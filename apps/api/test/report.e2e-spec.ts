/**
 * Report endpoints e2e against `watersaas_test` — fixtures carry the
 * `t13-` prefix. Boots the real AppModule so JWT/permission guards,
 * tenant ALS and RLS all apply.
 *
 * Covers (Task-13 brief assertions):
 *  1. GET /reports/meter-daily — per-book plan_item status counts
 *     (READ/NO_READ/PENDING) + same-day readingsTaken; a late read on
 *     another date attributes to its own day
 *  2. GET /reports/cashier-daily — per-cashier byChannel sums; a
 *     reversal payment nets negative in its channel; `closed` flag
 *     tracks cashier_day_close existence
 *  3. GET /reports/ar-monthly — billed Σ over the documented predicate
 *     (non-REVERSAL, POSTED|PARTIAL_PAID|PAID) split by usage_category;
 *     DRAFT / REVERSED / REVERSAL-kind / other-period rows excluded
 *  4. GET /reports/collected-monthly — Σ payment.amount in the month
 *     split by channel + the alloc-side Σ (distinct measures post-E6)
 *  5. GET /reports/recovery-rate — single-month rate at 4dp, the
 *     cumulative `through` variant, billed=0 → rate null
 *  6. a scoped report:read holder sees only own-subtree books in
 *     meter-daily; tenant B sees nothing on any report
 *  7. report:read holder reads all five endpoints; a billing:write-only
 *     holder gets 403 PERMISSION_DENIED (the permission split works)
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

// ---- fixtures (all prefixed t13-) ----
const T13A = 'aa13aa13-1313-4013-8013-aa13aa13aa13'; // tenant A
const T13B = 'bb13bb13-2020-4020-8020-bb13bb13bb13'; // tenant B (isolation)
const ORG_A = 'aa13aa13-0000-4000-8000-0000000000c0'; // company
const ORG_A2 = 'aa13aa13-0000-4000-8000-0000000000c2'; // branch, child of ORG_A
const ORG_B = 'bb13bb13-0000-4000-8000-0000000000c0';
const ROLE_ADMIN_A = 'aa13aa13-0000-4000-8000-00000000ad01';
const ROLE_READER_A = 'aa13aa13-0000-4000-8000-000000001e01';
const ROLE_SCOPED_A = 'aa13aa13-0000-4000-8000-00000000c011';
const ROLE_BILLER_A = 'aa13aa13-0000-4000-8000-00000000b111';
const ROLE_B_ADMIN = 'bb13bb13-0000-4000-8000-00000000ad01';
const PERM_REPORT_READ = 'aa13aa13-0000-4000-8000-00000000e801';
const PERM_BILL_WRITE = 'aa13aa13-0000-4000-8000-00000000e802';
const STAFF_ADMIN_A = 'aa13aa13-0000-4000-8000-0000000a0001';
const STAFF_READER_A = 'aa13aa13-0000-4000-8000-0000000b0002'; // ORG_A, report:read
const STAFF_SCOPED_A = 'aa13aa13-0000-4000-8000-0000000c0003'; // ORG_A2, report:read
const STAFF_BILLER_A = 'aa13aa13-0000-4000-8000-0000000d0004'; // ORG_A, billing:write only
const STAFF_CASHIER1_A = 'aa13aa13-0000-4000-8000-0000000ca501';
const STAFF_CASHIER2_A = 'aa13aa13-0000-4000-8000-0000000ca502';
const STAFF_B_ADMIN = 'bb13bb13-0000-4000-8000-0000000a0001';

const owner = new pg.Client({ connectionString: OWNER_URL });
let app: INestApplication<App>;
let adminToken = '';
let readerToken = '';
let scopedToken = '';
let billerToken = '';
let tenantBToken = '';

// ids populated by the sequential suite
const acct: Record<string, string> = {}; // water_account ids
const settleAcct: Record<string, string> = {};
const inst: Record<string, string> = {};
const book: Record<string, string> = {};
const item: Record<string, string> = {}; // plan item ids
const bill: Record<string, string> = {};
const pay: Record<string, string> = {};

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

const get = (path: string, token = adminToken, status = 200) =>
  request(app.getHttpServer()).get(path).set(auth(token)).expect(status);

const post = (path: string, body: unknown, token = adminToken) =>
  request(app.getHttpServer()).post(path).set(auth(token)).send(body);

const onboard = async (label: string, usageCategory = 'RES_METERED') => {
  const res = await post('/water-accounts/onboard', {
    customer: { name: `T13 ${label} ${RUN}`, custType: 'PERSONAL' },
    account: { usageCategory, addr: `${label} Water St` },
    meter: { brand: 't13-brand', caliber: 'DN15' },
    installation: { initialReading: 0, installedAt: '2026-01-01' },
  }).expect(201);
  acct[label] = res.body.waterAccount.id;
  settleAcct[label] = res.body.settleAccount.id;
  inst[label] = res.body.installation.id;
  return res.body;
};

/** Insert a bill directly (MANUAL source — no settlement row needed). */
const seedBill = async (
  label: string,
  waterAccountId: string,
  settleAccountId: string,
  period: string,
  opts: {
    status?: string;
    billKind?: string;
    totalAmount?: number;
    sourceId?: string;
  } = {},
) => {
  const row = (
    await owner.query(
      `INSERT INTO bill (id, tenant_id, settle_account_id, water_account_id, period,
                         bill_kind, source_type, source_id, tariff_plan_id, status,
                         is_estimated, total_amount, issued_at, due_date,
                         created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'MANUAL', $6::uuid, NULL, $7,
               false, $8, now(), '2026-12-15', now(), now())
       RETURNING id::text AS id`,
      [
        T13A,
        settleAccountId,
        waterAccountId,
        period,
        opts.billKind ?? 'NORMAL',
        opts.sourceId!, // every caller passes a unique uuid
        opts.status ?? 'POSTED',
        opts.totalAmount ?? 1000,
      ],
    )
  ).rows[0];
  bill[label] = row.id;
  return row.id as string;
};

/**
 * Insert a payment (+ matching allocs summing to its amount) directly —
 * the report reads received_at, which the API never accepts as input.
 * Every payment gets allocs so the collected-vs-allocated identity is
 * exercised, including the negative mirror on the reversal row.
 */
const seedPayment = async (
  label: string,
  seq: number,
  opts: {
    cashierId: string;
    orgUnitId: string;
    settleAccountId: string;
    billId: string;
    channel: string;
    amount: number;
    receivedAt: string;
    status?: string;
    reversalOfId?: string;
    dayCloseId?: string;
  },
) => {
  const row = (
    await owner.query(
      `INSERT INTO payment (id, tenant_id, payment_no, settle_account_id, cashier_id,
                            org_unit_id, channel, amount, status, received_at,
                            reversal_of_id, day_close_id, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz,
               $10::uuid, $11::uuid, now(), now())
       RETURNING id::text AS id`,
      [
        T13A,
        `TP13${String(seq).padStart(8, '0')}`,
        opts.settleAccountId,
        opts.cashierId,
        opts.orgUnitId,
        opts.channel,
        opts.amount,
        opts.status ?? 'RECEIVED',
        opts.receivedAt,
        opts.reversalOfId ?? null,
        opts.dayCloseId ?? null,
      ],
    )
  ).rows[0];
  await owner.query(
    `INSERT INTO payment_alloc (id, tenant_id, payment_id, bill_id, amount, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, now(), now())`,
    [T13A, row.id, opts.billId, opts.amount],
  );
  pay[label] = row.id;
  return row.id as string;
};

beforeAll(async () => {
  await owner.connect();
  const hash = await bcrypt.hash('t13-pass', 10);

  await owner.query(
    `INSERT INTO tenant (id, code, name, status, created_at, updated_at)
     VALUES ($1, 't13-water', 'T13 Water', 'ACTIVE', now(), now()),
            ($2, 't13-other', 'T13 Other', 'ACTIVE', now(), now())
     ON CONFLICT DO NOTHING`,
    [T13A, T13B],
  );
  await owner.query(
    `INSERT INTO org_unit (id, tenant_id, parent_id, name, type, created_at, updated_at)
     VALUES ($1, $2, NULL, 'T13 Company', 'COMPANY', now(), now()),
            ($3, $2, $1, 'T13 Branch', 'BRANCH', now(), now()),
            ($4, $5, NULL, 'T13B Company', 'COMPANY', now(), now())
     ON CONFLICT DO NOTHING`,
    [ORG_A, T13A, ORG_A2, ORG_B, T13B],
  );
  await owner.query(
    `INSERT INTO role (id, tenant_id, code, name, data_scope, created_at, updated_at)
     VALUES ($1, $3, 'admin', 'T13 Admin', 'ALL', now(), now()),
            ($2, $3, 't13-reader', 'T13 Report Reader', 'ORG_SUBTREE', now(), now()),
            ($4, $3, 't13-scoped', 'T13 Scoped Reader', 'ORG_SUBTREE', now(), now()),
            ($5, $3, 't13-biller', 'T13 Biller', 'ALL', now(), now()),
            ($6, $7, 'admin', 'T13B Admin', 'ALL', now(), now())
     ON CONFLICT DO NOTHING`,
    [ROLE_ADMIN_A, ROLE_READER_A, T13A, ROLE_SCOPED_A, ROLE_BILLER_A, ROLE_B_ADMIN, T13B],
  );
  await owner.query(
    `INSERT INTO permission (id, tenant_id, code, type, created_at, updated_at)
     VALUES ($1, $2, 'report:read', 'ACTION', now(), now()),
            ($3, $2, 'billing:write', 'ACTION', now(), now())
     ON CONFLICT DO NOTHING`,
    [PERM_REPORT_READ, T13A, PERM_BILL_WRITE],
  );
  await owner.query(
    `INSERT INTO role_permission (tenant_id, role_id, permission_id, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now()),
            ($1, $4, $3, now(), now()),
            ($1, $5, $6, now(), now())
     ON CONFLICT DO NOTHING`,
    [T13A, ROLE_READER_A, PERM_REPORT_READ, ROLE_SCOPED_A, ROLE_BILLER_A, PERM_BILL_WRITE],
  );
  await owner.query(
    `INSERT INTO staff (id, tenant_id, org_unit_id, login, password_hash, name, status, created_at, updated_at)
     VALUES ($1, $6, $8, 't13-admin',    $9, 'T13 Admin',    'ACTIVE', now(), now()),
            ($2, $6, $8, 't13-reader',   $9, 'T13 Reader',   'ACTIVE', now(), now()),
            ($3, $6, $10, 't13-scoped',  $9, 'T13 Scoped',   'ACTIVE', now(), now()),
            ($4, $6, $8, 't13-biller',   $9, 'T13 Biller',   'ACTIVE', now(), now()),
            ($5, $6, $8, 't13-cashier1', $9, 'T13 Cashier1', 'ACTIVE', now(), now()),
            ($11, $6, $10, 't13-cashier2', $9, 'T13 Cashier2', 'ACTIVE', now(), now()),
            ($7, $12, $13, 't13b-admin', $9, 'T13B Admin',   'ACTIVE', now(), now())
     ON CONFLICT (tenant_id, login) DO NOTHING`,
    [
      STAFF_ADMIN_A,
      STAFF_READER_A,
      STAFF_SCOPED_A,
      STAFF_BILLER_A,
      STAFF_CASHIER1_A,
      T13A,
      STAFF_B_ADMIN,
      ORG_A,
      hash,
      ORG_A2,
      STAFF_CASHIER2_A,
      T13B,
      ORG_B,
    ],
  );
  await owner.query(
    `INSERT INTO staff_role (tenant_id, staff_id, role_id, created_at, updated_at)
     VALUES ($1, $2, $5, now(), now()),
            ($1, $3, $6, now(), now()),
            ($1, $4, $7, now(), now()),
            ($1, $8, $9, now(), now()),
            ($10, $11, $12, now(), now())
     ON CONFLICT DO NOTHING`,
    [
      T13A,
      STAFF_ADMIN_A,
      STAFF_READER_A,
      STAFF_SCOPED_A,
      ROLE_ADMIN_A,
      ROLE_READER_A,
      ROLE_SCOPED_A,
      STAFF_BILLER_A,
      ROLE_BILLER_A,
      T13B,
      STAFF_B_ADMIN,
      ROLE_B_ADMIN,
    ],
  );

  // The test DB persists between runs — wipe tenant A's business tables
  // (FK-safe order); iam fixtures above are idempotent and stay.
  for (const table of [
    'payment_alloc',
    'receipt',
    'payment',
    'cashier_day_close',
    'bill_item',
    'bill',
    'billing_run',
    'consumption_component',
    'consumption_settlement',
    'meter_reading',
    'reading_plan_item',
    'reading_plan',
    'book_meter',
    'reading_book',
    'account_event',
    'meter_installation',
    'meter',
    'water_account_household_profile',
    'water_account',
    'settle_account',
    'customer',
    'tariff_tier',
    'tariff_plan',
    'fee_item',
    'tenant_param',
  ]) {
    await owner.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [T13A]);
  }

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleFixture.createNestApplication();
  await app.init();

  const login = async (tenantCode: string, login_: string) =>
    (
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ tenantCode, login: login_, password: 't13-pass' })
        .expect(201)
    ).body.accessToken as string;
  adminToken = await login('t13-water', 't13-admin');
  readerToken = await login('t13-water', 't13-reader');
  scopedToken = await login('t13-water', 't13-scoped');
  billerToken = await login('t13-water', 't13-biller');
  tenantBToken = await login('t13-other', 't13b-admin');
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

describe('fixtures: books + plans + readings', () => {
  it('onboards accounts and builds book1 (ORG_A, 3 items) + book2 (ORG_A2, 1 item) with 202610 plans', async () => {
    for (const label of ['A1', 'A2', 'A3', 'B1']) {
      await onboard(label);
    }
    // A commercial account for the byCategory split in ar-monthly.
    await onboard('C1', 'NON_RES');

    const book1 = await post('/reading-books', {
      name: `T13 Book1 ${RUN}`,
      orgUnitId: ORG_A,
    }).expect(201);
    book['B1'] = book1.body.id;
    for (const label of ['A1', 'A2', 'A3']) {
      await post(`/reading-books/${book['B1']}/meters`, {
        waterAccountId: acct[label],
      }).expect(201);
    }
    const plan1 = await post('/reading-plans/generate', {
      bookId: book['B1'],
      period: '202610',
      planDate: '2026-10-05',
    }).expect(201);
    for (const i of plan1.body.items) {
      item[`B1:${i.waterAccountId === acct['A1'] ? 'A1' : i.waterAccountId === acct['A2'] ? 'A2' : 'A3'}`] =
        i.id;
    }
    expect(plan1.body.items).toHaveLength(3);

    const book2 = await post('/reading-books', {
      name: `T13 Book2 ${RUN}`,
      orgUnitId: ORG_A2,
    }).expect(201);
    book['B2'] = book2.body.id;
    await post(`/reading-books/${book['B2']}/meters`, {
      waterAccountId: acct['B1'],
    }).expect(201);
    const plan2 = await post('/reading-plans/generate', {
      bookId: book['B2'],
      period: '202610',
      planDate: '2026-10-05',
    }).expect(201);
    item['B2:B1'] = plan2.body.items[0].id;
    expect(plan2.body.items).toHaveLength(1);
  });

  it('enters 2026-10-05 readings on book1: A1 ACTUAL + A2 NO_READ (A3 stays PENDING)', async () => {
    const r1 = await post('/meter-readings', {
      planItemId: item['B1:A1'],
      resultType: 'ACTUAL',
      readingValue: '25',
      readDate: '2026-10-05',
    }).expect(201);
    expect(r1.body.resultType).toBe('ACTUAL');
    const r2 = await post('/meter-readings', {
      planItemId: item['B1:A2'],
      resultType: 'NO_READ',
      exceptionCode: 'LOCKED',
      readDate: '2026-10-05',
    }).expect(201);
    expect(r2.body.resultType).toBe('NO_READ');
  });
});

describe('GET /reports/meter-daily', () => {
  it('reports per-book item counts + same-day readingsTaken for 2026-10-05', async () => {
    const res = (await get('/reports/meter-daily?date=2026-10-05')).body;
    expect(res).toHaveLength(2);
    const row1 = res.find((r: { bookId: string }) => r.bookId === book['B1']);
    expect(row1).toMatchObject({
      bookNo: expect.any(String),
      orgUnitId: ORG_A,
      plans: 1,
      total: 3,
      read: 1,
      noRead: 1,
      pending: 1,
      skipped: 0,
      readingsTaken: 2,
    });
    const row2 = res.find((r: { bookId: string }) => r.bookId === book['B2']);
    expect(row2).toMatchObject({
      orgUnitId: ORG_A2,
      plans: 1,
      total: 1,
      read: 0,
      noRead: 0,
      pending: 1,
      skipped: 0,
      readingsTaken: 0,
    });
  });

  it('bookId + orgUnitId filters narrow the row set; a day with nothing returns []', async () => {
    const one = (await get(`/reports/meter-daily?date=2026-10-05&bookId=${book['B1']}`)).body;
    expect(one).toHaveLength(1);
    expect(one[0].bookId).toBe(book['B1']);
    const byOrg = (await get(`/reports/meter-daily?date=2026-10-05&orgUnitId=${ORG_A2}`)).body;
    expect(byOrg).toHaveLength(1);
    expect(byOrg[0].bookId).toBe(book['B2']);
    // A date in a month with no plans and no readings → no rows at all.
    const none = (await get('/reports/meter-daily?date=2026-11-05')).body;
    expect(none).toEqual([]);
  });

  it('a reading taken on 2026-10-07 attributes to that day (readDate basis)', async () => {
    await post('/meter-readings', {
      planItemId: item['B2:B1'],
      resultType: 'ACTUAL',
      readingValue: '40',
      readDate: '2026-10-07',
    }).expect(201);
    const res = (await get('/reports/meter-daily?date=2026-10-07')).body;
    const row2 = res.find((r: { bookId: string }) => r.bookId === book['B2']);
    expect(row2).toMatchObject({ readingsTaken: 1, read: 1, pending: 0 });
    // The book1 row on the 7th still shows the same period snapshot, no new work.
    const row1 = res.find((r: { bookId: string }) => r.bookId === book['B1']);
    expect(row1).toMatchObject({ readingsTaken: 0, read: 1, noRead: 1, pending: 1 });
  });

  it('a scoped report:read holder sees only own-subtree books (ORG_A2)', async () => {
    const res = (await get('/reports/meter-daily?date=2026-10-05', scopedToken)).body;
    expect(res).toHaveLength(1);
    expect(res[0].bookId).toBe(book['B2']);
    // An out-of-subtree orgUnitId filter yields nothing, not a leak.
    const out = (await get(`/reports/meter-daily?date=2026-10-05&orgUnitId=${ORG_A}`, scopedToken)).body;
    expect(out).toEqual([]);
  });
});

describe('fixtures: payments + close + bills for the money reports', () => {
  it('seeds bills across periods/statuses and payments across days/channels', async () => {
    // ar-monthly predicate coverage for period 202610:
    //   in: POSTED 10000, PARTIAL_PAID 4000 (RES_METERED), POSTED 6000 (NON_RES)
    //   out: DRAFT, REVERSED-status, REVERSAL-kind, other period (202611 POSTED).
    await seedBill('bill1', acct['A1'], settleAcct['A1'], '202610', {
      status: 'POSTED',
      totalAmount: 10000,
      sourceId: 'aa13aa13-9999-4999-8999-000000000001',
    });
    await seedBill('bill2', acct['A2'], settleAcct['A2'], '202610', {
      status: 'PARTIAL_PAID',
      totalAmount: 4000,
      sourceId: 'aa13aa13-9999-4999-8999-000000000002',
    });
    await seedBill('bill3', acct['C1'], settleAcct['C1'], '202610', {
      status: 'POSTED',
      totalAmount: 6000,
      sourceId: 'aa13aa13-9999-4999-8999-000000000003',
    });
    await seedBill('billDraft', acct['A3'], settleAcct['A3'], '202610', {
      status: 'DRAFT',
      totalAmount: 9999,
      sourceId: 'aa13aa13-9999-4999-8999-000000000004',
    });
    await seedBill('billReversed', acct['A3'], settleAcct['A3'], '202610', {
      status: 'REVERSED',
      totalAmount: 5555,
      sourceId: 'aa13aa13-9999-4999-8999-000000000005',
    });
    await seedBill('billReversal', acct['A3'], settleAcct['A3'], '202610', {
      status: 'POSTED',
      billKind: 'REVERSAL',
      totalAmount: -5555,
      sourceId: bill['billReversed'],
    });
    await seedBill('billNov', acct['A1'], settleAcct['A1'], '202611', {
      status: 'POSTED',
      totalAmount: 7777,
      sourceId: 'aa13aa13-9999-4999-8999-000000000007',
    });

    // cashier-daily / collected-monthly payments on 2026-10-06:
    //   cashier1 (ORG_A): CASH +4000, POS +2500, TRANSFER +1000 — all
    //   DAY_CLOSED inside the seeded close; CASH −1500 reversal straggler.
    //   cashier2 (ORG_A2): CASH +800 RECEIVED, no close.
    const closeId = (
      await owner.query(
        `INSERT INTO cashier_day_close
           (id, tenant_id, cashier_id, org_unit_id, close_date, total_count,
            total_amount, by_channel, status, closed_at, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, '2026-10-06', 3, 7500,
                 '{"CASH":{"count":1,"amount":"4000"},"POS":{"count":1,"amount":"2500"},"TRANSFER":{"count":1,"amount":"1000"}}'::jsonb,
                 'POSTED', now(), now(), now())
         RETURNING id::text AS id`,
        [T13A, STAFF_CASHIER1_A, ORG_A],
      )
    ).rows[0].id as string;
    await seedPayment('p1', 1, {
      cashierId: STAFF_CASHIER1_A,
      orgUnitId: ORG_A,
      settleAccountId: settleAcct['A1'],
      billId: bill['bill1'],
      channel: 'CASH',
      amount: 4000,
      receivedAt: '2026-10-06T09:30:00Z',
      status: 'DAY_CLOSED',
      dayCloseId: closeId,
    });
    await seedPayment('p2', 2, {
      cashierId: STAFF_CASHIER1_A,
      orgUnitId: ORG_A,
      settleAccountId: settleAcct['C1'],
      billId: bill['bill3'],
      channel: 'POS',
      amount: 2500,
      receivedAt: '2026-10-06T10:00:00Z',
      status: 'DAY_CLOSED',
      dayCloseId: closeId,
    });
    await seedPayment('p3', 3, {
      cashierId: STAFF_CASHIER1_A,
      orgUnitId: ORG_A,
      settleAccountId: settleAcct['A2'],
      billId: bill['bill2'],
      channel: 'TRANSFER',
      amount: 1000,
      receivedAt: '2026-10-06T11:00:00Z',
      status: 'DAY_CLOSED',
      dayCloseId: closeId,
    });
    await seedPayment('p4rev', 4, {
      cashierId: STAFF_CASHIER1_A,
      orgUnitId: ORG_A,
      settleAccountId: settleAcct['A1'],
      billId: bill['bill1'],
      channel: 'CASH',
      amount: -1500,
      receivedAt: '2026-10-06T15:00:00Z',
      reversalOfId: pay['p1'],
    });
    await seedPayment('p5', 5, {
      cashierId: STAFF_CASHIER2_A,
      orgUnitId: ORG_A2,
      settleAccountId: settleAcct['B1'],
      billId: bill['billDraft'],
      channel: 'CASH',
      amount: 800,
      receivedAt: '2026-10-06T12:00:00Z',
    });
    // 2026-10-20 CASH 3200 for cashier1 → October collected = 10000.
    await seedPayment('p6', 6, {
      cashierId: STAFF_CASHIER1_A,
      orgUnitId: ORG_A,
      settleAccountId: settleAcct['A2'],
      billId: bill['bill2'],
      channel: 'CASH',
      amount: 3200,
      receivedAt: '2026-10-20T09:00:00Z',
    });
    // 2026-11-03 CASH 2000 → November collected = 2000 (through-variant).
    await seedPayment('p7', 7, {
      cashierId: STAFF_CASHIER1_A,
      orgUnitId: ORG_A,
      settleAccountId: settleAcct['A1'],
      billId: bill['billNov'],
      channel: 'CASH',
      amount: 2000,
      receivedAt: '2026-11-03T09:00:00Z',
    });
  });
});

describe('GET /reports/cashier-daily', () => {
  it('groups received payments per cashier × channel; reversal nets; closed flag set', async () => {
    const res = (await get('/reports/cashier-daily?date=2026-10-06')).body;
    expect(res).toHaveLength(2);
    const c1 = res.find((r: { cashierId: string }) => r.cashierId === STAFF_CASHIER1_A);
    expect(c1).toMatchObject({ name: 'T13 Cashier1', closed: true });
    expect(c1.byChannel.CASH).toEqual({ count: 2, amount: '2500' }); // 4000 − 1500
    expect(c1.byChannel.POS).toEqual({ count: 1, amount: '2500' });
    expect(c1.byChannel.TRANSFER).toEqual({ count: 1, amount: '1000' });
    expect(c1.total).toEqual({ count: 4, amount: '6000' });
    const c2 = res.find((r: { cashierId: string }) => r.cashierId === STAFF_CASHIER2_A);
    expect(c2).toMatchObject({ name: 'T13 Cashier2', closed: false });
    expect(c2.byChannel.CASH).toEqual({ count: 1, amount: '800' });
    expect(c2.total).toEqual({ count: 1, amount: '800' });
    const none = (await get('/reports/cashier-daily?date=2026-10-07')).body;
    expect(none).toEqual([]);
  });
});

describe('GET /reports/ar-monthly', () => {
  it('sums the documented billed predicate per usage_category', async () => {
    const res = (await get('/reports/ar-monthly?period=202610')).body;
    expect(res.period).toBe('202610');
    expect(res.billed).toBe('20000'); // 10000 + 4000 + 6000
    expect(res.byCategory.RES_METERED).toEqual({ count: 2, amount: '14000' });
    expect(res.byCategory.NON_RES).toEqual({ count: 1, amount: '6000' });
    const nov = (await get('/reports/ar-monthly?period=202611')).body;
    expect(nov.billed).toBe('7777');
    const empty = (await get('/reports/ar-monthly?period=202612')).body;
    expect(empty).toMatchObject({ billed: '0' });
    expect(empty.byCategory).toEqual({});
  });
});

describe('GET /reports/collected-monthly', () => {
  it('sums received payments in the month by channel; allocated ≡ collected', async () => {
    const res = (await get('/reports/collected-monthly?period=202610')).body;
    expect(res.period).toBe('202610');
    expect(res.collected).toBe('10000'); // 4000+2500+1000−1500+800+3200
    expect(res.byChannel.CASH).toEqual({ count: 4, amount: '6500' });
    expect(res.byChannel.POS).toEqual({ count: 1, amount: '2500' });
    expect(res.byChannel.TRANSFER).toEqual({ count: 1, amount: '1000' });
    expect(res.allocated).toBe('10000');
    const nov = (await get('/reports/collected-monthly?period=202611')).body;
    expect(nov.collected).toBe('2000');
    expect(nov.allocated).toBe('2000');
  });
});

describe('GET /reports/recovery-rate', () => {
  it('single-month rate at 4dp; through-cumulative; billed=0 → null', async () => {
    const oct = (await get('/reports/recovery-rate?period=202610')).body;
    expect(oct).toMatchObject({
      period: '202610',
      through: null,
      billed: '20000',
      collected: '10000',
      rate: '0.5000',
    });
    // cumulative ≤ 202611: billed 20000+7777, collected 10000+2000.
    const cum = (await get('/reports/recovery-rate?period=202610&through=202611')).body;
    expect(cum).toMatchObject({
      period: '202610',
      through: '202611',
      billed: '27777',
      collected: '12000',
      rate: '0.4320',
    });
    const zero = (await get('/reports/recovery-rate?period=202612')).body;
    expect(zero).toMatchObject({ billed: '0', collected: '0', rate: null });
  });
});

describe('validation + permission + tenant isolation', () => {
  it('missing/malformed params get clean 400s', async () => {
    for (const path of [
      '/reports/meter-daily',
      '/reports/meter-daily?date=2026-13-01',
      '/reports/meter-daily?date=20261005',
      '/reports/cashier-daily?date=10-06',
      '/reports/ar-monthly?period=2026-10',
      '/reports/collected-monthly?period=202613',
      '/reports/recovery-rate?period=202610&through=202609',
      '/reports/recovery-rate',
    ]) {
      const res = await request(app.getHttpServer()).get(path).set(auth(adminToken));
      expect(res.status).toBe(400);
    }
    const badUuid = await request(app.getHttpServer())
      .get('/reports/meter-daily?date=2026-10-05&bookId=nope')
      .set(auth(adminToken));
    expect(badUuid.status).toBe(400);
  });

  it('report:read holder reads the endpoints; billing:write-only holder → 403', async () => {
    for (const path of [
      '/reports/meter-daily?date=2026-10-05',
      '/reports/cashier-daily?date=2026-10-06',
      '/reports/ar-monthly?period=202610',
      '/reports/collected-monthly?period=202610',
    ]) {
      const ok = await request(app.getHttpServer()).get(path).set(auth(readerToken));
      expect(ok.status).toBe(200);
      const denied = await request(app.getHttpServer()).get(path).set(auth(billerToken));
      expect(denied.status).toBe(403);
      expect(denied.body).toMatchObject({ code: 'PERMISSION_DENIED' });
    }
    // recovery-rate is tenant-scope-only: a scoped report:read holder
    // fails closed, a billing:write-only holder is still 403 (permission
    // check precedes the scope check).
    const recDenied = await request(app.getHttpServer())
      .get('/reports/recovery-rate?period=202610')
      .set(auth(billerToken));
    expect(recDenied.status).toBe(403);
    expect(recDenied.body).toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('tenant B sees nothing on any report', async () => {
    const meter = (await get('/reports/meter-daily?date=2026-10-05', tenantBToken)).body;
    expect(meter).toEqual([]);
    const cashier = (await get('/reports/cashier-daily?date=2026-10-06', tenantBToken)).body;
    expect(cashier).toEqual([]);
    const ar = (await get('/reports/ar-monthly?period=202610', tenantBToken)).body;
    expect(ar).toMatchObject({ billed: '0' });
    const col = (await get('/reports/collected-monthly?period=202610', tenantBToken)).body;
    expect(col).toMatchObject({ collected: '0', allocated: '0' });
    const rec = (await get('/reports/recovery-rate?period=202610', tenantBToken)).body;
    expect(rec).toMatchObject({ billed: '0', collected: '0', rate: null });
  });
});

/**
 * E10-RC1 B2 — scoped report coverage. scopedToken is a report:read
 * holder bound to ORG_A2 (ORG_SUBTREE); readerToken sits on ORG_A.
 * Fixtures here are seeded AFTER the earlier describes ran so existing
 * assertions stay untouched; assertions use the post-seed totals.
 */
describe('E10-RC1 scoped reports (B2)', () => {
  it('fixtures: ORG_A2-territory bill + cross-counter November payment', async () => {
    // billB1 on acct B1 — covered only by book2 (ORG_A2).
    await seedBill('billB1', acct['B1'], settleAcct['B1'], '202610', {
      status: 'POSTED',
      totalAmount: 7000,
      sourceId: crypto.randomUUID(),
    });
    // pB: cashier2 collects at the ORG_A2 counter but allocates to
    // billNov — an A1 bill whose account is covered by book1 (ORG_A).
    // collected follows the counter org; allocated follows AGG_OWN —
    // the two anchors intentionally diverge for a scoped caller.
    await seedPayment('pB', 8, {
      cashierId: STAFF_CASHIER2_A,
      orgUnitId: ORG_A2,
      settleAccountId: settleAcct['A1'],
      billId: bill['billNov'],
      channel: 'CASH',
      amount: 900,
      receivedAt: '2026-11-05T09:00:00Z',
    });
  });

  it('cashier-daily: scoped caller sees only own-counter rows', async () => {
    const res = (await get('/reports/cashier-daily?date=2026-10-06', scopedToken)).body;
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({
      cashierId: STAFF_CASHIER2_A,
      name: 'T13 Cashier2',
      closed: false,
    });
    expect(res[0].total).toEqual({ count: 1, amount: '800' });
  });

  it('ar-monthly: scoped sees only AGG_OWN-covered bills; off-book excluded; tenant sees all', async () => {
    // scoped ORG_A2: only billB1 (B1 via book2). A1/A2/A3 are covered by
    // book1 (ORG_A — out of subtree) and C1 is off-book → both excluded.
    const scoped = (await get('/reports/ar-monthly?period=202610', scopedToken)).body;
    expect(scoped.billed).toBe('7000');
    expect(scoped.byCategory).toEqual({
      RES_METERED: { count: 1, amount: '7000' },
    });
    // tenant: everything — ORG_A book bills + ORG_A2 bill + off-book C1.
    const all = (await get('/reports/ar-monthly?period=202610')).body;
    expect(all.billed).toBe('27000'); // 20000 + 7000
    expect(all.byCategory.RES_METERED).toEqual({ count: 3, amount: '21000' });
    expect(all.byCategory.NON_RES).toEqual({ count: 1, amount: '6000' });
  });

  it('collected-monthly: collected anchors to counter org, allocated to bill AGG_OWN — allowed to diverge', async () => {
    const scoped = (await get('/reports/collected-monthly?period=202611', scopedToken)).body;
    // pB received at the ORG_A2 counter → in-scope collected.
    expect(scoped.collected).toBe('900');
    // …but its alloc lands on billNov whose account A1 is covered by
    // book1 (ORG_A) → out-of-scope allocated. p7 (ORG_A counter) is
    // invisible on the collected side, and its billNov alloc is also
    // out-of-scope → allocated stays 0.
    expect(scoped.allocated).toBe('0');
    const all = (await get('/reports/collected-monthly?period=202611')).body;
    expect(all.collected).toBe('2900'); // p7 2000 + pB 900
    expect(all.allocated).toBe('2900');
  });

  it('recovery-rate: tenant scope works; scoped caller fails closed 403', async () => {
    const all = await request(app.getHttpServer())
      .get('/reports/recovery-rate?period=202610')
      .set(auth(adminToken))
      .expect(200);
    expect(all.body.rate).toBe('0.3704'); // 10000 / 27000
    for (const t of [scopedToken, readerToken]) {
      const res = await request(app.getHttpServer())
        .get('/reports/recovery-rate?period=202610')
        .set(auth(t));
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'REPORT_SCOPE_UNDEFINED' });
    }
  });
});
