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

  it('D1 出入库分源：采购录新号建档+重号拒绝；selectable 按类型分源', async () => {
    const wh = await post('/meter-warehouses', {
      code: `WH2-${RUN}`,
      name: '二库房',
    }).expect(201);

    // 1) 采购入库直接录新表号批量建档（含检定周期自动带入）
    const nos = [`NEW-${RUN}-001`, `NEW-${RUN}-002`];
    const mv = await post('/meter-stock/movements', {
      type: 'PURCHASE_IN',
      meterNos: [...nos, nos[0]], // 批内重复应去重
      warehouseId: wh.body.id,
      brand: '宁波',
      caliber: 'DN15',
      supplier: 'XX表厂',
      batchNo: 'D1BATCH',
    }).expect(201);
    expect(mv.body.count).toBe(2);
    const created = (
      await owner.query(
        `SELECT meter_no, status::text AS s, check_period_years FROM meter
         WHERE meter_no = ANY($1) ORDER BY meter_no`,
        [nos],
      )
    ).rows;
    expect(created).toHaveLength(2);
    expect(created[0].s).toBe('AVAILABLE');
    expect(created[0].check_period_years).toBe(6); // DN15 → 6 年

    // 2) 重号整单拒绝（与档案池比对，含已入档表）
    const dup = await post('/meter-stock/movements', {
      type: 'PURCHASE_IN',
      meterNos: [nos[0], `NEW-${RUN}-003`],
      warehouseId: wh.body.id,
    });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('METER_NO_EXISTS');
    // 003 未落库（整单拒绝）
    expect(
      (
        await owner.query(`SELECT 1 FROM meter WHERE meter_no = $1`, [
          `NEW-${RUN}-003`,
        ])
      ).rowCount,
    ).toBe(0);

    // 3) selectable 分源：在库表出现在 ISSUE_OUT 候选，不出现在 RETURN_IN
    const issueCands = (
      await get(`/meter-stock/selectable?type=ISSUE_OUT&kw=NEW-${RUN}`)
    ).body as { meterNo: string; warehouse: { name: string } | null }[];
    expect(issueCands.map((c) => c.meterNo).sort()).toEqual(nos);
    const returnCands = (
      await get(`/meter-stock/selectable?type=RETURN_IN&kw=NEW-${RUN}`)
    ).body as { meterNo: string }[];
    expect(returnCands).toHaveLength(0);

    // 4) 领用出库后：该表转入 RETURN_IN 候选、离开 ISSUE_OUT 候选
    const meterId = (
      await owner.query(`SELECT id FROM meter WHERE meter_no = $1`, [nos[0]])
    ).rows[0].id as string;
    await post('/meter-stock/movements', {
      type: 'ISSUE_OUT',
      meterIds: [meterId],
    }).expect(201);
    const issueAfter = (
      await get(`/meter-stock/selectable?type=ISSUE_OUT&kw=NEW-${RUN}`)
    ).body as { meterNo: string }[];
    expect(issueAfter.map((c) => c.meterNo)).toEqual([nos[1]]);
    const returnAfter = (
      await get(`/meter-stock/selectable?type=RETURN_IN&kw=NEW-${RUN}`)
    ).body as { meterNo: string }[];
    expect(returnAfter.map((c) => c.meterNo)).toEqual([nos[0]]);
  });
});

describe('1026-v2 X1 — 库房/货位 编辑·停用·删除', () => {
  it('编辑改名 / 停用后禁出入库 / 非空删除拦截 / 空可删', async () => {
    const wh = (await post('/meter-warehouses', {
      code: `X1-${RUN}`, name: '编辑前', owner: '一公司',
    }).expect(201)).body;
    const loc = (await post(`/meter-warehouses/${wh.id}/locations`, {
      code: 'L1', name: '旧货位',
    }).expect(201)).body;

    // X1-1 编辑库房（改名+owner）与货位（改名）
    const wh2 = (await request(app.getHttpServer())
      .patch(`/meter-warehouses/${wh.id}`)
      .set(auth(adminToken))
      .send({ name: '编辑后', owner: '二公司' })
      .expect(200)).body;
    expect(wh2).toMatchObject({ name: '编辑后', owner: '二公司' });
    const loc2 = (await request(app.getHttpServer())
      .patch(`/meter-warehouses/${wh.id}/locations/${loc.id}`)
      .set(auth(adminToken))
      .send({ name: '新货位' })
      .expect(200)).body;
    expect(loc2.name).toBe('新货位');

    // X1-3 非空拦截：库房有货位 → 删库房 409；货位有在库表 → 删货位 409
    await request(app.getHttpServer())
      .delete(`/meter-warehouses/${wh.id}`)
      .set(auth(adminToken))
      .expect(409);
    const m = await mkMeter();
    await post('/meter-stock/movements', {
      type: 'PURCHASE_IN', meterIds: [m.id],
      warehouseId: wh.id, locationId: loc.id,
    }).expect(201);
    await request(app.getHttpServer())
      .delete(`/meter-warehouses/${wh.id}/locations/${loc.id}`)
      .set(auth(adminToken))
      .expect(409);

    // 停用库房 → 出入库被拒（RETURN_IN 显式指定停用库房 → 400）
    await request(app.getHttpServer())
      .patch(`/meter-warehouses/${wh.id}`)
      .set(auth(adminToken))
      .send({ status: 'DISABLED' })
      .expect(200);
    await post('/meter-stock/movements', {
      type: 'RETURN_IN', meterIds: [m.id],
      warehouseId: wh.id,
    }).expect(400);

    // 恢复启用；出库后货位空、流水已产生 → 删货位仍被流水拦（409）
    await request(app.getHttpServer())
      .patch(`/meter-warehouses/${wh.id}`)
      .set(auth(adminToken))
      .send({ status: 'ACTIVE' })
      .expect(200);
    await post('/meter-stock/movements', {
      type: 'ISSUE_OUT', meterIds: [m.id],
    }).expect(201);
    await request(app.getHttpServer())
      .delete(`/meter-warehouses/${wh.id}/locations/${loc.id}`)
      .set(auth(adminToken))
      .expect(409);

    // X1-2 空库房可删：新建空库房直接删
    const empty = (await post('/meter-warehouses', {
      code: `X1E-${RUN}`, name: '空库房',
    }).expect(201)).body;
    await request(app.getHttpServer())
      .delete(`/meter-warehouses/${empty.id}`)
      .set(auth(adminToken))
      .expect(200);
    const emptyLoc = (await post('/meter-warehouses', {
      code: `X1L-${RUN}`, name: '空货位库房',
    }).expect(201)).body;
    const l2 = (await post(`/meter-warehouses/${emptyLoc.id}/locations`, {
      code: 'L9', name: '临时',
    }).expect(201)).body;
    await request(app.getHttpServer())
      .delete(`/meter-warehouses/${emptyLoc.id}/locations/${l2.id}`)
      .set(auth(adminToken))
      .expect(200);
  });
});
