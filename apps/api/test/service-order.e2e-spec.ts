/**
 * 表务工单 e2e (20261019 整合需求 T1-T6, T12) against `watersaas_test`.
 * Fixtures carry the `sgo-` prefix. Boots the real AppModule so JWT /
 * permission guards, tenant ALS and RLS all apply.
 *
 * Covers:
 *  1. Full flow: create (SVC_APPROVAL task) → approve (task DONE) →
 *     dispatch (SVC_EXECUTE task) → execute (PERIODIC_CHECK writes
 *     AccountEvent METER_CHECK + meter.lastCheckDate 回写) → archive.
 *  2. tenant_param meterService.requireApproval=false → create lands
 *     APPROVED directly.
 *  3. FAULT execute → replaceTx 三要素分段 (old inst REMOVED + final,
 *     new inst ACTIVE + initial, linkRef populated).
 *  4. SUSPEND/RESUME execute → water_account status flip; execute replay
 *     is a no-op (no double SUSPEND event).
 *  5. CLOSE execute：录拆除止码 → removeTx 拆表 + 销户同事务；缺止码
 *     → 400 CLOSE_FINAL_READING_REQUIRED，工单停 DISPATCHED。
 *  6. Transition guards: dispatch before approve, execute before
 *     dispatch, archive before execute → 409.
 *  7. REJECTED / CANCELLED terminal states.
 *  8. Permissions: staff without metering:service → 403; tenant-B admin
 *     sees nothing of tenant-A orders.
 *  9. meter-lifecycle timeline endpoint.
 * 10. T4 scan-check-due 到期检定自动建单（幂等）；T5 来源字段 +
 *     建单自动挂最新在装表位。
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
process.env.MIGRATION_DATABASE_URL =
  process.env.MIGRATION_DATABASE_URL_TEST ??
  'postgresql://postgres:postgres@localhost:5432/watersaas_test';

const TA = 'cc50cc50-cc50-4c05-8c05-cc50cc50cc50';
const TB = 'dd50dd50-dd50-4d05-8d05-dd50dd50dd50';
const ORG_A = 'cc50cc50-0000-4000-8000-0000000000c0';
const ORG_B = 'dd50dd50-0000-4000-8000-0000000000c0';
const ROLE_ADMIN_A = 'cc50cc50-0000-4000-8000-00000000ad01';
const ROLE_LIMITED = 'cc50cc50-0000-4000-8000-00000000ad02';
const ROLE_ADMIN_B = 'dd50dd50-0000-4000-8000-00000000ad01';
const PERM_CUST_READ = 'cc50cc50-0000-4000-8000-00000000e601';
const STAFF_ADMIN_A = 'cc50cc50-0000-4000-8000-0000000a0001';
const STAFF_LIMITED = 'cc50cc50-0000-4000-8000-0000000a0002';
const STAFF_ADMIN_B = 'dd50dd50-0000-4000-8000-0000000a0001';

const owner = new pg.Client({
  connectionString: process.env.MIGRATION_DATABASE_URL,
});
let app: INestApplication<App>;
let adminToken = '';
let limitedToken = '';
let adminBToken = '';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

const post = (path: string, body: unknown, token = adminToken) =>
  request(app.getHttpServer()).post(path).set(auth(token)).send(body);
const get = (path: string, token = adminToken) =>
  request(app.getHttpServer()).get(path).set(auth(token));

const onboard = async (tag: string) => {
  const res = await post('/water-accounts/onboard', {
    customer: { name: `SGO ${tag} ${RUN}`, custType: 'PERSONAL' },
    account: { usageCategory: 'RES_METERED', addr: `${tag} service rd` },
    meter: { brand: 'sgo-brand', caliber: 'DN15' },
    installation: { initialReading: 0, installedAt: '2026-01-01' },
  }).expect(201);
  return res.body as {
    waterAccount: { id: string };
    meter: { id: string };
    installation: { id: string; meterId: string };
  };
};

const newMeter = async () =>
  (await post('/meters', { brand: 'sgo-spare', caliber: 'DN15' }).expect(201)).body as {
    id: string;
  };

const createOrder = (body: Record<string, unknown>, token = adminToken) =>
  post('/service-orders', body, token);

const accountStatus = async (id: string) =>
  (
    await owner.query(
      `SELECT status::text AS s FROM water_account WHERE tenant_id = $1 AND id = $2`,
      [TA, id],
    )
  ).rows[0].s as string;

beforeAll(async () => {
  await owner.connect();
  const hash = await bcrypt.hash('sgo-pass', 10);
  await owner.query(
    `INSERT INTO tenant (id, code, name, status, created_at, updated_at)
     VALUES ($1, 'sgo-water', 'SGO Water', 'ACTIVE', now(), now()),
            ($2, 'sgo-other', 'SGO Other', 'ACTIVE', now(), now())
     ON CONFLICT DO NOTHING`,
    [TA, TB],
  );
  await owner.query(
    `INSERT INTO org_unit (id, tenant_id, parent_id, name, type, created_at, updated_at)
     VALUES ($1, $2, NULL, 'SGO Company', 'COMPANY', now(), now()),
            ($3, $4, NULL, 'SGOB Company', 'COMPANY', now(), now())
     ON CONFLICT DO NOTHING`,
    [ORG_A, TA, ORG_B, TB],
  );
  await owner.query(
    `INSERT INTO role (id, tenant_id, code, name, data_scope, created_at, updated_at)
     VALUES ($1, $3, 'admin', 'SGO Admin', 'ALL', now(), now()),
            ($2, $3, 'sgo-limited', 'SGO Limited', 'ALL', now(), now()),
            ($4, $5, 'admin', 'SGOB Admin', 'ALL', now(), now())
     ON CONFLICT DO NOTHING`,
    [ROLE_ADMIN_A, ROLE_LIMITED, TA, ROLE_ADMIN_B, TB],
  );
  // limited role: customer:read only — no metering:service.
  await owner.query(
    `INSERT INTO permission (id, tenant_id, code, type, created_at, updated_at)
     VALUES ($1, $2, 'customer:read', 'ACTION', now(), now())
     ON CONFLICT DO NOTHING`,
    [PERM_CUST_READ, TA],
  );
  await owner.query(
    `INSERT INTO role_permission (tenant_id, role_id, permission_id, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now()) ON CONFLICT DO NOTHING`,
    [TA, ROLE_LIMITED, PERM_CUST_READ],
  );
  await owner.query(
    `INSERT INTO staff (id, tenant_id, org_unit_id, login, password_hash, name, status, created_at, updated_at)
     VALUES ($1, $4, $6, 'sgo-admin',   $7, 'SGO Admin',   'ACTIVE', now(), now()),
            ($2, $4, $6, 'sgo-limited', $7, 'SGO Limited', 'ACTIVE', now(), now()),
            ($3, $5, $8, 'sgob-admin',  $7, 'SGOB Admin',  'ACTIVE', now(), now())
     ON CONFLICT (tenant_id, login) DO NOTHING`,
    [STAFF_ADMIN_A, STAFF_LIMITED, STAFF_ADMIN_B, TA, TB, ORG_A, hash, ORG_B],
  );
  await owner.query(
    `INSERT INTO staff_role (tenant_id, staff_id, role_id, created_at, updated_at)
     VALUES ($1, $2, $4, now(), now()),
            ($1, $3, $5, now(), now()),
            ($6, $7, $8, now(), now())
     ON CONFLICT DO NOTHING`,
    [TA, STAFF_ADMIN_A, STAFF_LIMITED, ROLE_ADMIN_A, ROLE_LIMITED,
     TB, STAFF_ADMIN_B, ROLE_ADMIN_B],
  );

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleFixture.createNestApplication();
  await app.init();

  const login = async (tenantCode: string, login_: string) =>
    (
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ tenantCode, login: login_, password: 'sgo-pass' })
        .expect(201)
    ).body.accessToken as string;
  adminToken = await login('sgo-water', 'sgo-admin');
  limitedToken = await login('sgo-water', 'sgo-limited');
  adminBToken = await login('sgo-other', 'sgob-admin');
});

afterAll(async () => {
  await owner.query(`DELETE FROM tenant_param WHERE tenant_id = $1 AND key = 'meterService.requireApproval'`, [TA]);
  await app.close();
  await owner.end();
});

describe('表务工单全流程', () => {
  it('create → approve → dispatch(Task) → execute(METER_CHECK) → archive；任务双节点联动', async () => {
    const a = await onboard('flow');
    const created = await createOrder({
      waterAccountId: a.waterAccount.id,
      serviceType: 'PERIODIC_CHECK',
      reason: '周期校验',
      meterInstallationId: a.installation.id,
    }).expect(201);
    const id = created.body.id as string;
    expect(created.body.orderNo).toMatch(/^SG\d{12}$/);
    expect(created.body.status).toBe('PENDING_APPROVAL');
    // 只传表位 → meterId 自动带出；详情给目标表具档案
    expect(created.body.meterId).toBe(a.meter.id);
    const detail = (await get(`/service-orders/${id}`)).body;
    expect(detail.targetMeter?.id).toBe(a.meter.id);
    expect(detail.installation?.id).toBe(a.installation.id);

    // T2：申请即建 SVC_APPROVAL 待办任务
    const approvalTask = (
      await owner.query(
        `SELECT type, status::text AS status FROM task
         WHERE tenant_id = $1 AND biz_type = 'service_order' AND biz_id = $2 AND type = 'SVC_APPROVAL'`,
        [TA, id],
      )
    ).rows[0];
    expect(approvalTask?.status).toBe('PENDING');

    // 守卫：未审批不能派单/执行
    await post(`/service-orders/${id}/dispatch`, {}).expect(409);
    await post(`/service-orders/${id}/execute`, {}).expect(409);

    const approved = await post(`/service-orders/${id}/approve`, { note: 'ok' }).expect(201);
    expect(approved.body.status).toBe('APPROVED');

    // 审批通过 → 审批任务完结
    const afterApprove = (
      await owner.query(
        `SELECT status::text AS status FROM task
         WHERE tenant_id = $1 AND biz_type = 'service_order' AND biz_id = $2 AND type = 'SVC_APPROVAL'`,
        [TA, id],
      )
    ).rows[0];
    expect(afterApprove.status).toBe('DONE');

    const dispatched = await post(`/service-orders/${id}/dispatch`, {
      assigneeId: STAFF_ADMIN_A,
    }).expect(201);
    expect(dispatched.body.status).toBe('DISPATCHED');
    expect(dispatched.body.taskId).toBeTruthy();

    // 派单自动建了 SVC_EXECUTE 任务
    const task = (
      await owner.query(
        `SELECT type, biz_type, status::text AS status FROM task WHERE tenant_id = $1 AND id = $2`,
        [TA, dispatched.body.taskId],
      )
    ).rows[0];
    expect(task.type).toBe('SVC_EXECUTE');
    expect(task.biz_type).toBe('service_order');

    // 守卫：未派单不能归档
    const pre = await post(`/service-orders/${id}/archive`, {});
    // archive only allowed from EXECUTED → 409
    expect(pre.status).toBe(409);

    const executed = await post(`/service-orders/${id}/execute`, {
      resultNote: '校验合格',
      payload: {
        checkOrg: '市计量院',
        checkDate: '2026-10-19',
        checkResult: 'PASS',
        checkError: '+0.8',
        certNo: 'CERT-2026-001',
        photoRefs: ['site-photo-1'],
      },
    }).expect(201);
    expect(executed.body.status).toBe('EXECUTED');
    expect(executed.body.linkRef.accountEventId).toBeTruthy();
    expect(executed.body.linkRef.photoRefs).toEqual(['site-photo-1']);

    // 执行任务完结
    const afterExec = (
      await owner.query(
        `SELECT status::text AS status FROM task
         WHERE tenant_id = $1 AND biz_type = 'service_order' AND biz_id = $2 AND type = 'SVC_EXECUTE'`,
        [TA, id],
      )
    ).rows[0];
    expect(afterExec.status).toBe('DONE');

    // 检定档案留痕（机构/证书/误差全量入 payload）
    const ev = (
      await owner.query(
        `SELECT type::text AS type, payload FROM account_event WHERE tenant_id = $1 AND id = $2`,
        [TA, executed.body.linkRef.accountEventId],
      )
    ).rows[0];
    expect(ev.type).toBe('METER_CHECK');
    expect(ev.payload.checkOrg).toBe('市计量院');
    expect(ev.payload.certNo).toBe('CERT-2026-001');

    // 检定日期回写表具档案 → 驱动下次到期扫描
    const meter = (
      await owner.query(
        `SELECT last_check_date::text AS lcd, check_period_years AS cpy FROM meter
         WHERE tenant_id = $1 AND id = $2`,
        [TA, a.meter.id],
      )
    ).rows[0];
    expect(meter.lcd.slice(0, 10)).toBe('2026-10-19');
    expect(meter.cpy).toBe(6); // DN15 → 6 年自动带入

    // 重放安全：重复 execute 返回同一行，不再产生域动作
    const replay = await post(`/service-orders/${id}/execute`, { resultNote: 'x' }).expect(201);
    expect(replay.body.status).toBe('EXECUTED');
    const evCount = (
      await owner.query(
        `SELECT count(*)::int AS n FROM account_event WHERE tenant_id = $1 AND water_account_id = $2 AND type = 'METER_CHECK'`,
        [TA, a.waterAccount.id],
      )
    ).rows[0].n;
    expect(evCount).toBe(1);

    const archived = await post(`/service-orders/${id}/archive`, {}).expect(201);
    expect(archived.body.status).toBe('ARCHIVED');
    // 终态后所有迁移被拒
    await post(`/service-orders/${id}/cancel`, {}).expect(409);
  });

  it('requireApproval=false → 申请即 APPROVED', async () => {
    await owner.query(
      `INSERT INTO tenant_param (tenant_id, key, value, created_at, updated_at)
       VALUES ($1, 'meterService.requireApproval', 'false'::jsonb, now(), now())
       ON CONFLICT (tenant_id, key) DO UPDATE SET value = 'false'::jsonb`,
      [TA],
    );
    const a = await onboard('noapprove');
    const res = await createOrder({
      waterAccountId: a.waterAccount.id,
      serviceType: 'METER_GROUP_CLEANING',
    }).expect(201);
    expect(res.body.status).toBe('APPROVED');
    await owner.query(`DELETE FROM tenant_param WHERE tenant_id = $1 AND key = 'meterService.requireApproval'`, [TA]);
  });

  it('FAULT 执行 → 换表三要素分段 + linkRef', async () => {
    const a = await onboard('fault');
    const m2 = await newMeter();
    const created = await createOrder({
      waterAccountId: a.waterAccount.id,
      serviceType: 'FAULT',
      meterInstallationId: a.installation.id,
      reason: '表不走',
    }).expect(201);
    const id = created.body.id as string;
    await post(`/service-orders/${id}/approve`, {}).expect(201);
    await post(`/service-orders/${id}/dispatch`, {}).expect(201);

    // 缺三要素 → 400 REPLACE_FIELDS_REQUIRED
    await post(`/service-orders/${id}/execute`, { payload: { newMeterId: m2.id } }).expect(400);

    const executed = await post(`/service-orders/${id}/execute`, {
      resultNote: '已换表',
      payload: {
        newMeterId: m2.id,
        oldFinalReading: 100,
        newInitialReading: 5,
        replacedAt: '2026-10-19',
      },
    }).expect(201);
    expect(executed.body.status).toBe('EXECUTED');
    expect(executed.body.linkRef.newInstallationId).toBeTruthy();

    const inst = (
      await owner.query(
        `SELECT status::text AS s, final_reading::text AS fr FROM meter_installation
         WHERE tenant_id = $1 AND id = $2`,
        [TA, a.installation.id],
      )
    ).rows[0];
    expect(inst.s).toBe('REMOVED');
    expect(Number(inst.fr)).toBe(100);
    const newInst = (
      await owner.query(
        `SELECT status::text AS s, initial_reading::text AS ir FROM meter_installation
         WHERE tenant_id = $1 AND id = $2`,
        [TA, executed.body.linkRef.newInstallationId],
      )
    ).rows[0];
    expect(newInst.s).toBe('ACTIVE');
    expect(Number(newInst.ir)).toBe(5);
  });

  it('SUSPEND 执行 → 户状态 SUSPENDED；RESUME 恢复', async () => {
    const a = await onboard('suspend');
    const suspend = await createOrder({
      waterAccountId: a.waterAccount.id,
      serviceType: 'SUSPEND',
      reason: '报停',
    }).expect(201);
    const sid = suspend.body.id as string;
    await post(`/service-orders/${sid}/approve`, {}).expect(201);
    await post(`/service-orders/${sid}/dispatch`, {}).expect(201);
    await post(`/service-orders/${sid}/execute`, { payload: {} }).expect(201);
    expect(await accountStatus(a.waterAccount.id)).toBe('SUSPENDED');

    const resume = await createOrder({
      waterAccountId: a.waterAccount.id,
      serviceType: 'RESUME',
      reason: '复水',
    }).expect(201);
    const rid = resume.body.id as string;
    await post(`/service-orders/${rid}/approve`, {}).expect(201);
    await post(`/service-orders/${rid}/dispatch`, {}).expect(201);
    await post(`/service-orders/${rid}/execute`, { payload: {} }).expect(201);
    expect(await accountStatus(a.waterAccount.id)).toBe('NORMAL');
  });

  it('CLOSE 执行：录拆除止码 → 拆表 + 销户同事务；缺止码 400', async () => {
    const a = await onboard('close');
    const created = await createOrder({
      waterAccountId: a.waterAccount.id,
      serviceType: 'CLOSE',
      reason: '销户',
    }).expect(201);
    const id = created.body.id as string;
    await post(`/service-orders/${id}/approve`, {}).expect(201);
    await post(`/service-orders/${id}/dispatch`, {}).expect(201);

    // 未录拆除读数 → 400，工单停 DISPATCHED
    const bad = await post(`/service-orders/${id}/execute`, { payload: {} });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('CLOSE_FINAL_READING_REQUIRED');
    expect((await get(`/service-orders/${id}`)).body.status).toBe('DISPATCHED');

    // 录拆除止码 → removeTx 拆表 + CloseAccountUseCase 销户，同一事务
    const executed = await post(`/service-orders/${id}/execute`, {
      payload: { finalReading: 66, removedAt: '2026-10-20' },
    }).expect(201);
    expect(executed.body.status).toBe('EXECUTED');
    expect(executed.body.linkRef.waterAccountStatus).toBe('CLOSED');
    expect(await accountStatus(a.waterAccount.id)).toBe('CLOSED');
    const inst = (
      await owner.query(
        `SELECT status::text AS s, final_reading::text AS fr FROM meter_installation
         WHERE tenant_id = $1 AND id = $2`,
        [TA, a.installation.id],
      )
    ).rows[0];
    expect(inst.s).toBe('REMOVED');
    expect(Number(inst.fr)).toBe(66);
    // 拆表后表具回库可再装
    const m = (
      await owner.query(
        `SELECT status::text AS s FROM meter WHERE tenant_id = $1 AND id = $2`,
        [TA, a.meter.id],
      )
    ).rows[0];
    expect(m.s).toBe('AVAILABLE');
  });

  it('REJECTED / CANCELLED 终态', async () => {
    const a = await onboard('term');
    const r = await createOrder({
      waterAccountId: a.waterAccount.id,
      serviceType: 'DISPUTE_CHECK',
    }).expect(201);
    const rejected = await post(`/service-orders/${r.body.id}/reject`, { note: '不批' }).expect(201);
    expect(rejected.body.status).toBe('REJECTED');
    await post(`/service-orders/${r.body.id}/dispatch`, {}).expect(409);

    const c = await createOrder({
      waterAccountId: a.waterAccount.id,
      serviceType: 'SITE_RECTIFICATION',
    }).expect(201);
    await post(`/service-orders/${c.body.id}/approve`, {}).expect(201);
    const cancelled = await post(`/service-orders/${c.body.id}/cancel`, { reason: '用户取消' }).expect(201);
    expect(cancelled.body.status).toBe('CANCELLED');
  });

  it('权限：无 metering:service → 403；跨租户不可见', async () => {
    const a = await onboard('perm');
    await createOrder({ waterAccountId: a.waterAccount.id, serviceType: 'FAULT' }, limitedToken).expect(403);
    await get('/service-orders', limitedToken).expect(403);
    const mine = await createOrder({
      waterAccountId: a.waterAccount.id,
      serviceType: 'FLOW_LIMIT',
    }).expect(201);
    await get(`/service-orders/${mine.body.id}`, adminBToken).expect(404);
    const bList = (await get('/service-orders', adminBToken)).body;
    expect(bList.items.find((o: { id: string }) => o.id === mine.body.id)).toBeUndefined();
  });

  it('无效 serviceType → 400；不存在户 → 404', async () => {
    const a = await onboard('badtype');
    await createOrder({ waterAccountId: a.waterAccount.id, serviceType: 'NOPE' }).expect(400);
    await createOrder({
      waterAccountId: '00000000-0000-4000-8000-000000000000',
      serviceType: 'FAULT',
    }).expect(404);
  });

  it('meter-lifecycle：时间线含安装/工单/账户事件', async () => {
    const a = await onboard('life');
    const created = await createOrder({
      waterAccountId: a.waterAccount.id,
      serviceType: 'PERIODIC_CHECK',
    }).expect(201);
    const id = created.body.id as string;
    await post(`/service-orders/${id}/approve`, {}).expect(201);
    await post(`/service-orders/${id}/dispatch`, {}).expect(201);
    await post(`/service-orders/${id}/execute`, { payload: { checkResult: 'PASS' } }).expect(201);

    const res = await get(`/service-orders/meter-lifecycle/${a.waterAccount.id}`).expect(200);
    const kinds = res.body.timeline.map((t: { kind: string }) => t.kind);
    expect(kinds).toContain('INSTALL');
    expect(kinds).toContain('SERVICE_ORDER');
    expect(kinds).toContain('ACCOUNT_EVENT');
    expect(res.body.orders.find((o: { id: string }) => o.id === id)).toBeTruthy();
  });

  it('T11 stats：类型×状态分布 + 处置时长；T12 replace-records：换表明细配对', async () => {
    const a = await onboard('stats');
    const m2 = await newMeter();
    const created = await createOrder({
      waterAccountId: a.waterAccount.id,
      serviceType: 'FAULT',
      meterInstallationId: a.installation.id,
    }).expect(201);
    const id = created.body.id as string;
    await post(`/service-orders/${id}/approve`, {}).expect(201);
    await post(`/service-orders/${id}/dispatch`, {}).expect(201);
    await post(`/service-orders/${id}/execute`, {
      payload: { newMeterId: m2.id, oldFinalReading: 88, newInitialReading: 0 },
    }).expect(201);

    const stats = (await get('/service-orders/stats')).body as {
      slaHours: number;
      byTypeStatus: { service_type: string; status: string; n: string }[];
      durations: { service_type: string; done: string }[];
    };
    expect(stats.slaHours).toBe(72);
    const faultRow = stats.byTypeStatus.find(
      (r) => r.service_type === 'FAULT' && r.status === 'EXECUTED',
    );
    expect(faultRow).toBeTruthy();
    expect(stats.durations.find((d) => d.service_type === 'FAULT')).toBeTruthy();

    const rr = (await get('/service-orders/replace-records')).body as {
      items: {
        removedInstallationId: string;
        oldMeter: { finalReading: string };
        newMeter: { installationId: string; initialReading: string } | null;
      }[];
    };
    const rec = rr.items.find((i) => i.removedInstallationId === a.installation.id);
    expect(rec).toBeTruthy();
    expect(Number(rec!.oldMeter.finalReading)).toBe(88);
    expect(rec!.newMeter).toBeTruthy();
    expect(Number(rec!.newMeter!.initialReading)).toBe(0);
  });

  it('T4 scan-check-due：到期检定自动生成工单+审批任务，幂等不重复', async () => {
    const a = await onboard('due');
    // DN15 → 6 年；上次检定 2020-01 → 下次 2026-01，今天已到期
    await owner.query(
      `UPDATE meter SET last_check_date = '2020-01-15', check_period_years = 6
       WHERE tenant_id = $1 AND id = $2`,
      [TA, a.meter.id],
    );
    const scan = (
      await post('/service-orders/scan-check-due', { leadDays: 30 }).expect(201)
    ).body as {
      scanned: number;
      created: { orderId: string; meterNo: string; waterAccountId: string }[];
    };
    const mine = scan.created.find((c) => c.waterAccountId === a.waterAccount.id);
    expect(mine).toBeTruthy();
    const order = (await get(`/service-orders/${mine!.orderId}`)).body;
    expect(order.serviceType).toBe('PERIODIC_CHECK');
    expect(order.sourceType).toBe('AUTO_CHECK');
    expect(order.meterId).toBe(a.meter.id);
    expect(order.meterInstallationId).toBe(a.installation.id);
    expect(order.status).toBe('PENDING_APPROVAL');
    // 到期工单也进审批待办
    const t = (
      await owner.query(
        `SELECT count(*)::int AS n FROM task
         WHERE tenant_id = $1 AND biz_type = 'service_order' AND biz_id = $2 AND type = 'SVC_APPROVAL'`,
        [TA, order.id],
      )
    ).rows[0].n;
    expect(t).toBe(1);

    // 重复扫描：同表存在未完结检定工单 → 不再建
    const scan2 = (
      await post('/service-orders/scan-check-due', { leadDays: 30 }).expect(201)
    ).body as { created: unknown[] };
    expect(scan2.created.find((c) => (c as { orderId: string }).orderId === order.id)).toBeUndefined();

    // 无检定属性的表不生成
    const b = await onboard('nodue');
    const scan3 = (
      await post('/service-orders/scan-check-due', { leadDays: 30 }).expect(201)
    ).body as { created: { waterAccountId: string }[] };
    // onboard 新表口径 DN15 自动带入 6 年但无 lastCheckDate → 不生成
    expect(scan3.created.every((c) => c.waterAccountId !== b.waterAccount.id)).toBe(true);
  });

  it('T5 READING_REPORT 来源 + 建单自动挂最新在装表位', async () => {
    const a = await onboard('report');
    // 不传表位/表号（抄表上报场景）→ 自动解析 ACTIVE 安装行
    const created = await createOrder({
      waterAccountId: a.waterAccount.id,
      serviceType: 'FAULT',
      reason: '现场表不走',
      sourceType: 'READING_REPORT',
      photoRefs: ['data:image/jpeg;base64,x'],
    }).expect(201);
    expect(created.body.sourceType).toBe('READING_REPORT');
    expect(created.body.meterInstallationId).toBe(a.installation.id);
    expect(created.body.meterId).toBe(a.meter.id);
    expect(created.body.payload.photoRefs).toEqual(['data:image/jpeg;base64,x']);

    // 非法/跨户读数引用 → 400
    await createOrder({
      waterAccountId: a.waterAccount.id,
      serviceType: 'FAULT',
      sourceType: 'READING_REPORT',
      sourceReadingId: '00000000-0000-4000-8000-000000000000',
    }).expect(400);
  });
});
