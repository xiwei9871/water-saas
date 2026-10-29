/**
 * 1028v2 放号-上号（B1/B2/C1）e2e：
 *   放号：INSTALLING 申请 → 批量 PENDING_ASSIGN 预占户 + 档案号连续编号 + 上号任务指派
 *   上号：四项一致复核 + 录表号 → PENDING_COMPLETE + 报装申请办结 + 任务完结
 *   补录：客户/结算户/合同 → NORMAL（billable 复位）
 */
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { App } from 'supertest/types.js';
import request from 'supertest';
import * as pg from 'pg';
import bcrypt from 'bcrypt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

process.env.DATABASE_URL =
  process.env.DATABASE_URL_TEST ??
  'postgresql://ws_app:ws_app_pw@localhost:5432/watersaas_test';
const OWNER_URL =
  process.env.MIGRATION_DATABASE_URL_TEST ??
  'postgresql://postgres:postgres@localhost:5432/watersaas_test';

const TG = 'ee17ee17-1919-4719-8719-ee17ee17ee19';
const ORG_G = 'ee17ee17-0000-4000-8000-000000000a19';
const ROLE_ADMIN = 'ee17ee17-0000-4000-8000-00000000a019';
const PERM_ALL = 'ee17ee17-0000-4000-8000-00000000f019';
const STAFF_ADMIN = 'ee17ee17-0000-4000-8000-0000000a0019';

const owner = new pg.Client({ connectionString: OWNER_URL });
let app: INestApplication<App>;
let token = '';

const post = (path: string, body?: unknown) =>
  request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${token}`).send(body ?? {});
const get = (path: string) =>
  request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`);

beforeAll(async () => {
  await owner.connect();
  const hash = await bcrypt.hash('tg-pass', 10);
  await owner.query(
    `INSERT INTO tenant (id, code, name, status, created_at, updated_at)
     VALUES ($1, 'tg19-water', 'TG19 Water', 'ACTIVE', now(), now()) ON CONFLICT DO NOTHING`,
    [TG],
  );
  await owner.query(
    `INSERT INTO org_unit (id, tenant_id, parent_id, name, type, status, created_at, updated_at)
     VALUES ($1, $2, NULL, 'TG19 Company', 'COMPANY', 'ACTIVE', now(), now()) ON CONFLICT DO NOTHING`,
    [ORG_G, TG],
  );
  await owner.query(
    `INSERT INTO role (id, tenant_id, code, name, data_scope, status, created_at, updated_at)
     VALUES ($1, $2, 'admin', 'TG19 Admin', 'ALL', 'ACTIVE', now(), now()) ON CONFLICT DO NOTHING`,
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
     VALUES ($1, $2, $3, 'tg19-admin', $4, 'TG19 Admin', 'ACTIVE', now(), now())
     ON CONFLICT (tenant_id, login) DO NOTHING`,
    [STAFF_ADMIN, TG, ORG_G, hash],
  );
  await owner.query(
    `INSERT INTO staff_role (tenant_id, staff_id, role_id, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now()) ON CONFLICT DO NOTHING`,
    [TG, STAFF_ADMIN, ROLE_ADMIN],
  );
  for (const t of [
    'water_account_household_profile', 'reading_plan_item', 'reading_plan',
    'book_meter', 'reading_book', 'install_application', 'task',
    'meter_installation', 'meter', 'water_account', 'settle_account',
    'customer', 'sys_sequence', 'audit_log',
  ]) {
    await owner.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [TG]);
  }
  const fx = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = fx.createNestApplication();
  await app.init();
  token = (
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantCode: 'tg19-water', login: 'tg19-admin', password: 'tg-pass' })
      .expect(201)
  ).body.accessToken;
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

describe('1028v2 放号-上号-补录', () => {
  let appId = '';
  let applyNo = '';
  let acct1 = '';
  let acct2 = '';

  it('申请流转到 INSTALLING', async () => {
    const res = await post('/install/applications', {
      applicantName: '放号测试户', contactPhone: '13900001111',
      addr: 'TG19 上号路 8 号', usageCategory: 'RES_METERED', caliberReq: 'DN15',
    }).expect(201);
    appId = res.body.id;
    applyNo = res.body.applyNo;
    await post(`/install/applications/${appId}/transition`, { to: 'SURVEYED' }).expect(201);
    await post(`/install/applications/${appId}/transition`, { to: 'APPROVED' }).expect(201);
    await post(`/install/applications/${appId}/transition`, {
      to: 'INSTALLING', installMeterNo: 'N/A', installCaliber: 'DN15',
    }).expect(201);
  });

  it('非 INSTALLING 状态不可放号', async () => {
    const res2 = await post('/install/applications', {
      applicantName: '未装表户', addr: 'TG19 路 9 号', usageCategory: 'RES_METERED',
    }).expect(201);
    const bad = await post(`/install/applications/${res2.body.id}/allocate`, {
      meterQty: 1, readerId: STAFF_ADMIN,
    });
    expect(bad.status).toBe(409);
    expect(bad.body.code).toBe('APPLY_NOT_ACCEPTED');
  });

  it('放号 → 2 个待上号户 + 连续档案号 + 上号任务指派抄表员', async () => {
    const res = await post(`/install/applications/${appId}/allocate`, {
      meterQty: 2, caliber: 'DN15', readerId: STAFF_ADMIN, segNo: '07',
    }).expect(201);
    expect(res.body.count).toBe(2);
    expect(res.body.accounts).toHaveLength(2);
    expect(res.body.reader.id).toBe(STAFF_ADMIN);
    const [a1, a2] = res.body.accounts;
    acct1 = a1.id;
    acct2 = a2.id;
    expect(a1.archiveNo).toMatch(/^R\d{2}-07-\d{3}$/);
    expect(a2.archiveNo).toMatch(/^R\d{2}-07-\d{3}$/);
    // 户详情：PENDING_ASSIGN + 档案号/抄表员/口径/来源单号
    const wa = (await get(`/water-accounts/${acct1}`)).body;
    expect(wa.status).toBe('PENDING_ASSIGN');
    expect(wa.archiveNo).toBe(a1.archiveNo);
    expect(wa.assignReaderId).toBe(STAFF_ADMIN);
    expect(wa.pendingCaliber).toBe('DN15');
    expect(wa.sourceApplyNo).toBe(applyNo);
    expect(wa.billable).toBe(false);
    // 列表可筛 PENDING_ASSIGN
    const list = (await get('/water-accounts?status=PENDING_ASSIGN')).body;
    expect(list.some((r: { id: string }) => r.id === acct1)).toBe(true);
    // 上号任务已派给抄表员
    const tasks = ((await get('/tasks?type=ACCOUNT_ACTIVATE')).body as {
      items: { bizId: string; assigneeId: string | null }[];
    }).items;
    expect(tasks.filter((t) => t.bizId === acct1 || t.bizId === acct2)).toHaveLength(2);
  });

  it('重复放号被拒', async () => {
    const dup = await post(`/install/applications/${appId}/allocate`, {
      meterQty: 1, readerId: STAFF_ADMIN,
    });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('ALREADY_ALLOCATED');
  });

  it('上号：复核不全被拒 → 四项一致 + 表号 → PENDING_COMPLETE + 申请办结', async () => {
    const incomplete = await post(`/water-accounts/${acct1}/activate`, {
      meterNo: 'ACT-M-001',
      review: { meterNoOk: true, archiveNoOk: true, addrOk: true, nameOk: false },
    });
    expect(incomplete.status).toBe(400);
    expect(incomplete.body.code).toBe('REVIEW_INCOMPLETE');

    const ok = await post(`/water-accounts/${acct1}/activate`, {
      meterNo: 'ACT-M-001',
      initialReading: 3,
      review: { meterNoOk: true, archiveNoOk: true, addrOk: true, nameOk: true },
      meterInfo: { brand: '上号牌', caliber: 'DN15' },
    }).expect(201);
    expect(ok.body.status).toBe('PENDING_COMPLETE');
    expect(ok.body.activatedAt).toBeTruthy();
    // 表计自动建档 + INSTALLED
    const meter = (await get('/meters?q=ACT-M-001')).body;
    expect(meter[0].status).toBe('INSTALLED');
    expect(meter[0].brand).toBe('上号牌');
    // 报装申请办结 + 回写户号/表号
    const ap = (await get(`/install/applications/${appId}`)).body;
    expect(ap.status).toBe('COMPLETED');
    expect(ap.waterAccountId).toBe(acct1);
    expect(ap.meterNo).toBe('ACT-M-001');
    // 上号任务办结
    const done = ((await get('/tasks?type=ACCOUNT_ACTIVATE&box=done')).body as {
      items: { bizId: string; status: string }[];
    }).items;
    expect(done.some((t) => t.bizId === acct1 && t.status === 'DONE')).toBe(true);
  });

  it('状态机：PENDING_COMPLETE 不可再上号 / 不可重复 activate', async () => {
    const again = await post(`/water-accounts/${acct1}/activate`, {
      meterNo: 'ACT-M-999',
      review: { meterNoOk: true, archiveNoOk: true, addrOk: true, nameOk: true },
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ACCOUNT_NOT_PENDING');
  });

  it('表号冲突：同表号已在他户有效安装 → 拒', async () => {
    const conflict = await post(`/water-accounts/${acct2}/activate`, {
      meterNo: 'ACT-M-001',
      review: { meterNoOk: true, archiveNoOk: true, addrOk: true, nameOk: true },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('METER_ALREADY_INSTALLED');
    const ok = await post(`/water-accounts/${acct2}/activate`, {
      meterNo: 'ACT-M-002',
      review: { meterNoOk: true, archiveNoOk: true, addrOk: true, nameOk: true },
    }).expect(201);
    expect(ok.body.status).toBe('PENDING_COMPLETE');
  });

  it('补录：缺主体 400 → 补齐客户/结算户/合同 → NORMAL + billable', async () => {
    const bad = await post(`/water-accounts/${acct1}/complete-info`, {});
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('PRINCIPAL_REQUIRED');

    const cust = (await post('/customers', {
      name: '放号测试户', custType: 'PERSONAL', phone: '13900001111',
    }).expect(201)).body;
    const settle = (await post('/settle-accounts', {
      name: '放号测试户', phone: '13900001111',
    }).expect(201)).body;
    const done = await post(`/water-accounts/${acct1}/complete-info`, {
      customerId: cust.id,
      settleAccountId: settle.id,
      contractNo: 'HT-ALLOC-01',
      householdSize: 3,
      addr: 'TG19 上号路 8 号（补录）',
    }).expect(201);
    expect(done.body.status).toBe('NORMAL');
    expect(done.body.billable).toBe(true);
    expect(done.body.contractNo).toBe('HT-ALLOC-01');
    const wa = (await get(`/water-accounts/${acct1}`)).body;
    expect(wa.customerId).toBe(cust.id);
    expect(wa.addr).toBe('TG19 上号路 8 号（补录）');
  });

  it('补录状态机：PENDING_ASSIGN 直接补录被拒；PENDING_COMPLETE 正常补录', async () => {
    const cust = (await post('/customers', { name: 'X', custType: 'PERSONAL' }).expect(201)).body;
    const settle = (await post('/settle-accounts', { name: 'X' }).expect(201)).body;
    // 新建一个仍处 PENDING_ASSIGN 的户验证状态机
    const res2 = await post('/install/applications', {
      applicantName: '第三户', addr: 'TG19 路 10 号', usageCategory: 'RES_METERED',
    }).expect(201);
    await post(`/install/applications/${res2.body.id}/transition`, { to: 'SURVEYED' }).expect(201);
    await post(`/install/applications/${res2.body.id}/transition`, { to: 'APPROVED' }).expect(201);
    await post(`/install/applications/${res2.body.id}/transition`, { to: 'INSTALLING' }).expect(201);
    const alloc = (await post(`/install/applications/${res2.body.id}/allocate`, {
      meterQty: 1, readerId: STAFF_ADMIN,
    }).expect(201)).body;
    const early = await post(`/water-accounts/${alloc.accounts[0].id}/complete-info`, {
      customerId: cust.id, settleAccountId: settle.id,
    });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('ACCOUNT_NOT_PENDING_COMPLETE');
    // acct2 已上号 → PENDING_COMPLETE 可正常补录转 NORMAL
    const done = await post(`/water-accounts/${acct2}/complete-info`, {
      customerId: cust.id, settleAccountId: settle.id,
    }).expect(201);
    expect(done.body.status).toBe('NORMAL');
  });
});
