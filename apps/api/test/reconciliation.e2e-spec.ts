/**
 * Reconciliation （锚点校准/补差） e2e against `watersaas_test` — fixtures
 * carry the `t11-` prefix. Boots the real AppModule so JWT/permission
 * guards, tenant ALS and RLS all apply.
 *
 * Covers (Task-11 brief assertions):
 *  1. ABSORB: anchor 202606=1000 → estimates 30 (202607 FINAL) + 35
 *     (202608 DRAFT) → actual 202608=1080: total 80, settled 65,
 *     remainder +15 absorbed into the DRAFT settlement (35 → 50),
 *     status=ABSORBED, adjustment 0, NO bill
 *  2. explicit actualReadingId chains a second reconciliation onto the
 *     first one's actual (anchor = previous actual)
 *  3. negative adjustment: actual 1055 → remainder −10 → reprice →
 *     APPLIED + POSTED ADJUSTMENT bill (RECONCILIATION source) with
 *     negative totalAmount = correct(55 repriced) − posted(65 billed);
 *     Idempotency-Key replay returns the same row, no second bill
 *  4. positive remainder but span FINAL+billed → APPLIED + positive
 *     ADJUSTMENT bill (frozen settlements are never mutated)
 *  5. actual < anchor (dial regression) → MANUAL_REVIEW, no bill, no
 *     settlement mutation; meter swap → MANUAL_REVIEW
 *  6. errors: re-reconcile same actual → 409; no trusted reading → 404;
 *     no anchor → 404; superseded actual → 404; empty span → 409;
 *     tenant B sees nothing; field guards → 400
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

// ---- fixtures (all prefixed t11-) ----
const T11A = 'aa11aa11-1111-4011-8011-aa11aa11aa11'; // tenant A
const T11B = 'bb11bb11-2121-4021-8021-bb11bb11bb11'; // tenant B (isolation)
const ORG_A = 'aa11aa11-0000-4000-8000-0000000000c0';
const ORG_B = 'bb11bb11-0000-4000-8000-0000000000c0';
const ROLE_ADMIN_A = 'aa11aa11-0000-4000-8000-00000000ad01';
const ROLE_B_ADMIN = 'bb11bb11-0000-4000-8000-00000000ad01';
const STAFF_ADMIN_A = 'aa11aa11-0000-4000-8000-0000000a0001';
const STAFF_B_ADMIN = 'bb11bb11-0000-4000-8000-0000000a0001';

const owner = new pg.Client({ connectionString: OWNER_URL });
let app: INestApplication<App>;
let adminToken = '';
let tenantBToken = '';

// ids populated by the sequential suite
let waterItem = ''; // fee_item WATER-* (PER_QTY)
let fixedItem = ''; // fee_item FIXED-* (FIXED)
let planRes = ''; // ACTIVE RESIDENTIAL plan
const acct: Record<string, string> = {}; // A1..A9 water_account ids
const inst: Record<string, string> = {}; // A1..A9 ACTIVE installation ids
const meter: Record<string, string> = {}; // A1..A9 meter ids
const reading: Record<string, string> = {}; // label → meter_reading id
const settle: Record<string, string> = {}; // label → settlement id
const recon: Record<string, string> = {}; // label → reconciliation id

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

// Run-scoped suffix: the test DB keeps rows between runs, so business
// codes differ per run.
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

const post = (path: string, body: unknown, token = adminToken) =>
  request(app.getHttpServer()).post(path).set(auth(token)).send(body);

const get = (path: string, token = adminToken, status = 200) =>
  request(app.getHttpServer()).get(path).set(auth(token)).expect(status);

const onboard = async (label: string) => {
  const res = await post('/water-accounts/onboard', {
    customer: { name: `T11 ${label} ${RUN}`, custType: 'PERSONAL' },
    account: { usageCategory: 'RESIDENTIAL', addr: `${label} Water St` },
    meter: { brand: 't11-brand', caliber: 'DN15' },
    installation: { initialReading: 0, installedAt: '2026-01-01' },
  }).expect(201);
  acct[label] = res.body.waterAccount.id;
  inst[label] = res.body.installation.id;
  meter[label] = res.body.installation.meterId;
  return res.body;
};

/** Insert a meter_reading directly (trusted = PASSED ACTUAL by default). */
const seedReading = async (
  label: string,
  instId: string,
  meterId: string,
  period: string,
  readDate: string,
  value: string,
  opts: { resultType?: string; qc?: string; supersedes?: string } = {},
) => {
  const row = (
    await owner.query(
      `INSERT INTO meter_reading
         (id, tenant_id, installation_id, meter_id, period, read_date,
          result_type, reading_value, supersedes_reading_id, qc_status,
          source, operator_id, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9,
               'WEB', $10, now(), now())
       RETURNING id::text AS id`,
      [
        T11A,
        instId,
        meterId,
        period,
        readDate,
        opts.resultType ?? 'ACTUAL',
        value,
        opts.supersedes ?? null,
        opts.qc ?? 'PASSED',
        STAFF_ADMIN_A,
      ],
    )
  ).rows[0];
  reading[label] = row.id;
  return row.id as string;
};

/** Insert a consumption_settlement directly (DRAFT or FINAL). */
const seedSettlement = async (
  label: string,
  waterAccountId: string,
  period: string,
  usage: number,
  status: 'DRAFT' | 'FINAL' = 'FINAL',
) => {
  const row = (
    await owner.query(
      `INSERT INTO consumption_settlement
         (id, tenant_id, water_account_id, period, total_usage_qty, is_estimated,
          estimate_method, estimate_reason, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'MANUAL', 't11-estimate',
               $6, now(), now())
       RETURNING id::text AS id`,
      [T11A, waterAccountId, period, usage, true, status],
    )
  ).rows[0];
  settle[label] = row.id;
  return row.id as string;
};

/** Generate + post a billing run (real engine-priced POSTED bills). */
const runAndPost = async (period: string) => {
  const r = await post('/billing-runs', { period }).expect(201);
  return (await post(`/billing-runs/${r.body.id}/post`, {}).expect(201)).body;
};

const settlementDetail = async (id: string) =>
  (await get(`/consumption-settlements/${id}`)).body as {
    id: string;
    status: string;
    totalUsageQty: string;
  };

beforeAll(async () => {
  await owner.connect();
  const hash = await bcrypt.hash('t11-pass', 10);

  await owner.query(
    `INSERT INTO tenant (id, code, name, status, created_at, updated_at)
     VALUES ($1, 't11-water', 'T11 Water', 'ACTIVE', now(), now()),
            ($2, 't11-other', 'T11 Other', 'ACTIVE', now(), now())
     ON CONFLICT DO NOTHING`,
    [T11A, T11B],
  );
  await owner.query(
    `INSERT INTO org_unit (id, tenant_id, parent_id, name, type, created_at, updated_at)
     VALUES ($1, $2, NULL, 'T11 Company', 'COMPANY', now(), now()),
            ($3, $4, NULL, 'T11B Company', 'COMPANY', now(), now())
     ON CONFLICT DO NOTHING`,
    [ORG_A, T11A, ORG_B, T11B],
  );
  await owner.query(
    `INSERT INTO role (id, tenant_id, code, name, data_scope, created_at, updated_at)
     VALUES ($1, $3, 'admin', 'T11 Admin', 'ALL', now(), now()),
            ($2, $4, 'admin', 'T11B Admin', 'ALL', now(), now())
     ON CONFLICT DO NOTHING`,
    [ROLE_ADMIN_A, ROLE_B_ADMIN, T11A, T11B],
  );
  await owner.query(
    `INSERT INTO staff (id, tenant_id, org_unit_id, login, password_hash, name, status, created_at, updated_at)
     VALUES ($1, $3, $5, 't11-admin',  $6, 'T11 Admin',  'ACTIVE', now(), now()),
            ($2, $4, $7, 't11b-admin', $6, 'T11B Admin', 'ACTIVE', now(), now())
     ON CONFLICT (tenant_id, login) DO NOTHING`,
    [STAFF_ADMIN_A, STAFF_B_ADMIN, T11A, T11B, ORG_A, hash, ORG_B],
  );
  await owner.query(
    `INSERT INTO staff_role (tenant_id, staff_id, role_id, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now()),
            ($4, $5, $6, now(), now())
     ON CONFLICT DO NOTHING`,
    [T11A, STAFF_ADMIN_A, ROLE_ADMIN_A, T11B, STAFF_B_ADMIN, ROLE_B_ADMIN],
  );

  // The test DB persists between runs — wipe tenant A's business tables
  // (FK-safe order); iam fixtures above are idempotent and stay.
  for (const table of [
    'reconciliation',
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
    await owner.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [T11A]);
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
        .send({ tenantCode, login: login_, password: 't11-pass' })
        .expect(201)
    ).body.accessToken as string;
  adminToken = await login('t11-water', 't11-admin');
  tenantBToken = await login('t11-other', 't11b-admin');
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

describe('fixtures: fee items + plan + accounts + readings', () => {
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
      usageCategory: 'RESIDENTIAL',
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

  it('onboards the scenario accounts and seeds trusted readings', async () => {
    for (const label of ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9']) {
      await onboard(label);
    }

    // A1/A2/A3 — anchor 202606=1000, actual 202608 (per-test value).
    for (const label of ['A1', 'A2', 'A3']) {
      await seedReading(`${label}-anchor`, inst[label], meter[label], '202606', '2026-06-30', '1000');
    }
    await seedReading('A1-actual', inst['A1'], meter['A1'], '202608', '2026-08-31', '1080');
    await seedReading('A2-actual', inst['A2'], meter['A2'], '202608', '2026-08-31', '1055');
    await seedReading('A3-actual', inst['A3'], meter['A3'], '202608', '2026-08-31', '1080');

    // A4 — dial regression: actual 990 < anchor 1000.
    await seedReading('A4-anchor', inst['A4'], meter['A4'], '202606', '2026-06-30', '1000');
    await seedReading('A4-actual', inst['A4'], meter['A4'], '202608', '2026-08-31', '990');

    // A5 — no readings at all. A6 — a single reading (no anchor).
    await seedReading('A6-only', inst['A6'], meter['A6'], '202608', '2026-08-31', '1050');

    // A7 — a superseded pair in one period: old (superseded by new).
    const oldId = await seedReading(
      'A7-old', inst['A7'], meter['A7'], '202608', '2026-08-25', '1055',
    );
    await seedReading('A7-new', inst['A7'], meter['A7'], '202608', '2026-08-31', '1080', {
      supersedes: oldId,
    });

    // A9 — two readings, no settlements (empty span).
    await seedReading('A9-anchor', inst['A9'], meter['A9'], '202606', '2026-06-30', '1000');
    await seedReading('A9-actual', inst['A9'], meter['A9'], '202608', '2026-08-31', '1050');
  });

  it('A8 — swaps in a second meter; anchor on the removed, actual on the new installation', async () => {
    // Retire the onboarded installation, install a second meter via SQL.
    await owner.query(
      `UPDATE meter_installation SET status = 'REMOVED', removed_at = '2026-07-01' WHERE id = $1`,
      [inst['A8']],
    );
    const meterId = (
      await owner.query(
        `INSERT INTO meter (id, tenant_id, meter_no, status, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, 'INSTALLED', now(), now())
         RETURNING id::text AS id`,
        [T11A, `T11-M8-${RUN}`],
      )
    ).rows[0].id as string;
    const instId = (
      await owner.query(
        `INSERT INTO meter_installation
           (id, tenant_id, water_account_id, meter_id, installed_at,
            initial_reading, reason, status, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, '2026-07-01', 0, 'REPLACE',
                 'ACTIVE', now(), now())
         RETURNING id::text AS id`,
        [T11A, acct['A8'], meterId],
      )
    ).rows[0].id as string;

    await seedReading('A8-anchor', inst['A8'], meter['A8'], '202606', '2026-06-30', '1000');
    await seedReading('A8-actual', instId, meterId, '202608', '2026-08-31', '50');
  });
});

describe('posted history: A2 + A3 billed for the estimated months', () => {
  it('bills 202607 (30 m³ → 100.00) and 202608 (35 m³ → 115.00) for both accounts', async () => {
    // Estimated months for A2 + A3 — FINAL settlements the runs pick up.
    for (const label of ['A2', 'A3']) {
      await seedSettlement(`${label}-07`, acct[label], '202607', 30);
      await seedSettlement(`${label}-08`, acct[label], '202608', 35);
    }

    const r1 = await runAndPost('202607');
    expect(r1.status).toBe('POSTED');
    expect(r1.successCount).toBe(2);
    const r2 = await runAndPost('202608');
    expect(r2.status).toBe('POSTED');
    expect(r2.successCount).toBe(2);

    // ytd cursor: 202608 sees 202607's billed 30 — still all tier1.
    for (const label of ['A2', 'A3']) {
      const bills = (
        await get(`/bills?waterAccountId=${acct[label]}`)
      ).body as { period: string; totalAmount: string }[];
      const byPeriod = new Map(bills.map((b) => [b.period, b.totalAmount]));
      expect(byPeriod.get('202607')).toBe('10000'); // 30×3.0 + 10
      expect(byPeriod.get('202608')).toBe('11500'); // 35×3.0 + 10
    }
  });
});

describe('ABSORB — positive remainder into the DRAFT settlement', () => {
  it('A1: actual 1080 → total 80, settled 65, remainder +15 absorbed (35 → 50), NO bill', async () => {
    // A1's estimated months — seeded only now so the 202607 run above
    // could not bill them (the absorb path reads unbilled DRAFT/FINAL).
    await seedSettlement('A1-07', acct['A1'], '202607', 30);
    await seedSettlement('A1-08', acct['A1'], '202608', 35, 'DRAFT');

    const res = await post('/reconciliations', { waterAccountId: acct['A1'] }).expect(201);
    recon['A1'] = res.body.id;
    expect(res.body).toMatchObject({
      waterAccountId: acct['A1'],
      anchorReadingId: reading['A1-anchor'],
      actualReadingId: reading['A1-actual'],
      fromPeriod: '202607',
      toPeriod: '202608',
      actualTotalUsage: '80',
      previouslySettledUsage: '65',
      remainderUsage: '15',
      absorbedSettlementId: settle['A1-08'],
      status: 'ABSORBED',
      adjustmentAmountCent: '0',
      adjustmentBill: null,
    });

    const s = await settlementDetail(settle['A1-08']);
    expect(s.totalUsageQty).toBe('50'); // 35 + 15

    const bills = (await get(`/bills?waterAccountId=${acct['A1']}`)).body;
    expect(bills).toHaveLength(0);
  });

  it('chains a second reconciliation: explicit actualReadingId anchors on the previous actual', async () => {
    // Next month arrives: actual 202609=1130, DRAFT settlement usage 40.
    await seedSettlement('A1-09', acct['A1'], '202609', 40, 'DRAFT');
    await seedReading('A1-actual2', inst['A1'], meter['A1'], '202609', '2026-09-30', '1130');

    const res = await post('/reconciliations', {
      waterAccountId: acct['A1'],
      actualReadingId: reading['A1-actual2'],
    }).expect(201);
    recon['A1-2'] = res.body.id;
    expect(res.body).toMatchObject({
      anchorReadingId: reading['A1-actual'], // previous actual is the anchor
      actualReadingId: reading['A1-actual2'],
      fromPeriod: '202609',
      toPeriod: '202609',
      actualTotalUsage: '50',
      previouslySettledUsage: '40',
      remainderUsage: '10',
      status: 'ABSORBED',
    });
    const s = await settlementDetail(settle['A1-09']);
    expect(s.totalUsageQty).toBe('50'); // 40 + 10
  });

  it('GET /reconciliations filters + detail; tenant-scoped list shape', async () => {
    const detail = (await get(`/reconciliations/${recon['A1']}`)).body;
    expect(detail.id).toBe(recon['A1']);
    expect(detail.status).toBe('ABSORBED');

    const all = (await get(`/reconciliations?waterAccountId=${acct['A1']}`)).body;
    expect(all.map((r: { id: string }) => r.id)).toEqual([recon['A1-2'], recon['A1']]);

    // ?period= is a "covers" filter over [fromPeriod, toPeriod].
    const covered = (await get(`/reconciliations?period=202608`)).body;
    expect(covered.map((r: { id: string }) => r.id)).toContain(recon['A1']);
    expect(covered.map((r: { id: string }) => r.id)).not.toContain(recon['A1-2']);

    const absorbedOnly = (await get(`/reconciliations?status=ABSORBED`)).body;
    expect(absorbedOnly.map((r: { id: string }) => r.id)).toEqual(
      expect.arrayContaining([recon['A1'], recon['A1-2']]),
    );
  });
});

describe('ADJUST — negative remainder (over-estimated)', () => {
  it('A2: actual 1055 → remainder −10 → reprice → APPLIED + negative ADJUSTMENT bill', async () => {
    const key = `t11-recon-${RUN}`;
    const res = await request(app.getHttpServer())
      .post('/reconciliations')
      .set(auth(adminToken))
      .set('Idempotency-Key', key)
      .send({ waterAccountId: acct['A2'] })
      .expect(201);
    recon['A2'] = res.body.id;

    // allocated: 55 over [30,35] → [25.3846, 29.6154]; correct =
    // (76.1538→7615 + 1000) + (88.8462→8885 + 1000) = 8615 + 9885 =
    // 18500¢; posted = 10000 + 11500 = 21500¢ → adjustment −3000¢.
    expect(res.body).toMatchObject({
      waterAccountId: acct['A2'],
      fromPeriod: '202607',
      toPeriod: '202608',
      actualTotalUsage: '55',
      previouslySettledUsage: '65',
      remainderUsage: '-10',
      status: 'APPLIED',
      correctChargeCent: '18500',
      postedChargeCent: '21500',
      adjustmentAmountCent: '-3000',
      absorbedSettlementId: null,
    });
    const bill = res.body.adjustmentBill;
    expect(bill).toMatchObject({
      billKind: 'ADJUSTMENT',
      sourceType: 'RECONCILIATION',
      sourceId: recon['A2'],
      waterAccountId: acct['A2'],
      period: '202608',
      tariffPlanId: planRes,
      status: 'POSTED',
      totalAmount: '-3000',
      dueDate: null,
    });
    expect(bill.issuedAt).toBeTruthy();

    // One ADJUSTMENT item per span period: qty = allocated − settled,
    // amount = per-period correct − per-period posted. (Items share one
    // tx timestamp — match by description, not position.)
    const detail = (await get(`/bills/${bill.id}`)).body;
    expect(detail.items).toHaveLength(2);
    const byDesc = new Map(detail.items.map((i: { description: string }) => [i.description, i]));
    expect(byDesc.get('reconcile 202607')).toMatchObject({
      itemType: 'ADJUSTMENT',
      feeItemId: null,
      qty: '-4.6154', // 25.3846 − 30
      amount: '-1385', // 8615 − 10000
    });
    expect(byDesc.get('reconcile 202608')).toMatchObject({
      itemType: 'ADJUSTMENT',
      feeItemId: null,
      qty: '-5.3846', // 29.6154 − 35
      amount: '-1615', // 9885 − 11500
    });

    // Idempotency-Key replay returns the stored response — no second row.
    const replay = await request(app.getHttpServer())
      .post('/reconciliations')
      .set(auth(adminToken))
      .set('Idempotency-Key', key)
      .send({ waterAccountId: acct['A2'] })
      .expect(201);
    expect(replay.body.id).toBe(recon['A2']);
    expect((await get(`/reconciliations?waterAccountId=${acct['A2']}`)).body).toHaveLength(1);
    expect(
      (await get(`/bills?waterAccountId=${acct['A2']}&period=202608`)).body,
    ).toHaveLength(2); // the NORMAL bill + the one ADJUSTMENT

    const conflict = await request(app.getHttpServer())
      .post('/reconciliations')
      .set(auth(adminToken))
      .set('Idempotency-Key', key)
      .send({ waterAccountId: acct['A3'] });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
    });
  });
});

describe('ADJUST — positive remainder but settlements frozen', () => {
  it('A3: actual 1080 → remainder +15 but span FINAL+billed → APPLIED + positive ADJUSTMENT bill', async () => {
    const res = await post('/reconciliations', { waterAccountId: acct['A3'] }).expect(201);
    recon['A3'] = res.body.id;

    // allocated: 80 over [30,35] → [36.9231, 43.0769]; correct =
    // (36.9231×3 + 10) + (43.0769×3 + 10) = 120.77 + 139.23 = 26000¢;
    // posted 21500 → adjustment +4500¢.
    expect(res.body).toMatchObject({
      status: 'APPLIED',
      actualTotalUsage: '80',
      previouslySettledUsage: '65',
      remainderUsage: '15',
      correctChargeCent: '26000',
      postedChargeCent: '21500',
      adjustmentAmountCent: '4500',
    });
    const bill = res.body.adjustmentBill;
    expect(bill).toMatchObject({
      billKind: 'ADJUSTMENT',
      sourceType: 'RECONCILIATION',
      totalAmount: '4500',
    });
    const detail = (await get(`/bills/${bill.id}`)).body;
    expect(detail.items).toHaveLength(2);
    const byDesc = new Map(detail.items.map((i: { description: string }) => [i.description, i]));
    expect(byDesc.get('reconcile 202607')).toMatchObject({
      qty: '6.9231', // 36.9231 − 30
      amount: '2077', // 12077 − 10000
    });
    expect(byDesc.get('reconcile 202608')).toMatchObject({
      qty: '8.0769', // 43.0769 − 35
      amount: '2423', // 13923 − 11500
    });

    // FINAL settlements untouched.
    expect((await settlementDetail(settle['A3-07'])).totalUsageQty).toBe('30');
    expect((await settlementDetail(settle['A3-08'])).totalUsageQty).toBe('35');
  });
});

describe('MANUAL_REVIEW — regression + meter swap', () => {
  it('A4: actual 990 < anchor 1000 → MANUAL_REVIEW, no bill, no settlement mutation', async () => {
    await seedSettlement('A4-07', acct['A4'], '202607', 30);
    await seedSettlement('A4-08', acct['A4'], '202608', 35, 'DRAFT');

    const res = await post('/reconciliations', { waterAccountId: acct['A4'] }).expect(201);
    recon['A4'] = res.body.id;
    expect(res.body).toMatchObject({
      status: 'MANUAL_REVIEW',
      actualTotalUsage: '-10',
      previouslySettledUsage: '65',
      remainderUsage: '-75',
      adjustmentBill: null,
    });
    // untouched settlement + no bill
    expect((await settlementDetail(settle['A4-08'])).totalUsageQty).toBe('35');
    expect((await get(`/bills?waterAccountId=${acct['A4']}`)).body).toHaveLength(0);
  });

  it('A8: anchor/actual on different installations → MANUAL_REVIEW', async () => {
    await seedSettlement('A8-07', acct['A8'], '202607', 30);
    await seedSettlement('A8-08', acct['A8'], '202608', 35, 'DRAFT');

    const res = await post('/reconciliations', { waterAccountId: acct['A8'] }).expect(201);
    expect(res.body).toMatchObject({
      status: 'MANUAL_REVIEW',
      anchorReadingId: reading['A8-anchor'],
      actualReadingId: reading['A8-actual'],
      adjustmentBill: null,
    });
    expect((await get(`/bills?waterAccountId=${acct['A8']}`)).body).toHaveLength(0);
  });
});

describe('errors + tenant isolation', () => {
  it('re-reconciling the same actual → 409 RECONCILIATION_EXISTS', async () => {
    const res = await post('/reconciliations', { waterAccountId: acct['A3'] });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'RECONCILIATION_EXISTS',
      reconciliationId: recon['A3'],
    });
  });

  it('A5: no trusted reading → 404 READING_NOT_FOUND', async () => {
    const res = await post('/reconciliations', { waterAccountId: acct['A5'] });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'READING_NOT_FOUND' });
  });

  it('A6: one reading only → 404 ANCHOR_NOT_FOUND', async () => {
    const res = await post('/reconciliations', { waterAccountId: acct['A6'] });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'ANCHOR_NOT_FOUND' });
  });

  it('A7: a superseded reading is not trusted — explicit id → 404; latest → no anchor → 404', async () => {
    const stale = await post('/reconciliations', {
      waterAccountId: acct['A7'],
      actualReadingId: reading['A7-old'],
    });
    expect(stale.status).toBe(404);
    expect(stale.body).toMatchObject({ code: 'READING_NOT_FOUND' });

    // The fresh (unsuperseded) reading is trusted, but the only earlier
    // one is its superseded parent — nothing left to anchor on.
    const res = await post('/reconciliations', { waterAccountId: acct['A7'] });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'ANCHOR_NOT_FOUND' });
  });

  it('A9: no settlements inside (anchor, actual] → 409 RECONCILIATION_EMPTY_SPAN', async () => {
    const res = await post('/reconciliations', { waterAccountId: acct['A9'] });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'RECONCILIATION_EMPTY_SPAN' });
  });

  it('field guards → 400', async () => {
    const missing = await post('/reconciliations', {});
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ code: 'RECONCILIATION_FIELDS_REQUIRED' });

    const badId = await post('/reconciliations', { waterAccountId: 'nope' });
    expect(badId.status).toBe(400);
    expect(badId.body).toMatchObject({ code: 'INVALID_ID_FORMAT' });

    const badStatus = await get('/reconciliations?status=NOPE', adminToken, 400);
    expect(badStatus.body).toMatchObject({ code: 'RECONCILIATION_STATUS_INVALID' });
  });

  it('tenant B sees no reconciliations and cannot touch tenant A rows', async () => {
    expect((await get('/reconciliations', tenantBToken)).body).toEqual([]);
    await get(`/reconciliations/${recon['A1']}`, tenantBToken, 404);
    const res = await post('/reconciliations', { waterAccountId: acct['A1'] }, tenantBToken);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'WATER_ACCOUNT_NOT_FOUND' });
  });
});
