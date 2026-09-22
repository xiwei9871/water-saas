/**
 * Remote pipeline e2e (E5 T4–T7) against `watersaas_test` — fixtures carry
 * the `e5p-` prefix. Boots the real AppModule.
 *
 * Covers the frozen chain:
 *   ingest → device/binding/plan resolution → MeterReading(REMOTE)
 *  1. happy path: event → CONVERTED + reading(sourceEventId, operatorId NULL)
 *     + item READ + plan advanced + process log RECEIVED→CONVERTED
 *  2. same key+payload → IDEMPOTENT_REPLAY (no second event/reading, log row)
 *  3. same key+DIFFERENT payload → EVENT_KEY_CONFLICT (original preserved,
 *     issue marker set, no reading)
 *  4. unknown device → UNBOUND/DEVICE_NOT_FOUND
 *  5. known device, collectedAt outside binding → UNBOUND/NO_EFFECTIVE_BINDING
 *  6. no plan for period → WAITING_PLAN → generate plan → replay → CONVERTED
 *  7. UNBOUND → add binding → replay → CONVERTED
 *  8. manual read QC'd PASSED → remote → CONFLICT → USE_REMOTE → supersede
 *     correction (append-only chain, item re-points) → CONVERTED
 *  9. second conflict → KEEP_ACTUAL → IGNORED → replay → 409
 * 10. late recovery: item NO_READ (estimated) + plan DONE → remote → READ
 *     via late mode, plan stays DONE
 * 11. two plan items same account+period → FAILED PLAN_ITEM_AMBIGUOUS;
 *     plannedInstallationId exact match resolves → replay → CONVERTED
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

const TENANT = 'e5e5e5e5-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_CO = 'e5e5e5e5-0000-4000-8000-0000000000c0';
const ROLE_ADMIN = 'e5e5e5e5-0000-4000-8000-00000000ad01';
const STAFF_ADMIN = 'e5e5e5e5-0000-4000-8000-0000000a0001';

const owner = new pg.Client({ connectionString: OWNER_URL });
let app: INestApplication<App>;
let adminToken = '';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

let sourceId = '';
let deviceId = '';
let instInstalledAt = '';
const acct: Record<string, string> = {};
const inst: Record<string, string> = {};
const instAt: Record<string, string> = {};

const plusDays = (base: string, days: number) =>
  new Date(new Date(base).getTime() + days * 86400000).toISOString();

beforeAll(async () => {
  await owner.connect();
  const hash = await bcrypt.hash('e5p-pass', 10);
  await owner.query(
    `INSERT INTO tenant (id, code, name, status, created_at, updated_at)
     VALUES ($1, 'e5p-water', 'E5P Water', 'ACTIVE', now(), now())
     ON CONFLICT DO NOTHING`,
    [TENANT],
  );
  await owner.query(
    `INSERT INTO org_unit (id, tenant_id, parent_id, name, type, created_at, updated_at)
     VALUES ($1, $2, NULL, 'E5P Company', 'COMPANY', now(), now())
     ON CONFLICT DO NOTHING`,
    [ORG_CO, TENANT],
  );
  await owner.query(
    `INSERT INTO role (id, tenant_id, code, name, data_scope, created_at, updated_at)
     VALUES ($1, $2, 'admin', 'E5P Admin', 'ALL', now(), now())
     ON CONFLICT DO NOTHING`,
    [ROLE_ADMIN, TENANT],
  );
  await owner.query(
    `INSERT INTO staff (id, tenant_id, org_unit_id, login, password_hash, name, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'e5p-admin', $4, 'E5P Admin', 'ACTIVE', now(), now())
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
      .send({ tenantCode: 'e5p-water', login: 'e5p-admin', password: 'e5p-pass' })
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
      customer: { name: `E5P ${label} ${RUN}`, custType: 'PERSONAL' },
      account: { usageCategory: 'RES_METERED', addr: `${label} Pipe St` },
      meter: { brand: 'e5p-brand', caliber: 'DN15' },
      installation: { initialReading: 0 },
    })
    .expect(201);
  return res.body as {
    waterAccount: { id: string };
    installation: { id: string; installedAt: string };
  };
};

/** book + member + generated plan → returns {planId, items}. */
const mkPlan = async (period: string, waterAccountIds: string[], tag: string) => {
  const book = await request(app.getHttpServer())
    .post('/reading-books')
    .set(auth(adminToken))
    .send({ name: `E5P book ${tag} ${RUN}`, orgUnitId: ORG_CO })
    .expect(201);
  for (const id of waterAccountIds) {
    await request(app.getHttpServer())
      .post(`/reading-books/${book.body.id}/meters`)
      .set(auth(adminToken))
      .send({ waterAccountId: id })
      .expect(201);
  }
  const plan = await request(app.getHttpServer())
    .post('/reading-plans/generate')
    .set(auth(adminToken))
    .send({
      bookId: book.body.id,
      period,
      planDate: `${period.slice(0, 4)}-${period.slice(4)}-05`,
    })
    .expect(201);
  return { planId: plan.body.id as string, items: plan.body.items as { id: string; waterAccountId: string }[] };
};

const itemFor = (items: { id: string; waterAccountId: string }[], acctId: string) => {
  const it = items.find((i) => i.waterAccountId === acctId);
  if (!it) throw new Error('no plan item');
  return it.id;
};

const ingest = (body: Record<string, unknown>) =>
  request(app.getHttpServer())
    .post(`/remote-sources/${sourceId}/events`)
    .set(auth(adminToken))
    .send(body);

const DEVKEY = `DEV-${RUN}`;

describe('fixtures: source/device/binding/accounts', () => {
  it('builds the remote chain', async () => {
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
    acct.A = a.waterAccount.id;
    inst.A = a.installation.id;
    instInstalledAt = a.installation.installedAt;
    instAt.A = a.installation.installedAt;
    const b = await onboard('B');
    acct.B = b.waterAccount.id;
    inst.B = b.installation.id;
    instAt.B = b.installation.installedAt;

    const dev = await request(app.getHttpServer())
      .post('/remote-devices')
      .set(auth(adminToken))
      .send({ remoteSourceId: sourceId, vendorDeviceKey: DEVKEY })
      .expect(201);
    deviceId = dev.body.id;
    await request(app.getHttpServer())
      .post(`/remote-devices/${deviceId}/bindings`)
      .set(auth(adminToken))
      .send({
        installationId: inst.A,
        effectiveFrom: instInstalledAt,
        effectiveTo: plusDays(instInstalledAt, 400),
      })
      .expect(201);
  });
});

describe('ingest → convert happy path', () => {
  const P1 = '202610';
  let plan: { planId: string; items: { id: string; waterAccountId: string }[] };
  let eventId = '';
  const collectedAt = '2026-10-05T00:30:00Z'; // 08:30 Asia/Shanghai

  it('plan generated for A', async () => {
    plan = await mkPlan(P1, [acct.A], 'p1');
    expect(plan.items.length).toBe(1);
  });

  it('event converts to a REMOTE reading bound to the plan item', async () => {
    const res = await ingest({
      externalEventKey: `E1-${RUN}`,
      vendorDeviceKey: DEVKEY,
      businessPeriod: P1,
      collectedAt,
      readingValue: '123.5',
    }).expect(201);
    expect(res.body[0].outcome).toBe('CONVERTED');
    eventId = res.body[0].eventId;
    const readingId = res.body[0].readingId;
    expect(readingId).toBeTruthy();

    const reading = await request(app.getHttpServer())
      .get(`/meter-readings/${readingId}`)
      .set(auth(adminToken))
      .expect(200);
    expect(reading.body.resultType).toBe('REMOTE');
    expect(reading.body.source).toBe('REMOTE');
    expect(reading.body.sourceEventId).toBe(eventId);
    expect(reading.body.operatorId).toBeNull();
    expect(reading.body.readDate.startsWith('2026-10-05')).toBe(true);
    expect(reading.body.qcStatus).toBe('PENDING');

    const progress = await request(app.getHttpServer())
      .get(`/reading-plans/${plan.planId}/progress`)
      .set(auth(adminToken))
      .expect(200);
    expect(progress.body.planStatus).toBe('DONE');
  });

  it('same key + same payload → IDEMPOTENT_REPLAY (no second reading)', async () => {
    const res = await ingest({
      externalEventKey: `E1-${RUN}`,
      vendorDeviceKey: DEVKEY,
      businessPeriod: P1,
      collectedAt,
      readingValue: '123.5',
    }).expect(201);
    expect(res.body[0].outcome).toBe('IDEMPOTENT_REPLAY');
    expect(res.body[0].eventId).toBe(eventId);
    const { rows } = await owner.query(
      `SELECT COUNT(*)::int c FROM meter_reading WHERE source_event_id=$1`,
      [eventId],
    );
    expect(rows[0].c).toBe(1);
    const logs = await request(app.getHttpServer())
      .get(`/remote-events/${eventId}`)
      .set(auth(adminToken))
      .expect(200);
    const actions = logs.body.processLogs.map((l: { action: string }) => l.action);
    expect(actions).toContain('RECEIVED');
    expect(actions).toContain('CONVERTED');
    expect(actions).toContain('IDEMPOTENT_REPLAY');
  });

  it('same key + different payload → EVENT_KEY_CONFLICT, original preserved', async () => {
    const res = await ingest({
      externalEventKey: `E1-${RUN}`,
      vendorDeviceKey: DEVKEY,
      businessPeriod: P1,
      collectedAt,
      readingValue: '999.9',
    }).expect(201);
    expect(res.body[0].outcome).toBe('EVENT_KEY_CONFLICT');
    const detail = await request(app.getHttpServer())
      .get(`/remote-events/${eventId}`)
      .set(auth(adminToken))
      .expect(200);
    expect(detail.body.currentIssueCode).toBe('EVENT_KEY_CONFLICT');
    expect(Number(detail.body.readingValue)).toBe(123.5); // original preserved
    const { rows } = await owner.query(
      `SELECT COUNT(*)::int c FROM raw_remote_event
       WHERE tenant_id=$1 AND external_event_key=$2`,
      [TENANT, `E1-${RUN}`],
    );
    expect(rows[0].c).toBe(1);
  });
});

describe('resolution failures → replay', () => {
  it('unknown device → UNBOUND DEVICE_NOT_FOUND', async () => {
    const res = await ingest({
      vendorDeviceKey: `GHOST-${RUN}`,
      businessPeriod: '202610',
      collectedAt: '2026-10-06T00:30:00Z',
      readingValue: '10',
    }).expect(201);
    expect(res.body[0].outcome).toBe('UNBOUND');
    const detail = await request(app.getHttpServer())
      .get(`/remote-events/${res.body[0].eventId}`)
      .set(auth(adminToken))
      .expect(200);
    expect(detail.body.currentIssueCode).toBe('DEVICE_NOT_FOUND');
  });

  it('outside binding window → UNBOUND NO_EFFECTIVE_BINDING → extend binding → replay → CONVERTED', async () => {
    // The A binding covers [installedAt, +400d); this event lands past it,
    // on its own period so no completed reading conflicts with the replay.
    await mkPlan('202604', [acct.A], 'p0');
    const res = await ingest({
      vendorDeviceKey: DEVKEY,
      businessPeriod: '202604',
      collectedAt: plusDays(instInstalledAt, 401),
      readingValue: '10',
    }).expect(201);
    expect(res.body[0].outcome).toBe('UNBOUND');
    const eventId = res.body[0].eventId;
    const detail = await request(app.getHttpServer())
      .get(`/remote-events/${eventId}`)
      .set(auth(adminToken))
      .expect(200);
    expect(detail.body.currentIssueCode).toBe('NO_EFFECTIVE_BINDING');

    // Extend the existing binding to cover the late event, then replay.
    const bindings = await request(app.getHttpServer())
      .get(`/remote-devices/${deviceId}`)
      .set(auth(adminToken))
      .expect(200);
    const binding = bindings.body.bindings.find(
      (b: { installationId: string }) => b.installationId === inst.A,
    );
    await request(app.getHttpServer())
      .patch(`/remote-device-bindings/${binding.id}`)
      .set(auth(adminToken))
      .send({ effectiveTo: plusDays(instInstalledAt, 500) })
      .expect(200);
    const replay = await request(app.getHttpServer())
      .post(`/remote-events/${eventId}/replay`)
      .set(auth(adminToken))
      .expect(201);
    expect(replay.body.status).toBe('CONVERTED');
    expect(replay.body.readingId).toBeTruthy();
  });

  it('no plan → WAITING_PLAN → plan generated → replay → CONVERTED', async () => {
    const res = await ingest({
      vendorDeviceKey: DEVKEY,
      businessPeriod: '202611',
      collectedAt: '2026-11-05T00:30:00Z',
      readingValue: '140',
    }).expect(201);
    expect(res.body[0].outcome).toBe('WAITING_PLAN');
    const eventId = res.body[0].eventId;
    await mkPlan('202611', [acct.A], 'p2');
    const replay = await request(app.getHttpServer())
      .post(`/remote-events/${eventId}/replay`)
      .set(auth(adminToken))
      .expect(201);
    expect(replay.body.status).toBe('CONVERTED');
  });
});

describe('conflict adjudication', () => {
  const P2 = '202612';
  let conflictEvent = '';
  let keepEvent = '';
  let itemA = '';
  let manualReadingA = '';

  it('manual read QC PASSED → remote → CONFLICT → USE_REMOTE → supersede chain', async () => {
    const plan = await mkPlan(P2, [acct.A], 'p3');
    itemA = itemFor(plan.items, acct.A);
    manualReadingA = (
      await request(app.getHttpServer())
        .post('/meter-readings')
        .set(auth(adminToken))
        .send({ planItemId: itemA, resultType: 'ACTUAL', readingValue: 200 })
        .expect(201)
    ).body.id;
    await request(app.getHttpServer())
      .post(`/meter-readings/${manualReadingA}/qc`)
      .set(auth(adminToken))
      .send({ action: 'pass' })
      .expect(201);

    const res = await ingest({
      vendorDeviceKey: DEVKEY,
      businessPeriod: P2,
      collectedAt: '2026-12-05T00:30:00Z',
      readingValue: '205',
    }).expect(201);
    expect(res.body[0].outcome).toBe('CONFLICT');
    conflictEvent = res.body[0].eventId;

    const res_ = await request(app.getHttpServer())
      .post(`/remote-events/${conflictEvent}/resolve-conflict`)
      .set(auth(adminToken))
      .send({ decision: 'USE_REMOTE', note: 'vendor data trusted' })
      .expect(201);
    expect(res_.body.status).toBe('CONVERTED');
    const correction = await request(app.getHttpServer())
      .get(`/meter-readings/${res_.body.readingId}`)
      .set(auth(adminToken))
      .expect(200);
    expect(correction.body.supersedesReadingId).toBe(manualReadingA);
    expect(correction.body.resultType).toBe('REMOTE');
    expect(Number(correction.body.readingValue)).toBe(205);
  });

  it('KEEP_ACTUAL → IGNORED → replay refused', async () => {
    const plan = await mkPlan('202701', [acct.B], 'p4');
    const itemB = itemFor(plan.items, acct.B);
    const manualB = (
      await request(app.getHttpServer())
        .post('/meter-readings')
        .set(auth(adminToken))
        .send({ planItemId: itemB, resultType: 'ACTUAL', readingValue: 50 })
        .expect(201)
    ).body.id;
    await request(app.getHttpServer())
      .post(`/meter-readings/${manualB}/qc`)
      .set(auth(adminToken))
      .send({ action: 'pass' })
      .expect(201);
    // device2 bound to inst.B
    const dev2 = await request(app.getHttpServer())
      .post('/remote-devices')
      .set(auth(adminToken))
      .send({ remoteSourceId: sourceId, vendorDeviceKey: `DEVB-${RUN}` })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/remote-devices/${dev2.body.id}/bindings`)
      .set(auth(adminToken))
      .send({ installationId: inst.B, effectiveFrom: instAt.B })
      .expect(201);
    const res = await ingest({
      vendorDeviceKey: `DEVB-${RUN}`,
      businessPeriod: '202701',
      collectedAt: '2027-01-05T00:30:00Z',
      readingValue: '55',
    }).expect(201);
    expect(res.body[0].outcome).toBe('CONFLICT');
    keepEvent = res.body[0].eventId;

    const keep = await request(app.getHttpServer())
      .post(`/remote-events/${keepEvent}/resolve-conflict`)
      .set(auth(adminToken))
      .send({ decision: 'KEEP_ACTUAL' })
      .expect(201);
    expect(keep.body.status).toBe('IGNORED');
    await request(app.getHttpServer())
      .post(`/remote-events/${keepEvent}/replay`)
      .set(auth(adminToken))
      .expect(409);
  });
});

describe('late recovery + plan ambiguity', () => {
  it('item NO_READ + plan DONE → remote lands READ via late mode', async () => {
    const plan = await mkPlan('202702', [acct.A], 'p5');
    const item = itemFor(plan.items, acct.A);
    await request(app.getHttpServer())
      .post('/meter-readings')
      .set(auth(adminToken))
      .send({ planItemId: item, resultType: 'NO_READ', exceptionCode: 'LOCKED', estimateQty: 8 })
      .expect(201);
    const res = await ingest({
      vendorDeviceKey: DEVKEY,
      businessPeriod: '202702',
      collectedAt: '2027-02-05T00:30:00Z',
      readingValue: '260',
    }).expect(201);
    expect(res.body[0].outcome).toBe('CONVERTED');
    const progress = await request(app.getHttpServer())
      .get(`/reading-plans/${plan.planId}/progress`)
      .set(auth(adminToken))
      .expect(200);
    expect(progress.body.planStatus).toBe('DONE');
    const reading = await request(app.getHttpServer())
      .get(`/meter-readings/${res.body[0].readingId}`)
      .set(auth(adminToken))
      .expect(200);
    expect(reading.body.resultType).toBe('REMOTE');
    expect(reading.body.supersedesReadingId).toBeNull();
  });

  it('two items same account+period → FAILED PLAN_ITEM_AMBIGUOUS → fix snapshot → replay → CONVERTED', async () => {
    const p1 = await mkPlan('202703', [acct.A], 'amb1');
    const p2 = await mkPlan('202703', [acct.A], 'amb2');
    const res = await ingest({
      vendorDeviceKey: DEVKEY,
      businessPeriod: '202703',
      collectedAt: '2027-03-05T00:30:00Z',
      readingValue: '300',
    }).expect(201);
    expect(res.body[0].outcome).toBe('FAILED');
    const eventId = res.body[0].eventId;
    const detail = await request(app.getHttpServer())
      .get(`/remote-events/${eventId}`)
      .set(auth(adminToken))
      .expect(200);
    expect(detail.body.currentIssueCode).toBe('PLAN_ITEM_AMBIGUOUS');

    // Break the tie: item in p2 was generated for a different meter — its
    // plannedInstallationId no longer matches the binding's installation.
    const item2 = itemFor(p2.items, acct.A);
    await owner.query(
      `UPDATE reading_plan_item SET planned_installation_id=$1
       WHERE tenant_id=$2 AND id=$3`,
      [inst.B, TENANT, item2],
    );
    const replay = await request(app.getHttpServer())
      .post(`/remote-events/${eventId}/replay`)
      .set(auth(adminToken))
      .expect(201);
    expect(replay.body.status).toBe('CONVERTED');
    const reading = await request(app.getHttpServer())
      .get(`/meter-readings/${replay.body.readingId}`)
      .set(auth(adminToken))
      .expect(200);
    const item1 = itemFor(p1.items, acct.A);
    expect(reading.body.planItemId).toBe(item1);
  });
});

describe('T11: REMOTE reading → QC → reconciliation trusted chain', () => {
  it('REMOTE+PASSED lands as the reconciliation actual reading', async () => {
    // Fresh account C + its own bound device.
    const c = await onboard('C');
    acct.C = c.waterAccount.id;
    inst.C = c.installation.id;
    instAt.C = c.installation.installedAt;
    const dev = await request(app.getHttpServer())
      .post('/remote-devices')
      .set(auth(adminToken))
      .send({ remoteSourceId: sourceId, vendorDeviceKey: `DEVC-${RUN}` })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/remote-devices/${dev.body.id}/bindings`)
      .set(auth(adminToken))
      .send({ installationId: inst.C, effectiveFrom: instAt.C })
      .expect(201);

    // Anchor: manual ACTUAL 202704 = 100, QC PASSED.
    const p1 = await mkPlan('202704', [acct.C], 'r1');
    const anchorId = (
      await request(app.getHttpServer())
        .post('/meter-readings')
        .set(auth(adminToken))
        .send({
          planItemId: itemFor(p1.items, acct.C),
          resultType: 'ACTUAL',
          readingValue: 100,
        })
        .expect(201)
    ).body.id;
    await request(app.getHttpServer())
      .post(`/meter-readings/${anchorId}/qc`)
      .set(auth(adminToken))
      .send({ action: 'pass' })
      .expect(201);

    // Remote 202705 = 140 → CONVERTED → QC PASSED.
    await mkPlan('202705', [acct.C], 'r2');
    const res = await ingest({
      vendorDeviceKey: `DEVC-${RUN}`,
      businessPeriod: '202705',
      collectedAt: '2027-05-05T00:30:00Z',
      readingValue: '140',
    }).expect(201);
    expect(res.body[0].outcome).toBe('CONVERTED');
    const remoteReadingId = res.body[0].readingId as string;
    await request(app.getHttpServer())
      .post(`/meter-readings/${remoteReadingId}/qc`)
      .set(auth(adminToken))
      .send({ action: 'pass' })
      .expect(201);

    // A settled span is required — DRAFT estimate for 202705 (absorb path,
    // no tariff/bill dependency).
    const stl = (
      await owner.query(
        `INSERT INTO consumption_settlement
           (id, tenant_id, water_account_id, period, total_usage_qty, is_estimated,
            estimate_method, estimate_reason, status, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, '202705', 38, true, 'MANUAL',
                 'e5p-estimate', 'DRAFT', now(), now())
         RETURNING id::text AS id`,
        [TENANT, acct.C],
      )
    ).rows[0].id as string;
    await owner.query(
      `INSERT INTO consumption_component
         (id, tenant_id, settlement_id, installation_id, prev_reading_value,
          end_reading_value, usage_qty, source_type, source_reading_id,
          created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 100, 138, 38, 'ESTIMATE', NULL,
               now(), now())`,
      [TENANT, stl, inst.C],
    );

    // Reconciliation must treat REMOTE+PASSED as the trusted actual.
    const recon = await request(app.getHttpServer())
      .post('/reconciliations')
      .set(auth(adminToken))
      .send({ waterAccountId: acct.C })
      .expect(201);
    expect(recon.body.anchorReadingId).toBe(anchorId);
    expect(recon.body.actualReadingId).toBe(remoteReadingId);
    expect(recon.body.actualTotalUsage).toBe('40');
    expect(recon.body.fromPeriod).toBe('202705');
    expect(recon.body.toPeriod).toBe('202705');
    expect(recon.body.absorbedSettlementId).toBe(stl);
    expect(recon.body.status).toBe('ABSORBED');
  });
});

describe('release fixes — canonical validation', () => {
  it('negative readingValue → 422 INVALID_READING_VALUE', async () => {
    const res = await ingest({
      vendorDeviceKey: DEVKEY,
      businessPeriod: '202610',
      collectedAt: '2026-10-07T00:00:00Z',
      readingValue: '-5',
    }).expect(422);
    expect(res.body.code).toBe('INVALID_READING_VALUE');
  });

  it('businessPeriod must be a real YYYYMM — month 01..12', async () => {
    const res = await ingest({
      vendorDeviceKey: DEVKEY,
      businessPeriod: '202613',
      collectedAt: '2026-10-07T00:00:00Z',
      readingValue: '5',
    }).expect(400);
    expect(res.body.code).toBe('EVENT_FIELDS_REQUIRED');
    await ingest({
      vendorDeviceKey: DEVKEY,
      businessPeriod: '202600',
      collectedAt: '2026-10-07T00:00:00Z',
      readingValue: '5',
    }).expect(400);
  });

  it('naive collectedAt resolves through the SOURCE timezone, never the server tz', async () => {
    // Source is Asia/Shanghai (UTC+8): '2026-10-06 08:30:00' local =
    // 2026-10-06T00:30:00Z absolute — independent of the machine's zone.
    const res = await ingest({
      vendorDeviceKey: `GHOST-TZ-${RUN}`,
      businessPeriod: '202610',
      collectedAt: '2026-10-06 08:30:00',
      readingValue: '5',
    }).expect(201);
    const detail = await request(app.getHttpServer())
      .get(`/remote-events/${res.body[0].eventId}`)
      .set(auth(adminToken))
      .expect(200);
    expect(detail.body.collectedAt).toBe('2026-10-06T00:30:00.000Z');
    // An explicit offset is honored verbatim.
    const res2 = await ingest({
      vendorDeviceKey: `GHOST-TZ-${RUN}`,
      businessPeriod: '202610',
      collectedAt: '2026-10-06T08:30:00+05:30',
      readingValue: '5',
    }).expect(201);
    const detail2 = await request(app.getHttpServer())
      .get(`/remote-events/${res2.body[0].eventId}`)
      .set(auth(adminToken))
      .expect(200);
    expect(detail2.body.collectedAt).toBe('2026-10-06T03:00:00.000Z');
  });

  it('EVENT_KEY_CONFLICT process log preserves the incoming canonical payload', async () => {
    const res = await ingest({
      externalEventKey: `E1-${RUN}`,
      vendorDeviceKey: DEVKEY,
      businessPeriod: '202610',
      collectedAt: '2026-10-05T00:30:00Z',
      readingValue: '777.7',
    }).expect(201);
    expect(res.body[0].outcome).toBe('EVENT_KEY_CONFLICT');
    const detail = await request(app.getHttpServer())
      .get(`/remote-events/${res.body[0].eventId}`)
      .set(auth(adminToken))
      .expect(200);
    const conflicts = detail.body.processLogs.filter(
      (l: { action: string }) => l.action === 'EVENT_KEY_CONFLICT',
    );
    const last = conflicts[conflicts.length - 1];
    expect(last.detail.incomingCanonicalPayload.readingValue).toBe('777.7');
    expect(last.detail.incomingPayloadHash).toBeTruthy();
    // The stored event itself is still the original fact.
    expect(Number(detail.body.readingValue)).toBe(123.5);
  });
});

describe('release fixes — manual vs remote concurrency', () => {
  it('manual ACTUAL ∥ remote ingest: one current reading, event kept, no 500', async () => {
    const d = await onboard('D');
    acct.D = d.waterAccount.id;
    inst.D = d.installation.id;
    instAt.D = d.installation.installedAt;
    const dev = await request(app.getHttpServer())
      .post('/remote-devices')
      .set(auth(adminToken))
      .send({ remoteSourceId: sourceId, vendorDeviceKey: `DEVD-${RUN}` })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/remote-devices/${dev.body.id}/bindings`)
      .set(auth(adminToken))
      .send({ installationId: inst.D, effectiveFrom: instAt.D })
      .expect(201);
    const plan = await mkPlan('202801', [acct.D], 'race');
    const itemD = itemFor(plan.items, acct.D);

    // Fire both writes at once — whichever loses the plan-item lock must
    // see the winner's committed state, not a pre-lock snapshot.
    const [manual, remote] = await Promise.all([
      request(app.getHttpServer())
        .post('/meter-readings')
        .set(auth(adminToken))
        .send({ planItemId: itemD, resultType: 'ACTUAL', readingValue: 500 }),
      ingest({
        vendorDeviceKey: `DEVD-${RUN}`,
        businessPeriod: '202801',
        collectedAt: '2028-01-05T00:30:00Z',
        readingValue: '500',
      }),
    ]);
    expect(manual.status).toBeLessThan(500);
    expect(remote.status).toBe(201);

    const eventId = remote.body[0].eventId as string;
    expect(eventId).toBeTruthy();
    const detail = await request(app.getHttpServer())
      .get(`/remote-events/${eventId}`)
      .set(auth(adminToken))
      .expect(200);
    // The event is always preserved; the loser lands CONFLICT for human
    // adjudication (or — if manual never committed — a clean CONVERTED).
    expect(['CONFLICT', 'CONVERTED']).toContain(detail.body.processingStatus);

    // Exactly one current completed reading on the item.
    const item = (
      await owner.query(
        `SELECT status, completed_reading_id FROM reading_plan_item
         WHERE tenant_id=$1 AND id=$2`,
        [TENANT, itemD],
      )
    ).rows[0];
    expect(item.status).toBe('READ');
    expect(item.completed_reading_id).toBeTruthy();
    if (detail.body.processingStatus === 'CONFLICT') {
      // Manual won → its reading is the current fact; the remote fact
      // awaits adjudication instead of silently overwriting.
      expect(item.completed_reading_id).toBe(manual.body.id);
    }
    // No orphan: every reading on the item is reachable through
    // completed_reading_id or the supersede chain.
    const { rows } = await owner.query(
      `SELECT COUNT(*)::int c FROM meter_reading
       WHERE tenant_id=$1 AND plan_item_id=$2`,
      [TENANT, itemD],
    );
    expect(rows[0].c).toBe(detail.body.processingStatus === 'CONVERTED' ? 1 : 1);
  });
});

describe('release fixes — FINAL estimate + POSTED bill + late REMOTE → adjustment', () => {
  it('frozen settlement/bill untouched; reconciliation posts an ADJUSTMENT bill', async () => {
    // Tariff fixtures (pricing engine needs an ACTIVE plan + fee items).
    const waterItem = (
      await request(app.getHttpServer())
        .post('/fee-items')
        .set(auth(adminToken))
        .send({ code: `WATER-${RUN}`, name: '水费', calcType: 'PER_QTY' })
        .expect(201)
    ).body.id;
    const fixedItem = (
      await request(app.getHttpServer())
        .post('/fee-items')
        .set(auth(adminToken))
        .send({ code: `FIXED-${RUN}`, name: '定额费', calcType: 'FIXED' })
        .expect(201)
    ).body.id;
    // Idempotent across reruns: a leftover ACTIVE RES_METERED plan from a
    // previous run would 409 the activation below.
    await owner.query(
      `UPDATE tariff_plan SET status='RETIRED'
       WHERE tenant_id=$1 AND usage_category='RES_METERED' AND status='ACTIVE'`,
      [TENANT],
    );
    const plan = await request(app.getHttpServer())
      .post('/tariff-plans')
      .set(auth(adminToken))
      .send({
        code: `RES-${RUN}`,
        name: '居民水价',
        usageCategory: 'RES_METERED',
        effectiveFrom: '2026-01-01',
        tiers: [
          { feeItemId: waterItem, tierNo: 1, fromQty: 0, toQty: 180, unitPrice: '3.0' },
          { feeItemId: waterItem, tierNo: 2, fromQty: 180, toQty: null, unitPrice: '4.5' },
          { feeItemId: fixedItem, tierNo: 1, fromQty: 0, toQty: null, unitPrice: '10' },
        ],
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/tariff-plans/${plan.body.id}/activate`)
      .set(auth(adminToken))
      .send({})
      .expect(201);

    const e = await onboard('E');
    acct.E = e.waterAccount.id;
    inst.E = e.installation.id;
    instAt.E = e.installation.installedAt;
    const dev = await request(app.getHttpServer())
      .post('/remote-devices')
      .set(auth(adminToken))
      .send({ remoteSourceId: sourceId, vendorDeviceKey: `DEVE-${RUN}` })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/remote-devices/${dev.body.id}/bindings`)
      .set(auth(adminToken))
      .send({ installationId: inst.E, effectiveFrom: instAt.E })
      .expect(201);

    // Anchor: manual ACTUAL 202706 = 1000, QC PASSED.
    const p1 = await mkPlan('202706', [acct.E], 'f1');
    const anchorId = (
      await request(app.getHttpServer())
        .post('/meter-readings')
        .set(auth(adminToken))
        .send({
          planItemId: itemFor(p1.items, acct.E),
          resultType: 'ACTUAL',
          readingValue: 1000,
        })
        .expect(201)
    ).body.id;
    await request(app.getHttpServer())
      .post(`/meter-readings/${anchorId}/qc`)
      .set(auth(adminToken))
      .send({ action: 'pass' })
      .expect(201);

    // 202707: estimated FINAL settlement (30) → billed → POSTED.
    const settlementId = (
      await owner.query(
        `INSERT INTO consumption_settlement
           (id, tenant_id, water_account_id, period, total_usage_qty, is_estimated,
            estimate_method, estimate_reason, status, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, '202707', 30, true, 'MANUAL',
                 'e5p-estimate', 'FINAL', now(), now())
         RETURNING id::text AS id`,
        [TENANT, acct.E],
      )
    ).rows[0].id as string;
    const run = await request(app.getHttpServer())
      .post('/billing-runs')
      .set(auth(adminToken))
      .send({ period: '202707' })
      .expect(201);
    const posted = await request(app.getHttpServer())
      .post(`/billing-runs/${run.body.id}/post`)
      .set(auth(adminToken))
      .send({})
      .expect(201);
    expect(posted.body.status).toBe('POSTED');
    const billsBefore = (
      await request(app.getHttpServer())
        .get(`/bills?waterAccountId=${acct.E}`)
        .set(auth(adminToken))
        .expect(200)
    ).body as { id: string; period: string; status: string; billKind: string; totalAmount: string }[];
    const postedBill = billsBefore.find((b) => b.period === '202707');
    expect(postedBill?.status).toBe('POSTED');

    // Late remote fact for 202707 arrives → converts → QC PASS.
    await mkPlan('202707', [acct.E], 'f2');
    const res = await ingest({
      vendorDeviceKey: `DEVE-${RUN}`,
      businessPeriod: '202707',
      collectedAt: '2027-07-05T00:30:00Z',
      readingValue: '1035',
    }).expect(201);
    expect(res.body[0].outcome).toBe('CONVERTED');
    const remoteReadingId = res.body[0].readingId as string;
    await request(app.getHttpServer())
      .post(`/meter-readings/${remoteReadingId}/qc`)
      .set(auth(adminToken))
      .send({ action: 'pass' })
      .expect(201);

    // Reconciliation: actual usage 35 vs settled/billed 30 → +5 m³
    // remainder over a FINAL+billed span → APPLIED + ADJUSTMENT bill.
    const recon = await request(app.getHttpServer())
      .post('/reconciliations')
      .set(auth(adminToken))
      .send({ waterAccountId: acct.E })
      .expect(201);
    expect(recon.body.status).toBe('APPLIED');
    expect(recon.body.anchorReadingId).toBe(anchorId);
    expect(recon.body.actualReadingId).toBe(remoteReadingId);
    expect(recon.body.actualTotalUsage).toBe('35');
    expect(recon.body.previouslySettledUsage).toBe('30');
    expect(recon.body.remainderUsage).toBe('5');
    expect(recon.body.adjustmentBill).toBeTruthy();

    // History is append-only: the FINAL settlement and the POSTED bill
    // are byte-identical to before — the correction lives on the new
    // ADJUSTMENT bill only.
    const stl = (
      await owner.query(
        `SELECT status, total_usage_qty::text u FROM consumption_settlement
         WHERE tenant_id=$1 AND id=$2`,
        [TENANT, settlementId],
      )
    ).rows[0];
    expect(stl.status).toBe('FINAL');
    expect(stl.u).toBe('30.0000');
    const bill = (
      await owner.query(
        `SELECT status, bill_kind, total_amount::text a FROM bill
         WHERE tenant_id=$1 AND id=$2`,
        [TENANT, postedBill!.id],
      )
    ).rows[0];
    expect(bill.status).toBe('POSTED');
    expect(bill.bill_kind).toBe('NORMAL');
    expect(bill.a).toBe(postedBill!.totalAmount);
    const adj = (
      await owner.query(
        `SELECT status, bill_kind, source_type FROM bill WHERE tenant_id=$1 AND id=$2`,
        [TENANT, recon.body.adjustmentBill.id],
      )
    ).rows[0];
    expect(adj.bill_kind).toBe('ADJUSTMENT');
    expect(adj.status).toBe('POSTED');
  });
});
