/**
 * Billing run + bill lifecycle e2e against `watersaas_test` — fixtures
 * carry the `t10-` prefix. Boots the real AppModule so JWT/permission
 * guards, tenant ALS and RLS all apply.
 *
 * Covers (Task-10 brief assertions):
 *  1. POST /billing-runs {period} → DRAFT run + one DRAFT bill per FINAL
 *     settlement; tiered engine math verified on bill_item rows +
 *     totalAmount cents (ytd ladder cursor included); unbillable
 *     settlement (no ACTIVE tariff) → failed_settlement_ids, no bill
 *  2. already-billed settlement → skipped, no duplicate bill (unique
 *     (tenant, source_type, source_id, bill_kind)); Idempotency-Key
 *     replays create
 *  3. post → per-bill tx → PARTIAL when a generation failure remains;
 *     fixing the tariff + retry → POSTED (重跑失败户); re-post → 409
 *  4. discard removes a DRAFT run + its DRAFT bills, period re-runnable;
 *     discard on a posted run → 409
 *  5. reverse → original REVERSED + negative REVERSAL bill (ADJUSTMENT
 *     items); second reverse → 409; PAID/DRAFT/REVERSAL-kind → 409
 *  6. replace → original REVERSED + POSTED REPLACEMENT recomputed on the
 *     original plan with the supplied usageQty; missing usageQty → 400
 *  7. tenant B sees nothing; billing:read reads but cannot write
 *  8. getOutstanding → close-account: POSTED bill blocks close (409),
 *     PAID + reversal-pair netting → close succeeds
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

// ---- fixtures (all prefixed t10-) ----
const T10A = 'aa10aa10-1010-4010-8010-aa10aa10aa10'; // tenant A
const T10B = 'bb10bb10-2020-4020-8020-bb10bb10bb10'; // tenant B (isolation)
const ORG_A = 'aa10aa10-0000-4000-8000-0000000000c0';
const ORG_B = 'bb10bb10-0000-4000-8000-0000000000c0';
const ROLE_ADMIN_A = 'aa10aa10-0000-4000-8000-00000000ad01';
const ROLE_READER_A = 'aa10aa10-0000-4000-8000-000000001e01';
const ROLE_B_ADMIN = 'bb10bb10-0000-4000-8000-00000000ad01';
const PERM_BILL_READ = 'aa10aa10-0000-4000-8000-00000000e801';
const STAFF_ADMIN_A = 'aa10aa10-0000-4000-8000-0000000a0001';
const STAFF_READER_A = 'aa10aa10-0000-4000-8000-0000000b0002';
const STAFF_B_ADMIN = 'bb10bb10-0000-4000-8000-0000000a0001';

const owner = new pg.Client({ connectionString: OWNER_URL });
let app: INestApplication<App>;
let adminToken = '';
let readerToken = '';
let tenantBToken = '';

// ids populated by the sequential suite
let waterItem = ''; // fee_item WATER-* (PER_QTY)
let fixedItem = ''; // fee_item FIXED-* (FIXED)
let planRes = ''; // ACTIVE RESIDENTIAL plan
let planUc2 = ''; // UC2 plan, activated mid-suite for the retry test
const acct: Record<string, string> = {}; // A1/A2 water_account ids
const settleAcct: Record<string, string> = {};
const settle: Record<string, string> = {}; // label → settlement id
const run: Record<string, string> = {}; // label → billing_run id
const bill: Record<string, string> = {}; // label → bill id

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

// Run-scoped suffix: the test DB keeps rows between runs, so business
// codes/categories differ per run.
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
// SPECIAL is the controlled category this suite leaves plan-less until
// the retry test creates+activates one (was a run-scoped free-form value
// before the v0.2 controlled-category contract).
const UC2 = 'SPECIAL';

const post = (path: string, body: unknown, token = adminToken) =>
  request(app.getHttpServer()).post(path).set(auth(token)).send(body);

const get = (path: string, token = adminToken, status = 200) =>
  request(app.getHttpServer()).get(path).set(auth(token)).expect(status);

const onboard = async (label: string, usageCategory: string) => {
  const res = await post('/water-accounts/onboard', {
    customer: { name: `T10 ${label} ${RUN}`, custType: 'PERSONAL' },
    account: { usageCategory, addr: `${label} Water St` },
    meter: { brand: 't10-brand', caliber: 'DN15' },
    installation: { initialReading: 0, installedAt: '2026-01-01' },
  }).expect(201);
  acct[label] = res.body.waterAccount.id;
  settleAcct[label] = res.body.settleAccount.id;
  return res.body;
};

/** Insert a FINAL consumption_settlement directly (billing only consumes
 * FINAL rows — settlement generation is Task-7-covered). */
const seedSettlement = async (
  label: string,
  waterAccountId: string,
  period: string,
  usage: number,
  isEstimated = false,
) => {
  const row = (
    await owner.query(
      `INSERT INTO consumption_settlement
         (id, tenant_id, water_account_id, period, total_usage_qty, is_estimated,
          estimate_method, estimate_reason, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, 'FINAL', now(), now())
       RETURNING id::text AS id`,
      [
        T10A,
        waterAccountId,
        period,
        usage,
        isEstimated,
        isEstimated ? 'MANUAL' : null,
        isEstimated ? 't10-estimate' : null,
      ],
    )
  ).rows[0];
  settle[label] = row.id;
  return row.id;
};

/** Insert a POSTED NORMAL bill sourced from a settlement (prior history). */
const seedPostedBill = async (
  waterAccountId: string,
  settleAccountId: string,
  period: string,
  sourceSettlementId: string,
  tariffPlanId: string,
  totalAmount: number,
  status = 'POSTED',
) => {
  const row = (
    await owner.query(
      `INSERT INTO bill (id, tenant_id, settle_account_id, water_account_id, period,
                         bill_kind, source_type, source_id, tariff_plan_id, status,
                         is_estimated, total_amount, issued_at, due_date,
                         created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'NORMAL', 'SETTLEMENT', $5, $6,
               $7, false, $8, now(), '2026-07-15', now(), now())
       RETURNING id::text AS id`,
      [T10A, settleAccountId, waterAccountId, period, sourceSettlementId, tariffPlanId, status, totalAmount],
    )
  ).rows[0];
  return row.id as string;
};

const billDetail = async (id: string) =>
  (await get(`/bills/${id}`)).body as {
    id: string;
    status: string;
    billKind: string;
    sourceType: string;
    sourceId: string;
    totalAmount: string;
    tariffPlanId: string | null;
    issuedAt: string | null;
    dueDate: string | null;
    items: {
      feeItemId: string | null;
      itemType: string;
      description: string | null;
      qty: string | null;
      unitPrice: string | null;
      amount: string;
    }[];
  };

beforeAll(async () => {
  await owner.connect();
  const hash = await bcrypt.hash('t10-pass', 10);

  await owner.query(
    `INSERT INTO tenant (id, code, name, status, created_at, updated_at)
     VALUES ($1, 't10-water', 'T10 Water', 'ACTIVE', now(), now()),
            ($2, 't10-other', 'T10 Other', 'ACTIVE', now(), now())
     ON CONFLICT DO NOTHING`,
    [T10A, T10B],
  );
  await owner.query(
    `INSERT INTO org_unit (id, tenant_id, parent_id, name, type, created_at, updated_at)
     VALUES ($1, $2, NULL, 'T10 Company', 'COMPANY', now(), now()),
            ($3, $4, NULL, 'T10B Company', 'COMPANY', now(), now())
     ON CONFLICT DO NOTHING`,
    [ORG_A, T10A, ORG_B, T10B],
  );
  await owner.query(
    `INSERT INTO role (id, tenant_id, code, name, data_scope, created_at, updated_at)
     VALUES ($1, $3, 'admin', 'T10 Admin', 'ALL', now(), now()),
            ($2, $3, 't10-reader', 'T10 Billing Reader', 'ORG_SUBTREE', now(), now()),
            ($4, $5, 'admin', 'T10B Admin', 'ALL', now(), now())
     ON CONFLICT DO NOTHING`,
    [ROLE_ADMIN_A, ROLE_READER_A, T10A, ROLE_B_ADMIN, T10B],
  );
  await owner.query(
    `INSERT INTO permission (id, tenant_id, code, type, created_at, updated_at)
     VALUES ($1, $2, 'billing:read', 'ACTION', now(), now())
     ON CONFLICT DO NOTHING`,
    [PERM_BILL_READ, T10A],
  );
  await owner.query(
    `INSERT INTO role_permission (tenant_id, role_id, permission_id, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now()) ON CONFLICT DO NOTHING`,
    [T10A, ROLE_READER_A, PERM_BILL_READ],
  );
  await owner.query(
    `INSERT INTO staff (id, tenant_id, org_unit_id, login, password_hash, name, status, created_at, updated_at)
     VALUES ($1, $4, $6, 't10-admin',   $7, 'T10 Admin',   'ACTIVE', now(), now()),
            ($2, $4, $6, 't10-reader',  $7, 'T10 Reader',  'ACTIVE', now(), now()),
            ($3, $5, $8, 't10b-admin',  $7, 'T10B Admin',  'ACTIVE', now(), now())
     ON CONFLICT (tenant_id, login) DO NOTHING`,
    [STAFF_ADMIN_A, STAFF_READER_A, STAFF_B_ADMIN, T10A, T10B, ORG_A, hash, ORG_B],
  );
  await owner.query(
    `INSERT INTO staff_role (tenant_id, staff_id, role_id, created_at, updated_at)
     VALUES ($1, $2, $4, now(), now()),
            ($1, $3, $5, now(), now()),
            ($6, $7, $8, now(), now())
     ON CONFLICT DO NOTHING`,
    [T10A, STAFF_ADMIN_A, STAFF_READER_A, ROLE_ADMIN_A, ROLE_READER_A, T10B, STAFF_B_ADMIN, ROLE_B_ADMIN],
  );

  // The test DB persists between runs and a billing run aggregates ALL
  // FINAL settlements of a period — stale t10 fixtures would corrupt the
  // run counters. Wipe tenant A's business tables (FK-safe order); iam
  // fixtures above are idempotent and stay.
  for (const table of [
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
    await owner.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [T10A]);
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
        .send({ tenantCode, login: login_, password: 't10-pass' })
        .expect(201)
    ).body.accessToken as string;
  adminToken = await login('t10-water', 't10-admin');
  readerToken = await login('t10-water', 't10-reader');
  tenantBToken = await login('t10-other', 't10b-admin');
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

describe('fixtures: fee items + plan + accounts + settlements', () => {
  it('creates WATER (PER_QTY) + FIXED fee items and the ACTIVE RESIDENTIAL plan', async () => {
    waterItem = (
      await post('/fee-items', { code: `WATER-${RUN}`, name: '水费', calcType: 'PER_QTY' }).expect(201)
    ).body.id;
    fixedItem = (
      await post('/fee-items', { code: `FIXED-${RUN}`, name: '定额费', calcType: 'FIXED' }).expect(201)
    ).body.id;

    const plan = await post('/tariff-plans', {
      code: `RES-${RUN}`,
      name: '居民水价',
      usageCategory: 'RES_METERED',
      effectiveFrom: '2026-01-01',
      tiers: [
        { feeItemId: waterItem, tierNo: 1, fromQty: 0, toQty: 180, unitPrice: '3.0' },
        { feeItemId: waterItem, tierNo: 2, fromQty: 180, toQty: null, unitPrice: '4.5' },
        { feeItemId: fixedItem, tierNo: 1, fromQty: 0, toQty: null, unitPrice: '10' },
      ],
    }).expect(201);
    planRes = plan.body.id;
    await post(`/tariff-plans/${planRes}/activate`, {}).expect(201);
  });

  it('onboards A1 (RESIDENTIAL) + A2 (no-plan category) and seeds FINAL settlements', async () => {
    await onboard('A1', 'RES_METERED');
    await onboard('A2', UC2);

    // A1: 202606 usage 100 (billed POSTED below), 202607 usage 200
    // (estimated — flag must inherit to the bill), 202612 usage 10.
    await seedSettlement('A1-06', acct['A1'], '202606', 100);
    await seedSettlement('A1-07', acct['A1'], '202607', 200, true);
    await seedSettlement('A1-12', acct['A1'], '202612', 10);
    // A2: 202607 usage 30 — unbillable until a UC2 plan exists.
    await seedSettlement('A2-07', acct['A2'], '202607', 30);

    // Prior-year-cursor history: a POSTED bill on the 202606 settlement.
    // 100 × 3.0 + 10 = 310.00 → 31000¢.
    bill['A1-06'] = await seedPostedBill(
      acct['A1'],
      settleAcct['A1'],
      '202606',
      settle['A1-06'],
      planRes,
      31000,
    );
  });
});

describe('POST /billing-runs — DRAFT generation', () => {
  it('generates a DRAFT bill per FINAL settlement; unbillable A2 lands in failed_settlement_ids', async () => {
    const res = await post('/billing-runs', { period: '202607' }).expect(201);
    run['r1'] = res.body.id;
    expect(res.body).toMatchObject({
      period: '202607',
      runType: 'MANUAL',
      status: 'DRAFT',
      totalCount: 2,
      successCount: 0,
      failedCount: 1,
    });
    expect(res.body.failedSettlementIds).toEqual([
      expect.objectContaining({
        settlementId: settle['A2-07'],
        stage: 'generate',
        code: 'TARIFF_NOT_FOUND',
      }),
    ]);
    expect(res.body.bills).toHaveLength(1);

    const b = res.body.bills[0];
    bill['A1-07'] = b.id;
    expect(b).toMatchObject({
      billingRunId: run['r1'],
      settleAccountId: settleAcct['A1'],
      waterAccountId: acct['A1'],
      period: '202607',
      billKind: 'NORMAL',
      sourceType: 'SETTLEMENT',
      sourceId: settle['A1-07'],
      tariffPlanId: planRes,
      status: 'DRAFT',
      isEstimated: true, // inherited from the settlement
      totalAmount: '79000',
      issuedAt: null,
    });
    // due_date = period last day (2026-07-31) + bill_due_days (default 15).
    expect((b.dueDate as string).slice(0, 10)).toBe('2026-08-15');

    // Engine math on bill_item rows: ytd cursor 100 (the POSTED 202606
    // bill) → tier1 cap 80 @3.0, remaining 120 @4.5, FIXED 10.
    const detail = await billDetail(b.id);
    expect(detail.items).toHaveLength(3);
    const water = detail.items
      .filter((i) => i.feeItemId === waterItem)
      .map((i) => ({ qty: i.qty, unitPrice: i.unitPrice, amount: i.amount }))
      .sort((a, b) => Number(a.unitPrice) - Number(b.unitPrice));
    const fixed = detail.items.filter((i) => i.feeItemId === fixedItem);
    expect(water).toEqual([
      { qty: '80', unitPrice: '3', amount: '24000' },
      { qty: '120', unitPrice: '4.5', amount: '54000' },
    ]);
    expect(fixed).toHaveLength(1);
    expect(fixed[0].amount).toBe('1000');
    expect(detail.items.every((i) => i.itemType === 'NORMAL')).toBe(true);
  });

  it('a second run on the same period skips already-billed settlements — no duplicate bill', async () => {
    const res = await post('/billing-runs', { period: '202607' }).expect(201);
    run['r2'] = res.body.id;
    // A1 already billed (run1's DRAFT bill exists) → success; A2 still fails.
    expect(res.body).toMatchObject({
      status: 'DRAFT',
      totalCount: 2,
      successCount: 1,
      failedCount: 1,
    });
    expect(res.body.bills).toHaveLength(0);

    const bills = (await get(`/bills?period=202607&waterAccountId=${acct['A1']}`)).body;
    expect(bills).toHaveLength(1);
    expect(bills[0].id).toBe(bill['A1-07']);
  });

  it('discard removes the DRAFT run; GET endpoints read the surviving run + bills', async () => {
    await post(`/billing-runs/${run['r2']}/discard`, {}).expect(201);
    await get(`/billing-runs/${run['r2']}`, adminToken, 404);

    const list = (await get('/billing-runs?period=202607')).body;
    expect(list.map((r: { id: string }) => r.id)).toEqual([run['r1']]);
    const detail = (await get(`/billing-runs/${run['r1']}`)).body;
    expect(detail.bills.map((b: { id: string }) => b.id)).toEqual([bill['A1-07']]);
  });

  it('Idempotency-Key replays create; a different body under the same key → 409', async () => {
    const key = `t10-run-${RUN}`;
    const first = await request(app.getHttpServer())
      .post('/billing-runs')
      .set(auth(adminToken))
      .set('Idempotency-Key', key)
      .send({ period: '202701' }) // no settlements — empty run
      .expect(201);
    expect(first.body.totalCount).toBe(0);
    const replay = await request(app.getHttpServer())
      .post('/billing-runs')
      .set(auth(adminToken))
      .set('Idempotency-Key', key)
      .send({ period: '202701' })
      .expect(201);
    expect(replay.body.id).toBe(first.body.id);

    const conflict = await request(app.getHttpServer())
      .post('/billing-runs')
      .set(auth(adminToken))
      .set('Idempotency-Key', key)
      .send({ period: '202702' })
      .expect(409);
    expect(conflict.body).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
    });
    // keep the period clean
    await post(`/billing-runs/${first.body.id}/discard`, {}).expect(201);
  });
});

describe('post → PARTIAL → retry → POSTED', () => {
  it('posts the run: bill flips POSTED with issued_at; the generation failure keeps it PARTIAL', async () => {
    const res = await post(`/billing-runs/${run['r1']}/post`, {}).expect(201);
    expect(res.body).toMatchObject({
      status: 'PARTIAL',
      totalCount: 2,
      successCount: 1,
      failedCount: 1,
      postedAt: null,
    });
    expect(res.body.failedSettlementIds).toEqual([
      expect.objectContaining({ settlementId: settle['A2-07'], code: 'TARIFF_NOT_FOUND' }),
    ]);

    const detail = await billDetail(bill['A1-07']);
    expect(detail.status).toBe('POSTED');
    expect(detail.issuedAt).toBeTruthy();
  });

  it('re-post on PARTIAL re-executes (allowed by the guard) and stays PARTIAL; discard on a live run → 409', async () => {
    // post accepts DRAFT|PARTIAL — on PARTIAL it re-runs the failure
    // pipeline, exactly like retry. A2 is still unbillable → PARTIAL.
    const repost = await post(`/billing-runs/${run['r1']}/post`, {}).expect(201);
    expect(repost.body).toMatchObject({ status: 'PARTIAL', successCount: 1, failedCount: 1 });

    const discard = await post(`/billing-runs/${run['r1']}/discard`, {});
    expect(discard.status).toBe(409);
    expect(discard.body).toMatchObject({ code: 'INVALID_RUN_STATUS_TRANSITION' });

    const retry = await post(`/billing-runs/${run['r1']}/retry`, {}).expect(201);
    expect(retry.body).toMatchObject({ status: 'PARTIAL', successCount: 1, failedCount: 1 });
  });

  it('after activating a UC2 plan, retry re-bills the failed household → POSTED', async () => {
    const plan = await post('/tariff-plans', {
      code: `UC2-${RUN}`,
      name: 'UC2价',
      usageCategory: UC2,
      effectiveFrom: '2026-01-01',
      tiers: [{ feeItemId: waterItem, tierNo: 1, fromQty: 0, toQty: null, unitPrice: '2.0' }],
    }).expect(201);
    planUc2 = plan.body.id;
    await post(`/tariff-plans/${planUc2}/activate`, {}).expect(201);

    const res = await post(`/billing-runs/${run['r1']}/retry`, {}).expect(201);
    expect(res.body).toMatchObject({
      status: 'POSTED',
      totalCount: 2,
      successCount: 2,
      failedCount: 0,
      failedSettlementIds: [],
    });
    expect(res.body.postedAt).toBeTruthy();

    const a2 = (await get(`/bills?period=202607&waterAccountId=${acct['A2']}`)).body;
    expect(a2).toHaveLength(1);
    bill['A2-07'] = a2[0].id;
    expect(a2[0]).toMatchObject({
      status: 'POSTED',
      totalAmount: '6000', // 30 × 2.0
      tariffPlanId: planUc2,
    });
    const detail = await billDetail(a2[0].id);
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0]).toMatchObject({ qty: '30', unitPrice: '2', amount: '6000' });
  });

  it('post / retry / discard on a POSTED run → 409 INVALID_RUN_STATUS_TRANSITION', async () => {
    for (const op of ['post', 'retry', 'discard']) {
      const res = await post(`/billing-runs/${run['r1']}/${op}`, {});
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'INVALID_RUN_STATUS_TRANSITION' });
    }
  });
});

describe('discard + re-run on a fresh period', () => {
  it('DRAFT run discard deletes its DRAFT bills; the period re-runs cleanly', async () => {
    const c = await post('/billing-runs', { period: '202612' }).expect(201);
    run['rC'] = c.body.id;
    expect(c.body.bills).toHaveLength(1);
    // ytd cursor = 100 + 200 (both earlier bills POSTED) → all 10m³ in
    // tier2: 10 × 4.5 + FIXED 10 = 55.00 → 5500¢.
    expect(c.body.bills[0]).toMatchObject({ status: 'DRAFT', totalAmount: '5500' });
    const draftBillId = c.body.bills[0].id;

    const discarded = await post(`/billing-runs/${run['rC']}/discard`, {}).expect(201);
    expect(discarded.body.deletedBillCount).toBe(1);
    await get(`/bills/${draftBillId}`, adminToken, 404);
    await get(`/billing-runs/${run['rC']}`, adminToken, 404);

    const d = await post('/billing-runs', { period: '202612' }).expect(201);
    run['rD'] = d.body.id;
    expect(d.body.bills).toHaveLength(1);
    bill['A1-12'] = d.body.bills[0].id;
    const posted = await post(`/billing-runs/${run['rD']}/post`, {}).expect(201);
    expect(posted.body).toMatchObject({ status: 'POSTED', successCount: 1, failedCount: 0 });
  });
});

describe('reverse （红冲） + replace （重开）', () => {
  it('reverse: original → REVERSED + POSTED REVERSAL with negated ADJUSTMENT items', async () => {
    const res = await post(`/bills/${bill['A1-07']}/reverse`, {}).expect(201);
    bill['A1-07-rev'] = res.body.id;
    expect(res.body).toMatchObject({
      billKind: 'REVERSAL',
      sourceType: 'ORIGINAL_BILL',
      sourceId: bill['A1-07'],
      status: 'POSTED',
      totalAmount: '-79000',
      tariffPlanId: planRes,
    });
    for (const it of res.body.items) {
      expect(it.itemType).toBe('ADJUSTMENT');
      expect(Number(it.amount)).toBeLessThan(0);
      if (it.qty !== null) expect(Number(it.qty)).toBeLessThan(0);
    }
    expect(res.body.items.map((i: { amount: string }) => i.amount).sort()).toEqual(
      ['-1000', '-24000', '-54000'].sort(),
    );

    const original = await billDetail(bill['A1-07']);
    expect(original.status).toBe('REVERSED');
  });

  it('second reverse on the REVERSED original → 409; reversing a REVERSAL bill → 409', async () => {
    const again = await post(`/bills/${bill['A1-07']}/reverse`, {});
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'BILL_NOT_REVERSABLE' });

    const revOfRev = await post(`/bills/${bill['A1-07-rev']}/reverse`, {});
    expect(revOfRev.status).toBe(409);
    expect(revOfRev.body).toMatchObject({ code: 'BILL_NOT_REVERSABLE' });
  });

  it('PAID bill → 409 BILL_NOT_REVERSABLE (refund flow is T12)', async () => {
    await owner.query(`UPDATE bill SET status = 'PAID' WHERE id = $1`, [bill['A1-12']]);
    const res = await post(`/bills/${bill['A1-12']}/reverse`, {});
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'BILL_NOT_REVERSABLE', status: 'PAID' });
  });

  it('DRAFT bill → 409; the run+DRAFT bill discard cleanly afterwards', async () => {
    await seedSettlement('A1-13', acct['A1'], '202611', 5);
    const e = await post('/billing-runs', { period: '202611' }).expect(201);
    run['rE'] = e.body.id;
    const draftBill = e.body.bills[0];
    const res = await post(`/bills/${draftBill.id}/reverse`, {});
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'BILL_NOT_REVERSABLE', status: 'DRAFT' });

    await post(`/billing-runs/${run['rE']}/discard`, {}).expect(201);
    const bills = (await get(`/bills?period=202611`)).body;
    expect(bills).toHaveLength(0);
  });

  it('replace: original → REVERSED + POSTED REPLACEMENT recomputed on the original plan', async () => {
    const missing = await post(`/bills/${bill['A2-07']}/replace`, {});
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ code: 'BILL_USAGE_QTY_REQUIRED' });

    const res = await post(`/bills/${bill['A2-07']}/replace`, { usageQty: '50' }).expect(201);
    bill['A2-07-repl'] = res.body.id;
    expect(res.body).toMatchObject({
      billKind: 'REPLACEMENT',
      sourceType: 'ORIGINAL_BILL',
      sourceId: bill['A2-07'],
      status: 'POSTED',
      totalAmount: '10000', // 50 × 2.0, ytd cursor 0 for A2
      tariffPlanId: planUc2, // repriced on the ORIGINAL bill's plan
    });
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      itemType: 'NORMAL',
      qty: '50',
      unitPrice: '2',
      amount: '10000',
    });
    const original = await billDetail(bill['A2-07']);
    expect(original.status).toBe('REVERSED');
  });

  it('second replace → 409; replace on a REVERSED bill → 409', async () => {
    const again = await post(`/bills/${bill['A2-07']}/replace`, { usageQty: '60' });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'BILL_NOT_REPLACEABLE' });

    const onReversed = await post(`/bills/${bill['A1-07']}/replace`, { usageQty: '60' });
    expect(onReversed.status).toBe(409);
    expect(onReversed.body).toMatchObject({ code: 'BILL_NOT_REPLACEABLE' });
  });
});

describe('tenant isolation + permissions', () => {
  it('tenant B sees no runs/bills and cannot touch tenant A documents', async () => {
    expect((await get('/billing-runs', tenantBToken)).body).toEqual([]);
    expect((await get('/bills', tenantBToken)).body).toEqual([]);
    await get(`/billing-runs/${run['r1']}`, tenantBToken, 404);
    await get(`/bills/${bill['A1-07']}`, tenantBToken, 404);
    const rev = await post(`/bills/${bill['A1-12']}/reverse`, {}, tenantBToken);
    expect(rev.status).toBe(404);
    const rep = await post(`/billing-runs/${run['r1']}/post`, {}, tenantBToken);
    expect(rep.status).toBe(404);
  });

  it('billing:read holder reads but cannot write (403 PERMISSION_DENIED)', async () => {
    await get('/billing-runs', readerToken);
    await get(`/bills/${bill['A1-07']}`, readerToken);
    const c = await post('/billing-runs', { period: '202607' }, readerToken);
    expect(c.status).toBe(403);
    expect(c.body).toMatchObject({ code: 'PERMISSION_DENIED' });
    const rev = await post(`/bills/${bill['A1-12']}/reverse`, {}, readerToken);
    expect(rev.status).toBe(403);
  });
});

describe('getOutstanding → close-account', () => {
  it('a POSTED bill blocks close (409 with the cent amount); clearing it closes the account', async () => {
    // A1's settle account now nets: 202606 POSTED 31000 + 202612 PAID
    // (excluded) + the 202607 reversal pair (REVERSED + REVERSAL-kind → 0).
    const res = await post(`/water-accounts/${acct['A1']}/close`, {});
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'ACCOUNT_OUTSTANDING_BALANCE',
      outstanding: '31000',
    });

    await owner.query(`UPDATE bill SET status = 'PAID' WHERE id = $1`, [bill['A1-06']]);
    const ok = await post(`/water-accounts/${acct['A1']}/close`, {}).expect(201);
    expect(ok.body.status).toBe('CLOSED');
  });
});

describe('review fixes: org scope, close-vs-post, input bounds', () => {
  it('a scoped billing:write holder cannot reverse an out-of-scope bill (403); admin can', async () => {
    // ORG_A2 is a CHILD of ORG_A — its subtree does not contain ORG_A.
    const ORG_A2 = 'aa10aa10-0000-4000-8000-0000000000c2';
    const ROLE_SCOPED = 'aa10aa10-0000-4000-8000-00000000c011';
    const PERM_WRITE = 'aa10aa10-0000-4000-8000-00000000e802';
    const STAFF_SCOPED = 'aa10aa10-0000-4000-8000-0000000c0003';
    await owner.query(
      `INSERT INTO org_unit (id, tenant_id, parent_id, name, type, created_at, updated_at)
       VALUES ($1, $2, $3, 'T10 Branch', 'BRANCH', now(), now()) ON CONFLICT DO NOTHING`,
      [ORG_A2, T10A, ORG_A],
    );
    await owner.query(
      `INSERT INTO permission (id, tenant_id, code, type, created_at, updated_at)
       VALUES ($1, $2, 'billing:write', 'ACTION', now(), now()) ON CONFLICT DO NOTHING`,
      [PERM_WRITE, T10A],
    );
    await owner.query(
      `INSERT INTO role (id, tenant_id, code, name, data_scope, created_at, updated_at)
       VALUES ($1, $2, 't10-biller', 'T10 Scoped Biller', 'ORG_SUBTREE', now(), now())
       ON CONFLICT DO NOTHING`,
      [ROLE_SCOPED, T10A],
    );
    await owner.query(
      `INSERT INTO role_permission (tenant_id, role_id, permission_id, created_at, updated_at)
       VALUES ($1, $2, $3, now(), now()) ON CONFLICT DO NOTHING`,
      [T10A, ROLE_SCOPED, PERM_WRITE],
    );
    const hash = await bcrypt.hash('t10-pass', 10);
    await owner.query(
      `INSERT INTO staff (id, tenant_id, org_unit_id, login, password_hash, name, status, created_at, updated_at)
       VALUES ($1, $2, $3, 't10-biller', $4, 'T10 Biller', 'ACTIVE', now(), now())
       ON CONFLICT (tenant_id, login) DO NOTHING`,
      [STAFF_SCOPED, T10A, ORG_A2, hash],
    );
    await owner.query(
      `INSERT INTO staff_role (tenant_id, staff_id, role_id, created_at, updated_at)
       VALUES ($1, $2, $3, now(), now()) ON CONFLICT DO NOTHING`,
      [T10A, STAFF_SCOPED, ROLE_SCOPED],
    );
    const scopedToken = (
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ tenantCode: 't10-water', login: 't10-biller', password: 't10-pass' })
        .expect(201)
    ).body.accessToken as string;

    // Fresh account + FINAL settlement + a POSTED bill to reverse.
    await onboard('A5', 'RES_METERED');
    await seedSettlement('A5-10', acct['A5'], '202610', 40);
    const r = await post('/billing-runs', { period: '202610' }).expect(201);
    const posted = await post(`/billing-runs/${r.body.id}/post`, {}).expect(201);
    expect(posted.body.status).toBe('POSTED');
    const bills = (await get(`/billing-runs/${r.body.id}`)).body.bills;
    bill['A5-10'] = bills[0].id;
    expect(bills[0].status).toBe('POSTED');

    // Bind A5 to a book under ORG_A via a plan item for the bill's
    // period — out of the ORG_A2-scoped writer's subtree.
    const bookId = 'aa10aa10-0000-4000-8000-00000000b001';
    const planId = 'aa10aa10-0000-4000-8000-00000000b002';
    await owner.query(
      `INSERT INTO reading_book (id, tenant_id, org_unit_id, book_no, name, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 't10 scope book', now(), now()) ON CONFLICT DO NOTHING`,
      [bookId, T10A, ORG_A, `T10B-${RUN}`],
    );
    await owner.query(
      `INSERT INTO reading_plan (id, tenant_id, book_id, period, plan_date, status, created_at, updated_at)
       VALUES ($1, $2, $3, '202610', '2026-10-01', 'DONE', now(), now()) ON CONFLICT DO NOTHING`,
      [planId, T10A, bookId],
    );
    await owner.query(
      `INSERT INTO reading_plan_item (id, tenant_id, plan_id, water_account_id, seq_no, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 1, 'PENDING', now(), now()) ON CONFLICT DO NOTHING`,
      [T10A, planId, acct['A5']],
    );

    const denied = await post(`/bills/${bill['A5-10']}/reverse`, {}, scopedToken);
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: 'ORG_OUT_OF_SCOPE' });

    const ok = await post(`/bills/${bill['A5-10']}/reverse`, {});
    expect(ok.status).toBe(201);
    expect(ok.body.billKind).toBe('REVERSAL');
  });

  it('a DRAFT bill blocks close; posting onto a CLOSED account records ACCOUNT_CLOSED', async () => {
    await onboard('A4', 'RES_METERED');
    await seedSettlement('A4-08', acct['A4'], '202608', 25);
    const r1 = await post('/billing-runs', { period: '202608' }).expect(201);

    // The generated DRAFT bill counts as outstanding in flight — close
    // is blocked rather than letting the debt post onto a closed account.
    const blocked = await post(`/water-accounts/${acct['A4']}/close`, {});
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ code: 'ACCOUNT_OUTSTANDING_BALANCE' });

    await post(`/billing-runs/${r1.body.id}/discard`, {}).expect(201);
    const closed = await post(`/water-accounts/${acct['A4']}/close`, {}).expect(201);
    expect(closed.body.status).toBe('CLOSED');

    // A rerun still drafts the bill (the settlement is FINAL) but the
    // post refuses to mint debt onto the CLOSED account.
    const r2 = await post('/billing-runs', { period: '202608' }).expect(201);
    const done = await post(`/billing-runs/${r2.body.id}/post`, {}).expect(201);
    expect(done.body.status).toBe('FAILED');
    const codes = (done.body.failedSettlementIds as { code: string }[]).map(
      (f) => f.code,
    );
    expect(codes).toContain('ACCOUNT_CLOSED');
  });

  it('replace rejects usageQty beyond numeric(18,4) scale (400)', async () => {
    const res = await post(`/bills/aa10aa10-9999-4999-8999-aa10aa10aa10/replace`, {
      usageQty: '1.00005',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'BILL_USAGE_QTY_SCALE' });
  });
});

describe('v0.2: monitoring skip + household-scaled pricing', () => {
  it('MONITORING settlement is skipped — never a bill, never a failure, out of counters', async () => {
    const mon = await post('/water-accounts/onboard', {
      account: { usageCategory: 'MONITORING', addr: 'DMA-09 入口' },
      meter: { brand: 't10-brand' },
      installation: { initialReading: 0 },
    }).expect(201);
    const st = await post('/consumption-settlements', {
      waterAccountId: mon.body.waterAccount.id,
      period: '202609',
      usageQty: 40,
      estimateReason: 'monitoring period usage',
    }).expect(201);
    await post(`/consumption-settlements/${st.body.id}/finalize`, {}).expect(201);

    const res = await post('/billing-runs', { period: '202609' }).expect(201);
    // Excluded from the run's denominator entirely — not a failure record.
    expect(res.body.totalCount).toBe(0);
    expect(res.body.failedCount).toBe(0);
    const bills = await owner.query(
      `SELECT count(*)::int AS n FROM bill
       WHERE tenant_id = $1 AND source_type = 'SETTLEMENT' AND source_id = $2`,
      [T10A, st.body.id],
    );
    expect(bills.rows[0].n).toBe(0);
  });

  it('household=5 shifts tier bound 216→267 (baseHousehold 4, +51/person); 230 prices flat', async () => {
    const fee = (
      await post('/fee-items', {
        code: `WATER-HH-${RUN}`,
        name: '水费',
        calcType: 'PER_QTY',
      }).expect(201)
    ).body;
    const plan = await post('/tariff-plans', {
      code: `RESHH-${RUN}`,
      name: '居民户表价',
      usageCategory: 'RES_SHARED',
      effectiveFrom: '2026-01-01',
      baseHousehold: 4,
      perPersonQty: '51',
      tiers: [
        { feeItemId: fee.id, tierNo: 1, fromQty: 0, toQty: 216, unitPrice: '3' },
        { feeItemId: fee.id, tierNo: 2, fromQty: 216, toQty: null, unitPrice: '5' },
      ],
    }).expect(201);
    await post(`/tariff-plans/${plan.body.id}/activate`, {}).expect(201);

    const a = await post('/water-accounts/onboard', {
      customer: { name: `T10 HH ${RUN}`, custType: 'PERSONAL' },
      account: { usageCategory: 'RES_SHARED', addr: 'hh st', householdSize: 5 },
      meter: { brand: 't10-brand' },
      installation: { initialReading: 0 },
    }).expect(201);
    const st = await post('/consumption-settlements', {
      waterAccountId: a.body.waterAccount.id,
      period: '202609',
      usageQty: 230,
      estimateReason: 'hh scale test',
    }).expect(201);
    expect(st.body.householdSizeSnapshot).toBe(5);
    await post(`/consumption-settlements/${st.body.id}/finalize`, {}).expect(201);

    const run = await post('/billing-runs', { period: '202609' }).expect(201);
    // The monitoring settlement is skipped → only the household account counts.
    expect(run.body.totalCount).toBe(1);
    await post(`/billing-runs/${run.body.id}/post`, {}).expect(201);

    const bill = (
      await owner.query(
        `SELECT total_amount::text AS t FROM bill
         WHERE tenant_id = $1 AND source_type = 'SETTLEMENT' AND source_id = $2`,
        [T10A, st.body.id],
      )
    ).rows[0];
    // 5人 → bound 216+51=267; 230 ≤ 267 → all at 3.00 → 690.00
    expect(bill.t).toBe('69000');

    // Sanity: the same plan at household=4 would cross the bound —
    // 216×3 + 14×5 = 718.00 — proving the shift priced it.
    const a4 = await post('/water-accounts/onboard', {
      customer: { name: `T10 HH4 ${RUN}`, custType: 'PERSONAL' },
      account: { usageCategory: 'RES_SHARED', addr: 'hh4 st', householdSize: 4 },
      meter: { brand: 't10-brand' },
      installation: { initialReading: 0 },
    }).expect(201);
    const st4 = await post('/consumption-settlements', {
      waterAccountId: a4.body.waterAccount.id,
      period: '202610',
      usageQty: 230,
      estimateReason: 'hh4 scale test',
    }).expect(201);
    await post(`/consumption-settlements/${st4.body.id}/finalize`, {}).expect(201);
    const run2 = await post('/billing-runs', { period: '202610' }).expect(201);
    await post(`/billing-runs/${run2.body.id}/post`, {}).expect(201);
    const bill4 = (
      await owner.query(
        `SELECT total_amount::text AS t FROM bill
         WHERE tenant_id = $1 AND source_type = 'SETTLEMENT' AND source_id = $2`,
        [T10A, st4.body.id],
      )
    ).rows[0];
    expect(bill4.t).toBe('71800');
  });
});
