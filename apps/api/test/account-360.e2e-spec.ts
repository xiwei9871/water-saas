/**
 * E8 WaterAccount 360° e2e against `watersaas_test` — fixtures `t18-`.
 *
 * Covers the frozen E8 contract:
 *  1. Read-side org-scope closure across EVERY customer-domain resource:
 *     water-accounts, customers, settle-accounts, outstanding, payments,
 *     bills, settlements, meter-readings, reading-books, reading-plans,
 *     estimate preview — each verified via unfiltered scoped list,
 *     own-scope explicit filter, out-of-scope explicit filter, detail
 *     by id, and nested-relation bypass where applicable.
 *  2. D2 customer rules: shared customer readable but filtered embed;
 *     write 403 when any linked account is out of scope.
 *  3. GET /water-accounts/:id/events — lifecycle timeline.
 *  4. GET /water-accounts/:id/payment-activity — D4 discriminated union
 *     (PAYMENT allocs + PREPAYMENT allocs, no fake payment fields).
 *  5. GET /water-accounts/:id/360 — customer-domain summary only:
 *     account/customer/settle identity, currentInstallation (E7 rule),
 *     activeInstallationCount, lifecycle warnings. Cross-domain fields
 *     must NOT be present.
 */
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import bcrypt from 'bcrypt';
import pg from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

process.env.DATABASE_URL =
  process.env.DATABASE_URL_TEST ??
  'postgresql://ws_app:ws_app_pw@localhost:5432/watersaas_test';

const OWNER_URL =
  process.env.MIGRATION_DATABASE_URL_TEST ??
  'postgresql://postgres:postgres@localhost:5432/watersaas_test';

const T18 = 'aa18aa18-aa18-4a18-8a18-aa18aa18aa18';
const ORG_A = 'aa18aa18-0000-4000-8000-0000000000c0';
const ORG_BRANCH_A = 'aa18aa18-0000-4000-8000-0000000000d1';
const ORG_BRANCH_B = 'aa18aa18-0000-4000-8000-0000000000d2';
const ROLE_ADMIN = 'aa18aa18-0000-4000-8000-00000000ad01';
const ROLE_BRANCH = 'aa18aa18-0000-4000-8000-00000000ad02';
const PERMS = {
  'customer:read': 'aa18aa18-0000-4000-8000-00000000e601',
  'customer:write': 'aa18aa18-0000-4000-8000-00000000e602',
  'metering:read': 'aa18aa18-0000-4000-8000-00000000e603',
  'billing:read': 'aa18aa18-0000-4000-8000-00000000e604',
  'payment:read': 'aa18aa18-0000-4000-8000-00000000e605',
} as const;
const STAFF_ADMIN = 'aa18aa18-0000-4000-8000-0000000a0001';
const STAFF_BRANCH = 'aa18aa18-0000-4000-8000-0000000a0002';

const owner = new pg.Client({ connectionString: OWNER_URL });
let app: INestApplication<App>;
let adminToken = '';
let branchToken = '';

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const post = (path: string, body: unknown, token = adminToken) =>
  request(app.getHttpServer()).post(path).set(auth(token)).send(body);
const get = (path: string, token = adminToken) =>
  request(app.getHttpServer()).get(path).set(auth(token));
const patch = (path: string, body: unknown, token = adminToken) =>
  request(app.getHttpServer()).patch(path).set(auth(token)).send(body);

const onboard = async (tag: string) =>
  (
    await post('/water-accounts/onboard', {
      customer: { name: `T18 ${tag} ${RUN}`, custType: 'PERSONAL' },
      account: { usageCategory: 'RES_METERED', addr: `${tag} 360 st` },
      meter: { brand: 't18-brand', caliber: 'DN15' },
      installation: { initialReading: 0, installedAt: '2026-01-01' },
    }).expect(201)
  ).body as {
    waterAccount: {
      id: string;
      customerId: string;
      settleAccountId: string;
      accountNo: string;
    };
    meter: { id: string };
    installation: { id: string };
  };

/** Anchor a water account to a reading book under `orgId` (coverage rule). */
const coverAccount = async (orgId: string, waterAccountId: string, tag: string) => {
  const bookId = (
    await owner.query(
      `INSERT INTO reading_book
         (id, tenant_id, book_no, name, org_unit_id, cadence, meter_channel,
          created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'MONTHLY', 'MECHANICAL',
               now(), now())
       RETURNING id::text AS id`,
      [T18, `t18-${tag}-${RUN}`, `T18 Book ${tag}`, orgId],
    )
  ).rows[0].id;
  const planId = (
    await owner.query(
      `INSERT INTO reading_plan
         (id, tenant_id, book_id, period, plan_date, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, '209902', '2099-02-05', 'OPEN',
               now(), now())
       RETURNING id::text AS id`,
      [T18, bookId],
    )
  ).rows[0].id;
  await owner.query(
    `INSERT INTO book_meter
       (tenant_id, book_id, water_account_id, seq_no, created_at, updated_at)
     VALUES ($1, $2, $3, 1, now(), now())`,
    [T18, bookId, waterAccountId],
  );
  await owner.query(
    `INSERT INTO reading_plan_item
       (id, tenant_id, plan_id, water_account_id, seq_no, status,
        created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 1, 'PENDING', now(), now())`,
    [T18, planId, waterAccountId],
  );
  return { bookId, planId };
};

const seedBill = async (
  waterAccountId: string,
  settleAccountId: string,
  period: string,
  total = 5000n,
) =>
  (
    await owner.query(
      `INSERT INTO bill
         (id, tenant_id, settle_account_id, water_account_id, period,
          bill_kind, source_type, source_id, status, total_amount,
          created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'NORMAL', 'MANUAL',
               gen_random_uuid(), 'POSTED', $5, now(), now())
       RETURNING id::text AS id`,
      [T18, settleAccountId, waterAccountId, period, total],
    )
  ).rows[0].id as string;

const seedPaymentWithAlloc = async (
  settleAccountId: string,
  billId: string,
  amount = 5000n,
) => {
  const paymentId = (
    await owner.query(
      `INSERT INTO payment
         (id, tenant_id, payment_no, settle_account_id, cashier_id,
          org_unit_id, channel, amount, status, received_at,
          created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'CASH', $6, 'RECEIVED',
               now(), now(), now())
       RETURNING id::text AS id`,
      [T18, `t18-pay-${RUN}-${billId.slice(0, 8)}`, settleAccountId, STAFF_ADMIN, ORG_A, amount],
    )
  ).rows[0].id;
  await owner.query(
    `INSERT INTO payment_alloc
       (id, tenant_id, source, payment_id, bill_id, amount,
        created_at, updated_at)
     VALUES (gen_random_uuid(), $1, 'PAYMENT', $2, $3, $4, now(), now())`,
    [T18, paymentId, billId, amount],
  );
  return paymentId as string;
};

const seedPrepayApplyAlloc = async (
  settleAccountId: string,
  billId: string,
  amount = 1200n,
) => {
  const topUpId = (
    await owner.query(
      `INSERT INTO payment
         (id, tenant_id, payment_no, settle_account_id, cashier_id,
          org_unit_id, channel, amount, status, received_at,
          created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'CASH', 99000, 'RECEIVED',
               now(), now(), now())
       RETURNING id::text AS id`,
      [T18, `t18-topup-pay-${RUN}-${billId.slice(0, 8)}`, settleAccountId, STAFF_ADMIN, ORG_A],
    )
  ).rows[0].id;
  const lotId = (
    await owner.query(
      `INSERT INTO prepayment_ledger_entry
         (id, tenant_id, settle_account_id, type, amount, payment_id,
          idempotency_key, operator_id, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'TOP_UP', 99000, $3, $4, $5, now())
       RETURNING id::text AS id`,
      [T18, settleAccountId, topUpId, `t18-topup-${RUN}-${billId.slice(0, 8)}`, STAFF_ADMIN],
    )
  ).rows[0].id;
  const entryId = (
    await owner.query(
      `INSERT INTO prepayment_ledger_entry
         (id, tenant_id, settle_account_id, type, amount, bill_id,
          origin_top_up_id, idempotency_key, operator_id, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'APPLY', ($3::bigint * -1), $4, $5, $6, NULL, now())
       RETURNING id::text AS id`,
      [T18, settleAccountId, amount, billId, lotId, `t18-apply-${RUN}-${billId.slice(0, 8)}`],
    )
  ).rows[0].id;
  await owner.query(
    `INSERT INTO payment_alloc
       (id, tenant_id, source, prepayment_entry_id, bill_id, amount,
        created_at, updated_at)
     VALUES (gen_random_uuid(), $1, 'PREPAYMENT', $2, $3, $4, now(), now())`,
    [T18, entryId, billId, amount],
  );
  return entryId as string;
};

const seedSettlement = async (waterAccountId: string, period: string) =>
  (
    await owner.query(
      `INSERT INTO consumption_settlement
         (id, tenant_id, water_account_id, period, total_usage_qty,
          is_estimated, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 10, false, 'DRAFT', now(), now())
       RETURNING id::text AS id`,
      [T18, waterAccountId, period],
    )
  ).rows[0].id as string;

const seedReading = async (
  installationId: string,
  meterId: string,
  period: string,
) =>
  (
    await owner.query(
      `INSERT INTO meter_reading
         (id, tenant_id, installation_id, meter_id, period, read_date,
          result_type, reading_value, qc_status, source, operator_id,
          created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, '2026-02-20',
               'ACTUAL', 25, 'PASSED', 'WEB', $5, now(), now())
       RETURNING id::text AS id`,
      [T18, installationId, meterId, period, STAFF_ADMIN],
    )
  ).rows[0].id as string;

beforeAll(async () => {
  await owner.connect();
  const hash = await bcrypt.hash('t18-pass', 10);
  await owner.query(
    `INSERT INTO tenant (id, code, name, status, created_at, updated_at)
     VALUES ($1, 't18-water', 'T18 Water', 'ACTIVE', now(), now())
     ON CONFLICT DO NOTHING`,
    [T18],
  );
  await owner.query(
    `INSERT INTO org_unit (id, tenant_id, parent_id, name, type, created_at, updated_at)
     VALUES ($1, $2, NULL, 'T18 Company', 'COMPANY', now(), now()),
            ($3, $2, $1, 'T18 Branch A', 'BRANCH', now(), now()),
            ($4, $2, $1, 'T18 Branch B', 'BRANCH', now(), now())
     ON CONFLICT DO NOTHING`,
    [ORG_A, T18, ORG_BRANCH_A, ORG_BRANCH_B],
  );
  await owner.query(
    `INSERT INTO role (id, tenant_id, code, name, data_scope, created_at, updated_at)
     VALUES ($1, $3, 'admin', 'T18 Admin', 'ALL', now(), now()),
            ($2, $3, 't18-branch', 'T18 Branch', 'ORG_SUBTREE', now(), now())
     ON CONFLICT DO NOTHING`,
    [ROLE_ADMIN, ROLE_BRANCH, T18],
  );
  for (const [code, id] of Object.entries(PERMS)) {
    await owner.query(
      `INSERT INTO permission (id, tenant_id, code, type, created_at, updated_at)
       VALUES ($1, $2, $3, 'ACTION', now(), now()) ON CONFLICT DO NOTHING`,
      [id, T18, code],
    );
    await owner.query(
      `INSERT INTO role_permission (tenant_id, role_id, permission_id, created_at, updated_at)
       VALUES ($1, $2, $3, now(), now()) ON CONFLICT DO NOTHING`,
      [T18, ROLE_BRANCH, id],
    );
  }
  await owner.query(
    `INSERT INTO staff (id, tenant_id, org_unit_id, login, password_hash, name, status, created_at, updated_at)
     VALUES ($1, $3, $4, 't18-admin',  $5, 'T18 Admin',  'ACTIVE', now(), now()),
            ($2, $3, $6, 't18-branch', $5, 'T18 Branch', 'ACTIVE', now(), now())
     ON CONFLICT (tenant_id, login) DO NOTHING`,
    [STAFF_ADMIN, STAFF_BRANCH, T18, ORG_A, hash, ORG_BRANCH_A],
  );
  await owner.query(
    `INSERT INTO staff_role (tenant_id, staff_id, role_id, created_at, updated_at)
     VALUES ($1, $2, $4, now(), now()),
            ($1, $3, $5, now(), now())
     ON CONFLICT DO NOTHING`,
    [T18, STAFF_ADMIN, STAFF_BRANCH, ROLE_ADMIN, ROLE_BRANCH],
  );

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleFixture.createNestApplication();
  await app.init();
  const login = async (login_: string) =>
    (
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ tenantCode: 't18-water', login: login_, password: 't18-pass' })
        .expect(201)
    ).body.accessToken as string;
  adminToken = await login('t18-admin');
  branchToken = await login('t18-branch');
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

describe('read-scope: water-accounts / outstanding', () => {
  let acctA: Awaited<ReturnType<typeof onboard>>;
  let acctB: Awaited<ReturnType<typeof onboard>>;
  let acctOff: Awaited<ReturnType<typeof onboard>>;
  beforeAll(async () => {
    acctA = await onboard('waA');
    acctB = await onboard('waB');
    acctOff = await onboard('waOff');
    await coverAccount(ORG_BRANCH_A, acctA.waterAccount.id, 'waA');
    await coverAccount(ORG_BRANCH_B, acctB.waterAccount.id, 'waB');
  });

  it('scoped list hides out-of-scope; explicit accountNo cannot resurrect', async () => {
    // customerId-scoped queries keep the positive assertions deterministic
    // regardless of how many fixtures previous runs left in the DB.
    const byCustomer = async (customerId: string) =>
      (
        await get(
          `/water-accounts?customerId=${customerId}`,
          branchToken,
        ).expect(200)
      ).body.map((a: { id: string }) => a.id);
    expect(await byCustomer(acctA.waterAccount.customerId)).toContain(
      acctA.waterAccount.id,
    );
    expect(await byCustomer(acctOff.waterAccount.customerId)).toContain(
      acctOff.waterAccount.id,
    ); // off-book permissive
    expect(await byCustomer(acctB.waterAccount.customerId)).not.toContain(
      acctB.waterAccount.id,
    );
    const list = await get('/water-accounts?take=200', branchToken).expect(200);
    const ids = list.body.map((a: { id: string }) => a.id);
    expect(ids).not.toContain(acctB.waterAccount.id);

    expect(acctB.waterAccount.accountNo).toBeDefined();
    const probe = await get(
      `/water-accounts?accountNo=${acctB.waterAccount.accountNo}`,
      branchToken,
    ).expect(200);
    expect(probe.body).toHaveLength(0);
  });

  it('detail + writes on out-of-scope account → 403', async () => {
    await get(`/water-accounts/${acctB.waterAccount.id}`, branchToken).expect(403);
    await patch(
      `/water-accounts/${acctB.waterAccount.id}`,
      { addr: 'x' },
      branchToken,
    ).expect(403);
    await post(
      `/water-accounts/${acctB.waterAccount.id}/suspend`,
      {},
      branchToken,
    ).expect(403);
    await get(
      `/water-accounts/${acctB.waterAccount.id}/household-profiles`,
      branchToken,
    ).expect(403);
    await get(
      `/water-accounts/${acctB.waterAccount.id}/outstanding`,
      branchToken,
    ).expect(403);
    // own-scope still works
    await get(`/water-accounts/${acctA.waterAccount.id}`, branchToken).expect(200);
    await get(
      `/water-accounts/${acctA.waterAccount.id}/outstanding`,
      branchToken,
    ).expect(200);
  });
});

describe('read-scope: customers (D2)', () => {
  let onlyA: { customerId: string };
  let onlyB: { customerId: string };
  let sharedCustomerId: string;
  let sharedAcctB: string;

  beforeAll(async () => {
    const a = await onboard('cuA');
    const b = await onboard('cuB');
    onlyA = { customerId: a.waterAccount.customerId };
    onlyB = { customerId: b.waterAccount.customerId };
    await coverAccount(ORG_BRANCH_A, a.waterAccount.id, 'cuA');
    await coverAccount(ORG_BRANCH_B, b.waterAccount.id, 'cuB');
    // shared customer: transfer a Branch-B-covered account onto A's customer
    const shared = await onboard('cuShared');
    sharedCustomerId = shared.waterAccount.customerId;
    await coverAccount(ORG_BRANCH_A, shared.waterAccount.id, 'cuShared');
    // bind a second (out-of-scope) account to the same customer
    const b2 = await post('/water-accounts', {
      customerId: sharedCustomerId,
      settleAccountId: shared.waterAccount.settleAccountId,
      usageCategory: 'RES_METERED',
      addr: 'shared-B st',
    }).expect(201);
    sharedAcctB = b2.body.id;
    await coverAccount(ORG_BRANCH_B, sharedAcctB, 'cuSharedB');
  });

  it('list hides all-out-of-scope customers; detail 403', async () => {
    // RUN-scoped name filters — the test DB accumulates fixtures across
    // runs, so an unfiltered take=200 page is not guaranteed to contain
    // this run's rows.
    const byName = async (n: string) =>
      (
        await get(
          `/customers?name=${encodeURIComponent(`T18 ${n} ${RUN}`)}`,
          branchToken,
        ).expect(200)
      ).body.map((c: { id: string }) => c.id);
    expect(await byName('cuA')).toContain(onlyA.customerId);
    expect(await byName('cuShared')).toContain(sharedCustomerId); // ≥1 visible account
    expect(await byName('cuB')).not.toContain(onlyB.customerId);
    await get(`/customers/${onlyB.customerId}`, branchToken).expect(403);
  });

  it('shared customer: identity visible, embedded accounts filtered', async () => {
    const res = await get(`/customers/${sharedCustomerId}`, branchToken).expect(200);
    const acctIds = res.body.waterAccounts.map((a: { id: string }) => a.id);
    expect(acctIds).not.toContain(sharedAcctB);
    expect(acctIds.length).toBeGreaterThan(0);
  });

  it('write rule: any out-of-scope linked account → PATCH 403', async () => {
    await patch(
      `/customers/${sharedCustomerId}`,
      { phone: '139' },
      branchToken,
    ).expect(403);
    await patch(
      `/customers/${onlyA.customerId}`,
      { phone: '138' },
      branchToken,
    ).expect(200);
    // no-account customer: visible + writable
    const orphan = (
      await post('/customers', {
        name: `T18 orphan ${RUN}`,
        custType: 'PERSONAL',
      }).expect(201)
    ).body;
    await get(`/customers/${orphan.id}`, branchToken).expect(200);
    await patch(`/customers/${orphan.id}`, { phone: '137' }, branchToken).expect(200);
  });
});

describe('read-scope: settle-accounts (E6 strict)', () => {
  let settleA: string;
  let settleB: string;
  let sharedSettle: string;

  beforeAll(async () => {
    const a = await onboard('stA');
    const b = await onboard('stB');
    settleA = a.waterAccount.settleAccountId;
    settleB = b.waterAccount.settleAccountId;
    await coverAccount(ORG_BRANCH_A, a.waterAccount.id, 'stA');
    await coverAccount(ORG_BRANCH_B, b.waterAccount.id, 'stB');
    // strict case: one settle serving A-covered + B-covered accounts
    const shared = await onboard('stShared');
    sharedSettle = shared.waterAccount.settleAccountId;
    await coverAccount(ORG_BRANCH_A, shared.waterAccount.id, 'stShared');
    const b2 = await post('/water-accounts', {
      customerId: shared.waterAccount.customerId,
      settleAccountId: sharedSettle,
      usageCategory: 'RES_METERED',
      addr: 'stB2 st',
    }).expect(201);
    await coverAccount(ORG_BRANCH_B, b2.body.id, 'stSharedB');
  });

  it('list hides strict-out-of-scope settles; detail + patch → 403', async () => {
    // name filters (settle inherits the customer name at onboard) keep the
    // assertions deterministic across accumulated fixture runs.
    const byName = async (n: string) =>
      (
        await get(
          `/settle-accounts?name=${encodeURIComponent(`T18 ${n} ${RUN}`)}`,
          branchToken,
        ).expect(200)
      ).body.map((s: { id: string }) => s.id);
    expect(await byName('stA')).toContain(settleA);
    expect(await byName('stB')).not.toContain(settleB);
    expect(await byName('stShared')).not.toContain(sharedSettle); // ANY out-of-scope → hidden
    await get(`/settle-accounts/${settleB}`, branchToken).expect(403);
    await get(`/settle-accounts/${sharedSettle}`, branchToken).expect(403);
    await patch(`/settle-accounts/${settleB}`, { phone: '1' }, branchToken).expect(403);
    await get(`/settle-accounts/${settleA}`, branchToken).expect(200);
  });
});

describe('read-scope: bills / settlements / readings / plans / books / estimate', () => {
  let acctA: Awaited<ReturnType<typeof onboard>>;
  let acctB: Awaited<ReturnType<typeof onboard>>;
  let billA: string, billB: string;
  let stA: string, stB: string;
  let rdA: string, rdB: string;
  let covA: { bookId: string; planId: string };
  let covB: { bookId: string; planId: string };

  beforeAll(async () => {
    acctA = await onboard('dA');
    acctB = await onboard('dB');
    covA = await coverAccount(ORG_BRANCH_A, acctA.waterAccount.id, 'dA');
    covB = await coverAccount(ORG_BRANCH_B, acctB.waterAccount.id, 'dB');
    billA = await seedBill(acctA.waterAccount.id, acctA.waterAccount.settleAccountId, '202602');
    billB = await seedBill(acctB.waterAccount.id, acctB.waterAccount.settleAccountId, '202602');
    stA = await seedSettlement(acctA.waterAccount.id, '202603');
    stB = await seedSettlement(acctB.waterAccount.id, '202603');
    rdA = await seedReading(acctA.installation.id, acctA.meter.id, '202602');
    rdB = await seedReading(acctB.installation.id, acctB.meter.id, '202602');
  });

  it('bills: unfiltered excludes, explicit asserts, detail 403', async () => {
    const list = await get('/bills?take=200', branchToken).expect(200);
    const ids = list.body.map((b: { id: string }) => b.id);
    expect(ids).toContain(billA);
    expect(ids).not.toContain(billB);
    const own = await get(
      `/bills?waterAccountId=${acctA.waterAccount.id}&take=50`,
      branchToken,
    ).expect(200);
    for (const b of own.body as { waterAccountId: string }[]) {
      expect(b.waterAccountId).toBe(acctA.waterAccount.id);
    }
    await get(
      `/bills?waterAccountId=${acctB.waterAccount.id}`,
      branchToken,
    ).expect(403);
    await get(`/bills/${billB}`, branchToken).expect(403);
    await get(`/bills/${billA}`, branchToken).expect(200);
  });

  it('settlements: same coverage pattern', async () => {
    const list = await get('/consumption-settlements?take=200', branchToken).expect(200);
    const ids = list.body.map((s: { id: string }) => s.id);
    expect(ids).toContain(stA);
    expect(ids).not.toContain(stB);
    await get(
      `/consumption-settlements?waterAccountId=${acctB.waterAccount.id}`,
      branchToken,
    ).expect(403);
    await get(`/consumption-settlements/${stB}`, branchToken).expect(403);
    await get(`/consumption-settlements/${stA}`, branchToken).expect(200);
  });

  it('meter-readings: waterAccountId filter + coverage exclusion', async () => {
    const own = await get(
      `/meter-readings?waterAccountId=${acctA.waterAccount.id}&take=50`,
      branchToken,
    ).expect(200);
    expect(own.body.map((r: { id: string }) => r.id)).toContain(rdA);
    await get(
      `/meter-readings?waterAccountId=${acctB.waterAccount.id}`,
      branchToken,
    ).expect(403);
    const all = await get('/meter-readings?take=200', branchToken).expect(200);
    const ids = all.body.map((r: { id: string }) => r.id);
    expect(ids).toContain(rdA);
    expect(ids).not.toContain(rdB);
    await get(`/meter-readings/${rdB}`, branchToken).expect(403);
    await get(`/meter-readings/${rdA}`, branchToken).expect(200);
  });

  it('reading-books: org-anchored list/detail + waterAccountId filter', async () => {
    const list = await get('/reading-books?take=200', branchToken).expect(200);
    const ids = list.body.map((b: { id: string }) => b.id);
    expect(ids).toContain(covA.bookId);
    expect(ids).not.toContain(covB.bookId);
    await get(`/reading-books/${covB.bookId}`, branchToken).expect(403);
    const byAcct = await get(
      `/reading-books?waterAccountId=${acctA.waterAccount.id}`,
      branchToken,
    ).expect(200);
    expect(byAcct.body.map((b: { id: string }) => b.id)).toContain(covA.bookId);
    await get(
      `/reading-books?waterAccountId=${acctB.waterAccount.id}`,
      branchToken,
    ).expect(403);
  });

  it('reading-plans: list/detail/items scope + waterAccountId filter returns myItem', async () => {
    const list = await get('/reading-plans?take=200', branchToken);
    if (list.status !== 200) console.log('PLANS500', JSON.stringify(list.body).slice(0, 800));
    expect(list.status).toBe(200);
    const ids = list.body.map((p: { id: string }) => p.id);
    expect(ids).toContain(covA.planId);
    expect(ids).not.toContain(covB.planId);
    await get(`/reading-plans/${covB.planId}`, branchToken).expect(403);
    await get(`/reading-plans/${covB.planId}/items`, branchToken).expect(403);
    const byAcct = await get(
      `/reading-plans?waterAccountId=${acctA.waterAccount.id}`,
      branchToken,
    ).expect(200);
    const mine = byAcct.body.find((p: { id: string }) => p.id === covA.planId);
    expect(mine).toBeDefined();
    expect(mine.myItem.waterAccountId).toBe(acctA.waterAccount.id);
    await get(
      `/reading-plans?waterAccountId=${acctB.waterAccount.id}`,
      branchToken,
    ).expect(403);
  });

  it('estimate preview: out-of-scope account → 403', async () => {
    await post(
      '/estimate/preview',
      { waterAccountId: acctB.waterAccount.id, period: '202603' },
      branchToken,
    ).expect(403);
    await post(
      '/estimate/preview',
      { waterAccountId: acctA.waterAccount.id, period: '202603' },
      branchToken,
    ).expect(200);
  });
});

describe('read-scope: payments', () => {
  let acctA: Awaited<ReturnType<typeof onboard>>;
  let acctB: Awaited<ReturnType<typeof onboard>>;
  let payA: string, payB: string;

  beforeAll(async () => {
    acctA = await onboard('pA');
    acctB = await onboard('pB');
    await coverAccount(ORG_BRANCH_A, acctA.waterAccount.id, 'pA');
    await coverAccount(ORG_BRANCH_B, acctB.waterAccount.id, 'pB');
    const billA = await seedBill(acctA.waterAccount.id, acctA.waterAccount.settleAccountId, '202604');
    const billB = await seedBill(acctB.waterAccount.id, acctB.waterAccount.settleAccountId, '202604');
    payA = await seedPaymentWithAlloc(acctA.waterAccount.settleAccountId, billA);
    payB = await seedPaymentWithAlloc(acctB.waterAccount.settleAccountId, billB);
  });

  it('unfiltered excludes, explicit settle asserts, detail 403', async () => {
    const list = await get('/payments?take=200', branchToken).expect(200);
    const ids = list.body.map((p: { id: string }) => p.id);
    expect(ids).toContain(payA);
    expect(ids).not.toContain(payB);
    await get(
      `/payments?settleAccountId=${acctB.waterAccount.settleAccountId}`,
      branchToken,
    ).expect(403);
    await get(`/payments/${payB}`, branchToken).expect(403);
    await get(`/payments/${payA}`, branchToken).expect(200);
  });
});

describe('GET /water-accounts/:id/events', () => {
  it('returns lifecycle timeline after transitions; scoped 403', async () => {
    const a = await onboard('ev1');
    await coverAccount(ORG_BRANCH_A, a.waterAccount.id, 'ev1');
    await post(`/water-accounts/${a.waterAccount.id}/suspend`, {}).expect(201);
    await post(`/water-accounts/${a.waterAccount.id}/resume`, {}).expect(201);
    const res = await get(
      `/water-accounts/${a.waterAccount.id}/events`,
      branchToken,
    ).expect(200);
    const types = res.body.map((e: { type: string }) => e.type);
    expect(types).toContain('SUSPEND');
    expect(types).toContain('RESUME');
    // newest first
    expect(res.body[0].type).toBe('RESUME');
  });

  it('out-of-scope → 403', async () => {
    const b = await onboard('ev2');
    await coverAccount(ORG_BRANCH_B, b.waterAccount.id, 'ev2');
    await get(`/water-accounts/${b.waterAccount.id}/events`, branchToken).expect(403);
  });
});

describe('GET /water-accounts/:id/payment-activity (D4 union)', () => {
  it('PAYMENT + PREPAYMENT rows discriminate by source; allocatedAmount only', async () => {
    const a = await onboard('act');
    await coverAccount(ORG_BRANCH_A, a.waterAccount.id, 'act');
    const bill = await seedBill(a.waterAccount.id, a.waterAccount.settleAccountId, '202605', 8000n);
    const paymentId = await seedPaymentWithAlloc(a.waterAccount.settleAccountId, bill, 5000n);
    const entryId = await seedPrepayApplyAlloc(a.waterAccount.settleAccountId, bill, 1200n);

    const res = await get(
      `/water-accounts/${a.waterAccount.id}/payment-activity`,
      branchToken,
    ).expect(200);
    expect(res.body.length).toBe(2);
    const pay = res.body.find((r: { source: string }) => r.source === 'PAYMENT');
    const pre = res.body.find((r: { source: string }) => r.source === 'PREPAYMENT');
    expect(pay.payment.id).toBe(paymentId);
    expect(Number(pay.allocatedAmount)).toBe(5000);
    expect(pay.payment.paymentNo).toBeTruthy();
    expect(pay.bill.id).toBe(bill);
    // PREPAYMENT carries the ledger entry — never fake payment fields
    expect(pre.prepaymentEntry.id).toBe(entryId);
    expect(pre.prepaymentEntry.type).toBe('APPLY');
    expect(Number(pre.allocatedAmount)).toBe(1200);
    expect(pre.payment).toBeUndefined();
    expect(pre.prepaymentEntry.paymentNo).toBeUndefined();
  });

  it('out-of-scope → 403', async () => {
    const b = await onboard('actB');
    await coverAccount(ORG_BRANCH_B, b.waterAccount.id, 'actB');
    await get(
      `/water-accounts/${b.waterAccount.id}/payment-activity`,
      branchToken,
    ).expect(403);
  });
});

describe('GET /water-accounts/:id/360 (customer-domain summary)', () => {
  it('returns account+currentInstallation+count+warnings; no cross-domain fields', async () => {
    const a = await onboard('s360');
    await coverAccount(ORG_BRANCH_A, a.waterAccount.id, 's360');
    const res = await get(
      `/water-accounts/${a.waterAccount.id}/360`,
      branchToken,
    ).expect(200);
    expect(res.body.account.id).toBe(a.waterAccount.id);
    expect(res.body.account.customer.name).toContain('T18 s360');
    expect(res.body.account.settleAccount.id).toBe(a.waterAccount.settleAccountId);
    expect(res.body.currentInstallation.id).toBe(a.installation.id);
    expect(res.body.activeInstallationCount).toBe(1);
    expect(res.body.warnings).toEqual([]);
    // D1 freeze: nothing from metering/billing/payment domains
    for (const k of [
      'latestReading',
      'latestSettlement',
      'outstanding',
      'prepaymentBalance',
      'books',
      'currentPlanItems',
      'payments',
      'bills',
    ]) {
      expect(res.body[k]).toBeUndefined();
    }
  });

  it('multi-ACTIVE + zero-ACTIVE warnings are lifecycle-derived', async () => {
    const a = await onboard('s360m');
    const m2 = (
      await post('/meters', { brand: 't18-spare', caliber: 'DN15' }).expect(201)
    ).body;
    await post('/meter-installations', {
      waterAccountId: a.waterAccount.id,
      meterId: m2.id,
      initialReading: 0,
      installedAt: '2026-02-01',
    }).expect(201);
    const res = await get(`/water-accounts/${a.waterAccount.id}/360`).expect(200);
    expect(res.body.activeInstallationCount).toBe(2);
    expect(res.body.warnings).toContain('MULTI_ACTIVE_METER');
    // newest installed_at wins (E7 rule)
    expect(res.body.currentInstallation.meterId).toBe(m2.id);

    const b = await onboard('s360z');
    // remove the only installation → NO_ACTIVE_METER
    await post(`/meter-installations/${b.installation.id}/remove`, {
      finalReading: 0,
    }).expect(201);
    const res2 = await get(`/water-accounts/${b.waterAccount.id}/360`).expect(200);
    expect(res2.body.currentInstallation).toBeNull();
    expect(res2.body.warnings).toContain('NO_ACTIVE_METER');
  });

  it('out-of-scope → 403', async () => {
    const b = await onboard('s360b');
    await coverAccount(ORG_BRANCH_B, b.waterAccount.id, 's360b');
    await get(`/water-accounts/${b.waterAccount.id}/360`, branchToken).expect(403);
  });
});

/**
 * Release-gate regressions (E8 RC fix):
 *  P0 — /outstanding must obey STRICT settle scope, not just account scope.
 *  P1 — transfer/create/onboard must scope-check the TARGET references.
 *  P1 — /payment-activity must never project payment.amount (D4: the
 *       allocatedAmount line is the only money fact).
 */
describe('release-gate: outstanding obeys strict settle scope (P0)', () => {
  let sharedA: string; // A-covered account on a SHARED settle
  let sharedSettle: string;
  let soloA: Awaited<ReturnType<typeof onboard>>;
  let offBook: Awaited<ReturnType<typeof onboard>>;

  beforeAll(async () => {
    const a = await onboard('osA');
    const b = await onboard('osB');
    await coverAccount(ORG_BRANCH_A, a.waterAccount.id, 'osA');
    await coverAccount(ORG_BRANCH_B, b.waterAccount.id, 'osB');
    // shared settle S: repoint the A-covered account onto B's settle so S
    // serves one in-scope + one out-of-scope account.
    sharedSettle = b.waterAccount.settleAccountId;
    sharedA = a.waterAccount.id;
    await owner.query(
      `UPDATE water_account SET settle_account_id = $3, updated_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [T18, sharedA, sharedSettle],
    );
    soloA = await onboard('osSolo');
    await coverAccount(ORG_BRANCH_A, soloA.waterAccount.id, 'osSolo');
    offBook = await onboard('osOff'); // no coverage → off-book carve-out
  });

  it('account in scope but settle shared with B → 403 ORG_OUT_OF_SCOPE', async () => {
    // sanity: the ACCOUNT itself is visible to Branch A — the refusal must
    // come from the settle-scope check, not account scope.
    await get(`/water-accounts/${sharedA}`, branchToken).expect(200);
    const res = await get(
      `/water-accounts/${sharedA}/outstanding`,
      branchToken,
    ).expect(403);
    expect(res.body.code).toBe('ORG_OUT_OF_SCOPE');
    // admin still sees the facts (whole-tenant scope)
    await get(`/water-accounts/${sharedA}/outstanding`).expect(200);
  });

  it('single in-scope settle → 200; off-book settle → 200 (carve-out)', async () => {
    await get(
      `/water-accounts/${soloA.waterAccount.id}/outstanding`,
      branchToken,
    ).expect(200);
    await get(
      `/water-accounts/${offBook.waterAccount.id}/outstanding`,
      branchToken,
    ).expect(200);
  });
});

describe('release-gate: target-reference scope on transfer/create/onboard (P1)', () => {
  let src: Awaited<ReturnType<typeof onboard>>;
  let src2: Awaited<ReturnType<typeof onboard>>;
  let tgtB: Awaited<ReturnType<typeof onboard>>;
  let offBookSettle: string;
  let sharedCustomerId: string;

  beforeAll(async () => {
    src = await onboard('tgSrc');
    src2 = await onboard('tgSrc2');
    tgtB = await onboard('tgB');
    await coverAccount(ORG_BRANCH_A, src.waterAccount.id, 'tgSrc');
    await coverAccount(ORG_BRANCH_A, src2.waterAccount.id, 'tgSrc2');
    await coverAccount(ORG_BRANCH_B, tgtB.waterAccount.id, 'tgB');
    // permissive settle (off-book accounts only) for the create probes
    const off = await onboard('tgOff');
    offBookSettle = off.waterAccount.settleAccountId;
    // shared customer: one A-covered + one B-covered account → identity is
    // readable by Branch A under the D2 rule.
    const sh = await onboard('tgSh');
    sharedCustomerId = sh.waterAccount.customerId;
    await coverAccount(ORG_BRANCH_A, sh.waterAccount.id, 'tgSh');
    const b2 = await post('/water-accounts', {
      customerId: sharedCustomerId,
      settleAccountId: sh.waterAccount.settleAccountId,
      usageCategory: 'RES_METERED',
      addr: 'tgShB st',
    }).expect(201);
    await coverAccount(ORG_BRANCH_B, b2.body.id, 'tgShB');
  });

  it('transfer to B-only settle → 403, source row unchanged', async () => {
    const res = await post(
      `/water-accounts/${src.waterAccount.id}/transfer`,
      { settleAccountId: tgtB.waterAccount.settleAccountId },
      branchToken,
    ).expect(403);
    expect(res.body.code).toBe('ORG_OUT_OF_SCOPE');
    const after = await get(
      `/water-accounts/${src.waterAccount.id}`,
    ).expect(200);
    expect(after.body.customerId).toBe(src.waterAccount.customerId);
    expect(after.body.settleAccountId).toBe(src.waterAccount.settleAccountId);
  });

  it('transfer to B-only customer → 403', async () => {
    const res = await post(
      `/water-accounts/${src.waterAccount.id}/transfer`,
      { customerId: tgtB.waterAccount.customerId },
      branchToken,
    ).expect(403);
    expect(res.body.code).toBe('ORG_OUT_OF_SCOPE');
  });

  it('POST /water-accounts binding a B-only customer → 403', async () => {
    const res = await post(
      '/water-accounts',
      {
        customerId: tgtB.waterAccount.customerId,
        settleAccountId: offBookSettle, // permissive → 403 must be the customer
        usageCategory: 'RES_METERED',
        addr: 'probe st',
      },
      branchToken,
    ).expect(403);
    expect(res.body.code).toBe('ORG_OUT_OF_SCOPE');
  });

  it('onboard binding a B-only customer → 403', async () => {
    const res = await post(
      '/water-accounts/onboard',
      {
        customerId: tgtB.waterAccount.customerId,
        account: { usageCategory: 'RES_METERED', addr: 'probe st' },
        meter: { brand: 't18-brand', caliber: 'DN15' },
        installation: { initialReading: 0, installedAt: '2026-01-01' },
      },
      branchToken,
    ).expect(403);
    expect(res.body.code).toBe('ORG_OUT_OF_SCOPE');
  });

  it('shared-visible customer still allowed as transfer target', async () => {
    await post(
      `/water-accounts/${src2.waterAccount.id}/transfer`,
      { customerId: sharedCustomerId },
      branchToken,
    ).expect(201);
    const after = await get(
      `/water-accounts/${src2.waterAccount.id}`,
    ).expect(200);
    expect(after.body.customerId).toBe(sharedCustomerId);
  });
});

describe('release-gate: payment-activity field minimization (P1)', () => {
  it('split payment: only allocatedAmount + metadata, no payment.amount', async () => {
    const a = await onboard('minA');
    const b = await onboard('minB');
    await coverAccount(ORG_BRANCH_A, a.waterAccount.id, 'minA');
    await coverAccount(ORG_BRANCH_B, b.waterAccount.id, 'minB');
    // shared settle so one payment legitimately splits across accounts
    const settleId = b.waterAccount.settleAccountId;
    await owner.query(
      `UPDATE water_account SET settle_account_id = $3, updated_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [T18, a.waterAccount.id, settleId],
    );
    const billA = await seedBill(a.waterAccount.id, settleId, '202606', 3000n);
    const billB = await seedBill(b.waterAccount.id, settleId, '202606', 7000n);
    const paymentId = (
      await owner.query(
        `INSERT INTO payment
           (id, tenant_id, payment_no, settle_account_id, cashier_id,
            org_unit_id, channel, amount, status, received_at,
            created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'CASH', 10000,
                 'RECEIVED', now(), now(), now())
         RETURNING id::text AS id`,
        [T18, `t18-split-${RUN}`, settleId, STAFF_ADMIN, ORG_A],
      )
    ).rows[0].id;
    for (const [billId, amt] of [
      [billA, 3000n],
      [billB, 7000n],
    ] as [string, bigint][]) {
      await owner.query(
        `INSERT INTO payment_alloc
           (id, tenant_id, source, payment_id, bill_id, amount,
            created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'PAYMENT', $2, $3, $4, now(), now())`,
        [T18, paymentId, billId, amt],
      );
    }

    const res = await get(
      `/water-accounts/${a.waterAccount.id}/payment-activity`,
      branchToken,
    ).expect(200);
    // exactly A's alloc — B's 7000 line must not appear
    expect(res.body).toHaveLength(1);
    const row = res.body[0];
    expect(row.source).toBe('PAYMENT');
    expect(Number(row.allocatedAmount)).toBe(3000);
    expect(row.bill.id).toBe(billA);
    expect(row.payment.id).toBe(paymentId);
    expect(row.payment.amount).toBeUndefined();
    expect(Object.keys(row.payment).sort()).toEqual(
      ['cashierId', 'channel', 'id', 'paymentNo', 'receivedAt', 'status'].sort(),
    );
  });
});

/**
 * Release-gate RC2 regression (P1): the monitoring system pair
 * (customer.systemKey=MONITORING_INTERNAL + settle.settleNo=SYS-MONITORING)
 * is a CLOSED internal principal — only usable together, only on
 * MONITORING accounts. Binding it to a normal account is a 400
 * SYSTEM_PRINCIPAL_NOT_ALLOWED, not a scope question.
 */
describe('release-gate: system principal pair is closed (P1 RC2)', () => {
  let sysCustomerId: string;
  let sysSettleId: string;
  let ordCustomerId: string;
  let ordSettleId: string;
  let branchSettle: string; // in-scope settle for the branch probe

  const acct = (over: Record<string, unknown>) => ({
    customerId: ordCustomerId,
    settleAccountId: ordSettleId,
    usageCategory: 'RES_METERED',
    addr: 'rc2 st',
    ...over,
  });

  beforeAll(async () => {
    // materialize the system pair via a real MONITORING onboard
    const mon = await post('/water-accounts/onboard', {
      account: { usageCategory: 'MONITORING', addr: 'gatehouse' },
      meter: { brand: 't18-brand', caliber: 'DN15' },
      installation: { initialReading: 0, installedAt: '2026-01-01' },
    }).expect(201);
    sysCustomerId = mon.body.waterAccount.customerId;
    sysSettleId = mon.body.waterAccount.settleAccountId;
    const ord = await onboard('rc2Ord');
    ordCustomerId = ord.waterAccount.customerId;
    ordSettleId = ord.waterAccount.settleAccountId;
    const b = await onboard('rc2Br');
    await coverAccount(ORG_BRANCH_A, b.waterAccount.id, 'rc2Br');
    branchSettle = b.waterAccount.settleAccountId;
  });

  it('normal account + system customer → 400 SYSTEM_PRINCIPAL_NOT_ALLOWED', async () => {
    const res = await post(
      '/water-accounts',
      acct({ customerId: sysCustomerId }),
    ).expect(400);
    expect(res.body.code).toBe('SYSTEM_PRINCIPAL_NOT_ALLOWED');
  });

  it('normal account + system settle → 400', async () => {
    const res = await post(
      '/water-accounts',
      acct({ settleAccountId: sysSettleId }),
    ).expect(400);
    expect(res.body.code).toBe('SYSTEM_PRINCIPAL_NOT_ALLOWED');
  });

  it('normal account + full system pair → 400 (pair does not rescue it)', async () => {
    const res = await post(
      '/water-accounts',
      acct({ customerId: sysCustomerId, settleAccountId: sysSettleId }),
    ).expect(400);
    expect(res.body.code).toBe('SYSTEM_PRINCIPAL_NOT_ALLOWED');
  });

  it('scoped caller + system customer → 400 (never a scope bypass)', async () => {
    const res = await post(
      '/water-accounts',
      acct({ customerId: sysCustomerId, settleAccountId: branchSettle }),
      branchToken,
    ).expect(400);
    expect(res.body.code).toBe('SYSTEM_PRINCIPAL_NOT_ALLOWED');
  });

  it('MONITORING + full system pair via POST /water-accounts → 201', async () => {
    const res = await post(
      '/water-accounts',
      acct({
        usageCategory: 'MONITORING',
        customerId: sysCustomerId,
        settleAccountId: sysSettleId,
      }),
    ).expect(201);
    expect(res.body.usageCategory).toBe('MONITORING');
    expect(res.body.billable).toBe(false);
  });

  it('MONITORING + half-system pair → 400 (both directions)', async () => {
    const r1 = await post(
      '/water-accounts',
      acct({
        usageCategory: 'MONITORING',
        customerId: sysCustomerId,
        settleAccountId: ordSettleId,
      }),
    ).expect(400);
    expect(r1.body.code).toBe('SYSTEM_PRINCIPAL_NOT_ALLOWED');
    const r2 = await post(
      '/water-accounts',
      acct({
        usageCategory: 'MONITORING',
        customerId: ordCustomerId,
        settleAccountId: sysSettleId,
      }),
    ).expect(400);
    expect(r2.body.code).toBe('SYSTEM_PRINCIPAL_NOT_ALLOWED');
    // fully ordinary pair is also invalid for MONITORING
    const r3 = await post(
      '/water-accounts',
      acct({ usageCategory: 'MONITORING' }),
    ).expect(400);
    expect(r3.body.code).toBe('SYSTEM_PRINCIPAL_NOT_ALLOWED');
  });

  it('MONITORING onboard still refuses caller-supplied customer/settle', async () => {
    const base = {
      account: { usageCategory: 'MONITORING', addr: 'x' },
      meter: { brand: 't18-brand', caliber: 'DN15' },
      installation: { initialReading: 0, installedAt: '2026-01-01' },
    };
    const r1 = await post('/water-accounts/onboard', {
      ...base,
      customerId: ordCustomerId,
    }).expect(400);
    expect(r1.body.code).toBe('MONITORING_NO_CUSTOMER');
    const r2 = await post('/water-accounts/onboard', {
      ...base,
      customer: { name: 'x', custType: 'PERSONAL' },
      settleAccountId: sysSettleId,
    }).expect(400);
    expect(r2.body.code).toBe('MONITORING_NO_CUSTOMER');
  });

  it('transfer to a system principal → 400 (same closed-pair rule)', async () => {
    const src = await onboard('rc2Tr');
    await coverAccount(ORG_BRANCH_A, src.waterAccount.id, 'rc2Tr');
    const r1 = await post(
      `/water-accounts/${src.waterAccount.id}/transfer`,
      { customerId: sysCustomerId },
      branchToken,
    ).expect(400);
    expect(r1.body.code).toBe('SYSTEM_PRINCIPAL_NOT_ALLOWED');
    const r2 = await post(
      `/water-accounts/${src.waterAccount.id}/transfer`,
      { settleAccountId: sysSettleId },
      branchToken,
    ).expect(400);
    expect(r2.body.code).toBe('SYSTEM_PRINCIPAL_NOT_ALLOWED');
  });
});

/**
 * Release-gate RC3 regression (P1): PATCH /water-accounts/:id changing
 * usageCategory must hold the closed system-principal pair invariant —
 * MONITORING ⇔ MONITORING_INTERNAL customer + SYS-MONITORING settle —
 * on every write path that can alter the (category, customer, settle)
 * combination.
 */
describe('release-gate: PATCH usageCategory keeps the system pair closed (P1 RC3)', () => {
  it('Case 1: MONITORING on system pair → PATCH to RES_METERED → 400, row unchanged', async () => {
    const mon = await post('/water-accounts/onboard', {
      account: { usageCategory: 'MONITORING', addr: 'rc3 gatehouse' },
      meter: { brand: 't18-brand', caliber: 'DN15' },
      installation: { initialReading: 0, installedAt: '2026-01-01' },
    }).expect(201);
    const res = await patch(
      `/water-accounts/${mon.body.waterAccount.id}`,
      { usageCategory: 'RES_METERED' },
    ).expect(400);
    expect(res.body.code).toBe('SYSTEM_PRINCIPAL_NOT_ALLOWED');
    const after = await get(
      `/water-accounts/${mon.body.waterAccount.id}`,
    ).expect(200);
    expect(after.body.usageCategory).toBe('MONITORING');
    expect(after.body.billable).toBe(false);
  });

  it('Case 2: ordinary account → PATCH to MONITORING → 400, row unchanged', async () => {
    const a = await onboard('rc3Ord');
    const res = await patch(
      `/water-accounts/${a.waterAccount.id}`,
      { usageCategory: 'MONITORING' },
    ).expect(400);
    expect(res.body.code).toBe('SYSTEM_PRINCIPAL_NOT_ALLOWED');
    const after = await get(
      `/water-accounts/${a.waterAccount.id}`,
    ).expect(200);
    expect(after.body.usageCategory).toBe('RES_METERED');
    expect(after.body.billable).toBe(true);
  });

  it('Case 3: ordinary → ordinary category switch still works', async () => {
    const a = await onboard('rc3Cat');
    const res = await patch(
      `/water-accounts/${a.waterAccount.id}`,
      { usageCategory: 'NON_RES' },
    ).expect(200);
    expect(res.body.usageCategory).toBe('NON_RES');
    expect(res.body.billable).toBe(true);
  });

  it('Case 4: PATCH addr only still works', async () => {
    const a = await onboard('rc3Addr');
    const res = await patch(
      `/water-accounts/${a.waterAccount.id}`,
      { addr: 'rc3 new addr' },
    ).expect(200);
    expect(res.body.addr).toBe('rc3 new addr');
  });
});
