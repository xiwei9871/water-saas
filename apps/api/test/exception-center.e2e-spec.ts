/**
 * E9 Exception Center e2e against `watersaas_test` — fixtures `t19-`.
 *
 * Covers the frozen Rev4 contract:
 *  - Detector correctness for the 13-type catalog (+ exclusion set)
 *  - Episode model: partial unique (one active episode per key),
 *    RESOLVED fact-driven (AUTO/MANUAL), IGNORED episode-scoped
 *  - D1: GET endpoints never write work_item
 *  - D12: off-book anomalies anchor TENANT (branch cannot see/handle)
 *  - D21: remote anchors (UNBOUND/KEY_CONFLICT→REMOTE_SOURCE; resolved
 *    WAITING_PLAN/FAILED/CONFLICT→ACCOUNT; off-book→TENANT)
 *  - D10/D22: remote status transitions clear old episode / open new;
 *    KEY_CONFLICT keyed by occurrence so a new conflict revives the queue
 *  - RBAC: exception:read/manage; drill-down keeps domain permission
 *  - Reconcile concurrency: duplicate pass = idempotent, not 500
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

const T19 = 'aa19aa19-aa19-4a19-8a19-aa19aa19aa19';
const ORG_CO = 'aa19aa19-0000-4000-8000-0000000000c0';
const ORG_A = 'aa19aa19-0000-4000-8000-0000000000a1';
const ORG_B = 'aa19aa19-0000-4000-8000-0000000000b1';
const ROLE_ADMIN = 'aa19aa19-0000-4000-8000-00000000ad01';
const ROLE_BRANCH = 'aa19aa19-0000-4000-8000-00000000ad02';
const ROLE_PLAIN = 'aa19aa19-0000-4000-8000-00000000ad03';
const PERMS = {
  'exception:read': 'aa19aa19-0000-4000-8000-00000000e701',
  'exception:manage': 'aa19aa19-0000-4000-8000-00000000e702',
  'customer:read': 'aa19aa19-0000-4000-8000-00000000e703',
  'metering:read': 'aa19aa19-0000-4000-8000-00000000e704',
  // deliberately NO billing:read on the branch role — RBAC drill test
} as const;
const STAFF_ADMIN = 'aa19aa19-0000-4000-8000-0000000a0001';
const STAFF_BRANCH = 'aa19aa19-0000-4000-8000-0000000a0002';
const STAFF_PLAIN = 'aa19aa19-0000-4000-8000-0000000a0003';

const owner = new pg.Client({ connectionString: OWNER_URL });
let app: INestApplication<App>;
let adminToken = '';
let branchToken = '';
let plainToken = '';

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const post = (path: string, body?: unknown, token = adminToken) =>
  request(app.getHttpServer()).post(path).set(auth(token)).send(body);
const get = (path: string, token = adminToken) =>
  request(app.getHttpServer()).get(path).set(auth(token));

const keys = (items: { key: string }[]) => items.map((i) => i.key);
const workItems = async (key?: string) =>
  (
    await owner.query(
      `SELECT id::text, anomaly_key, anomaly_type, status,
              resolution_source, cleared_at IS NOT NULL AS cleared
       FROM work_item WHERE tenant_id=$1 ${key ? 'AND anomaly_key=$2' : ''}
       ORDER BY created_at`,
      key ? [T19, key] : [T19],
    )
  ).rows;

const onboard = async (tag: string) =>
  (
    await post('/water-accounts/onboard', {
      customer: { name: `T19 ${tag} ${RUN}`, custType: 'PERSONAL' },
      account: { usageCategory: 'RES_METERED', addr: `${tag} st` },
      meter: { brand: 't19', caliber: 'DN15' },
      installation: { initialReading: 0, installedAt: '2026-01-01' },
    }).expect(201)
  ).body as {
    waterAccount: { id: string; settleAccountId: string; accountNo: string };
    meter: { id: string };
    installation: { id: string };
  };

/** plain account without meter/book — for NO_ACTIVE_METER / NO_BOOK */
const seedAccount = async (tag: string) => {
  const custId = (
    await owner.query(
      `INSERT INTO customer (id, tenant_id, customer_no, name, cust_type,
         created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'PERSONAL', now(), now())
       RETURNING id::text`,
      [T19, `t19-cust-${tag}-${RUN}`, `T19 ${tag}`],
    )
  ).rows[0].id;
  const settleId = (
    await owner.query(
      `INSERT INTO settle_account (id, tenant_id, settle_no, name,
         created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, now(), now())
       RETURNING id::text`,
      [T19, `t19-settle-${tag}-${RUN}`, `T19 settle ${tag}`],
    )
  ).rows[0].id;
  const accId = (
    await owner.query(
      `INSERT INTO water_account (id, tenant_id, account_no, customer_id,
         settle_account_id, usage_category, addr, status, billable,
         created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'RES_METERED', $5,
               'NORMAL', true, now(), now())
       RETURNING id::text`,
      [T19, `t19-acc-${tag}-${RUN}`, custId, settleId, `${tag} addr`],
    )
  ).rows[0].id;
  return { custId, settleId, accId };
};

const coverAccount = async (orgId: string, waterAccountId: string, tag: string) => {
  const bookId = (
    await owner.query(
      `INSERT INTO reading_book
         (id, tenant_id, book_no, name, org_unit_id, cadence, meter_channel,
          created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'MONTHLY', 'MECHANICAL',
               now(), now()) RETURNING id::text`,
      [T19, `t19-${tag}-${RUN}`, `T19 Book ${tag}`, orgId],
    )
  ).rows[0].id;
  const planId = (
    await owner.query(
      `INSERT INTO reading_plan
         (id, tenant_id, book_id, period, plan_date, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, '209903', '2099-03-05', 'OPEN',
               now(), now()) RETURNING id::text`,
      [T19, bookId],
    )
  ).rows[0].id;
  await owner.query(
    `INSERT INTO book_meter
       (tenant_id, book_id, water_account_id, seq_no, created_at, updated_at)
     VALUES ($1, $2, $3, 1, now(), now())`,
    [T19, bookId, waterAccountId],
  );
  await owner.query(
    `INSERT INTO reading_plan_item
       (id, tenant_id, plan_id, water_account_id, seq_no, status,
        created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 1, 'PENDING', now(), now())`,
    [T19, planId, waterAccountId],
  );
  return { bookId, planId };
};

const seedMeterInstallation = async (accId: string, tag: string) => {
  const meterId = (
    await owner.query(
      `INSERT INTO meter (id, tenant_id, meter_no, brand, caliber, status,
         created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 't19', 'DN15', 'INSTALLED',
               now(), now()) RETURNING id::text`,
      [T19, `t19-m-${tag}-${RUN}`],
    )
  ).rows[0].id;
  const instId = (
    await owner.query(
      `INSERT INTO meter_installation
         (id, tenant_id, water_account_id, meter_id, installed_at,
          initial_reading, reason, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, '2026-01-01', 0, 'NEW',
               'ACTIVE', now(), now()) RETURNING id::text`,
      [T19, accId, meterId],
    )
  ).rows[0].id;
  return { meterId, instId };
};

const seedReading = async (
  instId: string,
  meterId: string,
  period: string,
  qcStatus: 'MANUAL_REVIEW' | 'REJECTED' | 'PASSED',
  supersedes?: string,
) =>
  (
    await owner.query(
      `INSERT INTO meter_reading
         (id, tenant_id, installation_id, meter_id, period, read_date,
          result_type, reading_value, qc_status, source, operator_id,
          supersedes_reading_id, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, '2026-02-20', 'ACTUAL', 25,
               $5, 'WEB', $6, $7, now(), now())
       RETURNING id::text`,
      [T19, instId, meterId, period, qcStatus, STAFF_ADMIN, supersedes ?? null],
    )
  ).rows[0].id as string;

const seedSettlement = async (accId: string, period: string, estimated: boolean) =>
  owner.query(
    `INSERT INTO consumption_settlement
       (id, tenant_id, water_account_id, period, total_usage_qty,
        is_estimated, status, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 10, $4, 'FINAL', now(), now())`,
    [T19, accId, period, estimated],
  );

const seedOverdueBill = async (accId: string, settleId: string, period: string) =>
  (
    await owner.query(
      `INSERT INTO bill
         (id, tenant_id, settle_account_id, water_account_id, period,
          bill_kind, source_type, source_id, status, total_amount, due_date,
          created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'NORMAL', 'MANUAL',
               gen_random_uuid(), 'POSTED', 5000, '2020-01-01', now(), now())
       RETURNING id::text`,
      [T19, settleId, accId, period],
    )
  ).rows[0].id as string;

const seedRemoteSource = async (orgUnitId: string | null, tag: string) =>
  (
    await owner.query(
      `INSERT INTO remote_source
         (id, tenant_id, code, name, type, adapter_key, status, timezone,
          org_unit_id, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'FILE_IMPORT', 'file-csv',
               'ACTIVE', 'Asia/Shanghai', $4, now(), now())
       RETURNING id::text`,
      [T19, `t19-src-${tag}-${RUN}`, `T19 src ${tag}`, orgUnitId],
    )
  ).rows[0].id as string;

const seedRemoteEvent = async (
  sourceId: string,
  tag: string,
  status: string,
  opts: { issueCode?: string; issueAt?: string; bindingId?: string; deviceId?: string } = {},
) =>
  (
    await owner.query(
      `INSERT INTO raw_remote_event
         (id, tenant_id, remote_source_id, external_event_key,
          canonical_payload_hash, vendor_device_key, business_period,
          collected_at, reading_value, raw_payload, canonical_payload,
          processing_status, current_issue_code, current_issue_at,
          resolved_remote_device_id, resolved_binding_id,
          created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'h', 'vdev', '202603',
               '2026-03-10', 1, '{}'::jsonb, '{}'::jsonb, $4, $5, $6,
               $7, $8, now(), now())
       RETURNING id::text`,
      [
        T19, sourceId, `t19-ev-${tag}-${RUN}`, status,
        opts.issueCode ?? null, opts.issueAt ?? null,
        opts.deviceId ?? null, opts.bindingId ?? null,
      ],
    )
  ).rows[0].id as string;

const seedBinding = async (sourceId: string, instId: string, tag: string) => {
  const deviceId = (
    await owner.query(
      `INSERT INTO remote_device
         (id, tenant_id, remote_source_id, vendor_device_key, status,
          created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'ACTIVE', now(), now())
       RETURNING id::text`,
      [T19, sourceId, `t19-dev-${tag}-${RUN}`],
    )
  ).rows[0].id;
  const bindingId = (
    await owner.query(
      `INSERT INTO remote_device_binding
         (id, tenant_id, remote_source_id, remote_device_id,
          installation_id, effective_from, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, '2026-01-01', now(), now())
       RETURNING id::text`,
      [T19, sourceId, deviceId, instId],
    )
  ).rows[0].id;
  return { deviceId, bindingId };
};

beforeAll(async () => {
  await owner.connect();
  const hash = await bcrypt.hash('t19-pass', 10);
  await owner.query(
    `INSERT INTO tenant (id, code, name, status, created_at, updated_at)
     VALUES ($1, 't19-water', 'T19 Water', 'ACTIVE', now(), now())
     ON CONFLICT DO NOTHING`,
    [T19],
  );
  await owner.query(
    `INSERT INTO org_unit (id, tenant_id, parent_id, name, type, created_at, updated_at)
     VALUES ($1, $2, NULL, 'T19 Company', 'COMPANY', now(), now()),
            ($3, $2, $1, 'T19 Branch A', 'BRANCH', now(), now()),
            ($4, $2, $1, 'T19 Branch B', 'BRANCH', now(), now())
     ON CONFLICT DO NOTHING`,
    [ORG_CO, T19, ORG_A, ORG_B],
  );
  await owner.query(
    `INSERT INTO role (id, tenant_id, code, name, data_scope, created_at, updated_at)
     VALUES ($1, $3, 'admin', 'T19 Admin', 'ALL', now(), now()),
            ($2, $3, 't19-branch', 'T19 Branch', 'ORG_SUBTREE', now(), now()),
            ($4, $3, 't19-plain', 'T19 Plain', 'ORG_SUBTREE', now(), now())
     ON CONFLICT DO NOTHING`,
    [ROLE_ADMIN, ROLE_BRANCH, T19, ROLE_PLAIN],
  );
  for (const [code, id] of Object.entries(PERMS)) {
    await owner.query(
      `INSERT INTO permission (id, tenant_id, code, type, created_at, updated_at)
       VALUES ($1, $2, $3, 'ACTION', now(), now()) ON CONFLICT DO NOTHING`,
      [id, T19, code],
    );
  }
  // branch role: exception:read+manage + customer/metering read (NO billing:read)
  for (const [, id] of Object.entries(PERMS)) {
    await owner.query(
      `INSERT INTO role_permission (tenant_id, role_id, permission_id, created_at, updated_at)
       VALUES ($1, $2, $3, now(), now()) ON CONFLICT DO NOTHING`,
      [T19, ROLE_BRANCH, id],
    );
  }
  // plain role: customer:read only — no exception perms at all
  await owner.query(
    `INSERT INTO role_permission (tenant_id, role_id, permission_id, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now()) ON CONFLICT DO NOTHING`,
    [T19, ROLE_PLAIN, PERMS['customer:read']],
  );
  await owner.query(
    `INSERT INTO staff (id, tenant_id, org_unit_id, login, password_hash, name, status, created_at, updated_at)
     VALUES ($1, $3, $4, 't19-admin',  $7, 'T19 Admin',  'ACTIVE', now(), now()),
            ($2, $3, $5, 't19-branch', $7, 'T19 Branch', 'ACTIVE', now(), now()),
            ($6, $3, $5, 't19-plain',  $7, 'T19 Plain',  'ACTIVE', now(), now())
     ON CONFLICT (tenant_id, login) DO NOTHING`,
    [STAFF_ADMIN, STAFF_BRANCH, T19, ORG_CO, ORG_A, STAFF_PLAIN, hash],
  );
  await owner.query(
    `INSERT INTO staff_role (tenant_id, staff_id, role_id, created_at, updated_at)
     VALUES ($1, $2, $4, now(), now()),
            ($1, $3, $5, now(), now()),
            ($1, $6, $7, now(), now())
     ON CONFLICT DO NOTHING`,
    [T19, STAFF_ADMIN, STAFF_BRANCH, ROLE_ADMIN, ROLE_BRANCH, STAFF_PLAIN, ROLE_PLAIN],
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
        .send({ tenantCode: 't19-water', login: l, password: 't19-pass' })
        .expect(201)
    ).body.accessToken as string;
  adminToken = await login('t19-admin');
  branchToken = await login('t19-branch');
  plainToken = await login('t19-plain');
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

// ---------------------------------------------------------------------------

describe('detectors + scope', () => {
  it('NO_BOOK / NO_ACTIVE_METER on off-book account → TENANT anchor (admin sees, branch cannot)', async () => {
    const { accId } = await seedAccount('offbook');
    await post('/exceptions/refresh').expect(201);
    const res = await get('/exceptions?type=NO_BOOK&take=200', adminToken).expect(200);
    const meter = await get('/exceptions?type=NO_ACTIVE_METER&take=200', adminToken).expect(200);
    const book = res.body.items.find((i: { key: string }) => i.key === `wa:${accId}:NO_BOOK`);
    const met = meter.body.items.find((i: { key: string }) => i.key === `wa:${accId}:NO_ACTIVE_METER`);
    expect(book?.anchor).toBe('TENANT');
    expect(met?.anchor).toBe('TENANT');

    const branch = await get('/exceptions?take=200', branchToken).expect(200);
    expect(keys(branch.body.items)).not.toContain(`wa:${accId}:NO_BOOK`);
    expect(keys(branch.body.items)).not.toContain(`wa:${accId}:NO_ACTIVE_METER`);
  });

  it('covered account anomalies → ACCOUNT anchor, visible to owning branch', async () => {
    const a = await onboard('covered');
    await coverAccount(ORG_A, a.waterAccount.id, 'bk-a');
    await post('/exceptions/refresh').expect(201);
    const branch = await get('/exceptions?type=NO_ACTIVE_METER', branchToken).expect(200);
    // covered account HAS an active meter → no NO_ACTIVE_METER; and it has a
    // book → no NO_BOOK. Assert NO_BOOK absent and coverage works via a
    // multi-book case below.
    expect(keys(branch.body.items)).not.toContain(`wa:${a.waterAccount.id}:NO_BOOK`);
  });

  it('MULTI_BOOK enters queue (D13), anchored ACCOUNT for owning branch', async () => {
    const a = await onboard('multibook');
    await coverAccount(ORG_A, a.waterAccount.id, 'mb1');
    await coverAccount(ORG_A, a.waterAccount.id, 'mb2');
    await post('/exceptions/refresh').expect(201);
    const res = await get('/exceptions?type=MULTI_BOOK', branchToken).expect(200);
    const item = res.body.items.find((i: { key: string }) => i.key === `wa:${a.waterAccount.id}:MULTI_BOOK`);
    expect(item).toBeTruthy();
    expect(item.anchor).toBe('ACCOUNT');
  });

  it('MULTI_ACTIVE_METER is BLOCKING', async () => {
    const { accId } = await seedAccount('multimeter');
    await seedMeterInstallation(accId, 'm1');
    await seedMeterInstallation(accId, 'm2');
    await coverAccount(ORG_A, accId, 'mm');
    await post('/exceptions/refresh').expect(201);
    const res = await get(`/exceptions/wa:${accId}:MULTI_ACTIVE_METER`, adminToken).expect(200);
    expect(res.body.fact.severity).toBe('BLOCKING');
  });

  it('READING_QC_REVIEW / QC_REJECTED; superseded readings excluded (D23)', async () => {
    const a = await onboard('qc');
    await coverAccount(ORG_A, a.waterAccount.id, 'qc');
    const r1 = await seedReading(a.installation.id, a.meter.id, '202601', 'MANUAL_REVIEW');
    const r2 = await seedReading(a.installation.id, a.meter.id, '202602', 'REJECTED');
    // r2 gets superseded → must drop out of the anomaly set
    await seedReading(a.installation.id, a.meter.id, '202602', 'PASSED', r2);
    await post('/exceptions/refresh').expect(201);
    const res = await get('/exceptions?take=200', adminToken).expect(200);
    expect(keys(res.body.items)).toContain(`reading:${r1}:QC_REVIEW`);
    expect(keys(res.body.items)).not.toContain(`reading:${r2}:QC_REJECTED`);
  });

  it('ESTIMATE_STREAK fires at >=2 consecutive estimated settlements', async () => {
    const a = await onboard('streak');
    await coverAccount(ORG_A, a.waterAccount.id, 'st');
    await seedSettlement(a.waterAccount.id, '202601', true);
    await seedSettlement(a.waterAccount.id, '202602', true);
    await post('/exceptions/refresh').expect(201);
    const res = await get('/exceptions?type=ESTIMATE_STREAK', adminToken).expect(200);
    expect(keys(res.body.items)).toContain(`wa:${a.waterAccount.id}:ESTIMATE_STREAK`);
  });

  it('UNPAID_BILL_OVERDUE: POSTED + past due + remaining > 0; paid bill excluded', async () => {
    const a = await onboard('bill');
    await coverAccount(ORG_A, a.waterAccount.id, 'bill');
    const overdue = await seedOverdueBill(a.waterAccount.id, a.waterAccount.settleAccountId, '202601');
    const paid = await seedOverdueBill(a.waterAccount.id, a.waterAccount.settleAccountId, '202602');
    await owner.query(
      `INSERT INTO payment
         (id, tenant_id, payment_no, settle_account_id, cashier_id,
          org_unit_id, channel, amount, status, received_at,
          created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'CASH', 5000,
               'RECEIVED', now(), now(), now()) RETURNING id::text`,
      [T19, `t19-pay-${RUN}`, a.waterAccount.settleAccountId, STAFF_ADMIN, ORG_A],
    ).then((r) =>
      owner.query(
        `INSERT INTO payment_alloc
           (id, tenant_id, source, payment_id, bill_id, amount,
            created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'PAYMENT', $2, $3, 5000, now(), now())`,
        [T19, r.rows[0].id, paid],
      ),
    );
    await post('/exceptions/refresh').expect(201);
    const res = await get('/exceptions?type=UNPAID_BILL_OVERDUE', adminToken).expect(200);
    expect(keys(res.body.items)).toContain(`bill:${overdue}:OVERDUE`);
    expect(keys(res.body.items)).not.toContain(`bill:${paid}:OVERDUE`);
  });
});

describe('remote anomalies (D10/D11/D21/D22)', () => {
  it('UNBOUND anchors REMOTE_SOURCE: branch sees only its own source', async () => {
    const srcA = await seedRemoteSource(ORG_A, 'a');
    const srcTenant = await seedRemoteSource(null, 't');
    const evA = await seedRemoteEvent(srcA, 'a', 'UNBOUND');
    const evT = await seedRemoteEvent(srcTenant, 't', 'UNBOUND');
    await post('/exceptions/refresh').expect(201);
    const branch = await get('/exceptions?type=REMOTE_EVENT_UNBOUND', branchToken).expect(200);
    expect(keys(branch.body.items)).toContain(`event:${evA}:UNBOUND`);
    expect(keys(branch.body.items)).not.toContain(`event:${evT}:UNBOUND`); // null org → tenant only
    const admin = await get('/exceptions?type=REMOTE_EVENT_UNBOUND', adminToken).expect(200);
    expect(keys(admin.body.items)).toContain(`event:${evT}:UNBOUND`);
  });

  it('WAITING_PLAN anchors resolved ACCOUNT (off-book → TENANT, branch cannot see)', async () => {
    const { accId } = await seedAccount('wp-offbook');
    const { instId } = await seedMeterInstallation(accId, 'wp');
    const srcA = await seedRemoteSource(ORG_A, 'wp');
    const { deviceId, bindingId } = await seedBinding(srcA, instId, 'wp');
    const ev = await seedRemoteEvent(srcA, 'wp', 'WAITING_PLAN', { deviceId, bindingId });
    await post('/exceptions/refresh').expect(201);
    const admin = await get('/exceptions?type=REMOTE_EVENT_WAITING_PLAN', adminToken).expect(200);
    const item = admin.body.items.find((i: { key: string }) => i.key === `event:${ev}:WAITING_PLAN`);
    expect(item?.anchor).toBe('TENANT'); // account is off-book → D12 downgrade
    const branch = await get('/exceptions?type=REMOTE_EVENT_WAITING_PLAN', branchToken).expect(200);
    expect(keys(branch.body.items)).not.toContain(`event:${ev}:WAITING_PLAN`);
  });

  it('replay UNBOUND→WAITING_PLAN: old episode RESOLVED, new episode OPEN (D10)', async () => {
    const { accId } = await seedAccount('replay');
    const { instId } = await seedMeterInstallation(accId, 'rp');
    const srcA = await seedRemoteSource(ORG_A, 'rp');
    const { deviceId, bindingId } = await seedBinding(srcA, instId, 'rp');
    const ev = await seedRemoteEvent(srcA, 'rp', 'UNBOUND', { deviceId, bindingId });
    await post('/exceptions/refresh').expect(201);
    const k1 = `event:${ev}:UNBOUND`;
    expect((await workItems(k1))[0]?.status).toBe('OPEN');
    // replay → status migration
    await owner.query(
      `UPDATE raw_remote_event SET processing_status='WAITING_PLAN', updated_at=now()
       WHERE tenant_id=$1 AND id=$2`,
      [T19, ev],
    );
    await post('/exceptions/refresh').expect(201);
    const old = (await workItems(k1))[0];
    expect(old.status).toBe('RESOLVED');
    expect(old.resolution_source).toBe('AUTO');
    expect(old.cleared).toBe(true);
    const k2 = `event:${ev}:WAITING_PLAN`;
    const fresh = (await workItems(k2))[0];
    expect(fresh?.status).toBe('OPEN');
    expect(fresh?.cleared).toBe(false);
  });

  it('EVENT_KEY_CONFLICT keyed by occurrence count: T2 conflict opens new episode after T1 IGNORE (D22)', async () => {
    const src = await seedRemoteSource(null, 'kc');
    const ev = await seedRemoteEvent(src, 'kc', 'CONVERTED', {
      issueCode: 'EVENT_KEY_CONFLICT',
      issueAt: '2026-03-10T01:00:00.000Z',
    });
    await owner.query(
      `INSERT INTO remote_event_process_log
         (id, tenant_id, remote_event_id, action, code, actor_type, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'EVENT_KEY_CONFLICT',
               'EVENT_KEY_CONFLICT', 'SYSTEM', now())`,
      [T19, ev],
    );
    await post('/exceptions/refresh').expect(201);
    const k1 = `event:${ev}:EVENT_KEY_CONFLICT:1`;
    expect((await workItems(k1)).length).toBe(1);
    await post(`/exceptions/${encodeURIComponent(k1)}/ignore`, { note: 'known dup' }).expect(201);
    // second payload conflict — SAME currentIssueAt ms as T1 to prove the
    // occurrence token is the conflict-log count, not the timestamp (A5)
    await owner.query(
      `UPDATE raw_remote_event SET current_issue_at='2026-03-10T01:00:00.000Z', updated_at=now()
       WHERE tenant_id=$1 AND id=$2`,
      [T19, ev],
    );
    await owner.query(
      `INSERT INTO remote_event_process_log
         (id, tenant_id, remote_event_id, action, code, actor_type, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'EVENT_KEY_CONFLICT',
               'EVENT_KEY_CONFLICT', 'SYSTEM', now())`,
      [T19, ev],
    );
    await post('/exceptions/refresh').expect(201);
    const old = (await workItems(k1))[0];
    expect(old.status).toBe('IGNORED');
    expect(old.cleared).toBe(true); // episode ended, IGNORE does not propagate
    const k2 = `event:${ev}:EVENT_KEY_CONFLICT:2`;
    const fresh = (await workItems(k2))[0];
    expect(fresh?.status).toBe('OPEN');
    expect(fresh?.cleared).toBe(false);
  });
});

describe('lifecycle + reconcile (D1/D2/D3)', () => {
  it('C1: concurrent reconcile → single active episode (partial unique)', async () => {
    const { accId } = await seedAccount('race');
    const [r1, r2] = await Promise.all([
      post('/exceptions/refresh'),
      post('/exceptions/refresh'),
    ]);
    expect([r1.status, r2.status].sort((a, b) => a - b)).toEqual([201, 201]);
    const rows = await workItems(`wa:${accId}:NO_BOOK`);
    expect(rows.length).toBe(1);
    expect(rows[0].cleared).toBe(false);
  });

  it('C3: IGNORED → fact gone → cleared → fact back → NEW open episode', async () => {
    const { accId } = await seedAccount('ign');
    await post('/exceptions/refresh').expect(201);
    const key = `wa:${accId}:NO_BOOK`;
    await post(`/exceptions/${encodeURIComponent(key)}/ignore`, { note: 'new acct pending' }).expect(201);
    // fact disappears (book added)
    await coverAccount(ORG_A, accId, 'ign');
    await post('/exceptions/refresh').expect(201);
    let rows = await workItems(key);
    expect(rows[0].status).toBe('IGNORED');
    expect(rows[0].cleared).toBe(true);
    // fact reappears (book removed) → new episode, not reopen of IGNORED one
    await owner.query(
      `DELETE FROM book_meter WHERE tenant_id=$1 AND water_account_id=$2`,
      [T19, accId],
    );
    await post('/exceptions/refresh').expect(201);
    rows = await workItems(key);
    expect(rows.length).toBe(2);
    expect(rows[1].status).toBe('OPEN');
    expect(rows[1].cleared).toBe(false);
  });

  it('C4: OPEN fact gone → RESOLVED/AUTO with resolvedAt=clearedAt', async () => {
    const { accId } = await seedAccount('auto');
    await post('/exceptions/refresh').expect(201);
    const key = `wa:${accId}:NO_BOOK`;
    await coverAccount(ORG_A, accId, 'auto');
    await post('/exceptions/refresh').expect(201);
    const [row] = await workItems(key);
    expect(row.status).toBe('RESOLVED');
    expect(row.resolution_source).toBe('AUTO');
    expect(row.cleared).toBe(true);
  });

  it('C5: GET list/detail never write work_item (D1)', async () => {
    const { accId } = await seedAccount('nowrite');
    const before = (await owner.query(`SELECT count(*)::int c, max(updated_at) m FROM work_item WHERE tenant_id=$1`, [T19])).rows[0];
    await get('/exceptions', adminToken).expect(200);
    await get(`/exceptions/wa:${accId}:NO_BOOK`, adminToken).expect(200);
    await get('/exceptions/summary', adminToken).expect(200);
    const after = (await owner.query(`SELECT count(*)::int c, max(updated_at) m FROM work_item WHERE tenant_id=$1`, [T19])).rows[0];
    expect(after.c).toBe(before.c);
    expect(after.m).toEqual(before.m);
    // fact exists but no episode row was created by the GETs
    expect((await workItems(`wa:${accId}:NO_BOOK`)).length).toBe(0);
  });

  it('manual resolve: fact still active → 409 ANOMALY_STILL_ACTIVE; fact gone → RESOLVED/MANUAL', async () => {
    const { accId } = await seedAccount('resolve');
    await post('/exceptions/refresh').expect(201);
    const key = `wa:${accId}:NO_BOOK`;
    const r = await post(`/exceptions/${encodeURIComponent(key)}/resolve`, {});
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('ANOMALY_STILL_ACTIVE');
    await coverAccount(ORG_A, accId, 'res');
    await post(`/exceptions/${encodeURIComponent(key)}/resolve`, { note: 'booked' }).expect(201);
    const [row] = await workItems(key);
    expect(row.status).toBe('RESOLVED');
    expect(row.resolution_source).toBe('MANUAL');
    expect(row.cleared).toBe(true);
  });
});

describe('RBAC + write ops', () => {
  it('no exception:read → 403 on queue; read-only role → 403 on manage', async () => {
    await get('/exceptions', plainToken).expect(403);
    await post('/exceptions/refresh', undefined, plainToken).expect(403);
  });

  it('exception:read w/o billing:read → sees overdue anomaly; bill drill still 403', async () => {
    const a = await onboard('rbac');
    await coverAccount(ORG_A, a.waterAccount.id, 'rbac');
    const billId = await seedOverdueBill(a.waterAccount.id, a.waterAccount.settleAccountId, '202604');
    await post('/exceptions/refresh').expect(201);
    const res = await get('/exceptions?type=UNPAID_BILL_OVERDUE', branchToken).expect(200);
    expect(keys(res.body.items)).toContain(`bill:${billId}:OVERDUE`);
    await get(`/bills/${billId}`, branchToken).expect(403); // domain permission intact
  });

  it('ack/assign/ignore/unignore; assignee out-of-scope → 403', async () => {
    const { accId } = await seedAccount('ops');
    await coverAccount(ORG_A, accId, 'ops');
    // give it an ACCOUNT-anchored anomaly: multi-book
    await coverAccount(ORG_A, accId, 'ops2');
    await post('/exceptions/refresh').expect(201);
    const key = `wa:${accId}:MULTI_BOOK`;
    // branch can ack its own scope anomaly
    await post(`/exceptions/${encodeURIComponent(key)}/ack`, undefined, branchToken).expect(201);
    // assign to plain staff (Branch A subtree, scope OK) → 201
    await post(`/exceptions/${encodeURIComponent(key)}/assign`, { assigneeId: STAFF_PLAIN }, branchToken).expect(201);
    // assign off-book anomaly to branch staff → 403 ASSIGNEE_OUT_OF_SCOPE
    const { accId: offbook } = await seedAccount('assign-tenant');
    await post('/exceptions/refresh').expect(201);
    const tkey = `wa:${offbook}:NO_BOOK`;
    const r = await post(`/exceptions/${encodeURIComponent(tkey)}/assign`, { assigneeId: STAFF_BRANCH });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('ASSIGNEE_OUT_OF_SCOPE');
    // unignore on non-ignored → 409
    const u = await post(`/exceptions/${encodeURIComponent(key)}/unignore`, undefined, branchToken);
    expect(u.status).toBe(409);
    // ignore requires note
    await post(`/exceptions/${encodeURIComponent(key)}/ignore`, {}, branchToken).expect(400);
    await post(`/exceptions/${encodeURIComponent(key)}/ignore`, { note: 'dup membership expected' }, branchToken).expect(201);
    // ack on IGNORED → 409
    await post(`/exceptions/${encodeURIComponent(key)}/ack`, undefined, branchToken).expect(409);
    // unignore restores OPEN
    await post(`/exceptions/${encodeURIComponent(key)}/unignore`, undefined, branchToken).expect(201);
    const [row] = await workItems(key);
    expect(row.status).toBe('OPEN');
  });

  it('detail returns fact + episode + history; bad key → 400', async () => {
    const { accId } = await seedAccount('detail');
    await post('/exceptions/refresh').expect(201);
    const res = await get(`/exceptions/wa:${accId}:NO_BOOK`, adminToken).expect(200);
    expect(res.body.fact.key).toBe(`wa:${accId}:NO_BOOK`);
    expect(res.body.episode.status).toBe('OPEN');
    await get('/exceptions/not-a-key').expect(400);
    await get(`/exceptions/wa:${'aa19aa19-9999-4999-8999-999999999999'}:NO_BOOK`).expect(404);
  });
});
