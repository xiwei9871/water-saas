/**
 * Meter-reading e2e against `watersaas_test` — fixtures carry the `t6-`
 * prefix. Boots the real AppModule so JWT/permission guards, tenant ALS and
 * RLS all apply.
 *
 * Covers (Task-6 brief assertions):
 *  1. shape rules: NO_READ w/o exception_code → 400; ACTUAL w/o value → 400;
 *     ACTUAL + exception_code → 400; NO_READ + value → 400; bad enums → 400
 *  2. entry → item.status READ/NO_READ + completed_reading_id; plan
 *     OPEN→IN_PROGRESS on first read, →DONE when the last PENDING item lands
 *  3. re-entry on a done item → 409 ITEM_ALREADY_DONE; batch {items:[]} is
 *     one transaction; Idempotency-Key replays the same reading
 *  4. supersede: original preserved, new row carries supersedes_reading_id,
 *     item re-points at the new row; second supersede → 409 ALREADY_SUPERSEDED;
 *     NO_READ original → 409
 *  5. QC: pass → PASSED + qc_by/qc_at; re-QC a terminal state → 409;
 *     review → MANUAL_REVIEW → reject works
 *  6. CSV import: valid rows land (source=IMPORT); any bad row → 400 with a
 *     per-row failed report and NOTHING written (all-or-nothing)
 *  7. NO_ACTIVE_INSTALLATION → 400 (schema installation_id is NOT NULL —
 *     NO_READ needs a meter on the wall too); CLOSED plan → 409
 *  8. cross-tenant 404/400; org-scope writer 403; metering:read can't write
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

// ---- fixtures (all prefixed t6-) ----
const T6A = 'a6a6a6a6-6666-4666-8666-a6a6a6a66666'; // tenant A
const T6B = 'b6b6b6b6-5555-4555-8555-b6b6b6b65555'; // tenant B (cross-tenant probes)
const ORG_A = 'a6a6a6a6-0000-4000-8000-0000000000c0';
const ORG_A_BR = 'a6a6a6a6-0000-4000-8000-0000000000b1';
const ORG_B = 'b6b6b6b6-0000-4000-8000-0000000000c0';
const ROLE_ADMIN_A = 'a6a6a6a6-0000-4000-8000-00000000ad01';
const ROLE_VIEWER_A = 'a6a6a6a6-0000-4000-8000-000000001e01';
const ROLE_WRITER_A = 'a6a6a6a6-0000-4000-8000-000000001e02';
const ROLE_B_ADMIN = 'b6b6b6b6-0000-4000-8000-00000000ad01';
const PERM_MET_READ = 'a6a6a6a6-0000-4000-8000-00000000e601';
const PERM_MET_WRITE = 'a6a6a6a6-0000-4000-8000-00000000e602';
const STAFF_ADMIN_A = 'a6a6a6a6-0000-4000-8000-0000000a0001';
const STAFF_VIEWER_A = 'a6a6a6a6-0000-4000-8000-0000000b0002';
const STAFF_WRITER_A = 'a6a6a6a6-0000-4000-8000-0000000b0004';
const STAFF_B_ADMIN = 'b6b6b6b6-0000-4000-8000-0000000a0001';

const owner = new pg.Client({ connectionString: OWNER_URL });
let app: INestApplication<App>;
let adminToken = '';
let viewerToken = '';
let writerToken = '';
let tenantBToken = '';

// ids populated by the sequential suite
let bookId = '';
const acct: Record<string, string> = {}; // water_account ids A/B/C + D (no meter)
const inst: Record<string, string> = {}; // ACTIVE installation ids A/B/C
const meter: Record<string, string> = {}; // meter ids A/B/C
const plans: Record<string, { id: string; items: { id: string; waterAccountId: string }[] }> = {};

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

// Run-scoped suffix: the test DB keeps business rows + idempotency keys
// between runs, so idem keys and unique-by-name fixtures must differ per run.
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

const onboard = async (label: string) => {
  const res = await request(app.getHttpServer())
    .post('/water-accounts/onboard')
    .set(auth(adminToken))
    .send({
      customer: { name: `T6 ${label} ${RUN}`, custType: 'PERSONAL' },
      account: { usageCategory: 'RES_METERED', addr: `${label} Water St` },
      meter: { brand: 't6-brand', caliber: 'DN15' },
      installation: { initialReading: 0 },
    })
    .expect(201);
  return res.body as {
    waterAccount: { id: string };
    meter: { id: string };
    installation: { id: string; meterId: string };
  };
};

/** Generate a plan on bookId for `period` and store it under plans[key]. */
const genPlan = async (key: string, period: string, onBook = bookId) => {
  const res = await request(app.getHttpServer())
    .post('/reading-plans/generate')
    .set(auth(adminToken))
    .send({ bookId: onBook, period, planDate: `${period.slice(0, 4)}-${period.slice(4)}-05` })
    .expect(201);
  plans[key] = { id: res.body.id, items: res.body.items };
  return plans[key];
};

const itemOf = (key: string, label: string) => {
  const item = plans[key].items.find((i) => i.waterAccountId === acct[label]);
  if (!item) throw new Error(`no plan item for ${label} in ${key}`);
  return item.id;
};

const progress = async (planId: string) =>
  (
    await request(app.getHttpServer())
      .get(`/reading-plans/${planId}/progress`)
      .set(auth(adminToken))
      .expect(200)
  ).body;

beforeAll(async () => {
  await owner.connect();
  const hash = await bcrypt.hash('t6-pass', 10);

  await owner.query(
    `INSERT INTO tenant (id, code, name, status, created_at, updated_at)
     VALUES ($1, 't6-water', 'T6 Water', 'ACTIVE', now(), now()),
            ($2, 't6-other', 'T6 Other', 'ACTIVE', now(), now())
     ON CONFLICT DO NOTHING`,
    [T6A, T6B],
  );
  await owner.query(
    `INSERT INTO org_unit (id, tenant_id, parent_id, name, type, created_at, updated_at)
     VALUES ($1, $2, NULL, 'T6 Company', 'COMPANY', now(), now()),
            ($3, $4, NULL, 'T6B Company', 'COMPANY', now(), now()),
            ($5, $2, $1, 'T6 Branch', 'BRANCH', now(), now())
     ON CONFLICT DO NOTHING`,
    [ORG_A, T6A, ORG_B, T6B, ORG_A_BR],
  );
  await owner.query(
    `INSERT INTO role (id, tenant_id, code, name, data_scope, created_at, updated_at)
     VALUES ($1, $3, 'admin', 'T6 Admin', 'ALL', now(), now()),
            ($2, $3, 't6-viewer', 'T6 Viewer', 'ORG_SUBTREE', now(), now()),
            ($6, $3, 't6-writer', 'T6 Writer', 'ORG_SUBTREE', now(), now()),
            ($4, $5, 'admin', 'T6B Admin', 'ALL', now(), now())
     ON CONFLICT DO NOTHING`,
    [ROLE_ADMIN_A, ROLE_VIEWER_A, T6A, ROLE_B_ADMIN, T6B, ROLE_WRITER_A],
  );
  await owner.query(
    `INSERT INTO permission (id, tenant_id, code, type, created_at, updated_at)
     VALUES ($1, $2, 'metering:read', 'ACTION', now(), now()),
            ($3, $2, 'metering:write', 'ACTION', now(), now())
     ON CONFLICT DO NOTHING`,
    [PERM_MET_READ, T6A, PERM_MET_WRITE],
  );
  await owner.query(
    `INSERT INTO role_permission (tenant_id, role_id, permission_id, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now()),
            ($1, $4, $5, now(), now())
     ON CONFLICT DO NOTHING`,
    [T6A, ROLE_VIEWER_A, PERM_MET_READ, ROLE_WRITER_A, PERM_MET_WRITE],
  );
  await owner.query(
    `INSERT INTO staff (id, tenant_id, org_unit_id, login, password_hash, name, status, created_at, updated_at)
     VALUES ($1, $4, $6, 't6-admin',   $7, 'T6 Admin',  'ACTIVE', now(), now()),
            ($2, $4, $6, 't6-viewer',  $7, 'T6 Viewer', 'ACTIVE', now(), now()),
            ($9, $4, $10,'t6-writer',  $7, 'T6 Writer', 'ACTIVE', now(), now()),
            ($3, $5, $8, 't6b-admin',  $7, 'T6B Admin', 'ACTIVE', now(), now())
     ON CONFLICT (tenant_id, login) DO NOTHING`,
    [STAFF_ADMIN_A, STAFF_VIEWER_A, STAFF_B_ADMIN, T6A, T6B, ORG_A, hash, ORG_B, STAFF_WRITER_A, ORG_A_BR],
  );
  await owner.query(
    `INSERT INTO staff_role (tenant_id, staff_id, role_id, created_at, updated_at)
     VALUES ($1, $2, $4, now(), now()),
            ($1, $3, $5, now(), now()),
            ($1, $6, $7, now(), now()),
            ($8, $9, $10, now(), now())
     ON CONFLICT DO NOTHING`,
    [
      T6A,
      STAFF_ADMIN_A,
      STAFF_VIEWER_A,
      ROLE_ADMIN_A,
      ROLE_VIEWER_A,
      STAFF_WRITER_A,
      ROLE_WRITER_A,
      T6B,
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
        .send({ tenantCode, login: login_, password: 't6-pass' })
        .expect(201)
    ).body.accessToken as string;
  adminToken = await login('t6-water', 't6-admin');
  viewerToken = await login('t6-water', 't6-viewer');
  writerToken = await login('t6-water', 't6-writer');
  tenantBToken = await login('t6-other', 't6b-admin');
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

describe('fixtures: accounts + book + plan', () => {
  it('onboards A/B/C (meter each) + D (meterless) and builds the book', async () => {
    for (const label of ['A', 'B', 'C']) {
      const r = await onboard(label);
      acct[label] = r.waterAccount.id;
      inst[label] = r.installation.id;
      meter[label] = r.installation.meterId;
    }
    // D: water account only, no meter — for NO_ACTIVE_INSTALLATION probes
    const dCust = (
      await request(app.getHttpServer())
        .post('/customers')
        .set(auth(adminToken))
        .send({ name: `T6 D ${RUN}`, custType: 'PERSONAL' })
        .expect(201)
    ).body;
    const dSettle = (
      await request(app.getHttpServer())
        .post('/settle-accounts')
        .set(auth(adminToken))
        .send({ name: `T6 D ${RUN}` })
        .expect(201)
    ).body;
    const dAcct = (
      await request(app.getHttpServer())
        .post('/water-accounts')
        .set(auth(adminToken))
        .send({
          customerId: dCust.id,
          settleAccountId: dSettle.id,
          usageCategory: 'RES_METERED',
          addr: 'D Water St',
        })
        .expect(201)
    ).body;
    acct['D'] = dAcct.id;

    const book = await request(app.getHttpServer())
      .post('/reading-books')
      .set(auth(adminToken))
      .send({ name: `T6 Book ${RUN}`, orgUnitId: ORG_A })
      .expect(201);
    bookId = book.body.id;
    for (const label of ['A', 'B', 'C']) {
      await request(app.getHttpServer())
        .post(`/reading-books/${bookId}/meters`)
        .set(auth(adminToken))
        .send({ waterAccountId: acct[label] })
        .expect(201);
    }
  });
});

describe('reading entry — validation + item/plan writeback', () => {
  it('generate plan1 → 3 PENDING items', async () => {
    const plan = await genPlan('p1', '202610');
    expect(plan.items).toHaveLength(3);
    expect(plan.items.every((i) => (i as { status: string }).status === 'PENDING')).toBe(true);
  });

  it('shape rules: NO_READ w/o exception_code, ACTUAL w/o value, crossed fields → all 400', async () => {
    const itemId = itemOf('p1', 'A');
    const cases: { body: Record<string, unknown>; code: string }[] = [
      { body: { planItemId: itemId, resultType: 'NO_READ' }, code: 'EXCEPTION_CODE_REQUIRED' },
      { body: { planItemId: itemId, resultType: 'NO_READ', exceptionCode: 'BOGUS' }, code: 'EXCEPTION_CODE_INVALID' },
      { body: { planItemId: itemId, resultType: 'ACTUAL' }, code: 'READING_VALUE_REQUIRED' },
      { body: { planItemId: itemId, resultType: 'NO_READ', readingValue: 5, exceptionCode: 'LOCKED' }, code: 'READING_VALUE_NOT_ALLOWED' },
      { body: { planItemId: itemId, resultType: 'ACTUAL', readingValue: 5, exceptionCode: 'LOCKED' }, code: 'EXCEPTION_CODE_NOT_ALLOWED' },
      { body: { planItemId: itemId, resultType: 'ESTIMATED', readingValue: 5 }, code: 'RESULT_TYPE_INVALID' },
      { body: { planItemId: itemId, resultType: 'ACTUAL', readingValue: -3 }, code: 'INVALID_DECIMAL' },
      { body: { planItemId: itemId, resultType: 'ACTUAL', readingValue: 'abc' }, code: 'INVALID_DECIMAL' },
      { body: { planItemId: 'not-a-uuid', resultType: 'ACTUAL', readingValue: 5 }, code: 'INVALID_ID_FORMAT' },
      { body: { resultType: 'ACTUAL', readingValue: 5 }, code: 'READING_FIELDS_REQUIRED' },
    ];
    for (const c of cases) {
      const res = await request(app.getHttpServer())
        .post('/meter-readings')
        .set(auth(adminToken))
        .send(c.body);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: c.code });
    }
    // unknown-but-well-formed item → 400 PLAN_ITEM_NOT_FOUND
    const res = await request(app.getHttpServer())
      .post('/meter-readings')
      .set(auth(adminToken))
      .send({
        planItemId: '99999999-9999-4999-8999-999999999999',
        resultType: 'ACTUAL',
        readingValue: 5,
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'PLAN_ITEM_NOT_FOUND' });
  });

  it('ACTUAL entry → reading row + item READ + completed_reading_id + plan IN_PROGRESS', async () => {
    const res = await request(app.getHttpServer())
      .post('/meter-readings')
      .set(auth(adminToken))
      .send({
        planItemId: itemOf('p1', 'A'),
        resultType: 'ACTUAL',
        readingValue: 123.5,
        readDate: '2026-10-05',
        remark: ' first ',
      })
      .expect(201);
    const reading = res.body;
    expect(reading.tenantId).toBe(T6A);
    expect(reading.planItemId).toBe(itemOf('p1', 'A'));
    expect(reading.installationId).toBe(inst['A']); // re-resolved ACTIVE installation
    expect(reading.meterId).toBe(meter['A']);
    expect(reading.period).toBe('202610'); // from the plan, not the request
    expect(reading.resultType).toBe('ACTUAL');
    expect(Number(reading.readingValue)).toBe(123.5);
    expect(reading.exceptionCode).toBeNull();
    expect(reading.qcStatus).toBe('PENDING');
    expect(reading.source).toBe('WEB');
    expect(reading.operatorId).toBe(STAFF_ADMIN_A);
    expect(reading.supersedesReadingId).toBeNull();
    expect(reading.remark).toBe('first'); // trimmed

    // item flipped READ + points at the reading — same transaction
    const items = (
      await request(app.getHttpServer())
        .get(`/reading-plans/${plans['p1'].id}/items`)
        .set(auth(adminToken))
        .expect(200)
    ).body;
    const itemA = items.find((i: { waterAccountId: string }) => i.waterAccountId === acct['A']);
    expect(itemA.status).toBe('READ');
    expect(itemA.completedReadingId).toBe(reading.id);

    const p = await progress(plans['p1'].id);
    expect(p).toMatchObject({ planStatus: 'IN_PROGRESS', PENDING: 2, READ: 1 });
  });

  it('re-entry on the completed item → 409 ITEM_ALREADY_DONE', async () => {
    const res = await request(app.getHttpServer())
      .post('/meter-readings')
      .set(auth(adminToken))
      .send({ planItemId: itemOf('p1', 'A'), resultType: 'ACTUAL', readingValue: 200 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'ITEM_ALREADY_DONE', status: 'READ' });
  });

  it('NO_READ entry → item NO_READ + reading_value NULL + exception_code stored', async () => {
    const res = await request(app.getHttpServer())
      .post('/meter-readings')
      .set(auth(adminToken))
      .send({ planItemId: itemOf('p1', 'B'), resultType: 'NO_READ', exceptionCode: 'LOCKED' })
      .expect(201);
    expect(res.body.resultType).toBe('NO_READ');
    expect(res.body.readingValue).toBeNull();
    expect(res.body.exceptionCode).toBe('LOCKED');

    const items = (
      await request(app.getHttpServer())
        .get(`/reading-plans/${plans['p1'].id}/items`)
        .set(auth(adminToken))
        .expect(200)
    ).body;
    const itemB = items.find((i: { waterAccountId: string }) => i.waterAccountId === acct['B']);
    expect(itemB.status).toBe('NO_READ');
    expect(itemB.completedReadingId).toBe(res.body.id);
  });

  it('last PENDING item lands → plan DONE in the same transaction', async () => {
    const res = await request(app.getHttpServer())
      .post('/meter-readings')
      .set(auth(adminToken))
      .send({ planItemId: itemOf('p1', 'C'), resultType: 'ACTUAL', readingValue: 88 })
      .expect(201);
    expect(res.body.resultType).toBe('ACTUAL');

    const p = await progress(plans['p1'].id);
    expect(p).toMatchObject({ planStatus: 'DONE', PENDING: 0, READ: 2, NO_READ: 1, total: 3 });
  });

  it('batch {items:[...]} on plan2 commits atomically; dup planItemId → 400', async () => {
    await genPlan('p2', '202611');
    // in-batch duplicate → whole request rejected
    const dup = await request(app.getHttpServer())
      .post('/meter-readings')
      .set(auth(adminToken))
      .send({
        items: [
          { planItemId: itemOf('p2', 'A'), resultType: 'ACTUAL', readingValue: 1 },
          { planItemId: itemOf('p2', 'A'), resultType: 'ACTUAL', readingValue: 2 },
        ],
      });
    expect(dup.status).toBe(400);
    expect(dup.body).toMatchObject({ code: 'DUPLICATE_PLAN_ITEM' });

    const res = await request(app.getHttpServer())
      .post('/meter-readings')
      .set(auth(adminToken))
      .send({
        items: [
          { planItemId: itemOf('p2', 'A'), resultType: 'ACTUAL', readingValue: 11 },
          { planItemId: itemOf('p2', 'B'), resultType: 'NO_READ', exceptionCode: 'FLOODED' },
          { planItemId: itemOf('p2', 'C'), resultType: 'REMOTE', readingValue: 77 },
        ],
      })
      .expect(201);
    expect(res.body.created).toBe(3);
    expect(res.body.readings).toHaveLength(3);
    // one bad row inside the batch would roll back everything — verified by
    // progress: all three items landed together, plan is DONE.
    const p = await progress(plans['p2'].id);
    expect(p).toMatchObject({ planStatus: 'DONE', PENDING: 0, READ: 2, NO_READ: 1 });
  });

  it('Idempotency-Key on entry replays the same reading (no double-write)', async () => {
    await genPlan('p3', '202612');
    const key = `t6-read-${RUN}`;
    const body = { planItemId: itemOf('p3', 'A'), resultType: 'ACTUAL', readingValue: 55 };
    const first = await request(app.getHttpServer())
      .post('/meter-readings')
      .set(auth(adminToken))
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    const replay = await request(app.getHttpServer())
      .post('/meter-readings')
      .set(auth(adminToken))
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    expect(replay.body.id).toBe(first.body.id);

    const list = await request(app.getHttpServer())
      .get(`/meter-readings?planItemId=${itemOf('p3', 'A')}`)
      .set(auth(adminToken))
      .expect(200);
    expect(list.body).toHaveLength(1);
  });
});

describe('QC', () => {
  let readingA = '';

  beforeAll(async () => {
    const list = await request(app.getHttpServer())
      .get(`/meter-readings?planItemId=${itemOf('p1', 'A')}`)
      .set(auth(adminToken))
      .expect(200);
    readingA = list.body[0].id;
  });

  it('bad action → 400; ghost reading → 404', async () => {
    await request(app.getHttpServer())
      .post(`/meter-readings/${readingA}/qc`)
      .set(auth(adminToken))
      .send({ action: 'bogus' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/meter-readings/99999999-9999-4999-8999-999999999999/qc')
      .set(auth(adminToken))
      .send({ action: 'pass' })
      .expect(404);
  });

  it('pass → PASSED + qc_by/qc_at; re-QC a terminal state → 409; item stays READ', async () => {
    const res = await request(app.getHttpServer())
      .post(`/meter-readings/${readingA}/qc`)
      .set(auth(adminToken))
      .send({ action: 'pass' })
      .expect(201);
    expect(res.body.qcStatus).toBe('PASSED');
    expect(res.body.qcBy).toBe(STAFF_ADMIN_A);
    expect(res.body.qcAt).toBeTruthy();

    const again = await request(app.getHttpServer())
      .post(`/meter-readings/${readingA}/qc`)
      .set(auth(adminToken))
      .send({ action: 'reject' });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'INVALID_QC_STATUS_TRANSITION' });

    // QC never touches the plan item — it records "the read happened"
    const items = (
      await request(app.getHttpServer())
        .get(`/reading-plans/${plans['p1'].id}/items`)
        .set(auth(adminToken))
        .expect(200)
    ).body;
    const itemA = items.find((i: { waterAccountId: string }) => i.waterAccountId === acct['A']);
    expect(itemA.status).toBe('READ');
    expect(itemA.completedReadingId).toBe(readingA);
  });

  it('review → MANUAL_REVIEW → reject works; review→review → 409', async () => {
    const list = await request(app.getHttpServer())
      .get(`/meter-readings?planItemId=${itemOf('p1', 'C')}`)
      .set(auth(adminToken))
      .expect(200);
    const readingC = list.body[0].id;

    const rev = await request(app.getHttpServer())
      .post(`/meter-readings/${readingC}/qc`)
      .set(auth(adminToken))
      .send({ action: 'review' })
      .expect(201);
    expect(rev.body.qcStatus).toBe('MANUAL_REVIEW');

    const reReview = await request(app.getHttpServer())
      .post(`/meter-readings/${readingC}/qc`)
      .set(auth(adminToken))
      .send({ action: 'review' });
    expect(reReview.status).toBe(409);

    const rej = await request(app.getHttpServer())
      .post(`/meter-readings/${readingC}/qc`)
      .set(auth(adminToken))
      .send({ action: 'reject' })
      .expect(201);
    expect(rej.body.qcStatus).toBe('REJECTED');
  });
});

describe('supersede chain', () => {
  let original = '';
  let corrected = '';

  beforeAll(async () => {
    const list = await request(app.getHttpServer())
      .get(`/meter-readings?planItemId=${itemOf('p1', 'A')}`)
      .set(auth(adminToken))
      .expect(200);
    original = list.body[0].id;
  });

  it('supersede → new row points at original; item re-points at new row; original untouched', async () => {
    const res = await request(app.getHttpServer())
      .post(`/meter-readings/${original}/supersede`)
      .set(auth(adminToken))
      .send({ readingValue: 130.25 })
      .expect(201);
    corrected = res.body.id;
    expect(res.body.supersedesReadingId).toBe(original);
    expect(res.body.planItemId).toBe(itemOf('p1', 'A'));
    expect(res.body.installationId).toBe(inst['A']);
    expect(res.body.meterId).toBe(meter['A']);
    expect(res.body.period).toBe('202610');
    expect(res.body.resultType).toBe('ACTUAL');
    expect(Number(res.body.readingValue)).toBe(130.25);
    expect(res.body.qcStatus).toBe('PENDING'); // re-enters QC, qcBy cleared
    expect(res.body.qcBy).toBeNull();

    // original preserved verbatim (append-only history)
    const orig = await request(app.getHttpServer())
      .get(`/meter-readings/${original}`)
      .set(auth(adminToken))
      .expect(200);
    expect(Number(orig.body.readingValue)).toBe(123.5);
    expect(orig.body.qcStatus).toBe('PASSED'); // original QC verdict kept
    // T15b: hydrated supersededById marks the corrected parent (list + detail).
    expect(orig.body.supersededById).toBe(corrected);

    const listRows = (
      await request(app.getHttpServer())
        .get(`/meter-readings?planItemId=${itemOf('p1', 'A')}`)
        .set(auth(adminToken))
        .expect(200)
    ).body;
    const parent = listRows.find((r: { id: string }) => r.id === original);
    const child = listRows.find((r: { id: string }) => r.id === corrected);
    expect(parent.supersededById).toBe(corrected);
    expect(child.supersededById).toBeNull();

    // item now points at the corrected fact
    const items = (
      await request(app.getHttpServer())
        .get(`/reading-plans/${plans['p1'].id}/items`)
        .set(auth(adminToken))
        .expect(200)
    ).body;
    const itemA = items.find((i: { waterAccountId: string }) => i.waterAccountId === acct['A']);
    expect(itemA.completedReadingId).toBe(corrected);
  });

  it('second supersede on the same original → 409 ALREADY_SUPERSEDED', async () => {
    const res = await request(app.getHttpServer())
      .post(`/meter-readings/${original}/supersede`)
      .set(auth(adminToken))
      .send({ readingValue: 131 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'ALREADY_SUPERSEDED', by: corrected });
  });

  it('NO_READ original → 409 NOT_SUPERSEDABLE; missing value → 400; ghost → 404', async () => {
    const list = await request(app.getHttpServer())
      .get(`/meter-readings?planItemId=${itemOf('p1', 'B')}`)
      .set(auth(adminToken))
      .expect(200);
    const noRead = list.body[0].id;
    const res = await request(app.getHttpServer())
      .post(`/meter-readings/${noRead}/supersede`)
      .set(auth(adminToken))
      .send({ readingValue: 10 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'NOT_SUPERSEDABLE' });

    await request(app.getHttpServer())
      .post(`/meter-readings/${original}/supersede`)
      .set(auth(adminToken))
      .send({})
      .expect(400);
    await request(app.getHttpServer())
      .post('/meter-readings/99999999-9999-4999-8999-999999999999/supersede')
      .set(auth(adminToken))
      .send({ readingValue: 1 })
      .expect(404);
  });
});

describe('CSV import', () => {
  it('valid csv (with header) → created rows, source=IMPORT', async () => {
    await genPlan('p4', '202701');
    const csv = [
      'plan_item_id,result_type,reading_value,exception_code',
      `${itemOf('p4', 'A')},ACTUAL,41.5,`,
      `${itemOf('p4', 'B')},NO_READ,,LOCKED`,
    ].join('\n');
    const res = await request(app.getHttpServer())
      .post('/meter-readings/import')
      .set(auth(adminToken))
      .send({ csv })
      .expect(201);
    expect(res.body.created).toBe(2);
    expect(res.body.readings.map((r: { source: string }) => r.source)).toEqual([
      'IMPORT',
      'IMPORT',
    ]);
    const p = await progress(plans['p4'].id);
    expect(p).toMatchObject({ planStatus: 'IN_PROGRESS', PENDING: 1, READ: 1, NO_READ: 1 });
  });

  it('any bad row → 400 with failed[] and NOTHING is written (all-or-nothing)', async () => {
    await genPlan('p5', '202702');
    const ghost = '99999999-9999-4999-8999-999999999999';
    const csv = [
      `${itemOf('p5', 'A')},ACTUAL,10,`, // valid — must NOT land
      `${itemOf('p5', 'B')},WRONG,10,`,
      `${ghost},ACTUAL,5,`,
      `${itemOf('p5', 'C')},NO_READ,,`, // missing exception_code
      `only,two`,
    ].join('\n');
    const res = await request(app.getHttpServer())
      .post('/meter-readings/import')
      .set(auth(adminToken))
      .send({ csv });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'IMPORT_VALIDATION_FAILED', created: 0 });
    const codes = res.body.failed.map((f: { code: string }) => f.code).sort();
    expect(codes).toEqual([
      'EXCEPTION_CODE_REQUIRED',
      'PLAN_ITEM_NOT_FOUND',
      'RESULT_TYPE_INVALID',
      'ROW_MALFORMED',
    ]);
    // row numbers point at the real csv lines (1-based, no header present)
    expect(res.body.failed.map((f: { row: number }) => f.row)).toEqual([2, 3, 4, 5]);

    // nothing written — all three items still PENDING, and the one valid
    // row never produced a reading (checked per-item: the test DB keeps
    // rows across runs, so a period-wide query isn't run-isolated)
    const p = await progress(plans['p5'].id);
    expect(p).toMatchObject({ planStatus: 'OPEN', PENDING: 3, READ: 0 });
    const readings = await request(app.getHttpServer())
      .get(`/meter-readings?planItemId=${itemOf('p5', 'A')}`)
      .set(auth(adminToken))
      .expect(200);
    expect(readings.body).toHaveLength(0);
  });

  it('in-file duplicate plan_item_id reported; {rows:[...]} variant works', async () => {
    const csv = [
      `${itemOf('p5', 'B')},ACTUAL,10,`,
      `${itemOf('p5', 'B')},ACTUAL,11,`,
    ].join('\n');
    const dup = await request(app.getHttpServer())
      .post('/meter-readings/import')
      .set(auth(adminToken))
      .send({ csv });
    expect(dup.status).toBe(400);
    expect(dup.body.failed).toHaveLength(1);
    expect(dup.body.failed[0]).toMatchObject({ row: 2, code: 'DUPLICATE_PLAN_ITEM' });

    const res = await request(app.getHttpServer())
      .post('/meter-readings/import')
      .set(auth(adminToken))
      .send({
        rows: [
          { planItemId: itemOf('p5', 'A'), resultType: 'ACTUAL', readingValue: 12 },
          { planItemId: itemOf('p5', 'B'), resultType: 'ACTUAL', readingValue: 13 },
          { planItemId: itemOf('p5', 'C'), resultType: 'NO_READ', exceptionCode: 'OTHER' },
        ],
      })
      .expect(201);
    expect(res.body.created).toBe(3);
    const p = await progress(plans['p5'].id);
    expect(p).toMatchObject({ planStatus: 'DONE', PENDING: 0 });
  });

  it('empty import body → 400', async () => {
    await request(app.getHttpServer())
      .post('/meter-readings/import')
      .set(auth(adminToken))
      .send({})
      .expect(400);
    await request(app.getHttpServer())
      .post('/meter-readings/import')
      .set(auth(adminToken))
      .send({ csv: '   \n\n' })
      .expect(400);
  });
});

describe('edge cases: no meter / closed plan', () => {
  it('meterless account → 400 NO_ACTIVE_INSTALLATION for ACTUAL and NO_READ alike', async () => {
    const book = await request(app.getHttpServer())
      .post('/reading-books')
      .set(auth(adminToken))
      .send({ name: `T6 BookD ${RUN}`, orgUnitId: ORG_A })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/reading-books/${book.body.id}/meters`)
      .set(auth(adminToken))
      .send({ waterAccountId: acct['D'] })
      .expect(201);
    const plan = await request(app.getHttpServer())
      .post('/reading-plans/generate')
      .set(auth(adminToken))
      .send({ bookId: book.body.id, period: '202703', planDate: '2027-03-05' })
      .expect(201);
    const itemD = plan.body.items[0].id;

    for (const body of [
      { planItemId: itemD, resultType: 'ACTUAL', readingValue: 1 },
      { planItemId: itemD, resultType: 'NO_READ', exceptionCode: 'LOCKED' },
    ]) {
      // meter_reading.installation_id is NOT NULL — "到场抄不了" still
      // presumes a meter on the wall; a meterless item can't produce a fact
      // row at all, so NO_READ 400s the same way.
      const res = await request(app.getHttpServer())
        .post('/meter-readings')
        .set(auth(adminToken))
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'NO_ACTIVE_INSTALLATION' });
    }
  });

  it('entry on a CLOSED plan → 409 PLAN_NOT_OPEN', async () => {
    const plan = await genPlan('p6', '202704');
    await request(app.getHttpServer())
      .post(`/reading-plans/${plan.id}/cancel`)
      .set(auth(adminToken))
      .send({})
      .expect(201);
    const res = await request(app.getHttpServer())
      .post('/meter-readings')
      .set(auth(adminToken))
      .send({ planItemId: itemOf('p6', 'A'), resultType: 'ACTUAL', readingValue: 1 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'PLAN_NOT_OPEN', status: 'CLOSED' });
  });
});

describe('tenant isolation + permissions + scope', () => {
  it('tenant B sees nothing of tenant A readings (RLS)', async () => {
    const list = await request(app.getHttpServer())
      .get('/meter-readings')
      .set(auth(tenantBToken))
      .expect(200);
    expect(list.body).toEqual([]);
    const aReading = (
      await request(app.getHttpServer())
        .get(`/meter-readings?planItemId=${itemOf('p1', 'A')}`)
        .set(auth(adminToken))
        .expect(200)
    ).body[0];
    await request(app.getHttpServer())
      .get(`/meter-readings/${aReading.id}`)
      .set(auth(tenantBToken))
      .expect(404);
    await request(app.getHttpServer())
      .post(`/meter-readings/${aReading.id}/qc`)
      .set(auth(tenantBToken))
      .send({ action: 'pass' })
      .expect(404);
    await request(app.getHttpServer())
      .post(`/meter-readings/${aReading.id}/supersede`)
      .set(auth(tenantBToken))
      .send({ readingValue: 1 })
      .expect(404);
    // entry against A's plan item id → the item is invisible → 400
    const res = await request(app.getHttpServer())
      .post('/meter-readings')
      .set(auth(tenantBToken))
      .send({ planItemId: itemOf('p3', 'B'), resultType: 'ACTUAL', readingValue: 1 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'PLAN_ITEM_NOT_FOUND' });
  });

  it('scoped writer (branch subtree) is 403 on entry/QC/supersede against ORG_A plans', async () => {
    const aReading = (
      await request(app.getHttpServer())
        .get(`/meter-readings?planItemId=${itemOf('p1', 'A')}`)
        .set(auth(adminToken))
        .expect(200)
    ).body[0];
    const entry = await request(app.getHttpServer())
      .post('/meter-readings')
      .set(auth(writerToken))
      .send({ planItemId: itemOf('p3', 'B'), resultType: 'ACTUAL', readingValue: 1 });
    expect(entry.status).toBe(403);
    expect(entry.body).toMatchObject({ code: 'ORG_OUT_OF_SCOPE' });

    for (const [route, body] of [
      [`/meter-readings/${aReading.id}/qc`, { action: 'pass' }],
      [`/meter-readings/${aReading.id}/supersede`, { readingValue: 9 }],
    ] as const) {
      const res = await request(app.getHttpServer())
        .post(route)
        .set(auth(writerToken))
        .send(body);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'ORG_OUT_OF_SCOPE' });
    }
  });

  it('metering:read holder reads but cannot write (403)', async () => {
    const list = await request(app.getHttpServer())
      .get('/meter-readings?qcStatus=PENDING')
      .set(auth(viewerToken))
      .expect(200);
    expect(Array.isArray(list.body)).toBe(true);
    const res = await request(app.getHttpServer())
      .post('/meter-readings')
      .set(auth(viewerToken))
      .send({ planItemId: itemOf('p3', 'B'), resultType: 'ACTUAL', readingValue: 1 })
      .expect(403);
    expect(res.body).toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});

describe('T6 review follow-ups', () => {
  it('NO_READ item accepts a retry: new ACTUAL lands, item READ, old NO_READ row preserved', async () => {
    const itemId = itemOf('p3', 'B');
    const first = await request(app.getHttpServer())
      .post('/meter-readings')
      .set(auth(adminToken))
      .send({ planItemId: itemId, resultType: 'NO_READ', exceptionCode: 'LOCKED' })
      .expect(201);

    // Same-day successful visit — a fresh observation, not a supersede.
    const retry = await request(app.getHttpServer())
      .post('/meter-readings')
      .set(auth(adminToken))
      .send({ planItemId: itemId, resultType: 'ACTUAL', readingValue: 66 })
      .expect(201);
    expect(retry.body.supersedesReadingId).toBeNull();

    const items = (
      await request(app.getHttpServer())
        .get(`/reading-plans/${plans['p3'].id}/items`)
        .set(auth(adminToken))
        .expect(200)
    ).body;
    const item = items.find((i: { id: string }) => i.id === itemId);
    expect(item.status).toBe('READ');
    expect(item.completedReadingId).toBe(retry.body.id);

    // The failed visit stays as history.
    const readings = (
      await request(app.getHttpServer())
        .get(`/meter-readings?planItemId=${itemId}`)
        .set(auth(adminToken))
        .expect(200)
    ).body;
    expect(readings).toHaveLength(2);
    expect(readings.map((r: { id: string }) => r.id)).toEqual(
      expect.arrayContaining([first.body.id, retry.body.id]),
    );
  });

  it('{rows} import forces source=IMPORT even when a row claims WEB', async () => {
    const res = await request(app.getHttpServer())
      .post('/meter-readings/import')
      .set(auth(adminToken))
      .send({
        rows: [
          {
            planItemId: itemOf('p3', 'C'),
            resultType: 'ACTUAL',
            readingValue: 5,
            source: 'WEB',
          },
        ],
      })
      .expect(201);
    expect(res.body.readings[0].source).toBe('IMPORT');

    // p3's last item landed → plan DONE.
    const p = await progress(plans['p3'].id);
    expect(p.planStatus).toBe('DONE');
  });

  it('QC on a superseded reading → 409 READING_SUPERSEDED', async () => {
    const list = await request(app.getHttpServer())
      .get(`/meter-readings?planItemId=${itemOf('p1', 'A')}`)
      .set(auth(adminToken))
      .expect(200);
    const superseded = list.body.find(
      (r: { supersedesReadingId: string | null }) => r.supersedesReadingId === null,
    );
    const res = await request(app.getHttpServer())
      .post(`/meter-readings/${superseded.id}/qc`)
      .set(auth(adminToken))
      .send({ action: 'reject' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'READING_SUPERSEDED' });
  });
});

describe('v0.2: reader estimateQty on NO_READ', () => {
  it('shape rules: ACTUAL/REMOTE + estimateQty → 400; NO_READ + estimateQty accepted', async () => {
    await genPlan('p6', '202703');
    for (const c of [
      {
        body: { planItemId: itemOf('p6', 'A'), resultType: 'ACTUAL', readingValue: 5, estimateQty: 9 },
        code: 'ESTIMATE_QTY_ONLY_FOR_NO_READ',
      },
      {
        body: { planItemId: itemOf('p6', 'A'), resultType: 'NO_READ', exceptionCode: 'LOCKED', estimateQty: 'abc' },
        code: 'INVALID_DECIMAL',
      },
    ]) {
      const res = await request(app.getHttpServer())
        .post('/meter-readings')
        .set(auth(adminToken))
        .send(c.body);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: c.code });
    }

    const ok = await request(app.getHttpServer())
      .post('/meter-readings')
      .set(auth(adminToken))
      .send({ planItemId: itemOf('p6', 'A'), resultType: 'NO_READ', exceptionCode: 'LOCKED', estimateQty: 30 })
      .expect(201);
    expect(ok.body.resultType).toBe('NO_READ');
    expect(ok.body.readingValue).toBeNull();
    expect(Number(ok.body.estimateQty)).toBe(30);
  });

  it('CSV sixth column estimate_qty imports; old 4/5-column rows still work', async () => {
    await genPlan('p7', '202704');
    const csv = [
      'plan_item_id,result_type,reading_value,exception_code,read_date,estimate_qty',
      `${itemOf('p7', 'A')},ACTUAL,41.5,,,`,
      `${itemOf('p7', 'B')},NO_READ,,LOCKED,2026-04-05,22`,
      `${itemOf('p7', 'C')},NO_READ,,LOCKED`, // legacy 4-column shape
    ].join('\n');
    const res = await request(app.getHttpServer())
      .post('/meter-readings/import')
      .set(auth(adminToken))
      .send({ csv })
      .expect(201);
    expect(res.body.created).toBe(3);
    const byItem = Object.fromEntries(
      res.body.readings.map((r: { planItemId: string; estimateQty: string | null }) => [
        r.planItemId,
        r.estimateQty,
      ]),
    );
    expect(byItem[itemOf('p7', 'B')]).toBe('22');
    expect(byItem[itemOf('p7', 'C')]).toBeNull();
  });

  it('CSV ACTUAL + estimate_qty is a failed row (all-or-nothing)', async () => {
    await genPlan('p8', '202705');
    const csv = [
      `${itemOf('p8', 'A')},ACTUAL,10,,,7`, // illegal combo → row fails
      `${itemOf('p8', 'B')},NO_READ,,LOCKED,,15`, // valid — must NOT land
    ].join('\n');
    const res = await request(app.getHttpServer())
      .post('/meter-readings/import')
      .set(auth(adminToken))
      .send({ csv });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'IMPORT_VALIDATION_FAILED', created: 0 });
    expect(res.body.failed[0].code).toBe('ESTIMATE_QTY_ONLY_FOR_NO_READ');
    const p = await progress(plans['p8'].id);
    expect(p).toMatchObject({ PENDING: 3, READ: 0, NO_READ: 0 });
  });
});
