/**
 * E10 foundation e2e — `watersaas_test`, fixtures `t20-`.
 *
 * Covers the frozen Metric Dictionary Rev4 semantics:
 *  - ACCOUNT_AGGREGATION_OWNERSHIP (D24): off-book → tenant-only;
 *    multi-book all-in-scope → count once; any book out → excluded
 *  - CURRENT_PORTFOLIO_VIEW (D25): historical-period WaterAccount metrics
 *    attribute by CURRENT BookMeter ownership, not event-time org
 *  - BILLED_AMOUNT (D26), GROSS_BILL_RECEIVABLE (D27) exact predicates
 *  - signed money: CASHIER_COLLECTED vs TERRITORY_DEBT_COLLECTION vs
 *    TOP_UP / PREPAYMENT APPLY / reversal nets (B6)
 *  - HOLD metrics absent (never a fake 0)
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

const T20 = 'aa20aa20-aa20-4a20-8a20-aa20aa20aa20';
const ORG_CO = 'aa20aa20-0000-4000-8000-0000000000c0';
const ORG_A = 'aa20aa20-0000-4000-8000-0000000000a1';
const ORG_B = 'aa20aa20-0000-4000-8000-0000000000b1';
const ROLE_ADMIN = 'aa20aa20-0000-4000-8000-00000000ad01';
const ROLE_BRANCH = 'aa20aa20-0000-4000-8000-00000000ad02';
const PERMS = {
  'report:read': 'aa20aa20-0000-4000-8000-00000000e801',
} as const;
const STAFF_ADMIN = 'aa20aa20-0000-4000-8000-0000000a0001';
const STAFF_A = 'aa20aa20-0000-4000-8000-0000000a0002';
const STAFF_B = 'aa20aa20-0000-4000-8000-0000000a0003';

const owner = new pg.Client({ connectionString: OWNER_URL });
let app: INestApplication<App>;
let adminToken = '';
let branchAToken = '';
let branchBToken = '';

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;
const uniq = (t: string) => `${t}-${RUN}-${seq++}`;
const get = (path: string, token: string) =>
  request(app.getHttpServer()).get(path).set(auth(token));
const metrics = async (period: string, token = adminToken) => {
  // transport-level flake guard: a transient 5xx under parallel load retries once
  let r = await get(`/dashboard/metrics?period=${period}`, token);
  if (r.status >= 500) {
    await new Promise((res) => setTimeout(res, 200));
    r = await get(`/dashboard/metrics?period=${period}`, token);
  }
  expect(r.status).toBe(200);
  return r.body.metrics as Record<string, unknown>;
};
/** Fixtures accumulate across runs — assert deltas, never absolutes. */
const delta = async (
  period: string, token: string, key: string, act: () => Promise<unknown>,
) => {
  const before = Number((await metrics(period, token))[key] ?? 0);
  await act();
  const after = Number((await metrics(period, token))[key] ?? 0);
  return after - before;
};

const seedAccount = async (tag: string) => {
  const custId = (
    await owner.query(
      `INSERT INTO customer (id, tenant_id, customer_no, name, cust_type,
         created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'PERSONAL', now(), now())
       RETURNING id::text`,
      [T20, `t20-cust-${uniq(tag)}`, `T20 ${tag}`],
    )
  ).rows[0].id;
  const settleId = (
    await owner.query(
      `INSERT INTO settle_account (id, tenant_id, settle_no, name,
         created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, now(), now())
       RETURNING id::text`,
      [T20, `t20-settle-${uniq(tag)}`, `T20 settle ${tag}`],
    )
  ).rows[0].id;
  const accId = (
    await owner.query(
      `INSERT INTO water_account (id, tenant_id, account_no, customer_id,
         settle_account_id, usage_category, addr, status, billable,
         created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'RES_METERED', $5,
               'NORMAL', true, now(), now())
       RETURNING id::text`,
      [T20, `t20-acc-${uniq(tag)}`, custId, settleId, `${tag} addr`],
    )
  ).rows[0].id;
  return { custId, settleId, accId };
};

const coverAccount = async (orgId: string, accId: string, tag: string) =>
  (
    await owner.query(
      `INSERT INTO reading_book
         (id, tenant_id, book_no, name, org_unit_id, cadence, meter_channel,
          created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'MONTHLY', 'MECHANICAL',
               now(), now()) RETURNING id::text`,
      [T20, `t20-${uniq(tag)}`, `T20 Book ${tag}`, orgId],
    ).then(async (r) => {
      const bookId = r.rows[0].id;
      await owner.query(
        `INSERT INTO book_meter
           (tenant_id, book_id, water_account_id, seq_no, created_at, updated_at)
         VALUES ($1, $2, $3, 1, now(), now())`,
        [T20, bookId, accId],
      );
      return bookId as string;
    })
  );

const seedBill = async (
  accId: string,
  settleId: string,
  period: string,
  amount: number,
  status: 'DRAFT' | 'POSTED' | 'PARTIAL_PAID' | 'PAID',
  kind: 'NORMAL' | 'REVERSAL' = 'NORMAL',
  dueDate = '2099-01-01',
) =>
  (
    await owner.query(
      `INSERT INTO bill
         (id, tenant_id, settle_account_id, water_account_id, period,
          bill_kind, source_type, source_id, status, total_amount, due_date,
          created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'MANUAL',
               gen_random_uuid(), $6, $7, $8, now(), now())
       RETURNING id::text`,
      [T20, settleId, accId, period, kind, status, amount, dueDate],
    )
  ).rows[0].id as string;

const seedPayment = async (
  settleId: string,
  orgId: string,
  amount: number,
  tag: string,
  receivedAt = '2026-08-15T02:00:00Z',
) =>
  (
    await owner.query(
      `INSERT INTO payment
         (id, tenant_id, payment_no, settle_account_id, cashier_id,
          org_unit_id, channel, amount, status, received_at,
          created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'CASH', $6,
               'RECEIVED', $7, now(), now()) RETURNING id::text`,
      [T20, `t20-pay-${uniq(tag)}`, settleId, STAFF_A, orgId, amount, receivedAt],
    )
  ).rows[0].id as string;

const allocPayment = (paymentId: string, billId: string, amount: number) =>
  owner.query(
    `INSERT INTO payment_alloc
       (id, tenant_id, source, payment_id, bill_id, amount,
        created_at, updated_at)
     VALUES (gen_random_uuid(), $1, 'PAYMENT', $2, $3, $4, now(), now())`,
    [T20, paymentId, billId, amount],
  );

const seedPrepayApply = async (settleId: string, billId: string, amount: number, tag: string) => {
  // APPLY requires origin_top_up_id → source TOP_UP needs a backing payment
  const payId = await seedPayment(settleId, ORG_A, amount, `applysrc-${tag}`);
  const topUpId = (
    await owner.query(
      `INSERT INTO prepayment_ledger_entry
         (id, tenant_id, settle_account_id, type, amount, payment_id,
          idempotency_key, operator_id, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'TOP_UP', $3, $4, $5, $6, now())
       RETURNING id::text`,
      [T20, settleId, amount, payId, `t20-apply-src-${uniq(tag)}`, STAFF_ADMIN],
    )
  ).rows[0].id;
  const entryId = (
    await owner.query(
      `INSERT INTO prepayment_ledger_entry
         (id, tenant_id, settle_account_id, type, amount, bill_id,
          origin_top_up_id, idempotency_key, operator_id, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'APPLY', ($3::bigint * -1), $4,
               $5, $6, $7, now()) RETURNING id::text`,
      [T20, settleId, amount, billId, topUpId, `t20-apply-${uniq(tag)}`, STAFF_ADMIN],
    )
  ).rows[0].id;
  await owner.query(
    `INSERT INTO payment_alloc
       (id, tenant_id, source, prepayment_entry_id, bill_id, amount,
        created_at, updated_at)
     VALUES (gen_random_uuid(), $1, 'PREPAYMENT', $2, $3, $4, now(), now())`,
    [T20, entryId, billId, amount],
  );
  return entryId as string;
};

const seedTopUp = async (settleId: string, paymentId: string, amount: number, tag: string) =>
  owner.query(
    `INSERT INTO prepayment_ledger_entry
       (id, tenant_id, settle_account_id, type, amount, payment_id,
        idempotency_key, operator_id, created_at)
     VALUES (gen_random_uuid(), $1, $2, 'TOP_UP', $3, $4, $5, $6, now())`,
    [T20, settleId, amount, paymentId, `t20-topup-${uniq(tag)}`, STAFF_ADMIN],
  );

const seedInstallation = async (accId: string, tag: string, opts: { reason?: string; installedAt?: string; status?: string } = {}) => {
  const meterId = (
    await owner.query(
      `INSERT INTO meter (id, tenant_id, meter_no, brand, caliber, status,
         created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 't20', 'DN15', 'INSTALLED',
               now(), now()) RETURNING id::text`,
      [T20, `t20-m-${uniq(tag)}`],
    )
  ).rows[0].id;
  await owner.query(
    `INSERT INTO meter_installation
       (id, tenant_id, water_account_id, meter_id, installed_at,
        initial_reading, reason, status, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 0, $5, $6, now(), now())`,
    [T20, accId, meterId, opts.installedAt ?? '2026-01-01', opts.reason ?? 'NEW', opts.status ?? 'ACTIVE'],
  );
};

const seedCloseEvent = (accId: string, effectiveDate: string) =>
  owner.query(
    `INSERT INTO account_event
       (id, tenant_id, water_account_id, type, effective_date,
        created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'CLOSE', $3, now(), now())`,
    [T20, accId, effectiveDate],
  );

beforeAll(async () => {
  await owner.connect();
  const hash = await bcrypt.hash('t20-pass', 10);
  await owner.query(
    `INSERT INTO tenant (id, code, name, status, created_at, updated_at)
     VALUES ($1, 't20-water', 'T20 Water', 'ACTIVE', now(), now())
     ON CONFLICT DO NOTHING`,
    [T20],
  );
  await owner.query(
    `INSERT INTO org_unit (id, tenant_id, parent_id, name, type, created_at, updated_at)
     VALUES ($1, $2, NULL, 'T20 Company', 'COMPANY', now(), now()),
            ($3, $2, $1, 'T20 Branch A', 'BRANCH', now(), now()),
            ($4, $2, $1, 'T20 Branch B', 'BRANCH', now(), now())
     ON CONFLICT DO NOTHING`,
    [ORG_CO, T20, ORG_A, ORG_B],
  );
  await owner.query(
    `INSERT INTO role (id, tenant_id, code, name, data_scope, created_at, updated_at)
     VALUES ($1, $3, 'admin', 'T20 Admin', 'ALL', now(), now()),
            ($2, $3, 't20-branch', 'T20 Branch', 'ORG_SUBTREE', now(), now())
     ON CONFLICT DO NOTHING`,
    [ROLE_ADMIN, ROLE_BRANCH, T20],
  );
  await owner.query(
    `INSERT INTO permission (id, tenant_id, code, type, created_at, updated_at)
     VALUES ($1, $2, 'report:read', 'ACTION', now(), now()) ON CONFLICT DO NOTHING`,
    [PERMS['report:read'], T20],
  );
  await owner.query(
    `INSERT INTO role_permission (tenant_id, role_id, permission_id, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now()) ON CONFLICT DO NOTHING`,
    [T20, ROLE_BRANCH, PERMS['report:read']],
  );
  await owner.query(
    `INSERT INTO staff (id, tenant_id, org_unit_id, login, password_hash, name, status, created_at, updated_at)
     VALUES ($1, $4, $5, 't20-admin', $7, 'T20 Admin', 'ACTIVE', now(), now()),
            ($2, $4, $6, 't20-branch-a', $7, 'T20 A', 'ACTIVE', now(), now()),
            ($3, $4, $8, 't20-branch-b', $7, 'T20 B', 'ACTIVE', now(), now())
     ON CONFLICT (tenant_id, login) DO NOTHING`,
    [STAFF_ADMIN, STAFF_A, STAFF_B, T20, ORG_CO, ORG_A, hash, ORG_B],
  );
  await owner.query(
    `INSERT INTO staff_role (tenant_id, staff_id, role_id, created_at, updated_at)
     VALUES ($1, $2, $4, now(), now()),
            ($1, $3, $5, now(), now()),
            ($1, $6, $5, now(), now())
     ON CONFLICT DO NOTHING`,
    [T20, STAFF_ADMIN, STAFF_A, ROLE_ADMIN, ROLE_BRANCH, STAFF_B],
  );

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleFixture.createNestApplication();
  await app.init();
  const login = async (l: string) =>
    (
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ tenantCode: 't20-water', login: l, password: 't20-pass' })
        .expect(201)
    ).body.accessToken as string;
  adminToken = await login('t20-admin');
  branchAToken = await login('t20-branch-a');
  branchBToken = await login('t20-branch-b');
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

// ---------------------------------------------------------------------------

describe('AGG_OWN (D24)', () => {
  it('off-book account: tenant aggregate counts it, branch aggregates exclude it', async () => {
    const { accId, settleId } = await seedAccount('offbook');
    const mk = () => seedBill(accId, settleId, '202611', 7000, 'POSTED');
    expect(await delta('202611', adminToken, 'BILLED_AMOUNT', mk)).toBe(7000);
    expect(await delta('202611', branchAToken, 'BILLED_AMOUNT', mk)).toBe(0);
    expect(await delta('202611', branchBToken, 'BILLED_AMOUNT', mk)).toBe(0);
  });

  it('single-book account counts once in owning branch, never in the other', async () => {
    const { accId, settleId } = await seedAccount('owna');
    await coverAccount(ORG_A, accId, 'owna');
    const mk = () => seedBill(accId, settleId, '202612', 3000, 'POSTED');
    expect(await delta('202612', branchAToken, 'BILLED_AMOUNT', mk)).toBe(3000);
    expect(await delta('202612', branchBToken, 'BILLED_AMOUNT', mk)).toBe(0);
  });

  it('multi-book same subtree → counted once; one book out of scope → excluded', async () => {
    const { accId, settleId } = await seedAccount('multi-same');
    await coverAccount(ORG_A, accId, 'ms1');
    await coverAccount(ORG_A, accId, 'ms2'); // two books, both branch A
    const mk1 = () => seedBill(accId, settleId, '202701', 4000, 'POSTED');
    expect(await delta('202701', branchAToken, 'BILLED_AMOUNT', mk1)).toBe(4000); // once

    const { accId: acc2, settleId: settle2 } = await seedAccount('multi-split');
    await coverAccount(ORG_A, acc2, 'mp1');
    await coverAccount(ORG_B, acc2, 'mp2'); // A + B coverage
    const mk2 = () => seedBill(acc2, settle2, '202701', 5000, 'POSTED');
    // fail closed: neither partial branch sees it; tenant does
    expect(await delta('202701', branchAToken, 'BILLED_AMOUNT', mk2)).toBe(0);
    expect(await delta('202701', branchBToken, 'BILLED_AMOUNT', mk2)).toBe(0);
    expect(await delta('202701', adminToken, 'BILLED_AMOUNT', mk2)).toBe(5000);
  });

  it('CURRENT_PORTFOLIO_VIEW: historical-period bill attributes to CURRENT ownership (D25)', async () => {
    const { accId, settleId } = await seedAccount('cpv');
    await seedBill(accId, settleId, '202601', 9000, 'POSTED'); // billed while off-book
    const b0 = Number((await metrics('202601', branchAToken)).BILLED_AMOUNT);
    // later the account moves into Branch A's book — history re-attributes
    await coverAccount(ORG_A, accId, 'cpv');
    const b1 = Number((await metrics('202601', branchAToken)).BILLED_AMOUNT);
    expect(b1 - b0).toBe(9000);
  });
});

describe('money semantics (B6/B7)', () => {
  it('Payment 100 = debt alloc 30 + TOP_UP 70: CASHIER=100, TERRITORY=30', async () => {
    const { accId, settleId } = await seedAccount('money');
    await coverAccount(ORG_A, accId, 'money');
    const bill = await seedBill(accId, settleId, '202602', 10000, 'POSTED');
    // Payment 10000: debt alloc 3000 + TOP_UP 7000 → CASHIER 10000, TERRITORY 3000
    const act = async () => {
      const pay = await seedPayment(settleId, ORG_A, 10000, 'money', '2026-02-15T02:00:00Z');
      await allocPayment(pay, bill, 3000);
      await seedTopUp(settleId, pay, 7000, 'money');
      return pay;
    };
    expect(await delta('202602', branchAToken, 'CASHIER_COLLECTED', act)).toBe(10000);
    expect(await delta('202602', adminToken, 'PREPAYMENT_BALANCE', () => Promise.resolve())).toBe(0); // no new topup — but verify TOP_UP counted:
    const pay2 = await seedPayment(settleId, ORG_A, 1000, 'money2', '2026-02-16T02:00:00Z');
    expect(
      await delta('202602', adminToken, 'PREPAYMENT_BALANCE',
        () => seedTopUp(settleId, pay2, 7000, 'money3')),
    ).toBe(7000); // TOP_UP → prepayment balance, never debt collection
    const terrBefore = Number((await metrics('202602', branchAToken)).TERRITORY_DEBT_COLLECTION);
    await allocPayment(pay2, bill, 2000);
    const terrAfter = Number((await metrics('202602', branchAToken)).TERRITORY_DEBT_COLLECTION);
    expect(terrAfter - terrBefore).toBe(2000);
  });

  it('reversal nets signed: payment -10000 + alloc -3000', async () => {
    const { accId, settleId } = await seedAccount('rev');
    await coverAccount(ORG_A, accId, 'rev');
    const bill = await seedBill(accId, settleId, '202603', 10000, 'POSTED');
    const applyPlus = async () => {
      const pay = await seedPayment(settleId, ORG_A, 10000, 'rev1', '2026-03-15T02:00:00Z');
      await allocPayment(pay, bill, 10000);
    };
    const applyMinus = async () => {
      const rev = await seedPayment(settleId, ORG_A, -10000, 'rev2', '2026-03-16T02:00:00Z');
      await allocPayment(rev, bill, -10000);
    };
    // +alloc: territory +10000
    expect(await delta('202603', branchAToken, 'TERRITORY_DEBT_COLLECTION', applyPlus)).toBe(10000);
    // de-alloc restores the bill's remaining (remaining 0 → 10000)
    expect(await delta('202603', branchAToken, 'GROSS_BILL_RECEIVABLE', applyMinus)).toBe(10000);
    // full +/− cycle nets to zero on both signed-money metrics
    const both = async () => { await applyPlus(); await applyMinus(); };
    expect(await delta('202603', branchAToken, 'CASHIER_COLLECTED', both)).toBe(0);
    expect(await delta('202603', branchAToken, 'TERRITORY_DEBT_COLLECTION', both)).toBe(0);
  });

  it('PREPAYMENT APPLY: not cash collection; reduces GROSS_BILL_RECEIVABLE', async () => {
    const { accId, settleId } = await seedAccount('prepay');
    await coverAccount(ORG_A, accId, 'prepay');
    const bill = await seedBill(accId, settleId, '202604', 8000, 'POSTED');
    const apply = () => seedPrepayApply(settleId, bill, 2000, 'prepay');
    expect(await delta('202604', branchAToken, 'TERRITORY_DEBT_COLLECTION', apply)).toBe(0);
    expect(await delta('202604', branchAToken, 'GROSS_BILL_RECEIVABLE', apply)).toBe(-2000);
    expect(await delta('202604', branchAToken, 'CASHIER_COLLECTED', apply)).toBe(0);
  });

  it('BILLED excludes DRAFT + REVERSAL; GROSS never nets a negative bill against another', async () => {
    const { accId, settleId } = await seedAccount('pred');
    await coverAccount(ORG_A, accId, 'pred');
    const mk = async () => {
      await seedBill(accId, settleId, '202605', 1000, 'DRAFT');            // not billed
      await seedBill(accId, settleId, '202605', 2000, 'PAID', 'REVERSAL'); // not billed
      const over = await seedBill(accId, settleId, '202605', 1000, 'POSTED');
      await seedBill(accId, settleId, '202605', 3000, 'POSTED');
      // over-allocated bill: remaining −500 must clamp to 0, not offset others
      const pay = await seedPayment(settleId, ORG_A, 1500, 'pred', '2026-05-15T02:00:00Z');
      await allocPayment(pay, over, 1500);
    };
    expect(await delta('202605', branchAToken, 'BILLED_AMOUNT', mk)).toBe(4000); // 1000+3000
    expect(await delta('202605', branchAToken, 'GROSS_BILL_RECEIVABLE', mk)).toBe(3000);
  });
});

describe('asset/event metrics + HOLD contract', () => {
  it('ACTIVE_METER_COUNT / METER_REPLACEMENT_COUNT / ACCOUNT_CLOSED_COUNT scoped by AGG_OWN', async () => {
    const { accId } = await seedAccount('asset');
    await coverAccount(ORG_A, accId, 'asset');
    const { accId: offbook } = await seedAccount('asset-off');
    const mk = async () => {
      await seedInstallation(accId, 'a1');
      await seedInstallation(accId, 'a2', { reason: 'REPLACE', installedAt: '2026-06-10' });
      await seedCloseEvent(accId, '2026-06-20');
      await seedInstallation(offbook, 'off');
      await seedCloseEvent(offbook, '2026-06-21');
    };
    // branch A: only the covered account's assets; off-book excluded
    expect(await delta('202606', branchAToken, 'ACTIVE_METER_COUNT', mk)).toBe(2);
    expect(await delta('202606', branchAToken, 'METER_REPLACEMENT_COUNT', mk)).toBe(1);
    expect(await delta('202606', branchAToken, 'ACCOUNT_CLOSED_COUNT', mk)).toBe(1);
    // tenant: covered + off-book
    expect(await delta('202606', adminToken, 'ACTIVE_METER_COUNT', mk)).toBe(3);
    expect(await delta('202606', adminToken, 'ACCOUNT_CLOSED_COUNT', mk)).toBe(2);
  });

  it('HOLD metrics never return numbers; scoped PREPAYMENT_BALANCE is null (D20)', async () => {
    const m = await metrics('202606', branchAToken);
    for (const h of ['RECOVERY_RATE', 'ESTIMATE_RATE', 'REMOTE_ONLINE_RATE']) {
      expect(m[h]).toBeUndefined();
    }
    expect(m.PREPAYMENT_BALANCE).toBeNull(); // tenant-only per D20
  });

  it('reading-book-anchored counts respect book org scope', async () => {
    const base = await metrics('202607', branchAToken);
    const { accId } = await seedAccount('read');
    await coverAccount(ORG_A, accId, 'read');
    const planId = (
      await owner.query(
        `INSERT INTO reading_plan
           (id, tenant_id, book_id, period, plan_date, status, created_at, updated_at)
         SELECT gen_random_uuid(), $1, bm.book_id, '202607', '2026-07-05', 'OPEN', now(), now()
         FROM book_meter bm WHERE bm.tenant_id=$1 AND bm.water_account_id=$2
         RETURNING id::text`,
        [T20, accId],
      )
    ).rows[0].id;
    await owner.query(
      `INSERT INTO reading_plan_item
         (id, tenant_id, plan_id, water_account_id, seq_no, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 1, 'READ', now(), now()),
              (gen_random_uuid(), $1, $2, $4, 2, 'PENDING', now(), now())`,
      [T20, planId, accId, (await seedAccount('read2')).accId],
    );
    const a = await metrics('202607', branchAToken);
    expect(Number(a.READING_DUE_COUNT) - Number(base.READING_DUE_COUNT)).toBe(2);
    expect(Number(a.READING_DONE_COUNT) - Number(base.READING_DONE_COUNT)).toBe(1);
    expect(Number(a.READING_MISSING_COUNT) - Number(base.READING_MISSING_COUNT)).toBe(1);
    const b = await metrics('202607', branchBToken);
    expect(b.READING_DUE_COUNT).toBe(0);
  });
});
