/**
 * E7 Meter Lifecycle e2e against `watersaas_test` — fixtures carry the
 * `t17-` prefix. Boots the real AppModule so JWT/permission guards, tenant
 * ALS and RLS all apply.
 *
 * Covers the frozen E7 contract:
 *  1. POST /meter-installations/:id/replace — atomic remove+install:
 *     old inst REMOVED + final_reading, old meter AVAILABLE, new inst
 *     ACTIVE + independent initial_reading, new meter INSTALLED,
 *     parent_meter_id lineage; bindings closed, never migrated.
 *  2. Field guards: missing readings → 400; same meter → 400; new meter
 *     not AVAILABLE → 409; REMOVED inst → 409; bogus new meter → 400 with
 *     FULL rollback (old inst/meter untouched).
 *  3. FINAL settlement / POSTED bill in the replacedAt period →
 *     409 SETTLEMENT_PERIOD_ALREADY_FINALIZED (fail closed).
 *  4. Close guard: ACTIVE installation blocks close → 409
 *     ACCOUNT_HAS_ACTIVE_INSTALLATION; CLOSED account rejects install
 *     and replace; SUSPENDED stays permissive.
 *  5. Org data scope: branch-scoped staff cannot read/write another
 *     branch's installations; meter detail filters embedded history.
 *  6. Concurrency C1–C4: close‖install, replace‖remove, replace‖replace,
 *     same-meter‖install — legal end states only.
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

const T17A = 'aa17aa17-aa17-4a17-8a17-aa17aa17aa17';
const T17B = 'bb17bb17-bb17-4b17-8b17-bb17bb17bb17';
const ORG_A = 'aa17aa17-0000-4000-8000-0000000000c0';
const ORG_B = 'bb17bb17-0000-4000-8000-0000000000c0';
const ORG_BRANCH_A = 'aa17aa17-0000-4000-8000-0000000000d1';
const ORG_BRANCH_B = 'aa17aa17-0000-4000-8000-0000000000d2';
const ROLE_ADMIN_A = 'aa17aa17-0000-4000-8000-00000000ad01';
const ROLE_BRANCH_A = 'aa17aa17-0000-4000-8000-00000000ad02';
const ROLE_B_ADMIN = 'bb17bb17-0000-4000-8000-00000000ad01';
const PERM_CUST_READ = 'aa17aa17-0000-4000-8000-00000000e601';
const PERM_CUST_WRITE = 'aa17aa17-0000-4000-8000-00000000e602';
const STAFF_ADMIN_A = 'aa17aa17-0000-4000-8000-0000000a0001';
const STAFF_BRANCH_A = 'aa17aa17-0000-4000-8000-0000000a0002';
const STAFF_B_ADMIN = 'bb17bb17-0000-4000-8000-0000000a0001';

const owner = new pg.Client({ connectionString: OWNER_URL });
let app: INestApplication<App>;
let adminToken = '';
let branchToken = '';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

const post = (path: string, body: unknown, token = adminToken) =>
  request(app.getHttpServer()).post(path).set(auth(token)).send(body);

const get = (path: string, token = adminToken) =>
  request(app.getHttpServer()).get(path).set(auth(token));

/** Onboard a fresh account+meter+ACTIVE installation. */
const onboard = async (tag: string) => {
  const res = await post('/water-accounts/onboard', {
    customer: { name: `T17 ${tag} ${RUN}`, custType: 'PERSONAL' },
    account: { usageCategory: 'RES_METERED', addr: `${tag} lifecycle st` },
    meter: { brand: 't17-brand', caliber: 'DN15' },
    installation: { initialReading: 0, installedAt: '2026-01-01' },
  }).expect(201);
  return res.body as {
    waterAccount: { id: string };
    meter: { id: string };
    installation: { id: string; meterId: string };
  };
};

/** Register an AVAILABLE meter. */
const newMeter = async () =>
  (
    await post('/meters', { brand: 't17-spare', caliber: 'DN15' }).expect(201)
  ).body as { id: string };

const instRow = async (id: string) =>
  (
    await owner.query(
      `SELECT status::text AS status, meter_id::text AS meter_id,
              final_reading::text AS final_reading,
              removed_at::text AS removed_at
       FROM meter_installation WHERE tenant_id = $1 AND id = $2`,
      [T17A, id],
    )
  ).rows[0];

const meterStatus = async (id: string) =>
  (
    await owner.query(
      `SELECT status::text AS s FROM meter WHERE tenant_id = $1 AND id = $2`,
      [T17A, id],
    )
  ).rows[0].s as string;

/** Anchor a water account to a reading book under `orgId`. */
const coverAccount = async (orgId: string, waterAccountId: string, tag: string) => {
  const bookId = (
    await owner.query(
      `INSERT INTO reading_book
         (id, tenant_id, book_no, name, org_unit_id, cadence, meter_channel,
          created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'MONTHLY', 'MECHANICAL',
               now(), now())
       RETURNING id::text AS id`,
      [T17A, `t17-${tag}-${RUN}`, `T17 Book ${tag}`, orgId],
    )
  ).rows[0].id;
  const planId = (
    await owner.query(
      `INSERT INTO reading_plan
         (id, tenant_id, book_id, period, plan_date, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, '209901', '2099-01-05', 'OPEN',
               now(), now())
       RETURNING id::text AS id`,
      [T17A, bookId],
    )
  ).rows[0].id;
  await owner.query(
    `INSERT INTO reading_plan_item
       (id, tenant_id, plan_id, water_account_id, seq_no, status,
        created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 1, 'PENDING', now(), now())`,
    [T17A, planId, waterAccountId],
  );
};

/** Current UTC period YYYYMM — matches the service's period key. */
const currentPeriod = () => {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

beforeAll(async () => {
  await owner.connect();
  const hash = await bcrypt.hash('t17-pass', 10);

  await owner.query(
    `INSERT INTO tenant (id, code, name, status, created_at, updated_at)
     VALUES ($1, 't17-water', 'T17 Water', 'ACTIVE', now(), now()),
            ($2, 't17-other', 'T17 Other', 'ACTIVE', now(), now())
     ON CONFLICT DO NOTHING`,
    [T17A, T17B],
  );
  await owner.query(
    `INSERT INTO org_unit (id, tenant_id, parent_id, name, type, created_at, updated_at)
     VALUES ($1, $2, NULL, 'T17 Company', 'COMPANY', now(), now()),
            ($3, $4, NULL, 'T17B Company', 'COMPANY', now(), now()),
            ($5, $2, $1, 'T17 Branch A', 'BRANCH', now(), now()),
            ($6, $2, $1, 'T17 Branch B', 'BRANCH', now(), now())
     ON CONFLICT DO NOTHING`,
    [ORG_A, T17A, ORG_B, T17B, ORG_BRANCH_A, ORG_BRANCH_B],
  );
  await owner.query(
    `INSERT INTO role (id, tenant_id, code, name, data_scope, created_at, updated_at)
     VALUES ($1, $3, 'admin', 'T17 Admin', 'ALL', now(), now()),
            ($2, $3, 't17-branch', 'T17 Branch', 'ORG_SUBTREE', now(), now()),
            ($4, $5, 'admin', 'T17B Admin', 'ALL', now(), now())
     ON CONFLICT DO NOTHING`,
    [ROLE_ADMIN_A, ROLE_BRANCH_A, T17A, ROLE_B_ADMIN, T17B],
  );
  await owner.query(
    `INSERT INTO permission (id, tenant_id, code, type, created_at, updated_at)
     VALUES ($1, $2, 'customer:read', 'ACTION', now(), now()),
            ($3, $2, 'customer:write', 'ACTION', now(), now())
     ON CONFLICT DO NOTHING`,
    [PERM_CUST_READ, T17A, PERM_CUST_WRITE],
  );
  await owner.query(
    `INSERT INTO role_permission (tenant_id, role_id, permission_id, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now()),
            ($1, $2, $4, now(), now())
     ON CONFLICT DO NOTHING`,
    [T17A, ROLE_BRANCH_A, PERM_CUST_READ, PERM_CUST_WRITE],
  );
  await owner.query(
    `INSERT INTO staff (id, tenant_id, org_unit_id, login, password_hash, name, status, created_at, updated_at)
     VALUES ($1, $4, $6, 't17-admin',  $7, 'T17 Admin',  'ACTIVE', now(), now()),
            ($2, $4, $8, 't17-branch', $7, 'T17 Branch', 'ACTIVE', now(), now()),
            ($3, $5, $9, 't17b-admin', $7, 'T17B Admin', 'ACTIVE', now(), now())
     ON CONFLICT (tenant_id, login) DO NOTHING`,
    [
      STAFF_ADMIN_A, STAFF_BRANCH_A, STAFF_B_ADMIN,
      T17A, T17B, ORG_A, hash, ORG_BRANCH_A, ORG_B,
    ],
  );
  await owner.query(
    `INSERT INTO staff_role (tenant_id, staff_id, role_id, created_at, updated_at)
     VALUES ($1, $2, $4, now(), now()),
            ($1, $3, $5, now(), now()),
            ($6, $7, $8, now(), now())
     ON CONFLICT DO NOTHING`,
    [T17A, STAFF_ADMIN_A, STAFF_BRANCH_A, ROLE_ADMIN_A, ROLE_BRANCH_A,
     T17B, STAFF_B_ADMIN, ROLE_B_ADMIN],
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
        .send({ tenantCode, login: login_, password: 't17-pass' })
        .expect(201)
    ).body.accessToken as string;
  adminToken = await login('t17-water', 't17-admin');
  branchToken = await login('t17-water', 't17-branch');
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

describe('replace endpoint (换表)', () => {
  it('atomic: old inst REMOVED+final, old meter AVAILABLE, new inst ACTIVE, new meter INSTALLED, lineage set', async () => {
    const a = await onboard('r1');
    const m2 = await newMeter();

    const res = await post(`/meter-installations/${a.installation.id}/replace`, {
      newMeterId: m2.id,
      oldFinalReading: 100,
      newInitialReading: 5, // independent dial — NOT equal to oldFinal
      reason: 'REPLACE',
    }).expect(201);

    expect(res.body.installed.status).toBe('ACTIVE');
    expect(res.body.installed.meterId).toBe(m2.id);
    expect(Number(res.body.installed.initialReading)).toBe(5);
    expect(res.body.installed.reason).toBe('REPLACE');

    const old = await instRow(a.installation.id);
    expect(old.status).toBe('REMOVED');
    expect(Number(old.final_reading)).toBe(100);
    expect(old.removed_at).toBeTruthy();
    expect(await meterStatus(a.meter.id)).toBe('AVAILABLE');
    expect(await meterStatus(m2.id)).toBe('INSTALLED');

    // replacement lineage
    const parent = (
      await owner.query(
        `SELECT parent_meter_id::text AS p FROM meter WHERE id = $1`,
        [m2.id],
      )
    ).rows[0].p;
    expect(parent).toBe(a.meter.id);

    // account now shows REMOVED + ACTIVE
    const detail = await get(`/water-accounts/${a.waterAccount.id}`).expect(200);
    const statuses = detail.body.meterInstallations
      .map((i: { status: string }) => i.status)
      .sort();
    expect(statuses).toEqual(['ACTIVE', 'REMOVED']);
  });

  it('missing newMeterId / oldFinalReading / newInitialReading → 400', async () => {
    const a = await onboard('r2');
    const m2 = await newMeter();
    for (const body of [
      { oldFinalReading: 1, newInitialReading: 0 },
      { newMeterId: m2.id, newInitialReading: 0 },
      { newMeterId: m2.id, oldFinalReading: 1 },
    ]) {
      const res = await post(
        `/meter-installations/${a.installation.id}/replace`,
        body,
      );
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('REPLACE_FIELDS_REQUIRED');
    }
    // nothing was mutated
    expect((await instRow(a.installation.id)).status).toBe('ACTIVE');
    expect(await meterStatus(m2.id)).toBe('AVAILABLE');
  });

  it('same old/new meter → 400 SAME_METER_REPLACE', async () => {
    const a = await onboard('r3');
    const res = await post(`/meter-installations/${a.installation.id}/replace`, {
      newMeterId: a.meter.id,
      oldFinalReading: 10,
      newInitialReading: 0,
    }).expect(400);
    expect(res.body.code).toBe('SAME_METER_REPLACE');
  });

  it('new meter not AVAILABLE → 409 METER_NOT_AVAILABLE', async () => {
    const a = await onboard('r4');
    const b = await onboard('r4b'); // b.meter is INSTALLED
    const res = await post(`/meter-installations/${a.installation.id}/replace`, {
      newMeterId: b.meter.id,
      oldFinalReading: 10,
      newInitialReading: 0,
    }).expect(409);
    expect(res.body.code).toBe('METER_NOT_AVAILABLE');
  });

  it('bogus new meter → 400 and FULL rollback (old inst/meter untouched)', async () => {
    const a = await onboard('r5');
    const res = await post(`/meter-installations/${a.installation.id}/replace`, {
      newMeterId: '99999999-9999-4999-8999-999999999999',
      oldFinalReading: 50,
      newInitialReading: 0,
    }).expect(400);
    expect(res.body.code).toBe('METER_NOT_FOUND');

    const old = await instRow(a.installation.id);
    expect(old.status).toBe('ACTIVE');
    expect(old.final_reading).toBeNull();
    expect(await meterStatus(a.meter.id)).toBe('INSTALLED');
    const insts = await get(
      `/meter-installations?waterAccountId=${a.waterAccount.id}`,
    ).expect(200);
    expect(insts.body).toHaveLength(1);
  });

  it('replace on a REMOVED installation → 409 INSTALLATION_NOT_ACTIVE', async () => {
    const a = await onboard('r6');
    await post(`/meter-installations/${a.installation.id}/remove`, {
      finalReading: 10,
    }).expect(201);
    const m2 = await newMeter();
    const res = await post(`/meter-installations/${a.installation.id}/replace`, {
      newMeterId: m2.id,
      oldFinalReading: 10,
      newInitialReading: 0,
    }).expect(409);
    expect(res.body.code).toBe('INSTALLATION_NOT_ACTIVE');
    expect(await meterStatus(m2.id)).toBe('AVAILABLE');
  });

  it('FINAL settlement in the replacedAt period → 409 fail closed', async () => {
    const a = await onboard('r7');
    await owner.query(
      `INSERT INTO consumption_settlement
         (id, tenant_id, water_account_id, period, total_usage_qty, is_estimated,
          status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 7, false, 'FINAL', now(), now())`,
      [T17A, a.waterAccount.id, currentPeriod()],
    );
    const m2 = await newMeter();
    const res = await post(`/meter-installations/${a.installation.id}/replace`, {
      newMeterId: m2.id,
      oldFinalReading: 10,
      newInitialReading: 0,
    }).expect(409);
    expect(res.body.code).toBe('SETTLEMENT_PERIOD_ALREADY_FINALIZED');
    expect((await instRow(a.installation.id)).status).toBe('ACTIVE');
    expect(await meterStatus(m2.id)).toBe('AVAILABLE');
  });

  it('POSTED bill in the replacedAt period → 409 fail closed', async () => {
    const a = await onboard('r8');
    const sa = (
      await owner.query(
        `SELECT settle_account_id::text AS id FROM water_account WHERE id = $1`,
        [a.waterAccount.id],
      )
    ).rows[0].id;
    await owner.query(
      `INSERT INTO bill (id, tenant_id, settle_account_id, water_account_id, period,
                         bill_kind, source_type, source_id, status, is_estimated,
                         total_amount, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'NORMAL', 'MANUAL',
               gen_random_uuid(), 'POSTED', false, 10, now(), now())`,
      [T17A, sa, a.waterAccount.id, currentPeriod()],
    );
    const m2 = await newMeter();
    const res = await post(`/meter-installations/${a.installation.id}/replace`, {
      newMeterId: m2.id,
      oldFinalReading: 10,
      newInitialReading: 0,
    }).expect(409);
    expect(res.body.code).toBe('SETTLEMENT_PERIOD_ALREADY_FINALIZED');
  });

  it('bindings close on replace and are NOT migrated to the new meter', async () => {
    const a = await onboard('r9');
    const source = (
      await post('/remote-sources', {
        code: `t17-src-${RUN}`,
        name: 'T17 Source',
        type: 'FILE_IMPORT',
        adapterKey: 'file-csv',
        timezone: 'Asia/Shanghai',
      }).expect(201)
    ).body;
    const device = (
      await post('/remote-devices', {
        remoteSourceId: source.id,
        vendorDeviceKey: `t17-dev-${RUN}`,
      }).expect(201)
    ).body;
    const binding = (
      await post(`/remote-devices/${device.id}/bindings`, {
        installationId: a.installation.id,
        effectiveFrom: '2026-01-01T00:00:00Z',
      }).expect(201)
    ).body;

    const m2 = await newMeter();
    const res = await post(`/meter-installations/${a.installation.id}/replace`, {
      newMeterId: m2.id,
      oldFinalReading: 20,
      newInitialReading: 0,
    }).expect(201);
    const newInstId = res.body.installed.id;

    const b = (
      await owner.query(
        `SELECT effective_to::text AS t FROM remote_device_binding WHERE id = $1`,
        [binding.id],
      )
    ).rows[0];
    expect(b.t).toBeTruthy(); // closed, not left open
    // no binding exists for the new installation — explicit re-bind required
    const migrated = await owner.query(
      `SELECT count(*)::int AS n FROM remote_device_binding
       WHERE tenant_id = $1 AND installation_id = $2`,
      [T17A, newInstId],
    );
    expect(migrated.rows[0].n).toBe(0);
  });
});

describe('close guard + account status (销户拦截)', () => {
  it('ACTIVE installation blocks close → 409 ACCOUNT_HAS_ACTIVE_INSTALLATION; remove → close OK', async () => {
    const a = await onboard('c1');
    const blocked = await post(`/water-accounts/${a.waterAccount.id}/close`, {});
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('ACCOUNT_HAS_ACTIVE_INSTALLATION');

    await post(`/meter-installations/${a.installation.id}/remove`, {
      finalReading: 10,
    }).expect(201);
    const closed = await post(
      `/water-accounts/${a.waterAccount.id}/close`,
      {},
    ).expect(201);
    expect(closed.body.status).toBe('CLOSED');
  });

  it('CLOSED account rejects install and replace', async () => {
    const a = await onboard('c2');
    // Force CLOSED with the ACTIVE installation still attached — the state
    // the guard exists to prevent; seeded directly to test rejection paths.
    await owner.query(
      `UPDATE water_account SET status = 'CLOSED', closed_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [T17A, a.waterAccount.id],
    );
    const m2 = await newMeter();
    const inst = await post('/meter-installations', {
      waterAccountId: a.waterAccount.id,
      meterId: m2.id,
      initialReading: 0,
    }).expect(409);
    expect(inst.body.code).toBe('ACCOUNT_CLOSED');
    expect(await meterStatus(m2.id)).toBe('AVAILABLE');

    const rep = await post(`/meter-installations/${a.installation.id}/replace`, {
      newMeterId: m2.id,
      oldFinalReading: 10,
      newInitialReading: 0,
    }).expect(409);
    expect(rep.body.code).toBe('ACCOUNT_CLOSED');
  });

  it('SUSPENDED account stays permissive for install; close still blocked by ACTIVE', async () => {
    const a = await onboard('c3');
    await post(`/water-accounts/${a.waterAccount.id}/suspend`, {}).expect(201);
    const m2 = await newMeter();
    const inst = await post('/meter-installations', {
      waterAccountId: a.waterAccount.id,
      meterId: m2.id,
      initialReading: 0,
    }).expect(201);
    expect(inst.body.status).toBe('ACTIVE');

    const blocked = await post(`/water-accounts/${a.waterAccount.id}/close`, {});
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('ACCOUNT_HAS_ACTIVE_INSTALLATION');
  });
});

describe('org data scope (营业所隔离)', () => {
  let acctA = '';
  let instA = '';
  let acctB = '';
  let instB = '';
  let meterB = '';

  beforeAll(async () => {
    const a = await onboard('sA');
    const b = await onboard('sB');
    acctA = a.waterAccount.id;
    instA = a.installation.id;
    acctB = b.waterAccount.id;
    instB = b.installation.id;
    meterB = b.meter.id;
    await coverAccount(ORG_BRANCH_A, acctA, 'sA');
    await coverAccount(ORG_BRANCH_B, acctB, 'sB');
  });

  it('branch staff reads own-scope list/detail; branch B is hidden/403', async () => {
    const filtered = await get(
      '/meter-installations?take=100',
      branchToken,
    ).expect(200);
    const ids = filtered.body.map((i: { id: string }) => i.id);
    expect(ids).toContain(instA);
    expect(ids).not.toContain(instB);

    const scoped = await get(
      `/meter-installations?waterAccountId=${acctB}`,
      branchToken,
    );
    expect(scoped.status).toBe(403);
    expect(scoped.body.code).toBe('ORG_OUT_OF_SCOPE');

    const detail = await get(`/meter-installations/${instB}`, branchToken);
    expect(detail.status).toBe(403);
    expect(detail.body.code).toBe('ORG_OUT_OF_SCOPE');

    // admin (scope ALL) sees both
    const all = await get(
      `/meter-installations?waterAccountId=${acctB}`,
      adminToken,
    ).expect(200);
    expect(all.body.map((i: { id: string }) => i.id)).toContain(instB);
  });

  it('branch staff cannot install/remove/replace on out-of-scope accounts', async () => {
    const m = await newMeter();
    const inst = await post(
      '/meter-installations',
      { waterAccountId: acctB, meterId: m.id, initialReading: 0 },
      branchToken,
    );
    expect(inst.status).toBe(403);
    expect(inst.body.code).toBe('ORG_OUT_OF_SCOPE');

    const rem = await post(
      `/meter-installations/${instB}/remove`,
      { finalReading: 10 },
      branchToken,
    );
    expect(rem.status).toBe(403);

    const rep = await post(
      `/meter-installations/${instB}/replace`,
      { newMeterId: m.id, oldFinalReading: 10, newInitialReading: 0 },
      branchToken,
    );
    expect(rep.status).toBe(403);
    // untouched
    expect((await instRow(instB)).status).toBe('ACTIVE');
    expect(await meterStatus(m.id)).toBe('AVAILABLE');
  });

  it('meter registry stays tenant-wide but detail filters out-of-scope history', async () => {
    const branchDetail = await get(`/meters/${meterB}`, branchToken).expect(200);
    expect(branchDetail.body.id).toBe(meterB); // meter itself visible
    expect(branchDetail.body.installations).toEqual([]); // history hidden

    const adminDetail = await get(`/meters/${meterB}`, adminToken).expect(200);
    expect(adminDetail.body.installations.length).toBe(1);
    expect(adminDetail.body.installations[0].waterAccountId).toBe(acctB);
  });
});

describe('multi-ACTIVE permissive domain', () => {
  it('two ACTIVE installations on one account both list; newest wins "current"', async () => {
    const a = await onboard('m1');
    const m2 = await newMeter();
    await post('/meter-installations', {
      waterAccountId: a.waterAccount.id,
      meterId: m2.id,
      initialReading: 0,
      installedAt: '2026-02-01', // newer than onboard's 2026-01-01
    }).expect(201);

    const detail = await get(`/water-accounts/${a.waterAccount.id}`).expect(200);
    const actives = detail.body.meterInstallations.filter(
      (i: { status: string }) => i.status === 'ACTIVE',
    );
    expect(actives).toHaveLength(2);
    // timeline ordered installed_at DESC → newest (m2) is "current"
    expect(actives[0].meterId).toBe(m2.id);
  });
});

describe('concurrency C1–C4', () => {
  it('C1: close ‖ install — never CLOSED + ACTIVE', async () => {
    for (const tag of ['c1a', 'c1b']) {
      const a = await onboard(tag);
      // detach the onboarded meter first so close is legal when it wins
      await post(`/meter-installations/${a.installation.id}/remove`, {
        finalReading: 10,
      }).expect(201);
      const m2 = await newMeter();

      const [closeRes, instRes] = await Promise.all([
        post(`/water-accounts/${a.waterAccount.id}/close`, {}),
        post('/meter-installations', {
          waterAccountId: a.waterAccount.id,
          meterId: m2.id,
          initialReading: 0,
        }),
      ]);
      const acct = (
        await owner.query(
          `SELECT status::text AS s FROM water_account WHERE id = $1`,
          [a.waterAccount.id],
        )
      ).rows[0].s;
      const activeCount = (
        await owner.query(
          `SELECT count(*)::int AS n FROM meter_installation
           WHERE tenant_id = $1 AND water_account_id = $2 AND status = 'ACTIVE'`,
          [T17A, a.waterAccount.id],
        )
      ).rows[0].n;

      // legal end states only
      if (acct === 'CLOSED') {
        expect(activeCount).toBe(0);
        expect(instRes.status).toBe(409); // install lost → ACCOUNT_CLOSED
      } else {
        expect(acct).toBe('NORMAL');
        expect(activeCount).toBe(1);
        expect(instRes.status).toBe(201);
        expect(closeRes.status).toBe(409); // close lost → has ACTIVE inst
      }
    }
  });

  it('C2: replace ‖ remove on the same ACTIVE installation — exactly one wins', async () => {
    const a = await onboard('c2x');
    const m2 = await newMeter();
    const [r1, r2] = await Promise.all([
      post(`/meter-installations/${a.installation.id}/replace`, {
        newMeterId: m2.id,
        oldFinalReading: 30,
        newInitialReading: 0,
      }),
      post(`/meter-installations/${a.installation.id}/remove`, {
        finalReading: 30,
      }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([201, 409]);
    expect((await instRow(a.installation.id)).status).toBe('REMOVED');
    const actives = (
      await owner.query(
        `SELECT count(*)::int AS n FROM meter_installation
         WHERE tenant_id = $1 AND water_account_id = $2 AND status = 'ACTIVE'`,
        [T17A, a.waterAccount.id],
      )
    ).rows[0].n;
    expect(actives === 0 || actives === 1).toBe(true);
    // consistent: if replace won, exactly one ACTIVE on the new meter
    if (r1.status === 201) {
      expect(actives).toBe(1);
      expect(await meterStatus(m2.id)).toBe('INSTALLED');
    }
  });

  it('C3: replace ‖ replace on the same old installation — exactly one wins', async () => {
    const a = await onboard('c3x');
    const m2 = await newMeter();
    const m3 = await newMeter();
    const [r1, r2] = await Promise.all([
      post(`/meter-installations/${a.installation.id}/replace`, {
        newMeterId: m2.id,
        oldFinalReading: 30,
        newInitialReading: 0,
      }),
      post(`/meter-installations/${a.installation.id}/replace`, {
        newMeterId: m3.id,
        oldFinalReading: 30,
        newInitialReading: 0,
      }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    // exactly one new ACTIVE installation was created from the old one
    const insts = (
      await owner.query(
        `SELECT meter_id::text AS m, status::text AS s FROM meter_installation
         WHERE tenant_id = $1 AND water_account_id = $2`,
        [T17A, a.waterAccount.id],
      )
    ).rows;
    expect(insts.filter((i) => i.s === 'ACTIVE')).toHaveLength(1);
    expect(insts.filter((i) => i.s === 'REMOVED')).toHaveLength(1);
    // loser's meter stays AVAILABLE
    const winnerMeter = r1.status === 201 ? m2.id : m3.id;
    const loserMeter = r1.status === 201 ? m3.id : m2.id;
    expect(await meterStatus(winnerMeter)).toBe('INSTALLED');
    expect(await meterStatus(loserMeter)).toBe('AVAILABLE');
  });

  it('C4: two accounts install the same AVAILABLE meter — exactly one wins', async () => {
    const a = await onboard('c4a');
    const b = await onboard('c4b');
    const shared = await newMeter();
    const [r1, r2] = await Promise.all([
      post('/meter-installations', {
        waterAccountId: a.waterAccount.id,
        meterId: shared.id,
        initialReading: 0,
      }),
      post('/meter-installations', {
        waterAccountId: b.waterAccount.id,
        meterId: shared.id,
        initialReading: 0,
      }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    expect(await meterStatus(shared.id)).toBe('INSTALLED');
    const owners = (
      await owner.query(
        `SELECT count(*)::int AS n FROM meter_installation
         WHERE tenant_id = $1 AND meter_id = $2 AND status = 'ACTIVE'`,
        [T17A, shared.id],
      )
    ).rows[0].n;
    expect(owners).toBe(1);
  });
});
