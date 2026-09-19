/**
 * Payment / allocation / receipt / cashier day-close e2e against
 * `watersaas_test` — fixtures carry the `t12-` prefix. Boots the real
 * AppModule so JWT/permission guards, tenant ALS and RLS all apply.
 *
 * Covers (Task-12 brief assertions):
 *  1. POST /payments split across 2 bills → one PAID, one PARTIAL_PAID;
 *     payment_no + receipt_no issued; GET /water-accounts/:id/outstanding
 *     reflects the remainder; a negative ADJUSTMENT bill nets the total
 *  2. validation: Σ allocs ≠ amount → 400 PAYMENT_ALLOC_MISMATCH;
 *     duplicate billId → 400 PAYMENT_ALLOC_DUPLICATE; alloc > outstanding
 *     → 409 PAYMENT_OVER_ALLOCATION; DRAFT/PAID/REVERSED/REVERSAL-kind
 *     bill → 409 BILL_NOT_PAYABLE; wrong settle account → 400
 *  3. Idempotency-Key: same payload → identical payment; different → 409
 *  4. reverse: ORIGINAL stays RECEIVED (never flipped), a RECEIVED
 *     reversal payment carries −amount + mirror allocs, bills roll back
 *     to POSTED, the original receipt is voided (print → 409);
 *     double-reverse → 409, reversing a reversal → 400
 *  5. day close: RECEIVED → DAY_CLOSED, by_channel sums incl. a negative
 *     reversal leg; empty → 409 DAY_CLOSE_EMPTY; same date → 409
 *     DAY_CLOSE_EXISTS; post-close reversal is swept by the NEXT close
 *  6. close-account after payment: partial pay still blocks, remaining
 *     DRAFT blocks, fully clear → closes; a reversed-bill's orphan alloc
 *     becomes a blocking customer credit until the payment is reversed
 *  7. tenant B isolation; payment:read reads but cannot write; a scoped
 *     payment:write holder → 403 on an out-of-scope settle account
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

// ---- fixtures (all prefixed t12-) ----
const T12A = 'aa12aa12-1212-4012-8012-aa12aa12aa12'; // tenant A
const T12B = 'bb12bb12-2020-4020-8020-bb12bb12bb12'; // tenant B (isolation)
const ORG_A = 'aa12aa12-0000-4000-8000-0000000000c0';
const ORG_A2 = 'aa12aa12-0000-4000-8000-0000000000c2'; // child of ORG_A
const ORG_B = 'bb12bb12-0000-4000-8000-0000000000c0';
const ROLE_ADMIN_A = 'aa12aa12-0000-4000-8000-00000000ad01';
const ROLE_READER_A = 'aa12aa12-0000-4000-8000-000000001e01';
const ROLE_CASHIER_A = 'aa12aa12-0000-4000-8000-00000000ca01';
const ROLE_SCOPED_A = 'aa12aa12-0000-4000-8000-00000000c011';
const ROLE_B_ADMIN = 'bb12bb12-0000-4000-8000-00000000ad01';
const PERM_PAY_READ = 'aa12aa12-0000-4000-8000-00000000e801';
const PERM_PAY_WRITE = 'aa12aa12-0000-4000-8000-00000000e802';
const STAFF_ADMIN_A = 'aa12aa12-0000-4000-8000-0000000a0001';
const STAFF_READER_A = 'aa12aa12-0000-4000-8000-0000000b0002';
const STAFF_CASHIER_A = 'aa12aa12-0000-4000-8000-0000000a0003';
const STAFF_SCOPED_A = 'aa12aa12-0000-4000-8000-0000000c0003';
const STAFF_B_ADMIN = 'bb12bb12-0000-4000-8000-0000000a0001';

const owner = new pg.Client({ connectionString: OWNER_URL });
let app: INestApplication<App>;
let adminToken = '';
let readerToken = '';
let cashierToken = '';
let scopedToken = '';
let tenantBToken = '';

// ids populated by the sequential suite
const acct: Record<string, string> = {}; // water_account ids
const settleAcct: Record<string, string> = {}; // settle_account ids
const bill: Record<string, string> = {};
const pay: Record<string, string> = {};
const receipt: Record<string, string> = {};

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

const post = (path: string, body: unknown, token = adminToken) =>
  request(app.getHttpServer()).post(path).set(auth(token)).send(body);

const get = (path: string, token = adminToken, status = 200) =>
  request(app.getHttpServer()).get(path).set(auth(token)).expect(status);

const onboard = async (label: string, usageCategory = 'RESIDENTIAL') => {
  const res = await post('/water-accounts/onboard', {
    customer: { name: `T12 ${label} ${RUN}`, custType: 'PERSONAL' },
    account: { usageCategory, addr: `${label} Water St` },
    meter: { brand: 't12-brand', caliber: 'DN15' },
    installation: { initialReading: 0, installedAt: '2026-01-01' },
  }).expect(201);
  acct[label] = res.body.waterAccount.id;
  settleAcct[label] = res.body.settleAccount.id;
  return res.body;
};

const seedSettlement = async (waterAccountId: string, period: string, usage: number) => {
  const row = (
    await owner.query(
      `INSERT INTO consumption_settlement
         (id, tenant_id, water_account_id, period, total_usage_qty, is_estimated,
          estimate_method, estimate_reason, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, false, NULL, NULL, 'FINAL', now(), now())
       RETURNING id::text AS id`,
      [T12A, waterAccountId, period, usage],
    )
  ).rows[0];
  return row.id as string;
};

/** Insert a bill directly (NORMAL POSTED by default — the payable side). */
const seedBill = async (
  label: string,
  waterAccountId: string,
  settleAccountId: string,
  period: string,
  opts: {
    status?: string;
    billKind?: string;
    sourceType?: string;
    sourceId?: string;
    totalAmount?: number;
  } = {},
) => {
  const sourceId =
    opts.sourceId ?? (await seedSettlement(waterAccountId, period, 1));
  const row = (
    await owner.query(
      `INSERT INTO bill (id, tenant_id, settle_account_id, water_account_id, period,
                         bill_kind, source_type, source_id, tariff_plan_id, status,
                         is_estimated, total_amount, issued_at, due_date,
                         created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7::uuid, NULL, $8,
               false, $9, now(), '2026-07-15', now(), now())
       RETURNING id::text AS id`,
      [
        T12A,
        settleAccountId,
        waterAccountId,
        period,
        opts.billKind ?? 'NORMAL',
        opts.sourceType ?? 'SETTLEMENT',
        sourceId,
        opts.status ?? 'POSTED',
        opts.totalAmount ?? 1000,
      ],
    )
  ).rows[0];
  bill[label] = row.id;
  return row.id as string;
};

const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  await owner.connect();
  const hash = await bcrypt.hash('t12-pass', 10);

  await owner.query(
    `INSERT INTO tenant (id, code, name, status, created_at, updated_at)
     VALUES ($1, 't12-water', 'T12 Water', 'ACTIVE', now(), now()),
            ($2, 't12-other', 'T12 Other', 'ACTIVE', now(), now())
     ON CONFLICT DO NOTHING`,
    [T12A, T12B],
  );
  await owner.query(
    `INSERT INTO org_unit (id, tenant_id, parent_id, name, type, created_at, updated_at)
     VALUES ($1, $2, NULL, 'T12 Company', 'COMPANY', now(), now()),
            ($3, $2, $1, 'T12 Branch', 'BRANCH', now(), now()),
            ($4, $5, NULL, 'T12B Company', 'COMPANY', now(), now())
     ON CONFLICT DO NOTHING`,
    [ORG_A, T12A, ORG_A2, ORG_B, T12B],
  );
  await owner.query(
    `INSERT INTO role (id, tenant_id, code, name, data_scope, created_at, updated_at)
     VALUES ($1, $3, 'admin', 'T12 Admin', 'ALL', now(), now()),
            ($2, $3, 't12-reader', 'T12 Pay Reader', 'ORG_SUBTREE', now(), now()),
            ($4, $3, 't12-cashier', 'T12 Cashier', 'ORG_SUBTREE', now(), now()),
            ($5, $3, 't12-scoped', 'T12 Scoped Pay', 'ORG_SUBTREE', now(), now()),
            ($6, $7, 'admin', 'T12B Admin', 'ALL', now(), now())
     ON CONFLICT DO NOTHING`,
    [ROLE_ADMIN_A, ROLE_READER_A, T12A, ROLE_CASHIER_A, ROLE_SCOPED_A, ROLE_B_ADMIN, T12B],
  );
  await owner.query(
    `INSERT INTO permission (id, tenant_id, code, type, created_at, updated_at)
     VALUES ($1, $2, 'payment:read', 'ACTION', now(), now()),
            ($3, $2, 'payment:write', 'ACTION', now(), now())
     ON CONFLICT DO NOTHING`,
    [PERM_PAY_READ, T12A, PERM_PAY_WRITE],
  );
  await owner.query(
    `INSERT INTO role_permission (tenant_id, role_id, permission_id, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now()),
            ($1, $4, $3, now(), now()),
            ($1, $4, $5, now(), now()),
            ($1, $6, $5, now(), now()),
            ($1, $6, $3, now(), now())
     ON CONFLICT DO NOTHING`,
    [T12A, ROLE_READER_A, PERM_PAY_READ, ROLE_CASHIER_A, PERM_PAY_WRITE, ROLE_SCOPED_A],
  );
  await owner.query(
    `INSERT INTO staff (id, tenant_id, org_unit_id, login, password_hash, name, status, created_at, updated_at)
     VALUES ($1, $5, $7, 't12-admin',   $8, 'T12 Admin',   'ACTIVE', now(), now()),
            ($2, $5, $7, 't12-reader',  $8, 'T12 Reader',  'ACTIVE', now(), now()),
            ($3, $5, $7, 't12-cashier', $8, 'T12 Cashier', 'ACTIVE', now(), now()),
            ($4, $5, $9, 't12-scoped',  $8, 'T12 Scoped',  'ACTIVE', now(), now()),
            ($6, $10, $11, 't12b-admin', $8, 'T12B Admin', 'ACTIVE', now(), now())
     ON CONFLICT (tenant_id, login) DO NOTHING`,
    [
      STAFF_ADMIN_A,
      STAFF_READER_A,
      STAFF_CASHIER_A,
      STAFF_SCOPED_A,
      T12A,
      STAFF_B_ADMIN,
      ORG_A,
      hash,
      ORG_A2,
      T12B,
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
      T12A,
      STAFF_ADMIN_A,
      STAFF_READER_A,
      STAFF_CASHIER_A,
      ROLE_ADMIN_A,
      ROLE_READER_A,
      ROLE_CASHIER_A,
      STAFF_SCOPED_A,
      ROLE_SCOPED_A,
      T12B,
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
    'water_account',
    'settle_account',
    'customer',
    'tariff_tier',
    'tariff_plan',
    'fee_item',
    'tenant_param',
  ]) {
    await owner.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [T12A]);
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
        .send({ tenantCode, login: login_, password: 't12-pass' })
        .expect(201)
    ).body.accessToken as string;
  adminToken = await login('t12-water', 't12-admin');
  readerToken = await login('t12-water', 't12-reader');
  cashierToken = await login('t12-water', 't12-cashier');
  scopedToken = await login('t12-water', 't12-scoped');
  tenantBToken = await login('t12-other', 't12b-admin');
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

describe('fixtures: accounts + payable bills', () => {
  it('onboards A1..A7 and seeds POSTED-side bills per settle account', async () => {
    for (const label of ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7']) {
      await onboard(label);
    }
    // A1: split-payment targets — 31000 POSTED, 10000 POSTED.
    await seedBill('B1', acct['A1'], settleAcct['A1'], '202606', { totalAmount: 31000 });
    await seedBill('B2', acct['A1'], settleAcct['A1'], '202607', { totalAmount: 10000 });
    // A2: reverse target 6000 + a small bill for the idempotency test.
    await seedBill('B3', acct['A2'], settleAcct['A2'], '202606', { totalAmount: 6000 });
    await seedBill('B3b', acct['A2'], settleAcct['A2'], '202607', { totalAmount: 2000 });
    // A3: the cashier's day-close bills.
    await seedBill('B5', acct['A3'], settleAcct['A3'], '202606', { totalAmount: 4000 });
    await seedBill('B6', acct['A3'], settleAcct['A3'], '202607', { totalAmount: 2500 });
    // A4: close-account flow — POSTED 8000 + DRAFT 3000.
    await seedBill('B7', acct['A4'], settleAcct['A4'], '202606', { totalAmount: 8000 });
    await seedBill('D4', acct['A4'], settleAcct['A4'], '202607', {
      status: 'DRAFT',
      totalAmount: 3000,
    });
    // A5: reversed-bill credit edge.
    await seedBill('B8', acct['A5'], settleAcct['A5'], '202606', { totalAmount: 5000 });
    // A6: unpayable kind/status fixtures.
    await seedBill('D6', acct['A6'], settleAcct['A6'], '202606', {
      status: 'DRAFT',
      totalAmount: 7000,
    });
    await seedBill('R6', acct['A6'], settleAcct['A6'], '202607', {
      status: 'REVERSED',
      totalAmount: 9000,
    });
    await seedBill('V6', acct['A6'], settleAcct['A6'], '202608', {
      billKind: 'REVERSAL',
      sourceType: 'ORIGINAL_BILL',
      sourceId: bill['R6'],
      totalAmount: -9000,
    });
    // A7: bound to a book under ORG_A later (scope test).
    await seedBill('B9', acct['A7'], settleAcct['A7'], '202606', { totalAmount: 1500 });
  });
});

describe('POST /payments — multi-bill allocation', () => {
  it('splits one payment across two bills → one PAID, one PARTIAL_PAID; payment_no + receipt_no issued', async () => {
    const res = await post('/payments', {
      settleAccountId: settleAcct['A1'],
      channel: 'CASH',
      amount: 36000,
      allocs: [
        { billId: bill['B1'], amount: 31000 },
        { billId: bill['B2'], amount: 5000 },
      ],
    }).expect(201);
    pay['P1'] = res.body.id;
    receipt['P1'] = res.body.receipt.id;
    expect(res.body).toMatchObject({
      settleAccountId: settleAcct['A1'],
      cashierId: STAFF_ADMIN_A,
      orgUnitId: ORG_A,
      channel: 'CASH',
      amount: '36000',
      status: 'RECEIVED',
      reversalOfId: null,
    });
    expect(res.body.paymentNo).toMatch(/^P\d{12}$/);
    expect(res.body.receipt.receiptNo).toMatch(/^R\d{12}$/);
    expect(res.body.receipt.printedAt).toBeNull();
    expect(res.body.receipt.voidFlag).toBe(false);
    expect(res.body.allocs).toHaveLength(2);

    const b1 = (await get(`/bills/${bill['B1']}`)).body;
    expect(b1.status).toBe('PAID');
    const b2 = (await get(`/bills/${bill['B2']}`)).body;
    expect(b2.status).toBe('PARTIAL_PAID');

    const detail = (await get(`/payments/${pay['P1']}`)).body;
    expect(detail.allocs.map((a: { billId: string }) => a.billId).sort()).toEqual(
      [bill['B1'], bill['B2']].sort(),
    );
    expect(detail.receipt.id).toBe(receipt['P1']);
  });

  it('GET /water-accounts/:id/outstanding — remainder math; a negative ADJUSTMENT bill nets the total', async () => {
    let res = (await get(`/water-accounts/${acct['A1']}/outstanding`)).body;
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      billId: bill['B2'],
      period: '202607',
      billKind: 'NORMAL',
      totalAmount: '10000',
      paidAmount: '5000',
      outstanding: '5000',
    });
    expect(res.totalOutstanding).toBe('5000');

    // A posted credit bill (reconciliation adjustment) nets the settle
    // account's position without entering the payable items list. A
    // MANUAL source carries no settlement row — a stand-in uuid keeps the
    // (tenant, source_type, source_id, bill_kind) tuple unique.
    await seedBill('ADJ1', acct['A1'], settleAcct['A1'], '202607', {
      billKind: 'ADJUSTMENT',
      sourceType: 'MANUAL',
      sourceId: 'aa12aa12-9999-4999-8999-0000000000a1',
      totalAmount: -2000,
    });
    res = (await get(`/water-accounts/${acct['A1']}/outstanding`)).body;
    expect(res.items).toHaveLength(1); // the credit bill is not payable
    expect(res.reversedBillCredit).toBe('0');
    expect(res.totalOutstanding).toBe('3000');
  });

  it('rejects malformed payloads before any DB work (400s)', async () => {
    const bad = (body: unknown) => post('/payments', body);
    expect((await bad({ settleAccountId: settleAcct['A1'], channel: 'CASH', amount: 100, allocs: [] })).status).toBe(400);
    expect(
      (await bad({
        settleAccountId: settleAcct['A1'],
        channel: 'CASH',
        amount: 100,
        allocs: [{ billId: bill['B2'], amount: 50 }],
      })).body,
    ).toMatchObject({ code: 'PAYMENT_ALLOC_MISMATCH' });
    expect(
      (await bad({
        settleAccountId: settleAcct['A1'],
        channel: 'CASH',
        amount: 100,
        allocs: [
          { billId: bill['B2'], amount: 50 },
          { billId: bill['B2'], amount: 50 },
        ],
      })).body,
    ).toMatchObject({ code: 'PAYMENT_ALLOC_DUPLICATE' });
    expect(
      (await bad({
        settleAccountId: settleAcct['A1'],
        channel: 'CARD',
        amount: 100,
        allocs: [{ billId: bill['B2'], amount: 100 }],
      })).body,
    ).toMatchObject({ code: 'PAY_CHANNEL_INVALID' });
    expect(
      (await bad({
        settleAccountId: settleAcct['A1'],
        channel: 'CASH',
        amount: 0,
        allocs: [{ billId: bill['B2'], amount: 0 }],
      })).body,
    ).toMatchObject({ code: 'INVALID_AMOUNT' });
    expect(
      (await bad({
        settleAccountId: settleAcct['A1'],
        channel: 'CASH',
        amount: '12.5',
        allocs: [{ billId: bill['B2'], amount: '12.5' }],
      })).body,
    ).toMatchObject({ code: 'INVALID_AMOUNT' });
    // Above 2^53−1 the JSON number cannot represent its cents exactly.
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    expect(
      (await bad({
        settleAccountId: settleAcct['A1'],
        channel: 'CASH',
        amount: unsafe,
        allocs: [{ billId: bill['B2'], amount: unsafe }],
      })).body,
    ).toMatchObject({ code: 'INVALID_AMOUNT' });
    expect(
      (await bad({
        settleAccountId: settleAcct['A1'],
        channel: 'CASH',
        amount: 100,
        allocs: [{ billId: bill['B2'], amount: -100 }],
      })).body,
    ).toMatchObject({ code: 'INVALID_AMOUNT' });
  });

  it('rejects unpayable targets (409/400/404)', async () => {
    // alloc larger than the bill's remaining outstanding (B2 has 5000 left)
    const over = await post('/payments', {
      settleAccountId: settleAcct['A1'],
      channel: 'CASH',
      amount: 5001,
      allocs: [{ billId: bill['B2'], amount: 5001 }],
    });
    expect(over.status).toBe(409);
    expect(over.body).toMatchObject({ code: 'PAYMENT_OVER_ALLOCATION', outstanding: '5000' });

    // PAID bill (B1 was fully covered above)
    const paid = await post('/payments', {
      settleAccountId: settleAcct['A1'],
      channel: 'CASH',
      amount: 100,
      allocs: [{ billId: bill['B1'], amount: 100 }],
    });
    expect(paid.status).toBe(409);
    expect(paid.body).toMatchObject({ code: 'BILL_NOT_PAYABLE', status: 'PAID' });

    // DRAFT / REVERSED / REVERSAL-kind bills on A6
    for (const [label, status] of [
      ['D6', 'DRAFT'],
      ['R6', 'REVERSED'],
      ['V6', 'POSTED'],
    ] as const) {
      const res = await post('/payments', {
        settleAccountId: settleAcct['A6'],
        channel: 'CASH',
        amount: 100,
        allocs: [{ billId: bill[label], amount: 100 }],
      });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'BILL_NOT_PAYABLE', status });
    }

    // A6's bill targeted through A1's settle account
    const mismatch = await post('/payments', {
      settleAccountId: settleAcct['A1'],
      channel: 'CASH',
      amount: 100,
      allocs: [{ billId: bill['D6'], amount: 100 }],
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body).toMatchObject({ code: 'PAYMENT_BILL_ACCOUNT_MISMATCH' });

    // unknown settle account / unknown bill
    const noSa = await post('/payments', {
      settleAccountId: 'aa12aa12-9999-4999-8999-aa12aa12aa12',
      channel: 'CASH',
      amount: 100,
      allocs: [{ billId: bill['B2'], amount: 100 }],
    });
    expect(noSa.status).toBe(404);
    expect(noSa.body).toMatchObject({ code: 'SETTLE_ACCOUNT_NOT_FOUND' });
    const noBill = await post('/payments', {
      settleAccountId: settleAcct['A1'],
      channel: 'CASH',
      amount: 100,
      allocs: [{ billId: 'aa12aa12-9999-4999-8999-aa12aa12aa12', amount: 100 }],
    });
    expect(noBill.status).toBe(404);
    expect(noBill.body).toMatchObject({ code: 'BILL_NOT_FOUND' });
  });

  it('Idempotency-Key replays the identical payment; a different payload under the same key → 409', async () => {
    const key = `t12-pay-${RUN}`;
    const body = {
      settleAccountId: settleAcct['A2'],
      channel: 'TRANSFER',
      amount: 1000,
      allocs: [{ billId: bill['B3b'], amount: 1000 }],
    };
    const first = await request(app.getHttpServer())
      .post('/payments')
      .set(auth(adminToken))
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    pay['P-idem'] = first.body.id;

    const replay = await request(app.getHttpServer())
      .post('/payments')
      .set(auth(adminToken))
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    expect(replay.body.id).toBe(first.body.id);
    expect(replay.body.paymentNo).toBe(first.body.paymentNo);
    expect(replay.body.receipt.receiptNo).toBe(first.body.receipt.receiptNo);

    const conflict = await request(app.getHttpServer())
      .post('/payments')
      .set(auth(adminToken))
      .set('Idempotency-Key', key)
      .send({ ...body, amount: 500, allocs: [{ billId: bill['B3b'], amount: 500 }] })
      .expect(409);
    expect(conflict.body).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
    });

    // The replay did not double-apply: B3b still carries exactly 1000 paid.
    const out = (await get(`/water-accounts/${acct['A2']}/outstanding`)).body;
    const b3b = out.items.find((i: { billId: string }) => i.billId === bill['B3b']);
    expect(b3b).toMatchObject({ paidAmount: '1000', outstanding: '1000' });
  });
});

describe('POST /payments/:id/reverse — append-only reversal', () => {
  it('reverse keeps the original RECEIVED, lands a negative RECEIVED reversal, rolls the bill back, voids the receipt', async () => {
    const res = await post('/payments', {
      settleAccountId: settleAcct['A2'],
      channel: 'POS',
      amount: 6000,
      allocs: [{ billId: bill['B3'], amount: 6000 }],
    }).expect(201);
    pay['P2'] = res.body.id;
    receipt['P2'] = res.body.receipt.id;
    expect((await get(`/bills/${bill['B3']}`)).body.status).toBe('PAID');

    const rev = await post(`/payments/${pay['P2']}/reverse`, {}).expect(201);
    pay['P2-rev'] = rev.body.id;
    expect(rev.body).toMatchObject({
      amount: '-6000',
      channel: 'POS',
      status: 'RECEIVED',
      reversalOfId: pay['P2'],
      settleAccountId: settleAcct['A2'],
      cashierId: STAFF_ADMIN_A,
    });
    expect(rev.body.paymentNo).toMatch(/^P\d{12}$/);
    expect(rev.body.paymentNo).not.toBe(res.body.paymentNo);
    expect(rev.body.receipt).toBeNull(); // a reversal documents a refund, not a sale
    expect(rev.body.allocs).toHaveLength(1);
    expect(rev.body.allocs[0]).toMatchObject({ billId: bill['B3'], amount: '-6000' });

    // The ORIGINAL is never flipped — it still nets inside its own close.
    const original = (await get(`/payments/${pay['P2']}`)).body;
    expect(original.status).toBe('RECEIVED');
    expect(original.receipt.voidFlag).toBe(true);

    // The bill's outstanding fully recovered.
    expect((await get(`/bills/${bill['B3']}`)).body.status).toBe('POSTED');

    // A voided receipt can never print.
    const print = await post(`/receipts/${receipt['P2']}/print`, {});
    expect(print.status).toBe(409);
    expect(print.body).toMatchObject({ code: 'RECEIPT_VOID' });
  });

  it('double-reverse → 409 PAYMENT_ALREADY_REVERSED; reversing a reversal → 400', async () => {
    const again = await post(`/payments/${pay['P2']}/reverse`, {});
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({
      code: 'PAYMENT_ALREADY_REVERSED',
      reversalPaymentId: pay['P2-rev'],
    });

    const revOfRev = await post(`/payments/${pay['P2-rev']}/reverse`, {});
    expect(revOfRev.status).toBe(400);
    expect(revOfRev.body).toMatchObject({ code: 'PAYMENT_NOT_REVERSABLE' });
  });

  it('a different cashier\'s reversal is attributed to the ORIGINAL cashier\'s drawer', async () => {
    // The cashier reverses an ADMIN payment — the correction must land
    // in admin's drawer sequence (cashierId/orgUnitId copied from the
    // original) so the +/− pair nets inside one cashier's closes.
    const rev = await post(`/payments/${pay['P-idem']}/reverse`, {}, cashierToken).expect(201);
    expect(rev.body).toMatchObject({
      cashierId: STAFF_ADMIN_A,
      orgUnitId: ORG_A,
      channel: 'TRANSFER',
      amount: '-1000',
      reversalOfId: pay['P-idem'],
      status: 'RECEIVED',
    });
    // It is the original cashier's pending line, not the actor's.
    const mine = (
      await get(`/payments?cashierId=${STAFF_CASHIER_A}`, cashierToken)
    ).body;
    expect(mine.map((p: { id: string }) => p.id)).not.toContain(rev.body.id);
  });

  it('Idempotency-Key on reverse: same payload replays, a different body → 409', async () => {
    const target = await post('/payments', {
      settleAccountId: settleAcct['A2'],
      channel: 'CASH',
      amount: 1000,
      allocs: [{ billId: bill['B3b'], amount: 1000 }],
    }).expect(201);
    const key = `t12-rev-${RUN}`;
    const first = await request(app.getHttpServer())
      .post(`/payments/${target.body.id}/reverse`)
      .set(auth(adminToken))
      .set('Idempotency-Key', key)
      .send({})
      .expect(201);
    const replay = await request(app.getHttpServer())
      .post(`/payments/${target.body.id}/reverse`)
      .set(auth(adminToken))
      .set('Idempotency-Key', key)
      .send({})
      .expect(201);
    expect(replay.body.id).toBe(first.body.id);

    const conflict = await request(app.getHttpServer())
      .post(`/payments/${target.body.id}/reverse`)
      .set(auth(adminToken))
      .set('Idempotency-Key', key)
      .send({ reason: 'different-body' })
      .expect(409);
    expect(conflict.body).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
    });
  });

  it('receipt print sets printed_at and re-print updates it', async () => {
    const p = (await get(`/payments/${pay['P1']}`)).body;
    const first = await post(`/receipts/${p.receipt.id}/print`, {}).expect(201);
    expect(first.body.printedAt).toBeTruthy();
    const again = await post(`/receipts/${p.receipt.id}/print`, {}).expect(201);
    expect(new Date(again.body.printedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(first.body.printedAt).getTime(),
    );
  });
});

describe('cashier day-close', () => {
  it('close sweeps the cashier\'s RECEIVED payments → DAY_CLOSED with per-channel sums', async () => {
    // The cashier pays A3's two bills on two channels.
    const p1 = await post(
      '/payments',
      {
        settleAccountId: settleAcct['A3'],
        channel: 'CASH',
        amount: 4000,
        allocs: [{ billId: bill['B5'], amount: 4000 }],
      },
      cashierToken,
    ).expect(201);
    pay['C1'] = p1.body.id;
    expect(p1.body.cashierId).toBe(STAFF_CASHIER_A);
    const p2 = await post(
      '/payments',
      {
        settleAccountId: settleAcct['A3'],
        channel: 'POS',
        amount: 2500,
        allocs: [{ billId: bill['B6'], amount: 2500 }],
      },
      cashierToken,
    ).expect(201);
    pay['C2'] = p2.body.id;

    const close = await post('/cashier-day-close/close', {}, cashierToken).expect(201);
    pay['CLOSE1'] = close.body.id;
    expect(close.body).toMatchObject({
      cashierId: STAFF_CASHIER_A,
      orgUnitId: ORG_A,
      totalCount: 2,
      totalAmount: '6500',
      status: 'POSTED',
    });
    expect(close.body.byChannel).toEqual({
      CASH: { count: 1, amount: '4000' },
      POS: { count: 1, amount: '2500' },
      TRANSFER: { count: 0, amount: '0' },
    });
    expect(
      close.body.payments.map((p: { id: string }) => p.id).sort(),
    ).toEqual([pay['C1'], pay['C2']].sort());

    // Both payments flipped to DAY_CLOSED and stamped with this close —
    // membership is a stored fact (payment.day_close_id), not a boundary
    // reconstruction.
    for (const pid of [pay['C1'], pay['C2']]) {
      const row = (await get(`/payments/${pid}`)).body;
      expect(row.status).toBe('DAY_CLOSED');
      expect(row.dayCloseId).toBe(pay['CLOSE1']);
    }

    // List + detail: the close's payment membership is exact.
    const list = (await get(`/cashier-day-close?cashierId=${STAFF_CASHIER_A}`, cashierToken)).body;
    expect(list.map((c: { id: string }) => c.id)).toEqual([pay['CLOSE1']]);
    const detail = (await get(`/cashier-day-close/${pay['CLOSE1']}`, cashierToken)).body;
    expect(
      detail.payments.map((p: { id: string }) => p.id).sort(),
    ).toEqual([pay['C1'], pay['C2']].sort());
  });

  it('a second close for the same (cashier, date) → 409; nothing pending → 409 EMPTY', async () => {
    const dup = await post('/cashier-day-close/close', {}, cashierToken);
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({
      code: 'DAY_CLOSE_EXISTS',
      cashierDayCloseId: pay['CLOSE1'],
    });

    // A date with no pending payments (nothing was ever received that long ago).
    const empty = await post('/cashier-day-close/close', { closeDate: '2020-01-01' }, cashierToken);
    expect(empty.status).toBe(409);
    expect(empty.body).toMatchObject({ code: 'DAY_CLOSE_EMPTY' });
  });

  it('post-close reversal stays out of the sealed close and is swept by the NEXT close as a negative line', async () => {
    const rev = await post(`/payments/${pay['C1']}/reverse`, {}, cashierToken).expect(201);
    pay['C1-rev'] = rev.body.id;
    expect(rev.body.amount).toBe('-4000');

    // The original stays DAY_CLOSED — the signed close is immutable.
    expect((await get(`/payments/${pay['C1']}`)).body.status).toBe('DAY_CLOSED');
    expect((await get(`/payments/${pay['C1-rev']}`)).body.status).toBe('RECEIVED');

    // Today's close exists, so the same-date close is refused; the
    // reversal rolls forward into the next operating date's close.
    const sameDay = await post('/cashier-day-close/close', {}, cashierToken);
    expect(sameDay.status).toBe(409);
    expect(sameDay.body).toMatchObject({ code: 'DAY_CLOSE_EXISTS' });

    const next = await post('/cashier-day-close/close', { closeDate: tomorrow() }, cashierToken).expect(201);
    pay['CLOSE2'] = next.body.id;
    expect(next.body).toMatchObject({ totalCount: 1, totalAmount: '-4000' });
    expect(next.body.byChannel.CASH).toEqual({ count: 1, amount: '-4000' });
    expect(next.body.payments.map((p: { id: string }) => p.id)).toEqual([pay['C1-rev']]);
    const revRow = (await get(`/payments/${pay['C1-rev']}`)).body;
    expect(revRow.status).toBe('DAY_CLOSED');
    expect(revRow.dayCloseId).toBe(pay['CLOSE2']);
    // The originals' stored membership still points at the first close.
    expect((await get(`/payments/${pay['C1']}`)).body.dayCloseId).toBe(pay['CLOSE1']);

    // Membership reconstruction: the first close still shows exactly its
    // own two payments — the reversal does NOT leak backwards.
    const first = (await get(`/cashier-day-close/${pay['CLOSE1']}`, cashierToken)).body;
    expect(first.payments.map((p: { id: string }) => p.id).sort()).toEqual(
      [pay['C1'], pay['C2']].sort(),
    );
    const second = (await get(`/cashier-day-close/${pay['CLOSE2']}`, cashierToken)).body;
    expect(second.payments.map((p: { id: string }) => p.id)).toEqual([pay['C1-rev']]);
  });
});

describe('getOutstanding ↔ close-account after payment', () => {
  it('partial pay still blocks, a remaining DRAFT still blocks, fully clear → closes', async () => {
    // A4: POSTED 8000 + DRAFT 3000 → outstanding 11000.
    const blocked = await post(`/water-accounts/${acct['A4']}/close`, {});
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ outstanding: '11000' });

    await post('/payments', {
      settleAccountId: settleAcct['A4'],
      channel: 'CASH',
      amount: 3000,
      allocs: [{ billId: bill['B7'], amount: 3000 }],
    }).expect(201);
    const partial = await post(`/water-accounts/${acct['A4']}/close`, {});
    expect(partial.status).toBe(409);
    expect(partial.body).toMatchObject({ outstanding: '8000' }); // 5000 left + 3000 draft

    await post('/payments', {
      settleAccountId: settleAcct['A4'],
      channel: 'CASH',
      amount: 5000,
      allocs: [{ billId: bill['B7'], amount: 5000 }],
    }).expect(201);
    // B7 is PAID now — the DRAFT bill alone keeps the account unclosable.
    const draftBlocks = await post(`/water-accounts/${acct['A4']}/close`, {});
    expect(draftBlocks.status).toBe(409);
    expect(draftBlocks.body).toMatchObject({ outstanding: '3000' });

    await owner.query(`DELETE FROM bill WHERE id = $1`, [bill['D4']]);
    const ok = await post(`/water-accounts/${acct['A4']}/close`, {}).expect(201);
    expect(ok.body.status).toBe('CLOSED');
  });

  it('a bill reversed after payment turns the applied money into a blocking credit until the payment is reversed', async () => {
    // A5: pay 2000 of 5000, then the bill is red-flushed (status flip —
    // the REVERSAL-kind mirror would drop out by kind anyway).
    await post('/payments', {
      settleAccountId: settleAcct['A5'],
      channel: 'CASH',
      amount: 2000,
      allocs: [{ billId: bill['B8'], amount: 2000 }],
    }).expect(201);
    pay['P5'] = (await get(`/payments?settleAccountId=${settleAcct['A5']}`)).body[0].id;

    await owner.query(`UPDATE bill SET status = 'REVERSED' WHERE id = $1`, [bill['B8']]);
    const credit = await post(`/water-accounts/${acct['A5']}/close`, {});
    expect(credit.status).toBe(409);
    // The orphan alloc survives as −2000: the customer prepaid on a
    // voided debt and is owed a refund — the close must not wave through.
    expect(credit.body).toMatchObject({ outstanding: '-2000' });

    await post(`/payments/${pay['P5']}/reverse`, {}).expect(201);
    const ok = await post(`/water-accounts/${acct['A5']}/close`, {}).expect(201);
    expect(ok.body.status).toBe('CLOSED');
  });
});

describe('review: probe credit surface + closed-account reversal guard', () => {
  it('probe: a paid-then-replaced bill exposes reversedBillCredit and nets the total', async () => {
    // A8 + a FIXED-fee plan so the seeded bill carries a real
    // tariff_plan_id for /bills/:id/replace to reprice against.
    await onboard('A8');
    const fixedItem = (
      await post('/fee-items', { code: `FIX12-${RUN}`, name: '定额费', calcType: 'FIXED' }).expect(201)
    ).body.id;
    const plan = await post('/tariff-plans', {
      code: `PLAN12-${RUN}`,
      name: 'T12 定额价',
      usageCategory: 'RESIDENTIAL',
      effectiveFrom: '2026-01-01',
      tiers: [{ feeItemId: fixedItem, tierNo: 1, fromQty: 0, toQty: null, unitPrice: '80' }],
    }).expect(201);
    await post(`/tariff-plans/${plan.body.id}/activate`, {}).expect(201);
    // 8000 POSTED NORMAL carrying the plan; pay 6000 → PARTIAL_PAID.
    await seedBill('B10', acct['A8'], settleAcct['A8'], '202606', {
      totalAmount: 8000,
    });
    await owner.query(`UPDATE bill SET tariff_plan_id = $2 WHERE id = $1`, [
      bill['B10'],
      plan.body.id,
    ]);
    const p = await post('/payments', {
      settleAccountId: settleAcct['A8'],
      channel: 'CASH',
      amount: 6000,
      allocs: [{ billId: bill['B10'], amount: 6000 }],
    }).expect(201);
    pay['P10'] = p.body.id;
    expect((await get(`/bills/${bill['B10']}`)).body.status).toBe('PARTIAL_PAID');

    // Replace red-flushes the original; its 6000 of applied money survives
    // as allocs on a REVERSED bill — a customer credit, not a vanished fact.
    const repl = await post(`/bills/${bill['B10']}/replace`, { usageQty: 1 }).expect(201);
    expect((await get(`/bills/${bill['B10']}`)).body.status).toBe('REVERSED');
    expect(repl.body.billKind).toBe('REPLACEMENT');
    expect(repl.body.totalAmount).toBe('8000'); // FIXED reprices flat

    const probe = (await get(`/water-accounts/${acct['A8']}/outstanding`)).body;
    expect(probe.items).toHaveLength(1);
    expect(probe.items[0]).toMatchObject({
      billId: repl.body.id,
      billKind: 'REPLACEMENT',
      outstanding: '8000',
    });
    expect(probe.reversedBillCredit).toBe('6000');
    expect(probe.totalOutstanding).toBe('2000');
    // The FinancePort agrees — close sees the same net position.
    const blocked = await post(`/water-accounts/${acct['A8']}/close`, {});
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ outstanding: '2000' });

    // Reversing the payment refunds the credit: allocs net to zero and the
    // replacement's full 8000 is the only remaining debt.
    await post(`/payments/${pay['P10']}/reverse`, {}).expect(201);
    const after = (await get(`/water-accounts/${acct['A8']}/outstanding`)).body;
    expect(after.reversedBillCredit).toBe('0');
    expect(after.totalOutstanding).toBe('8000');
  });

  it('a reversal that would resurrect debt on a CLOSED account → 409 PAYMENT_ACCOUNT_CLOSED', async () => {
    await onboard('A9');
    await seedBill('B11', acct['A9'], settleAcct['A9'], '202606', { totalAmount: 3000 });
    const p = await post('/payments', {
      settleAccountId: settleAcct['A9'],
      channel: 'CASH',
      amount: 3000,
      allocs: [{ billId: bill['B11'], amount: 3000 }],
    }).expect(201);
    pay['P11'] = p.body.id;
    const closed = await post(`/water-accounts/${acct['A9']}/close`, {}).expect(201);
    expect(closed.body.status).toBe('CLOSED');

    const rev = await post(`/payments/${pay['P11']}/reverse`, {});
    expect(rev.status).toBe(409);
    expect(rev.body).toMatchObject({ code: 'PAYMENT_ACCOUNT_CLOSED' });

    // Nothing was written: the original is untouched and no reversal exists.
    const original = (await get(`/payments/${pay['P11']}`)).body;
    expect(original.status).toBe('RECEIVED');
    const list = (await get(`/payments?settleAccountId=${settleAcct['A9']}`)).body;
    expect(list.map((x: { id: string }) => x.id)).toEqual([pay['P11']]);
  });
});

describe('tenant isolation + permissions + org scope', () => {
  it('tenant B sees nothing and cannot touch tenant A documents', async () => {
    expect((await get('/payments', tenantBToken)).body).toEqual([]);
    await get(`/payments/${pay['P1']}`, tenantBToken, 404);
    await get(`/water-accounts/${acct['A1']}/outstanding`, tenantBToken, 404);
    const pay_ = await post(
      '/payments',
      {
        settleAccountId: settleAcct['A1'],
        channel: 'CASH',
        amount: 100,
        allocs: [{ billId: bill['B2'], amount: 100 }],
      },
      tenantBToken,
    );
    expect(pay_.status).toBe(404); // settle account is not visible across tenants
    const rev = await post(`/payments/${pay['P1']}/reverse`, {}, tenantBToken);
    expect(rev.status).toBe(404);
    const print = await post(`/receipts/${receipt['P1']}/print`, {}, tenantBToken);
    expect(print.status).toBe(404);
  });

  it('payment:read holder reads but cannot write (403 PERMISSION_DENIED)', async () => {
    await get('/payments', readerToken);
    await get(`/payments/${pay['P1']}`, readerToken);
    await get(`/water-accounts/${acct['A1']}/outstanding`, readerToken);
    const c = await post(
      '/payments',
      {
        settleAccountId: settleAcct['A1'],
        channel: 'CASH',
        amount: 100,
        allocs: [{ billId: bill['B2'], amount: 100 }],
      },
      readerToken,
    );
    expect(c.status).toBe(403);
    expect(c.body).toMatchObject({ code: 'PERMISSION_DENIED' });
    const close = await post('/cashier-day-close/close', {}, readerToken);
    expect(close.status).toBe(403);
    const print = await post(`/receipts/${receipt['P1']}/print`, {}, readerToken);
    expect(print.status).toBe(403);
  });

  it('a scoped payment:write holder is 403 on an out-of-scope settle account, permissive on an unbound one', async () => {
    // Bind A7 to a reading book under ORG_A via a plan item — ORG_A2's
    // subtree does not contain ORG_A (same fixture pattern as billing).
    const bookId = 'aa12aa12-0000-4000-8000-00000000b001';
    const planId = 'aa12aa12-0000-4000-8000-00000000b002';
    await owner.query(
      `INSERT INTO reading_book (id, tenant_id, org_unit_id, book_no, name, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 't12 scope book', now(), now()) ON CONFLICT DO NOTHING`,
      [bookId, T12A, ORG_A, `T12B-${RUN}`],
    );
    await owner.query(
      `INSERT INTO reading_plan (id, tenant_id, book_id, period, plan_date, status, created_at, updated_at)
       VALUES ($1, $2, $3, '202606', '2026-06-01', 'DONE', now(), now()) ON CONFLICT DO NOTHING`,
      [planId, T12A, bookId],
    );
    await owner.query(
      `INSERT INTO reading_plan_item (id, tenant_id, plan_id, water_account_id, seq_no, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 1, 'PENDING', now(), now()) ON CONFLICT DO NOTHING`,
      [T12A, planId, acct['A7']],
    );

    const denied = await post(
      '/payments',
      {
        settleAccountId: settleAcct['A7'],
        channel: 'CASH',
        amount: 1500,
        allocs: [{ billId: bill['B9'], amount: 1500 }],
      },
      scopedToken,
    );
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: 'ORG_OUT_OF_SCOPE' });

    // The admin (ALL scope) pays the scoped-out account normally — the
    // reverse below needs an out-of-scope payment to aim at.
    const admin = await post('/payments', {
      settleAccountId: settleAcct['A7'],
      channel: 'CASH',
      amount: 1500,
      allocs: [{ billId: bill['B9'], amount: 1500 }],
    });
    expect(admin.status).toBe(201);
    pay['P9'] = admin.body.id;

    // The same settle-account scope guard protects reverse.
    const deniedReverse = await post(`/payments/${pay['P9']}/reverse`, {}, scopedToken);
    expect(deniedReverse.status).toBe(403);
    expect(deniedReverse.body).toMatchObject({ code: 'ORG_OUT_OF_SCOPE' });

    // An account bound to no reading plan has no org anchor — the same
    // permissive carve-out as billing's single-bill mutations.
    const ok = await post(
      '/payments',
      {
        settleAccountId: settleAcct['A1'],
        channel: 'CASH',
        amount: 5000,
        allocs: [{ billId: bill['B2'], amount: 5000 }],
      },
      scopedToken,
    );
    expect(ok.status).toBe(201);
  });
});
