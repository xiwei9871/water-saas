/**
 * 追加抄表独立功能 e2e (20261026 设计方案) against `watersaas_test`。
 * Covers:
 *  V2 下达 → 单户 SUPPLEMENT 计划 + SUPPLEMENT_READING 任务直接指派
 *     （ASSIGNED 进抄表员待办，context 带 planItemId/户/期）；
 *  V6 未入册户 → 系统册兜底 + 抄表员必填强制（READER 校验）；
 *  幂等：同户同期重复下达 → deduped 复用原计划；
 *  V7 任务闭环：未回填读数点完成 → TASK_NOT_DONE；回填后可办结。
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

const TA = 'bb70bb70-bb70-4b07-8b07-bb70bb70bb70';
const ORG_A = 'bb70bb70-0000-4000-8000-0000000000c0';
const ROLE_ADMIN = 'bb70bb70-0000-4000-8000-00000000ad01';
const STAFF_ADMIN = 'bb70bb70-0000-4000-8000-0000000a0001';
const owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
let app: INestApplication<App>;
let adminToken = '';
const auth = () => ({ Authorization: `Bearer ${adminToken}` });
const RUN = `s${Date.now().toString(36)}`;

const post = (p: string, b: unknown, expectCode = 201) =>
  request(app.getHttpServer()).post(p).set(auth()).send(b).expect(expectCode);
const get = (p: string) => request(app.getHttpServer()).get(p).set(auth());

beforeAll(async () => {
  await owner.connect();
  const bcrypt = (await import('bcrypt')).default;
  const hash = await bcrypt.hash('sup-pass', 10);
  await owner.query(
    `INSERT INTO tenant (id, code, name, status, created_at, updated_at)
     VALUES ($1, 'sup-water', 'SUP Water', 'ACTIVE', now(), now()) ON CONFLICT DO NOTHING`,
    [TA],
  );
  await owner.query(
    `INSERT INTO org_unit (id, tenant_id, parent_id, name, type, created_at, updated_at)
     VALUES ($1, $2, NULL, 'SUP Company', 'COMPANY', now(), now()) ON CONFLICT DO NOTHING`,
    [ORG_A, TA],
  );
  await owner.query(
    `INSERT INTO role (id, tenant_id, code, name, data_scope, created_at, updated_at)
     VALUES ($1, $2, 'admin', 'SUP Admin', 'ALL', now(), now())
     ON CONFLICT (tenant_id, code) DO NOTHING`,
    [ROLE_ADMIN, TA],
  );
  await owner.query(
    `INSERT INTO staff (id, tenant_id, org_unit_id, login, password_hash, name, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'sup-admin', $4, 'SUP Admin', 'ACTIVE', now(), now())
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
      .send({ tenantCode: 'sup-water', login: 'sup-admin', password: 'sup-pass' })
      .expect(201)
  ).body.accessToken as string;
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

const onboard = async (meterNo: string) => {
  const m = (await post('/meters', { meterNo, brand: 's' }).expect(201)).body as {
    id: string;
  };
  const acc = (
    await post('/water-accounts/onboard', {
      customer: { name: `u${meterNo}`, custType: 'PERSONAL' },
      account: { usageCategory: 'RES_METERED', addr: 'rd' },
      meterId: m.id,
      installation: { initialReading: 0, installedAt: '2026-01-01' },
    }).expect(201)
  ).body as { waterAccount: { id: string; accountNo: string } };
  return acc.waterAccount;
};

describe('20261026 追加抄表独立功能', () => {
  it('V2/V6：未入册户下达 → SUPPLEMENT 计划（系统册）+ ASSIGNED 任务；重复下达幂等', async () => {
    const wa = await onboard(`SUP1-${RUN}`);
    const res = (
      await post('/reading-plans/supplement', {
        waterAccountId: wa.id,
        period: '202610',
        planDate: '2026-10-28',
        readerId: STAFF_ADMIN,
        remark: '现场复查',
      }).expect(201)
    ).body as {
      id: string;
      planType: string;
      period: string;
      readerId: string;
      bookId: string;
      items: { id: string; waterAccountId: string; seqNo: number }[];
      taskId: string;
      deduped: boolean;
    };
    expect(res.planType).toBe('SUPPLEMENT');
    expect(res.items).toHaveLength(1);
    expect(res.items[0].waterAccountId).toBe(wa.id);
    expect(res.taskId).toBeTruthy();
    expect(res.deduped).toBe(false);

    // 未入册 → 系统册兜底（book_no=SYS-SUP 自动建立）。
    const book = (await get(`/reading-books/${res.bookId}`).expect(200)).body as {
      bookNo: string;
      name: string;
    };
    expect(book.bookNo).toBe('SYS-SUP');

    // 任务：ASSIGNED 直接进抄表员待办，context 要素齐备（闭环指引）。
    const task = (await get(`/tasks/${res.taskId}`).expect(200)).body as {
      type: string;
      status: string;
      assigneeId: string;
      bizType: string;
      bizId: string;
      context: Record<string, string>;
    };
    expect(task.type).toBe('SUPPLEMENT_READING');
    expect(task.status).toBe('ASSIGNED');
    expect(task.assigneeId).toBe(STAFF_ADMIN);
    expect(task.bizType).toBe('readingPlan');
    expect(task.bizId).toBe(res.id);
    expect(task.context.waterAccountNo).toBe(wa.accountNo);
    expect(task.context.period).toBe('202610');
    expect(task.context.planItemId).toBe(res.items[0].id);

    // 幂等：同户同期再次下达 → 复用（deduped）。
    const again = (
      await post('/reading-plans/supplement', {
        waterAccountId: wa.id,
        period: '202610',
        readerId: STAFF_ADMIN,
      }).expect(201)
    ).body as { id: string; deduped: boolean; taskId: string };
    expect(again.deduped).toBe(true);
    expect(again.id).toBe(res.id);

    // V7 完成标准：未回填读数直接点完成 → 409（佐证已带，越过形式校验）。
    await request(app.getHttpServer())
      .post(`/tasks/${res.taskId}/complete`)
      .set(auth())
      .send({ note: '没抄就点完成', evidenceRefs: ['photo://x'] })
      .expect(409);

    // 回填读数（计划明细录入）→ 任务可办结。
    await post(
      '/meter-readings',
      {
        planItemId: res.items[0].id,
        resultType: 'ACTUAL',
        readingValue: '66',
        readDate: '2026-10-28',
      },
      201,
    );
    await request(app.getHttpServer())
      .post(`/tasks/${res.taskId}/complete`)
      .set(auth())
      .send({ note: '已抄 66', evidenceRefs: ['photo://x'] })
      .expect(201);

    // 计划行带出 planType 便于列表「常规/追加」标识。
    const plans = (
      await get(`/reading-plans?planType=SUPPLEMENT&period=202610`).expect(200)
    ).body as { id: string; planType: string }[];
    expect(plans.some((p) => p.id === res.id)).toBe(true);
  });

  it('V1/V6 边界：入册户挂原册；抄表员必填 + 非员工拒绝', async () => {
    // 入册户 → 计划挂该册（不建系统册副本）。
    const wa = await onboard(`SUP2-${RUN}`);
    const book = (
      await post('/reading-books', {
        name: `B-${RUN}`,
        orgUnitId: ORG_A,
        readerId: STAFF_ADMIN,
      }).expect(201)
    ).body as { id: string };
    await post(`/reading-books/${book.id}/meters/transfer`, {
      waterAccountId: wa.id,
    }).expect(201);
    const res = (
      await post('/reading-plans/supplement', {
        waterAccountId: wa.id,
        period: '202610',
        readerId: STAFF_ADMIN,
      }).expect(201)
    ).body as { bookId: string };
    expect(res.bookId).toBe(book.id);

    // readerId 缺失/非员工 → 400。
    await post(
      '/reading-plans/supplement',
      { waterAccountId: wa.id, period: '202611' },
      400,
    );
    await post(
      '/reading-plans/supplement',
      {
        waterAccountId: wa.id,
        period: '202611',
        readerId: '00000000-0000-0000-0000-000000000000',
      },
      400,
    );
  });
});
