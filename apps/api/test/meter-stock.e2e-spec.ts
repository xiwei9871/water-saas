/**
 * 水表库房 e2e (20261021 整改 任务D) against `watersaas_test`。
 * 复用 rel-water 租户 fixture（meter-relation spec 已建）。
 * Covers:
 *  1. 建库房+货位 → 批量采购入库（供应商/批次）→ 库存出现。
 *  2. 有库房后，未入库表禁止装表（METER_NOT_IN_STOCK）。
 *  3. 在库表装表自动记 ISSUE_OUT 流水 + 清库位 + 表转 INSTALLED。
 *  4. 领用→退库循环：ISSUE_OUT→ISSUED，RETURN_IN→AVAILABLE+回库位。
 *  5. 报废出库 SCRAP_OUT → RETIRED；在用表不可报废。
 *  6. 全生命周期 trail：流水+装拆履历合一。
 */
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
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

const TA = 'aa60aa60-aa60-4a06-8a06-aa60aa60aa60';
const ORG_A = 'aa60aa60-0000-4000-8000-0000000000c0';
const ROLE_ADMIN = 'aa60aa60-0000-4000-8000-00000000ad01';
const STAFF_ADMIN = 'aa60aa60-0000-4000-8000-0000000a0001';
const owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
let app: INestApplication<App>;
let adminToken = '';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const RUN = `st${Date.now().toString(36)}`;

const post = (p: string, b: unknown) =>
  request(app.getHttpServer()).post(p).set(auth(adminToken)).send(b);
const get = (p: string) => request(app.getHttpServer()).get(p).set(auth(adminToken));

const mkMeter = async () =>
  (await post('/meters', { brand: 'st-brand', caliber: 'DN15', meterNo: `ST-${RUN}-${Math.random().toString(36).slice(2, 7)}` }).expect(201)).body as { id: string; meterNo: string };

const mkAccount = async (tag: string, meterId: string) =>
  (
    await post('/water-accounts/onboard', {
      customer: { name: `STK ${tag} ${RUN}`, custType: 'PERSONAL' },
      account: { usageCategory: 'RES_METERED', addr: `${tag} st rd` },
      meterId,
      installation: { initialReading: 0, installedAt: '2026-10-20' },
    }).expect(201)
  ).body as { waterAccount: { id: string } };

beforeAll(async () => {
  await owner.connect();
  const bcrypt = (await import('bcrypt')).default;
  const hash = await bcrypt.hash('stk-pass', 10);
  await owner.query(
    `INSERT INTO tenant (id, code, name, status, created_at, updated_at)
     VALUES ($1, 'stk-water', 'STK Water', 'ACTIVE', now(), now()) ON CONFLICT DO NOTHING`,
    [TA],
  );
  await owner.query(
    `INSERT INTO org_unit (id, tenant_id, parent_id, name, type, created_at, updated_at)
     VALUES ($1, $2, NULL, 'STK Company', 'COMPANY', now(), now()) ON CONFLICT DO NOTHING`,
    [ORG_A, TA],
  );
  await owner.query(
    `INSERT INTO role (id, tenant_id, code, name, data_scope, created_at, updated_at)
     VALUES ($1, $2, 'admin', 'STK Admin', 'ALL', now(), now())
     ON CONFLICT (tenant_id, code) DO NOTHING`,
    [ROLE_ADMIN, TA],
  );
  await owner.query(
    `INSERT INTO staff (id, tenant_id, org_unit_id, login, password_hash, name, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'stk-admin', $4, 'STK Admin', 'ACTIVE', now(), now())
     ON CONFLICT (tenant_id, login) DO NOTHING`,
    [STAFF_ADMIN, TA, ORG_A, hash],
  );
  await owner.query(
    `INSERT INTO staff_role (tenant_id, staff_id, role_id, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now()) ON CONFLICT DO NOTHING`,
    [TA, STAFF_ADMIN, ROLE_ADMIN],
  );
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleFixture.createNestApplication();
  await app.init();
  adminToken = (
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantCode: 'stk-water', login: 'stk-admin', password: 'stk-pass' })
      .expect(201)
  ).body.accessToken as string;
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

describe('任务D 水表库房全生命周期', () => {
  it('库房/货位 → 采购入库 → 装表强制走库存 → 流水全追溯', async () => {
    // 1. 建库房 + 货位
    const wh = await post('/meter-warehouses', {
      code: `WH-${RUN}`,
      name: '主库房',
      owner: '供水公司',
    }).expect(201);
    const loc = await post(`/meter-warehouses/${wh.body.id}/locations`, {
      code: 'A-01',
      name: '一号货架',
    }).expect(201);

    // 2. 两只新表批量采购入库
    const m1 = await mkMeter();
    const m2 = await mkMeter();
    const mv = await post('/meter-stock/movements', {
      type: 'PURCHASE_IN',
      meterIds: [m1.id, m2.id],
      warehouseId: wh.body.id,
      locationId: loc.body.id,
      docNo: `PO-${RUN}`,
      supplier: 'XX表厂',
      batchNo: 'B202610',
    }).expect(201);
    expect(mv.body.count).toBe(2);

    // 3. 租户有库房后：未入库表禁止装表（onboard 也不放过）
    const loose = await mkMeter();
    const denied = await post('/water-accounts/onboard', {
      customer: { name: `STK loose ${RUN}`, custType: 'PERSONAL' },
      account: { usageCategory: 'RES_METERED', addr: 'loose rd' },
      meterId: loose.id,
      installation: { initialReading: 0, installedAt: '2026-10-20' },
    });
    expect(denied.status).toBe(409);
    expect(denied.body.code ?? denied.body.message?.code).toBe('METER_NOT_IN_STOCK');

    // 4. 在库表装表（onboard meterId 路径）→ 自动领用出库 + 转 INSTALLED + 清库位
    const acc = await mkAccount('a', m1.id);
    const mRow = (
      await owner.query(
        `SELECT status::text AS s, warehouse_id FROM meter WHERE id = $1`,
        [m1.id],
      )
    ).rows[0];
    expect(mRow.s).toBe('INSTALLED');
    expect(mRow.warehouse_id).toBeNull();
    const issueMv = (
      await owner.query(
        `SELECT movement_type, remark FROM meter_stock_movement
         WHERE meter_id = $1 AND movement_type = 'ISSUE_OUT'`,
        [m1.id],
      )
    ).rows[0];
    expect(issueMv).toBeTruthy();
    expect(issueMv.remark).toContain('自动领用');

    // 5. 领用→退库循环
    await post('/meter-stock/movements', {
      type: 'ISSUE_OUT',
      meterIds: [m2.id],
      docNo: `LK-${RUN}`,
    }).expect(201);
    expect(
      (await owner.query(`SELECT status::text AS s FROM meter WHERE id=$1`, [m2.id])).rows[0].s,
    ).toBe('ISSUED');
    await post('/meter-stock/movements', {
      type: 'RETURN_IN',
      meterIds: [m2.id],
      warehouseId: wh.body.id,
      locationId: loc.body.id,
      docNo: `RT-${RUN}`,
    }).expect(201);
    const m2Row = (
      await owner.query(
        `SELECT status::text AS s, warehouse_id FROM meter WHERE id=$1`,
        [m2.id],
      )
    ).rows[0];
    expect(m2Row.s).toBe('AVAILABLE');
    expect(m2Row.warehouse_id).toBe(wh.body.id);

    // 6. 报废出库
    const scrap = await mkMeter();
    await post('/meter-stock/movements', {
      type: 'PURCHASE_IN',
      meterIds: [scrap.id],
      warehouseId: wh.body.id,
    }).expect(201);
    await post('/meter-stock/movements', {
      type: 'SCRAP_OUT',
      meterIds: [scrap.id],
      remark: '检定不合格报废',
    }).expect(201);
    expect(
      (await owner.query(`SELECT status::text AS s FROM meter WHERE id=$1`, [scrap.id])).rows[0].s,
    ).toBe('RETIRED');
    // 在用表不可报废
    await post('/meter-stock/movements', {
      type: 'SCRAP_OUT',
      meterIds: [m1.id],
    }).expect(400);

    // 7. 全生命周期轨迹：m1 应有 PURCHASE_IN + ISSUE_OUT + 装表记录
    const trail = (await get(`/meter-stock/meters/${m1.id}/trail`)).body as {
      movements: { movementType: string }[];
      installations: { status: string }[];
    };
    const types = trail.movements.map((m) => m.movementType);
    expect(types).toContain('PURCHASE_IN');
    expect(types).toContain('ISSUE_OUT');
    expect(trail.installations.length).toBe(1);
    expect(trail.installations[0].status).toBe('ACTIVE');

    // 8. 流水列表按单据号过滤
    const list = (await get(`/meter-stock/movements?docNo=PO-${RUN}`)).body as {
      items: { docNo: string }[];
      total: number;
    };
    expect(list.total).toBe(2);
  });
});
