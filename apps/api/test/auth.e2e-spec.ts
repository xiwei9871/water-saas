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
// (PrismaClient is constructed lazily at app init, so this lands in time.
// JWT_SECRET would NOT work here — JwtModule reads env at module-evaluation
// time, before spec top-level code runs; the suite uses the dev fallback
// secret deliberately.)
process.env.DATABASE_URL =
  process.env.DATABASE_URL_TEST ??
  'postgresql://ws_app:ws_app_pw@localhost:5432/watersaas_test';

const OWNER_URL =
  process.env.MIGRATION_DATABASE_URL_TEST ??
  'postgresql://postgres:postgres@localhost:5432/watersaas_test';

// ---- fixtures (all prefixed t3-) ----
const T3 = '33333333-3333-4333-8333-333333333333'; // tenant A
const T3B = '44444444-4444-4444-8444-444444444444'; // tenant B (mismatch + suspend)
const ORG_CO = '33333333-0000-4000-8000-0000000000c0';
const ORG_BR = '33333333-0000-4000-8000-0000000000b1';
const ROLE_ADMIN = '33333333-0000-4000-8000-00000000ad01';
const ROLE_LIMITED = '33333333-0000-4000-8000-000000001e01';
const PERM_READ = '33333333-0000-4000-8000-00000000e601';
const STAFF_ADMIN = '33333333-0000-4000-8000-0000000a0001';
const STAFF_VIEWER = '33333333-0000-4000-8000-0000000b0002';
const STAFF_DISABLED = '33333333-0000-4000-8000-0000000d0003';
// non-admin writer: holds iam:read+iam:write but NOT '*' — the escalation attacker
const PERM_WRITE = '33333333-0000-4000-8000-00000000e602';
const ROLE_WRITER = '33333333-0000-4000-8000-000000001e02';
const ROLE_ALLSCOPE = '33333333-0000-4000-8000-000000001e03'; // non-admin, dataScope ALL
const STAFF_WRITER = '33333333-0000-4000-8000-0000000b0004';
// tenant B fixtures — used to prove refresh dies when the tenant is suspended
const ORG_B = '44444444-0000-4000-8000-0000000000c0';
const ROLE_B_ADMIN = '44444444-0000-4000-8000-00000000ad01';
const STAFF_B_ADMIN = '44444444-0000-4000-8000-0000000a0001';

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
let writerToken = '';
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
     VALUES ($1, $2, 'iam:read', 'ACTION', now(), now()),
            ($3, $2, 'iam:write', 'ACTION', now(), now())
     ON CONFLICT DO NOTHING`,
    [PERM_READ, T3, PERM_WRITE],
  );
  await owner.query(
    `INSERT INTO role_permission (tenant_id, role_id, permission_id, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now()) ON CONFLICT DO NOTHING`,
    [T3, ROLE_LIMITED, PERM_READ],
  );
  // writer role: iam:read + iam:write (no '*')
  await owner.query(
    `INSERT INTO role (id, tenant_id, code, name, data_scope, created_at, updated_at)
     VALUES ($1, $3, 't3-writer', 'T3 Writer', 'ORG_SUBTREE', now(), now()),
            ($2, $3, 't3-notadmin', 'T3 AllScope', 'ALL', now(), now())
     ON CONFLICT DO NOTHING`,
    [ROLE_WRITER, ROLE_ALLSCOPE, T3],
  );
  await owner.query(
    `INSERT INTO role_permission (tenant_id, role_id, permission_id, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now()), ($1, $2, $4, now(), now())
     ON CONFLICT DO NOTHING`,
    [T3, ROLE_WRITER, PERM_READ, PERM_WRITE],
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
  // writer staff: iam:read+iam:write via t3-writer role, ORG_SUBTREE at branch
  await owner.query(
    `INSERT INTO staff (id, tenant_id, org_unit_id, login, password_hash, name, status, created_at, updated_at)
     VALUES ($1, $2, $3, 't3-writer', $4, 'T3 Writer', 'ACTIVE', now(), now())
     ON CONFLICT (tenant_id, login) DO NOTHING`,
    [STAFF_WRITER, T3, ORG_BR, hash],
  );
  // heal drift: a previous spec run may have rebound the writer's roles
  await owner.query(
    `DELETE FROM staff_role WHERE tenant_id = $1 AND staff_id = $2 AND role_id <> $3`,
    [T3, STAFF_WRITER, ROLE_WRITER],
  );
  await owner.query(
    `INSERT INTO staff_role (tenant_id, staff_id, role_id, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now()) ON CONFLICT DO NOTHING`,
    [T3, STAFF_WRITER, ROLE_WRITER],
  );
  // tenant B: org + admin role + admin staff (suspension regression fixtures)
  await owner.query(
    `INSERT INTO org_unit (id, tenant_id, parent_id, name, type, created_at, updated_at)
     VALUES ($1, $2, NULL, 'T3B Company', 'COMPANY', now(), now()) ON CONFLICT DO NOTHING`,
    [ORG_B, T3B],
  );
  await owner.query(
    `INSERT INTO role (id, tenant_id, code, name, data_scope, created_at, updated_at)
     VALUES ($1, $2, 'admin', 'T3B Admin', 'ALL', now(), now()) ON CONFLICT DO NOTHING`,
    [ROLE_B_ADMIN, T3B],
  );
  await owner.query(
    `INSERT INTO staff (id, tenant_id, org_unit_id, login, password_hash, name, status, created_at, updated_at)
     VALUES ($1, $2, $3, 't3b-admin', $4, 'T3B Admin', 'ACTIVE', now(), now())
     ON CONFLICT (tenant_id, login) DO NOTHING`,
    [STAFF_B_ADMIN, T3B, ORG_B, hash],
  );
  await owner.query(
    `INSERT INTO staff_role (tenant_id, staff_id, role_id, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now()) ON CONFLICT DO NOTHING`,
    [T3B, STAFF_B_ADMIN, ROLE_B_ADMIN],
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

    const writer = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantCode: 't3-water', login: 't3-writer', password: 't3-pass' })
      .expect(201);
    writerToken = writer.body.accessToken;
    expect(writer.body.perms.sort()).toEqual(['iam:read', 'iam:write']);
    expect(writer.body.perms).not.toContain('*');
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

  it('refresh dies with 403 TENANT_SUSPENDED once the tenant is suspended', async () => {
    // self-healing: a previous run may have left T3B suspended
    await owner.query(`UPDATE tenant SET status = 'ACTIVE' WHERE id = $1`, [T3B]);
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantCode: 't3-other', login: 't3b-admin', password: 't3-pass' })
      .expect(201);
    const rtB = login.body.refreshToken;

    // sanity: refresh works while ACTIVE
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: rtB })
      .expect(201);

    // suspend the tenant — the same refresh token must now be refused
    await owner.query(`UPDATE tenant SET status = 'SUSPENDED' WHERE id = $1`, [T3B]);
    const res = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: rtB })
      .expect(403);
    expect(res.body).toMatchObject({ code: 'TENANT_SUSPENDED' });
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

/**
 * Privilege-escalation chain (F1, uniform admin-only model): the whole
 * role-management surface AND staff role binding are grant surfaces — a
 * non-admin iam:write user must not mint scope/permissions nor bind roles
 * (self-assign → re-login → tenant takeover). All of them → 403
 * ADMIN_REQUIRED. Delegated writes (staff profile fields inside the
 * caller's subtree) still work.
 */
describe('privilege-escalation guards', () => {
  it('role management is admin-only — create + patch + delete', async () => {
    const create = await request(app.getHttpServer())
      .post('/iam/roles')
      .set('Authorization', `Bearer ${writerToken}`)
      .send({ code: 't3-evil', name: 'Evil', dataScope: 'ALL' })
      .expect(403);
    expect(create.body).toMatchObject({ code: 'ADMIN_REQUIRED' });

    const patch = await request(app.getHttpServer())
      .patch(`/iam/roles/${ROLE_LIMITED}`)
      .set('Authorization', `Bearer ${writerToken}`)
      .send({ dataScope: 'ALL' })
      .expect(403);
    expect(patch.body).toMatchObject({ code: 'ADMIN_REQUIRED' });

    const del = await request(app.getHttpServer())
      .delete(`/iam/roles/${ROLE_LIMITED}`)
      .set('Authorization', `Bearer ${writerToken}`)
      .expect(403);
    expect(del.body).toMatchObject({ code: 'ADMIN_REQUIRED' });

    // admin CAN still manage roles (control case)
    await request(app.getHttpServer())
      .patch(`/iam/roles/${ROLE_LIMITED}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ dataScope: 'ALL' })
      .expect(200);
    // restore — later tests assume ROLE_LIMITED stays ORG_SUBTREE
    await request(app.getHttpServer())
      .patch(`/iam/roles/${ROLE_LIMITED}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ dataScope: 'ORG_SUBTREE' })
      .expect(200);
  });

  it('permission binding is admin-only', async () => {
    const res = await request(app.getHttpServer())
      .put(`/iam/roles/${ROLE_LIMITED}/permissions`)
      .set('Authorization', `Bearer ${writerToken}`)
      .send({ permissionIds: [PERM_READ] })
      .expect(403);
    expect(res.body).toMatchObject({ code: 'ADMIN_REQUIRED' });
  });

  it('staff role binding is admin-only — even for a plain ORG_SUBTREE role', async () => {
    // ANY roleIds on PATCH is a grant surface → admin (not just privileged
    // roles — the uniform model doesn't let non-admins bind at all)
    for (const roleId of [ROLE_ADMIN, ROLE_ALLSCOPE, ROLE_LIMITED]) {
      const res = await request(app.getHttpServer())
        .patch(`/iam/staff/${STAFF_WRITER}`)
        .set('Authorization', `Bearer ${writerToken}`)
        .send({ roleIds: [roleId] })
        .expect(403);
      expect(res.body).toMatchObject({ code: 'ADMIN_REQUIRED' });
    }
    // POST /iam/staff carrying roleIds → same rule
    const res = await request(app.getHttpServer())
      .post('/iam/staff')
      .set('Authorization', `Bearer ${writerToken}`)
      .send({
        login: 't3-x',
        name: 'X',
        password: 'x',
        orgUnitId: ORG_BR,
        roleIds: [ROLE_LIMITED],
      })
      .expect(403);
    expect(res.body).toMatchObject({ code: 'ADMIN_REQUIRED' });
  });

  it('non-admin CAN still PATCH staff profile fields (no roleIds) inside their subtree', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/iam/staff/${STAFF_WRITER}`)
      .set('Authorization', `Bearer ${writerToken}`)
      .send({ name: 'T3 Writer' })
      .expect(200);
    expect(res.body.name).toBe('T3 Writer');
  });

  it('built-in admin role cannot be deleted, even by admin', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/iam/roles/${ROLE_ADMIN}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(403);
    expect(res.body).toMatchObject({ code: 'ROLE_PROTECTED' });
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

  it('same key against a DIFFERENT route → 409 (route is part of the key check)', async () => {
    // 't3-idem-1' is COMPLETED from the previous test with method=POST,
    // route=/iam/staff, requestHash=sha256(bodyA). Sending the IDENTICAL body
    // to a different endpoint must still 409 — the stored route differs.
    const bodyA = { login: 't3-idem1', name: 'Idem One', password: 'x', orgUnitId: ORG_BR };
    const res = await request(app.getHttpServer())
      .post('/iam/roles')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', 't3-idem-1')
      .send(bodyA)
      .expect(409);
    expect(res.body).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
    });
  });
});

describe('input-validation guards', () => {
  it('permission dictionary writes are admin-only too', async () => {
    const res = await request(app.getHttpServer())
      .post('/iam/roles/permissions')
      .set('Authorization', `Bearer ${writerToken}`)
      .send({ code: 'hack:perm', type: 'ACTION' })
      .expect(403);
    expect(res.body).toMatchObject({ code: 'ADMIN_REQUIRED' });
  });

  it('malformed ids/fields return 400, not 500', async () => {
    await request(app.getHttpServer())
      .patch('/iam/roles/not-a-uuid')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'x' })
      .expect(400);
    await request(app.getHttpServer())
      .put('/iam/roles/not-a-uuid/permissions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ permissionIds: [] })
      .expect(400);
    await request(app.getHttpServer())
      .patch(`/iam/staff/${STAFF_VIEWER}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ orgUnitId: '' })
      .expect(400);
    await request(app.getHttpServer())
      .patch(`/iam/staff/${STAFF_VIEWER}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ roleIds: 5 })
      .expect(400);
    await request(app.getHttpServer())
      .patch(`/iam/staff/${STAFF_VIEWER}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'X' })
      .expect(400);
    await request(app.getHttpServer())
      .put(`/iam/roles/${ROLE_LIMITED}/permissions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ permissionIds: 5 })
      .expect(400);
  });

  it('scoped writer cannot promote an org to root (parentId: null → 403)', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/iam/orgs/${ORG_BR}`)
      .set('Authorization', `Bearer ${writerToken}`)
      .send({ parentId: null })
      .expect(403);
    expect(res.body).toMatchObject({ code: 'ORG_OUT_OF_SCOPE' });
  });

  it('org parentId must be a valid uuid when provided', async () => {
    await request(app.getHttpServer())
      .patch(`/iam/orgs/${ORG_BR}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ parentId: '' })
      .expect(400);
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
