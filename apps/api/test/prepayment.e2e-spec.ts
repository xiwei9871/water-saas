/**
 * Prepayment (E6) e2e against `watersaas_test` — fixtures carry the
 * `t16-` prefix. Boots the real AppModule so JWT/permission guards,
 * tenant ALS and RLS all apply.
 *
 * Covers the E6 domain-design §22 matrix:
 *  1. TOP_UP splits one counter payment into debt-first PAYMENT allocs
 *     + a TOP_UP lot — one Payment, one Receipt, one cash event
 *  2. No debt → full TOP_UP; amount < debt → allocs only, no lot
 *  3. Billing-run post auto-APPLY: full → PAID, partial → PARTIAL_PAID,
 *     FIFO across lots, comparator ordering incl. dueDate-null fallback
 *  4. Idempotent top-up replay returns the same payment
 *  5. Mixed payment reversal: cash allocs mirror + TOP_UP leg reverses
 *     append-only; consumed lot → 409 PREPAYMENT_ALREADY_APPLIED; bill
 *     reversal restores the lot so the reversal then succeeds
 *  6. REFUND: FIFO legs, negative Payment, over-balance → 409, refund
 *     payment not reversable, prepayment:reverse gate
 *  7. PAID bill with a PREPAYMENT leg is reversible; pure-cash PAID → 409
 *  8. DayClose prepaymentBreakdown conservation + non-cash systemApply
 *  9. WaterAccount transfer never migrates the settle-account balance
 * 10. Permission matrix: reader 403 on writes; cashier lacks
 *     prepayment:reverse for refund; yesterday's unclosed top-up
 *     reversal needs prepayment:reverse; that perm alone cannot reverse
 *     a pure-cash payment
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

// ---- fixtures (all prefixed t16-) ----
const T16A = 'aa16aa16-1616-4016-8016-aa16aa16aa16';
const T16B = 'bb16bb16-2020-4020-8020-bb16bb16bb16';
const ORG_A = 'aa16aa16-0000-4000-8000-0000000000c0';
const ORG_B = 'bb16bb16-0000-4000-8000-0000000000c0';
const ROLE_ADMIN_A = 'aa16aa16-0000-4000-8000-00000000ad01';
const ROLE_READER_A = 'aa16aa16-0000-4000-8000-000000001e01';
const ROLE_CASHIER_A = 'aa16aa16-0000-4000-8000-00000000ca01';
const ROLE_SUPERVISOR_A = 'aa16aa16-0000-4000-8000-00000000c011';
const ROLE_B_ADMIN = 'bb16bb16-0000-4000-8000-00000000ad01';
const PERM_PAY_READ = 'aa16aa16-0000-4000-8000-00000000e801';
const PERM_PAY_WRITE = 'aa16aa16-0000-4000-8000-00000000e802';
const PERM_PREPAY_REV = 'aa16aa16-0000-4000-8000-00000000e803';
const STAFF_ADMIN_A = 'aa16aa16-0000-4000-8000-0000000a0001';
const STAFF_READER_A = 'aa16aa16-0000-4000-8000-0000000b0002';
const STAFF_CASHIER_A = 'aa16aa16-0000-4000-8000-0000000a0003';
const STAFF_SUPERVISOR_A = 'aa16aa16-0000-4000-8000-0000000c0003';
const STAFF_CASHIER2_A = 'aa16aa16-0000-4000-8000-0000000a0004';
const STAFF_B_ADMIN = 'bb16bb16-0000-4000-8000-0000000a0001';

const owner = new pg.Client({ connectionString: OWNER_URL });
let app: INestApplication<App>;
let adminToken = '';
let readerToken = '';
let cashierToken = '';
let cashier2Token = '';
let supervisorToken = '';
let tenantBToken = '';
let planId = '';

const acct: Record<string, string> = {};
const settleAcct: Record<string, string> = {};
const bill: Record<string, string> = {};
const settle: Record<string, string> = {};
const inst: Record<string, string> = {};
const meter: Record<string, string> = {};
const reading: Record<string, string> = {};

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

const post = (path: string, body: unknown, token = adminToken) =>
  request(app.getHttpServer()).post(path).set(auth(token)).send(body);

const get = (path: string, token = adminToken, status = 200) =>
  request(app.getHttpServer()).get(path).set(auth(token)).expect(status);

const postIdem = (path: string, body: unknown, key: string, token = adminToken) =>
  request(app.getHttpServer())
    .post(path)
    .set(auth(token))
    .set('Idempotency-Key', key)
    .send(body);

const onboard = async (label: string) => {
  const res = await post('/water-accounts/onboard', {
    customer: { name: `T16 ${label} ${RUN}`, custType: 'PERSONAL' },
    account: { usageCategory: 'RES_METERED', addr: `${label} Prepay St` },
    meter: { brand: 't16-brand', caliber: 'DN15' },
    installation: { initialReading: 0, installedAt: '2026-01-01' },
  }).expect(201);
  acct[label] = res.body.waterAccount.id;
  settleAcct[label] = res.body.settleAccount.id;
  inst[label] = res.body.installation.id;
  meter[label] = res.body.installation.meterId;
  return res.body;
};

/** Insert a trusted meter_reading (PASSED ACTUAL) — recon fixtures. */
const seedReading = async (
  label: string,
  instId: string,
  meterId: string,
  period: string,
  readDate: string,
  value: string,
) => {
  const row = (
    await owner.query(
      `INSERT INTO meter_reading
         (id, tenant_id, installation_id, meter_id, period, read_date,
          result_type, reading_value, qc_status, source, operator_id,
          created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'ACTUAL', $6,
               'PASSED', 'WEB', $7, now(), now())
       RETURNING id::text AS id`,
      [T16A, instId, meterId, period, readDate, value, STAFF_ADMIN_A],
    )
  ).rows[0];
  reading[label] = row.id;
  return row.id as string;
};

const seedSettlement = async (
  label: string,
  waterAccountId: string,
  period: string,
  usage: number,
) => {
  const row = (
    await owner.query(
      `INSERT INTO consumption_settlement
         (id, tenant_id, water_account_id, period, total_usage_qty, is_estimated,
          estimate_method, estimate_reason, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, false, NULL, NULL, 'FINAL', now(), now())
       RETURNING id::text AS id`,
      [T16A, waterAccountId, period, usage],
    )
  ).rows[0];
  settle[label] = row.id;
  return row.id as string;
};

/** Direct POSTED bill insert — bypasses APPLY (fixture debt). */
const seedBill = async (
  label: string,
  waterAccountId: string,
  settleAccountId: string,
  period: string,
  totalAmount: number,
  opts: { status?: string; dueDate?: string | null; tariffPlanId?: string | null } = {},
) => {
  const sourceId = await seedSettlement(`${label}-s`, waterAccountId, period, 1);
  const row = (
    await owner.query(
      `INSERT INTO bill (id, tenant_id, settle_account_id, water_account_id, period,
                         bill_kind, source_type, source_id, tariff_plan_id, status,
                         is_estimated, total_amount, issued_at, due_date,
                         created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'NORMAL', 'SETTLEMENT', $5,
               $6::uuid, $7, false, $8, now(), $9::date, now(), now())
       RETURNING id::text AS id`,
      [
        T16A,
        settleAccountId,
        waterAccountId,
        period,
        sourceId,
        opts.tariffPlanId ?? null,
        opts.status ?? 'POSTED',
        totalAmount,
        opts.dueDate === undefined ? '2026-07-15' : opts.dueDate,
      ],
    )
  ).rows[0];
  bill[label] = row.id;
  return row.id as string;
};

const balance = async (settleAccountId: string, token = adminToken) =>
  (await get(`/prepayments/balance?settleAccountId=${settleAccountId}`, token))
    .body as { balance: string; lots: { topUpEntryId: string; remaining: string }[] };

const entries = async (settleAccountId: string, type?: string) =>
  (
    await get(
      `/prepayments/entries?settleAccountId=${settleAccountId}${type ? `&type=${type}` : ''}&take=100`,
    )
  ).body.items as {
    id: string;
    type: string;
    amount: string;
    billId: string | null;
    paymentId: string | null;
    originTopUpId: string | null;
    reversalOfEntryId: string | null;
  }[];

const billStatus = async (id: string) =>
  (await get(`/bills/${id}`)).body.status as string;

/** Onboard + topup helper — returns the API result. */
const topUp = (
  settleAccountId: string,
  amount: number,
  token = adminToken,
  channel = 'CASH',
) =>
  post('/prepayments/top-ups', { settleAccountId, channel, amount: String(amount) }, token);

beforeAll(async () => {
  await owner.connect();
  const hash = await bcrypt.hash('t16-pass', 10);

  await owner.query(
    `INSERT INTO tenant (id, code, name, status, created_at, updated_at)
     VALUES ($1, 't16-water', 'T16 Water', 'ACTIVE', now(), now()),
            ($2, 't16-other', 'T16 Other', 'ACTIVE', now(), now())
     ON CONFLICT DO NOTHING`,
    [T16A, T16B],
  );
  await owner.query(
    `INSERT INTO org_unit (id, tenant_id, parent_id, name, type, created_at, updated_at)
     VALUES ($1, $2, NULL, 'T16 Company', 'COMPANY', now(), now()),
            ($3, $4, NULL, 'T16B Company', 'COMPANY', now(), now())
     ON CONFLICT DO NOTHING`,
    [ORG_A, T16A, ORG_B, T16B],
  );
  await owner.query(
    `INSERT INTO role (id, tenant_id, code, name, data_scope, created_at, updated_at)
     VALUES ($1, $3, 'admin', 'T16 Admin', 'ALL', now(), now()),
            ($2, $3, 't16-reader', 'T16 Reader', 'ORG_SUBTREE', now(), now()),
            ($4, $3, 't16-cashier', 'T16 Cashier', 'ORG_SUBTREE', now(), now()),
            ($5, $3, 't16-super', 'T16 Supervisor', 'ORG_SUBTREE', now(), now()),
            ($6, $7, 'admin', 'T16B Admin', 'ALL', now(), now())
     ON CONFLICT DO NOTHING`,
    [ROLE_ADMIN_A, ROLE_READER_A, T16A, ROLE_CASHIER_A, ROLE_SUPERVISOR_A, ROLE_B_ADMIN, T16B],
  );
  await owner.query(
    `INSERT INTO permission (id, tenant_id, code, type, created_at, updated_at)
     VALUES ($1, $2, 'payment:read', 'ACTION', now(), now()),
            ($3, $2, 'payment:write', 'ACTION', now(), now()),
            ($4, $2, 'prepayment:reverse', 'ACTION', now(), now())
     ON CONFLICT DO NOTHING`,
    [PERM_PAY_READ, T16A, PERM_PAY_WRITE, PERM_PREPAY_REV],
  );
  await owner.query(
    `INSERT INTO role_permission (tenant_id, role_id, permission_id, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now()),
            ($1, $4, $3, now(), now()),
            ($1, $4, $5, now(), now()),
            ($1, $6, $3, now(), now()),
            ($1, $6, $7, now(), now())
     ON CONFLICT DO NOTHING`,
    [T16A, ROLE_READER_A, PERM_PAY_READ, ROLE_CASHIER_A, PERM_PAY_WRITE, ROLE_SUPERVISOR_A, PERM_PREPAY_REV],
  );
  await owner.query(
    `INSERT INTO staff (id, tenant_id, org_unit_id, login, password_hash, name, status, created_at, updated_at)
     VALUES ($1, $5, $7, 't16-admin', $8, 'T16 Admin', 'ACTIVE', now(), now()),
            ($2, $5, $7, 't16-reader', $8, 'T16 Reader', 'ACTIVE', now(), now()),
            ($3, $5, $7, 't16-cashier', $8, 'T16 Cashier', 'ACTIVE', now(), now()),
            ($4, $5, $7, 't16-super', $8, 'T16 Supervisor', 'ACTIVE', now(), now()),
            ($6, $9, $10, 't16b-admin', $8, 'T16B Admin', 'ACTIVE', now(), now()),
            ($11, $5, $7, 't16-cashier2', $8, 'T16 Cashier2', 'ACTIVE', now(), now())
     ON CONFLICT (tenant_id, login) DO NOTHING`,
    [
      STAFF_ADMIN_A, STAFF_READER_A, STAFF_CASHIER_A, STAFF_SUPERVISOR_A,
      T16A, STAFF_B_ADMIN, ORG_A, hash, T16B, ORG_B, STAFF_CASHIER2_A,
    ],
  );
  await owner.query(
    `INSERT INTO staff_role (tenant_id, staff_id, role_id, created_at, updated_at)
     VALUES ($1, $2, $5, now(), now()),
            ($1, $3, $6, now(), now()),
            ($1, $4, $7, now(), now()),
            ($1, $8, $9, now(), now()),
            ($10, $11, $12, now(), now()),
            ($1, $13, $7, now(), now())
     ON CONFLICT DO NOTHING`,
    [
      T16A, STAFF_ADMIN_A, STAFF_READER_A, STAFF_CASHIER_A, ROLE_ADMIN_A,
      ROLE_READER_A, ROLE_CASHIER_A, STAFF_SUPERVISOR_A, ROLE_SUPERVISOR_A,
      T16B, STAFF_B_ADMIN, ROLE_B_ADMIN, STAFF_CASHIER2_A,
    ],
  );

  for (const table of [
    'payment_alloc',
    'prepayment_ledger_entry',
    'receipt',
    'payment',
    'cashier_day_close',
    'bill_item',
    'bill',
    'billing_run',
    'reconciliation',
    'consumption_component',
    'consumption_settlement',
    'meter_reading',
    'reading_plan_item',
    'reading_plan',
    'book_meter',
    'reading_book',
    'account_event',
    'meter_installation',
    'meter',
    'water_account_household_profile',
    'water_account',
    'settle_account',
    'customer',
    'tariff_tier',
    'tariff_plan',
    'fee_item',
    'tenant_param',
    'raw_remote_event',
    'remote_device_binding',
    'remote_device',
    'remote_source',
  ]) {
    await owner.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [T16A]);
  }

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleFixture.createNestApplication();
  await app.init();

  const login = async (tenantCode: string, login_: string) =>
    (
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ tenantCode, login: login_, password: 't16-pass' })
        .expect(201)
    ).body.accessToken as string;
  adminToken = await login('t16-water', 't16-admin');
  readerToken = await login('t16-water', 't16-reader');
  cashierToken = await login('t16-water', 't16-cashier');
  cashier2Token = await login('t16-water', 't16-cashier2');
  supervisorToken = await login('t16-water', 't16-super');
  tenantBToken = await login('t16-other', 't16b-admin');

  // ACTIVE plan for the billing-run/replace paths: 3.0/m³ + 10 fixed.
  const waterItem = (
    await post('/fee-items', {
      code: `WATER-${RUN}`,
      name: '水费',
      calcType: 'PER_QTY',
    }).expect(201)
  ).body.id;
  const fixedItem = (
    await post('/fee-items', {
      code: `FIXED-${RUN}`,
      name: '定额费',
      calcType: 'FIXED',
    }).expect(201)
  ).body.id;
  planId = (
    await post('/tariff-plans', {
      code: `RES-${RUN}`,
      name: '居民水价',
      usageCategory: 'RES_METERED',
      effectiveFrom: '2026-01-01',
      tiers: [
        { feeItemId: waterItem, tierNo: 1, fromQty: 0, toQty: null, unitPrice: '3.0' },
        { feeItemId: fixedItem, tierNo: 1, fromQty: 0, toQty: null, unitPrice: '10' },
      ],
    }).expect(201)
  ).body.id;
  await post(`/tariff-plans/${planId}/activate`, {}).expect(201);
});

afterAll(async () => {
  await app?.close();
  await owner.end();
});

// ---------------------------------------------------------------------------
// TOP_UP split semantics
// ---------------------------------------------------------------------------

describe('TOP_UP — debt-first split, one money event', () => {
  it('欠费 80 + 收款 200 → 80 PAYMENT alloc + 120 TOP_UP + 1 Payment + 1 Receipt', async () => {
    await onboard('S1');
    const b = await seedBill('S1', acct['S1'], settleAcct['S1'], '202601', 8000);
    const res = await topUp(settleAcct['S1'], 20000).expect(201);
    expect(res.body.billAllocs).toEqual([{ billId: b, amount: '8000' }]);
    expect(res.body.topUp).toBe('12000');
    expect(res.body.topUpEntryId).toBeTruthy();
    expect(res.body.receipt?.receiptNo).toBeTruthy();
    expect(await billStatus(b)).toBe('PAID');
    expect((await balance(settleAcct['S1'])).balance).toBe('12000');
    // one payment, one receipt, ledger leg carries the payment ref
    const legs = await entries(settleAcct['S1'], 'TOP_UP');
    expect(legs).toHaveLength(1);
    expect(legs[0].amount).toBe('12000');
    expect(legs[0].paymentId).toBe(res.body.payment.id);
  });

  it('无欠费 → 全额 TOP_UP', async () => {
    await onboard('S2');
    const res = await topUp(settleAcct['S2'], 15000).expect(201);
    expect(res.body.billAllocs).toEqual([]);
    expect(res.body.topUp).toBe('15000');
    expect((await balance(settleAcct['S2'])).balance).toBe('15000');
  });

  it('收款不足清欠 → 全部分摊，无 TOP_UP', async () => {
    await onboard('S3');
    const b = await seedBill('S3', acct['S3'], settleAcct['S3'], '202601', 30000);
    const res = await topUp(settleAcct['S3'], 10000).expect(201);
    expect(res.body.billAllocs).toEqual([{ billId: b, amount: '10000' }]);
    expect(res.body.topUp).toBe('0');
    expect(res.body.topUpEntryId).toBeNull();
    expect(await billStatus(b)).toBe('PARTIAL_PAID');
    expect((await balance(settleAcct['S3'])).balance).toBe('0');
  });

  it('欠费排序 comparator：dueDate NULL 回退 period 月末，先清最老有效到期', async () => {
    await onboard('S4');
    // old: no dueDate, period 202401 → effectiveDue 2024-01-31
    const oldB = await seedBill('S4-old', acct['S4'], settleAcct['S4'], '202401', 5000, {
      dueDate: null,
    });
    // new: dueDate 2026-07-15, period 202607
    const newB = await seedBill('S4-new', acct['S4'], settleAcct['S4'], '202607', 6000, {
      dueDate: '2026-07-15',
    });
    // pay exactly the old bill's amount → comparator must pick old first
    const res = await topUp(settleAcct['S4'], 5000).expect(201);
    expect(res.body.billAllocs).toEqual([{ billId: oldB, amount: '5000' }]);
    expect(await billStatus(oldB)).toBe('PAID');
    expect(await billStatus(newB)).toBe('POSTED');
  });

  it('幂等重放：同 Idempotency-Key 返回同一 Payment，余额不重复入账', async () => {
    await onboard('S5');
    const key = `t16-topup-${RUN}`;
    const r1 = await postIdem(
      '/prepayments/top-ups',
      { settleAccountId: settleAcct['S5'], channel: 'CASH', amount: '9000' },
      key,
    ).expect(201);
    // 幂等重放返回已存的响应（状态码即当初写入的 201）
    const r2 = await postIdem(
      '/prepayments/top-ups',
      { settleAccountId: settleAcct['S5'], channel: 'CASH', amount: '9000' },
      key,
    ).expect(201);
    expect(r2.body.payment.id).toBe(r1.body.payment.id);
    expect((await balance(settleAcct['S5'])).balance).toBe('9000');
  });
});

// ---------------------------------------------------------------------------
// auto-APPLY on new payable POSTED debt
// ---------------------------------------------------------------------------

describe('APPLY — new POSTED debt consumes prepayment', () => {
  it('billing run 过账自动全额抵扣 → PAID', async () => {
    await onboard('A1');
    await topUp(settleAcct['A1'], 25000).expect(201);
    await seedSettlement('A1-01', acct['A1'], '202601', 50); // 50×3+10 = 16000
    const run = (await post('/billing-runs', { period: '202601' }).expect(201)).body;
    await post(`/billing-runs/${run.id}/post`, {}).expect(201);
    const detail = (await get(`/bills/${run.bills[0].id}`)).body;
    expect(detail.status).toBe('PAID');
    expect(detail.allocs).toEqual([
      expect.objectContaining({ source: 'PREPAYMENT', amount: '16000' }),
    ]);
    expect((await balance(settleAcct['A1'])).balance).toBe('9000');
    const applyLegs = (await entries(settleAcct['A1'], 'APPLY')).filter(
      (e) => e.billId === detail.id,
    );
    expect(applyLegs).toHaveLength(1);
    expect(applyLegs[0].amount).toBe('-16000');
    // alloc↔entry 1:1
    expect(detail.allocs[0].prepaymentEntryId).toBe(applyLegs[0].id);
  });

  it('余额不足 → 部分抵扣 PARTIAL_PAID', async () => {
    await onboard('A2');
    await topUp(settleAcct['A2'], 5000).expect(201);
    await seedSettlement('A2-02', acct['A2'], '202602', 50);
    const run = (await post('/billing-runs', { period: '202602' }).expect(201)).body;
    await post(`/billing-runs/${run.id}/post`, {}).expect(201);
    const detail = (await get(`/bills/${run.bills[0].id}`)).body;
    expect(detail.status).toBe('PARTIAL_PAID');
    expect((await balance(settleAcct['A2'])).balance).toBe('0');
  });

  it('FIFO：两笔充值批次按 createdAt 顺序消耗', async () => {
    await onboard('A3');
    const t1 = (await topUp(settleAcct['A3'], 6000).expect(201)).body;
    const t2 = (await topUp(settleAcct['A3'], 4000).expect(201)).body;
    const b = await seedBill('A3', acct['A3'], settleAcct['A3'], '202603', 8000, {
      tariffPlanId: planId,
    });
    // 账单是 fixture 直插 —— 用 replace 触发"新 POSTED 债务"入口
    await post(`/bills/${b}/replace`, { usageQty: '30' }).expect(201);
    // replacement bill: 30×3+10 = 100 元 → 10000¢ > balance(10000)? equal → PAID
    const bal = await balance(settleAcct['A3']);
    const applyLegs = await entries(settleAcct['A3'], 'APPLY');
    expect(applyLegs.length).toBeGreaterThanOrEqual(2);
    const byOrigin = new Map(applyLegs.map((e) => [e.originTopUpId, e.amount]));
    // replacement = 30×3+10 = 100 元 → lot1 6000 耗光后 lot2 再耗 4000
    expect(byOrigin.get(t1.topUpEntryId)).toBe('-6000');
    expect(byOrigin.get(t2.topUpEntryId)).toBe('-4000');
    expect(bal.balance).toBe('0');
  });

  it('replace 产生的新正债务自动 APPLY', async () => {
    await onboard('A4');
    // 先充值（无欠费 → 全预存），再直插 POSTED 账单 —— 否则充值会先清欠
    await topUp(settleAcct['A4'], 12000).expect(201);
    const b = await seedBill('A4', acct['A4'], settleAcct['A4'], '202604', 8000, {
      tariffPlanId: planId,
    });
    const res = await post(`/bills/${b}/replace`, { usageQty: '30' }).expect(201);
    const replacement = res.body;
    expect(replacement.billKind).toBe('REPLACEMENT');
    expect(replacement.status).toBe('PAID'); // 12000 ≥ 10000 → auto applied
    expect((await balance(settleAcct['A4'])).balance).toBe('2000');
  });
});

// ---------------------------------------------------------------------------
// reconciliation ADJUSTMENT entry point (domain §9)
// ---------------------------------------------------------------------------

describe('reconciliation ADJUSTMENT — positive applies, non-positive skips', () => {
  it('正 ADJUSTMENT 账单自动 APPLY', async () => {
    await onboard('ADJ1');
    // anchor 1000 + FINAL settlement 30@202607 → billing run posts 100.00
    await seedReading(
      'ADJ1-anchor', inst['ADJ1'], meter['ADJ1'], '202606', '2026-06-30', '1000',
    );
    await seedSettlement('ADJ1-07', acct['ADJ1'], '202607', 30);
    const run = (await post('/billing-runs', { period: '202607' }).expect(201)).body;
    await post(`/billing-runs/${run.id}/post`, {}).expect(201);
    // 充值 200：清欠 100 + 预存 100
    await topUp(settleAcct['ADJ1'], 20000).expect(201);
    // actual 1040 → span usage 40 → correctCharge 130.00 vs posted 100.00
    // → positive ADJUSTMENT 30.00 POSTED → 同事务 APPLY
    await seedReading(
      'ADJ1-actual', inst['ADJ1'], meter['ADJ1'], '202608', '2026-08-31', '1040',
    );
    await post('/reconciliations', { waterAccountId: acct['ADJ1'] }).expect(201);
    const bills = (await get(`/bills?waterAccountId=${acct['ADJ1']}`)).body as {
      billKind: string;
      status: string;
      totalAmount: string;
    }[];
    const adj = bills.find((b) => b.billKind === 'ADJUSTMENT');
    expect(adj).toBeTruthy();
    expect(Number(adj!.totalAmount)).toBeGreaterThan(0);
    expect(adj!.status).toBe('PAID'); // auto-applied in the same tx
    // 10000 预存 − 正调整额
    expect((await balance(settleAcct['ADJ1'])).balance).toBe(
      (10000 - Number(adj!.totalAmount)).toString(),
    );
  });

  it('负 ADJUSTMENT 不触发 APPLY（余额不动）', async () => {
    await onboard('ADJ2');
    await seedReading(
      'ADJ2-anchor', inst['ADJ2'], meter['ADJ2'], '202606', '2026-06-30', '1000',
    );
    await seedSettlement('ADJ2-07', acct['ADJ2'], '202607', 30);
    const run = (await post('/billing-runs', { period: '202607' }).expect(201)).body;
    await post(`/billing-runs/${run.id}/post`, {}).expect(201);
    await topUp(settleAcct['ADJ2'], 20000).expect(201);
    // actual 1020 → usage 20 → correct 70.00 < posted 100.00 → −3000 调整单
    await seedReading(
      'ADJ2-actual', inst['ADJ2'], meter['ADJ2'], '202608', '2026-08-31', '1020',
    );
    const before = (await balance(settleAcct['ADJ2'])).balance;
    await post('/reconciliations', { waterAccountId: acct['ADJ2'] }).expect(201);
    const bills = (await get(`/bills?waterAccountId=${acct['ADJ2']}`)).body as {
      id: string;
      billKind: string;
      totalAmount: string;
    }[];
    const adj = bills.find((b) => b.billKind === 'ADJUSTMENT');
    expect(adj).toBeTruthy();
    expect(Number(adj!.totalAmount)).toBeLessThan(0);
    const legs = await entries(settleAcct['ADJ2'], 'APPLY');
    expect(legs.filter((e) => e.billId === adj!.id)).toEqual([]);
    expect((await balance(settleAcct['ADJ2'])).balance).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// reversal semantics
// ---------------------------------------------------------------------------

describe('reversal — mixed payment + consumed lot + bill red-flush', () => {
  it('混合收款当日本人冲正：现金镜像 + TOP_UP 腿 REVERSAL', async () => {
    await onboard('R1');
    const b = await seedBill('R1', acct['R1'], settleAcct['R1'], '202601', 8000);
    // cashier 本人当日未日结 → payment:write 即可冲正含 TOP_UP 的收款
    const res = await topUp(settleAcct['R1'], 20000, cashierToken).expect(201);
    const rev = await post(`/payments/${res.body.payment.id}/reverse`, {}, cashierToken).expect(201);
    expect(rev.body.amount).toBe('-20000');
    expect(await billStatus(b)).toBe('POSTED'); // 欠费恢复
    expect((await balance(settleAcct['R1'])).balance).toBe('0');
    const legs = await entries(settleAcct['R1'], 'REVERSAL');
    expect(legs).toHaveLength(1);
    expect(legs[0].amount).toBe('-12000');
    expect(legs[0].reversalOfEntryId).toBe(res.body.topUpEntryId);
    expect(legs[0].paymentId).toBe(rev.body.id);
  });

  it('批次已消耗 → 冲正 409 PREPAYMENT_ALREADY_APPLIED；账单红冲恢复后可冲', async () => {
    await onboard('R2');
    const res = await topUp(settleAcct['R2'], 20000).expect(201);
    await seedSettlement('R2-06', acct['R2'], '202606', 50);
    const run = (await post('/billing-runs', { period: '202606' }).expect(201)).body;
    await post(`/billing-runs/${run.id}/post`, {}).expect(201);
    const appliedBill = run.bills[0].id;
    expect(await billStatus(appliedBill)).toBe('PAID'); // 16000 applied

    const deny = await post(`/payments/${res.body.payment.id}/reverse`, {});
    expect(deny.status).toBe(409);
    expect(deny.body.code ?? deny.body.message?.code).toBe('PREPAYMENT_ALREADY_APPLIED');

    // 账单红冲 → REVERSAL(+16000) 恢复批次 → 冲正放行
    await post(`/bills/${appliedBill}/reverse`, {}).expect(201);
    expect((await balance(settleAcct['R2'])).balance).toBe('20000');
    await post(`/payments/${res.body.payment.id}/reverse`, {}).expect(201);
    expect((await balance(settleAcct['R2'])).balance).toBe('0');
  });

  it('昨日未日结的含 TOP_UP 收款：payment:write 拒、prepayment:reverse 放行', async () => {
    await onboard('R3');
    const res = await topUp(settleAcct['R3'], 10000, cashierToken).expect(201);
    // 模拟昨日收款（仍 day_close_id IS NULL —— 漏日结 ≠ 当日）
    await owner.query(`UPDATE payment SET received_at = now() - interval '1 day' WHERE id = $1`, [
      res.body.payment.id,
    ]);
    const denyCashier = await post(
      `/payments/${res.body.payment.id}/reverse`,
      {},
      cashierToken,
    );
    expect(denyCashier.status).toBe(403);
    const allow = await post(
      `/payments/${res.body.payment.id}/reverse`,
      {},
      supervisorToken,
    ).expect(201);
    expect(allow.body.amount).toBe('-10000');
    expect((await balance(settleAcct['R3'])).balance).toBe('0');
  });

  it('prepayment:reverse 不授予普通现金冲正权限', async () => {
    await onboard('R4');
    const b = await seedBill('R4', acct['R4'], settleAcct['R4'], '202601', 8000);
    const cash = await post('/payments', {
      settleAccountId: settleAcct['R4'],
      channel: 'CASH',
      amount: '8000',
      allocs: [{ billId: b, amount: '8000' }],
    }).expect(201);
    const deny = await post(`/payments/${cash.body.id}/reverse`, {}, supervisorToken);
    expect(deny.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// REFUND
// ---------------------------------------------------------------------------

describe('REFUND — money out, FIFO legs, guards', () => {
  it('跨批次退款按 FIFO 拆行，产生负 Payment', async () => {
    await onboard('F1');
    const t1 = (await topUp(settleAcct['F1'], 6000).expect(201)).body;
    const t2 = (await topUp(settleAcct['F1'], 4000).expect(201)).body;
    const res = await post(
      '/prepayments/refunds',
      {
        settleAccountId: settleAcct['F1'],
        channel: 'CASH',
        amount: '8000',
        reason: '客户迁出退款',
      },
      supervisorToken,
    ).expect(201);
    expect(res.body.payment.amount).toBe('-8000');
    expect(res.body.entries).toEqual([
      { id: expect.any(String), originTopUpId: t1.topUpEntryId, amount: '-6000' },
      { id: expect.any(String), originTopUpId: t2.topUpEntryId, amount: '-2000' },
    ]);
    expect((await balance(settleAcct['F1'])).balance).toBe('2000');

    // 退款产生的负 Payment 不可再冲正
    const deny = await post(`/payments/${res.body.payment.id}/reverse`, {}, supervisorToken);
    expect(deny.status).toBe(400);
  });

  it('退款超额 → 409 PREPAYMENT_INSUFFICIENT_BALANCE；无权限 → 403', async () => {
    await onboard('F2');
    await topUp(settleAcct['F2'], 5000).expect(201);
    const over = await post(
      '/prepayments/refunds',
      {
        settleAccountId: settleAcct['F2'],
        channel: 'CASH',
        amount: '5001',
        reason: 'x',
      },
      supervisorToken,
    );
    expect(over.status).toBe(409);
    expect(over.body.code ?? over.body.message?.code).toBe(
      'PREPAYMENT_INSUFFICIENT_BALANCE',
    );
    const noPerm = await post(
      '/prepayments/refunds',
      {
        settleAccountId: settleAcct['F2'],
        channel: 'CASH',
        amount: '1000',
        reason: 'x',
      },
      cashierToken,
    );
    expect(noPerm.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// bill reversal + PAID rules
// ---------------------------------------------------------------------------

describe('bill red-flush — PAID+预存可纠正，纯现金 PAID 仍禁', () => {
  it('预存抵扣的 PAID 账单红冲恢复批次', async () => {
    await onboard('B1');
    await topUp(settleAcct['B1'], 20000).expect(201);
    await seedSettlement('B1-07', acct['B1'], '202607', 50);
    const run = (await post('/billing-runs', { period: '202607' }).expect(201)).body;
    await post(`/billing-runs/${run.id}/post`, {}).expect(201);
    const appliedBill = run.bills[0].id;
    expect(await billStatus(appliedBill)).toBe('PAID');
    await post(`/bills/${appliedBill}/reverse`, {}).expect(201);
    expect((await balance(settleAcct['B1'])).balance).toBe('20000');
    // REVERSAL(+16000) + 负向 PREPAYMENT alloc
    const revLegs = (await entries(settleAcct['B1'], 'REVERSAL')).filter(
      (e) => e.billId === appliedBill,
    );
    expect(revLegs).toHaveLength(1);
    expect(revLegs[0].amount).toBe('16000');
  });

  it('纯现金 PAID 账单 → 409 BILL_NOT_REVERSABLE', async () => {
    await onboard('B2');
    const b = await seedBill('B2', acct['B2'], settleAcct['B2'], '202608', 8000);
    await post('/payments', {
      settleAccountId: settleAcct['B2'],
      channel: 'CASH',
      amount: '8000',
      allocs: [{ billId: b, amount: '8000' }],
    }).expect(201);
    expect(await billStatus(b)).toBe('PAID');
    const deny = await post(`/bills/${b}/reverse`, {});
    expect(deny.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// day close breakdown + transfer
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// old-debt rescan + concurrency (domain §9/§14)
// ---------------------------------------------------------------------------

describe('rescan + concurrency', () => {
  it('老欠费随新债务入口整户重扫', async () => {
    await onboard('C1');
    await topUp(settleAcct['C1'], 10000).expect(201); // 无欠费 → 全预存
    // 直插两张老欠费（绕过 APPLY 入口，模拟存量欠费）
    const o1 = await seedBill('C1-a', acct['C1'], settleAcct['C1'], '202401', 3000);
    const o2 = await seedBill('C1-b', acct['C1'], settleAcct['C1'], '202402', 4000);
    // 新 POSTED 债务入口 → apply 整户重扫：老账单先于新账单被 APPLY
    await seedSettlement('C1-09', acct['C1'], '202609', 10); // 10×3+10=4000
    const run = (await post('/billing-runs', { period: '202609' }).expect(201)).body;
    await post(`/billing-runs/${run.id}/post`, {}).expect(201);
    expect(await billStatus(o1)).toBe('PAID');
    expect(await billStatus(o2)).toBe('PAID');
    const legs = await entries(settleAcct['C1'], 'APPLY');
    expect(legs.map((l) => l.billId).sort()).toEqual(
      [o1, o2, run.bills[0].id].sort(),
    );
    // 10000 − 3000 − 4000 = 3000 全打给新账单（新账单 4000 → PARTIAL_PAID）
    expect((await balance(settleAcct['C1'])).balance).toBe('0');
    expect(await billStatus(run.bills[0].id)).toBe('PARTIAL_PAID');
  });

  it('并发：Payment reversal || Bill reverse — 两合法终态，不双写不负额', async () => {
    await onboard('C2');
    await topUp(settleAcct['C2'], 20000, cashierToken).expect(201); // 全预存
    await seedSettlement('C2-11', acct['C2'], '202611', 10); // 4000
    const run = (await post('/billing-runs', { period: '202611' }).expect(201)).body;
    await post(`/billing-runs/${run.id}/post`, {}).expect(201);
    const paidBill = run.bills[0].id;
    expect(await billStatus(paidBill)).toBe('PAID'); // APPLY 4000
    const topupPaymentId = (await entries(settleAcct['C2'], 'TOP_UP'))[0]
      .paymentId!;
    const [r1, r2] = await Promise.all([
      post(`/payments/${topupPaymentId}/reverse`, {}, cashierToken),
      post(`/bills/${paidBill}/reverse`, {}),
    ]);
    // 两合法终态：账单红冲先恢复批次→收款红冲放行(201,201)；
    // 收款红冲先查批次已消耗→409，账单红冲仍成功(409,201)。
    expect(r2.status).toBe(201);
    expect([201, 409]).toContain(r1.status);
    const bal = await balance(settleAcct['C2']);
    expect(Number(bal.balance)).toBeGreaterThanOrEqual(0);
    // 幂等键防双写：批次恢复/回滚各至多一条 REVERSAL 腿
    const revs = await entries(settleAcct['C2'], 'REVERSAL');
    const lotRestore = revs.filter((e) => e.billId === paidBill);
    expect(lotRestore).toHaveLength(1);
  });

  it('并发：Payment reversal || postOneBill — 锁序同向无死锁、余额不为负', async () => {
    await onboard('C3');
    const pay = (await topUp(settleAcct['C3'], 20000, cashierToken).expect(201))
      .body;
    await seedSettlement('C3-12', acct['C3'], '202612', 10); // 4000
    const run = (await post('/billing-runs', { period: '202612' }).expect(201)).body;
    const [r1, r2] = await Promise.all([
      post(`/payments/${pay.payment.id}/reverse`, {}, cashierToken),
      post(`/billing-runs/${run.id}/post`, {}),
    ]);
    expect(r2.status).toBe(201);
    expect([201, 409]).toContain(r1.status);
    const bal = await balance(settleAcct['C3']);
    expect(Number(bal.balance)).toBeGreaterThanOrEqual(0);
    const billId = run.bills[0].id;
    const st = await billStatus(billId);
    if (r1.status === 409) {
      // apply 先消耗批次 → 收款红冲被拒
      expect(st).toBe('PAID');
      expect(bal.balance).toBe('16000');
    } else {
      // 收款红冲先 → 批次回滚，post 时余额 0 → 账单保持 POSTED
      expect(st).toBe('POSTED');
      expect(bal.balance).toBe('0');
    }
  });
});

describe('DayClose breakdown + WaterAccount transfer', () => {
  it('prepaymentBreakdown 四项守恒；SYSTEM APPLY 单列非现金', async () => {
    await onboard('D1');
    await seedBill('D1', acct['D1'], settleAcct['D1'], '202601', 8000);
    // 独立柜员（cashier2）收一笔 200（80 清欠 + 120 预存）—— 抽屉不被其他用例串扰
    await topUp(settleAcct['D1'], 20000, cashier2Token).expect(201);
    const close = (
      await post('/cashier-day-close/close', {}, cashier2Token).expect(201)
    ).body;
    const bd = close.prepaymentBreakdown;
    expect(bd).toBeTruthy();
    expect(BigInt(bd.debtCollection)).toBe(8000n);
    expect(BigInt(bd.topUp)).toBe(12000n);
    expect(
      BigInt(bd.debtCollection) +
        BigInt(bd.topUp) +
        BigInt(bd.refundAmount) +
        BigInt(bd.reversalAmount),
    ).toBe(BigInt(close.totalAmount));
    const detail = (await get(`/cashier-day-close/${close.id}`)).body;
    expect(detail.systemApplyAmount).toBeDefined();
    // APPLY 归属系统不归属柜员 —— 不进 totalAmount
    expect(BigInt(detail.totalAmount)).toBe(20000n);
  });

  it('改挂不迁移预存余额', async () => {
    await onboard('T1');
    const target = await onboard('T2');
    await topUp(settleAcct['T1'], 7000).expect(201);
    await post(`/water-accounts/${acct['T1']}/transfer`, {
      settleAccountId: target.settleAccount.id,
    }).expect(201);
    expect((await balance(settleAcct['T1'])).balance).toBe('7000');
    expect((await balance(target.settleAccount.id)).balance).toBe('0');
  });
});

// ---------------------------------------------------------------------------
// permissions / reads
// ---------------------------------------------------------------------------

describe('permissions + reads', () => {
  it('payment:read 可读余额/流水；无 payment:write 不可充值', async () => {
    await onboard('P1');
    const bal = await balance(settleAcct['P1'], readerToken);
    expect(bal.balance).toBe('0');
    const deny = await topUp(settleAcct['P1'], 1000, readerToken);
    expect(deny.status).toBe(403);
  });

  it('跨租户隔离：B 租户读不到 A 的流水', async () => {
    const res = await get(
      `/prepayments/entries?settleAccountId=${settleAcct['S2']}`,
      tenantBToken,
    );
    expect(res.body.items).toHaveLength(0);
  });
});
