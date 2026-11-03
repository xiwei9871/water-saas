/**
 * 1102 抄表业务模型重构 Stage-A 专项 e2e（t9 前缀 fixture）：
 *  A1 自动计划=下一个工作日（周五→周一/节假日顺延/跨月/幂等/plan_gen_run）
 *  A2 调序校验+两阶段重排+routeKey 保序+跳序学习+模式组织权限
 *  A3 区段变更册成员一致性（移动/解除/补赋任务闭环）
 *  A4 放号 meterQty 严格校验/口径明细一致/安装明细上限/退号
 *  A5 权限负测（越权绑定/越权应用模式/跨租户隔离）
 *
 *  fixture 说明：测试库跨运行残留——区号按 RUN 派生保证每轮唯一；
 *  日历例外(2026-12-07 节假日)用 upsert 语义天然幂等。
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

const T9A = '99999999-9999-4999-8999-999999999999';
const T9B = '9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b9b';
const ORG_A = '99999999-0000-4000-8000-0000000000a0';
const ORG_A_BR = '99999999-0000-4000-8000-0000000000b1';
const ORG_B = '9b9b9b9b-0000-4000-8000-0000000000b0';
const ROLE_ADMIN_A = '99999999-0000-4000-8000-00000000ad01';
const ROLE_VIEWER_A = '99999999-0000-4000-8000-000000001e01';
const ROLE_WRITER_A = '99999999-0000-4000-8000-000000001e02';
const ROLE_B_ADMIN = '9b9b9b9b-0000-4000-8000-00000000ad01';
const PERM_MET_READ = '99999999-0000-4000-8000-00000000e601';
const PERM_MET_WRITE = '99999999-0000-4000-8000-00000000e602';
const PERM_CUST_WRITE = '99999999-0000-4000-8000-00000000e603';
const STAFF_ADMIN_A = '99999999-0000-4000-8000-0000000a0001';
const STAFF_VIEWER_A = '99999999-0000-4000-8000-0000000b0002';
const STAFF_READER_A = '99999999-0000-4000-8000-0000000c0003';
const STAFF_WRITER_A = '99999999-0000-4000-8000-0000000b0004';
const STAFF_B_ADMIN = '9b9b9b9b-0000-4000-8000-0000000a0001';

const owner = new pg.Client({ connectionString: OWNER_URL });
let app: INestApplication<App>;
let adminToken = '';
let viewerToken = '';
let writerToken = '';
let tenantBToken = '';

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
// 每运行唯一区号（20–98，17 与 79 互质 → n 不同区号必不同）。
const runNum = parseInt(RUN.replace(/[^a-z0-9]/g, '').slice(-6), 36) || 1;
const zoneOf = (n: number) => String(20 + ((runNum + n * 17) % 79)).padStart(2, '0');
const Z1 = zoneOf(1); // A1 用（区段册 06/05/01）
const Z2 = zoneOf(2); // A2/A3 用
const ZN1 = zoneOf(5); // 负测用
const ZN2 = zoneOf(6);

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const post = (path: string, body: object, token = adminToken) =>
  request(app.getHttpServer()).post(path).set(auth(token)).send(body);
const patch = (path: string, body: object, token = adminToken) =>
  request(app.getHttpServer()).patch(path).set(auth(token)).send(body);
const get = (path: string, token = adminToken) =>
  request(app.getHttpServer()).get(path).set(auth(token));

const onboard = async (label: string, account?: Record<string, unknown>) => {
  const res = await post('/water-accounts/onboard', {
    customer: { name: `T9 ${label} ${RUN}`, custType: 'PERSONAL' },
    account: { usageCategory: 'RES_METERED', addr: `${label} Rd`, ...account },
    meter: { brand: 't9', caliber: 'DN15' },
    installation: { initialReading: 0 },
  }).expect(201);
  return res.body.waterAccount.id as string;
};

/** 区号绑定 find-or-create（同名区号跨运行残留时复用并确保启用）。 */
const ensureZone = async (zoneNo: string) => {
  const existing = (await get('/reading-zones')).body.find(
    (z: { zoneNo: string }) => z.zoneNo === zoneNo,
  );
  if (existing) {
    if (existing.status !== 'ACTIVE' || existing.readerId !== STAFF_READER_A) {
      await patch(`/reading-zones/${existing.id}`, {
        readerId: STAFF_READER_A, status: 'ACTIVE',
      }).expect(200);
    }
    return existing;
  }
  return (await post('/reading-zones', { zoneNo, readerId: STAFF_READER_A }).expect(201)).body;
};

/** 在册列表里找 zone+seg 册。 */
const bookOf = async (zoneNo: string, segNo: string | null) =>
  (await get('/reading-books?take=200')).body.find(
    (x: { zoneNo: string | null; segNo: string | null }) =>
      x.zoneNo === zoneNo && x.segNo === segNo,
  );

beforeAll(async () => {
  await owner.connect();
  const hash = await bcrypt.hash('t9-pass', 10);
  await owner.query(
    `INSERT INTO tenant (id, code, name, status, created_at, updated_at)
     VALUES ($1,'t9-water','T9 Water','ACTIVE',now(),now()),
            ($2,'t9-other','T9 Other','ACTIVE',now(),now()) ON CONFLICT DO NOTHING`,
    [T9A, T9B],
  );
  await owner.query(
    `INSERT INTO org_unit (id, tenant_id, parent_id, name, type, created_at, updated_at)
     VALUES ($1,$2,NULL,'T9 Co','COMPANY',now(),now()),
            ($3,$4,NULL,'T9B Co','COMPANY',now(),now()),
            ($5,$2,$1,'T9 Br','BRANCH',now(),now()) ON CONFLICT DO NOTHING`,
    [ORG_A, T9A, ORG_B, T9B, ORG_A_BR],
  );
  await owner.query(
    `INSERT INTO role (id, tenant_id, code, name, data_scope, created_at, updated_at)
     VALUES ($1,$3,'admin','Admin','ALL',now(),now()),
            ($2,$3,'t9-viewer','Viewer','ORG_SUBTREE',now(),now()),
            ($4,$3,'t9-writer','Writer','ORG_SUBTREE',now(),now()),
            ($5,$6,'admin','AdminB','ALL',now(),now()) ON CONFLICT DO NOTHING`,
    [ROLE_ADMIN_A, ROLE_VIEWER_A, T9A, ROLE_WRITER_A, ROLE_B_ADMIN, T9B],
  );
  await owner.query(
    `INSERT INTO permission (id, tenant_id, code, type, created_at, updated_at)
     VALUES ($1,$2,'metering:read','ACTION',now(),now()),
            ($3,$2,'metering:write','ACTION',now(),now()),
            ($4,$2,'customer:write','ACTION',now(),now()),
            ($5,$2,'*','ACTION',now(),now()) ON CONFLICT DO NOTHING`,
    [PERM_MET_READ, T9A, PERM_MET_WRITE, PERM_CUST_WRITE, '99999999-0000-4000-8000-00000000ff01'],
  );
  await owner.query(
    `INSERT INTO permission (id, tenant_id, code, type, created_at, updated_at)
     VALUES ('9b9b9b9b-0000-4000-8000-00000000ff01',$1,'*','ACTION',now(),now())
     ON CONFLICT DO NOTHING`,
    [T9B],
  );
  await owner.query(
    `INSERT INTO role_permission (tenant_id, role_id, permission_id, created_at, updated_at)
     VALUES ($1,$2,$3,now(),now()),($1,$4,$5,now(),now()),($1,$4,$6,now(),now()),
            ($1,$4,$3,now(),now()),
            ($1,$7,$8,now(),now()),($9,$10,$11,now(),now())
     ON CONFLICT DO NOTHING`,
    [T9A, ROLE_VIEWER_A, PERM_MET_READ, ROLE_WRITER_A, PERM_MET_WRITE,
     PERM_CUST_WRITE, ROLE_ADMIN_A, '99999999-0000-4000-8000-00000000ff01',
     T9B, ROLE_B_ADMIN, '9b9b9b9b-0000-4000-8000-00000000ff01'],
  );
  await owner.query(
    `INSERT INTO staff (id, tenant_id, org_unit_id, login, password_hash, name, status, created_at, updated_at)
     VALUES ($1,$4,$6,'t9-admin',$7,'Admin','ACTIVE',now(),now()),
            ($2,$4,$6,'t9-viewer',$7,'Viewer','ACTIVE',now(),now()),
            ($8,$4,$6,'t9-reader',$7,'Reader','ACTIVE',now(),now()),
            ($3,$5,$9,'t9b-admin',$7,'AdminB','ACTIVE',now(),now()),
            ($10,$4,$11,'t9-writer',$7,'Writer','ACTIVE',now(),now())
     ON CONFLICT (tenant_id, login) DO NOTHING`,
    [STAFF_ADMIN_A, STAFF_VIEWER_A, STAFF_B_ADMIN, T9A, T9B, ORG_A, hash,
     STAFF_READER_A, ORG_B, STAFF_WRITER_A, ORG_A_BR],
  );
  await owner.query(
    `INSERT INTO staff_role (tenant_id, staff_id, role_id, created_at, updated_at)
     VALUES ($1,$2,$4,now(),now()),($1,$3,$5,now(),now()),($6,$7,$8,now(),now()),
            ($1,$9,$10,now(),now()) ON CONFLICT DO NOTHING`,
    [T9A, STAFF_ADMIN_A, STAFF_VIEWER_A, ROLE_ADMIN_A, ROLE_VIEWER_A,
     T9B, STAFF_B_ADMIN, ROLE_B_ADMIN, STAFF_WRITER_A, ROLE_WRITER_A],
  );
  await owner.query(
    `INSERT INTO tenant_param (tenant_id, key, value, created_at, updated_at)
     VALUES ($1,'metering.collectMode','"ZONE_SEGMENT"',now(),now())
     ON CONFLICT (tenant_id, key) DO UPDATE SET value='"ZONE_SEGMENT"'`,
    [T9A],
  );

  // P0-2：违章类型字典（FIELD 上报须字典匹配）
  await owner.query(
    `INSERT INTO sys_dict (id, tenant_id, category, code, name, seq, status, created_at, updated_at)
     SELECT gen_random_uuid(), $1, 'VIOLATION_TYPE', c.code, c.name, c.seq, 'ACTIVE', now(), now()
       FROM (VALUES ('TAMPER','破坏计量',1),('PRIVATE_CONN','私接管线',2),
                    ('THEFT','偷水',3),('SEAL_BROKEN','封条破损',4)) AS c(code,name,seq)
     ON CONFLICT DO NOTHING`, [T9A]);

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleFixture.createNestApplication();
  await app.init();
  const login = async (tenantCode: string, l: string) =>
    (await request(app.getHttpServer())
      .post('/auth/login').send({ tenantCode, login: l, password: 't9-pass' })
      .expect(201)).body.accessToken as string;
  adminToken = await login('t9-water', 't9-admin');
  viewerToken = await login('t9-water', 't9-viewer');
  writerToken = await login('t9-water', 't9-writer');
  tenantBToken = await login('t9-other', 't9b-admin');
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

// ---------------------------------------------------------------------------
// A1 自动计划 = 下一个工作日
// ---------------------------------------------------------------------------
describe('A1 auto-generate next workday', () => {
  let segBookId = '';
  const BASE_FRI = '2026-11-06'; // 周五
  const EXPECT_MON = '2026-11-09'; // 下周一 = 当月第 6 个工作日 → 段 06

  it('周五 18 点后生成的是周一计划（非周六）', async () => {
    await ensureZone(Z1);
    const wa = await onboard('A1');
    await patch(`/water-accounts/${wa}`, { zoneNo: Z1, segNo: '06' }).expect(200);
    const b = await bookOf(Z1, '06');
    expect(b).toBeTruthy();
    segBookId = b.id;

    const r = await post('/reading-plans/auto-generate', { baseDate: BASE_FRI }).expect(201);
    expect(r.body.planDate.slice(0, 10)).toBe(EXPECT_MON);
    expect(r.body.segNo).toBe('06');
    expect(r.body.generated).toContain(segBookId);
    const plan = (await get(`/reading-plans?bookId=${segBookId}&period=202611`)).body[0];
    expect(plan.planDate.slice(0, 10)).toBe(EXPECT_MON);
    const runs = await owner.query(
      `SELECT status, seg_no FROM plan_gen_run WHERE tenant_id=$1
        ORDER BY created_at DESC LIMIT 1`, [T9A]);
    expect(runs.rows[0].status).toBe('OK');
    expect(runs.rows[0].seg_no).toBe('06');
  });

  it('幂等：重复触发同日不再生成', async () => {
    const r = await post('/reading-plans/auto-generate', { baseDate: BASE_FRI }).expect(201);
    expect(r.body.generated).toEqual([]);
    const runs = await owner.query(
      `SELECT status FROM plan_gen_run WHERE tenant_id=$1
        ORDER BY created_at DESC LIMIT 1`, [T9A]);
    expect(runs.rows[0].status).toBe('OK');
  });

  it('节假日顺延：周一登记节假日 → 计划落到周二(段05)', async () => {
    await post('/metering/calendar', { day: '2026-12-07', kind: 'HOLIDAY' }).expect(201);
    // 2026-12-04 周五 → 12-07 周一(节假日跳过) → 下一工作日 12-08 周二 = 第 5 个工作日
    const wa = await onboard('A1B');
    await patch(`/water-accounts/${wa}`, { zoneNo: Z1, segNo: '05' }).expect(200);
    const b = await bookOf(Z1, '05');
    const r = await post('/reading-plans/auto-generate', { baseDate: '2026-12-04' }).expect(201);
    expect(r.body.planDate.slice(0, 10)).toBe('2026-12-08');
    expect(r.body.segNo).toBe('05');
    expect(r.body.generated).toContain(b.id);
  });

  it('跨月：月末评估日 → 下一工作日落次月、账期取次月', async () => {
    const wa = await onboard('A1C');
    await patch(`/water-accounts/${wa}`, { zoneNo: Z1, segNo: '01' }).expect(200);
    const b = await bookOf(Z1, '01');
    const r = await post('/reading-plans/auto-generate', { baseDate: '2026-11-30' }).expect(201);
    expect(r.body.planDate.slice(0, 10)).toBe('2026-12-01');
    expect(r.body.segNo).toBe('01');
    const plan = (await get(`/reading-plans?bookId=${b.id}&period=202612`)).body[0];
    expect(plan.period).toBe('202612');
  });
});

// ---------------------------------------------------------------------------
// A2 调序 + 路线学习 + 模式权限
// ---------------------------------------------------------------------------
describe('A2 reorder + routeKey', () => {
  let planId = '';
  let items: { id: string; waterAccountId: string }[] = [];

  it('建册 3 户生成计划', async () => {
    await ensureZone(Z2);
    for (const l of ['P', 'Q', 'R']) {
      const wa = await onboard(l);
      await patch(`/water-accounts/${wa}`, { zoneNo: Z2, segNo: '02' }).expect(200);
    }
    const book = await bookOf(Z2, '02');
    const plan = await post('/reading-plans/generate', { bookId: book.id, period: '202611' }).expect(201);
    planId = plan.body.id;
    items = plan.body.items;
    expect(items).toHaveLength(3);
  });

  it('负测：数量不符/重复ID/他计划ID → 400', async () => {
    expect((await post(`/reading-plans/${planId}/reorder`, { orderedItemIds: [items[0].id] }))
      .body.code).toBe('REORDER_ITEMS_MISMATCH');
    expect((await post(`/reading-plans/${planId}/reorder`, {
      orderedItemIds: [items[0].id, items[0].id, items[1].id],
    })).body.code).toBe('REORDER_ITEMS_DUPLICATED');
    expect((await post(`/reading-plans/${planId}/reorder`, {
      orderedItemIds: [items[0].id, items[1].id, '11111111-1111-4111-8111-111111111111'],
    })).body.code).toBe('REORDER_ITEM_NOT_IN_PLAN');
  });

  it('逆序调序：seqNo 重排 + routeKey 同集合重贴且递增', async () => {
    const before = await owner.query(
      `SELECT route_key FROM water_account WHERE id = ANY($1::uuid[])`,
      [items.map((i) => i.waterAccountId)]);
    const oldKeys = before.rows.map((r) => Number(r.route_key)).sort((a, b) => a - b);
    expect(oldKeys).toHaveLength(3);

    const reversed = [...items].reverse().map((i) => i.id);
    const res = await post(`/reading-plans/${planId}/reorder`, { orderedItemIds: reversed }).expect(201);
    expect(res.body.map((i: { id: string }) => i.id)).toEqual(reversed);
    const keys = (await owner.query(
      `SELECT w.route_key FROM reading_plan_item i
         JOIN water_account w ON w.id=i.water_account_id
        WHERE i.plan_id=$1 ORDER BY i.seq_no`, [planId])).rows.map((r) => Number(r.route_key));
    expect([...keys].sort((a, b) => a - b)).toEqual(oldKeys);
    for (let i = 1; i < keys.length; i++) expect(keys[i]).toBeGreaterThan(keys[i - 1]);
  });

  it('未参与计划的户 routeKey 不被调序破坏', async () => {
    const wa = await onboard('OUT');
    await owner.query(`UPDATE water_account SET route_key=555555 WHERE id=$1`, [wa]);
    await post(`/reading-plans/${planId}/reorder`, {
      orderedItemIds: items.map((i) => i.id),
    }).expect(201);
    const after = (await owner.query(
      `SELECT route_key FROM water_account WHERE id=$1`, [wa])).rows[0].route_key;
    expect(Number(after)).toBe(555555);
  });

  it('跳序抄表→routeKey 学习（先抄第3户后抄第1户 → k3 < k1）', async () => {
    const [i1, , i3] = items;
    await post('/meter-readings', { planItemId: i3.id, resultType: 'ACTUAL', readingValue: 11 }).expect(201);
    await post('/meter-readings', { planItemId: i1.id, resultType: 'ACTUAL', readingValue: 10 }).expect(201);
    const k = await owner.query(
      `SELECT id, route_key FROM water_account WHERE id = ANY($1::uuid[])`,
      [[i1.waterAccountId, i3.waterAccountId]]);
    const k1 = Number(k.rows.find((r) => r.id === i1.waterAccountId).route_key);
    const k3 = Number(k.rows.find((r) => r.id === i3.waterAccountId).route_key);
    expect(k3).toBeLessThan(k1);
  });

  it('CLOSED 计划禁止调序', async () => {
    await post(`/reading-plans/${planId}/cancel`, {}).expect(201);
    const r = await post(`/reading-plans/${planId}/reorder`, {
      orderedItemIds: items.map((i) => i.id),
    });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('PLAN_NOT_REORDERABLE');
  });
});

// ---------------------------------------------------------------------------
// A3 区段变更 → 册成员一致性 + 补赋任务闭环
// ---------------------------------------------------------------------------
describe('A3 zone/seg membership consistency', () => {
  it('设区+段入册 → 清段号解除入册+建补赋任务 → 补赋后闭环', async () => {
    const wa = await onboard('A3', { zoneNo: Z2, segNo: '03' });
    const member = await owner.query(
      `SELECT 1 FROM book_meter bm JOIN reading_book b ON b.id=bm.book_id
        WHERE bm.water_account_id=$1 AND b.zone_no=$2 AND b.seg_no='03'`, [wa, Z2]);
    expect(member.rowCount).toBe(1);

    await patch(`/water-accounts/${wa}`, { segNo: null }).expect(200);
    expect((await owner.query(
      `SELECT 1 FROM book_meter WHERE water_account_id=$1`, [wa])).rowCount).toBe(0);
    const task = await owner.query(
      `SELECT id, status FROM task WHERE tenant_id=$1 AND type='ACCOUNT_SEG_ASSIGN'
        AND biz_id=$2 AND status IN ('PENDING','ASSIGNED','CLAIMED')`, [T9A, wa]);
    expect(task.rowCount).toBe(1);

    await patch(`/water-accounts/${wa}`, { segNo: '04' }).expect(200);
    const back = await owner.query(
      `SELECT 1 FROM book_meter bm JOIN reading_book b ON b.id=bm.book_id
        WHERE bm.water_account_id=$1 AND b.zone_no=$2 AND b.seg_no='04'`, [wa, Z2]);
    expect(back.rowCount).toBe(1);
    const closed = await owner.query(`SELECT status FROM task WHERE id=$1`, [task.rows[0].id]);
    expect(['DONE', 'CANCELLED']).toContain(closed.rows[0].status);
  });

  it('清空区号同样解除入册并建补赋任务', async () => {
    const wa = await onboard('A3B', { zoneNo: Z2, segNo: '05' });
    await patch(`/water-accounts/${wa}`, { zoneNo: null }).expect(200);
    expect((await owner.query(
      `SELECT 1 FROM book_meter WHERE water_account_id=$1`, [wa])).rowCount).toBe(0);
    const task = await owner.query(
      `SELECT 1 FROM task WHERE tenant_id=$1 AND type='ACCOUNT_SEG_ASSIGN'
        AND biz_id=$2 AND status IN ('PENDING','ASSIGNED','CLAIMED')`, [T9A, wa]);
    expect(task.rowCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// A4 放号校验 + 退号
// ---------------------------------------------------------------------------
describe('A4 allocate guard + deallocate', () => {
  let appId = '';

  const mkApp = async (meterQty = 3) => {
    const r = await post('/install/applications', {
      applicantName: `T9 ${RUN}`, addr: 'T9 Rd', usageCategory: 'RES_METERED', meterQty,
    }).expect(201);
    await post(`/install/applications/${r.body.id}/transition`, { to: 'SURVEYED' }).expect(201);
    await post(`/install/applications/${r.body.id}/transition`, { to: 'APPROVED' }).expect(201);
    await post(`/install/applications/${r.body.id}/transition`,
      { to: 'INSTALLING', installCompletedAt: '2026-11-01' }).expect(201);
    return r.body.id as string;
  };

  it('meterQty 非整数/越界 → 400；超批准量 → 409；明细合计不符 → 400', async () => {
    appId = await mkApp(3);
    for (const q of [0, 1.5, 10000, -3]) {
      const r = await post(`/install/applications/${appId}/allocate`,
        { meterQty: q, readerId: STAFF_READER_A });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('METER_QTY_INVALID');
    }
    const over = await post(`/install/applications/${appId}/allocate`,
      { meterQty: 5, readerId: STAFF_READER_A });
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('QTY_EXCEEDS_APPROVED');
    const mm = await post(`/install/applications/${appId}/allocate`, {
      meterQty: 3, readerId: STAFF_READER_A,
      caliberDetails: [{ caliber: 'DN15', qty: 2 }, { caliber: 'DN20', qty: 2 }],
    });
    expect(mm.status).toBe(400);
    expect(mm.body.code).toBe('CALIBER_DETAILS_MISMATCH');
  });

  it('口径明细放号 + 退号闭环（档案号不复用）', async () => {
    const ok = await post(`/install/applications/${appId}/allocate`, {
      meterQty: 3, readerId: STAFF_READER_A, segNo: '05',
      caliberDetails: [{ caliber: 'DN15', qty: 2 }, { caliber: 'DN20', qty: 1 }],
    }).expect(201);
    expect(ok.body.count).toBe(3);
    const acctIds = ok.body.accounts.map((a: { id: string }) => a.id);
    const calibers = (await owner.query(
      `SELECT pending_caliber FROM water_account WHERE id=ANY($1::uuid[]) ORDER BY pending_caliber`,
      [acctIds])).rows.map((r) => r.pending_caliber);
    expect(calibers).toEqual(['DN15', 'DN15', 'DN20']);

    const ret = await post('/install/applications/deallocate',
      { accountIds: [acctIds[0]], reason: 'test return' }).expect(201);
    expect(ret.body.returned).toHaveLength(1);
    const st = (await owner.query(
      `SELECT status, return_reason FROM water_account WHERE id=$1`, [acctIds[0]])).rows[0];
    expect(st.status).toBe('RETURNED');
    const tk = (await owner.query(
      `SELECT status FROM task WHERE biz_id=$1 AND type='ACCOUNT_ACTIVATE'`, [acctIds[0]])).rows[0];
    expect(tk.status).toBe('CANCELLED');
    expect((await post('/install/applications/deallocate',
      { accountIds: [acctIds[1]] })).body.code).toBe('RETURN_REASON_REQUIRED');
    expect((await post('/install/applications/deallocate',
      { accountIds: [acctIds[0]], reason: 'x' })).body.code).toBe('RETURN_NOT_ALLOWED');
  });

  it('已激活户禁止退号', async () => {
    const wa = await onboard('A4');
    const r = await post('/install/applications/deallocate', { accountIds: [wa], reason: 'x' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('RETURN_NOT_ALLOWED');
  });

  it('安装明细数 < 放号数 → 409 QTY_EXCEEDS_INSTALLED', async () => {
    const appId2 = await mkApp(2);
    await post(`/install/applications/${appId2}/install-meters`, {
      meters: [{ meterNo: `T9M-${RUN}-1` }],
    }).expect(201);
    const r = await post(`/install/applications/${appId2}/allocate`,
      { meterQty: 2, readerId: STAFF_READER_A });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('QTY_EXCEEDS_INSTALLED');
    const ok = await post(`/install/applications/${appId2}/allocate`,
      { meterQty: 1, readerId: STAFF_READER_A }).expect(201);
    expect(ok.body.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// A5 权限负测 + 跨租户隔离
// ---------------------------------------------------------------------------
describe('A5 permission negatives', () => {
  it('metering:read 只读建区号绑定 → 403', async () => {
    const r = await post('/reading-zones', { zoneNo: ZN1, readerId: STAFF_READER_A }, viewerToken);
    expect(r.status).toBe(403);
  });

  it('scoped writer 绑定子树外员工 → 400 READER_OUT_OF_SCOPE', async () => {
    const r = await post('/reading-zones', { zoneNo: ZN2, readerId: STAFF_READER_A }, writerToken);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('READER_OUT_OF_SCOPE');
  });

  it('scoped writer 应用覆盖组织外户的模式 → 400 PATTERN_OUT_OF_SCOPE', async () => {
    const pat = await post('/route-patterns', { zoneNo: Z2, name: `P-${RUN}` }).expect(201);
    const r = await post(`/route-patterns/${pat.body.id}/apply`, {}, writerToken);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('PATTERN_OUT_OF_SCOPE');
  });

  it('跨租户：B 租户读不到 A 的绑定；改 A 的绑定 → 404', async () => {
    const zones = await get('/reading-zones', tenantBToken);
    expect(zones.body.map((z: { zoneNo: string }) => z.zoneNo)).not.toContain(Z2);
    const a = (await get('/reading-zones')).body.find(
      (z: { zoneNo: string }) => z.zoneNo === Z2);
    const r = await patch(`/reading-zones/${a.id}`, { status: 'DISABLED' }, tenantBToken);
    expect(r.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Stage 2.1 P0 增补：日历真实天数 / 问题上报真实通道 / 模式全操作范围 / billable
// ---------------------------------------------------------------------------
describe('P0-1 monthWorkdays 真实天数', () => {
  it('2026-11 无例外=21 工作日，预留6→15 段', async () => {
    const r = await get('/metering/calendar?period=202611').expect(200);
    expect(r.body.reserveDays).toBe(6);
    expect(r.body.segments).toHaveLength(15);
    expect(r.body.segments[0].date).toBe('2026-11-02');
  });
  it('2027-02（28 天非闰）20 工作日', async () => {
    const r = await get('/metering/calendar?period=202702').expect(200);
    expect(r.body.segments).toHaveLength(14);
  });
  it('2028-02（闰年 29 天）21 工作日', async () => {
    const r = await get('/metering/calendar?period=202802').expect(200);
    expect(r.body.segments).toHaveLength(15);
  });
  it('2027-04（30 天）22 工作日', async () => {
    const r = await get('/metering/calendar?period=202704').expect(200);
    expect(r.body.segments).toHaveLength(16);
  });
  it('月末例外登记 29/30/31 日不被截断', async () => {
    await post('/metering/calendar', { day: '2027-01-29', kind: 'HOLIDAY' }).expect(201);
    await post('/metering/calendar', { day: '2027-01-30', kind: 'WORKDAY' }).expect(201);
    await post('/metering/calendar', { day: '2027-01-31', kind: 'HOLIDAY' }).expect(201);
    const r = await get('/metering/calendar?period=202701').expect(200);
    const byDay = Object.fromEntries(r.body.exceptions.map((x: {day:string;kind:string})=>[x.day,x.kind]));
    expect(byDay['2027-01-29']).toBe('HOLIDAY');
    expect(byDay['2027-01-30']).toBe('WORKDAY');
    expect(byDay['2027-01-31']).toBe('HOLIDAY');
  });
});

describe('P0-2 问题上报四类真实通道', () => {
  let waId = '';
  it('准备目标户', async () => {
    waId = await onboard('REPORT');
    await post('/meter-readings/does-not-matter', {}).catch(() => undefined);
  });
  it('FAULT/METER_GROUP_CLEANING/SITE_RECTIFICATION → 表务工单 201', async () => {
    for (const t of ['FAULT', 'METER_GROUP_CLEANING', 'SITE_RECTIFICATION']) {
      const r = await post('/service-orders', {
        waterAccountId: waId,
        serviceType: t,
        reason: `[现场上报] ${RUN} ${t}`,
        payload: { photoRefs: [`data:image/png;base64,T9-${t}`] },
      });
      expect(r.status).toBe(201);
      expect(r.body.serviceType).toBe(t);
      // 照片确实入库（payload.photoRefs 带出）
      const detail = await get(`/service-orders/${r.body.id}`).expect(200);
      expect(JSON.stringify(detail.body)).toContain(`T9-${t}`);
    }
  });
  it('未注册类型 REPLACE → 400 SERVICE_TYPE_INVALID', async () => {
    const r = await post('/service-orders', {
      waterAccountId: waId, serviceType: 'REPLACE', reason: 'x',
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('SERVICE_TYPE_INVALID');
  });
  it('VIOLATION → /violations 通道（FIELD 须描述+照片），非表务工单', async () => {
    const noPhoto = await post('/violations', {
      sourceType: 'FIELD', waterAccountId: waId, violationType: 'TAMPER',
      occurredDate: '2026-11-05', description: 'test',
    });
    expect(noPhoto.status).toBe(400);
    expect(noPhoto.body.code).toBe('VIOLATION_PHOTO_REQUIRED');
    const ok = await post('/violations', {
      sourceType: 'FIELD', waterAccountId: waId, violationType: 'TAMPER',
      occurredDate: '2026-11-05', description: `${RUN} 破坏计量`,
      photoRefs: ['data:image/png;base64,T9V'],
    });
    expect(ok.status).toBe(201);
    const list = await get('/violations').expect(200);
    const items = list.body.items ?? list.body;
    const row = items.find((x: { id: string }) => x.id === ok.body.id);
    expect(row).toBeTruthy();
    expect(row.sourceType).toBe('FIELD');
  });
  it('抄表员(writer 无 metering:service) FIELD 上报可行、稽查登记被拒', async () => {
    const ins = await post('/violations', {
      sourceType: 'INSPECT', waterAccountId: waId, violationType: 'TAMPER',
      occurredDate: '2026-11-05', description: 'x',
    }, writerToken);
    expect(ins.status).toBe(403);
    expect(ins.body.code).toBe('VIOLATION_INSPECT_ONLY');
  });
});

describe('P0-3 路线模式全操作组织范围', () => {
  it('scoped writer 读列表只见子树内区号模式；存/删/默认越区被拒', async () => {
    // 管理员在 Z2 建模式（之前 A5 用例已建，重新建一个确保存在）
    const pat = await post('/route-patterns', { zoneNo: Z2, name: `P3-${RUN}` }).expect(201);
    // scoped writer 列表不含 Z2 模式（Z2 户挂在 ORG_A 册）
    const listW = await get('/route-patterns', writerToken);
    expect(Array.isArray(listW.body)).toBe(true);
    const ids = listW.body.map((p: { id: string }) => p.id);
    expect(ids).not.toContain(pat.body.id);
    // 存：WRITER 子树外区号被拒
    const sv = await post('/route-patterns', { zoneNo: Z2, name: 'x' }, writerToken);
    expect(sv.status).toBe(400);
    expect(sv.body.code).toBe('PATTERN_ZONE_OUT_OF_SCOPE');
    // 设默认/删除：scoped 被拒
    expect((await post(`/route-patterns/${pat.body.id}/default`, {}, writerToken)).body.code)
      .toBe('PATTERN_ZONE_OUT_OF_SCOPE');
    const del = await request(app.getHttpServer())
      .delete(`/route-patterns/${pat.body.id}`).set(auth(writerToken));
    expect(del.body.code).toBe('PATTERN_ZONE_OUT_OF_SCOPE');
    // admin 全范围不受影响
    expect((await post(`/route-patterns/${pat.body.id}/default`, {})).status).toBe(201);
    expect((await request(app.getHttpServer())
      .delete(`/route-patterns/${pat.body.id}`).set(auth(adminToken))).status).toBe(200);
  });
});

describe('P0-4 billable 状态一致', () => {
  it('PENDING_ASSIGN→false / NORMAL→true / RETURNED→false / CLOSED 非监控→true', async () => {
    // 正常立户（NORMAL）：billable=true
    const normal = await onboard('BILL');
    const n = (await owner.query(`SELECT billable FROM water_account WHERE id=$1`, [normal])).rows[0];
    expect(n.billable).toBe(true);
    // 放号（PENDING_ASSIGN）：false
    const appRes = await post('/install/applications', {
      applicantName: `T9B ${RUN}`, addr: 'B Rd', usageCategory: 'RES_METERED', meterQty: 1,
    }).expect(201);
    for (const to of ['SURVEYED', 'APPROVED']) {
      await post(`/install/applications/${appRes.body.id}/transition`, { to }).expect(201);
    }
    await post(`/install/applications/${appRes.body.id}/transition`,
      { to: 'INSTALLING', installCompletedAt: '2026-11-01' }).expect(201);
    const alloc = await post(`/install/applications/${appRes.body.id}/allocate`,
      { meterQty: 1, readerId: STAFF_READER_A }).expect(201);
    const waId = alloc.body.accounts[0].id;
    const pa = (await owner.query(`SELECT status,billable FROM water_account WHERE id=$1`, [waId])).rows[0];
    expect(pa.status).toBe('PENDING_ASSIGN');
    expect(pa.billable).toBe(false);
    // 退号（RETURNED）：false
    await post('/install/applications/deallocate', { accountIds: [waId], reason: 'r' }).expect(201);
    const ret = (await owner.query(`SELECT status,billable FROM water_account WHERE id=$1`, [waId])).rows[0];
    expect(ret.status).toBe('RETURNED');
    expect(ret.billable).toBe(false);
    // CLOSED（经状态机）：billable 保持类别推导值（CHECK 允许）；先拆表才能销户
    const closeMe = await onboard('CLOSEM');
    const inst = (await owner.query(
      `SELECT id FROM meter_installation WHERE water_account_id=$1 AND status='ACTIVE'`,
      [closeMe])).rows[0];
    await post(`/meter-installations/${inst.id}/remove`, {
      finalReading: 0, removedAt: '2026-11-06', reason: 'close test',
    }).expect(201);
    const cl = await post(`/water-accounts/${closeMe}/close`,
      { effectiveDate: '2026-11-06' });
    expect(cl.status).toBe(201);
    const c = (await owner.query(`SELECT status,billable FROM water_account WHERE id=$1`, [closeMe])).rows[0];
    expect(c.status).toBe('CLOSED');
    expect(c.billable).toBe(true);
    // 普通编辑不得改 status（状态机保护）
    const bypass = await patch(`/water-accounts/${closeMe}`, { status: 'NORMAL' });
    const after = (await owner.query(`SELECT status FROM water_account WHERE id=$1`, [closeMe])).rows[0];
    expect(after.status).toBe('CLOSED');
  });
});
