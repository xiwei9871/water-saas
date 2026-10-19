/**
 * POST /meter-readings/recognize e2e — synthetic roller-window image through
 * the real pipeline (sharp + tesseract worker). Fixtures carry the `o1-`
 * prefix; only auth + one tenant/org/roles needed since the endpoint stores
 * nothing.
 */
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import bcrypt from 'bcrypt';
import pg from 'pg';
import sharp from 'sharp';
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

const T = '01cd010c-0000-4000-8000-00000000c0c0';
const ORG = '01cd010c-0000-4000-8000-00000000c001';
const ROLE_ADMIN = '01cd010c-0000-4000-8000-00000000ad01';
const ROLE_VIEWER = '01cd010c-0000-4000-8000-000000001e01';
const PERM_READ = '01cd010c-0000-4000-8000-00000000e601';
const STAFF_ADMIN = '01cd010c-0000-4000-8000-0000000a0001';
const STAFF_VIEWER = '01cd010c-0000-4000-8000-0000000b0002';

const owner = new pg.Client({ connectionString: OWNER_URL });
let app: INestApplication<App>;
let adminToken = '';
let viewerToken = '';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

/** A clean roller-window image: "0123" digit strip on white panel. */
const rollerPngB64 = async (): Promise<string> => {
  const svg = `<svg width="600" height="400" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#e8e2d8"/>
    <rect x="140" y="160" width="330" height="80" fill="#f8f8f4" stroke="#333"/>
    <text x="160" y="228" font-size="72" font-family="monospace" letter-spacing="14" fill="#111">0123</text>
  </svg>`;
  return (await sharp(Buffer.from(svg)).jpeg().toBuffer()).toString('base64');
};

beforeAll(async () => {
  await owner.connect();
  const hash = await bcrypt.hash('o1-pass', 10);
  await owner.query(
    `INSERT INTO tenant (id, code, name, status, created_at, updated_at)
     VALUES ($1, 'o1-ocr', 'O1 Ocr', 'ACTIVE', now(), now()) ON CONFLICT DO NOTHING`,
    [T],
  );
  await owner.query(
    `INSERT INTO org_unit (id, tenant_id, parent_id, name, type, created_at, updated_at)
     VALUES ($1, $2, NULL, 'O1 Company', 'COMPANY', now(), now()) ON CONFLICT DO NOTHING`,
    [ORG, T],
  );
  await owner.query(
    `INSERT INTO role (id, tenant_id, code, name, data_scope, created_at, updated_at)
     VALUES ($1, $3, 'admin', 'O1 Admin', 'ALL', now(), now()),
            ($2, $3, 'o1-viewer', 'O1 Viewer', 'ORG_SUBTREE', now(), now())
     ON CONFLICT DO NOTHING`,
    [ROLE_ADMIN, ROLE_VIEWER, T],
  );
  await owner.query(
    `INSERT INTO permission (id, tenant_id, code, type, created_at, updated_at)
     VALUES ($1, $2, 'metering:read', 'ACTION', now(), now()) ON CONFLICT DO NOTHING`,
    [PERM_READ, T],
  );
  await owner.query(
    `INSERT INTO role_permission (tenant_id, role_id, permission_id, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now()) ON CONFLICT DO NOTHING`,
    [T, ROLE_VIEWER, PERM_READ],
  );
  await owner.query(
    `INSERT INTO staff (id, tenant_id, org_unit_id, login, password_hash, name, status, created_at, updated_at)
     VALUES ($1, $3, $4, 'o1-admin',  $5, 'O1 Admin',  'ACTIVE', now(), now()),
            ($2, $3, $4, 'o1-viewer', $5, 'O1 Viewer', 'ACTIVE', now(), now())
     ON CONFLICT (tenant_id, login) DO NOTHING`,
    [STAFF_ADMIN, STAFF_VIEWER, T, ORG, hash],
  );
  await owner.query(
    `INSERT INTO staff_role (tenant_id, staff_id, role_id, created_at, updated_at)
     VALUES ($1, $2, $4, now(), now()),
            ($1, $3, $5, now(), now()) ON CONFLICT DO NOTHING`,
    [T, STAFF_ADMIN, STAFF_VIEWER, ROLE_ADMIN, ROLE_VIEWER],
  );

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleFixture.createNestApplication();
  await app.init();

  const login = async (l: string) =>
    (
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ tenantCode: 'o1-ocr', login: l, password: 'o1-pass' })
        .expect(201)
    ).body.accessToken as string;
  adminToken = await login('o1-admin');
  viewerToken = await login('o1-viewer');
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

describe('POST /meter-readings/recognize', () => {
  it('401 without token', async () => {
    await request(app.getHttpServer())
      .post('/meter-readings/recognize')
      .send({ image: 'AAAA' + 'A'.repeat(200) })
      .expect(401);
  });

  it('400 when image missing / not base64', async () => {
    await request(app.getHttpServer())
      .post('/meter-readings/recognize')
      .set(auth(adminToken))
      .send({})
      .expect(400);
    const res = await request(app.getHttpServer())
      .post('/meter-readings/recognize')
      .set(auth(adminToken))
      .send({ image: '!!!not-base64!!!' + 'x'.repeat(200) })
      .expect(400);
    expect(res.body.code).toBe('IMAGE_INVALID');
  });

  it('403 for metering:read-only staff (endpoint needs metering:write)', async () => {
    await request(app.getHttpServer())
      .post('/meter-readings/recognize')
      .set(auth(viewerToken))
      .send({ image: 'AAAA' + 'A'.repeat(200) })
      .expect(403);
  });

  it(
    'recognizes a synthetic roller window',
    async () => {
      const image = await rollerPngB64();
      const res = await request(app.getHttpServer())
        .post('/meter-readings/recognize')
        .set(auth(adminToken))
        .send({ image })
        .expect(201);
      expect(['roller', 'pointer', 'none']).toContain(res.body.method);
      if (res.body.method === 'roller') {
        expect(res.body.value).toMatch(/^\d+(\.\d+)?$/);
      }
      expect(typeof res.body.confidence).toBe('number');
    },
    30_000,
  );

  it(
    'returns method none + message on undecodable bytes',
    async () => {
      const junk = Buffer.from('definitely-not-an-image-bytes'.repeat(20)).toString('base64');
      const res = await request(app.getHttpServer())
        .post('/meter-readings/recognize')
        .set(auth(adminToken))
        .send({ image: junk })
        .expect(201);
      expect(res.body.value).toBeNull();
      expect(res.body.method).toBe('none');
      expect(res.body.message).toBeTruthy();
    },
    30_000,
  );
});
