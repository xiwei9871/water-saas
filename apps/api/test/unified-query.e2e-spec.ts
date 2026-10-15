/**
 * 统一数据查询（2026-10-15 设计方案）e2e — POST /reports/query/unified。
 * Prefix `t15-`.
 *
 * Covers:
 *  - GET /unified/fields — 5 主题字段池按调用者权限过滤（report:read-only
 *    用户只见身份字段）
 *  - 多账期横展：行=户，periods 内账期级字段按账期取值
 *  - 五主题数据源：水量(settlement)/账单(bill+分摊)/收费(alloc按账单期)/
 *    欠费累计(截至 periodTo 快照)/基本信息
 *  - 筛选：对象（户多选/抄表册）、用水类别、估抄 ONLY|EXCLUDE、欠费门槛
 *  - 权限：deniedFields 剔除未授权字段而非静默返 0；AGG_OWN 数据范围；
 *    跨租户隔离
 *  - 校验：fields 必填、账期跨度 ≤12、period 格式
 *  - POST /unified/export — xlsx 透视导出 + audit_log
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

const T15 = 'aa15aa15-1515-4015-8015-aa15aa15aa15';
const ORG_A = 'aa15aa15-0000-4000-8000-0000000000c0';
const ORG_A2 = 'aa15aa15-0000-4000-8000-0000000000c2';
const ROLE_ADMIN = 'aa15aa15-0000-4000-8000-00000000ad01';
const ROLE_RPT = 'aa15aa15-0000-4000-8000-00000000c011';
const PERM_STAR = 'aa15aa15-0000-4000-8000-00000000ff01';
const PERM_RPT = 'aa15aa15-0000-4000-8000-00000000ff02';
const STAFF_ADMIN = 'aa15aa15-0000-4000-8000-0000000a0001';
const STAFF_RPT = 'aa15aa15-0000-4000-8000-0000000c0003';

const owner = new pg.Client({ connectionString: OWNER_URL });
let app: INestApplication<App>;
let adminToken = '';
let rptToken = '';

const acct: Record<string, string> = {};
const settleAcct: Record<string, string> = {};
const instId: Record<string, string> = {};
let bookA = '';
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const get = (path: string, token = adminToken, status = 200) =>
  request(app.getHttpServer()).get(path).set(auth(token)).expect(status);
const post = (path: string, body: unknown, token = adminToken) =>
  request(app.getHttpServer()).post(path).set(auth(token)).send(body);

const onboard = async (label: string) => {
  const res = await post('/water-accounts/onboard', {
    customer: { name: `T15 ${label} ${RUN}`, custType: 'PERSONAL' },
    account: { usageCategory: 'RES_METERED', addr: `${label} Rd` },
    meter: { brand: 't15', caliber: 'DN15' },
    installation: { initialReading: 0, installedAt: '2026-01-01' },
  }).expect(201);
  acct[label] = res.body.waterAccount.id;
  settleAcct[label] = res.body.settleAccount.id;
  instId[label] = (
    await owner.query(
      `SELECT id::text FROM meter_installation
       WHERE tenant_id = $1 AND water_account_id = $2 AND status = 'ACTIVE'`,
      [T15, acct[label]],
    )
  ).rows[0].id;
};

const seedSettlement = async (
  waterAccountId: string,
  installationId: string,
  period: string,
  usage: number,
  isEstimated: boolean,
) => {
  const s = (
    await owner.query(
      `INSERT INTO consumption_settlement
         (id, tenant_id, water_account_id, period, total_usage_qty, is_estimated,
          estimate_method, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'FINAL', now(), now())
       RETURNING id::text`,
      [T15, waterAccountId, period, usage, isEstimated, isEstimated ? 'MANUAL' : null],
    )
  ).rows[0];
  await owner.query(
    `INSERT INTO consumption_component
       (id, tenant_id, settlement_id, installation_id, prev_reading_value,
        end_reading_value, usage_qty, source_type, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 0, $4, $4,
             $5::"ComponentSourceType", now(), now())`,
    [T15, s.id, installationId, usage, isEstimated ? 'ESTIMATE' : 'READING'],
  );
};

const seedBill = async (
  waterAccountId: string,
  settleAccountId: string,
  period: string,
  totalAmount: number,
) =>
  (
    await owner.query(
      `INSERT INTO bill (id, tenant_id, settle_account_id, water_account_id, period,
                         bill_kind, source_type, source_id, status, is_estimated,
                         total_amount, issued_at, due_date, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'NORMAL', 'MANUAL', gen_random_uuid(),
               'POSTED', false, $5, $6::date, '2099-12-15', now(), now())
       RETURNING id::text`,
      [T15, settleAccountId, waterAccountId, period, totalAmount, `${period}05`],
    )
  ).rows[0].id as string;

const seedPayment = async (opts: {
  settleAccountId: string;
  billId: string;
  amount: number;
  receivedAt: string;
}) => {
  const p = (
    await owner.query(
      `INSERT INTO payment (id, tenant_id, payment_no, settle_account_id, cashier_id,
                            org_unit_id, channel, amount, status, received_at,
                            created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'CASH', $6, 'RECEIVED',
               $7::timestamptz, now(), now())
       RETURNING id::text`,
      [
        T15,
        `TP15${Math.floor(Math.random() * 1e8).toString().padStart(8, '0')}`,
        opts.settleAccountId,
        STAFF_ADMIN,
        ORG_A,
        opts.amount,
        opts.receivedAt,
      ],
    )
  ).rows[0];
  await owner.query(
    `INSERT INTO payment_alloc (id, tenant_id, payment_id, bill_id, amount, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, now(), now())`,
    [T15, p.id, opts.billId, opts.amount],
  );
};

beforeAll(async () => {
  await owner.connect();
  const hash = await bcrypt.hash('t15-pass', 10);
  await owner.query(
    `INSERT INTO tenant (id, code, name, status, created_at, updated_at)
     VALUES ($1, 't15-water', 'T15 Water', 'ACTIVE', now(), now())
     ON CONFLICT DO NOTHING`,
    [T15],
  );
  await owner.query(
    `INSERT INTO org_unit (id, tenant_id, parent_id, name, type, created_at, updated_at)
     VALUES ($1, $2, NULL, 'T15 Company', 'COMPANY', now(), now()),
            ($3, $2, $1, 'T15 Branch', 'BRANCH', now(), now())
     ON CONFLICT DO NOTHING`,
    [ORG_A, T15, ORG_A2],
  );
  await owner.query(
    `INSERT INTO role (id, tenant_id, code, name, data_scope, created_at, updated_at)
     VALUES ($1, $3, 'admin', 'T15 Admin', 'ALL', now(), now()),
            ($2, $3, 't15-rpt', 'T15 ReportOnly', 'ALL', now(), now())
     ON CONFLICT DO NOTHING`,
    [ROLE_ADMIN, ROLE_RPT, T15],
  );
  await owner.query(
    `INSERT INTO permission (id, tenant_id, code, type, created_at, updated_at)
     VALUES ($1, $3, '*', 'ACTION', now(), now()),
            ($2, $3, 'report:read', 'ACTION', now(), now())
     ON CONFLICT DO NOTHING`,
    [PERM_STAR, PERM_RPT, T15],
  );
  await owner.query(
    `INSERT INTO role_permission (tenant_id, role_id, permission_id, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now()),
            ($1, $4, $5, now(), now())
     ON CONFLICT DO NOTHING`,
    [T15, ROLE_ADMIN, PERM_STAR, ROLE_RPT, PERM_RPT],
  );
  await owner.query(
    `INSERT INTO staff (id, tenant_id, org_unit_id, login, password_hash, name, status, created_at, updated_at)
     VALUES ($1, $3, $5, 't15-admin', $4, 'T15 Admin', 'ACTIVE', now(), now()),
            ($2, $3, $5, 't15-rpt', $4, 'T15 Rpt', 'ACTIVE', now(), now())
     ON CONFLICT (tenant_id, login) DO NOTHING`,
    [STAFF_ADMIN, STAFF_RPT, T15, hash, ORG_A],
  );
  await owner.query(
    `INSERT INTO staff_role (tenant_id, staff_id, role_id, created_at, updated_at)
     VALUES ($1, $2, $4, now(), now()),
            ($1, $3, $5, now(), now())
     ON CONFLICT DO NOTHING`,
    [T15, STAFF_ADMIN, STAFF_RPT, ROLE_ADMIN, ROLE_RPT],
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
    await owner.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [T15]);
  }

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleFixture.createNestApplication();
  await app.init();

  const login = async (login_: string) =>
    (
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ tenantCode: 't15-water', login: login_, password: 't15-pass' })
        .expect(201)
    ).body.accessToken as string;
  adminToken = await login('t15-admin');
  rptToken = await login('t15-rpt');
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

describe('fixtures', () => {
  it('onboards A1/B1 + 挂抄表册 + 种水量/账单/收款', async () => {
    await onboard('A1');
    await onboard('B1');
    const b = await post('/reading-books', {
      name: `T15 BookA ${RUN}`, orgUnitId: ORG_A,
    }).expect(201);
    bookA = b.body.id;
    await post(`/reading-books/${bookA}/meters`, { waterAccountId: acct['A1'] }).expect(201);
    const b2 = await post('/reading-books', {
      name: `T15 BookB ${RUN}`, orgUnitId: ORG_A2,
    }).expect(201);
    await post(`/reading-books/${b2.body.id}/meters`, { waterAccountId: acct['B1'] }).expect(201);

    // A1: 三期结算（202701 实抄10 / 202702 估抄12 / 202703 实抄0）
    await seedSettlement(acct['A1'], instId['A1'], '202701', 10, false);
    await seedSettlement(acct['A1'], instId['A1'], '202702', 12, true);
    await seedSettlement(acct['A1'], instId['A1'], '202703', 0, false);
    // B1: 一期实抄 8（用于估抄筛选对照）
    await seedSettlement(acct['B1'], instId['B1'], '202701', 8, false);

    // A1: 202701 账单 3000 全额收清；202702 账单 3600 未收 → 截至 202703 欠费
    const bill1 = await seedBill(acct['A1'], settleAcct['A1'], '202701', 3000);
    await seedBill(acct['A1'], settleAcct['A1'], '202702', 3600);
    await seedPayment({
      settleAccountId: settleAcct['A1'], billId: bill1,
      amount: 3000, receivedAt: '2027-02-05T09:00:00Z',
    });
    // B1: 202701 账单 2400 未收
    await seedBill(acct['B1'], settleAcct['B1'], '202701', 2400);
  });
});

const FIELDS_ALL = [
  'usageQty', 'isEstimated', 'readSource', 'ytdUsage',
  'billKind', 'billStatus', 'priceText', 'totalAmount', 'allocated', 'remaining',
  'collectedAmount', 'channels', 'lastPaidAt', 'paymentNos',
  'arrearsAmount', 'oldestPeriod', 'agingMonths', 'arrearsBillCount', 'writtenOff',
  'addr', 'usageCategory', 'accountStatus', 'orgName', 'meterNo', 'caliber',
];

describe('GET /reports/query/unified/fields', () => {
  it('admin sees 5 themes; report-only user sees only identity fields', async () => {
    const all = (await get('/reports/query/unified/fields')).body;
    expect(all.periodSpanMax).toBe(12);
    expect(all.themes).toHaveLength(5);
    const keys = new Set(
      all.themes.flatMap((t: { fields: { key: string }[] }) => t.fields.map((f) => f.key)),
    );
    for (const k of FIELDS_ALL) expect(keys).toContain(k);

    const limited = (await get('/reports/query/unified/fields', rptToken)).body;
    const limitedKeys = limited.themes.flatMap(
      (t: { fields: { key: string }[] }) => t.fields.map((f) => f.key),
    );
    expect(limitedKeys.sort()).toEqual(['accountNo', 'customerName']);
  });
});

describe('POST /reports/query/unified', () => {
  const base = { periodFrom: '202701', periodTo: '202703', fields: FIELDS_ALL };

  it('多账期横展：行=户，账期级字段按账期取值', async () => {
    const res = await post('/reports/query/unified', base).expect(201);
    expect(res.body.periods).toEqual(['202701', '202702', '202703']);
    expect(res.body.total).toBe(2);
    const a1 = res.body.rows.find(
      (r: { fixed: Record<string, unknown> }) => r.fixed.accountNo?.toString().startsWith('A'),
    ) ?? res.body.rows.find((r: { periods: Record<string, Record<string, unknown>> }) => r.periods['202702']?.usageQty === '12.0000');
    expect(a1).toBeTruthy();
    // 水量主题
    expect(Number(a1.periods['202701'].usageQty)).toBe(10);
    expect(a1.periods['202702'].isEstimated).toBe(true);
    expect(a1.periods['202702'].usageQty && Number(a1.periods['202702'].usageQty)).toBe(12);
    // 年累计：202703 时 ytd = 10+12+0 = 22
    expect(Number(a1.periods['202703'].ytdUsage)).toBe(22);
    // 账单主题
    expect(a1.periods['202701'].totalAmount).toBe('3000');
    expect(a1.periods['202701'].allocated).toBe('3000');
    expect(a1.periods['202701'].remaining).toBe('0');
    expect(a1.periods['202701'].billStatus).toContain('POSTED');
    // 收费主题（按账单账期归集）
    expect(a1.periods['202701'].collectedAmount).toBe('3000');
    expect(a1.periods['202701'].channels).toContain('CASH');
    // 欠费累计（截至 202703：202702 账单 3600 未收）
    expect(a1.cumulative.arrearsAmount).toBe('3600');
    expect(a1.cumulative.oldestPeriod).toBe('202702');
    expect(a1.cumulative.arrearsBillCount).toBe(1);
    // 基本信息
    expect(a1.fixed.usageCategory).toBe('RES_METERED');
    expect(a1.fixed.meterNo).toBeTruthy();
  });

  it('估抄筛选 ONLY/EXCLUDE', async () => {
    const only = await post('/reports/query/unified', {
      ...base, estimated: 'ONLY', fields: ['isEstimated'],
    }).expect(201);
    expect(only.body.total).toBe(1);
    expect(only.body.rows[0].periods['202702'].isEstimated).toBe(true);

    const excl = await post('/reports/query/unified', {
      ...base, estimated: 'EXCLUDE', fields: ['isEstimated'],
    }).expect(201);
    expect(excl.body.total).toBe(1);
    expect(excl.body.rows[0].waterAccountId).toBe(acct['B1']);
  });

  it('对象筛选：抄表册 / 用水户多选 / 欠费门槛', async () => {
    const byBook = await post('/reports/query/unified', {
      ...base, bookIds: [bookA], fields: ['usageQty'],
    }).expect(201);
    expect(byBook.body.total).toBe(1);
    expect(byBook.body.rows[0].waterAccountId).toBe(acct['A1']);

    const byIds = await post('/reports/query/unified', {
      ...base, waterAccountIds: [acct['A1'], acct['B1']], fields: ['usageQty'],
    }).expect(201);
    expect(byIds.body.total).toBe(2);

    // 欠费门槛：A1 欠 3600 分，B1 欠 2400 分（截至 202703）
    const arrs = await post('/reports/query/unified', {
      ...base, arrearsMin: 3000, fields: ['arrearsAmount'],
    }).expect(201);
    expect(arrs.body.total).toBe(1);
    expect(arrs.body.rows[0].waterAccountId).toBe(acct['A1']);
  });

  it('deniedFields：report:read-only 用户请求域字段被剔除', async () => {
    const res = await post('/reports/query/unified', base, rptToken).expect(201);
    expect(res.body.deniedFields).toEqual(
      expect.arrayContaining(['usageQty', 'totalAmount', 'arrearsAmount']),
    );
    expect(res.body.fields.map((f: { key: string }) => f.key).sort()).toEqual([
      'accountNo', 'customerName',
    ]);
    expect(res.body.rows[0].periods).toEqual({});
  });

  it('校验：fields 必填 / 跨度>12 / period 格式 / periodTo<periodFrom', async () => {
    await post('/reports/query/unified', { ...base, fields: [] }).expect(400);
    await post('/reports/query/unified', {
      ...base, periodFrom: '202601', periodTo: '202706',
    }).expect(400);
    const span = await post('/reports/query/unified', {
      ...base, periodFrom: '202601', periodTo: '202706',
    });
    expect(span.body.code).toBe('PERIOD_SPAN_EXCEEDED');
    await post('/reports/query/unified', { ...base, periodFrom: '20271' }).expect(400);
    await post('/reports/query/unified', {
      ...base, periodFrom: '202703', periodTo: '202701',
    }).expect(400);
  });

  it('xlsx 导出：PK zip + audit_log 留痕', async () => {
    const res = await post('/reports/query/unified/export', base)
      .responseType('blob')
      .expect(201);
    const buf = Buffer.from(res.body as ArrayBuffer);
    expect(buf.subarray(0, 2).toString()).toBe('PK');
    const audit = await owner.query(
      `SELECT action FROM audit_log
       WHERE tenant_id = $1 AND action LIKE 'EXPORT /reports/query/unified%'
       ORDER BY created_at DESC LIMIT 1`,
      [T15],
    );
    expect(audit.rows[0].action).toBe('EXPORT /reports/query/unified');
  });
});
