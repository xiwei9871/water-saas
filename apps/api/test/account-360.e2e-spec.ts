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
    const list = await get('/water-accounts?take=200', branchToken).expect(200);
    const ids = list.body.map((a: { id: string }) => a.id);
    expect(ids).toContain(acctA.waterAccount.id);
    expect(ids).toContain(acctOff.waterAccount.id); // off-book permissive
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
    const list = await get('/customers?take=200', branchToken).expect(200);
    const ids = list.body.map((c: { id: string }) => c.id);
    expect(ids).toContain(onlyA.customerId);
    expect(ids).toContain(sharedCustomerId); // ≥1 visible account
    expect(ids).not.toContain(onlyB.customerId);
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
    const list = await get('/settle-accounts?take=200', branchToken).expect(200);
    const ids = list.body.map((s: { id: string }) => s.id);
    expect(ids).toContain(settleA);
    expect(ids).not.toContain(settleB);
    expect(ids).not.toContain(sharedSettle); // ANY out-of-scope → hidden
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
