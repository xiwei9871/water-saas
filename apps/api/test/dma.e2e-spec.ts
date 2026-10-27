/**
 * DMA 管理 + 产销差看板 e2e (20261023 C1/C2) against `watersaas_test`。
 * Covers:
 *  1. DMA 分区建/改 + 考核表挂接（限 CHECK 角色）+ 挂接水表多对多。
 *  2. 产销差：Σ考核表水量 − Σ挂接水量 = 未计量；漏损率 + 除零保护。
 *  3. 生效/失效窗口：摘除后不再计入下期；多期对比趋势。
 *  4. 权限与组织边界：metering:service 写、metering:read 看板。
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
const RUN = `d${Date.now().toString(36)}`;

const post = (p: string, b: unknown) =>
  request(app.getHttpServer()).post(p).set(auth(adminToken)).send(b);
const get = (p: string) => request(app.getHttpServer()).get(p).set(auth(adminToken));
const del = (p: string) => request(app.getHttpServer()).delete(p).set(auth(adminToken));

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

/** 造一条读数（直接写库，绕开计划/QC 链——产销差算的是表码差）。 */
const seedReading = async (
  installationId: string,
  meterId: string,
  period: string,
  value: number,
) =>
  owner.query(
    `INSERT INTO meter_reading
       (id, tenant_id, installation_id, meter_id, period, read_date, result_type,
        reading_value, qc_status, source, operator_id, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'ACTUAL', $6, 'PASSED', 'WEB', $7, now(), now())`,
    [TA, installationId, meterId, period, `${period.slice(0, 4)}-${period.slice(4)}-15`, value, STAFF_ADMIN],
  );

describe('C1/C2 DMA 管理 + 产销差（20261026 D1-D4：考核表=监控表户）', () => {
  it('分区→考核表→挂接→产销差：Σ考核表−Σ挂接=未计量；除零保护；摘除失效', async () => {
    // 1. 建表（均普通表——D1 后表具角色无 CHECK）+ 各立户装表；
    //    考核表判定 = 用水户用水类别 MONITORING。
    const chkMeter = (
      await post('/meters', {
        meterNo: `CHK-${RUN}`,
        brand: 'dma',
        caliber: 'DN50',
        // 兼容旧入参：CHECK 角色已废除，服务端按 NORMAL 落档。
        meterRole: 'CHECK',
      }).expect(201)
    ).body as { id: string; meterRole: string };
    expect(chkMeter.meterRole).toBe('NORMAL');
    const usrMeter = (
      await post('/meters', { meterNo: `USR-${RUN}`, brand: 'dma', caliber: 'DN15' }).expect(201)
    ).body as { id: string };

    // 同租户可能已有库房（meter-stock spec）——未入库表禁装表，先入后装。
    const wh = await post('/meter-warehouses', { code: `DWH-${RUN}`, name: 'DMA库' }).expect(201);
    await post('/meter-stock/movements', {
      type: 'PURCHASE_IN',
      meterIds: [chkMeter.id, usrMeter.id],
      warehouseId: wh.body.id,
    }).expect(201);

    const chkAcct = (
      await post('/water-accounts/onboard', {
        account: { usageCategory: 'MONITORING', addr: 'DMA入口' },
        meterId: chkMeter.id,
        installation: { initialReading: 0, installedAt: '2026-01-01' },
      }).expect(201)
    ).body;
    const usrAcct = (
      await post('/water-accounts/onboard', {
        customer: { name: `DMA user ${RUN}`, custType: 'PERSONAL' },
        account: { usageCategory: 'RES_METERED', addr: 'user rd' },
        meterId: usrMeter.id,
        installation: { initialReading: 0, installedAt: '2026-01-01' },
      }).expect(201)
    ).body;
    const chkInstId = chkAcct.installation.id as string;
    const usrInstId = usrAcct.installation.id as string;

    // 2. 建 DMA + 挂考核表（D1：非监控表户的水表拒绝）+ 挂接水表。
    const dma = (
      await post('/dma/zones', {
        code: `DMA-${RUN}`,
        name: '城东DMA',
        region: '城东片区',
      }).expect(201)
    ).body as { id: string };
    await post(`/dma/zones/${dma.id}/check-meters`, {
      meterIds: [usrMeter.id], // D3 多选入参；该表非监控表 → 400
    }).expect(400);
    const chkAdd = (
      await post(`/dma/zones/${dma.id}/check-meters`, {
        meterIds: [chkMeter.id],
        effectiveFrom: '2026-06-01',
      }).expect(201)
    ).body as { checkMeterIds: string[]; count: number };
    expect(chkAdd.count).toBe(1);
    const chkLink = { id: chkAdd.checkMeterIds[0] };
    // D1：监控表户的水表不可作为挂接对象。
    await post(`/dma/check-meters/${chkLink.id}/links`, {
      meterIds: [chkMeter.id],
    }).expect(400);
    const link = (
      await post(`/dma/check-meters/${chkLink.id}/links`, {
        meterIds: [usrMeter.id],
        effectiveFrom: '2026-06-01',
      }).expect(201)
    ).body;
    expect(link.count).toBe(1);

    // 3. 读数：考核表 0→1000，挂接表 0→800 → 未计量 200，漏损率 20%。
    const P = '202607';
    await seedReading(chkInstId, chkMeter.id, P, 1000);
    await seedReading(usrInstId, usrMeter.id, P, 800);

    const dash = (
      await get(`/dma/dashboard?period=${P}`).expect(200)
    ).body as {
      rows: {
        dma: { id: string };
        checkQty: string;
        linkedQty: string;
        unmeasuredQty: string;
        leakageRate: string | null;
      }[];
    }[];
    const row = dash[0].rows.find((r) => r.dma.id === dma.id)!;
    expect(row.checkQty).toBe('1000.00');
    expect(row.linkedQty).toBe('800.00');
    expect(row.unmeasuredQty).toBe('200.00');
    expect(row.leakageRate).toBe('20.00');

    // 4. 下钻明细：两侧分表各自用量与表号（中文标签/无裸 id 由前端渲染）。
    const usage = (
      await get(`/dma/zones/${dma.id}/usage?period=${P}`).expect(200)
    ).body as {
      checkMeters: { meterNo: string; usageQty: string; measured: boolean }[];
      linkedMeters: { meterNo: string; usageQty: string; measured: boolean }[];
    };
    expect(usage.checkMeters).toEqual([
      expect.objectContaining({ meterNo: `CHK-${RUN}`, usageQty: '1000.00', measured: true }),
    ]);
    expect(usage.linkedMeters).toEqual([
      expect.objectContaining({ meterNo: `USR-${RUN}`, usageQty: '800.00', measured: true }),
    ]);

    // 5. 除零保护：新分区无考核表读数 → 漏损率 null 不报错。
    const empty = (
      await post('/dma/zones', { code: `DMAE-${RUN}`, name: '空分区' }).expect(201)
    ).body as { id: string };
    const dash2 = (await get(`/dma/dashboard?period=${P}`).expect(200)).body as {
      rows: { dma: { id: string }; leakageRate: string | null; checkQty: string }[];
    }[];
    const emptyRow = dash2[0].rows.find((r) => r.dma.id === empty.id)!;
    expect(emptyRow.checkQty).toBe('0.00');
    expect(emptyRow.leakageRate).toBeNull();

    // 6. 摘除考核表（effective_to=现在≈10月）→ 摘除后的月份不再计入；
    //    摘除当月及历史期仍按"当时有效"计入（失效窗口语义）。
    await del(`/dma/check-meters/${chkLink.id}`).expect(200);
    const P2 = '202611';
    await seedReading(chkInstId, chkMeter.id, P2, 1200);
    const dash3 = (await get(`/dma/dashboard?periods=${P},${P2}`).expect(200)).body as {
      period: string;
      rows: { dma: { id: string }; checkMeterCount: number; checkQty: string }[];
    }[];
    const p2row = dash3.find((d) => d.period === P2)!.rows.find((r) => r.dma.id === dma.id)!;
    expect(p2row.checkMeterCount).toBe(0);
    expect(p2row.checkQty).toBe('0.00');
    const p1row = dash3.find((d) => d.period === P)!.rows.find((r) => r.dma.id === dma.id)!;
    expect(p1row.checkQty).toBe('1000.00');
  });

  it('D3/D4：挂考核表批量多选 + 同表多挂产销差去重', async () => {
    const P = '202608';
    // 两只监控表（两只监控户）+ 一只计费表，先入库再立户装表。
    const m1 = (await post('/meters', { meterNo: `M1-${RUN}`, brand: 'd' }).expect(201)).body as {
      id: string;
    };
    const m2 = (await post('/meters', { meterNo: `M2-${RUN}`, brand: 'd' }).expect(201)).body as {
      id: string;
    };
    const um = (await post('/meters', { meterNo: `UM-${RUN}`, brand: 'd' }).expect(201)).body as {
      id: string;
    };
    const wh = await post('/meter-warehouses', {
      code: `DWH2-${RUN}`,
      name: 'DMA库2',
    }).expect(201);
    await post('/meter-stock/movements', {
      type: 'PURCHASE_IN',
      meterIds: [m1.id, m2.id, um.id],
      warehouseId: wh.body.id,
    }).expect(201);
    const a1 = (
      await post('/water-accounts/onboard', {
        account: { usageCategory: 'MONITORING', addr: '入口1' },
        meterId: m1.id,
        installation: { initialReading: 0, installedAt: '2026-01-01' },
      }).expect(201)
    ).body;
    const a2 = (
      await post('/water-accounts/onboard', {
        account: { usageCategory: 'MONITORING', addr: '入口2' },
        meterId: m2.id,
        installation: { initialReading: 0, installedAt: '2026-01-01' },
      }).expect(201)
    ).body;
    const ua = (
      await post('/water-accounts/onboard', {
        customer: { name: `U ${RUN}`, custType: 'PERSONAL' },
        account: { usageCategory: 'RES_METERED', addr: 'u' },
        meterId: um.id,
        installation: { initialReading: 0, installedAt: '2026-01-01' },
      }).expect(201)
    ).body;

    const dma = (
      await post('/dma/zones', { code: `DMAD-${RUN}`, name: '去重区' }).expect(201)
    ).body as { id: string };
    // D3：一次多选挂两只考核表。
    const add = (
      await post(`/dma/zones/${dma.id}/check-meters`, {
        meterIds: [m1.id, m2.id],
        effectiveFrom: '2026-06-01',
      }).expect(201)
    ).body as { checkMeterIds: string[]; count: number };
    expect(add.count).toBe(2);
    // D4：同一结算水表挂到两只考核表下。
    for (const cmId of add.checkMeterIds) {
      await post(`/dma/check-meters/${cmId}/links`, {
        meterIds: [um.id],
        effectiveFrom: '2026-06-01',
      }).expect(201);
    }
    // 考核表 100+200，挂接表 80 → 挂接侧去重只计一次：未计量 220。
    await seedReading(a1.installation.id, m1.id, P, 100);
    await seedReading(a2.installation.id, m2.id, P, 200);
    await seedReading(ua.installation.id, um.id, P, 80);
    const dash = (await get(`/dma/dashboard?period=${P}`).expect(200)).body as {
      rows: {
        dma: { id: string };
        checkQty: string;
        linkedQty: string;
        unmeasuredQty: string;
        leakageRate: string | null;
        linkedMeterCount: number;
      }[];
    }[];
    const row = dash[0].rows.find((r) => r.dma.id === dma.id)!;
    expect(row.checkQty).toBe('300.00');
    expect(row.linkedQty).toBe('80.00'); // 去重后不重复扣减
    expect(row.unmeasuredQty).toBe('220.00');
    expect(row.linkedMeterCount).toBe(1);
    expect(row.leakageRate).toBe('73.33');
  });

  it('权限边界：dashboard 无 period 或非法期 → 400', async () => {
    await get('/dma/dashboard').expect(400);
    await get('/dma/dashboard?period=202613').expect(400);
  });
});
