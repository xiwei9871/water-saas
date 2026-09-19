/**
 * Settlement e2e against `watersaas_test` — fixtures carry the `t7-`
 * prefix. Boots the real AppModule so JWT/permission guards, tenant ALS
 * and RLS all apply.
 *
 * Covers (Task-7 brief assertions):
 *  1. READING path: PASSED ACTUAL → component usage = end − prev
 *     (prev = initial_reading on the first settlement, then the prior
 *     component's end_reading_value); settlement FINAL via /finalize
 *  2. mid-period meter swap: REMOVED install ends at final_reading
 *     (130−100=30) + new install reads 18−0=18 → two components,
 *     totalUsageQty 48
 *  3. ESTIMATE path: NO_READ (and no-reading) → AVG3 suggestion over the
 *     last ≤3 READING-derived usages; estimate_method AUTO_AVG3;
 *     end = prev + usage (synthetic); estimate_reason mandatory
 *  4. operator override → estimate_method MANUAL; missing reason → 400;
 *     no history + no override → 400 ESTIMATE_USAGE_REQUIRED
 *  5. POST /estimate/preview → {suggestedUsage, method, basis} (ESTIMATE
 *     components are excluded from history); null when no history
 *  6. duplicate (account,period) → 409; finalize is idempotent-409;
 *     consecutiveEstimates counts the estimated streak
 *  7. Idempotency-Key replays generation; tenant B sees nothing; scoped
 *     writer 403 on out-of-scope books; metering:read can't write
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

// ---- fixtures (all prefixed t7-) ----
const T7A = 'a7a7a7a7-7777-4777-8777-a7a7a7a77777'; // tenant A
const T7B = 'b7b7b7b7-5555-4555-8555-b7b7b7b75555'; // tenant B (isolation probes)
const ORG_A = 'a7a7a7a7-0000-4000-8000-0000000000c0';
const ORG_A_BR = 'a7a7a7a7-0000-4000-8000-0000000000b1';
const ORG_B = 'b7b7b7b7-0000-4000-8000-0000000000c0';
const ROLE_ADMIN_A = 'a7a7a7a7-0000-4000-8000-00000000ad01';
const ROLE_VIEWER_A = 'a7a7a7a7-0000-4000-8000-000000001e01';
const ROLE_WRITER_A = 'a7a7a7a7-0000-4000-8000-000000001e02';
const ROLE_B_ADMIN = 'b7b7b7b7-0000-4000-8000-00000000ad01';
const PERM_MET_READ = 'a7a7a7a7-0000-4000-8000-00000000e601';
const PERM_MET_WRITE = 'a7a7a7a7-0000-4000-8000-00000000e602';
const STAFF_ADMIN_A = 'a7a7a7a7-0000-4000-8000-0000000a0001';
const STAFF_VIEWER_A = 'a7a7a7a7-0000-4000-8000-0000000b0002';
const STAFF_WRITER_A = 'a7a7a7a7-0000-4000-8000-0000000b0004';
const STAFF_B_ADMIN = 'b7b7b7b7-0000-4000-8000-0000000a0001';

const owner = new pg.Client({ connectionString: OWNER_URL });
let app: INestApplication<App>;
let adminToken = '';
let viewerToken = '';
let writerToken = '';
let tenantBToken = '';

// ids populated by the sequential suite
let bookId = '';
const acct: Record<string, string> = {}; // S=swap, E=estimate, F=fresh
const inst: Record<string, string> = {}; // ACTIVE install per account (S→old)
const plans: Record<string, { id: string; items: { id: string; waterAccountId: string }[] }> = {};
const settlement: Record<string, string> = {}; // label → settlement id

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

// Run-scoped suffix: the test DB keeps business rows + idempotency keys
// between runs, so idem keys and unique-by-name fixtures differ per run.
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

const onboard = async (label: string, installedAt: string, initialReading: number) => {
  const res = await request(app.getHttpServer())
    .post('/water-accounts/onboard')
    .set(auth(adminToken))
    .send({
      customer: { name: `T7 ${label} ${RUN}`, custType: 'PERSONAL' },
      account: { usageCategory: 'RESIDENTIAL', addr: `${label} Water St` },
      meter: { brand: 't7-brand', caliber: 'DN15' },
      installation: { initialReading, installedAt },
    })
    .expect(201);
  return res.body as {
    waterAccount: { id: string };
    meter: { id: string };
    installation: { id: string; meterId: string };
  };
};

/** Generate a plan on bookId for `period` and store it under plans[key]. */
const genPlan = async (key: string, period: string) => {
  const res = await request(app.getHttpServer())
    .post('/reading-plans/generate')
    .set(auth(adminToken))
    .send({ bookId, period, planDate: `${period.slice(0, 4)}-${period.slice(4)}-05` })
    .expect(201);
  plans[key] = { id: res.body.id, items: res.body.items };
  return plans[key];
};

const itemOf = (key: string, label: string) => {
  const item = plans[key].items.find((i) => i.waterAccountId === acct[label]);
  if (!item) throw new Error(`no plan item for ${label} in ${key}`);
  return item.id;
};

/** Enter an ACTUAL reading on the item and QC-pass it. */
const passActual = async (
  key: string,
  label: string,
  readingValue: number,
  readDate: string,
) => {
  const reading = (
    await request(app.getHttpServer())
      .post('/meter-readings')
      .set(auth(adminToken))
      .send({ planItemId: itemOf(key, label), resultType: 'ACTUAL', readingValue, readDate })
      .expect(201)
  ).body;
  await request(app.getHttpServer())
    .post(`/meter-readings/${reading.id}/qc`)
    .set(auth(adminToken))
    .send({ action: 'pass' })
    .expect(201);
  return reading;
};

const settle = (label: string, period: string, extra: Record<string, unknown> = {}) =>
  request(app.getHttpServer())
    .post('/consumption-settlements')
    .set(auth(adminToken))
    .send({ waterAccountId: acct[label], period, ...extra });

const finalize = (id: string) =>
  request(app.getHttpServer())
    .post(`/consumption-settlements/${id}/finalize`)
    .set(auth(adminToken))
    .send({});

const detail = async (id: string) =>
  (
    await request(app.getHttpServer())
      .get(`/consumption-settlements/${id}`)
      .set(auth(adminToken))
      .expect(200)
  ).body;

const componentOf = (body: { components: { installationId: string }[] }, installationId: string) => {
  const c = body.components.find((x) => x.installationId === installationId);
  if (!c) throw new Error(`no component for installation ${installationId}`);
  return c as unknown as {
    prevReadingValue: string;
    endReadingValue: string;
    usageQty: string;
    sourceType: string;
    sourceReadingId: string | null;
  };
};

beforeAll(async () => {
  await owner.connect();
  const hash = await bcrypt.hash('t7-pass', 10);

  await owner.query(
    `INSERT INTO tenant (id, code, name, status, created_at, updated_at)
     VALUES ($1, 't7-water', 'T7 Water', 'ACTIVE', now(), now()),
            ($2, 't7-other', 'T7 Other', 'ACTIVE', now(), now())
     ON CONFLICT DO NOTHING`,
    [T7A, T7B],
  );
  await owner.query(
    `INSERT INTO org_unit (id, tenant_id, parent_id, name, type, created_at, updated_at)
     VALUES ($1, $2, NULL, 'T7 Company', 'COMPANY', now(), now()),
            ($3, $4, NULL, 'T7B Company', 'COMPANY', now(), now()),
            ($5, $2, $1, 'T7 Branch', 'BRANCH', now(), now())
     ON CONFLICT DO NOTHING`,
    [ORG_A, T7A, ORG_B, T7B, ORG_A_BR],
  );
  await owner.query(
    `INSERT INTO role (id, tenant_id, code, name, data_scope, created_at, updated_at)
     VALUES ($1, $3, 'admin', 'T7 Admin', 'ALL', now(), now()),
            ($2, $3, 't7-viewer', 'T7 Viewer', 'ORG_SUBTREE', now(), now()),
            ($6, $3, 't7-writer', 'T7 Writer', 'ORG_SUBTREE', now(), now()),
            ($4, $5, 'admin', 'T7B Admin', 'ALL', now(), now())
     ON CONFLICT DO NOTHING`,
    [ROLE_ADMIN_A, ROLE_VIEWER_A, T7A, ROLE_B_ADMIN, T7B, ROLE_WRITER_A],
  );
  await owner.query(
    `INSERT INTO permission (id, tenant_id, code, type, created_at, updated_at)
     VALUES ($1, $2, 'metering:read', 'ACTION', now(), now()),
            ($3, $2, 'metering:write', 'ACTION', now(), now())
     ON CONFLICT DO NOTHING`,
    [PERM_MET_READ, T7A, PERM_MET_WRITE],
  );
  await owner.query(
    `INSERT INTO role_permission (tenant_id, role_id, permission_id, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now()),
            ($1, $4, $5, now(), now())
     ON CONFLICT DO NOTHING`,
    [T7A, ROLE_VIEWER_A, PERM_MET_READ, ROLE_WRITER_A, PERM_MET_WRITE],
  );
  await owner.query(
    `INSERT INTO staff (id, tenant_id, org_unit_id, login, password_hash, name, status, created_at, updated_at)
     VALUES ($1, $4, $6, 't7-admin',   $7, 'T7 Admin',  'ACTIVE', now(), now()),
            ($2, $4, $6, 't7-viewer',  $7, 'T7 Viewer', 'ACTIVE', now(), now()),
            ($9, $4, $10,'t7-writer',  $7, 'T7 Writer', 'ACTIVE', now(), now()),
            ($3, $5, $8, 't7b-admin',  $7, 'T7B Admin', 'ACTIVE', now(), now())
     ON CONFLICT (tenant_id, login) DO NOTHING`,
    [STAFF_ADMIN_A, STAFF_VIEWER_A, STAFF_B_ADMIN, T7A, T7B, ORG_A, hash, ORG_B, STAFF_WRITER_A, ORG_A_BR],
  );
  await owner.query(
    `INSERT INTO staff_role (tenant_id, staff_id, role_id, created_at, updated_at)
     VALUES ($1, $2, $4, now(), now()),
            ($1, $3, $5, now(), now()),
            ($1, $6, $7, now(), now()),
            ($8, $9, $10, now(), now())
     ON CONFLICT DO NOTHING`,
    [
      T7A,
      STAFF_ADMIN_A,
      STAFF_VIEWER_A,
      ROLE_ADMIN_A,
      ROLE_VIEWER_A,
      STAFF_WRITER_A,
      ROLE_WRITER_A,
      T7B,
      STAFF_B_ADMIN,
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
        .send({ tenantCode, login: login_, password: 't7-pass' })
        .expect(201)
    ).body.accessToken as string;
  adminToken = await login('t7-water', 't7-admin');
  viewerToken = await login('t7-water', 't7-viewer');
  writerToken = await login('t7-water', 't7-writer');
  tenantBToken = await login('t7-other', 't7b-admin');
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

describe('fixtures: accounts + book', () => {
  it('onboards S/E/F and builds the book', async () => {
    // S's first meter is installed 2026-08-01 at dial 100 (mid-period swap
    // scenario per spec §2.3); E/F start 2026-07-01 at dial 0.
    const s = await onboard('S', '2026-08-01', 100);
    acct['S'] = s.waterAccount.id;
    inst['S'] = s.installation.id;
    const e = await onboard('E', '2026-07-01', 0);
    acct['E'] = e.waterAccount.id;
    inst['E'] = e.installation.id;
    const f = await onboard('F', '2026-07-01', 0);
    acct['F'] = f.waterAccount.id;
    inst['F'] = f.installation.id;

    const book = await request(app.getHttpServer())
      .post('/reading-books')
      .set(auth(adminToken))
      .send({ name: `T7 Book ${RUN}`, orgUnitId: ORG_A })
      .expect(201);
    bookId = book.body.id;
    for (const label of ['S', 'E', 'F']) {
      await request(app.getHttpServer())
        .post(`/reading-books/${bookId}/meters`)
        .set(auth(adminToken))
        .send({ waterAccountId: acct[label] })
        .expect(201);
    }
  });
});

describe('READING path: first settlement + finalize', () => {
  it('wire validation: missing fields, bad period, ghost account → 400', async () => {
    for (const body of [
      {},
      { waterAccountId: acct['E'] },
      { period: '202607' },
      { waterAccountId: acct['E'], period: '20267' },
      { waterAccountId: acct['E'], period: '202613' },
      { waterAccountId: 'not-a-uuid', period: '202607' },
    ]) {
      const res = await request(app.getHttpServer())
        .post('/consumption-settlements')
        .set(auth(adminToken))
        .send(body);
      expect(res.status).toBe(400);
    }
    const ghost = await request(app.getHttpServer())
      .post('/consumption-settlements')
      .set(auth(adminToken))
      .send({ waterAccountId: '99999999-9999-4999-8999-999999999999', period: '202607' });
    expect(ghost.status).toBe(400);
    expect(ghost.body).toMatchObject({ code: 'WATER_ACCOUNT_NOT_FOUND' });
  });

  it('E 202607: PASSED ACTUAL 30 → READING component (prev=initial 0, usage 30) → finalize FINAL', async () => {
    await genPlan('p07', '202607');
    await passActual('p07', 'E', 30, '2026-07-05');

    const res = await settle('E', '202607').expect(201);
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.isEstimated).toBe(false);
    expect(res.body.estimateMethod).toBeNull();
    expect(res.body.estimateReason).toBeNull();
    expect(Number(res.body.totalUsageQty)).toBe(30);
    expect(res.body.consecutiveEstimates).toBe(0);
    expect(res.body.components).toHaveLength(1);
    const c = componentOf(res.body, inst['E']);
    expect(c).toMatchObject({
      prevReadingValue: '0',
      endReadingValue: '30',
      usageQty: '30',
      sourceType: 'READING',
    });
    expect(c.sourceReadingId).toBeTruthy();

    settlement['E07'] = res.body.id;
    const fin = await finalize(res.body.id).expect(201);
    expect(fin.body.status).toBe('FINAL');
  });

  it('duplicate (account, period) → 409 SETTLEMENT_ALREADY_EXISTS', async () => {
    const res = await settle('E', '202607');
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'SETTLEMENT_ALREADY_EXISTS',
      settlementId: settlement['E07'],
    });
  });

  it('GET list filters + detail carries components', async () => {
    const list = (
      await request(app.getHttpServer())
        .get(`/consumption-settlements?waterAccountId=${acct['E']}&period=202607`)
        .set(auth(adminToken))
        .expect(200)
    ).body;
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(settlement['E07']);
    expect(list[0].components).toHaveLength(1);

    const d = await detail(settlement['E07']);
    expect(d.period).toBe('202607');
    expect(d.components[0].installationId).toBe(inst['E']);
    await request(app.getHttpServer())
      .get('/consumption-settlements/99999999-9999-4999-8999-999999999999')
      .set(auth(adminToken))
      .expect(404);
  });
});

describe('mid-period meter swap → two components', () => {
  it('remove old meter (final 130) + install new (initial 0), read 18 on new → settle 202608 totals 48', async () => {
    // Swap mid-202608: old install ends at its recorded final_reading,
    // new install starts at 0 and gets a PASSED ACTUAL 18.
    const meter2 = (
      await request(app.getHttpServer())
        .post('/meters')
        .set(auth(adminToken))
        .send({ brand: 't7-brand', caliber: 'DN15' })
        .expect(201)
    ).body;
    await request(app.getHttpServer())
      .post(`/meter-installations/${inst['S']}/remove`)
      .set(auth(adminToken))
      .send({ finalReading: 130, removedAt: '2026-08-15' })
      .expect(201);
    inst['S2'] = (
      await request(app.getHttpServer())
        .post('/meter-installations')
        .set(auth(adminToken))
        .send({
          waterAccountId: acct['S'],
          meterId: meter2.id,
          initialReading: 0,
          installedAt: '2026-08-15',
          reason: 'REPLACE',
        })
        .expect(201)
    ).body.id;

    await genPlan('p08', '202608');
    // Entry re-resolves the CURRENT ACTIVE installation → lands on inst S2.
    const reading = await passActual('p08', 'S', 18, '2026-08-30');
    expect(reading.installationId).toBe(inst['S2']);

    const res = await settle('S', '202608').expect(201);
    expect(res.body.components).toHaveLength(2);
    expect(Number(res.body.totalUsageQty)).toBe(48);
    expect(res.body.isEstimated).toBe(false);
    expect(res.body.consecutiveEstimates).toBe(0);

    const oldC = componentOf(res.body, inst['S']);
    expect(oldC).toMatchObject({
      prevReadingValue: '100', // first settlement → initial_reading
      endReadingValue: '130', // 拆表 final_reading, not a meter_reading
      usageQty: '30',
      sourceType: 'READING',
      sourceReadingId: null,
    });
    const newC = componentOf(res.body, inst['S2']);
    expect(newC).toMatchObject({
      prevReadingValue: '0',
      endReadingValue: '18',
      usageQty: '18',
      sourceType: 'READING',
      sourceReadingId: reading.id,
    });
    settlement['S08'] = res.body.id;
  });
});

describe('ESTIMATE path: AVG3 + manual override', () => {
  it('E 202608: second PASSED reading → prev chain = prior end (30), usage 40', async () => {
    // Same plan p08 — E's item gets its own ACTUAL 70.
    await passActual('p08', 'E', 70, '2026-08-05');
    const res = await settle('E', '202608').expect(201);
    const c = componentOf(res.body, inst['E']);
    expect(c).toMatchObject({
      prevReadingValue: '30', // prior component's end_reading_value
      endReadingValue: '70',
      usageQty: '40',
      sourceType: 'READING',
    });
    settlement['E08'] = res.body.id;
    await finalize(res.body.id).expect(201);
  });

  it('missing estimate_reason on an estimated settlement → 400; then AUTO_AVG3 35 lands', async () => {
    await genPlan('p09', '202609');
    // NO_READ recorded on E's item → no valid ACTUAL → ESTIMATE path.
    await request(app.getHttpServer())
      .post('/meter-readings')
      .set(auth(adminToken))
      .send({ planItemId: itemOf('p09', 'E'), resultType: 'NO_READ', exceptionCode: 'LOCKED' })
      .expect(201);

    const noReason = await settle('E', '202609');
    expect(noReason.status).toBe(400);
    expect(noReason.body).toMatchObject({ code: 'ESTIMATE_REASON_REQUIRED' });

    const res = await settle('E', '202609', { estimateReason: 'door locked twice' }).expect(201);
    expect(res.body.isEstimated).toBe(true);
    expect(res.body.estimateMethod).toBe('AUTO_AVG3');
    expect(res.body.estimateReason).toBe('door locked twice');
    expect(res.body.consecutiveEstimates).toBe(1);
    const c = componentOf(res.body, inst['E']);
    // AVG3 over [30, 40] → 35; synthetic end keeps the chain alive.
    expect(c).toMatchObject({
      prevReadingValue: '70',
      endReadingValue: '105',
      usageQty: '35',
      sourceType: 'ESTIMATE',
      sourceReadingId: null,
    });
    const basis = res.body.estimateBasis as {
      historyUsageQtys: string[];
      componentBreakdown: { suggestedUsageQty?: string }[];
    };
    expect(basis.historyUsageQtys).toEqual(['30', '40']);
    expect(Number(basis.componentBreakdown[0].suggestedUsageQty)).toBe(35);

    settlement['E09'] = res.body.id;
  });

  it('finalize → FINAL; re-finalize → 409 INVALID_SETTLEMENT_STATUS_TRANSITION', async () => {
    const fin = await finalize(settlement['E09']).expect(201);
    expect(fin.body.status).toBe('FINAL');
    expect(fin.body.consecutiveEstimates).toBe(1);

    const again = await finalize(settlement['E09']);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({
      code: 'INVALID_SETTLEMENT_STATUS_TRANSITION',
      from: 'FINAL',
      to: 'FINAL',
    });
    await request(app.getHttpServer())
      .post('/consumption-settlements/99999999-9999-4999-8999-999999999999/finalize')
      .set(auth(adminToken))
      .send({})
      .expect(404);
  });

  it('no reading at all → ESTIMATE too; consecutiveEstimates accumulates to 2', async () => {
    // 202610: no plan entry for E at all — "无读数" is the same ESTIMATE
    // path; history stays [30,40] because ESTIMATE usages never feed AVG3.
    const res = await settle('E', '202610', { estimateReason: 'still locked' }).expect(201);
    const c = componentOf(res.body, inst['E']);
    expect(c).toMatchObject({
      prevReadingValue: '105', // synthetic end of the estimated 202609
      endReadingValue: '140',
      usageQty: '35',
      sourceType: 'ESTIMATE',
    });
    expect(res.body.consecutiveEstimates).toBe(2);
    settlement['E10'] = res.body.id;
  });

  it('operator override → estimate_method MANUAL; no history + no override → 400', async () => {
    // F has zero settled history: AVG3 suggests nothing and generation
    // refuses to silently bill — the operator must key a usage.
    const needUsage = await settle('F', '202611', { estimateReason: 'new account' });
    expect(needUsage.status).toBe(400);
    expect(needUsage.body).toMatchObject({ code: 'ESTIMATE_USAGE_REQUIRED' });

    const noReason = await settle('F', '202611', { usageQty: 12 });
    expect(noReason.status).toBe(400);
    expect(noReason.body).toMatchObject({ code: 'ESTIMATE_REASON_REQUIRED' });

    const res = await settle('F', '202611', {
      usageQty: 12,
      estimateReason: 'new account, ops estimate',
    }).expect(201);
    expect(res.body.isEstimated).toBe(true);
    expect(res.body.estimateMethod).toBe('MANUAL');
    const c = componentOf(res.body, inst['F']);
    expect(c).toMatchObject({
      prevReadingValue: '0',
      endReadingValue: '12',
      usageQty: '12',
      sourceType: 'ESTIMATE',
    });
    settlement['F11'] = res.body.id;
  });

  it('flat usageQty applies to the single estimated component; pre-period removal excluded', async () => {
    // S in 202609: the removed install is out of scope (removedAt < period
    // start), only the replacement estimates → the shorthand applies.
    const res = await settle('S', '202609', {
      usageQty: 5,
      estimateReason: 'post-swap estimate',
    }).expect(201);
    expect(res.body.components).toHaveLength(1);
    expect(res.body.estimateMethod).toBe('MANUAL');
    const c = componentOf(res.body, inst['S2']);
    expect(c).toMatchObject({
      prevReadingValue: '18', // S08's READING component end_reading_value
      endReadingValue: '23',
      usageQty: '5',
      sourceType: 'ESTIMATE',
    });
    settlement['S09'] = res.body.id;
  });

  it('flat usageQty over multiple estimates → 400; per-install overrides → MANUAL', async () => {
    // A second ACTIVE meter on F from 2027-01: two installs both estimate
    // in 202701 (installed after the 202611/202612 periods, so earlier
    // settlements stay single-install).
    const meter3 = (
      await request(app.getHttpServer())
        .post('/meters')
        .set(auth(adminToken))
        .send({ brand: 't7-brand', caliber: 'DN15' })
        .expect(201)
    ).body;
    const instF2 = (
      await request(app.getHttpServer())
        .post('/meter-installations')
        .set(auth(adminToken))
        .send({
          waterAccountId: acct['F'],
          meterId: meter3.id,
          initialReading: 0,
          installedAt: '2027-01-05',
          reason: 'NEW',
        })
        .expect(201)
    ).body.id;

    const amb = await settle('F', '202701', { usageQty: 5, estimateReason: 'x' });
    expect(amb.status).toBe(400);
    expect(amb.body).toMatchObject({ code: 'USAGE_QTY_AMBIGUOUS' });

    // Overrides may only target ESTIMATE-path installs of THIS settlement —
    // E's install belongs to another account entirely.
    const badTarget = await settle('F', '202701', {
      estimateReason: 'x',
      overrides: [{ installationId: inst['E'], usageQty: 5 }],
    });
    expect(badTarget.status).toBe(400);
    expect(badTarget.body).toMatchObject({ code: 'OVERRIDE_TARGET_INVALID' });

    const res = await settle('F', '202701', {
      estimateReason: 'two meters, ops estimate',
      overrides: [
        { installationId: inst['F'], usageQty: 5 },
        { installationId: instF2, usageQty: 7 },
      ],
    }).expect(201);
    expect(res.body.components).toHaveLength(2);
    expect(Number(res.body.totalUsageQty)).toBe(12);
    expect(res.body.estimateMethod).toBe('MANUAL');
    expect(res.body.components.every((c: { sourceType: string }) => c.sourceType === 'ESTIMATE')).toBe(true);
  });
});

describe('estimate preview', () => {
  it('E 202610 → suggestedUsage 35 over READING history [30,40]', async () => {
    const res = await request(app.getHttpServer())
      .post('/estimate/preview')
      .set(auth(adminToken))
      .send({ waterAccountId: acct['E'], period: '202610' })
      .expect(200);
    // ESTIMATE components never feed the history — [30,40] not [30,40,35].
    expect(Number(res.body.suggestedUsage)).toBe(35);
    expect(res.body.method).toBe('AUTO_AVG3');
    expect(res.body.basis.historyUsageQtys).toEqual(['30', '40']);
    expect(res.body.basis.window).toBe(3);
  });

  it('no history → suggestedUsage null; ghost/bad input → 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/estimate/preview')
      .set(auth(adminToken))
      .send({ waterAccountId: acct['F'], period: '202607' })
      .expect(200);
    expect(res.body.suggestedUsage).toBeNull();
    expect(res.body.basis.historyUsageQtys).toEqual([]);

    await request(app.getHttpServer())
      .post('/estimate/preview')
      .set(auth(adminToken))
      .send({ waterAccountId: '99999999-9999-4999-8999-999999999999', period: '202607' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/estimate/preview')
      .set(auth(adminToken))
      .send({ waterAccountId: acct['E'] })
      .expect(400);
  });
});

describe('idempotency + scope + isolation', () => {
  it('scoped writer (branch subtree) → 403 ORG_OUT_OF_SCOPE on generate/finalize', async () => {
    // F lands in p12's book (ORG_A) — outside the writer's branch subtree.
    await genPlan('p12', '202612');
    const gen = await request(app.getHttpServer())
      .post('/consumption-settlements')
      .set(auth(writerToken))
      .send({ waterAccountId: acct['F'], period: '202612', usageQty: 9, estimateReason: 'x' });
    expect(gen.status).toBe(403);
    expect(gen.body).toMatchObject({ code: 'ORG_OUT_OF_SCOPE' });

    const fin = await request(app.getHttpServer())
      .post(`/consumption-settlements/${settlement['E09']}/finalize`)
      .set(auth(writerToken))
      .send({});
    expect(fin.status).toBe(403);
    expect(fin.body).toMatchObject({ code: 'ORG_OUT_OF_SCOPE' });
  });

  it('Idempotency-Key replays generation verbatim (no double-write)', async () => {
    const key = `t7-settle-${RUN}`;
    const body = {
      waterAccountId: acct['F'],
      period: '202612',
      usageQty: 9,
      estimateReason: 'idem probe',
    };
    const first = await request(app.getHttpServer())
      .post('/consumption-settlements')
      .set(auth(adminToken))
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    const replay = await request(app.getHttpServer())
      .post('/consumption-settlements')
      .set(auth(adminToken))
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    expect(replay.body.id).toBe(first.body.id);
    settlement['F12'] = first.body.id;

    // Without the key the unique key still guards the write.
    const dup = await settle('F', '202612', { usageQty: 9, estimateReason: 'x' });
    expect(dup.status).toBe(409);
  });

  it('metering:read holder reads but cannot write (403)', async () => {
    const list = await request(app.getHttpServer())
      .get(`/consumption-settlements?waterAccountId=${acct['E']}`)
      .set(auth(viewerToken))
      .expect(200);
    expect(list.body.length).toBeGreaterThan(0);
    const res = await request(app.getHttpServer())
      .post('/consumption-settlements')
      .set(auth(viewerToken))
      .send({ waterAccountId: acct['F'], period: '202701', usageQty: 1, estimateReason: 'x' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'PERMISSION_DENIED' });
    await request(app.getHttpServer())
      .post(`/consumption-settlements/${settlement['F12']}/finalize`)
      .set(auth(viewerToken))
      .send({})
      .expect(403);
    // preview is a read — the viewer can call it.
    await request(app.getHttpServer())
      .post('/estimate/preview')
      .set(auth(viewerToken))
      .send({ waterAccountId: acct['E'], period: '202610' })
      .expect(200);
  });

  it('tenant B sees nothing of tenant A settlements (RLS)', async () => {
    const list = await request(app.getHttpServer())
      .get('/consumption-settlements')
      .set(auth(tenantBToken))
      .expect(200);
    expect(list.body).toEqual([]);
    await request(app.getHttpServer())
      .get(`/consumption-settlements/${settlement['E09']}`)
      .set(auth(tenantBToken))
      .expect(404);
    await request(app.getHttpServer())
      .post(`/consumption-settlements/${settlement['E09']}/finalize`)
      .set(auth(tenantBToken))
      .send({})
      .expect(404);
    // A's waterAccountId is invisible → generation/preview 400 not 403.
    const gen = await request(app.getHttpServer())
      .post('/consumption-settlements')
      .set(auth(tenantBToken))
      .send({ waterAccountId: acct['E'], period: '202611' });
    expect(gen.status).toBe(400);
    expect(gen.body).toMatchObject({ code: 'WATER_ACCOUNT_NOT_FOUND' });
    const prev = await request(app.getHttpServer())
      .post('/estimate/preview')
      .set(auth(tenantBToken))
      .send({ waterAccountId: acct['E'], period: '202610' });
    expect(prev.status).toBe(400);
  });
});

describe('T7 review follow-ups: supersede exclusion + rollover', () => {
  it('superseded PASSED reading is excluded — settlement uses the corrected child', async () => {
    await genPlan('x1', '202611');
    const parent = await passActual('x1', 'S', 200, '2026-11-06');
    const child = (
      await request(app.getHttpServer())
        .post(`/meter-readings/${parent.id}/supersede`)
        .set(auth(adminToken))
        .send({ readingValue: 210 })
        .expect(201)
    ).body;
    await request(app.getHttpServer())
      .post(`/meter-readings/${child.id}/qc`)
      .set(auth(adminToken))
      .send({ action: 'pass' })
      .expect(201);

    const res = await settle('S', '202611').expect(201);
    const c = componentOf(res.body, inst['S2']); // entry lands on current install
    expect(c.sourceType).toBe('READING');
    expect(c.sourceReadingId).toBe(child.id);
    expect(Number(c.endReadingValue)).toBe(210);
    // prev chain: S2's latest prior component end is 23 (202609 estimate:
    // synthetic 18 + 5), so usage = 210 − 23 = 187.
    expect(Number(c.usageQty)).toBe(187);
  });

  it('superseded parent with child still PENDING → ESTIMATE (no valid fact)', async () => {
    await genPlan('x2', '202702');
    const parent = await passActual('x2', 'S', 300, '2027-02-06');
    await request(app.getHttpServer())
      .post(`/meter-readings/${parent.id}/supersede`)
      .set(auth(adminToken))
      .send({ readingValue: 310 })
      .expect(201);
    // Child deliberately left PENDING — the parent is superseded history
    // and the child is unverdicted, so no READING source exists.
    const res = await settle('S', '202702', { estimateReason: 'correction pending QC' }).expect(201);
    const c = componentOf(res.body, inst['S2']);
    expect(c.sourceType).toBe('ESTIMATE');
    expect(res.body.isEstimated).toBe(true);
  });

  it('rollover: end < prev with maxDial → usage = (maxDial − prev) + end', async () => {
    const r = (
      await request(app.getHttpServer())
        .post('/water-accounts/onboard')
        .set(auth(adminToken))
        .send({
          customer: { name: `T7 R ${RUN}`, custType: 'PERSONAL' },
          account: { usageCategory: 'RESIDENTIAL', addr: 'R Water St' },
          meter: { brand: 't7-brand', caliber: 'DN15', maxDial: 100 },
          installation: { initialReading: 90, installedAt: '2026-10-01' },
        })
        .expect(201)
    ).body;
    acct['R'] = r.waterAccount.id;
    inst['R'] = r.installation.id;
    await request(app.getHttpServer())
      .post(`/reading-books/${bookId}/meters`)
      .set(auth(adminToken))
      .send({ waterAccountId: acct['R'] })
      .expect(201);

    await genPlan('x3', '202703');
    await passActual('x3', 'R', 15, '2027-03-06'); // 15 < prev 90 → rolled
    const res = await settle('R', '202703').expect(201);
    const c = componentOf(res.body, inst['R']);
    expect(c.sourceType).toBe('READING');
    expect(Number(c.usageQty)).toBe(25); // (100 − 90) + 15
  });
});

/**
 * RC Fix Cycle 1 — I-2 + M-1 regression.
 *
 * I-2: removing a meter dated INTO an already-finalized period must fail
 * closed — the final_reading delta above the settled chain-end would be
 * permanently unbillable (the period can't be re-settled and the next
 * period has no installation). Guard fires before ANY mutation.
 * M-1: a CLOSED water account must not gain new settlement activity —
 * create → 409 WATER_ACCOUNT_CLOSED, and a DRAFT left behind by a close
 * can't be finalized either (historical FINALs are untouched).
 */
describe('RC-fix I-2: meter removal into a finalized period fails closed', () => {
  it('FINAL-settled period → 409 SETTLEMENT_PERIOD_ALREADY_FINALIZED, installation + meter untouched', async () => {
    const a = await onboard('X1', '2035-01-01', 0);
    const st = await request(app.getHttpServer())
      .post('/consumption-settlements')
      .set(auth(adminToken))
      .send({
        waterAccountId: a.waterAccount.id,
        period: '203501',
        usageQty: 60,
        estimateReason: 'rc-i2',
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/consumption-settlements/${st.body.id}/finalize`)
      .set(auth(adminToken))
      .expect(201);

    const res = await request(app.getHttpServer())
      .post(`/meter-installations/${a.installation.id}/remove`)
      .set(auth(adminToken))
      .send({ finalReading: 999, removedAt: '2035-01-15' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'SETTLEMENT_PERIOD_ALREADY_FINALIZED' });

    // Fail-closed means literally nothing changed.
    const after = await request(app.getHttpServer())
      .get(`/meter-installations/${a.installation.id}`)
      .set(auth(adminToken))
      .expect(200);
    expect(after.body.status).toBe('ACTIVE');
    expect(after.body.finalReading).toBeNull();
    expect(after.body.removedAt).toBeNull();
    expect(after.body.meter.status).toBe('INSTALLED');
  });

  it('POSTED-billed period (no settlement row needed) → 409', async () => {
    const a = await onboard('X2', '2035-02-01', 0);
    const sa = (
      await owner.query(
        `SELECT settle_account_id::text AS id FROM water_account WHERE id = $1`,
        [a.waterAccount.id],
      )
    ).rows[0].id as string;
    await owner.query(
      `INSERT INTO bill
         (id, tenant_id, settle_account_id, water_account_id, period,
          bill_kind, source_type, source_id, status, total_amount,
          issued_at, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, '203502', 'NORMAL', 'MANUAL',
               gen_random_uuid(), 'POSTED', 5000, now(), now(), now())`,
      [T7A, sa, a.waterAccount.id],
    );

    const res = await request(app.getHttpServer())
      .post(`/meter-installations/${a.installation.id}/remove`)
      .set(auth(adminToken))
      .send({ finalReading: 999, removedAt: '2035-02-15' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'SETTLEMENT_PERIOD_ALREADY_FINALIZED' });
  });

  it('OPEN period → removal still succeeds (guard only fires on finalized periods)', async () => {
    const a = await onboard('X3', '2035-03-01', 0);
    const res = await request(app.getHttpServer())
      .post(`/meter-installations/${a.installation.id}/remove`)
      .set(auth(adminToken))
      .send({ finalReading: 25, removedAt: '2035-03-15' })
      .expect(201);
    expect(res.body.status).toBe('REMOVED');
    expect(res.body.meter.status).toBe('AVAILABLE');
  });
});

describe('RC-fix M-1: closed account gains no settlement activity', () => {
  it('settlement create on CLOSED → 409 WATER_ACCOUNT_CLOSED; orphaned DRAFT finalize → 409', async () => {
    const a = await onboard('X4', '2035-04-01', 0);
    const st = await request(app.getHttpServer())
      .post('/consumption-settlements')
      .set(auth(adminToken))
      .send({
        waterAccountId: a.waterAccount.id,
        period: '203504',
        usageQty: 10,
        estimateReason: 'rc-m1',
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/water-accounts/${a.waterAccount.id}/close`)
      .set(auth(adminToken))
      .send({})
      .expect(201);

    // The orphaned DRAFT can never finalize — the zombie chain ends here.
    const fin = await request(app.getHttpServer())
      .post(`/consumption-settlements/${st.body.id}/finalize`)
      .set(auth(adminToken));
    expect(fin.status).toBe(409);
    expect(fin.body).toMatchObject({ code: 'WATER_ACCOUNT_CLOSED' });

    // And no new settlement can be created on the closed account.
    const gen = await request(app.getHttpServer())
      .post('/consumption-settlements')
      .set(auth(adminToken))
      .send({
        waterAccountId: a.waterAccount.id,
        period: '203505',
        usageQty: 10,
        estimateReason: 'rc-m1',
      });
    expect(gen.status).toBe(409);
    expect(gen.body).toMatchObject({ code: 'WATER_ACCOUNT_CLOSED' });
  });
});
