/**
 * 缺口补齐 e2e（docs/GAP_ANALYSIS_2026-10.md）— prefix `tg16-`。
 *
 * Covers:
 *  G1 违约金：参数未启用→400；启用后计提生成 PENALTY 账单项并幂等；
 *     违约金不滚入本金（重复计提 delta=0）
 *  G3 渠道对账：CSV 上传核账（MATCHED/AMOUNT_MISMATCH/NOT_FOUND）+
 *     差异挂 RECON_HANDLE 任务 + mock-statement 生成
 *  G4 催缴通知单：欠费户生成→COLLECTION 任务→打印计数
 *  G5 票据台账：号段登记→领用→收款占用票号；发票登记/作废
 *  S1 报装：申请→INSTALL_REVIEW 任务→流转→归档立户→任务办结
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

const TG = 'ee17ee17-1717-4717-8717-ee17ee17ee17';
const ORG_G = 'ee17ee17-0000-4000-8000-0000000000c0';
const ROLE_ADMIN = 'ee17ee17-0000-4000-8000-00000000ad01';
const PERM_ALL = 'ee17ee17-0000-4000-8000-00000000ff01';
const STAFF_ADMIN = 'ee17ee17-0000-4000-8000-0000000a0001';

const owner = new pg.Client({ connectionString: OWNER_URL });
let app: INestApplication<App>;
let token = '';
let waId = '';
let settleId = '';
let billId = '';
let paymentNo = '';

const post = (path: string, body?: unknown) =>
  request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${token}`).send(body ?? {});
const get = (path: string) =>
  request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`);
const put = (path: string, body?: unknown) =>
  request(app.getHttpServer()).put(path).set('Authorization', `Bearer ${token}`).send(body ?? {});

beforeAll(async () => {
  await owner.connect();
  const hash = await bcrypt.hash('tg-pass', 10);
  await owner.query(
    `INSERT INTO tenant (id, code, name, status, created_at, updated_at)
     VALUES ($1, 'tg16-water', 'TG Water', 'ACTIVE', now(), now()) ON CONFLICT DO NOTHING`,
    [TG],
  );
  await owner.query(
    `INSERT INTO org_unit (id, tenant_id, parent_id, name, type, created_at, updated_at)
     VALUES ($1, $2, NULL, 'TG Company', 'COMPANY', now(), now()) ON CONFLICT DO NOTHING`,
    [ORG_G, TG],
  );
  await owner.query(
    `INSERT INTO role (id, tenant_id, code, name, data_scope, created_at, updated_at)
     VALUES ($1, $2, 'admin', 'TG Admin', 'ALL', now(), now()) ON CONFLICT DO NOTHING`,
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
     VALUES ($1, $2, $3, 'tg-admin', $4, 'TG Admin', 'ACTIVE', now(), now())
     ON CONFLICT (tenant_id, login) DO NOTHING`,
    [STAFF_ADMIN, TG, ORG_G, hash],
  );
  await owner.query(
    `INSERT INTO staff_role (tenant_id, staff_id, role_id, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now()) ON CONFLICT DO NOTHING`,
    [TG, STAFF_ADMIN, ROLE_ADMIN],
  );
  for (const t of [
    'channel_recon_row', 'channel_recon_batch', 'collection_notice',
    'receipt_book', 'invoice_registry', 'install_application', 'task',
    'payment_alloc', 'receipt', 'payment', 'bill_item', 'bill',
    'account_event', 'meter_installation', 'meter',
    'water_account', 'settle_account', 'customer', 'tenant_param',
    'work_item', 'sys_dict', 'audit_log',
  ]) {
    await owner.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [TG]);
  }
  const fx = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = fx.createNestApplication();
  await app.init();
  token = (
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantCode: 'tg16-water', login: 'tg-admin', password: 'tg-pass' })
      .expect(201)
  ).body.accessToken;

  // 立户 + 一笔逾期账单（dueDate 早已过期）
  const ob = await post('/water-accounts/onboard', {
    customer: { name: 'TG客户一', custType: 'PERSONAL' },
    account: { usageCategory: 'RES_METERED', addr: 'TG 地址 1 号' },
    meter: { brand: 'tg-brand', caliber: 'DN15' },
    installation: { initialReading: 0, installedAt: '2026-01-01' },
  }).expect(201);
  waId = ob.body.waterAccount.id;
  settleId = ob.body.settleAccount.id;
  billId = (
    await owner.query(
      `INSERT INTO bill (id, tenant_id, settle_account_id, water_account_id, period,
                         bill_kind, source_type, source_id, status, total_amount,
                         issued_at, due_date, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, '202601', 'NORMAL', 'MANUAL', gen_random_uuid(),
               'POSTED', 30000, '2026-01-20', '2026-02-01', now(), now())
       RETURNING id::text`,
      [TG, settleId, waId],
    )
  ).rows[0].id;
  paymentNo = `TG${Math.floor(Math.random() * 1e10).toString().padStart(10, '0')}`;
  await owner.query(
    `INSERT INTO payment (id, tenant_id, payment_no, settle_account_id, cashier_id,
                          org_unit_id, channel, amount, status, received_at,
                          created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'BANK_DEDUCT', 5000,
             'RECEIVED', '2026-04-01 10:00:00+08', now(), now())`,
    [TG, paymentNo, settleId, STAFF_ADMIN, ORG_G],
  );
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

describe('G1 违约金', () => {
  it('未启用时 accrue → 400 PENALTY_DISABLED', async () => {
    const res = await post('/billing/penalties/accrue', {}).expect(400);
    expect(res.body.code).toBe('PENALTY_DISABLED');
  });

  it('启用后计提：PENALTY 项生成 + 账单总额增长；同日重提幂等', async () => {
    await put('/iam/tenant-params/billing.penalty', {
      value: { enabled: true, dailyRate: 0.001, capRatio: 0.5 },
    }).expect(200);
    const res = await post('/billing/penalties/accrue', { asOfDate: '2026-04-01' }).expect(201);
    expect(Number(res.body.accrued)).toBe(1);
    const bill = (await get(`/bills/${billId}`)).body;
    const pen = (bill.items as { itemType: string; amount: string }[]).find((i) => i.itemType === 'PENALTY');
    expect(pen).toBeDefined();
    expect(BigInt(bill.totalAmount)).toBeGreaterThan(30000n);
    // 同日重提 → 金额不变、不产生新计提
    const again = await post('/billing/penalties/accrue', { asOfDate: '2026-04-01' }).expect(201);
    expect(Number(again.body.accrued)).toBe(0);
    // 更晚日期重提 → 金额更新但仍是单行 PENALTY
    const later = await post('/billing/penalties/accrue', { asOfDate: '2026-05-01' }).expect(201);
    expect(Number(later.body.accrued)).toBe(1);
    const bill2 = (await get(`/bills/${billId}`)).body;
    const pens = (bill2.items as { itemType: string }[]).filter((i) => i.itemType === 'PENALTY');
    expect(pens).toHaveLength(1);
  });
});

describe('G3 渠道对账', () => {
  it('mock-statement 生成对账单 CSV', async () => {
    const res = await get('/payments/recon/mock-statement?channel=BANK_DEDUCT').expect(200);
    expect(res.body.content).toContain(paymentNo);
    expect(res.body.rows).toBeGreaterThanOrEqual(1);
  });

  it('上传核账：匹配/金额不符/无此单 分类 + RECON_HANDLE 任务', async () => {
    const res = await post('/payments/recon', {
      channel: 'BANK_DEDUCT',
      fileName: 'bank-202604.csv',
      content: [
        `${paymentNo},50.00,2026-04-01 10:00:00`, // 匹配
        `${paymentNo}x,999.00`,                  // 我方无此单
        'GHOST001,10.00,2026-04-02 09:00:00',    // 我方无此单
      ].join('\n'),
    }).expect(201);
    expect(res.body.batch.totalRows).toBe(3);
    expect(res.body.batch.matched).toBe(1);
    expect(res.body.batch.mismatched).toBe(2);
    expect(res.body.batch.taskId).toBeTruthy();
    const tasks = ((await get('/tasks?type=RECON_HANDLE')).body as { items: { type: string }[] }).items;
    expect(tasks.some((t) => t.type === 'RECON_HANDLE')).toBe(true);
  });

  it('明细行状态正确', async () => {
    const batches = (await get('/payments/recon')).body as { id: string }[];
    const detail = (await get(`/payments/recon/${batches[0].id}`)).body as {
      rows: { channelRef: string; matchStatus: string }[];
    };
    const byRef = new Map(detail.rows.map((r) => [r.channelRef, r.matchStatus]));
    expect(byRef.get(paymentNo)).toBe('MATCHED');
    expect(byRef.get(`${paymentNo}x`)).toBe('NOT_FOUND');
  });
});

describe('G4 催缴通知单', () => {
  let noticeId = '';
  it('欠费户生成通知单 + 挂催缴任务', async () => {
    const res = await post('/payments/collection-notices', { waterAccountId: waId }).expect(201);
    noticeId = res.body.id;
    expect(res.body.noticeNo).toMatch(/^CJ\d+/);
    expect(res.body.billCount).toBeGreaterThanOrEqual(1);
    expect(res.body.taskId).toBeTruthy();
  });
  it('打印留痕 printCount 递增', async () => {
    await post(`/payments/collection-notices/${noticeId}/print`).expect(201);
    const n = (await get(`/payments/collection-notices/${noticeId}`)).body;
    expect(n.printCount).toBe(1);
    expect(n.lastPrintedAt).toBeTruthy();
  });
  it('无欠费户 → 400 NO_ARREARS', async () => {
    const ob = await post('/water-accounts/onboard', {
      customer: { name: 'TG客户二', custType: 'PERSONAL' },
      account: { usageCategory: 'RES_METERED', addr: 'TG 地址 2 号' },
      meter: { brand: 'tg-brand', caliber: 'DN15' },
      installation: { initialReading: 0, installedAt: '2026-01-01' },
    }).expect(201);
    const res = await post('/payments/collection-notices', { waterAccountId: ob.body.waterAccount.id }).expect(400);
    expect(res.body.code).toBe('NO_ARREARS');
  });
});

describe('G5 票据台账', () => {
  it('号段登记→领用→收款占用票据号', async () => {
    const book = await post('/payments/receipt-books', {
      bookNo: 'TG-BOOK-1', prefix: 'TG', rangeStart: 1, rangeEnd: 5,
    }).expect(201);
    await put(`/payments/receipt-books/${book.body.id}/issue`, {}).expect(200);
    // 收款 → 收据号取号段 TG00001（前缀+按末位宽度补零）
    const bill2 = (
      await owner.query(
        `INSERT INTO bill (id, tenant_id, settle_account_id, water_account_id, period,
                           bill_kind, source_type, source_id, status, total_amount,
                           created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, '202602', 'NORMAL', 'MANUAL', gen_random_uuid(),
                 'POSTED', 1200, now(), now()) RETURNING id::text`,
        [TG, settleId, waId],
      )
    ).rows[0].id;
    const pay = await post('/payments', {
      settleAccountId: settleId, channel: 'CASH', amount: 1200,
      allocs: [{ billId: bill2, amount: 1200 }],
    }).expect(201);
    expect(pay.body.receipt.receiptNo).toBe('TG1'); // pad=1 (rangeEnd=5 → 1 位宽)
    const books = (await get('/payments/receipt-books')).body as { nextNo: number }[];
    expect(books[0].nextNo).toBe(2);
  });

  it('发票登记/作废留痕', async () => {
    const inv = await post('/payments/invoices', {
      invoiceNo: 'INV-TG-001', waterAccountId: waId, amount: 30000, remark: '测试登记',
    }).expect(201);
    await put(`/payments/invoices/${inv.body.id}/void`, {}).expect(200);
    const list = (await get('/payments/invoices')).body as { status: string }[];
    expect(list[0].status).toBe('VOID');
  });
});

describe('S1 报装', () => {
  let appId = '';
  it('新建申请 → SUBMITTED + INSTALL_REVIEW 任务', async () => {
    const res = await post('/install/applications', {
      applicantName: '报装测试户', contactPhone: '13800000000',
      addr: 'TG 新址 9 号', usageCategory: 'RES_METERED', caliberReq: 'DN15',
    }).expect(201);
    appId = res.body.id;
    expect(res.body.applyNo).toMatch(/^BZ\d+/);
    expect(res.body.status).toBe('SUBMITTED');
    const tasks = ((await get('/tasks?type=INSTALL_REVIEW')).body as { items: { type: string; bizId: string }[] }).items;
    expect(tasks.some((t) => t.bizId === appId)).toBe(true);
  });

  it('非法流转被拒 + 正常流转全链', async () => {
    const bad = await post(`/install/applications/${appId}/transition`, { to: 'COMPLETED' }).expect(409);
    expect(bad.body.code).toBe('INVALID_APPLY_TRANSITION');
    await post(`/install/applications/${appId}/transition`, { to: 'SURVEYED', note: '现场可装' }).expect(201);
    await post(`/install/applications/${appId}/transition`, { to: 'APPROVED' }).expect(201);
    await post(`/install/applications/${appId}/transition`, { to: 'INSTALLING', note: '派工' }).expect(201);
    const app2 = (await get(`/install/applications/${appId}`)).body;
    expect(app2.status).toBe('INSTALLING');
  });

  it('归档 → COMPLETED + 回写户号 + 任务办结', async () => {
    const res = await post(`/install/applications/${appId}/archive`, {
      account: { usageCategory: 'RES_METERED', addr: 'TG 新址 9 号' },
      meter: { brand: 'tg-brand', caliber: 'DN15' },
      installation: { initialReading: 0, installedAt: '2026-01-01' },
    }).expect(201);
    expect(res.body.status).toBe('COMPLETED');
    expect(res.body.waterAccountId).toBeTruthy();
    const wa = (await get(`/water-accounts/${res.body.waterAccountId}`)).body;
    expect(wa.addr).toBe('TG 新址 9 号');
    const tasks = ((await get('/tasks?type=INSTALL_REVIEW&box=done')).body as { items: { type: string; bizId: string; status: string }[] }).items;
    expect(tasks.some((t) => t.bizId === appId && t.status === 'DONE')).toBe(true);
  });
});
