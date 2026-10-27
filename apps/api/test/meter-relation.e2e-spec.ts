/**
 * 总分表 e2e (20261021 整改 任务C) against `watersaas_test`。
 * Fixtures carry the `rel-` prefix. Covers:
 *  1. 建关系 → 主/分表角色自动置 MASTER/SUB；同分表重挂 409；同主表模式冲突 400。
 *  2. 计费排除：billingMode=MASTER 时分表户结算 400 ACCOUNT_BILLING_EXCLUDED；
 *     SUB 模式时总表户结算被排除；CHECK 考核表永不计费。
 *  3. 失效关系 → 角色回 NORMAL；切计费模式同步同主表全部在挂关系。
 *  4. 漏损分析：总表用量 − 分表合计 = 差额/比率。
 *  5. 权限/租户隔离。
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

const TA = 'ee50ee50-ee50-4e05-8e05-ee50ee50ee50';
const TB = 'ff50ff50-ff50-4f05-8f05-ff50ff50ff50';
const ORG_A = 'ee50ee50-0000-4000-8000-0000000000c0';
const ORG_B = 'ff50ff50-0000-4000-8000-0000000000c0';
const ROLE_ADMIN_A = 'ee50ee50-0000-4000-8000-00000000ad01';
const ROLE_ADMIN_B = 'ff50ff50-0000-4000-8000-00000000ad01';
const STAFF_ADMIN_A = 'ee50ee50-0000-4000-8000-0000000a0001';
const STAFF_ADMIN_B = 'ff50ff50-0000-4000-8000-0000000a0001';

const owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
let app: INestApplication<App>;
let adminToken = '';
let adminBToken = '';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

const post = (path: string, body: unknown, token = adminToken) =>
  request(app.getHttpServer()).post(path).set(auth(token)).send(body);
const patch = (path: string, body: unknown, token = adminToken) =>
  request(app.getHttpServer()).patch(path).set(auth(token)).send(body);
const get = (path: string, token = adminToken) =>
  request(app.getHttpServer()).get(path).set(auth(token));

const onboard = async (tag: string) => {
  const res = await post('/water-accounts/onboard', {
    customer: { name: `REL ${tag} ${RUN}`, custType: 'PERSONAL' },
    account: { usageCategory: 'RES_METERED', addr: `${tag} rel rd` },
    meter: { brand: 'rel-brand', caliber: 'DN15' },
    installation: { initialReading: 0, installedAt: '2026-01-01' },
  }).expect(201);
  return res.body as {
    waterAccount: { id: string };
    meter: { id: string };
    installation: { id: string };
  };
};

const meterRole = async (id: string) =>
  (await owner.query(`SELECT meter_role FROM meter WHERE id = $1`, [id])).rows[0]
    .meter_role as string;

beforeAll(async () => {
  await owner.connect();
  const hash = await bcrypt.hash('rel-pass', 10);
  await owner.query(
    `INSERT INTO tenant (id, code, name, status, created_at, updated_at)
     VALUES ($1, 'rel-water', 'REL Water', 'ACTIVE', now(), now()),
            ($2, 'rel-other', 'REL Other', 'ACTIVE', now(), now())
     ON CONFLICT DO NOTHING`,
    [TA, TB],
  );
  await owner.query(
    `INSERT INTO org_unit (id, tenant_id, parent_id, name, type, created_at, updated_at)
     VALUES ($1, $2, NULL, 'REL Company', 'COMPANY', now(), now()),
            ($3, $4, NULL, 'RELB Company', 'COMPANY', now(), now())
     ON CONFLICT DO NOTHING`,
    [ORG_A, TA, ORG_B, TB],
  );
  await owner.query(
    `INSERT INTO role (id, tenant_id, code, name, data_scope, created_at, updated_at)
     VALUES ($1, $2, 'admin', 'REL Admin', 'ALL', now(), now()),
            ($3, $4, 'admin', 'RELB Admin', 'ALL', now(), now())
     ON CONFLICT (tenant_id, code) DO NOTHING`,
    [ROLE_ADMIN_A, TA, ROLE_ADMIN_B, TB],
  );
  await owner.query(
    `INSERT INTO staff (id, tenant_id, org_unit_id, login, password_hash, name, status, created_at, updated_at)
     VALUES ($1, $3, $5, 'rel-admin',  $6, 'REL Admin',  'ACTIVE', now(), now()),
            ($2, $4, $7, 'relb-admin', $6, 'RELB Admin', 'ACTIVE', now(), now())
     ON CONFLICT (tenant_id, login) DO NOTHING`,
    [STAFF_ADMIN_A, STAFF_ADMIN_B, TA, TB, ORG_A, hash, ORG_B],
  );
  await owner.query(
    `INSERT INTO staff_role (tenant_id, staff_id, role_id, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now()), ($4, $5, $6, now(), now())
     ON CONFLICT DO NOTHING`,
    [TA, STAFF_ADMIN_A, ROLE_ADMIN_A, TB, STAFF_ADMIN_B, ROLE_ADMIN_B],
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
        .send({ tenantCode, login: login_, password: 'rel-pass' })
        .expect(201)
    ).body.accessToken as string;
  adminToken = await login('rel-water', 'rel-admin');
  adminBToken = await login('rel-other', 'relb-admin');
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

describe('任务C 总分表', () => {
  it('建关系→角色自动置位；同分表重挂409；同主表模式冲突400；失效回NORMAL', async () => {
    const aM = await onboard('master');
    const aS1 = await onboard('sub1');
    const aS2 = await onboard('sub2');

    const rel = await post('/meter-relations', {
      masterMeterId: aM.meter.id,
      subMeterId: aS1.meter.id,
      billingMode: 'SUB',
      effectiveDate: '2026-01-01',
    });
    if (rel.status !== 201) console.log('REL-DBG', rel.status, JSON.stringify(rel.body));
    expect(await meterRole(aM.meter.id)).toBe('MASTER');
    expect(await meterRole(aS1.meter.id)).toBe('SUB');
    const relId = rel.body.id as string;

    // 同分表重挂 → 409
    await post('/meter-relations', {
      masterMeterId: aM.meter.id,
      subMeterId: aS1.meter.id,
      effectiveDate: '2026-02-01',
    }).expect(409);

    // 同主表第二分表不同模式 → 400 BILLING_MODE_CONFLICT
    await post('/meter-relations', {
      masterMeterId: aM.meter.id,
      subMeterId: aS2.meter.id,
      billingMode: 'MASTER',
      effectiveDate: '2026-01-01',
    }).expect(400);
    const rel2 = await post('/meter-relations', {
      masterMeterId: aM.meter.id,
      subMeterId: aS2.meter.id,
      billingMode: 'SUB',
      effectiveDate: '2026-01-01',
    }).expect(201);

    // 切计费模式 → 同主表在挂关系全部同步
    await patch(`/meter-relations/${relId}`, { billingMode: 'MASTER' }).expect(200);
    const rows = (await get('/meter-relations')).body as {
      id: string;
      master_meter_id: string;
      billing_mode: string;
      expired_date: string | null;
    }[];
    const live = rows.filter(
      (r) => r.expired_date === null && r.master_meter_id === aM.meter.id,
    );
    expect(live.length).toBe(2);
    expect(live.every((r) => r.billing_mode === 'MASTER')).toBe(true);

    // 失效 rel2 → 分表角色回 NORMAL；主表仍有 rel1 → 保持 MASTER
    await patch(`/meter-relations/${rel2.body.id}`, { expiredDate: '2026-10-01' }).expect(200);
    expect(await meterRole(aS2.meter.id)).toBe('NORMAL');
    expect(await meterRole(aM.meter.id)).toBe('MASTER');
    // 失效 rel1 → 主表也回 NORMAL
    await patch(`/meter-relations/${relId}`, { expiredDate: '2026-10-01' }).expect(200);
    expect(await meterRole(aM.meter.id)).toBe('NORMAL');
    expect(await meterRole(aS1.meter.id)).toBe('NORMAL');
  });

  it('计费排除：MASTER模式分表户/ SUB模式总表户/ CHECK考核表 → ACCOUNT_BILLING_EXCLUDED', async () => {
    // MASTER 模式：分表户不独立结算
    const mA = await onboard('bm-m');
    const sA = await onboard('bm-s');
    const rel = await post('/meter-relations', {
      masterMeterId: mA.meter.id,
      subMeterId: sA.meter.id,
      billingMode: 'MASTER',
      effectiveDate: '2026-01-01',
    }).expect(201);
    const denied = await post('/consumption-settlements', {
      waterAccountId: sA.waterAccount.id,
      period: '202610',
    });
    expect(denied.status).toBe(400);
    expect(denied.body.code ?? denied.body.message?.code).toBe('ACCOUNT_BILLING_EXCLUDED');
    // 主表户正常结算（201 或业务成功响应）
    const ok = await post('/consumption-settlements', {
      waterAccountId: mA.waterAccount.id,
      period: '202610',
      estimateReason: 'no reading yet',
      usageQty: 0,
    });
    expect({ status: ok.status, body: ok.body }).toMatchObject({ status: 201 });

    // SUB 模式：总表户不计费
    const mB = await onboard('bm2-m');
    const sB = await onboard('bm2-s');
    await post('/meter-relations', {
      masterMeterId: mB.meter.id,
      subMeterId: sB.meter.id,
      billingMode: 'SUB',
      effectiveDate: '2026-01-01',
    }).expect(201);
    const deniedM = await post('/consumption-settlements', {
      waterAccountId: mB.waterAccount.id,
      period: '202610',
    });
    expect(deniedM.status).toBe(400);
    expect(deniedM.body.code ?? deniedM.body.message?.code).toBe('ACCOUNT_BILLING_EXCLUDED');
    const okS = await post('/consumption-settlements', {
      waterAccountId: sB.waterAccount.id,
      period: '202610',
      estimateReason: 'no reading yet',
      usageQty: 0,
    });
    expect(okS.status).toBe(201);

    // 监控表户（20261026 D1 后唯一考核表口径）：billable=false 永不计费
    const cA = (
      await post('/water-accounts/onboard', {
        account: { usageCategory: 'MONITORING', addr: 'x' },
        meter: { brand: 't', caliber: 'DN15' },
        installation: { initialReading: 0, installedAt: '2026-01-01' },
      }).expect(201)
    ).body as { waterAccount: { id: string } };
    const deniedC = await post('/consumption-settlements', {
      waterAccountId: cA.waterAccount.id,
      period: '202610',
    });
    expect(deniedC.status).toBe(400);
    void rel;
  });

  it('漏损分析：总表用量−分表合计=差额/比率；租户隔离', async () => {
    const mA = await onboard('loss-m');
    const sA = await onboard('loss-s');
    const sB = await onboard('loss-s2');
    await post('/meter-relations', {
      masterMeterId: mA.meter.id,
      subMeterId: sA.meter.id,
      billingMode: 'SUB',
      effectiveDate: '2026-01-01',
    }).expect(201);
    await post('/meter-relations', {
      masterMeterId: mA.meter.id,
      subMeterId: sB.meter.id,
      billingMode: 'SUB',
      effectiveDate: '2026-01-01',
    }).expect(201);

    // 直接落结算明细：总表 100，分表 60+30 → 漏损 10 (10%)
    const insertSettle = async (wa: string, inst: string, qty: number) => {
      const sid = (
        await owner.query(
          `INSERT INTO consumption_settlement
             (id, tenant_id, water_account_id, period, total_usage_qty, is_estimated, status, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, '202610', $3, false, 'FINAL', now(), now())
           RETURNING id`,
          [TA, wa, qty],
        )
      ).rows[0].id as string;
      await owner.query(
        `INSERT INTO consumption_component
           (id, tenant_id, settlement_id, installation_id, prev_reading_value, end_reading_value, usage_qty, source_type, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 0, $4, $4, 'READING', now(), now())`,
        [TA, sid, inst, qty],
      );
    };
    await insertSettle(mA.waterAccount.id, mA.installation.id, 100);
    await insertSettle(sA.waterAccount.id, sA.installation.id, 60);
    await insertSettle(sB.waterAccount.id, sB.installation.id, 30);

    const res = await get(
      `/meter-relations/loss?masterMeterId=${mA.meter.id}&from=202610&to=202610`,
    );
    if (res.status !== 200 || res.body.masterUsage === undefined) {
      console.log('LOSS-DBG', res.status, JSON.stringify(res.body));
    }
    expect(res.body.masterUsage).toBeCloseTo(100);
    expect(res.body.subTotal).toBeCloseTo(90);
    expect(res.body.lossQty).toBeCloseTo(10);
    expect(res.body.lossRate).toBeCloseTo(0.1);

    // 租户 B 不可见租户 A 的关系
    const listBRes = await get('/meter-relations', adminBToken);
    if (listBRes.status !== 200) console.log('LISTB-DBG', listBRes.status, JSON.stringify(listBRes.body));
    expect(listBRes.status).toBe(200);
    expect((listBRes.body as unknown[]).length).toBe(0);
  });
});
