/**
 * Metering module e2e against `watersaas_test` — fixtures carry the `t5-`
 * prefix. Boots the real AppModule so JWT/permission guards, tenant ALS and
 * RLS all apply.
 *
 * Covers (Task-5 brief assertions):
 *  1. book with members A/B/C → POST /reading-plans/generate → 3 items,
 *     seq_no ordered, planned_installation_id = the account's ACTIVE
 *     installation at snapshot time
 *  2. SNAPSHOT: after generate, remove B + add D to the book → the plan's
 *     items are still A/B/C (spec §6.5)
 *  3. GET /:id/progress → {PENDING:3, READ:0, NO_READ:0, SKIPPED:0, total:3}
 *  4. same book+period generate → 409 PLAN_ALREADY_EXISTS
 *  5. cross-tenant: tenant B sees nothing of tenant A's plan (404) and
 *     cannot generate against A's book
 *  6. state machine: start OPEN→IN_PROGRESS (re-start → 409),
 *     cancel → CLOSED; cancel leaves a READ item untouched; cancelled slot
 *     frees book+period for regeneration
 *  7. account with no meter → item planned_installation_id NULL;
 *     empty book → 400 EMPTY_BOOK
 *  8. Idempotency-Key on generate: replay returns the same plan
 *  9. metering:read holder reads but cannot write (403)
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

// ---- fixtures (all prefixed t5-) ----
const T5A = '77777777-7777-4777-8777-777777777777'; // tenant A
const T5B = '88888888-8888-4888-8888-888888888888'; // tenant B (cross-tenant probes)
const ORG_A = '77777777-0000-4000-8000-0000000000c0';
const ROLE_ADMIN_A = '77777777-0000-4000-8000-00000000ad01';
const ROLE_VIEWER_A = '77777777-0000-4000-8000-000000001e01';
const PERM_MET_READ = '77777777-0000-4000-8000-00000000e601';
const STAFF_ADMIN_A = '77777777-0000-4000-8000-0000000a0001';
const STAFF_VIEWER_A = '77777777-0000-4000-8000-0000000b0002';
const STAFF_READER_A = '77777777-0000-4000-8000-0000000c0003';
// scoped-writer fixtures: metering:write at a branch that does NOT contain the book's org
const ORG_A_BR = '77777777-0000-4000-8000-0000000000b1';
const PERM_MET_WRITE = '77777777-0000-4000-8000-00000000e602';
const ROLE_WRITER_A = '77777777-0000-4000-8000-000000001e02';
const STAFF_WRITER_A = '77777777-0000-4000-8000-0000000b0004';
const ORG_B = '88888888-0000-4000-8000-0000000000c0';
const ROLE_B_ADMIN = '88888888-0000-4000-8000-00000000ad01';
const STAFF_B_ADMIN = '88888888-0000-4000-8000-0000000a0001';

const owner = new pg.Client({ connectionString: OWNER_URL });
let app: INestApplication<App>;
let adminToken = '';
let viewerToken = '';
let writerToken = '';
let tenantBToken = '';

// ids populated by the sequential suite
let bookId = '';
let bookBiId = ''; // BIMONTHLY book for the cadence suite
let planId = '';
const acct: Record<string, string> = {}; // water_account ids: A/B/C/D
const inst: Record<string, string> = {}; // ACTIVE installation ids: A/B/C

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

// Run-scoped suffix: the test DB keeps business rows + idempotency keys
// between runs, so idem keys and unique-by-name fixtures must differ per run.
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const PERIOD = '202610';
const PERIOD2 = '202611';

const onboard = async (label: string) => {
  const res = await request(app.getHttpServer())
    .post('/water-accounts/onboard')
    .set(auth(adminToken))
    .send({
      customer: { name: `T5 ${label} ${RUN}`, custType: 'PERSONAL' },
      account: { usageCategory: 'RES_METERED', addr: `${label} Water St` },
      meter: { brand: 't5-brand', caliber: 'DN15' },
      installation: { initialReading: 0 },
    })
    .expect(201);
  return res.body as {
    waterAccount: { id: string };
    installation: { id: string };
  };
};

beforeAll(async () => {
  await owner.connect();
  const hash = await bcrypt.hash('t5-pass', 10);

  await owner.query(
    `INSERT INTO tenant (id, code, name, status, created_at, updated_at)
     VALUES ($1, 't5-water', 'T5 Water', 'ACTIVE', now(), now()),
            ($2, 't5-other', 'T5 Other', 'ACTIVE', now(), now())
     ON CONFLICT DO NOTHING`,
    [T5A, T5B],
  );
  await owner.query(
    `INSERT INTO org_unit (id, tenant_id, parent_id, name, type, created_at, updated_at)
     VALUES ($1, $2, NULL, 'T5 Company', 'COMPANY', now(), now()),
            ($3, $4, NULL, 'T5B Company', 'COMPANY', now(), now()),
            ($5, $2, $1, 'T5 Branch', 'BRANCH', now(), now())
     ON CONFLICT DO NOTHING`,
    [ORG_A, T5A, ORG_B, T5B, ORG_A_BR],
  );
  await owner.query(
    `INSERT INTO role (id, tenant_id, code, name, data_scope, created_at, updated_at)
     VALUES ($1, $3, 'admin', 'T5 Admin', 'ALL', now(), now()),
            ($2, $3, 't5-viewer', 'T5 Viewer', 'ORG_SUBTREE', now(), now()),
            ($4, $5, 'admin', 'T5B Admin', 'ALL', now(), now()),
            ($6, $3, 't5-writer', 'T5 Writer', 'ORG_SUBTREE', now(), now())
     ON CONFLICT DO NOTHING`,
    [ROLE_ADMIN_A, ROLE_VIEWER_A, T5A, ROLE_B_ADMIN, T5B, ROLE_WRITER_A],
  );
  await owner.query(
    `INSERT INTO permission (id, tenant_id, code, type, created_at, updated_at)
     VALUES ($1, $2, 'metering:read', 'ACTION', now(), now()),
            ($3, $2, 'metering:write', 'ACTION', now(), now())
     ON CONFLICT DO NOTHING`,
    [PERM_MET_READ, T5A, PERM_MET_WRITE],
  );
  await owner.query(
    `INSERT INTO role_permission (tenant_id, role_id, permission_id, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now()),
            ($1, $4, $3, now(), now()),
            ($1, $4, $5, now(), now())
     ON CONFLICT DO NOTHING`,
    [T5A, ROLE_VIEWER_A, PERM_MET_READ, ROLE_WRITER_A, PERM_MET_WRITE],
  );
  await owner.query(
    `INSERT INTO staff (id, tenant_id, org_unit_id, login, password_hash, name, status, created_at, updated_at)
     VALUES ($1, $4, $6, 't5-admin',   $7, 'T5 Admin',   'ACTIVE', now(), now()),
            ($2, $4, $6, 't5-viewer',  $7, 'T5 Viewer',  'ACTIVE', now(), now()),
            ($8, $4, $6, 't5-reader',  $7, 'T5 Reader',  'ACTIVE', now(), now()),
            ($3, $5, $9, 't5b-admin',  $7, 'T5B Admin',  'ACTIVE', now(), now()),
            ($10,$4, $11,'t5-writer',  $7, 'T5 Writer',  'ACTIVE', now(), now())
     ON CONFLICT (tenant_id, login) DO NOTHING`,
    [STAFF_ADMIN_A, STAFF_VIEWER_A, STAFF_B_ADMIN, T5A, T5B, ORG_A, hash, STAFF_READER_A, ORG_B, STAFF_WRITER_A, ORG_A_BR],
  );
  await owner.query(
    `INSERT INTO staff_role (tenant_id, staff_id, role_id, created_at, updated_at)
     VALUES ($1, $2, $4, now(), now()),
            ($1, $3, $5, now(), now()),
            ($6, $7, $8, now(), now()),
            ($1, $9, $10, now(), now())
     ON CONFLICT DO NOTHING`,
    [T5A, STAFF_ADMIN_A, STAFF_VIEWER_A, ROLE_ADMIN_A, ROLE_VIEWER_A, T5B, STAFF_B_ADMIN, ROLE_B_ADMIN, STAFF_WRITER_A, ROLE_WRITER_A],
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
        .send({ tenantCode, login: login_, password: 't5-pass' })
        .expect(201)
    ).body.accessToken as string;
  adminToken = await login('t5-water', 't5-admin');
  viewerToken = await login('t5-water', 't5-viewer');
  writerToken = await login('t5-water', 't5-writer');
  tenantBToken = await login('t5-other', 't5b-admin');
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

describe('reading book CRUD + members', () => {
  it('creates a book (book_no from sys_sequence) and adds members A/B/C', async () => {
    // three accounts each with one ACTIVE installation via the onboard wizard
    for (const label of ['A', 'B', 'C']) {
      const r = await onboard(label);
      acct[label] = r.waterAccount.id;
      inst[label] = r.installation.id;
    }
    // account D: no meter at all — only an account (customer/settle reused)
    const dCust = (
      await request(app.getHttpServer())
        .post('/customers')
        .set(auth(adminToken))
        .send({ name: `T5 D ${RUN}`, custType: 'PERSONAL' })
        .expect(201)
    ).body;
    const dSettle = (
      await request(app.getHttpServer())
        .post('/settle-accounts')
        .set(auth(adminToken))
        .send({ name: `T5 D ${RUN}` })
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
      .send({ name: `T5 Book ${RUN}`, orgUnitId: ORG_A, readerId: STAFF_READER_A, scheduleDay: 5 })
      .expect(201);
    expect(book.body.tenantId).toBe(T5A);
    expect(book.body.bookNo).toMatch(/^B\d{12}$/);
    expect(book.body.readerId).toBe(STAFF_READER_A);
    bookId = book.body.id;

    for (const label of ['A', 'B', 'C']) {
      const m = await request(app.getHttpServer())
        .post(`/reading-books/${bookId}/meters`)
        .set(auth(adminToken))
        .send({ waterAccountId: acct[label] })
        .expect(201);
      expect(m.body.waterAccountId).toBe(acct[label]);
    }

    const detail = await request(app.getHttpServer())
      .get(`/reading-books/${bookId}`)
      .set(auth(adminToken))
      .expect(200);
    expect(detail.body.members.map((m: { waterAccountId: string }) => m.waterAccountId)).toEqual([
      acct['A'],
      acct['B'],
      acct['C'],
    ]);
    expect(detail.body.members.map((m: { seqNo: number }) => m.seqNo)).toEqual([1, 2, 3]);
  });

  it('rejects a duplicate member (409) and a non-member remove (404)', async () => {
    const dup = await request(app.getHttpServer())
      .post(`/reading-books/${bookId}/meters`)
      .set(auth(adminToken))
      .send({ waterAccountId: acct['A'] });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ code: 'UNIQUE_CONSTRAINT_VIOLATION' });

    const ghost = '99999999-9999-4999-8999-999999999999';
    await request(app.getHttpServer())
      .delete(`/reading-books/${bookId}/meters/${ghost}`)
      .set(auth(adminToken))
      .expect(404);
  });
});

describe('plan generation + snapshot', () => {
  it('generate → OPEN plan with 3 PENDING items, seq ordered, ACTIVE installation snapshotted', async () => {
    const res = await request(app.getHttpServer())
      .post('/reading-plans/generate')
      .set(auth(adminToken))
      .send({ bookId, period: PERIOD, planDate: '2026-10-01' })
      .expect(201);

    planId = res.body.id;
    expect(res.body.status).toBe('OPEN');
    expect(res.body.bookId).toBe(bookId);
    expect(res.body.period).toBe(PERIOD);
    expect(res.body.readerId).toBe(STAFF_READER_A); // inherited from the book

    const items = res.body.items;
    expect(items).toHaveLength(3);
    expect(items.map((i: { seqNo: number }) => i.seqNo)).toEqual([1, 2, 3]);
    expect(items.map((i: { waterAccountId: string }) => i.waterAccountId)).toEqual([
      acct['A'],
      acct['B'],
      acct['C'],
    ]);
    for (const label of ['A', 'B', 'C']) {
      const item = items.find((i: { waterAccountId: string }) => i.waterAccountId === acct[label]);
      expect(item.plannedInstallationId).toBe(inst[label]);
      expect(item.status).toBe('PENDING');
    }
  });

  it('SNAPSHOT: book loses B + gains D afterwards — plan items stay A/B/C', async () => {
    await request(app.getHttpServer())
      .delete(`/reading-books/${bookId}/meters/${acct['B']}`)
      .set(auth(adminToken))
      .expect(200);
    await request(app.getHttpServer())
      .post(`/reading-books/${bookId}/meters`)
      .set(auth(adminToken))
      .send({ waterAccountId: acct['D'] })
      .expect(201);

    // the live book is now A/C/D …
    const book = await request(app.getHttpServer())
      .get(`/reading-books/${bookId}`)
      .set(auth(adminToken))
      .expect(200);
    expect(book.body.members.map((m: { waterAccountId: string }) => m.waterAccountId)).toEqual([
      acct['A'],
      acct['C'],
      acct['D'],
    ]);

    // … but the generated plan still snapshots A/B/C
    const items = await request(app.getHttpServer())
      .get(`/reading-plans/${planId}/items`)
      .set(auth(adminToken))
      .expect(200);
    expect(items.body).toHaveLength(3);
    expect(items.body.map((i: { waterAccountId: string }) => i.waterAccountId)).toEqual([
      acct['A'],
      acct['B'],
      acct['C'],
    ]);
  });

  it('progress → {PENDING:3, READ:0, NO_READ:0, SKIPPED:0, total:3}', async () => {
    const res = await request(app.getHttpServer())
      .get(`/reading-plans/${planId}/progress`)
      .set(auth(adminToken))
      .expect(200);
    expect(res.body).toMatchObject({
      planId,
      planStatus: 'OPEN',
      PENDING: 3,
      READ: 0,
      NO_READ: 0,
      SKIPPED: 0,
      total: 3,
    });
  });

  it('duplicate generate on the same book+period → 409', async () => {
    const res = await request(app.getHttpServer())
      .post('/reading-plans/generate')
      .set(auth(adminToken))
      .send({ bookId, period: PERIOD, planDate: '2026-10-02' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'PLAN_ALREADY_EXISTS', planId });
  });

  it('Idempotency-Key replays the same plan instead of double-generating', async () => {
    const key = `t5-gen-${RUN}`;
    const body = { bookId, period: PERIOD2, planDate: '2026-11-01' };
    const first = await request(app.getHttpServer())
      .post('/reading-plans/generate')
      .set(auth(adminToken))
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);

    const replay = await request(app.getHttpServer())
      .post('/reading-plans/generate')
      .set(auth(adminToken))
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    expect(replay.body.id).toBe(first.body.id);
    expect(replay.body.items).toHaveLength(first.body.items.length);

    const plans = await owner.query(
      `SELECT count(*)::int AS n FROM reading_plan
       WHERE tenant_id = $1 AND book_id = $2 AND period = $3`,
      [T5A, bookId, PERIOD2],
    );
    expect(plans.rows[0].n).toBe(1);

    // free the slot for the lifecycle suite below — this plan is cancelled
    await request(app.getHttpServer())
      .post(`/reading-plans/${first.body.id}/cancel`)
      .set(auth(adminToken))
      .send({})
      .expect(201);
  });
});

describe('plan lifecycle', () => {
  it('start → IN_PROGRESS; second start → 409', async () => {
    const started = await request(app.getHttpServer())
      .post(`/reading-plans/${planId}/start`)
      .set(auth(adminToken))
      .send({})
      .expect(201);
    expect(started.body.status).toBe('IN_PROGRESS');

    const again = await request(app.getHttpServer())
      .post(`/reading-plans/${planId}/start`)
      .set(auth(adminToken))
      .send({});
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'INVALID_PLAN_STATUS_TRANSITION' });
  });

  it('cancel on IN_PROGRESS → CLOSED and leaves a READ item untouched; regenerate frees the slot', async () => {
    // simulate T6 having recorded a reading on item 1 (owner-level write;
    // the API surface for readings is Task 6)
    await owner.query(
      `UPDATE reading_plan_item SET status = 'READ'
       WHERE tenant_id = $1 AND plan_id = $2 AND seq_no = 1`,
      [T5A, planId],
    );

    const cancelled = await request(app.getHttpServer())
      .post(`/reading-plans/${planId}/cancel`)
      .set(auth(adminToken))
      .send({})
      .expect(201);
    expect(cancelled.body.status).toBe('CLOSED');

    // the READ item stays READ — cancel only stops the remaining work
    const item = await owner.query(
      `SELECT status::text AS s FROM reading_plan_item
       WHERE tenant_id = $1 AND plan_id = $2 AND seq_no = 1`,
      [T5A, planId],
    );
    expect(item.rows[0].s).toBe('READ');
    const progress = await request(app.getHttpServer())
      .get(`/reading-plans/${planId}/progress`)
      .set(auth(adminToken))
      .expect(200);
    expect(progress.body).toMatchObject({ PENDING: 2, READ: 1, total: 3 });

    // cancel is terminal — a second cancel → 409
    const again = await request(app.getHttpServer())
      .post(`/reading-plans/${planId}/cancel`)
      .set(auth(adminToken))
      .send({});
    expect(again.status).toBe(409);

    // a CLOSED plan frees the book+period slot for regeneration
    const regen = await request(app.getHttpServer())
      .post('/reading-plans/generate')
      .set(auth(adminToken))
      .send({ bookId, period: PERIOD, planDate: '2026-10-15' })
      .expect(201);
    expect(regen.body.id).not.toBe(planId);
    // regenerated from the CURRENT book → A/C/D (B is gone); D has no meter
    expect(regen.body.items.map((i: { waterAccountId: string }) => i.waterAccountId)).toEqual([
      acct['A'],
      acct['C'],
      acct['D'],
    ]);
    const dItem = regen.body.items.find(
      (i: { waterAccountId: string }) => i.waterAccountId === acct['D'],
    );
    expect(dItem.plannedInstallationId).toBeNull();
  });

  it('empty book → 400 EMPTY_BOOK', async () => {
    const empty = await request(app.getHttpServer())
      .post('/reading-books')
      .set(auth(adminToken))
      .send({ name: `T5 Empty ${RUN}`, orgUnitId: ORG_A })
      .expect(201);
    const res = await request(app.getHttpServer())
      .post('/reading-plans/generate')
      .set(auth(adminToken))
      .send({ bookId: empty.body.id, period: PERIOD, planDate: '2026-10-01' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'EMPTY_BOOK' });
  });

  it('malformed period → 400 (not a Prisma 500)', async () => {
    await request(app.getHttpServer())
      .post('/reading-plans/generate')
      .set(auth(adminToken))
      .send({ bookId, period: '2026-10', planDate: '2026-10-01' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/reading-plans/generate')
      .set(auth(adminToken))
      .send({ bookId, period: '202613', planDate: '2026-10-01' })
      .expect(400);
  });
});

describe('tenant isolation + permissions', () => {
  it('tenant B cannot see or touch tenant A plans/books (RLS)', async () => {
    await request(app.getHttpServer())
      .get(`/reading-plans/${planId}`)
      .set(auth(tenantBToken))
      .expect(404);
    await request(app.getHttpServer())
      .get(`/reading-plans/${planId}/items`)
      .set(auth(tenantBToken))
      .expect(404);
    await request(app.getHttpServer())
      .get(`/reading-plans/${planId}/progress`)
      .set(auth(tenantBToken))
      .expect(404);
    await request(app.getHttpServer())
      .get(`/reading-books/${bookId}`)
      .set(auth(tenantBToken))
      .expect(404);
    const list = await request(app.getHttpServer())
      .get('/reading-plans')
      .set(auth(tenantBToken))
      .expect(200);
    expect(list.body).toEqual([]);
    // generate against A's book id → RLS hides the book
    const res = await request(app.getHttpServer())
      .post('/reading-plans/generate')
      .set(auth(tenantBToken))
      .send({ bookId, period: PERIOD, planDate: '2026-10-01' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'BOOK_NOT_FOUND' });
    // transition probe on A's plan id → 404, not a state leak
    await request(app.getHttpServer())
      .post(`/reading-plans/${planId}/start`)
      .set(auth(tenantBToken))
      .send({})
      .expect(404);
  });

  it('metering:read holder reads but cannot write (403)', async () => {
    const list = await request(app.getHttpServer())
      .get('/reading-books')
      .set(auth(viewerToken))
      .expect(200);
    expect(Array.isArray(list.body)).toBe(true);
    await request(app.getHttpServer())
      .get(`/reading-plans/${planId}/progress`)
      .set(auth(viewerToken))
      .expect(200);

    const res = await request(app.getHttpServer())
      .post('/reading-plans/generate')
      .set(auth(viewerToken))
      .send({ bookId, period: PERIOD, planDate: '2026-10-01' })
      .expect(403);
    expect(res.body).toMatchObject({ code: 'PERMISSION_DENIED' });
    await request(app.getHttpServer())
      .post('/reading-books')
      .set(auth(viewerToken))
      .send({ name: 'x', orgUnitId: ORG_A })
      .expect(403);
  });
});

describe('org-scope guards on plan writes (I1)', () => {
  it('scoped writer cannot generate/start/cancel on a book outside their subtree', async () => {
    // writer's data scope is ORG_A_BR; the shared book + plan live at ORG_A.
    const gen = await request(app.getHttpServer())
      .post('/reading-plans/generate')
      .set(auth(writerToken))
      .send({ bookId, period: '202612' })
      .expect(403);
    expect(gen.body).toMatchObject({ code: 'ORG_OUT_OF_SCOPE' });

    // Scope check precedes the status check, so even the closed planId 403s.
    for (const op of ['start', 'cancel']) {
      const res = await request(app.getHttpServer())
        .post(`/reading-plans/${planId}/${op}`)
        .set(auth(writerToken))
        .expect(403);
      expect(res.body).toMatchObject({ code: 'ORG_OUT_OF_SCOPE' });
    }
  });

  it('generate skips members whose account was CLOSED after joining the book', async () => {
    const e = await onboard('E');
    const f = await onboard('F');
    const book = await request(app.getHttpServer())
      .post('/reading-books')
      .set(auth(adminToken))
      .send({ name: `T5 ClosedBook ${RUN}`, orgUnitId: ORG_A })
      .expect(201);
    for (const a of [e, f]) {
      await request(app.getHttpServer())
        .post(`/reading-books/${book.body.id}/meters`)
        .set(auth(adminToken))
        .send({ waterAccountId: a.waterAccount.id })
        .expect(201);
    }
    // F joined while NORMAL, then is closed — generation must skip it.
    // E7 close guard: detach the onboarded ACTIVE installation first.
    await owner.query(
      `UPDATE meter m SET status='AVAILABLE' FROM meter_installation mi
       WHERE mi.tenant_id=$1 AND mi.water_account_id=$2 AND mi.meter_id=m.id`,
      [T5A, f.waterAccount.id],
    );
  await owner.query(
      `UPDATE meter_installation SET status='REMOVED', final_reading=initial_reading,
             removed_at=now()
       WHERE tenant_id=$1 AND water_account_id=$2 AND status='ACTIVE'`,
      [T5A, f.waterAccount.id],
    );
    await request(app.getHttpServer())
      .post(`/water-accounts/${f.waterAccount.id}/close`)
      .set(auth(adminToken))
      .send({})
      .expect(201);

    const plan = await request(app.getHttpServer())
      .post('/reading-plans/generate')
      .set(auth(adminToken))
      .send({ bookId: book.body.id, period: '202612' })
      .expect(201);
    expect(plan.body.items).toHaveLength(1);
    expect(plan.body.items[0].waterAccountId).toBe(e.waterAccount.id);
  });
});

describe('v0.2: book cadence + due-period warning', () => {
  it('create with cadence/meterChannel persisted; invalid values → 422', async () => {
    const book = await request(app.getHttpServer())
      .post('/reading-books')
      .set(auth(adminToken))
      .send({
        name: `T5 Bi ${RUN}`,
        orgUnitId: ORG_A,
        cadence: 'BIMONTHLY',
        anchorPeriod: '202601',
        meterChannel: 'REMOTE_MANUAL',
      })
      .expect(201);
    expect(book.body.cadence).toBe('BIMONTHLY');
    expect(book.body.anchorPeriod).toBe('202601');
    expect(book.body.meterChannel).toBe('REMOTE_MANUAL');
    bookBiId = book.body.id;

    for (const [body, code] of [
      [{ name: 'x', orgUnitId: ORG_A, cadence: 'WEEKLY' }, 'INVALID_CADENCE'],
      [{ name: 'x', orgUnitId: ORG_A, meterChannel: 'LORAWAN' }, 'INVALID_METER_CHANNEL'],
      [{ name: 'x', orgUnitId: ORG_A, cadence: 'BIMONTHLY' }, 'BIMONTHLY_ANCHOR_REQUIRED'],
      [{ name: 'x', orgUnitId: ORG_A, cadence: 'BIMONTHLY', anchorPeriod: '202613' }, 'INVALID_ANCHOR_PERIOD'],
    ] as const) {
      const res = await request(app.getHttpServer())
        .post('/reading-books')
        .set(auth(adminToken))
        .send(body);
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code });
    }
  });

  it('PATCH MONTHLY→BIMONTHLY without anchor → 422; with anchor → 200', async () => {
    const book = await request(app.getHttpServer())
      .post('/reading-books')
      .set(auth(adminToken))
      .send({ name: `T5 M2B ${RUN}`, orgUnitId: ORG_A })
      .expect(201);
    const bad = await request(app.getHttpServer())
      .patch(`/reading-books/${book.body.id}`)
      .set(auth(adminToken))
      .send({ cadence: 'BIMONTHLY' });
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ code: 'BIMONTHLY_ANCHOR_REQUIRED' });
    const ok = await request(app.getHttpServer())
      .patch(`/reading-books/${book.body.id}`)
      .set(auth(adminToken))
      .send({ cadence: 'BIMONTHLY', anchorPeriod: '202602' })
      .expect(200);
    expect(ok.body.cadence).toBe('BIMONTHLY');
    expect(ok.body.anchorPeriod).toBe('202602');
  });

  it('generate on a due bimonthly period → no warning; off-cycle → cadenceWarning, still 201', async () => {
    const e = await onboard('E2');
    await request(app.getHttpServer())
      .post(`/reading-books/${bookBiId}/meters`)
      .set(auth(adminToken))
      .send({ waterAccountId: e.waterAccount.id })
      .expect(201);

    // anchor 202601 → due: 202601, 202603, …, 202701 (odd month-index parity)
    const due = await request(app.getHttpServer())
      .post('/reading-plans/generate')
      .set(auth(adminToken))
      .send({ bookId: bookBiId, period: '202603' })
      .expect(201);
    expect(due.body.cadenceWarning).toBeNull();

    const off = await request(app.getHttpServer())
      .post('/reading-plans/generate')
      .set(auth(adminToken))
      .send({ bookId: bookBiId, period: '202604' })
      .expect(201); // warn, never block — catch-up reads are legal
    expect(off.body.cadenceWarning).toBe('BOOK_NOT_DUE_THIS_PERIOD');

    // Year-boundary: 202612→202702 is one bimonthly step.
    const xYear = await request(app.getHttpServer())
      .post('/reading-plans/generate')
      .set(auth(adminToken))
      .send({ bookId: bookBiId, period: '202701' })
      .expect(201);
    expect(xYear.body.cadenceWarning).toBeNull();
    const xYearOff = await request(app.getHttpServer())
      .post('/reading-plans/generate')
      .set(auth(adminToken))
      .send({ bookId: bookBiId, period: '202612' })
      .expect(201);
    expect(xYearOff.body.cadenceWarning).toBe('BOOK_NOT_DUE_THIS_PERIOD');
  });

  it('MONTHLY book is due every period — no warning ever', async () => {
    const plan = await request(app.getHttpServer())
      .post('/reading-plans/generate')
      .set(auth(adminToken))
      .send({ bookId, period: '203001' })
      .expect(201);
    expect(plan.body.cadenceWarning).toBeNull();
  });
});
