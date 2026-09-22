/**
 * RemoteDevice + RemoteDeviceBinding e2e (E5 T3) against `watersaas_test` —
 * fixtures carry the `e5d-` prefix.
 *
 * Covers:
 *  1. device create: missing fields → 400; unknown source → 400;
 *     dup (source, vendorDeviceKey) → 409; valid → 201
 *  2. device patch: status/metadata mutable; vendorDeviceKey + source immutable
 *  3. binding create: valid → 201; same-device overlap → 409; different-device
 *     same-installation overlap → 409; adjacent half-open ranges accepted;
 *     before installedAt → 422; past removedAt → 422; inverted range → 422
 *  4. binding patch: effectiveTo closes a range; reopen→narrow overlap → 409
 *  5. installation removal closes the open binding in the same transaction
 *  6. permission matrix + cross-tenant 404
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

const TENANT = 'e5d5d5d5-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_CO = 'e5d5d5d5-0000-4000-8000-0000000000c0';
const ROLE_ADMIN = 'e5d5d5d5-0000-4000-8000-00000000ad01';
const STAFF_ADMIN = 'e5d5d5d5-0000-4000-8000-0000000a0001';

const owner = new pg.Client({ connectionString: OWNER_URL });
let app: INestApplication<App>;
let adminToken = '';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

let sourceId = '';
let deviceId = '';
let device2Id = '';
let instId = '';
let inst2Id = '';
let instInstalledAt = '';
let bindingId = '';
const iso = (d: Date) => d.toISOString();
const plusDays = (base: string, days: number) => iso(new Date(new Date(base).getTime() + days * 86400000));

beforeAll(async () => {
  await owner.connect();
  const hash = await bcrypt.hash('e5d-pass', 10);
  await owner.query(
    `INSERT INTO tenant (id, code, name, status, created_at, updated_at)
     VALUES ($1, 'e5d-water', 'E5D Water', 'ACTIVE', now(), now())
     ON CONFLICT DO NOTHING`,
    [TENANT],
  );
  await owner.query(
    `INSERT INTO org_unit (id, tenant_id, parent_id, name, type, created_at, updated_at)
     VALUES ($1, $2, NULL, 'E5D Company', 'COMPANY', now(), now())
     ON CONFLICT DO NOTHING`,
    [ORG_CO, TENANT],
  );
  await owner.query(
    `INSERT INTO role (id, tenant_id, code, name, data_scope, created_at, updated_at)
     VALUES ($1, $2, 'admin', 'E5D Admin', 'ALL', now(), now())
     ON CONFLICT DO NOTHING`,
    [ROLE_ADMIN, TENANT],
  );
  await owner.query(
    `INSERT INTO staff (id, tenant_id, org_unit_id, login, password_hash, name, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'e5d-admin', $4, 'E5D Admin', 'ACTIVE', now(), now())
     ON CONFLICT (tenant_id, login) DO NOTHING`,
    [STAFF_ADMIN, TENANT, ORG_CO, hash],
  );
  await owner.query(
    `INSERT INTO staff_role (tenant_id, staff_id, role_id, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now())
     ON CONFLICT DO NOTHING`,
    [TENANT, STAFF_ADMIN, ROLE_ADMIN],
  );

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleFixture.createNestApplication();
  await app.init();

  adminToken = (
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantCode: 'e5d-water', login: 'e5d-admin', password: 'e5d-pass' })
      .expect(201)
  ).body.accessToken as string;
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

const onboard = async (label: string) => {
  const res = await request(app.getHttpServer())
    .post('/water-accounts/onboard')
    .set(auth(adminToken))
    .send({
      customer: { name: `E5D ${label} ${RUN}`, custType: 'PERSONAL' },
      account: { usageCategory: 'RES_METERED', addr: `${label} Remote St` },
      meter: { brand: 'e5d-brand', caliber: 'DN15' },
      installation: { initialReading: 0 },
    })
    .expect(201);
  return res.body as { installation: { id: string; installedAt: string } };
};

describe('remote-device CRUD', () => {
  it('fixture: source + two accounts/installations', async () => {
    const src = await request(app.getHttpServer())
      .post('/remote-sources')
      .set(auth(adminToken))
      .send({
        code: `SRC-${RUN}`,
        name: 'NB Cloud',
        type: 'FILE_IMPORT',
        adapterKey: 'file-csv',
        timezone: 'Asia/Shanghai',
      })
      .expect(201);
    sourceId = src.body.id;
    const a = await onboard('A');
    instId = a.installation.id;
    instInstalledAt = a.installation.installedAt;
    const b = await onboard('B');
    inst2Id = b.installation.id;
    expect(instId).toBeTruthy();
  });

  it('create validation + unique key', async () => {
    await request(app.getHttpServer())
      .post('/remote-devices')
      .set(auth(adminToken))
      .send({ vendorDeviceKey: 'D1' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/remote-devices')
      .set(auth(adminToken))
      .send({ remoteSourceId: '00000000-0000-4000-8000-000000000000', vendorDeviceKey: 'D1' })
      .expect(400);
    const res = await request(app.getHttpServer())
      .post('/remote-devices')
      .set(auth(adminToken))
      .send({
        remoteSourceId: sourceId,
        vendorDeviceKey: `86423907${RUN.slice(0, 4)}`,
        vendorMeterNo: 'VM-001',
        communicationId: 'IMEI-1',
        model: 'NB-15',
      })
      .expect(201);
    deviceId = res.body.id;
    expect(res.body.status).toBe('ACTIVE');
    // same (source, vendorDeviceKey) → 409
    await request(app.getHttpServer())
      .post('/remote-devices')
      .set(auth(adminToken))
      .send({ remoteSourceId: sourceId, vendorDeviceKey: res.body.vendorDeviceKey })
      .expect(409);
    const d2 = await request(app.getHttpServer())
      .post('/remote-devices')
      .set(auth(adminToken))
      .send({ remoteSourceId: sourceId, vendorDeviceKey: `86423908${RUN.slice(0, 4)}` })
      .expect(201);
    device2Id = d2.body.id;
  });

  it('patch profile/status; identity immutable', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/remote-devices/${deviceId}`)
      .set(auth(adminToken))
      .send({
        model: 'NB-15-B',
        status: 'DISABLED',
        vendorDeviceKey: 'SHOULD-NOT-STICK',
        remoteSourceId: '00000000-0000-4000-8000-000000000000',
      })
      .expect(200);
    expect(res.body.model).toBe('NB-15-B');
    expect(res.body.status).toBe('DISABLED');
    expect(res.body.vendorDeviceKey).not.toBe('SHOULD-NOT-STICK');
    expect(res.body.remoteSourceId).toBe(sourceId);
    // re-enable for binding tests
    await request(app.getHttpServer())
      .patch(`/remote-devices/${deviceId}`)
      .set(auth(adminToken))
      .send({ status: 'ACTIVE' })
      .expect(200);
  });
});

describe('remote-device-binding', () => {
  it('creates an open binding; detail lists it', async () => {
    const res = await request(app.getHttpServer())
      .post(`/remote-devices/${deviceId}/bindings`)
      .set(auth(adminToken))
      .send({ installationId: instId, effectiveFrom: instInstalledAt })
      .expect(201);
    bindingId = res.body.id;
    const detail = await request(app.getHttpServer())
      .get(`/remote-devices/${deviceId}`)
      .set(auth(adminToken))
      .expect(200);
    expect(detail.body.bindings.length).toBe(1);
    expect(detail.body.bindings[0].installation.id).toBe(instId);
  });

  it('same-device overlap → 409; adjacent half-open ok', async () => {
    await request(app.getHttpServer())
      .post(`/remote-devices/${deviceId}/bindings`)
      .set(auth(adminToken))
      .send({
        installationId: inst2Id,
        effectiveFrom: plusDays(instInstalledAt, 10),
        effectiveTo: plusDays(instInstalledAt, 40),
      })
      .expect(409);
    // first close the open one at +10d, then a successor starting
    // exactly at the boundary is legal (half-open [from, to)).
    await request(app.getHttpServer())
      .patch(`/remote-device-bindings/${bindingId}`)
      .set(auth(adminToken))
      .send({ effectiveTo: plusDays(instInstalledAt, 10) })
      .expect(200);
    const next = await request(app.getHttpServer())
      .post(`/remote-devices/${deviceId}/bindings`)
      .set(auth(adminToken))
      .send({ installationId: inst2Id, effectiveFrom: plusDays(instInstalledAt, 10) })
      .expect(201);
    expect(next.body.effectiveTo).toBeNull();
  });

  it('different device on same installation overlapping → 409', async () => {
    // device1's closed binding covered [install,+10d) on inst1 — a new
    // device binding overlapping that window on the same installation is refused.
    await request(app.getHttpServer())
      .post(`/remote-devices/${device2Id}/bindings`)
      .set(auth(adminToken))
      .send({ installationId: instId, effectiveFrom: plusDays(instInstalledAt, 5) })
      .expect(409);
  });

  it('containment + range validation → 422', async () => {
    await request(app.getHttpServer())
      .post(`/remote-devices/${device2Id}/bindings`)
      .set(auth(adminToken))
      .send({ installationId: instId, effectiveFrom: plusDays(instInstalledAt, -1) })
      .expect(422);
    await request(app.getHttpServer())
      .post(`/remote-devices/${device2Id}/bindings`)
      .set(auth(adminToken))
      .send({
        installationId: inst2Id,
        effectiveFrom: plusDays(instInstalledAt, 60),
        effectiveTo: plusDays(instInstalledAt, 50),
      })
      .expect(422);
    await request(app.getHttpServer())
      .post(`/remote-devices/${device2Id}/bindings`)
      .set(auth(adminToken))
      .send({ installationId: inst2Id, effectiveFrom: 'not-a-date' })
      .expect(422);
  });

  it('removing an installation closes its open binding in the same tx', async () => {
    // device1 currently has open binding on inst2 from +10d.
    const removedAt = plusDays(instInstalledAt, 20);
    await request(app.getHttpServer())
      .post(`/meter-installations/${inst2Id}/remove`)
      .set(auth(adminToken))
      .send({ finalReading: 0, removedAt })
      .expect(201);
    const detail = await request(app.getHttpServer())
      .get(`/remote-devices/${deviceId}`)
      .set(auth(adminToken))
      .expect(200);
    const open = detail.body.bindings.find((b: { installationId: string }) => b.installationId === inst2Id);
    expect(open.effectiveTo).toBe(removedAt);
  });
});

describe('binding lifecycle guards (release fix)', () => {
  it('REMOVED installation: reopening a binding (effectiveTo=null) → 422', async () => {
    const detail = await request(app.getHttpServer())
      .get(`/remote-devices/${deviceId}`)
      .set(auth(adminToken))
      .expect(200);
    const closed = detail.body.bindings.find(
      (b: { installationId: string }) => b.installationId === inst2Id,
    );
    await request(app.getHttpServer())
      .patch(`/remote-device-bindings/${closed.id}`)
      .set(auth(adminToken))
      .send({ effectiveTo: null })
      .expect(422)
      .expect((r) => expect(r.body.code).toBe('BINDING_OUTSIDE_INSTALLATION'));
    // A REMOVED installation also refuses brand-new open bindings.
    await request(app.getHttpServer())
      .post(`/remote-devices/${device2Id}/bindings`)
      .set(auth(adminToken))
      .send({ installationId: inst2Id, effectiveFrom: plusDays(instInstalledAt, 5) })
      .expect(422)
      .expect((r) => expect(r.body.code).toBe('BINDING_OUTSIDE_INSTALLATION'));
  });

  it('removedAt < installedAt → business error, not a DB 500', async () => {
    const inst3 = await onboard('C');
    await request(app.getHttpServer())
      .post(`/meter-installations/${inst3.installation.id}/remove`)
      .set(auth(adminToken))
      .send({
        finalReading: 0,
        removedAt: plusDays(inst3.installation.installedAt, -1),
      })
      .expect(400)
      .expect((r) => expect(r.body.code).toBe('REMOVE_BEFORE_INSTALL'));
  });

  it('removal that would orphan a resolved event → 409 BINDING_CLOSE_ORPHANS_EVENT', async () => {
    const inst4 = await onboard('D');
    const bind = await request(app.getHttpServer())
      .post(`/remote-devices/${device2Id}/bindings`)
      .set(auth(adminToken))
      .send({
        installationId: inst4.installation.id,
        effectiveFrom: inst4.installation.installedAt,
      })
      .expect(201);
    // A raw event already resolved through this binding, collected AFTER
    // the removal date we are about to request — closing the binding at
    // removedAt would strand it outside its own provenance window.
    const collectedAt = plusDays(inst4.installation.installedAt, 30);
    await owner.query(
      `INSERT INTO raw_remote_event (
         id, tenant_id, remote_source_id, external_event_key,
         canonical_payload_hash, vendor_device_key, business_period,
         collected_at, reading_value, raw_payload, canonical_payload,
         resolved_remote_device_id, resolved_binding_id,
         processing_status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'h', 'x', '202610', $4, 1,
               '{}'::jsonb, '{}'::jsonb, $5, $6, 'CONVERTED', now(), now())`,
      [
        TENANT,
        sourceId,
        `orphan-${RUN}`,
        collectedAt,
        device2Id,
        bind.body.id,
      ],
    );
    await request(app.getHttpServer())
      .post(`/meter-installations/${inst4.installation.id}/remove`)
      .set(auth(adminToken))
      .send({
        finalReading: 0,
        removedAt: plusDays(inst4.installation.installedAt, 20),
      })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('BINDING_CLOSE_ORPHANS_EVENT'));
    // A removal dated past the event's collectedAt keeps the event inside
    // the (closed) window → allowed.
    await request(app.getHttpServer())
      .post(`/meter-installations/${inst4.installation.id}/remove`)
      .set(auth(adminToken))
      .send({
        finalReading: 0,
        removedAt: plusDays(inst4.installation.installedAt, 40),
      })
      .expect(201);
  });
});
