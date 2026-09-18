/**
 * IAM e2e against `watersaas_test` (schema deployed, no seed — fixtures carry
 * the `t3-` prefix). Boots the real AppModule so global guards/interceptors
 * apply, plus a spec-local stub controller to prove `customer:write` checks.
 *
 * Covers:
 *  1. no token → 401
 *  2. login → JWT pair; GET /auth/me returns staff + role
 *  3. tenant A token + X-Tenant-Id: B → 403 (token wins)
 *  4. wrong password → 401
 *  5. DISABLED staff login → 403
 *  6. role without `customer:write` → 403
 *  7. Idempotency-Key: same key + different body → 409; same key + same body →
 *     stored response replayed, business never re-runs
 *  8. mutating requests append audit_log rows (ws_app: INSERT/SELECT only)
 *  9. POST /auth/refresh re-issues a working access token
 */
import { INestApplication, Post, Controller } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import bcrypt from 'bcrypt';
import pg from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Permissions } from '../src/common/permissions.decorator.js';
import { AppModule } from '../src/app.module.js';

// Point the app's runtime client at the TEST database before Nest builds it.
process.env.DATABASE_URL =
  process.env.DATABASE_URL_TEST ??
  'postgresql://ws_app:ws_app_pw@localhost:5432/watersaas_test';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 't3-e2e-secret';

const OWNER_URL =
  process.env.MIGRATION_DATABASE_URL_TEST ??
  'postgresql://postgres:postgres@localhost:5432/watersaas_test';

// ---- fixtures (all prefixed t3-) ----
const T3 = '33333333-3333-4333-8333-333333333333'; // tenant A
const T3B = '44444444-4444-4444-8444-444444444444'; // tenant B (mismatch check)
const ORG_CO = '33333333-0000-4000-8000-0000000000c0';
const ORG_BR = '33333333-0000-4000-8000-0000000000b1';
const ROLE_ADMIN = '33333333-0000-4000-8000-00000000ad01';
const ROLE_LIMITED = '33333333-0000-4000-8000-000000001e01';
const PERM_READ = '33333333-0000-4000-8000-00000000e601';
const STAFF_ADMIN = '33333333-0000-4000-8000-0000000a0001';
const STAFF_VIEWER = '33333333-0000-4000-8000-0000000b0002';
const STAFF_DISABLED = '33333333-0000-4000-8000-0000000d0003';

/** Spec-local route proving a non-IAM permission code is enforced. */
@Controller('e2e-customer')
class CustomerStubController {
  @Post()
  @Permissions('customer:write')
  create() {
    return { ok: true };
  }
}

const owner = new pg.Client({ connectionString: OWNER_URL });
let app: INestApplication<App>;
let adminToken = '';
let viewerToken = '';
let refreshToken = '';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  await owner.connect();
  const hash = await bcrypt.hash('t3-pass', 10);
  const disabledHash = await bcrypt.hash('t3-pass', 10);

  await owner.query(
    `INSERT INTO tenant (id, code, name, status, created_at, updated_at)
     VALUES ($1, 't3-water', 'T3 Water', 'ACTIVE', now(), now()),
            ($2, 't3-other', 'T3 Other', 'ACTIVE', now(), now())
     ON CONFLICT DO NOTHING`,
    [T3, T3B],
  );
  await owner.query(
    `INSERT INTO org_unit (id, tenant_id, parent_id, name, type, created_at, updated_at)
     VALUES ($1, $3, NULL, 'T3 Company', 'COMPANY', now(), now()),
            ($2, $3, $1, 'T3 Branch', 'BRANCH', now(), now())
     ON CONFLICT DO NOTHING`,
    [ORG_CO, ORG_BR, T3],
  );
  await owner.query(
    `INSERT INTO role (id, tenant_id, code, name, data_scope, created_at, updated_at)
     VALUES ($1, $3, 'admin', 'T3 Admin', 'ALL', now(), now()),
            ($2, $3, 't3-limited', 'T3 Limited', 'ORG_SUBTREE', now(), now())
     ON CONFLICT DO NOTHING`,
    [ROLE_ADMIN, ROLE_LIMITED, T3],
  );
  await owner.query(
    `INSERT INTO permission (id, tenant_id, code, type, created_at, updated_at)
     VALUES ($1, $2, 'iam:read', 'ACTION', now(), now()) ON CONFLICT DO NOTHING`,
    [PERM_READ, T3],
  );
  await owner.query(
    `INSERT INTO role_permission (tenant_id, role_id, permission_id, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now()) ON CONFLICT DO NOTHING`,
    [T3, ROLE_LIMITED, PERM_READ],
  );
  await owner.query(
    `INSERT INTO staff (id, tenant_id, org_unit_id, login, password_hash, name, status, created_at, updated_at)
     VALUES ($1, $4, $5, 't3-admin',   $7, 'T3 Admin',    'ACTIVE',   now(), now()),
            ($2, $4, $6, 't3-viewer',  $7, 'T3 Viewer',   'ACTIVE',   now(), now()),
            ($3, $4, $5, 't3-disabled',$8, 'T3 Disabled', 'DISABLED', now(), now())
     ON CONFLICT (tenant_id, login) DO NOTHING`,
    [STAFF_ADMIN, STAFF_VIEWER, STAFF_DISABLED, T3, ORG_CO, ORG_BR, hash, disabledHash],
  );
  await owner.query(
    `INSERT INTO staff_role (tenant_id, staff_id, role_id, created_at, updated_at)
     VALUES ($1, $2, $4, now(), now()), ($1, $3, $5, now(), now()), ($1, $6, $4, now(), now())
     ON CONFLICT DO NOTHING`,
    [T3, STAFF_ADMIN, STAFF_VIEWER, ROLE_ADMIN, ROLE_LIMITED, STAFF_DISABLED],
  );

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [CustomerStubController],
  }).compile();
  app = moduleFixture.createNestApplication();
  await app.init();
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

describe('auth flow', () => {
  it('rejects requests without a token (401)', async () => {
    await request(app.getHttpServer()).get('/auth/me').expect(401);
    await request(app.getHttpServer()).get('/iam/staff').expect(401);
  });

  it('rejects wrong credentials (401)', async () => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantCode: 't3-water', login: 't3-admin', password: 'wrong' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantCode: 'no-such-tenant', login: 't3-admin', password: 't3-pass' })
      .expect(401);
  });

  it('rejects a DISABLED staff login (403)', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantCode: 't3-water', login: 't3-disabled', password: 't3-pass' })
      .expect(403);
    expect(res.body).toMatchObject({ code: 'STAFF_DISABLED' });
  });

  it('logs in and returns staff + role via /auth/me', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantCode: 't3-water', login: 't3-admin', password: 't3-pass' })
      .expect(201);
    expect(login.body.accessToken).toBeTruthy();
    expect(login.body.refreshToken).toBeTruthy();
    adminToken = login.body.accessToken;
    refreshToken = login.body.refreshToken;

    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(me.body.login).toBe('t3-admin');
    expect(me.body.tenantId).toBe(T3);
    expect(me.body.roles.map((r: { code: string }) => r.code)).toContain('admin');
    expect(me.body.perms).toContain('*');

    const viewer = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantCode: 't3-water', login: 't3-viewer', password: 't3-pass' })
      .expect(201);
    viewerToken = viewer.body.accessToken;
    expect(viewer.body.perms).toEqual(['iam:read']);
  });

  it('rejects X-Tenant-Id that disagrees with the token (403)', async () => {
    const res = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Tenant-Id', T3B)
      .expect(403);
    expect(res.body).toMatchObject({ code: 'TENANT_MISMATCH' });
  });

  it('re-issues a working access token via /auth/refresh', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken })
      .expect(201);
    expect(res.body.accessToken).toBeTruthy();
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${res.body.accessToken}`)
      .expect(200);
  });
});

describe('permissions', () => {
  it('enforces @Permissions codes — viewer lacks customer:write (403)', async () => {
    const res = await request(app.getHttpServer())
      .post('/e2e-customer')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({})
      .expect(403);
    expect(res.body).toMatchObject({ code: 'PERMISSION_DENIED' });
    // admin's '*' perm passes the same check
    await request(app.getHttpServer())
      .post('/e2e-customer')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(201);
  });

  it('viewer can read but not write IAM resources', async () => {
    await request(app.getHttpServer())
      .get('/iam/staff')
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post('/iam/staff')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ login: 'x', name: 'x', password: 'x', orgUnitId: ORG_BR })
      .expect(403);
  });
});

describe('idempotency', () => {
  it('same key + different body → 409; same key + same body → replayed', async () => {
    const key = 't3-idem-1';
    const bodyA = { login: 't3-idem1', name: 'Idem One', password: 'x', orgUnitId: ORG_BR };
    const bodyB = { login: 't3-idem2', name: 'Idem Two', password: 'x', orgUnitId: ORG_BR };

    const first = await request(app.getHttpServer())
      .post('/iam/staff')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', key)
      .send(bodyA)
      .expect(201);
    expect(first.body.id).toBeTruthy();

    const conflict = await request(app.getHttpServer())
      .post('/iam/staff')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', key)
      .send(bodyB)
      .expect(409);
    expect(conflict.body).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
    });

    const replay = await request(app.getHttpServer())
      .post('/iam/staff')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', key)
      .send(bodyA)
      .expect(201);
    expect(replay.body.id).toBe(first.body.id);

    // business ran exactly once
    const dup = await owner.query(
      `SELECT count(*)::int AS n FROM staff WHERE tenant_id = $1 AND login = 't3-idem1'`,
      [T3],
    );
    expect(dup.rows[0].n).toBe(1);
  });
});

describe('audit log', () => {
  it('appends an audit_log row after a mutating request', async () => {
    // The interceptor writes fire-and-forget after the response — poll briefly.
    let n = 0;
    for (let i = 0; i < 30; i++) {
      const res = await owner.query(
        `SELECT count(*)::int AS n FROM audit_log
         WHERE tenant_id = $1 AND action = 'POST /iam/staff' AND entity = 'staff'`,
        [T3],
      );
      n = res.rows[0].n;
      if (n > 0) break;
      await sleep(100);
    }
    expect(n).toBeGreaterThan(0);
  });
});
