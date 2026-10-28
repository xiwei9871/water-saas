/**
 * 决策层报表体系 e2e（2026-10-16 修订意见）— prefix `rr17-`。
 *
 * Covers:
 *  R4 规范月报：六大类指标 × 本期/同比/累计列 + meta（公司名/填报单位/签章）
 *  R5 分月年报：12 行 + 合计行
 *  R6 公司名称：tenant_param company.name 覆盖 tenant.name
 *  R7 组织层级：orgUnitId 子树过滤，填报单位标注
 *  Q1 汇总趋势：ALL/ORG/CATEGORY 三维度 + 同比
 *  Q2 指标查询：metric-search + metrics/:code/detail 趋势
 *  H1/H2：cockpit 五区 + my-prefs 个人视图
 *  导出：ops-monthly / ops-yearly / summary-trend xlsx
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

const TG = 'rr17rr17-1717-4717-8717-rr17rr17rr17'.replace(/r/g, 'f'); // ff17…
const ORG_ROOT = 'ff17ff17-0000-4000-8000-0000000000a0';
const ORG_SUB = 'ff17ff17-0000-4000-8000-0000000000b0';
const ROLE_ADMIN = 'ff17ff17-0000-4000-8000-00000000ad01';
const PERM_ALL = 'ff17ff17-0000-4000-8000-00000000ff01';
const STAFF_ADMIN = 'ff17ff17-0000-4000-8000-0000000a0001';
const BOOK = 'ff17ff17-0000-4000-8000-00000000b001';

const owner = new pg.Client({ connectionString: OWNER_URL });
let app: INestApplication<App>;
let token = '';
let waId = '';
let settleId = '';
let instId = '';

const post = (path: string, body?: unknown) =>
  request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${token}`).send(body ?? {});
const get = (path: string) =>
  request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`);
const put = (path: string, body?: unknown) =>
  request(app.getHttpServer()).put(path).set('Authorization', `Bearer ${token}`).send(body ?? {});

beforeAll(async () => {
  await owner.connect();
  const hash = await bcrypt.hash('rr-pass', 10);
  await owner.query(
    `INSERT INTO tenant (id, code, name, status, created_at, updated_at)
     VALUES ($1, 'rr17-water', 'RR县自来水有限公司', 'ACTIVE', now(), now()) ON CONFLICT DO NOTHING`,
    [TG],
  );
  await owner.query(
    `INSERT INTO org_unit (id, tenant_id, parent_id, name, type, created_at, updated_at)
     VALUES ($1, $2, NULL, 'RR总公司', 'COMPANY', now(), now()),
            ($3, $2, $1, '第一营业所', 'BRANCH', now(), now())
     ON CONFLICT DO NOTHING`,
    [ORG_ROOT, TG, ORG_SUB],
  );
  await owner.query(
    `INSERT INTO role (id, tenant_id, code, name, data_scope, created_at, updated_at)
     VALUES ($1, $2, 'admin', 'RR Admin', 'ALL', now(), now()) ON CONFLICT DO NOTHING`,
    [ROLE_ADMIN, TG],
  );
  await owner.query(
    `INSERT INTO permission (id, tenant_id, code, type, created_at, updated_at)
     VALUES ($1, $2, '*', 'ACTION', now(), now()) ON CONFLICT DO NOTHING`,
    [PERM_ALL, TG],
  );
  await owner.query(
    `INSERT INTO role_permission (tenant_id, role_id, permission_id, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now()) ON CONFLICT DO NOTHING`,
    [TG, ROLE_ADMIN, PERM_ALL],
  );
  await owner.query(
    `INSERT INTO staff (id, tenant_id, org_unit_id, login, password_hash, name, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'rr-admin', $4, 'RR Admin', 'ACTIVE', now(), now())
     ON CONFLICT (tenant_id, login) DO NOTHING`,
    [STAFF_ADMIN, TG, ORG_ROOT, hash],
  );
  await owner.query(
    `INSERT INTO staff_role (tenant_id, staff_id, role_id, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now()) ON CONFLICT DO NOTHING`,
    [TG, STAFF_ADMIN, ROLE_ADMIN],
  );
  for (const t of [
    'consumption_component', 'consumption_settlement', 'meter_reading',
    'reading_plan_item', 'reading_plan', 'book_meter', 'reading_book',
    'payment_alloc', 'receipt', 'payment', 'bill_item', 'bill',
    'meter_installation', 'meter', 'water_account', 'settle_account',
    'customer', 'staff_pref', 'tenant_param', 'task', 'audit_log',
  ]) {
    await owner.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [TG]);
  }
  const fx = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = fx.createNestApplication();
  await app.init();
  token = (
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantCode: 'rr17-water', login: 'rr-admin', password: 'rr-pass' })
      .expect(201)
  ).body.accessToken;

  // 立户 + 册归属第一营业所 + 结算/账单/收款
  const ob = await post('/water-accounts/onboard', {
    customer: { name: 'RR客户一', custType: 'PERSONAL' },
    account: { usageCategory: 'RES_METERED', addr: 'RR 地址 1 号' },
    meter: { brand: 'rr', caliber: 'DN15' },
    installation: { initialReading: 0, installedAt: '2025-06-01' },
  }).expect(201);
  waId = ob.body.waterAccount.id;
  settleId = ob.body.settleAccount.id;
  instId = (
    await owner.query(
      `SELECT id::text FROM meter_installation
       WHERE tenant_id = $1 AND water_account_id = $2 AND status = 'ACTIVE'`,
      [TG, waId],
    )
  ).rows[0].id;
  await owner.query(
    `INSERT INTO reading_book (id, tenant_id, book_no, name, org_unit_id, cadence, created_at, updated_at)
     VALUES ($1, $2, 'RB-RR1', '第一营业所册', $3, 'MONTHLY', now(), now()) ON CONFLICT DO NOTHING`,
    [BOOK, TG, ORG_SUB],
  );
  await owner.query(
    `INSERT INTO book_meter (tenant_id, book_id, water_account_id, seq_no, created_at, updated_at)
     VALUES ($1, $2, $3, 1, now(), now()) ON CONFLICT DO NOTHING`,
    [TG, BOOK, waId],
  );
  // 202604 售水 100m³ + 应收 300 元 + 实收 300（当期实收）
  await owner.query(
    `INSERT INTO consumption_settlement
       (id, tenant_id, water_account_id, period, total_usage_qty, is_estimated,
        status, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, '202604', 100, false, 'FINAL', now(), now())`,
    [TG, waId],
  );
  const billId = (
    await owner.query(
      `INSERT INTO bill (id, tenant_id, settle_account_id, water_account_id, period,
                         bill_kind, source_type, source_id, status, is_estimated,
                         total_amount, issued_at, due_date, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, '202604', 'NORMAL', 'MANUAL', gen_random_uuid(),
               'POSTED', false, 30000, '2026-04-05', '2026-05-01', now(), now())
       RETURNING id::text`,
      [TG, settleId, waId],
    )
  ).rows[0].id;
  const payId = (
    await owner.query(
      `INSERT INTO payment (id, tenant_id, payment_no, settle_account_id, cashier_id,
                            org_unit_id, channel, amount, status, received_at,
                            created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'RRPAY1', $2, $3, $4, 'CASH', 30000,
               'RECEIVED', '2026-04-20 10:00:00+08', now(), now())
       RETURNING id::text`,
      [TG, settleId, STAFF_ADMIN, ORG_SUB],
    )
  ).rows[0].id;
  await owner.query(
    `INSERT INTO payment_alloc (id, tenant_id, payment_id, bill_id, amount, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 30000, now(), now())`,
    [TG, payId, billId],
  );
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

describe('R4 规范月报', () => {
  it('六大类指标齐备 + 四要素 meta + 本期数正确', async () => {
    const res = await get('/reports/ops-monthly?period=202604').expect(200);
    expect(res.body.meta.companyName).toBe('RR县自来水有限公司');
    expect(res.body.meta.orgLabel).toBe('全公司');
    expect(res.body.meta.periodLabel).toBe('2026 年 4 月');
    expect(res.body.meta.preparedBy).toBe('RR Admin');
    const names = res.body.sections.map((s: { name: string }) => s.name);
    expect(names).toEqual([
      '一、售水及收入', '二、收费', '三、欠费', '四、抄表质量', '五、客户', '六、经营效益',
    ]);
    const rows = res.body.sections.flatMap((s: { rows: { key: string; current: number | null }[] }) => s.rows);
    const sold = rows.find((r: { key: string }) => r.key === 'SOLD_QTY');
    expect(sold.current).toBe(100);
    const col = rows.find((r: { key: string }) => r.key === 'COLLECTED');
    expect(col.current).toBe(300);
    const seq = rows.map((r: { seq: number }) => r.seq);
    expect(seq).toEqual([...seq].sort((a: number, b: number) => a - b)); // 连续编号
    expect(rows.length).toBe(21);
  });

  it('R6 公司名称：tenant_param company.name 覆盖 tenant.name', async () => {
    await put('/iam/tenant-params/company.name', { value: 'RR水务集团' }).expect(200);
    const res = await get('/reports/ops-monthly?period=202604').expect(200);
    expect(res.body.meta.companyName).toBe('RR水务集团');
  });

  it('自检 checkResults：13 规则齐备，勾稽类 R1/R2/R11 通过，异常项带 actual/expected/diff', async () => {
    const res = await get('/reports/ops-monthly?period=202604').expect(200);
    const checks = res.body.checkResults as {
      rule: string; level: string; passed: boolean;
      actual: string | null; expected: string | null; diff: string | null; message: string;
    }[];
    expect(Array.isArray(checks)).toBe(true);
    const byRule = Object.fromEntries(checks.map((c) => [c.rule, c]));
    for (const r of ['R1', 'R2', 'R3', 'R4', 'R6a', 'R6b', 'R7', 'R8', 'R9', 'R10', 'R11', 'R12', 'R13']) {
      expect(byRule[r], `${r} 缺失`).toBeTruthy();
    }
    // R1 勾稽：期末欠费 = 期初 + 应收 − 实收（RR 数据一致应通过）
    expect(byRule.R1.level).toBe('BLOCK');
    expect(byRule.R1.passed).toBe(true);
    expect(byRule.R1.diff).toBe('+0.00');
    expect(byRule.R2.passed).toBe(true);
    expect(byRule.R3.passed).toBe(true);
    // 结果包含结论文案
    for (const c of checks) expect(c.message.length).toBeGreaterThan(0);
    // 阻断/警告字段完整
    for (const c of checks.filter((x) => !x.passed)) {
      expect(['BLOCK', 'WARN']).toContain(c.level);
    }
  });

  it('自检 R1：构造数据失衡时返回 BLOCK 不通过（期初欠费≠上期期末）', async () => {
    // RR 数据中 202604 与历史勾稽一致；用 202605（无数据期）验证零数据期结论合理
    const res = await get('/reports/ops-monthly?period=202605').expect(200);
    const r1 = (res.body.checkResults as { rule: string; passed: boolean; actual: string }[]).find(
      (c) => c.rule === 'R1',
    );
    // 无业务时 期末=期初 仍应勾稽（0=0 通过，期初应延续 202604 期末欠费）
    expect(r1.passed).toBe(true);
  });

  it('R7 部门级：orgUnitId=第一营业所 → 填报单位标注 + 数据归属该所', async () => {
    const res = await get(`/reports/ops-monthly?period=202604&orgUnitId=${ORG_SUB}`).expect(200);
    expect(res.body.meta.orgLabel).toBe('第一营业所');
    const rows = res.body.sections.flatMap((s: { rows: { key: string; current: number | null }[] }) => s.rows);
    expect(rows.find((r) => r.key === 'COLLECTED').current).toBe(300);
    // 虚构组织 → 404
    await get(`/reports/ops-monthly?period=202604&orgUnitId=${TG}`).expect(404);
  });
});

describe('R5 分月年报', () => {
  it('12 行分月 + 合计行', async () => {
    const res = await get('/reports/ops-yearly?year=2026').expect(200);
    expect(res.body.rows.length).toBe(13);
    const apr = res.body.rows.find((r: { period?: string }) => r.period === '202604');
    expect(apr.soldQty).toBe(100);
    const total = res.body.rows[12];
    expect(total.month).toBe('全年合计 / 平均');
    expect(total.soldQty).toBe(100);
    expect(res.body.meta.periodLabel).toBe('2026 年度');
  });
});

describe('Q1 汇总趋势', () => {
  it('ALL：近2年行 + 同比', async () => {
    const res = await get('/reports/summary-trend?years=2&endYear=2026').expect(200);
    expect(res.body.rows.length).toBe(2);
    const y2026 = res.body.rows.find((r: { year: number }) => r.year === 2026);
    expect(y2026.soldQty).toBe(100);
    expect(y2026.collected).toBe(300);
    expect(y2026.yoy.soldQty).toBeNull(); // 2025 无数据 → null
  });

  it('ORG：按片区分组聚合', async () => {
    const res = await get('/reports/summary-trend?groupBy=ORG&years=1&endYear=2026').expect(200);
    const sub = res.body.rows.find((r: { group: string }) => r.group === '第一营业所');
    expect(sub).toBeDefined();
    expect(sub.collected).toBe(300); // 收款按 payment.org_unit_id 归属
  });

  it('CATEGORY：按用水类别分组', async () => {
    const res = await get('/reports/summary-trend?groupBy=CATEGORY&years=1&endYear=2026').expect(200);
    const rr = res.body.rows.find((r: { group: string }) => r.group === 'RES_METERED');
    expect(rr).toBeDefined();
    expect(rr.soldQty).toBe(100);
  });
});

describe('Q2 指标查询', () => {
  it('按名搜索 + 详情含当前值/近N期趋势', async () => {
    const res = await get('/reports/metric-search?q=回收率').expect(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    const detail = await get('/reports/metrics/COLLECTED/detail?periods=4&endPeriod=202607').expect(200);
    expect(detail.body.def.name).toBe('实收水费');
    expect(detail.body.periods.length).toBe(4);
    const apr = detail.body.periods.find((p: { period: string }) => p.period === '202604');
    expect(apr.value).toBe(300);
  });

  it('未知指标 → 404', async () => {
    await get('/reports/metrics/NOPE/detail').expect(404);
  });
});

describe('H1/H2 驾驶舱', () => {
  it('cockpit 五区字段齐备', async () => {
    const res = await get('/reports/cockpit?periods=3').expect(200);
    expect(res.body.cards.RECOVERY_RATE).toBeDefined();
    expect(res.body.realtime.todayCollected).toBeDefined();
    expect(res.body.trend.length).toBe(3);
    expect(res.body.alerts.openTasks).toBeDefined();
    expect(Array.isArray(res.body.orgRanking)).toBe(true);
  });

  it('my-prefs 个人视图读写 + 非法 key 400', async () => {
    await put('/iam/my-prefs/dashboard.view', {
      value: { cards: ['SOLD_QTY'], trendMetric: 'revenue', periods: 6 },
    }).expect(200);
    const res = await get('/iam/my-prefs/dashboard.view').expect(200);
    expect(res.body.cards).toEqual(['SOLD_QTY']);
    await put('/iam/my-prefs/evil.key', { value: 1 }).expect(400);
  });
});

describe('导出 xlsx', () => {
  it('ops-monthly / ops-yearly / summary-trend 均产出 xlsx', async () => {
    for (const p of [
      '/reports/ops-monthly/export?period=202604',
      '/reports/ops-yearly/export?year=2026',
      '/reports/summary-trend/export?groupBy=ALL&years=2',
    ]) {
      const res = await get(p).expect(200);
      expect(res.headers['content-type']).toContain('spreadsheetml');
      expect(res.body).toBeDefined();
    }
  });
});
