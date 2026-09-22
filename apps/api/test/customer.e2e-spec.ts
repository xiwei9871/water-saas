/**
 * Customer module e2e against `watersaas_test` — fixtures carry the `t4-`
 * prefix. Boots the real AppModule so JWT/permission guards, tenant ALS and
 * RLS all apply.
 *
 * Covers (Task-4 brief assertions):
 *  1. POST /water-accounts/onboard — one tx → customer+settle_account+
 *     water_account+meter+ACTIVE installation, all tenant-scoped, doc numbers
 *     from sys_sequence (prefix+yyyyMM+6位)
 *  2. Idempotency-Key on onboard: same key+body replays, different body → 409
 *  3. remove: final<initial → 400; valid → installation REMOVED + meter
 *     AVAILABLE + final_reading persisted
 *  4. meter swap (remove + new install) → account has two installations,
 *     new meter INSTALLED; installing an INSTALLED meter → 409
 *  5. suspend/resume/close write account_event rows; close refuses while a
 *     POSTED bill keeps the real FinancePort outstanding > 0 (409)
 *  6. cross-tenant: tenant B token sees nothing of tenant A (404/empty — RLS)
 *  7. customer:read holder reads but cannot write (403)
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

// ---- fixtures (all prefixed t4-) ----
const T4A = '55555555-5555-4555-8555-555555555555'; // tenant A
const T4B = '66666666-6666-4666-8666-666666666666'; // tenant B (cross-tenant probes)
const ORG_A = '55555555-0000-4000-8000-0000000000c0';
const ROLE_ADMIN_A = '55555555-0000-4000-8000-00000000ad01';
const ROLE_VIEWER_A = '55555555-0000-4000-8000-000000001e01';
const PERM_CUST_READ = '55555555-0000-4000-8000-00000000e601';
const STAFF_ADMIN_A = '55555555-0000-4000-8000-0000000a0001';
const STAFF_VIEWER_A = '55555555-0000-4000-8000-0000000b0002';
const ORG_B = '66666666-0000-4000-8000-0000000000c0';
const ROLE_B_ADMIN = '66666666-0000-4000-8000-00000000ad01';
const STAFF_B_ADMIN = '66666666-0000-4000-8000-0000000a0001';

const owner = new pg.Client({ connectionString: OWNER_URL });
let app: INestApplication<App>;
let adminToken = '';
let viewerToken = '';
let tenantBToken = '';

// ids populated by the onboard test and reused downstream (sequential suite)
let acctId = '';
let instId = '';
let meterId = '';
let custId = '';
let acct2Id = '';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

// Run-scoped suffix: the test DB keeps business rows + idempotency keys
// between runs, so anything asserted "exactly once" (idem replay, event
// counts) must be unique per run or stale rows replay/accumulate.
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

const eventsOf = async (accountId: string) =>
  (
    await owner.query(
      `SELECT type::text AS type, payload FROM account_event
       WHERE tenant_id = $1 AND water_account_id = $2 ORDER BY created_at`,
      [T4A, accountId],
    )
  ).rows;

beforeAll(async () => {
  await owner.connect();
  const hash = await bcrypt.hash('t4-pass', 10);

  await owner.query(
    `INSERT INTO tenant (id, code, name, status, created_at, updated_at)
     VALUES ($1, 't4-water', 'T4 Water', 'ACTIVE', now(), now()),
            ($2, 't4-other', 'T4 Other', 'ACTIVE', now(), now())
     ON CONFLICT DO NOTHING`,
    [T4A, T4B],
  );
  await owner.query(
    `INSERT INTO org_unit (id, tenant_id, parent_id, name, type, created_at, updated_at)
     VALUES ($1, $2, NULL, 'T4 Company', 'COMPANY', now(), now()),
            ($3, $4, NULL, 'T4B Company', 'COMPANY', now(), now())
     ON CONFLICT DO NOTHING`,
    [ORG_A, T4A, ORG_B, T4B],
  );
  await owner.query(
    `INSERT INTO role (id, tenant_id, code, name, data_scope, created_at, updated_at)
     VALUES ($1, $3, 'admin', 'T4 Admin', 'ALL', now(), now()),
            ($2, $3, 't4-viewer', 'T4 Viewer', 'ORG_SUBTREE', now(), now()),
            ($4, $5, 'admin', 'T4B Admin', 'ALL', now(), now())
     ON CONFLICT DO NOTHING`,
    [ROLE_ADMIN_A, ROLE_VIEWER_A, T4A, ROLE_B_ADMIN, T4B],
  );
  await owner.query(
    `INSERT INTO permission (id, tenant_id, code, type, created_at, updated_at)
     VALUES ($1, $2, 'customer:read', 'ACTION', now(), now())
     ON CONFLICT DO NOTHING`,
    [PERM_CUST_READ, T4A],
  );
  await owner.query(
    `INSERT INTO role_permission (tenant_id, role_id, permission_id, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now()) ON CONFLICT DO NOTHING`,
    [T4A, ROLE_VIEWER_A, PERM_CUST_READ],
  );
  await owner.query(
    `INSERT INTO staff (id, tenant_id, org_unit_id, login, password_hash, name, status, created_at, updated_at)
     VALUES ($1, $4, $6, 't4-admin',   $7, 'T4 Admin',   'ACTIVE', now(), now()),
            ($2, $4, $6, 't4-viewer',  $7, 'T4 Viewer',  'ACTIVE', now(), now()),
            ($3, $5, $8, 't4b-admin',  $7, 'T4B Admin',  'ACTIVE', now(), now())
     ON CONFLICT (tenant_id, login) DO NOTHING`,
    [STAFF_ADMIN_A, STAFF_VIEWER_A, STAFF_B_ADMIN, T4A, T4B, ORG_A, hash, ORG_B],
  );
  await owner.query(
    `INSERT INTO staff_role (tenant_id, staff_id, role_id, created_at, updated_at)
     VALUES ($1, $2, $4, now(), now()),
            ($1, $3, $5, now(), now()),
            ($6, $7, $8, now(), now())
     ON CONFLICT DO NOTHING`,
    [T4A, STAFF_ADMIN_A, STAFF_VIEWER_A, ROLE_ADMIN_A, ROLE_VIEWER_A, T4B, STAFF_B_ADMIN, ROLE_B_ADMIN],
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
        .send({ tenantCode, login: login_, password: 't4-pass' })
        .expect(201)
    ).body.accessToken as string;
  adminToken = await login('t4-water', 't4-admin');
  viewerToken = await login('t4-water', 't4-viewer');
  tenantBToken = await login('t4-other', 't4b-admin');
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

describe('onboard wizard (立户)', () => {
  it('creates customer+settle+account+meter+ACTIVE installation in one tx', async () => {
    const res = await request(app.getHttpServer())
      .post('/water-accounts/onboard')
      .set(auth(adminToken))
      .send({
        customer: { name: 'T4 Alice', custType: 'PERSONAL', phone: '13800000001' },
        account: { usageCategory: 'RES_METERED', addr: '1 Water St' },
        meter: { brand: 't4-brand', caliber: 'DN15' },
        installation: { initialReading: 12.5 },
      })
      .expect(201);

    const { customer, settleAccount, waterAccount, meter, installation } = res.body;
    // all five rows landed, tenant-scoped, with sequenced doc numbers
    expect(customer.tenantId).toBe(T4A);
    expect(customer.customerNo).toMatch(/^C\d{12}$/);
    expect(settleAccount.tenantId).toBe(T4A);
    expect(settleAccount.settleNo).toMatch(/^S\d{12}$/);
    expect(settleAccount.name).toBe('T4 Alice'); // defaulted from the customer
    expect(waterAccount.accountNo).toMatch(/^A\d{12}$/);
    expect(waterAccount.customerId).toBe(customer.id);
    expect(waterAccount.settleAccountId).toBe(settleAccount.id);
    expect(waterAccount.status).toBe('NORMAL');
    expect(waterAccount.openedAt).toBeTruthy();
    expect(meter.meterNo).toMatch(/^M\d{12}$/);
    expect(meter.status).toBe('INSTALLED');
    expect(installation.status).toBe('ACTIVE');
    expect(installation.meterId).toBe(meter.id);
    expect(installation.waterAccountId).toBe(waterAccount.id);
    expect(Number(installation.initialReading)).toBe(12.5);
    expect(installation.reason).toBe('NEW');

    // DB-level truth: everything carries tenant A's id (RLS double-check)
    const rows = await owner.query(
      `SELECT
         (SELECT tenant_id::text FROM customer WHERE id = $1) AS cust,
         (SELECT tenant_id::text FROM settle_account WHERE id = $2) AS settle,
         (SELECT tenant_id::text FROM water_account WHERE id = $3) AS acct,
         (SELECT tenant_id::text FROM meter WHERE id = $4) AS meter,
         (SELECT tenant_id::text FROM meter_installation WHERE id = $5) AS inst`,
      [customer.id, settleAccount.id, waterAccount.id, meter.id, installation.id],
    );
    expect(rows.rows[0]).toEqual({
      cust: T4A,
      settle: T4A,
      acct: T4A,
      meter: T4A,
      inst: T4A,
    });

    custId = customer.id;
    acctId = waterAccount.id;
    instId = installation.id;
    meterId = meter.id;
  });

  it('replays the same Idempotency-Key and never double-opens', async () => {
    const key = `t4-onboard-${RUN}`;
    const body = {
      customer: { name: `T4 Idem ${RUN}`, custType: 'ORG' },
      account: { usageCategory: 'NON_RES', addr: '2 Water St' },
      meter: { brand: 't4-brand' },
      installation: { initialReading: 0 },
    };
    const first = await request(app.getHttpServer())
      .post('/water-accounts/onboard')
      .set(auth(adminToken))
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    acct2Id = first.body.waterAccount.id;

    const replay = await request(app.getHttpServer())
      .post('/water-accounts/onboard')
      .set(auth(adminToken))
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    expect(replay.body.waterAccount.id).toBe(acct2Id);
    expect(replay.body.customer.id).toBe(first.body.customer.id);

    const dup = await owner.query(
      `SELECT count(*)::int AS n FROM water_account WHERE tenant_id = $1 AND id = $2`,
      [T4A, acct2Id],
    );
    expect(dup.rows[0].n).toBe(1);
    // the business ran exactly once — only one customer with this run's name
    const custs = await owner.query(
      `SELECT count(*)::int AS n FROM customer WHERE tenant_id = $1 AND name = $2`,
      [T4A, `T4 Idem ${RUN}`],
    );
    expect(custs.rows[0].n).toBe(1);

    const conflict = await request(app.getHttpServer())
      .post('/water-accounts/onboard')
      .set(auth(adminToken))
      .set('Idempotency-Key', key)
      .send({ ...body, account: { usageCategory: 'SPECIAL', addr: 'x' } })
      .expect(409);
    expect(conflict.body).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
    });
  });

  it('rejects malformed wizard bodies (400, not 500)', async () => {
    // neither customer nor customerId
    await request(app.getHttpServer())
      .post('/water-accounts/onboard')
      .set(auth(adminToken))
      .send({
        account: { usageCategory: 'RES_METERED', addr: 'a' },
        meter: {},
        installation: { initialReading: 0 },
      })
      .expect(400);
    // both meter and meterId → ambiguous
    await request(app.getHttpServer())
      .post('/water-accounts/onboard')
      .set(auth(adminToken))
      .send({
        customer: { name: 'x', custType: 'PERSONAL' },
        account: { usageCategory: 'RES_METERED', addr: 'a' },
        meter: {},
        meterId: meterId,
        installation: { initialReading: 0 },
      })
      .expect(400);
    // missing initialReading
    await request(app.getHttpServer())
      .post('/water-accounts/onboard')
      .set(auth(adminToken))
      .send({
        customer: { name: 'x', custType: 'PERSONAL' },
        account: { usageCategory: 'RES_METERED', addr: 'a' },
        meter: {},
        installation: {},
      })
      .expect(400);
    // bad custType / bad reason / negative reading
    await request(app.getHttpServer())
      .post('/water-accounts/onboard')
      .set(auth(adminToken))
      .send({
        customer: { name: 'x', custType: 'ALIEN' },
        account: { usageCategory: 'RES_METERED', addr: 'a' },
        meter: {},
        installation: { initialReading: 0 },
      })
      .expect(400);
    await request(app.getHttpServer())
      .post('/water-accounts/onboard')
      .set(auth(adminToken))
      .send({
        customer: { name: 'x', custType: 'PERSONAL' },
        account: { usageCategory: 'RES_METERED', addr: 'a' },
        meter: {},
        installation: { initialReading: -1 },
      })
      .expect(400);
  });
});

describe('meter installation lifecycle (装表/拆表/换表)', () => {
  it('refuses to install an already-INSTALLED meter (409)', async () => {
    const res = await request(app.getHttpServer())
      .post('/meter-installations')
      .set(auth(adminToken))
      .send({ waterAccountId: acctId, meterId, initialReading: 0 })
      .expect(409);
    expect(res.body).toMatchObject({ code: 'METER_NOT_AVAILABLE' });
  });

  it('remove: final_reading < initial_reading → 400; valid → REMOVED + meter AVAILABLE', async () => {
    const bad = await request(app.getHttpServer())
      .post(`/meter-installations/${instId}/remove`)
      .set(auth(adminToken))
      .send({ finalReading: 5 }) // initial was 12.5
      .expect(400);
    expect(bad.body).toMatchObject({ code: 'FINAL_READING_BEFORE_INITIAL' });

    const res = await request(app.getHttpServer())
      .post(`/meter-installations/${instId}/remove`)
      .set(auth(adminToken))
      .send({ finalReading: 20 })
      .expect(201);
    expect(res.body.status).toBe('REMOVED');
    expect(res.body.removedAt).toBeTruthy();
    expect(Number(res.body.finalReading)).toBe(20);
    expect(res.body.meter.status).toBe('AVAILABLE');

    const db = await owner.query(
      `SELECT status::text AS s, final_reading::text AS f,
              (SELECT status::text FROM meter WHERE id = $2) AS meter_status
       FROM meter_installation WHERE id = $1`,
      [instId, meterId],
    );
    expect(db.rows[0]).toMatchObject({ s: 'REMOVED', meter_status: 'AVAILABLE' });
    expect(Number(db.rows[0].f)).toBe(20);
  });

  it('double-remove → 409 INSTALLATION_NOT_ACTIVE', async () => {
    const res = await request(app.getHttpServer())
      .post(`/meter-installations/${instId}/remove`)
      .set(auth(adminToken))
      .send({ finalReading: 21 })
      .expect(409);
    expect(res.body).toMatchObject({ code: 'INSTALLATION_NOT_ACTIVE' });
  });

  it('meter swap: remove + new install → two installations, new meter INSTALLED', async () => {
    // register a fresh device via POST /meters (sequence-issued meter_no)
    const meter2 = (
      await request(app.getHttpServer())
        .post('/meters')
        .set(auth(adminToken))
        .send({ brand: 't4-brand2', caliber: 'DN20' })
        .expect(201)
    ).body;
    expect(meter2.status).toBe('AVAILABLE');
    expect(meter2.meterNo).toMatch(/^M\d{12}$/);

    const inst2 = (
      await request(app.getHttpServer())
        .post('/meter-installations')
        .set(auth(adminToken))
        .send({
          waterAccountId: acctId,
          meterId: meter2.id,
          initialReading: 0,
          reason: 'REPLACE',
        })
        .expect(201)
    ).body;
    expect(inst2.status).toBe('ACTIVE');
    expect(inst2.reason).toBe('REPLACE');
    expect(inst2.meter.status).toBe('INSTALLED');

    const detail = await request(app.getHttpServer())
      .get(`/water-accounts/${acctId}`)
      .set(auth(adminToken))
      .expect(200);
    const installations = detail.body.meterInstallations;
    expect(installations).toHaveLength(2);
    expect(installations.map((i: { status: string }) => i.status).sort()).toEqual([
      'ACTIVE',
      'REMOVED',
    ]);
  });

  it('a removed (AVAILABLE) meter can be reinstalled elsewhere — spec: 拆下可复装', async () => {
    // meterId is back to AVAILABLE after the earlier remove — reinstall it on
    // the second onboarded account.
    const res = await request(app.getHttpServer())
      .post('/meter-installations')
      .set(auth(adminToken))
      .send({ waterAccountId: acct2Id, meterId, initialReading: 0, reason: 'NEW' })
      .expect(201);
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.meter.status).toBe('INSTALLED');
  });
});

describe('account events (过户/暂停/恢复/销户)', () => {
  it('suspend → SUSPENDED + SUSPEND event; re-suspend → 409', async () => {
    const res = await request(app.getHttpServer())
      .post(`/water-accounts/${acctId}/suspend`)
      .set(auth(adminToken))
      .send({ remark: 't4-suspend' })
      .expect(201);
    expect(res.body.status).toBe('SUSPENDED');

    const again = await request(app.getHttpServer())
      .post(`/water-accounts/${acctId}/suspend`)
      .set(auth(adminToken))
      .send({})
      .expect(409);
    expect(again.body).toMatchObject({ code: 'INVALID_ACCOUNT_STATUS_TRANSITION' });
  });

  it('resume → NORMAL + RESUME event', async () => {
    const res = await request(app.getHttpServer())
      .post(`/water-accounts/${acctId}/resume`)
      .set(auth(adminToken))
      .send({})
      .expect(201);
    expect(res.body.status).toBe('NORMAL');

    const events = await eventsOf(acctId);
    expect(events.map((e) => e.type)).toEqual(['SUSPEND', 'RESUME']);
    expect(events[0].payload.oldValue.status).toBe('NORMAL');
    expect(events[0].payload.newValue.status).toBe('SUSPENDED');
    expect(events[1].payload.newValue.status).toBe('NORMAL');
  });

  it('close refuses while a POSTED bill reports outstanding > 0 (409)', async () => {
    // Real FinancePort (T10): outstanding = Σ POSTED/PARTIAL_PAID bills on
    // the account's settle_account. Seed one directly.
    const sa = (
      await owner.query(
        `SELECT settle_account_id::text AS id FROM water_account WHERE id = $1`,
        [acctId],
      )
    ).rows[0].id;
    const bill = (
      await owner.query(
        `INSERT INTO bill (id, tenant_id, settle_account_id, water_account_id, period,
                           bill_kind, source_type, source_id, status, is_estimated,
                           total_amount, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, '202601', 'NORMAL', 'MANUAL',
                 gen_random_uuid(), 'POSTED', false, 12345, now(), now())
         RETURNING id::text AS id`,
        [T4A, sa, acctId],
      )
    ).rows[0];

    const res = await request(app.getHttpServer())
      .post(`/water-accounts/${acctId}/close`)
      .set(auth(adminToken))
      .send({})
      .expect(409);
    expect(res.body).toMatchObject({
      code: 'ACCOUNT_OUTSTANDING_BALANCE',
      outstanding: '12345',
    });

    // still NORMAL — the refused close must not transition or write an event
    const acct = await request(app.getHttpServer())
      .get(`/water-accounts/${acctId}`)
      .set(auth(adminToken))
      .expect(200);
    expect(acct.body.status).toBe('NORMAL');
    expect((await eventsOf(acctId)).map((e) => e.type)).not.toContain('CLOSE');

    // PAID bills carry no outstanding — clearing the debt path for the
    // next test (T12 will model real payment allocations).
    await owner.query(`UPDATE bill SET status = 'PAID' WHERE id = $1`, [bill.id]);
  });

  it('close with outstanding cleared → CLOSED + closedAt + CLOSE event; second close → 409', async () => {
    // E7 close guard: the ACTIVE installation from the swap test must be
    // removed first — closing with an ACTIVE meter is a 409.
    const detail = await request(app.getHttpServer())
      .get(`/water-accounts/${acctId}`)
      .set(auth(adminToken))
      .expect(200);
    for (const i of detail.body.meterInstallations as {
      id: string;
      status: string;
    }[]) {
      if (i.status === 'ACTIVE') {
        await request(app.getHttpServer())
          .post(`/meter-installations/${i.id}/remove`)
          .set(auth(adminToken))
          .send({ finalReading: 30 })
          .expect(201);
      }
    }
    const res = await request(app.getHttpServer())
      .post(`/water-accounts/${acctId}/close`)
      .set(auth(adminToken))
      .send({ remark: 't4-close' })
      .expect(201);
    expect(res.body.status).toBe('CLOSED');
    expect(res.body.closedAt).toBeTruthy();

    const events = await eventsOf(acctId);
    expect(events.map((e) => e.type)).toEqual(['SUSPEND', 'RESUME', 'CLOSE']);
    expect(events[2].payload.newValue.status).toBe('CLOSED');

    const again = await request(app.getHttpServer())
      .post(`/water-accounts/${acctId}/close`)
      .set(auth(adminToken))
      .send({})
      .expect(409);
    expect(again.body).toMatchObject({ code: 'INVALID_ACCOUNT_STATUS_TRANSITION' });
  });

  it('transfer re-points the account and writes a TRANSFER event', async () => {
    // a second customer to receive the account
    const newCust = (
      await request(app.getHttpServer())
        .post('/customers')
        .set(auth(adminToken))
        .send({ name: 'T4 Bob', custType: 'PERSONAL' })
        .expect(201)
    ).body;

    const res = await request(app.getHttpServer())
      .post(`/water-accounts/${acct2Id}/transfer`)
      .set(auth(adminToken))
      .send({ customerId: newCust.id, remark: 't4-transfer' })
      .expect(201);
    expect(res.body.customerId).toBe(newCust.id);
    expect(res.body.customer.id).toBe(newCust.id);

    const events = await eventsOf(acct2Id);
    expect(events.map((e) => e.type)).toEqual(['TRANSFER']);
    expect(events[0].payload.newValue.customerId).toBe(newCust.id);
  });
});

describe('tenant isolation + permissions', () => {
  it('tenant B cannot see or touch tenant A rows (RLS)', async () => {
    await request(app.getHttpServer())
      .get(`/water-accounts/${acctId}`)
      .set(auth(tenantBToken))
      .expect(404);
    const list = await request(app.getHttpServer())
      .get('/water-accounts')
      .set(auth(tenantBToken))
      .expect(200);
    expect(list.body).toEqual([]);
    await request(app.getHttpServer())
      .get(`/customers/${custId}`)
      .set(auth(tenantBToken))
      .expect(404);
    // cross-tenant write probe on A's ACTIVE installation id → 404, not data
    const res = await request(app.getHttpServer())
      .post(`/meter-installations/${instId}/remove`)
      .set(auth(tenantBToken))
      .send({ finalReading: 99 });
    expect(res.status).toBe(404);
  });

  it('customer:read holder reads lists but cannot write', async () => {
    const list = await request(app.getHttpServer())
      .get('/customers')
      .set(auth(viewerToken))
      .expect(200);
    expect(Array.isArray(list.body)).toBe(true);

    const res = await request(app.getHttpServer())
      .post('/customers')
      .set(auth(viewerToken))
      .send({ name: 'x', custType: 'PERSONAL' })
      .expect(403);
    expect(res.body).toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});

describe('v0.2: monitoring meter onboard （监控表）', () => {
  it('MONITORING onboards with NO customer body — system customer + billable=false', async () => {
    const res = await request(app.getHttpServer())
      .post('/water-accounts/onboard')
      .set(auth(adminToken))
      .send({
        account: { usageCategory: 'MONITORING', addr: 'DMA-01 入口' },
        meter: { brand: 't4-brand', caliber: 'DN50' },
        installation: { initialReading: 0 },
      })
      .expect(201);

    const { customer, settleAccount, waterAccount } = res.body;
    expect(customer.systemKey).toBe('MONITORING_INTERNAL');
    expect(settleAccount.settleNo).toBe('SYS-MONITORING');
    expect(waterAccount.usageCategory).toBe('MONITORING');
    expect(waterAccount.billable).toBe(false);

    // Second monitoring meter REUSES the same system customer/settle account.
    const res2 = await request(app.getHttpServer())
      .post('/water-accounts/onboard')
      .set(auth(adminToken))
      .send({
        account: { usageCategory: 'MONITORING', addr: 'DMA-02 入口' },
        meter: { brand: 't4-brand' },
        installation: { initialReading: 0 },
      })
      .expect(201);
    expect(res2.body.customer.id).toBe(customer.id);
    expect(res2.body.settleAccount.id).toBe(settleAccount.id);
  });

  it('MONITORING with a supplied customer/settleAccount → 400 (not silently ignored)', async () => {
    for (const extra of [
      { customer: { name: 'x', custType: 'ORG' } },
      { customerId: '99999999-9999-4999-8999-999999999999' },
      { settleAccount: { name: 'x' } },
      { settleAccountId: '99999999-9999-4999-8999-999999999999' },
    ]) {
      const res = await request(app.getHttpServer())
        .post('/water-accounts/onboard')
        .set(auth(adminToken))
        .send({
          account: { usageCategory: 'MONITORING', addr: 'DMA-x' },
          meter: { brand: 't4-brand' },
          installation: { initialReading: 0 },
          ...extra,
        });
      expect(res.status).toBe(400);
    }
  });

  it('billable derives from category — PATCH to MONITORING flips it, and back', async () => {
    const res = await request(app.getHttpServer())
      .post('/water-accounts/onboard')
      .set(auth(adminToken))
      .send({
        customer: { name: `T4 Cat ${RUN}`, custType: 'PERSONAL' },
        account: { usageCategory: 'RES_METERED', addr: 'cat flip st' },
        meter: { brand: 't4-brand' },
        installation: { initialReading: 0 },
      })
      .expect(201);
    const id = res.body.waterAccount.id;
    expect(res.body.waterAccount.billable).toBe(true);

    const toMon = await request(app.getHttpServer())
      .patch(`/water-accounts/${id}`)
      .set(auth(adminToken))
      .send({ usageCategory: 'MONITORING' })
      .expect(200);
    expect(toMon.body.billable).toBe(false);

    const back = await request(app.getHttpServer())
      .patch(`/water-accounts/${id}`)
      .set(auth(adminToken))
      .send({ usageCategory: 'SPECIAL' })
      .expect(200);
    expect(back.body.billable).toBe(true);
  });

  it('unknown usageCategory → 422 INVALID_USAGE_CATEGORY on create + onboard', async () => {
    const ghost = '99999999-9999-4999-8999-999999999999';
    const direct = await request(app.getHttpServer())
      .post('/water-accounts')
      .set(auth(adminToken))
      .send({ customerId: ghost, settleAccountId: ghost, usageCategory: 'RESIDENTIAL', addr: 'a' });
    expect(direct.status).toBe(422);
    expect(direct.body).toMatchObject({ code: 'INVALID_USAGE_CATEGORY' });

    const wiz = await request(app.getHttpServer())
      .post('/water-accounts/onboard')
      .set(auth(adminToken))
      .send({
        customer: { name: 'x', custType: 'PERSONAL' },
        account: { usageCategory: 'BOGUS', addr: 'a' },
        meter: { brand: 't4-brand' },
        installation: { initialReading: 0 },
      });
    expect(wiz.status).toBe(422);
    expect(wiz.body).toMatchObject({ code: 'INVALID_USAGE_CATEGORY' });
  });

  it('household profile PATCH is scoped to the route account (cross-account → 404)', async () => {
    const onboard = async (tag: string) =>
      (
        await request(app.getHttpServer())
          .post('/water-accounts/onboard')
          .set(auth(adminToken))
          .send({
            customer: { name: `T4 HH ${tag} ${RUN}`, custType: 'PERSONAL' },
            account: { usageCategory: 'RES_METERED', addr: `hh ${tag} st` },
            meter: { brand: 't4-brand' },
            installation: { initialReading: 0 },
          })
          .expect(201)
      ).body.waterAccount.id as string;
    const a = await onboard('a');
    const b = await onboard('b');
    const prof = (
      await request(app.getHttpServer())
        .post(`/water-accounts/${b}/household-profiles`)
        .set(auth(adminToken))
        .send({ householdSize: 4, effectiveFromPeriod: '202601' })
        .expect(201)
    ).body;

    // B's profile id under A's route → 404, not a silent cross-account write.
    const cross = await request(app.getHttpServer())
      .patch(`/water-accounts/${a}/household-profiles/${prof.id}`)
      .set(auth(adminToken))
      .send({ householdSize: 9 });
    expect(cross.status).toBe(404);
    expect(cross.body).toMatchObject({ code: 'HOUSEHOLD_PROFILE_NOT_FOUND' });

    const ok = await request(app.getHttpServer())
      .patch(`/water-accounts/${b}/household-profiles/${prof.id}`)
      .set(auth(adminToken))
      .send({ householdSize: 9 })
      .expect(200);
    expect(Number(ok.body.householdSize)).toBe(9);
  });

  it('reconciliation on a MONITORING account → 409 ACCOUNT_NOT_BILLABLE', async () => {
    const res = await request(app.getHttpServer())
      .post('/water-accounts/onboard')
      .set(auth(adminToken))
      .send({
        account: { usageCategory: 'MONITORING', addr: `DMA-recon ${RUN}` },
        meter: { brand: 't4-brand' },
        installation: { initialReading: 0 },
      })
      .expect(201);
    const recon = await request(app.getHttpServer())
      .post('/reconciliations')
      .set(auth(adminToken))
      .send({ waterAccountId: res.body.waterAccount.id });
    expect(recon.status).toBe(409);
    expect(recon.body).toMatchObject({ code: 'ACCOUNT_NOT_BILLABLE' });
  });
});
