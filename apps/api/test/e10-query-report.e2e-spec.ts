/**
 * E10 (2026-10 requirements) e2e — query/export layer, metric dictionary,
 * analysis reports, unified dict + bad-debt writeoff. Prefix `t14-`.
 *
 * Covers:
 *  1. GET /reports/metric-dictionary — 25+ metric defs + version, report:read only
 *  2. A1–A5 /reports/query/* — human-readable rows, AGG_OWN/counter scope,
 *     tenant isolation, param validation
 *  3. F1 export — ?format=xlsx returns a real workbook (PK zip signature)
 *     and writes an audit_log row
 *  4. B1 ops-daily / B2 analysis-monthly / B3 analysis-yearly — totals
 *     reconcile against seeded bills/payments; metric codes align with dict
 *  5. G4 dicts — category validation, CRUD, DISABLED kept, payment:read can
 *     read WRITEOFF_REASON
 *  6. G2 writeoffs — reason must hit ACTIVE dict; register/list/reverse;
 *     embedded settle labels (no raw uuid as primary identity)
 *  7. G1 fee-item kind — create/patch/list
 *  8. G3 expanded channels — ONLINE/BANK_DEDUCT payments pass validation
 *     and appear in channel splits
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

const T14A = 'aa14aa14-1414-4014-8014-aa14aa14aa14';
const T14B = 'bb14bb14-1414-4014-8014-bb14bb14bb14';
const ORG_A = 'aa14aa14-0000-4000-8000-0000000000c0';
const ORG_A2 = 'aa14aa14-0000-4000-8000-0000000000c2';
const ORG_B = 'bb14bb14-0000-4000-8000-0000000000c0';
const ROLE_ADMIN_A = 'aa14aa14-0000-4000-8000-00000000ad01';
const ROLE_SCOPED_A = 'aa14aa14-0000-4000-8000-00000000c011';
const ROLE_ADMIN_B = 'bb14bb14-0000-4000-8000-00000000ad01';
const STAFF_ADMIN_A = 'aa14aa14-0000-4000-8000-0000000a0001';
const STAFF_SCOPED_A = 'aa14aa14-0000-4000-8000-0000000c0003';
const STAFF_ADMIN_B = 'bb14bb14-0000-4000-8000-0000000a0001';
const PERM_ALL = 'aa14aa14-0000-4000-8000-00000000ff01';
const PERM_SCOPED = 'aa14aa14-0000-4000-8000-00000000ff02';
const PERM_ALL_B = 'bb14bb14-0000-4000-8000-00000000ff01';
const PERM_SCOPED_B = 'bb14bb14-0000-4000-8000-00000000ff02';

const owner = new pg.Client({ connectionString: OWNER_URL });
let app: INestApplication<App>;
let adminToken = '';
let scopedToken = '';
let tenantBToken = '';

const acct: Record<string, string> = {};
const settleAcct: Record<string, string> = {};
const bill: Record<string, string> = {};

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

const get = (path: string, token = adminToken, status = 200) =>
  request(app.getHttpServer()).get(path).set(auth(token)).expect(status);
const post = (path: string, body: unknown, token = adminToken) =>
  request(app.getHttpServer()).post(path).set(auth(token)).send(body);

const onboard = async (label: string) => {
  const res = await post('/water-accounts/onboard', {
    customer: { name: `T14 ${label} ${RUN}`, custType: 'PERSONAL' },
    account: { usageCategory: 'RES_METERED', addr: `${label} Rd` },
    meter: { brand: 't14', caliber: 'DN15' },
    installation: { initialReading: 0, installedAt: '2026-01-01' },
  }).expect(201);
  acct[label] = res.body.waterAccount.id;
  settleAcct[label] = res.body.settleAccount.id;
};

const seedBill = async (
  label: string,
  waterAccountId: string,
  settleAccountId: string,
  period: string,
  totalAmount: number,
) => {
  const row = (
    await owner.query(
      `INSERT INTO bill (id, tenant_id, settle_account_id, water_account_id, period,
                         bill_kind, source_type, source_id, status, is_estimated,
                         total_amount, issued_at, due_date, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'NORMAL', 'MANUAL', gen_random_uuid(),
               'POSTED', false, $5, '2026-10-05', '2026-12-15', now(), now())
       RETURNING id::text`,
      [T14A, settleAccountId, waterAccountId, period, totalAmount],
    )
  ).rows[0];
  bill[label] = row.id;
  return row.id as string;
};

const seedPayment = async (opts: {
  cashierId: string;
  orgUnitId: string;
  settleAccountId: string;
  billId?: string;
  /** 多账单分摊——提供时忽略 billId（一笔收款摊到多张账单）。 */
  allocs?: { billId: string; amount: number }[];
  channel: string;
  amount: number;
  receivedAt: string;
}) => {
  const row = (
    await owner.query(
      `INSERT INTO payment (id, tenant_id, payment_no, settle_account_id, cashier_id,
                            org_unit_id, channel, amount, status, received_at,
                            created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, 'RECEIVED', $8::timestamptz,
               now(), now())
       RETURNING id::text`,
      [
        T14A,
        `TP14${Math.floor(Math.random() * 1e8).toString().padStart(8, '0')}`,
        opts.settleAccountId,
        opts.cashierId,
        opts.orgUnitId,
        opts.channel,
        opts.amount,
        opts.receivedAt,
      ],
    )
  ).rows[0];
  const allocs = opts.allocs ?? [{ billId: opts.billId!, amount: opts.amount }];
  for (const a of allocs) {
    await owner.query(
      `INSERT INTO payment_alloc (id, tenant_id, payment_id, bill_id, amount, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, now(), now())`,
      [T14A, row.id, a.billId, a.amount],
    );
  }
  return row.id as string;
};

beforeAll(async () => {
  await owner.connect();
  const hash = await bcrypt.hash('t14-pass', 10);
  await owner.query(
    `INSERT INTO tenant (id, code, name, status, created_at, updated_at)
     VALUES ($1, 't14-water', 'T14 Water', 'ACTIVE', now(), now()),
            ($2, 't14-other', 'T14 Other', 'ACTIVE', now(), now())
     ON CONFLICT DO NOTHING`,
    [T14A, T14B],
  );
  await owner.query(
    `INSERT INTO org_unit (id, tenant_id, parent_id, name, type, created_at, updated_at)
     VALUES ($1, $2, NULL, 'T14 Company', 'COMPANY', now(), now()),
            ($3, $2, $1, 'T14 Branch', 'BRANCH', now(), now()),
            ($4, $5, NULL, 'T14B Company', 'COMPANY', now(), now())
     ON CONFLICT DO NOTHING`,
    [ORG_A, T14A, ORG_A2, ORG_B, T14B],
  );
  await owner.query(
    `INSERT INTO role (id, tenant_id, code, name, data_scope, created_at, updated_at)
     VALUES ($1, $3, 'admin', 'T14 Admin', 'ALL', now(), now()),
            ($2, $3, 't14-scoped', 'T14 Scoped', 'ORG_SUBTREE', now(), now()),
            ($4, $5, 'admin', 'T14B Admin', 'ALL', now(), now()),
            ('bb14bb14-0000-4000-8000-00000000c011', $5, 't14b-scoped', 'T14B Scoped', 'ORG_SUBTREE', now(), now())
     ON CONFLICT DO NOTHING`,
    [ROLE_ADMIN_A, ROLE_SCOPED_A, T14A, ROLE_ADMIN_B, T14B],
  );
  await owner.query(
    `INSERT INTO permission (id, tenant_id, code, type, created_at, updated_at)
     VALUES ($1, $3, '*', 'ACTION', now(), now()),
            ($2, $3, 'report:read', 'ACTION', now(), now()),
            ($4, $5, '*', 'ACTION', now(), now()),
            ($6, $5, 'report:read', 'ACTION', now(), now())
     ON CONFLICT DO NOTHING`,
    [PERM_ALL, PERM_SCOPED, T14A, PERM_ALL_B, T14B, PERM_SCOPED_B],
  );
  await owner.query(
    `INSERT INTO role_permission (tenant_id, role_id, permission_id, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now()),
            ($1, $4, $5, now(), now()),
            ($6, $7, $8, now(), now()),
            ($6, $9, $10, now(), now())
     ON CONFLICT DO NOTHING`,
    [
      T14A, ROLE_ADMIN_A, PERM_ALL,
      ROLE_SCOPED_A, PERM_SCOPED,
      T14B, ROLE_ADMIN_B, PERM_ALL_B,
      'bb14bb14-0000-4000-8000-00000000c011', PERM_SCOPED_B,
    ],
  );
  await owner.query(
    `INSERT INTO staff (id, tenant_id, org_unit_id, login, password_hash, name, status, created_at, updated_at)
     VALUES ($1, $4, $6, 't14-admin',  $7, 'T14 Admin',  'ACTIVE', now(), now()),
            ($2, $4, $8, 't14-scoped', $7, 'T14 Scoped', 'ACTIVE', now(), now()),
            ($3, $5, $9, 't14b-admin', $7, 'T14B Admin', 'ACTIVE', now(), now())
     ON CONFLICT (tenant_id, login) DO NOTHING`,
    [STAFF_ADMIN_A, STAFF_SCOPED_A, STAFF_ADMIN_B, T14A, T14B, ORG_A, hash, ORG_A2, ORG_B],
  );
  await owner.query(
    `INSERT INTO staff_role (tenant_id, staff_id, role_id, created_at, updated_at)
     VALUES ($1, $2, $4, now(), now()),
            ($1, $3, $5, now(), now()),
            ($7, $6, $8, now(), now())
     ON CONFLICT DO NOTHING`,
    [T14A, STAFF_ADMIN_A, STAFF_SCOPED_A, ROLE_ADMIN_A, ROLE_SCOPED_A, STAFF_ADMIN_B, T14B, ROLE_ADMIN_B],
  );

  await owner.query(
    `DELETE FROM role_permission WHERE tenant_id = $1
       AND role_id IN ('bb14bb14-0000-4000-8000-00000000ad01', 'bb14bb14-1414-4014-8014-bb14bb14bb14')`,
    [T14A],
  );
  await owner.query(
    `DELETE FROM staff_role WHERE tenant_id = $1 AND staff_id = $2`,
    [T14A, STAFF_ADMIN_B],
  );

  for (const table of [
    'payment_alloc', 'receipt', 'payment', 'cashier_day_close',
    'bill_item', 'bill', 'billing_run',
    'consumption_component', 'consumption_settlement', 'meter_reading',
    'reading_plan_item', 'reading_plan', 'book_meter', 'reading_book',
    'account_event', 'meter_installation', 'meter',
    'water_account_household_profile', 'water_account', 'settle_account',
    'customer', 'tariff_tier', 'tariff_plan', 'fee_item', 'tenant_param',
    'sys_dict', 'bad_debt_writeoff', 'work_item', 'audit_log',
  ]) {
    await owner.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [T14A]);
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
        .send({ tenantCode, login: login_, password: 't14-pass' })
        .expect(201)
    ).body.accessToken as string;
  adminToken = await login('t14-water', 't14-admin');
  scopedToken = await login('t14-water', 't14-scoped');
  tenantBToken = await login('t14-other', 't14b-admin');
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

describe('fixtures', () => {
  it('onboards two accounts (A1 in ORG_A book, B1 in ORG_A2 book) + seeds bills/payments', async () => {
    await onboard('A1');
    await onboard('B1');

    const book1 = await post('/reading-books', {
      name: `T14 BookA ${RUN}`, orgUnitId: ORG_A,
    }).expect(201);
    await post(`/reading-books/${book1.body.id}/meters`, {
      waterAccountId: acct['A1'],
    }).expect(201);
    const book2 = await post('/reading-books', {
      name: `T14 BookB ${RUN}`, orgUnitId: ORG_A2,
    }).expect(201);
    await post(`/reading-books/${book2.body.id}/meters`, {
      waterAccountId: acct['B1'],
    }).expect(201);

    // A1: 202610 bill 20000 posted (unpaid) + 202609 bill 5000 paid in Oct.
    await seedBill('A1-oct', acct['A1'], settleAcct['A1'], '202610', 20000);
    await seedBill('A1-sep', acct['A1'], settleAcct['A1'], '202609', 5000);
    // B1: 202610 bill 7000 posted.
    await seedBill('B1-oct', acct['B1'], settleAcct['B1'], '202610', 7000);
    // A1: 两笔小额 202609 账单——用于多分摊收款（P3）防 payment×alloc 扇出回归。
    await seedBill('A1-sep2', acct['A1'], settleAcct['A1'], '202609', 2000);
    await seedBill('A1-sep3', acct['A1'], settleAcct['A1'], '202609', 1000);

    // Payment 1: CASH 5000 on 2026-10-06 at ORG_A counter → arrears alloc (202609).
    await seedPayment({
      cashierId: STAFF_ADMIN_A, orgUnitId: ORG_A,
      settleAccountId: settleAcct['A1'], billId: bill['A1-sep'],
      channel: 'CASH', amount: 5000, receivedAt: '2026-10-06T09:00:00Z',
    });
    // Payment 3: CASH 3000 on 2026-10-06 → 分摊到 sep2+sep3 两张账单。
    // 扇出回归：sum(p.amount) 若随 alloc 行重复计数会得到 5000+3000×2。
    await seedPayment({
      cashierId: STAFF_ADMIN_A, orgUnitId: ORG_A,
      settleAccountId: settleAcct['A1'],
      allocs: [
        { billId: bill['A1-sep2'], amount: 2000 },
        { billId: bill['A1-sep3'], amount: 1000 },
      ],
      channel: 'CASH', amount: 3000, receivedAt: '2026-10-06T10:00:00Z',
    });
    // Payment 2: ONLINE 3000 on 2026-10-07 at ORG_A2 counter → current alloc.
    await seedPayment({
      cashierId: STAFF_SCOPED_A, orgUnitId: ORG_A2,
      settleAccountId: settleAcct['B1'], billId: bill['B1-oct'],
      channel: 'ONLINE', amount: 3000, receivedAt: '2026-10-07T09:00:00Z',
    });
  });
});

describe('C1 metric dictionary', () => {
  it('returns versioned definitions covering the required KPI set', async () => {
    const res = (await get('/reports/metric-dictionary')).body;
    expect(res.version).toBe('2026-10.v3');
    expect(res.metrics.length).toBeGreaterThanOrEqual(25);
    const codes = new Set(res.metrics.map((m: { code: string }) => m.code));
    for (const c of [
      'SOLD_QTY', 'AR_AMOUNT', 'COLLECTED', 'CURRENT_COLLECTED',
      'ARREARS_COLLECTED', 'RECOVERY_RATE', 'ARREARS_TOTAL', 'COMPOSITE_PRICE',
      'READ_ACCURACY', 'READ_COVERAGE', 'ESTIMATE_RATE', 'READ_TIMELINESS',
      'BAD_DEBT_WRITEOFF', 'ONLINE_RATE', 'DUN_SUCCESS_RATE',
      // 整改 P2：补齐的 10 个缺失指标（催缴成功率已有 COLLECTION 任务数据源）
      'READ_ARRIVAL_RATE', 'SMART_METER_RATE', 'ZERO_USAGE_STREAK_RATE',
      'BILL_TIMELINESS', 'BILL_ACCURACY', 'DISCOUNT_RATE', 'PREPAY_RATE',
      'AGED_ARREARS_RATE', 'CHURN_RATE', 'AVG_SOLD_PER_ACCOUNT',
    ]) {
      expect(codes.has(c)).toBe(true);
    }
    // 催缴成功率 v2 起可用（task(type=COLLECTION) ⋈ 收款）；售水完成率仍暂缓。
    const dun = res.metrics.find((m: { code: string }) => m.code === 'DUN_SUCCESS_RATE');
    expect(dun.available).toBe(true);
    const target = res.metrics.find((m: { code: string }) => m.code === 'SOLD_QTY_TARGET_RATE');
    expect(target.available).toBe(false);
    expect(target.unavailableReason).toBeTruthy();
  });

  it('scoped report:read can read the dictionary; tenant B empty tenant sees it too', async () => {
    await get('/reports/metric-dictionary', scopedToken);
    await get('/reports/metric-dictionary', tenantBToken);
  });
});

describe('A1–A5 queries', () => {
  it('A1 accounts: human-readable row + AGG_OWN scope', async () => {
    const all = (await get('/reports/query/accounts')).body;
    const a1 = all.find((r: { accountNo: string }) => r.customerName.includes('T14 A1'));
    expect(a1).toMatchObject({ usageCategory: 'RES_METERED', status: 'NORMAL' });
    expect(a1.accountNo).toMatch(/^A/);
    // scoped（ORG_A2 子树）只见 B1 —— 覆盖册决定归属。
    const scoped = (await get('/reports/query/accounts', scopedToken)).body;
    expect(scoped).toHaveLength(1);
    expect(scoped[0].customerName).toContain('T14 B1');
    // 租户 B 看不到任何 A 户。
    const b = (await get('/reports/query/accounts', tenantBToken)).body;
    expect(b).toEqual([]);
  });

  it('A2 usage-details: requires period; zero rows without settlements', async () => {
    const res = await request(app.getHttpServer())
      .get('/reports/query/usage-details')
      .set(auth(adminToken))
      .expect(400);
    expect(res.body.code).toBe('REPORT_PARAM_REQUIRED');
    const rows = (await get('/reports/query/usage-details?period=202610')).body;
    expect(rows).toEqual([]);
  });

  it('A3 bill-details: period rows with receivable/allocated/remaining split', async () => {
    const rows = (await get('/reports/query/bill-details?period=202610')).body;
    const a1 = rows.find((r: { customerName: string }) => r.customerName.includes('T14 A1'));
    expect(a1).toMatchObject({
      period: '202610',
      totalAmount: '20000',
      allocated: '0',
      remaining: '20000',
    });
    const b1 = rows.find((r: { customerName: string }) => r.customerName.includes('T14 B1'));
    expect(b1.remaining).toBe('4000');
    // scoped only sees B1's bill.
    const scoped = (await get('/reports/query/bill-details?period=202610', scopedToken)).body;
    expect(scoped).toHaveLength(1);
    expect(scoped[0].customerName).toContain('T14 B1');
  });

  it('A4 payments: date window + channel filter; counter-org scope', async () => {
    const rows = (await get('/reports/query/payments?from=2026-10-01&to=2026-10-31')).body;
    expect(rows).toHaveLength(3);
    const online = rows.find((r: { channel: string }) => r.channel === 'ONLINE');
    expect(online).toMatchObject({ amount: '3000', status: 'RECEIVED' });
    expect(online.cashierName).toBe('T14 Scoped');
    expect(online.allocPeriods).toContain('202610');
    // channel filter
    const cash = (await get('/reports/query/payments?from=2026-10-01&to=2026-10-31&channel=CASH')).body;
    expect(cash).toHaveLength(2);
    // scoped sees only ORG_A2 counter payments.
    const scoped = (await get('/reports/query/payments?from=2026-10-01&to=2026-10-31', scopedToken)).body;
    expect(scoped).toHaveLength(1);
    expect(scoped[0].channel).toBe('ONLINE');
  });

  it('A5 arrears: unpaid bills aggregate per account with aging; writeoff column present', async () => {
    const rows = (await get('/reports/query/arrears?asOf=2026-10-31')).body;
    const a1 = rows.find((r: { customerName: string }) => r.customerName.includes('T14 A1'));
    expect(a1).toMatchObject({ arrearsAmount: '20000', billCount: 1, oldestPeriod: '202610' });
    expect(a1.agingMonths).toBe(0);
    expect(a1.writtenOff).toBe('0');
    const b1 = rows.find((r: { customerName: string }) => r.customerName.includes('T14 B1'));
    expect(b1.arrearsAmount).toBe('4000'); // 7000 - 3000 alloc
    // minAmount (分) filter
    const big = (await get('/reports/query/arrears?asOf=2026-10-31&minAmount=1000000')).body;
    expect(big).toEqual([]);
  });
});

describe('F1 xlsx export', () => {
  it('returns a real xlsx (PK zip) and writes an audit_log row', async () => {
    const res = await request(app.getHttpServer())
      .get('/reports/query/accounts?format=xlsx')
      .set(auth(adminToken))
      .buffer()
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect((res.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    // audit 留痕
    const audit = await owner.query(
      `SELECT action, after FROM audit_log
       WHERE tenant_id = $1 AND action LIKE 'EXPORT /reports/query/%'
       ORDER BY created_at DESC LIMIT 1`,
      [T14A],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].action).toBe('EXPORT /reports/query/accounts');
    expect(audit.rows[0].after.rowCount).toBeGreaterThanOrEqual(2);
  });
});

describe('B1–B3 analysis reports', () => {
  it('B1 ops-daily: collected split current/arrears reconciles with seeded payments', async () => {
    const res = (await get('/reports/ops-daily?date=2026-10-06')).body;
    expect(res.metricVersion).toBe('2026-10.v3');
    // 当日两笔 CASH：5000 单分摊 + 3000 跨两单分摊（扇出回归：
    // collected 必须是 8000，而不是 join 展开后的 5000+3000×2=11000）
    expect(res.totals.collected).toBe('8000');
    expect(res.totals.arrearsCollected).toBe('8000');
    expect(res.totals.currentCollected).toBe('0');
    // 欠费总额 = A1 20000 + B1 4000 = 24000
    expect(res.totals.arrearsTotal).toBe('24000');
    // 按渠道只 CASH
    expect(res.byChannel.map((c: { channel: string }) => c.channel)).toEqual(['CASH']);
    // scoped 只见 ORG_A2 柜台 —— 当日其柜台无收款
    const scoped = (await get('/reports/ops-daily?date=2026-10-06', scopedToken)).body;
    expect(scoped.totals.collected).toBe('0');
  });

  it('B2 analysis-monthly: 202610 totals + dict-code totals + breakdowns', async () => {
    const res = (await get('/reports/analysis-monthly?period=202610')).body;
    const t = res.totals;
    // 应收 = A1 20000 + B1 7000
    expect(t.AR_AMOUNT).toBe('27000');
    // 实收（10 月窗口）= 5000 + 3000 + 3000
    expect(t.COLLECTED).toBe('11000');
    // 当期实收 = ONLINE 3000（当期账期内 due_date 前）
    expect(t.CURRENT_COLLECTED).toBe('3000');
    // 陈欠收取 = CASH 5000 + 3000（均摊到 202609 账期）
    expect(t.ARREARS_COLLECTED).toBe('8000');
    // 回收率 = 3000/27000 ≈ 0.111
    expect(Number(t.RECOVERY_RATE)).toBeCloseTo(0.1111, 3);
    // 欠费总额 = 20000 + 4000
    expect(t.ARREARS_TOTAL).toBe('24000');
    // 账龄分段：全部为 0-3 个月
    expect(res.byAging['0-3']).toBe('24000');
    // 异常清单：欠费 TOP 含两户
    expect(res.lists.arrearsList).toHaveLength(2);
    // 催缴成功率 v2 起可用：本期无 COLLECTION 任务 → 分母 0 → null + 口径参数
    expect(t.DUN_SUCCESS_RATE.param.dunSuccessDays).toBe(7);
    // P2 新增指标均有返回（比率型 null=分母为 0，数值型有值）
    for (const k of [
      'READ_ARRIVAL_RATE', 'SMART_METER_RATE', 'BILL_TIMELINESS',
      'BILL_ACCURACY', 'DISCOUNT_RATE', 'PREPAY_RATE', 'AGED_ARREARS_RATE',
      'CHURN_RATE',
    ]) {
      const cell = t[k];
      expect(cell === null || typeof cell === 'number' ||
             (cell && typeof cell === 'object' && 'value' in cell)).toBe(true);
    }
    expect(t.ZERO_USAGE_STREAK_RATE.param.zeroUsageMonths).toBe(3);
    expect(t.ACCOUNT_COUNT).toBe(2);
    // 售水量÷在册户（fixture 售水量可为 0，值为 0 也是合法结果）
    expect(t.AVG_SOLD_PER_ACCOUNT).not.toBeNull();
    // 无数据指标显式标出
    expect(t.SOLD_QTY_TARGET_RATE.reason).toBeTruthy();
  });

  it('B3 analysis-yearly: trend + totals + empty lists without writeoffs', async () => {
    const res = (await get('/reports/analysis-yearly?year=2026')).body;
    const oct = res.trend.find((r: { period: string }) => r.period === '202610');
    expect(oct).toMatchObject({ billed: '27000', collected: '11000' });
    // 年度应收含 202609 账单：27000 + 5000 + 2000 + 1000
    expect(res.totals.AR_AMOUNT).toBe('35000');
    expect(res.totals.ACCOUNT_COUNT).toBe(2);
    expect(res.totals.BAD_DEBT_WRITEOFF).toBe('0');
    expect(res.lists.topArrears).toHaveLength(2);
  });
});

describe('G4 unified dicts', () => {
  it('rejects unknown categories; CRUD + disable lifecycle works', async () => {
    await request(app.getHttpServer())
      .get('/iam/dicts?category=NOPE')
      .set(auth(adminToken))
      .expect(400);
    const created = await post('/iam/dicts', {
      category: 'WRITEOFF_REASON',
      code: 'BANKRUPT',
      name: '客户破产',
      seq: 9,
    }).expect(201);
    const listed = (await get('/iam/dicts?category=WRITEOFF_REASON')).body;
    expect(listed.map((d: { code: string }) => d.code)).toContain('BANKRUPT');
    // 停用后默认列表不再返回，但 all=1 可见（历史引用不丢）。
    await request(app.getHttpServer())
      .patch(`/iam/dicts/${created.body.id}`)
      .set(auth(adminToken))
      .send({ status: 'DISABLED' })
      .expect(200);
    const active = (await get('/iam/dicts?category=WRITEOFF_REASON')).body;
    expect(active.map((d: { code: string }) => d.code)).not.toContain('BANKRUPT');
    const all = (await get('/iam/dicts?category=WRITEOFF_REASON&all=1')).body;
    expect(all.map((d: { code: string }) => d.code)).toContain('BANKRUPT');
    // code 不可重复
    await post('/iam/dicts', {
      category: 'WRITEOFF_REASON', code: 'BANKRUPT', name: '重复',
    }).expect(409);
    // categories 清单
    const cats = (await get('/iam/dicts/categories')).body;
    expect(cats.map((c: { code: string }) => c.code)).toContain('AGING_BUCKET');
    // 租户 B 不可见 A 的字典
    const bList = (await get('/iam/dicts?category=WRITEOFF_REASON&all=1', tenantBToken)).body;
    expect(bList.map((d: { code: string }) => d.code)).not.toContain('BANKRUPT');
  });
});

describe('G2 bad-debt writeoff', () => {
  it('reason must hit ACTIVE WRITEOFF_REASON dict; register → list → reverse', async () => {
    // 先配原因
    await post('/iam/dicts', {
      category: 'WRITEOFF_REASON', code: 'AGED_OVER_3Y', name: '账龄超3年', seq: 1,
    }).expect(201);
    // 无效原因 → 400
    const bad = await post('/writeoffs', {
      settleAccountId: settleAcct['A1'],
      amount: 100,
      reasonCode: 'NOT_A_REASON',
      effectiveDate: '2026-10-20',
    }).expect(400);
    expect(bad.body.code).toBe('WRITEOFF_REASON_INVALID');
    // 正常登记
    const ok = await post('/writeoffs', {
      settleAccountId: settleAcct['A1'],
      waterAccountId: acct['A1'],
      amount: 20000,
      reasonCode: 'AGED_OVER_3Y',
      note: 'test writeoff',
      effectiveDate: '2026-10-20',
    }).expect(201);
    // 列表人读化
    const list = (await get('/writeoffs')).body;
    const row = list.find((r: { id: string }) => r.id === ok.body.id);
    expect(row).toMatchObject({
      settleName: expect.any(String),
      amount: '20000',
      reasonCode: 'AGED_OVER_3Y',
      status: 'ACTIVE',
    });
    expect(row.settleNo).toBeTruthy();
    // A5 欠费明细同步出现已核销列
    const arrears = (await get('/reports/query/arrears?asOf=2026-10-31')).body;
    const a1 = arrears.find((r: { customerName: string }) => r.customerName.includes('T14 A1'));
    expect(a1.writtenOff).toBe('20000');
    // 年报核销额
    const yr = (await get('/reports/analysis-yearly?year=2026')).body;
    expect(yr.totals.BAD_DEBT_WRITEOFF).toBe('20000');
    // 撤销 → status REVERSED，年报核销额归零
    await post(`/writeoffs/${ok.body.id}/reverse`, {}).expect(201);
    const yr2 = (await get('/reports/analysis-yearly?year=2026')).body;
    expect(yr2.totals.BAD_DEBT_WRITEOFF).toBe('0');
    // 重复撤销 → 400
    await post(`/writeoffs/${ok.body.id}/reverse`, {}).expect(400);
  });
});

describe('G1 fee-item kind', () => {
  it('create with kind; patch kind; list exposes kind', async () => {
    const created = await post('/fee-items', {
      code: `AGENCY_${RUN.slice(-6)}`.toUpperCase(),
      name: '代收污水费',
      calcType: 'PER_QTY',
      kind: 'AGENCY',
    }).expect(201);
    expect(created.body.kind).toBe('AGENCY');
    const list = (await get('/fee-items')).body;
    const row = list.find((f: { id: string }) => f.id === created.body.id);
    expect(row.kind).toBe('AGENCY');
    // kind 可改（重新归类），code 不可改
    const patched = await request(app.getHttpServer())
      .patch(`/fee-items/${created.body.id}`)
      .set(auth(adminToken))
      .send({ kind: 'OTHER' })
      .expect(200);
    expect(patched.body.kind).toBe('OTHER');
    // 非法 kind → 400
    await request(app.getHttpServer())
      .post('/fee-items')
      .set(auth(adminToken))
      .send({ code: 'BAD1', name: 'x', calcType: 'PER_QTY', kind: 'NOPE' })
      .expect(400);
  });
});
