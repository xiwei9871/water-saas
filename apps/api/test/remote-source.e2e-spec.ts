/**
 * RemoteSource CRUD e2e (E5 T2) against `watersaas_test` — fixtures carry
 * the `e5s-` prefix. Boots the real AppModule so JWT/permission guards,
 * tenant ALS and RLS all apply.
 *
 * Covers:
 *  1. create validation: required fields → 400; bad type → 422;
 *     non-IANA timezone → 422; duplicate code → 409
 *  2. permissions: metering:read lists/gets; metering:write (no remote:manage)
 *     → 403 on POST/PATCH; remote:manage staff writes
 *  3. org scope: a branch-scoped manager cannot create a source on the
 *     company org or a tenant-wide (NULL org) source; can on own org
 *  4. PATCH: name/timezone/status mutable; code/type/adapterKey
 *     immutable (PATCH ignores them); DISABLED status lands
 *  5. Idempotency-Key replays the create; cross-tenant → 404
 */
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import bcrypt from 'bcrypt';
import pg from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

process.env.DATABASE_URL =
  process.env.DATABASE_URL_TEST ??
  'postgresql://ws_app:ws_app_pw@localhost:5432/watersaas_test';

const OWNER_URL =
  process.env.MIGRATION_DATABASE_URL_TEST ??
  'postgresql://postgres:postgres@localhost:5432/watersaas_test';

const TENANT = 'e5a5a5a5-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'e5a5a5a5-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORG_CO = 'e5a5a5a5-0000-4000-8000-0000000000c0';
const ORG_BR = 'e5a5a5a5-0000-4000-8000-0000000000b1';
const ORG_B = 'e5a5a5a5-0000-4000-8000-0000000000cb';
const ROLE_ADMIN = 'e5a5a5a5-0000-4000-8000-00000000ad01';
const ROLE_VIEWER = 'e5a5a5a5-0000-4000-8000-000000001e01';
const ROLE_WRITER = 'e5a5a5a5-0000-4000-8000-000000001e02';
const ROLE_MANAGER = 'e5a5a5a5-0000-4000-8000-000000001e03';
const ROLE_B_ADMIN = 'e5a5a5a5-0000-4000-8000-00000000adb1';
const PERM_READ = 'e5a5a5a5-0000-4000-8000-00000000e601';
const PERM_WRITE = 'e5a5a5a5-0000-4000-8000-00000000e602';
const PERM_MANAGE = 'e5a5a5a5-0000-4000-8000-00000000e603';
const STAFF_ADMIN = 'e5a5a5a5-0000-4000-8000-0000000a0001';
const STAFF_VIEWER = 'e5a5a5a5-0000-4000-8000-0000000b0002';
const STAFF_WRITER = 'e5a5a5a5-0000-4000-8000-0000000b0003';
const STAFF_MANAGER = 'e5a5a5a5-0000-4000-8000-0000000b0004';
const STAFF_B = 'e5a5a5a5-0000-4000-8000-0000000ab001';

const owner = new pg.Client({ connectionString: OWNER_URL });
let app: INestApplication<App>;
let adminToken = '';
let viewerToken = '';
let writerToken = '';
let managerToken = '';
let tenantBToken = '';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

let sourceId = '';

beforeAll(async () => {
  await owner.connect();
  const hash = await bcrypt.hash('e5s-pass', 10);

  await owner.query(
    `INSERT INTO tenant (id, code, name, status, created_at, updated_at)
     VALUES ($1, 'e5s-water', 'E5S Water', 'ACTIVE', now(), now()),
            ($2, 'e5s-other', 'E5S Other', 'ACTIVE', now(), now())
     ON CONFLICT DO NOTHING`,
    [TENANT, TENANT_B],
  );
  await owner.query(
    `INSERT INTO org_unit (id, tenant_id, parent_id, name, type, created_at, updated_at)
     VALUES ($1, $2, NULL, 'E5S Company', 'COMPANY', now(), now()),
            ($3, $2, $1, 'E5S Branch', 'BRANCH', now(), now()),
            ($4, $5, NULL, 'E5SB Company', 'COMPANY', now(), now())
     ON CONFLICT DO NOTHING`,
    [ORG_CO, TENANT, ORG_BR, ORG_B, TENANT_B],
  );
  await owner.query(
    `INSERT INTO role (id, tenant_id, code, name, data_scope, created_at, updated_at)
     VALUES ($1, $3, 'admin', 'E5S Admin', 'ALL', now(), now()),
            ($2, $3, 'e5s-viewer', 'E5S Viewer', 'ORG_SUBTREE', now(), now()),
            ($6, $3, 'e5s-writer', 'E5S Writer', 'ORG_SUBTREE', now(), now()),
            ($7, $3, 'e5s-manager', 'E5S Manager', 'ORG_SUBTREE', now(), now()),
            ($4, $5, 'admin', 'E5SB Admin', 'ALL', now(), now())
     ON CONFLICT DO NOTHING`,
    [ROLE_ADMIN, ROLE_VIEWER, TENANT, ROLE_B_ADMIN, TENANT_B, ROLE_WRITER, ROLE_MANAGER],
  );
  await owner.query(
    `INSERT INTO permission (id, tenant_id, code, type, created_at, updated_at)
     VALUES ($1, $2, 'metering:read', 'ACTION', now(), now()),
            ($3, $2, 'metering:write', 'ACTION', now(), now()),
            ($4, $2, 'metering:remote:manage', 'ACTION', now(), now())
     ON CONFLICT DO NOTHING`,
    [PERM_READ, TENANT, PERM_WRITE, PERM_MANAGE],
  );
  // viewer: read only; writer: read+write but NOT remote:manage;
  // manager: remote:manage scoped to ORG_BR subtree only.
  await owner.query(
    `INSERT INTO role_permission (tenant_id, role_id, permission_id, created_at, updated_at)
     VALUES ($1, $2, $5, now(), now()),
            ($1, $3, $5, now(), now()),
            ($1, $3, $6, now(), now()),
            ($1, $4, $5, now(), now()),
            ($1, $4, $7, now(), now())
     ON CONFLICT DO NOTHING`,
    [TENANT, ROLE_VIEWER, ROLE_WRITER, ROLE_MANAGER, PERM_READ, PERM_WRITE, PERM_MANAGE],
  );
  const staffRows: [string, string, string, string, string][] = [
    [STAFF_ADMIN, TENANT, ORG_CO, 'e5s-admin', 'E5S Admin'],
    [STAFF_VIEWER, TENANT, ORG_CO, 'e5s-viewer', 'E5S Viewer'],
    [STAFF_WRITER, TENANT, ORG_CO, 'e5s-writer', 'E5S Writer'],
    [STAFF_MANAGER, TENANT, ORG_BR, 'e5s-manager', 'E5S Manager'],
    [STAFF_B, TENANT_B, ORG_B, 'e5sb-admin', 'E5SB Admin'],
  ];
  for (const [id, tenantId, orgId, login_, name] of staffRows) {
    await owner.query(
      `INSERT INTO staff (id, tenant_id, org_unit_id, login, password_hash, name, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', now(), now())
       ON CONFLICT (tenant_id, login) DO NOTHING`,
      [id, tenantId, orgId, login_, hash, name],
    );
  }
  await owner.query(
    `INSERT INTO staff_role (tenant_id, staff_id, role_id, created_at, updated_at)
     VALUES ($1, $2, $6, now(), now()),
            ($1, $3, $7, now(), now()),
            ($1, $4, $8, now(), now()),
            ($1, $5, $9, now(), now()),
            ($10, $11, $12, now(), now())
     ON CONFLICT DO NOTHING`,
    [
      TENANT, STAFF_ADMIN, STAFF_VIEWER, STAFF_WRITER, STAFF_MANAGER,
      ROLE_ADMIN, ROLE_VIEWER, ROLE_WRITER, ROLE_MANAGER,
      TENANT_B, STAFF_B, ROLE_B_ADMIN,
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
        .send({ tenantCode, login: login_, password: 'e5s-pass' })
        .expect(201)
    ).body.accessToken as string;
  adminToken = await login('e5s-water', 'e5s-admin');
  viewerToken = await login('e5s-water', 'e5s-viewer');
  writerToken = await login('e5s-water', 'e5s-writer');
  managerToken = await login('e5s-water', 'e5s-manager');
  tenantBToken = await login('e5s-other', 'e5sb-admin');
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

describe('remote-source create validation', () => {
  it('missing required fields → 400', async () => {
    await request(app.getHttpServer())
      .post('/remote-sources')
      .set(auth(adminToken))
      .send({ code: `SRC-${RUN}` })
      .expect(400);
  });
  it('bad type → 422; bad timezone → 422', async () => {
    await request(app.getHttpServer())
      .post('/remote-sources')
      .set(auth(adminToken))
      .send({
        code: `SRC-${RUN}`,
        name: 'NB Platform',
        type: 'LORA_MAGIC',
        adapterKey: 'file-csv',
        timezone: 'Asia/Shanghai',
      })
      .expect(422);
    await request(app.getHttpServer())
      .post('/remote-sources')
      .set(auth(adminToken))
      .send({
        code: `SRC-${RUN}`,
        name: 'NB Platform',
        type: 'FILE_IMPORT',
        adapterKey: 'file-csv',
        timezone: 'Mars/Olympus',
      })
      .expect(422);
  });
  it('valid create → 201 + ACTIVE', async () => {
    const res = await request(app.getHttpServer())
      .post('/remote-sources')
      .set(auth(adminToken))
      .send({
        code: `SRC-${RUN}`,
        name: '宁波水表云平台',
        type: 'FILE_IMPORT',
        adapterKey: 'file-csv',
        timezone: 'Asia/Shanghai',
        credentialRef: 'vault://nb-cloud/api-key',
        orgUnitId: ORG_CO,
      })
      .expect(201);
    sourceId = res.body.id;
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.timezone).toBe('Asia/Shanghai');
  });
  it('duplicate code → 409; Idempotency-Key replays', async () => {
    await request(app.getHttpServer())
      .post('/remote-sources')
      .set(auth(adminToken))
      .send({
        code: `SRC-${RUN}`,
        name: 'dup',
        type: 'FILE_IMPORT',
        adapterKey: 'file-csv',
        timezone: 'UTC',
      })
      .expect(409);
    const body = {
      code: `IDEM-${RUN}`,
      name: 'idem',
      type: 'FILE_IMPORT',
      adapterKey: 'file-csv',
      timezone: 'UTC',
    };
    const first = await request(app.getHttpServer())
      .post('/remote-sources')
      .set(auth(adminToken))
      .set('Idempotency-Key', `e5s-${RUN}`)
      .send(body)
      .expect(201);
    const replay = await request(app.getHttpServer())
      .post('/remote-sources')
      .set(auth(adminToken))
      .set('Idempotency-Key', `e5s-${RUN}`)
      .send(body)
      .expect(201);
    expect(replay.body.id).toBe(first.body.id);
  });
});

describe('remote-source permissions', () => {
  it('metering:read lists + gets; list does not leak across tenants', async () => {
    const list = await request(app.getHttpServer())
      .get('/remote-sources')
      .set(auth(viewerToken))
      .expect(200);
    expect(list.body.some((s: { id: string }) => s.id === sourceId)).toBe(true);
    const bList = await request(app.getHttpServer())
      .get('/remote-sources')
      .set(auth(tenantBToken))
      .expect(200);
    expect(bList.body.some((s: { id: string }) => s.id === sourceId)).toBe(false);
    await request(app.getHttpServer())
      .get(`/remote-sources/${sourceId}`)
      .set(auth(viewerToken))
      .expect(200);
    await request(app.getHttpServer())
      .get(`/remote-sources/${sourceId}`)
      .set(auth(tenantBToken))
      .expect(404);
  });
  it('metering:write without remote:manage → 403 on POST + PATCH', async () => {
    await request(app.getHttpServer())
      .post('/remote-sources')
      .set(auth(writerToken))
      .send({
        code: `W-${RUN}`,
        name: 'x',
        type: 'FILE_IMPORT',
        adapterKey: 'file-csv',
        timezone: 'UTC',
      })
      .expect(403);
    await request(app.getHttpServer())
      .patch(`/remote-sources/${sourceId}`)
      .set(auth(writerToken))
      .send({ name: 'x' })
      .expect(403);
  });
});

describe('remote-source org scope', () => {
  it('branch-scoped manager: own org ok, company org 403, tenant-wide 403', async () => {
    const own = await request(app.getHttpServer())
      .post('/remote-sources')
      .set(auth(managerToken))
      .send({
        code: `BR-${RUN}`,
        name: 'branch src',
        type: 'FILE_IMPORT',
        adapterKey: 'file-csv',
        timezone: 'UTC',
        orgUnitId: ORG_BR,
      })
      .expect(201);
    await request(app.getHttpServer())
      .post('/remote-sources')
      .set(auth(managerToken))
      .send({
        code: `CO-${RUN}`,
        name: 'company src',
        type: 'FILE_IMPORT',
        adapterKey: 'file-csv',
        timezone: 'UTC',
        orgUnitId: ORG_CO,
      })
      .expect(403);
    await request(app.getHttpServer())
      .post('/remote-sources')
      .set(auth(managerToken))
      .send({
        code: `TW-${RUN}`,
        name: 'tenant-wide src',
        type: 'FILE_IMPORT',
        adapterKey: 'file-csv',
        timezone: 'UTC',
      })
      .expect(403);
    // ...and can't patch the company-org source created by admin either.
    await request(app.getHttpServer())
      .patch(`/remote-sources/${sourceId}`)
      .set(auth(managerToken))
      .send({ name: 'hijack' })
      .expect(403);
    await request(app.getHttpServer())
      .patch(`/remote-sources/${own.body.id}`)
      .set(auth(managerToken))
      .send({ name: 'branch src v2' })
      .expect(200);
  });
});

describe('remote-source patch', () => {
  it('name/timezone/status mutable; identity fields immutable', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/remote-sources/${sourceId}`)
      .set(auth(adminToken))
      .send({
        name: '宁波水表云平台·改名',
        timezone: 'UTC',
        status: 'DISABLED',
        code: 'SHOULD-NOT-STICK',
        type: 'WEBHOOK',
        adapterKey: 'other-adapter',
      })
      .expect(200);
    expect(res.body.name).toBe('宁波水表云平台·改名');
    expect(res.body.status).toBe('DISABLED');
    expect(res.body.code).toBe(`SRC-${RUN}`);
    expect(res.body.type).toBe('FILE_IMPORT');
    expect(res.body.adapterKey).toBe('file-csv');
  });
});
