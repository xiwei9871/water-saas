/**
 * Tariff config + version freeze e2e against `watersaas_test` — fixtures
 * carry the `t8-` prefix. Boots the real AppModule so JWT/permission
 * guards, tenant ALS and RLS all apply.
 *
 * Covers (Task-8 brief assertions):
 *  1. fee_items: create/list/detail/PATCH-name; duplicate code → 409;
 *     code/calcType immutable → 400; bad calcType → 400
 *  2. tariff_plans: create DRAFT + tiers atomically; tier ladder rules
 *     (first fromQty=0, contiguous, last open-ended, from<to) → 400s;
 *     ghost feeItemId → 400; duplicate (code, effective_from) → 409
 *  3. DRAFT PATCH: name/effectiveTo/tier-replace work; code → 400
 *  4. activate → ACTIVE; tierless plan → 409 TARIFF_TIERS_EMPTY;
 *     re-activate → 409; ACTIVE edits limited to effectiveTo shrink/close
 *     (name/tiers → 409 TARIFF_FROZEN; extend/null/< from → 400)
 *  5. overlap: a second ACTIVE window of the same usage_category that
 *     intersects → 409 TARIFF_WINDOW_OVERLAP; touching boundary OK
 *  6. freeze (P0): a POSTED bill referencing the plan → ALL PATCHes →
 *     409 TARIFF_FROZEN (a DRAFT bill does not freeze); status
 *     transitions stay legal
 *  7. new-version → independent DRAFT copy (same code, copied tiers,
 *     new effective_from); supplied tiers validated as create; works
 *     from RETIRED too
 *  8. retire → RETIRED; re-retire → 409; RETIRED edits → 409
 *  9. Idempotency-Key replays create; billing:read reads-only;
 *     metering:write can't write tariffs (403); tenant B sees nothing
 */
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import bcrypt from 'bcrypt';
import pg from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

// Point the app's runtime client at the TEST database before Nest builds it.
process.env.DATABASE_URL =
  process.env.DATABASE_URL_TEST ??
  'postgresql://ws_app:ws_app_pw@localhost:5432/watersaas_test';

const OWNER_URL =
  process.env.MIGRATION_DATABASE_URL_TEST ??
  'postgresql://postgres:postgres@localhost:5432/watersaas_test';

// ---- fixtures (all prefixed t8-) ----
const T8A = 'a8a8a8a8-8888-4888-8888-a8a8a8a88888'; // tenant A
const T8B = 'b8b8b8b8-5555-4555-8555-b8b8b8b85555'; // tenant B (isolation probes)
const ORG_A = 'a8a8a8a8-0000-4000-8000-0000000000c0';
const ORG_B = 'b8b8b8b8-0000-4000-8000-0000000000c0';
const ROLE_ADMIN_A = 'a8a8a8a8-0000-4000-8000-00000000ad01';
const ROLE_READER_A = 'a8a8a8a8-0000-4000-8000-000000001e01';
const ROLE_WRITER_A = 'a8a8a8a8-0000-4000-8000-000000001e02';
const ROLE_METWRITER_A = 'a8a8a8a8-0000-4000-8000-000000001e03';
const ROLE_B_ADMIN = 'b8b8b8b8-0000-4000-8000-00000000ad01';
const PERM_BILL_READ = 'a8a8a8a8-0000-4000-8000-00000000e801';
const PERM_BILL_WRITE = 'a8a8a8a8-0000-4000-8000-00000000e802';
const PERM_MET_WRITE = 'a8a8a8a8-0000-4000-8000-00000000e803';
const STAFF_ADMIN_A = 'a8a8a8a8-0000-4000-8000-0000000a0001';
const STAFF_READER_A = 'a8a8a8a8-0000-4000-8000-0000000b0002';
const STAFF_WRITER_A = 'a8a8a8a8-0000-4000-8000-0000000b0003';
const STAFF_METWRITER_A = 'a8a8a8a8-0000-4000-8000-0000000b0004';
const STAFF_B_ADMIN = 'b8b8b8b8-0000-4000-8000-0000000a0001';

const owner = new pg.Client({ connectionString: OWNER_URL });
let app: INestApplication<App>;
let adminToken = '';
let readerToken = '';
let writerToken = '';
let metWriterToken = '';
let tenantBToken = '';

// ids populated by the sequential suite
let waterItem = ''; // fee_item WATER-*
let fixedItem = ''; // fee_item FIXED-*
const plan: Record<string, string> = {}; // label → tariff_plan id
let settleAccountId = '';
let waterAccountId = '';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

// Run-scoped suffix: the test DB keeps business rows + idempotency keys
// between runs, so codes/keys/usage-categories differ per run.
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const UC = `T8R-${RUN}`; // usage_category unique to this run

const day = (iso: string) => iso; // readability alias for YYYY-MM-DD literals

const createFeeItem = (body: Record<string, unknown>, token = adminToken) =>
  request(app.getHttpServer()).post('/fee-items').set(auth(token)).send(body);

const createPlan = (body: Record<string, unknown>, token = adminToken) =>
  request(app.getHttpServer()).post('/tariff-plans').set(auth(token)).send(body);

const patchPlan = (id: string, body: Record<string, unknown>, token = adminToken) =>
  request(app.getHttpServer()).patch(`/tariff-plans/${id}`).set(auth(token)).send(body);

const activate = (id: string, token = adminToken) =>
  request(app.getHttpServer())
    .post(`/tariff-plans/${id}/activate`)
    .set(auth(token))
    .send({});

const retire = (id: string, token = adminToken) =>
  request(app.getHttpServer()).post(`/tariff-plans/${id}/retire`).set(auth(token)).send({});

const newVersion = (id: string, body: Record<string, unknown>, token = adminToken) =>
  request(app.getHttpServer())
    .post(`/tariff-plans/${id}/new-version`)
    .set(auth(token))
    .send(body);

const getPlan = async (id: string, token = adminToken, status = 200) =>
  (
    await request(app.getHttpServer())
      .get(`/tariff-plans/${id}`)
      .set(auth(token))
      .expect(status)
  ).body;

/** Two-tier WATER ladder: [0,180) @3.0, [180,∞) @4.5. */
const waterTiers = () => [
  { feeItemId: waterItem, tierNo: 1, fromQty: 0, toQty: 180, unitPrice: '3.0' },
  { feeItemId: waterItem, tierNo: 2, fromQty: 180, toQty: null, unitPrice: '4.5' },
];

beforeAll(async () => {
  await owner.connect();
  const hash = await bcrypt.hash('t8-pass', 10);

  await owner.query(
    `INSERT INTO tenant (id, code, name, status, created_at, updated_at)
     VALUES ($1, 't8-water', 'T8 Water', 'ACTIVE', now(), now()),
            ($2, 't8-other', 'T8 Other', 'ACTIVE', now(), now())
     ON CONFLICT DO NOTHING`,
    [T8A, T8B],
  );
  await owner.query(
    `INSERT INTO org_unit (id, tenant_id, parent_id, name, type, created_at, updated_at)
     VALUES ($1, $2, NULL, 'T8 Company', 'COMPANY', now(), now()),
            ($3, $4, NULL, 'T8B Company', 'COMPANY', now(), now())
     ON CONFLICT DO NOTHING`,
    [ORG_A, T8A, ORG_B, T8B],
  );
  await owner.query(
    `INSERT INTO role (id, tenant_id, code, name, data_scope, created_at, updated_at)
     VALUES ($1, $3, 'admin', 'T8 Admin', 'ALL', now(), now()),
            ($2, $3, 't8-reader', 'T8 Billing Reader', 'ORG_SUBTREE', now(), now()),
            ($6, $3, 't8-writer', 'T8 Billing Writer', 'ORG_SUBTREE', now(), now()),
            ($7, $3, 't8-metwriter', 'T8 Metering Writer', 'ORG_SUBTREE', now(), now()),
            ($4, $5, 'admin', 'T8B Admin', 'ALL', now(), now())
     ON CONFLICT DO NOTHING`,
    [ROLE_ADMIN_A, ROLE_READER_A, T8A, ROLE_B_ADMIN, T8B, ROLE_WRITER_A, ROLE_METWRITER_A],
  );
  await owner.query(
    `INSERT INTO permission (id, tenant_id, code, type, created_at, updated_at)
     VALUES ($1, $2, 'billing:read', 'ACTION', now(), now()),
            ($3, $2, 'billing:write', 'ACTION', now(), now()),
            ($4, $2, 'metering:write', 'ACTION', now(), now())
     ON CONFLICT DO NOTHING`,
    [PERM_BILL_READ, T8A, PERM_BILL_WRITE, PERM_MET_WRITE],
  );
  await owner.query(
    `INSERT INTO role_permission (tenant_id, role_id, permission_id, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now()),
            ($1, $4, $5, now(), now()),
            ($1, $6, $7, now(), now())
     ON CONFLICT DO NOTHING`,
    [
      T8A,
      ROLE_READER_A,
      PERM_BILL_READ,
      ROLE_WRITER_A,
      PERM_BILL_WRITE,
      ROLE_METWRITER_A,
      PERM_MET_WRITE,
    ],
  );
  await owner.query(
    `INSERT INTO staff (id, tenant_id, org_unit_id, login, password_hash, name, status, created_at, updated_at)
     VALUES ($1, $4, $6, 't8-admin',     $7, 'T8 Admin',     'ACTIVE', now(), now()),
            ($2, $4, $6, 't8-reader',    $7, 'T8 Reader',    'ACTIVE', now(), now()),
            ($9, $4, $6, 't8-writer',    $7, 'T8 Writer',    'ACTIVE', now(), now()),
            ($10, $4, $6,'t8-metwriter', $7, 'T8 MetWriter', 'ACTIVE', now(), now()),
            ($3, $5, $8, 't8b-admin',    $7, 'T8B Admin',    'ACTIVE', now(), now())
     ON CONFLICT (tenant_id, login) DO NOTHING`,
    [
      STAFF_ADMIN_A,
      STAFF_READER_A,
      STAFF_B_ADMIN,
      T8A,
      T8B,
      ORG_A,
      hash,
      ORG_B,
      STAFF_WRITER_A,
      STAFF_METWRITER_A,
    ],
  );
  await owner.query(
    `INSERT INTO staff_role (tenant_id, staff_id, role_id, created_at, updated_at)
     VALUES ($1, $2, $5, now(), now()),
            ($1, $3, $6, now(), now()),
            ($1, $7, $8, now(), now()),
            ($1, $9, $10, now(), now()),
            ($11, $4, $12, now(), now())
     ON CONFLICT DO NOTHING`,
    [
      T8A,
      STAFF_ADMIN_A,
      STAFF_READER_A,
      STAFF_B_ADMIN,
      ROLE_ADMIN_A,
      ROLE_READER_A,
      STAFF_WRITER_A,
      ROLE_WRITER_A,
      STAFF_METWRITER_A,
      ROLE_METWRITER_A,
      T8B,
      ROLE_B_ADMIN,
    ],
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
        .send({ tenantCode, login: login_, password: 't8-pass' })
        .expect(201)
    ).body.accessToken as string;
  adminToken = await login('t8-water', 't8-admin');
  readerToken = await login('t8-water', 't8-reader');
  writerToken = await login('t8-water', 't8-writer');
  metWriterToken = await login('t8-water', 't8-metwriter');
  tenantBToken = await login('t8-other', 't8b-admin');
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

describe('fee items', () => {
  it('creates WATER (PER_QTY) + FIXED fee items; shape + audit fields', async () => {
    const water = await createFeeItem({
      code: `WATER-${RUN}`,
      name: '水费',
      calcType: 'PER_QTY',
    }).expect(201);
    expect(water.body).toMatchObject({
      code: `WATER-${RUN}`,
      name: '水费',
      calcType: 'PER_QTY',
      tenantId: T8A,
    });
    waterItem = water.body.id;

    const fixed = await createFeeItem({
      code: `FIXED-${RUN}`,
      name: '定额费',
      calcType: 'FIXED',
    }).expect(201);
    fixedItem = fixed.body.id;
  });

  it('duplicate (tenant, code) → 409 FEE_ITEM_CODE_TAKEN', async () => {
    const res = await createFeeItem({
      code: `WATER-${RUN}`,
      name: '水费copy',
      calcType: 'PER_QTY',
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'FEE_ITEM_CODE_TAKEN', feeItemId: waterItem });
  });

  it('wire validation: missing fields / bad calcType → 400', async () => {
    for (const body of [
      {},
      { code: 'X' },
      { code: 'X', name: 'x' },
      { code: 'X', name: 'x', calcType: 'WRONG' },
    ]) {
      const res = await createFeeItem(body);
      expect(res.status).toBe(400);
    }
  });

  it('list filters + detail; ghost id → 404', async () => {
    const list = (
      await request(app.getHttpServer())
        .get(`/fee-items?calcType=PER_QTY`)
        .set(auth(adminToken))
        .expect(200)
    ).body;
    expect(list.some((f: { id: string }) => f.id === waterItem)).toBe(true);
    expect(list.some((f: { id: string }) => f.id === fixedItem)).toBe(false);

    const one = (
      await request(app.getHttpServer())
        .get(`/fee-items/${waterItem}`)
        .set(auth(adminToken))
        .expect(200)
    ).body;
    expect(one.code).toBe(`WATER-${RUN}`);
    await request(app.getHttpServer())
      .get('/fee-items/99999999-9999-4999-8999-999999999999')
      .set(auth(adminToken))
      .expect(404);
    await request(app.getHttpServer())
      .get('/fee-items?calcType=WRONG')
      .set(auth(adminToken))
      .expect(400);
  });

  it('PATCH name → 200; code/calcType → 400 immutable', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/fee-items/${waterItem}`)
      .set(auth(adminToken))
      .send({ name: '水费(居民)' })
      .expect(200);
    expect(res.body.name).toBe('水费(居民)');

    for (const body of [{ code: 'W2' }, { calcType: 'PERCENT' }]) {
      const bad = await request(app.getHttpServer())
        .patch(`/fee-items/${waterItem}`)
        .set(auth(adminToken))
        .send(body);
      expect(bad.status).toBe(400);
      expect(bad.body).toMatchObject({ code: 'FEE_ITEM_IMMUTABLE_FIELD' });
    }
    await request(app.getHttpServer())
      .patch('/fee-items/99999999-9999-4999-8999-999999999999')
      .set(auth(adminToken))
      .send({ name: 'ghost' })
      .expect(404);
  });
});

describe('tariff plan create + tier ladder validation', () => {
  const base = () => ({
    code: `RES-STD-${RUN}`,
    name: '居民标准水价',
    usageCategory: UC,
    effectiveFrom: day('2026-01-01'),
  });

  it('wire validation: missing fields / bad dates / bad tier rows → 400', async () => {
    for (const body of [
      {},
      { code: 'X', name: 'x', usageCategory: UC }, // no effectiveFrom
      { ...base(), effectiveFrom: 'not-a-date' },
      { ...base(), effectiveTo: 'also-bad' },
      { ...base(), tiers: 'nope' },
      { ...base(), tiers: [{ feeItemId: waterItem, tierNo: 1, fromQty: 0 }] }, // no unitPrice
      { ...base(), tiers: [{ feeItemId: waterItem, tierNo: 0, fromQty: 0, unitPrice: 1 }] },
      { ...base(), tiers: [{ feeItemId: 'nope', tierNo: 1, fromQty: 0, unitPrice: 1 }] },
      { ...base(), tiers: [{ feeItemId: waterItem, tierNo: 1, fromQty: -1, unitPrice: 1 }] },
      { ...base(), tiers: [{ feeItemId: waterItem, tierNo: 1, fromQty: 0, unitPrice: -5 }] },
    ]) {
      const res = await createPlan(body);
      expect(res.status).toBe(400);
    }
  });

  it('tier ladder rules: non-contiguous / first≠0 / closed last / bad range / ghost item → 400', async () => {
    const cases: [string, Record<string, unknown>[]][] = [
      // first tier must start at 0
      [
        'TIER_FROM_NOT_ZERO',
        [
          { feeItemId: waterItem, tierNo: 1, fromQty: 10, toQty: null, unitPrice: 3 },
        ],
      ],
      // gap between tier boundaries
      [
        'TIER_NOT_CONTIGUOUS',
        [
          { feeItemId: waterItem, tierNo: 1, fromQty: 0, toQty: 100, unitPrice: 3 },
          { feeItemId: waterItem, tierNo: 2, fromQty: 120, toQty: null, unitPrice: 4 },
        ],
      ],
      // last tier must be open-ended
      [
        'TIER_OPEN_ENDED_REQUIRED',
        [
          { feeItemId: waterItem, tierNo: 1, fromQty: 0, toQty: 100, unitPrice: 3 },
          { feeItemId: waterItem, tierNo: 2, fromQty: 100, toQty: 200, unitPrice: 4 },
        ],
      ],
      // toQty <= fromQty on a non-last tier
      [
        'TIER_RANGE_INVALID',
        [
          { feeItemId: waterItem, tierNo: 1, fromQty: 0, toQty: 0, unitPrice: 3 },
          { feeItemId: waterItem, tierNo: 2, fromQty: 0, toQty: null, unitPrice: 4 },
        ],
      ],
      // open-ended mid-ladder is meaningless
      [
        'TIER_RANGE_INVALID',
        [
          { feeItemId: waterItem, tierNo: 1, fromQty: 0, toQty: null, unitPrice: 3 },
          { feeItemId: waterItem, tierNo: 2, fromQty: 10, toQty: null, unitPrice: 4 },
        ],
      ],
      // same tier_no twice for one fee item
      [
        'TIER_DUPLICATE_NO',
        [
          { feeItemId: waterItem, tierNo: 1, fromQty: 0, toQty: 100, unitPrice: 3 },
          { feeItemId: waterItem, tierNo: 1, fromQty: 100, toQty: null, unitPrice: 4 },
        ],
      ],
    ];
    for (const [code, tiers] of cases) {
      const res = await createPlan({ ...base(), tiers });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code });
    }
    const ghost = await createPlan({
      ...base(),
      tiers: [
        {
          feeItemId: '99999999-9999-4999-8999-999999999999',
          tierNo: 1,
          fromQty: 0,
          toQty: null,
          unitPrice: 3,
        },
      ],
    });
    expect(ghost.status).toBe(400);
    expect(ghost.body).toMatchObject({ code: 'FEE_ITEM_NOT_FOUND' });
  });

  it('effectiveTo < effectiveFrom → 400 TARIFF_WINDOW_INVALID', async () => {
    const res = await createPlan({
      ...base(),
      effectiveTo: day('2025-12-31'),
      tiers: waterTiers(),
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'TARIFF_WINDOW_INVALID' });
  });

  it('creates DRAFT plan + tiers atomically; detail carries tiers inline', async () => {
    const res = await createPlan({ ...base(), tiers: waterTiers() }).expect(201);
    expect(res.body).toMatchObject({
      code: `RES-STD-${RUN}`,
      usageCategory: UC,
      status: 'DRAFT',
      tenantId: T8A,
    });
    expect(res.body.effectiveTo).toBeNull();
    expect(res.body.tiers).toHaveLength(2);
    plan['main'] = res.body.id;

    const detail = await getPlan(plan['main']);
    expect(detail.tiers).toHaveLength(2);
    expect(Number(detail.tiers[0].fromQty)).toBe(0);
    expect(Number(detail.tiers[0].toQty)).toBe(180);
    expect(Number(detail.tiers[0].unitPrice)).toBe(3);
    expect(detail.tiers[1].toQty).toBeNull();
    expect(Number(detail.tiers[1].unitPrice)).toBe(4.5);
  });

  it('multi-fee-item ladder: each item validated independently', async () => {
    const res = await createPlan({
      ...base(),
      code: `RES-COMBO-${RUN}`,
      effectiveFrom: day('2026-02-01'),
      tiers: [
        ...waterTiers(),
        { feeItemId: fixedItem, tierNo: 1, fromQty: 0, toQty: null, unitPrice: '2.5' },
      ],
    }).expect(201);
    expect(res.body.tiers).toHaveLength(3);
  });

  it('duplicate (tenant, code, effective_from) → 409 TARIFF_PLAN_VERSION_EXISTS', async () => {
    const res = await createPlan({ ...base(), tiers: waterTiers() });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'TARIFF_PLAN_VERSION_EXISTS' });
  });

  it('list filters by usageCategory/status; ghost detail → 404', async () => {
    const list = (
      await request(app.getHttpServer())
        .get(`/tariff-plans?usageCategory=${UC}&status=DRAFT`)
        .set(auth(adminToken))
        .expect(200)
    ).body;
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.some((p: { id: string }) => p.id === plan['main'])).toBe(true);

    const actives = (
      await request(app.getHttpServer())
        .get(`/tariff-plans?usageCategory=${UC}&status=ACTIVE`)
        .set(auth(adminToken))
        .expect(200)
    ).body;
    expect(actives).toEqual([]);

    await request(app.getHttpServer())
      .get('/tariff-plans?status=WRONG')
      .set(auth(adminToken))
      .expect(400);
    await request(app.getHttpServer())
      .get('/tariff-plans/99999999-9999-4999-8999-999999999999')
      .set(auth(adminToken))
      .expect(404);
  });
});

describe('DRAFT edits', () => {
  it('PATCH name + effectiveTo + tier replace all work on DRAFT', async () => {
    const res = await patchPlan(plan['main'], {
      name: '居民标准水价 v1',
      effectiveTo: day('2026-12-31'),
    }).expect(200);
    expect(res.body.name).toBe('居民标准水价 v1');
    expect(res.body.effectiveTo.slice(0, 10)).toBe('2026-12-31');
    expect(res.body.tiers).toHaveLength(2);

    // Tier replace: swap the ladder for a single open tier.
    const replaced = await patchPlan(plan['main'], {
      tiers: [{ feeItemId: waterItem, tierNo: 1, fromQty: 0, toQty: null, unitPrice: '3.6' }],
    }).expect(200);
    expect(replaced.body.tiers).toHaveLength(1);
    expect(Number(replaced.body.tiers[0].unitPrice)).toBe(3.6);

    // Restore the two-tier ladder for downstream tests.
    await patchPlan(plan['main'], { tiers: waterTiers() }).expect(200);
  });

  it('PATCH rejects invalid tiers (non-contiguous) with 400 — nothing written', async () => {
    const res = await patchPlan(plan['main'], {
      tiers: [
        { feeItemId: waterItem, tierNo: 1, fromQty: 0, toQty: 50, unitPrice: 3 },
        { feeItemId: waterItem, tierNo: 2, fromQty: 60, toQty: null, unitPrice: 4 },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'TIER_NOT_CONTIGUOUS' });
    const detail = await getPlan(plan['main']);
    expect(detail.tiers).toHaveLength(2); // original ladder intact
  });

  it('code/usageCategory → 400 immutable; effectiveTo < effectiveFrom → 400', async () => {
    for (const body of [{ code: 'X' }, { usageCategory: 'OTHER' }]) {
      const res = await patchPlan(plan['main'], body);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'TARIFF_IMMUTABLE_FIELD' });
    }
    const bad = await patchPlan(plan['main'], { effectiveTo: day('2025-01-01') });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: 'TARIFF_WINDOW_INVALID' });
  });
});

describe('activate + ACTIVE edit rules + overlap', () => {
  it('tierless plan refuses activation (409 TARIFF_TIERS_EMPTY)', async () => {
    const empty = await createPlan({
      code: `RES-EMPTY-${RUN}`,
      name: 'empty',
      usageCategory: UC,
      effectiveFrom: day('2026-01-01'),
      tiers: [],
    }).expect(201);
    plan['empty'] = empty.body.id;
    const res = await activate(plan['empty']);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'TARIFF_TIERS_EMPTY' });
  });

  it('activate → ACTIVE; re-activate → 409', async () => {
    const res = await activate(plan['main']).expect(201);
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.tiers).toHaveLength(2);

    const again = await activate(plan['main']);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({
      code: 'INVALID_TARIFF_STATUS_TRANSITION',
      from: 'ACTIVE',
      to: 'ACTIVE',
    });
  });

  it('PATCH name/tiers/code on ACTIVE → 409 TARIFF_FROZEN', async () => {
    for (const body of [
      { name: 'renamed' },
      { tiers: waterTiers() },
      { code: 'X' },
      { effectiveFrom: day('2026-02-01') },
    ]) {
      const res = await patchPlan(plan['main'], body);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'TARIFF_FROZEN' });
    }
  });

  it('ACTIVE allows effectiveTo shrink/close only: set → 200; extend/null/<from → 400', async () => {
    const close = await patchPlan(plan['main'], { effectiveTo: day('2026-06-30') }).expect(200);
    expect(close.body.effectiveTo.slice(0, 10)).toBe('2026-06-30');

    // Extending past the current close is a reopen — refused.
    const extend = await patchPlan(plan['main'], { effectiveTo: day('2026-12-31') });
    expect(extend.status).toBe(400);
    expect(extend.body).toMatchObject({ code: 'TARIFF_WINDOW_INVALID' });
    // Clearing the close reopens the window — refused.
    const reopen = await patchPlan(plan['main'], { effectiveTo: null });
    expect(reopen.status).toBe(400);
    // A close before the window even starts — refused.
    const beforeFrom = await patchPlan(plan['main'], { effectiveTo: day('2025-06-01') });
    expect(beforeFrom.status).toBe(400);
  });

  it('overlapping ACTIVE window of same usage_category → 409 TARIFF_WINDOW_OVERLAP', async () => {
    // plan['main'] is ACTIVE [2026-01-01, 2026-06-30); a second version of a
    // DIFFERENT code starting mid-window must not activate.
    const alt = await createPlan({
      code: `RES-ALT-${RUN}`,
      name: '居民替代价',
      usageCategory: UC,
      effectiveFrom: day('2026-04-01'),
      tiers: waterTiers(),
    }).expect(201);
    plan['alt'] = alt.body.id;

    const res = await activate(plan['alt']);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'TARIFF_WINDOW_OVERLAP',
      withPlanId: plan['main'],
    });

    // Move to the boundary — [06-30, ∞) touches but does not intersect.
    await patchPlan(plan['alt'], { effectiveFrom: day('2026-06-30') }).expect(200);
    const ok = await activate(plan['alt']).expect(201);
    expect(ok.body.status).toBe('ACTIVE');

    // A different usage_category may overlap freely.
    const other = await createPlan({
      code: `COM-${RUN}`,
      name: '商业水价',
      usageCategory: `COM-${RUN}`,
      effectiveFrom: day('2026-03-01'),
      tiers: waterTiers(),
    }).expect(201);
    await activate(other.body.id).expect(201);
    plan['other'] = other.body.id;
  });
});

describe('version freeze via POSTED bill (P0)', () => {
  it('onboards an account + inserts a POSTED bill referencing plan[main]', async () => {
    const onboard = (
      await request(app.getHttpServer())
        .post('/water-accounts/onboard')
        .set(auth(adminToken))
        .send({
          customer: { name: `T8 Cust ${RUN}`, custType: 'PERSONAL' },
          account: { usageCategory: UC, addr: 'T8 Water St' },
          meter: { brand: 't8-brand', caliber: 'DN15' },
          installation: { initialReading: 0, installedAt: day('2026-01-01') },
        })
        .expect(201)
    ).body;
    settleAccountId = onboard.settleAccount.id;
    waterAccountId = onboard.waterAccount.id;

    // A DRAFT bill on plan['alt'] proves DRAFT refs do NOT freeze.
    for (const [planId, status] of [
      [plan['alt'], 'DRAFT'],
      [plan['main'], 'POSTED'],
    ] as const) {
      await owner.query(
        `INSERT INTO bill (id, tenant_id, settle_account_id, water_account_id, period,
                           bill_kind, source_type, source_id, tariff_plan_id, status,
                           is_estimated, total_amount, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, '202601', 'NORMAL', 'MANUAL',
                 gen_random_uuid(), $4, $5, false, 12345, now(), now())`,
        [T8A, settleAccountId, waterAccountId, planId, status],
      );
    }
  });

  it('DRAFT bill does not freeze: effectiveTo shrink on plan[alt] still 200', async () => {
    const res = await patchPlan(plan['alt'], { effectiveTo: day('2026-12-31') }).expect(200);
    expect(res.body.effectiveTo.slice(0, 10)).toBe('2026-12-31');
  });

  it('POSTED bill freezes everything: name/effectiveTo/tiers PATCHes → 409 TARIFF_FROZEN', async () => {
    for (const body of [
      { name: 'try rename' },
      { effectiveTo: day('2026-05-31') },
      { tiers: waterTiers() },
    ]) {
      const res = await patchPlan(plan['main'], body);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'TARIFF_FROZEN' });
    }
    // The frozen row is unchanged.
    const detail = await getPlan(plan['main']);
    expect(detail.name).toBe('居民标准水价 v1');
    expect(detail.effectiveTo.slice(0, 10)).toBe('2026-06-30');
  });
});

describe('new-version — the repricing path', () => {
  it('copies the plan: same code, copied tiers, DRAFT, new effective_from', async () => {
    // plan['main'] is frozen+ACTIVE — new-version is exactly how you reprice it.
    const res = await newVersion(plan['main'], {
      effectiveFrom: day('2026-03-01'),
    }).expect(201);
    expect(res.body).toMatchObject({
      code: `RES-STD-${RUN}`,
      name: '居民标准水价 v1',
      usageCategory: UC,
      status: 'DRAFT',
    });
    expect(res.body.id).not.toBe(plan['main']);
    // effectiveTo copied from the source's close.
    expect(res.body.effectiveTo.slice(0, 10)).toBe('2026-06-30');
    expect(res.body.tiers).toHaveLength(2);
    expect(res.body.tiers.map((t: { tariffPlanId: string }) => t.tariffPlanId)).toEqual([
      res.body.id,
      res.body.id,
    ]);
    plan['v0301'] = res.body.id;
  });

  it('activating the copy inside the original ACTIVE window → 409 overlap', async () => {
    const res = await activate(plan['v0301']);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'TARIFF_WINDOW_OVERLAP',
      withPlanId: plan['main'],
    });
  });

  it('copied effectiveTo before new effectiveFrom → 400; explicit null opens it', async () => {
    const bad = await newVersion(plan['main'], { effectiveFrom: day('2027-01-01') });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: 'TARIFF_WINDOW_INVALID' });

    const ok = await newVersion(plan['main'], {
      effectiveFrom: day('2027-01-01'),
      effectiveTo: null,
      name: '居民标准水价 v2',
    }).expect(201);
    expect(ok.body.effectiveTo).toBeNull();
    plan['v2027'] = ok.body.id;

    // Non-overlapping: plan[main] ends 06-30, plan[alt] ends 12-31 → activates.
    await activate(plan['v2027']).expect(201);
  });

  it('supplied tiers replace the copy; bad supplied tiers → 400', async () => {
    const bad = await newVersion(plan['main'], {
      effectiveFrom: day('2027-03-01'),
      effectiveTo: null,
      tiers: [
        { feeItemId: waterItem, tierNo: 1, fromQty: 5, toQty: null, unitPrice: 3 },
      ],
    });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: 'TIER_FROM_NOT_ZERO' });

    const ok = await newVersion(plan['main'], {
      effectiveFrom: day('2027-03-01'),
      effectiveTo: null,
      tiers: [
        { feeItemId: waterItem, tierNo: 1, fromQty: 0, toQty: null, unitPrice: '9.9' },
      ],
    }).expect(201);
    expect(ok.body.tiers).toHaveLength(1);
    expect(Number(ok.body.tiers[0].unitPrice)).toBe(9.9);
    plan['v0301b'] = ok.body.id;
  });
});

describe('retire', () => {
  it('ACTIVE → RETIRED; re-retire and DRAFT-retire → 409; RETIRED edits → 409', async () => {
    const res = await retire(plan['alt']).expect(201);
    expect(res.body.status).toBe('RETIRED');

    const again = await retire(plan['alt']);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({
      code: 'INVALID_TARIFF_STATUS_TRANSITION',
      from: 'RETIRED',
      to: 'RETIRED',
    });
    const fromDraft = await retire(plan['empty']);
    expect(fromDraft.status).toBe(409);
    expect(fromDraft.body).toMatchObject({
      code: 'INVALID_TARIFF_STATUS_TRANSITION',
      from: 'DRAFT',
      to: 'RETIRED',
    });

    const edit = await patchPlan(plan['alt'], { name: 'nope' });
    expect(edit.status).toBe(409);
    expect(edit.body).toMatchObject({ code: 'TARIFF_FROZEN' });
  });

  it('new-version from RETIRED still works (copies historical version)', async () => {
    const res = await newVersion(plan['alt'], {
      effectiveFrom: day('2028-01-01'),
      effectiveTo: null,
    }).expect(201);
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.code).toBe(`RES-ALT-${RUN}`);
    expect(res.body.tiers).toHaveLength(2);
  });
});

describe('idempotency + permissions + tenant isolation', () => {
  it('Idempotency-Key replays plan create verbatim; different body same key → 409', async () => {
    const key = `t8-plan-${RUN}`;
    const body = {
      code: `IDEM-${RUN}`,
      name: '幂等水价',
      usageCategory: UC,
      effectiveFrom: day('2026-05-01'),
      tiers: waterTiers(),
    };
    const first = await request(app.getHttpServer())
      .post('/tariff-plans')
      .set(auth(adminToken))
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    const replay = await request(app.getHttpServer())
      .post('/tariff-plans')
      .set(auth(adminToken))
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    expect(replay.body.id).toBe(first.body.id);

    const clash = await request(app.getHttpServer())
      .post('/tariff-plans')
      .set(auth(adminToken))
      .set('Idempotency-Key', key)
      .send({ ...body, name: 'different' });
    expect(clash.status).toBe(409);
    expect(clash.body).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
    });
  });

  it('billing:read holder reads but cannot write (403 PERMISSION_DENIED)', async () => {
    await request(app.getHttpServer())
      .get(`/tariff-plans?usageCategory=${UC}`)
      .set(auth(readerToken))
      .expect(200);
    await request(app.getHttpServer())
      .get(`/fee-items/${waterItem}`)
      .set(auth(readerToken))
      .expect(200);

    for (const r of [
      await createFeeItem({ code: 'X', name: 'x', calcType: 'FIXED' }, readerToken),
      await createPlan(
        {
          code: `R-${RUN}`,
          name: 'x',
          usageCategory: UC,
          effectiveFrom: day('2026-01-01'),
        },
        readerToken,
      ),
      await patchPlan(plan['main'], { name: 'x' }, readerToken),
      await activate(plan['empty'], readerToken),
      await newVersion(plan['main'], { effectiveFrom: day('2029-01-01') }, readerToken),
      await retire(plan['main'], readerToken),
    ]) {
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ code: 'PERMISSION_DENIED' });
    }
  });

  it('metering:write holder cannot write tariffs (403 — wrong permission code)', async () => {
    const feeRes = await createFeeItem(
      { code: 'X', name: 'x', calcType: 'FIXED' },
      metWriterToken,
    );
    expect(feeRes.status).toBe(403);
    expect(feeRes.body).toMatchObject({ code: 'PERMISSION_DENIED' });

    const planRes = await createPlan(
      {
        code: `M-${RUN}`,
        name: 'x',
        usageCategory: UC,
        effectiveFrom: day('2026-01-01'),
      },
      metWriterToken,
    );
    expect(planRes.status).toBe(403);
    // metering:write does not include billing:read either.
    await request(app.getHttpServer())
      .get('/tariff-plans')
      .set(auth(metWriterToken))
      .expect(403);
  });

  it('billing:write holder writes (fee item + plan + patch)', async () => {
    const fee = await createFeeItem(
      { code: `W-ITEM-${RUN}`, name: 'writer项', calcType: 'PER_QTY' },
      writerToken,
    ).expect(201);
    const p = await createPlan(
      {
        code: `W-PLAN-${RUN}`,
        name: 'writer方案',
        usageCategory: UC,
        effectiveFrom: day('2026-09-01'),
        tiers: [
          { feeItemId: fee.body.id, tierNo: 1, fromQty: 0, toQty: null, unitPrice: 1 },
        ],
      },
      writerToken,
    ).expect(201);
    const patched = await patchPlan(p.body.id, { name: 'writer方案 v2' }, writerToken);
    expect(patched.status).toBe(200);
  });

  it('tenant B sees nothing of tenant A (RLS) — and A cannot use B fee items', async () => {
    // Tenant B creates its own fee item; A's list must not contain it.
    const bItem = await createFeeItem(
      { code: `B-ITEM-${RUN}`, name: 'B项', calcType: 'FIXED' },
      tenantBToken,
    ).expect(201);
    const bList = (
      await request(app.getHttpServer())
        .get('/fee-items')
        .set(auth(tenantBToken))
        .expect(200)
    ).body;
    // B sees its own item but never A's (rows from earlier runs persist).
    expect(bList.some((f: { id: string }) => f.id === bItem.body.id)).toBe(true);
    expect(bList.some((f: { id: string }) => f.id === waterItem)).toBe(false);

    const aList = (
      await request(app.getHttpServer())
        .get('/fee-items')
        .set(auth(adminToken))
        .expect(200)
    ).body;
    expect(aList.some((f: { id: string }) => f.id === bItem.body.id)).toBe(false);

    // B sees none of A's plans; A's ids 404 for B on every verb.
    const bPlans = (
      await request(app.getHttpServer())
        .get('/tariff-plans')
        .set(auth(tenantBToken))
        .expect(200)
    ).body;
    expect(
      bPlans.filter((p: { usageCategory: string }) => p.usageCategory === UC),
    ).toEqual([]);
    await request(app.getHttpServer())
      .get(`/tariff-plans/${plan['main']}`)
      .set(auth(tenantBToken))
      .expect(404);
    await patchPlan(plan['main'], { name: 'x' }, tenantBToken).expect(404);
    await activate(plan['empty'], tenantBToken).expect(404);
    await newVersion(plan['main'], { effectiveFrom: day('2029-01-01') }, tenantBToken).expect(404);
    await retire(plan['main'], tenantBToken).expect(404);
    await request(app.getHttpServer())
      .get(`/fee-items/${waterItem}`)
      .set(auth(tenantBToken))
      .expect(404);

    // Cross-tenant feeItemId inside a tier set → 400, not a leak.
    const cross = await createPlan({
      code: `XREF-${RUN}`,
      name: 'x',
      usageCategory: UC,
      effectiveFrom: day('2026-11-01'),
      tiers: [
        { feeItemId: bItem.body.id, tierNo: 1, fromQty: 0, toQty: null, unitPrice: 1 },
      ],
    });
    expect(cross.status).toBe(400);
    expect(cross.body).toMatchObject({ code: 'FEE_ITEM_NOT_FOUND' });
  });
});
