/**
 * 违章用水 e2e (20261021 整改 任务E) against `watersaas_test`。
 * 独立租户 vio-water。
 * Covers:
 *  1. 稽查登记 → PROCESSING + VIOLATION_HANDLE 任务派发。
 *  2. 抄表上报（meter_readings/:id/report-violation）→ PENDING_REVIEW；
 *     核实确认 → PROCESSING；误报 → DISMISSED + 任务关闭。
 *  3. 处理录罚款/补缴 → PROCESSED；归档缺佐证 400，补齐全 → ARCHIVED。
 *  4. 违章类型字典生效（非法类型 400）。
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

const TA = 'bb60bb60-bb60-4b06-8b06-bb60bb60bb60';
const ORG = 'bb60bb60-0000-4000-8000-0000000000c0';
const ROLE = 'bb60bb60-0000-4000-8000-00000000ad01';
const STAFF = 'bb60bb60-0000-4000-8000-0000000a0001';

const owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
let app: INestApplication<App>;
let adminToken = '';
const auth = () => ({ Authorization: `Bearer ${adminToken}` });
const RUN = `v${Date.now().toString(36)}`;

const post = (p: string, b: unknown) =>
  request(app.getHttpServer()).post(p).set(auth()).send(b);

beforeAll(async () => {
  await owner.connect();
  const hash = await bcrypt.hash('vio-pass', 10);
  await owner.query(
    `INSERT INTO tenant (id, code, name, status, created_at, updated_at)
     VALUES ($1, 'vio-water', 'VIO Water', 'ACTIVE', now(), now()) ON CONFLICT DO NOTHING`,
    [TA],
  );
  await owner.query(
    `INSERT INTO org_unit (id, tenant_id, parent_id, name, type, created_at, updated_at)
     VALUES ($1, $2, NULL, 'VIO Co', 'COMPANY', now(), now()) ON CONFLICT DO NOTHING`,
    [ORG, TA],
  );
  await owner.query(
    `INSERT INTO role (id, tenant_id, code, name, data_scope, created_at, updated_at)
     VALUES ($1, $2, 'admin', 'VIO Admin', 'ALL', now(), now())
     ON CONFLICT (tenant_id, code) DO NOTHING`,
    [ROLE, TA],
  );
  await owner.query(
    `INSERT INTO staff (id, tenant_id, org_unit_id, login, password_hash, name, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'vio-admin', $4, 'VIO Admin', 'ACTIVE', now(), now())
     ON CONFLICT (tenant_id, login) DO NOTHING`,
    [STAFF, TA, ORG, hash],
  );
  await owner.query(
    `INSERT INTO staff_role (tenant_id, staff_id, role_id, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now()) ON CONFLICT DO NOTHING`,
    [TA, STAFF, ROLE],
  );
  // 违章字典 + 任务类型字典（迁移里按现有租户种入；本租户在迁移后创建则需补种）
  await owner.query(
    `INSERT INTO sys_dict (id, tenant_id, category, code, name, seq, status, created_at, updated_at)
     SELECT gen_random_uuid(), $1, 'VIOLATION_TYPE', c.code, c.name, c.seq, 'ACTIVE', now(), now()
     FROM (VALUES ('THEFT','盗窃用水',10),('PRIVATE_CONN','私自接水',20),
                  ('TAMPER','破坏表计',30),('SEAL_BROKEN','破坏铅封',40),
                  ('CATEGORY_MISUSE','擅自改变用水性质',50)) c(code,name,seq)
     ON CONFLICT DO NOTHING`,
    [TA],
  );
  await owner.query(
    `INSERT INTO sys_dict (id, tenant_id, category, code, name, value, seq, status, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, 'TASK_TYPE_PERM', 'VIOLATION_HANDLE', '违章处置',
             '{"perm":"metering:service","dueDays":3,"priority":"HIGH"}'::jsonb, 90, 'ACTIVE', now(), now())
     ON CONFLICT DO NOTHING`,
    [TA],
  );

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleFixture.createNestApplication();
  await app.init();
  adminToken = (
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantCode: 'vio-water', login: 'vio-admin', password: 'vio-pass' })
      .expect(201)
  ).body.accessToken as string;
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

const mkAccount = async (tag: string) =>
  (
    await post('/water-accounts/onboard', {
      customer: { name: `VIO ${tag} ${RUN}`, custType: 'PERSONAL' },
      account: { usageCategory: 'RES_METERED', addr: `${tag} vio rd` },
      meter: { brand: 'vio', caliber: 'DN15' },
      installation: { initialReading: 0, installedAt: '2026-01-01' },
    }).expect(201)
  ).body as {
    waterAccount: { id: string };
    meter: { id: string };
    installation: { id: string };
  };

const mkReading = async (instId: string, meterId: string) => {
  const r = await owner.query(
    `INSERT INTO meter_reading
       (id, tenant_id, installation_id, meter_id, period, read_date, result_type,
        reading_value, qc_status, source, operator_id, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, '202610', '2026-10-20', 'ACTUAL',
             100, 'PENDING', 'APP', $4, now(), now())
     RETURNING id`,
    [TA, instId, meterId, STAFF],
  );
  return r.rows[0].id as string;
};

describe('任务E 违章用水', () => {
  it('稽查登记→PROCESSING+任务；处理→PROCESSED；归档佐证强制', async () => {
    const acc = await mkAccount('insp');
    // 非法类型 → 400
    await post('/violations', {
      waterAccountId: acc.waterAccount.id,
      violationType: 'NOPE',
      description: 'x',
    }).expect(400);

    const v = await post('/violations', {
      waterAccountId: acc.waterAccount.id,
      violationType: 'TAMPER',
      occurredDate: '2026-10-20',
      description: '表具玻璃被撬',
      photoRefs: ['p://v1'],
    }).expect(201);
    expect(v.body.status).toBe('PROCESSING');
    // 任务已派发
    const task = (
      await owner.query(
        `SELECT type, status FROM task WHERE id = $1`,
        [v.body.taskId],
      )
    ).rows[0];
    expect(task.type).toBe('VIOLATION_HANDLE');
    expect(task.status).toBe('PENDING');

    // 处理：罚款 500 + 补缴 200
    const p = await post(`/violations/${v.body.id}/process`, {
      penaltyAmount: 500,
      backbillAmount: 200,
      note: '补缴历史漏计 + 罚款',
    }).expect(201);
    expect(p.body.status).toBe('PROCESSED');
    // 任务已关闭
    const task2 = (
      await owner.query(`SELECT status FROM task WHERE id = $1`, [v.body.taskId])
    ).rows[0];
    expect(task2.status).toBe('DONE');

    // 归档：缺佐证 400
    const denied = await post(`/violations/${v.body.id}/archive`, { evidence: {} });
    expect(denied.status).toBe(400);
    expect(denied.body.code ?? denied.body.message?.code).toBe('EVIDENCE_REQUIRED');
    // 补全 site+penaltyDoc → 归档
    await post(`/violations/${v.body.id}/archive`, {
      evidence: { site: ['p://site1'], penaltyDoc: ['p://doc1'] },
    }).expect(201);
  });

  it('抄表上报→PENDING_REVIEW；核实确认/误报', async () => {
    const acc = await mkAccount('read');
    const readingId = await mkReading(acc.installation.id, acc.meter.id);
    const v = await post(`/meter-readings/${readingId}/report-violation`, {
      violationType: 'SEAL_BROKEN',
      description: '铅封缺失',
      photoRefs: ['p://seal'],
    });
    if (v.status !== 201) console.log('VIO-DBG', v.status, JSON.stringify(v.body));
    expect(v.body.status).toBe('PENDING_REVIEW');
    expect(v.body.sourceType).toBe('READING');
    expect(v.body.sourceId).toBe(readingId);

    // 核实：属实 → PROCESSING
    const v2 = await post(`/violations/${v.body.id}/verify`, { confirm: true, note: '现场确认' });
    expect(v2.body.status).toBe('PROCESSING');

    // 另一条误报路径
    const r2 = await mkReading(acc.installation.id, acc.meter.id);
    const v3 = await post(`/meter-readings/${r2}/report-violation`, {
      violationType: 'THEFT',
      description: '读数异常疑似偷水',
    }).expect(201);
    const d = await post(`/violations/${v3.body.id}/verify`, { confirm: false, note: '复核系误差' });
    expect(d.body.status).toBe('DISMISSED');
  });
});
