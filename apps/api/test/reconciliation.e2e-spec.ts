/**
 * Reconciliation （锚点校准/补差） e2e against `watersaas_test` — fixtures
 * carry the `t11-` prefix. Boots the real AppModule so JWT/permission
 * guards, tenant ALS and RLS all apply.
 *
 * Post-review semantics: settled = FINAL-only, absorb SETs (not
 * increments) and rewires the component dial chain, posted counts
 * NORMAL|REPLACEMENT|ADJUSTMENT.
 *
 * Covers (Task-11 brief + fix-round assertions):
 *  1. ABSORB: anchor 202606=1000 → estimates 30 (202607 FINAL) + 35
 *     (202608 DRAFT) → actual 202608=1080: total 80, fixed 30,
 *     openUsage 50 → DRAFT settlement SET to 50 (estimate corrected
 *     wholesale), component rewired to the real dial, status=ABSORBED,
 *     adjustment 0, NO bill
 *  2. C1 sharpest: 202607 FINAL+billed 30, 202608 DRAFT 40, actual
 *     1055 → ABSORBED, settlement := 25 (55−30) — the over-estimate is
 *     corrected in place, no bill; Idempotency-Key replay + a 409
 *     re-POST both leave the settlement at 25 (SET semantics)
 *  3. C1 gate: FINAL-but-UNBILLED settlement inside the span + adjust
 *     triggered → 422 RECONCILIATION_UNBILLED_SPAN naming the period
 *  4. C2 convergence: an APPLIED recon's ADJUSTMENT bill counts toward
 *     the next recon's posted — second calibration nets only the
 *     remaining delta (−3000 already corrected → −6000, not −9000)
 *  5. explicit actualReadingId chains a second reconciliation onto the
 *     first one's actual (anchor = previous actual)
 *  6. negative adjustment: actual 1055 → openUsage −10 → reprice →
 *     APPLIED + POSTED ADJUSTMENT bill (RECONCILIATION source);
 *     Idempotency-Key replay returns the same row, no second bill
 *  7. positive remainder but span FINAL+billed → APPLIED + positive
 *     ADJUSTMENT bill (frozen settlements are never mutated)
 *  8. actual < anchor (dial regression) → MANUAL_REVIEW, no bill, no
 *     settlement mutation; meter swap → MANUAL_REVIEW
 *  9. errors: re-reconcile same actual → 409; no trusted reading → 404;
 *     no anchor → 404; superseded actual → 404; empty span → 409;
 *     CLOSED account → 409; tenant B sees nothing; field guards → 400
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
const acct: Record<string, string> = {}; // A1..A13 water_account ids
const inst: Record<string, string> = {}; // A1..A13 ACTIVE installation ids
const meter: Record<string, string> = {}; // A1..A13 meter ids
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

/**
 * Insert one ESTIMATE component on a settlement — absorb rewires the
 * component on the actual's installation (end dial → real reading,
 * source → READING), so absorb-target DRAFTs need a row to rewire.
 */
const seedComponent = async (
  settlementId: string,
  installationId: string,
  prev: string,
  end: string,
  usage: string,
) =>
  owner.query(
    `INSERT INTO consumption_component
       (id, tenant_id, settlement_id, installation_id, prev_reading_value,
        end_reading_value, usage_qty, source_type, source_reading_id,
        created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'ESTIMATE', NULL,
             now(), now())`,
    [T11A, settlementId, installationId, prev, end, usage],
  );

/** The component rows of a settlement (owner-side read for assertions).
 *  Numeric scale is normalized ('50.0000' → '50') for clean matching. */
const componentsOf = async (settlementId: string) =>
  (
    await owner.query(
      `SELECT installation_id::text AS "installationId",
              TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM prev_reading_value::text))
                AS "prevReadingValue",
              TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM end_reading_value::text))
                AS "endReadingValue",
              TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM usage_qty::text))
                AS "usageQty",
              source_type::text AS "sourceType",
              source_reading_id::text AS "sourceReadingId"
         FROM consumption_component
        WHERE tenant_id = $1 AND settlement_id = $2
        ORDER BY installation_id`,
      [T11A, settlementId],
    )
  ).rows as {
    installationId: string;
    prevReadingValue: string;
    endReadingValue: string;
    usageQty: string;
    sourceType: string;
    sourceReadingId: string | null;
  }[];

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
    for (const label of [
      'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9',
      'A10', 'A11', 'A12', 'A13',
    ]) {
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

    // A10 — C1 absorb: anchor 202606=1000, actual 202608=1055 (over-estimate
    // corrected into the DRAFT settlement).
    await seedReading('A10-anchor', inst['A10'], meter['A10'], '202606', '2026-06-30', '1000');
    await seedReading('A10-actual', inst['A10'], meter['A10'], '202608', '2026-08-31', '1055');

    // A11 — unbilled-FINAL-in-span gate: anchor 202606=1000, actual 1080.
    await seedReading('A11-anchor', inst['A11'], meter['A11'], '202606', '2026-06-30', '1000');
    await seedReading('A11-actual', inst['A11'], meter['A11'], '202608', '2026-08-31', '1080');

    // A12 — convergence: R0 anchor, R1 first actual (later superseded by
    // a back-dated correction R1s so recon2's anchor precedes the first
    // ADJUSTMENT's period), R2 second actual.
    await seedReading('A12-r0', inst['A12'], meter['A12'], '202606', '2026-06-30', '1000');
    await seedReading('A12-r1', inst['A12'], meter['A12'], '202608', '2026-08-31', '1055');
    await seedReading('A12-r2', inst['A12'], meter['A12'], '202610', '2026-10-31', '1130');

    // A13 — CLOSED account (status flipped inside its test; no readings
    // needed — the CLOSED check precedes every probe).
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

describe('C1 semantics — FINAL-only settled, absorb SETs + rewires the dial', () => {
  it('A10: over-estimated DRAFT corrected in place — settlement := 25 (55−30), NO bill', async () => {
    // 202607 FINAL 30 → billed by its own run (already-billed
    // settlements count toward successCount, so assert the bill itself).
    await seedSettlement('A10-07', acct['A10'], '202607', 30);
    const r = await runAndPost('202607');
    expect(r.status).toBe('POSTED');
    const a10Bills = (await get(`/bills?waterAccountId=${acct['A10']}`)).body;
    expect(a10Bills).toHaveLength(1);
    expect(a10Bills[0]).toMatchObject({ period: '202607', totalAmount: '10000' });

    // 202608 DRAFT estimate 40 (too high) + its ESTIMATE component —
    // the dial chain absorb must rewire.
    await seedSettlement('A10-08', acct['A10'], '202608', 40, 'DRAFT');
    await seedComponent(settle['A10-08'], inst['A10'], '1030', '1070', '40');

    const key = `t11-absorb-${RUN}`;
    const res = await request(app.getHttpServer())
      .post('/reconciliations')
      .set(auth(adminToken))
      .set('Idempotency-Key', key)
      .send({ waterAccountId: acct['A10'] })
      .expect(201);
    recon['A10'] = res.body.id;

    // actualTotal 55, fixedUsage 30 (FINAL only — the DRAFT's 40 is
    // open usage, not settled) → openUsage 25 SET over the estimate 40.
    expect(res.body).toMatchObject({
      waterAccountId: acct['A10'],
      anchorReadingId: reading['A10-anchor'],
      actualReadingId: reading['A10-actual'],
      fromPeriod: '202607',
      toPeriod: '202608',
      actualTotalUsage: '55',
      previouslySettledUsage: '30',
      remainderUsage: '25',
      absorbedSettlementId: settle['A10-08'],
      status: 'ABSORBED',
      adjustmentAmountCent: '0',
      adjustmentBill: null,
    });
    expect((await settlementDetail(settle['A10-08'])).totalUsageQty).toBe('25');

    // I1: the component now carries the REAL dial — next period's
    // prevChain starts at 1055, not the estimate's synthetic 1070.
    const comps = await componentsOf(settle['A10-08']);
    expect(comps).toHaveLength(1);
    expect(comps[0]).toMatchObject({
      installationId: inst['A10'],
      usageQty: '25',
      endReadingValue: '1055',
      sourceType: 'READING',
      sourceReadingId: reading['A10-actual'],
    });

    expect(
      (await get(`/bills?waterAccountId=${acct['A10']}&period=202608`)).body,
    ).toHaveLength(0); // absorb mints no bill

    // Idempotency-Key replay: the stored response returns and the
    // settlement is still 25 — SET semantics make even a re-execution
    // a no-op, and the unique actual guard blocks a second row.
    const replay = await request(app.getHttpServer())
      .post('/reconciliations')
      .set(auth(adminToken))
      .set('Idempotency-Key', key)
      .send({ waterAccountId: acct['A10'] })
      .expect(201);
    expect(replay.body.id).toBe(recon['A10']);
    expect((await settlementDetail(settle['A10-08'])).totalUsageQty).toBe('25');

    const dup = await post('/reconciliations', { waterAccountId: acct['A10'] });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ code: 'RECONCILIATION_EXISTS' });
    expect((await settlementDetail(settle['A10-08'])).totalUsageQty).toBe('25');
  });

  it('A11: FINAL-but-UNBILLED settlement inside the span → 422 RECONCILIATION_UNBILLED_SPAN', async () => {
    // 202608 FINAL 35 billed by its own run; 202607 FINAL 30 seeded
    // AFTER the 202607 runs — FINAL but never billed.
    await seedSettlement('A11-08', acct['A11'], '202608', 35);
    const r = await runAndPost('202608');
    expect(r.status).toBe('POSTED');
    const a11Bills = (await get(`/bills?waterAccountId=${acct['A11']}`)).body;
    expect(a11Bills).toHaveLength(1);
    expect(a11Bills[0]).toMatchObject({ period: '202608', totalAmount: '11500' });
    await seedSettlement('A11-07', acct['A11'], '202607', 30);

    // actual 1080 → openUsage 80−65=+15; S_n (202608) is FINAL so no
    // absorb → adjust → 202607 is FINAL but unbilled → loud 422.
    const res = await post('/reconciliations', { waterAccountId: acct['A11'] });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      code: 'RECONCILIATION_UNBILLED_SPAN',
      period: '202607',
    });
  });

  it('A12: convergence — a prior ADJUSTMENT counts toward the next posted (C2)', async () => {
    // recon1's span: (202606, 202608] = {07, 08} — both FINAL+billed.
    await seedSettlement('A12-07', acct['A12'], '202607', 30);
    const r1 = await runAndPost('202607'); // also bills A11-07, still unbilled
    expect(r1.status).toBe('POSTED');
    await seedSettlement('A12-08', acct['A12'], '202608', 35);
    const r2 = await runAndPost('202608');
    expect(r2.status).toBe('POSTED');
    const a12Posted = new Map(
      (
        (await get(`/bills?waterAccountId=${acct['A12']}`)).body as {
          period: string;
          totalAmount: string;
        }[]
      ).map((b) => [b.period, b.totalAmount]),
    );
    expect(a12Posted.get('202607')).toBe('10000');
    expect(a12Posted.get('202608')).toBe('11500');

    const res1 = await post('/reconciliations', {
      waterAccountId: acct['A12'],
      actualReadingId: reading['A12-r1'],
    }).expect(201);
    recon['A12-1'] = res1.body.id;
    // Same math as A2: correct 18500 − posted 21500 → −3000 on 202608.
    expect(res1.body).toMatchObject({
      status: 'APPLIED',
      postedChargeCent: '21500',
      adjustmentAmountCent: '-3000',
    });
    expect(res1.body.adjustmentBill).toMatchObject({ period: '202608' });

    // Later span settlements + a back-dated superseding correction of
    // R1 (period 202607) so recon2's anchor precedes the ADJUSTMENT's
    // period and the bill lands INSIDE the new span.
    await seedSettlement('A12-09', acct['A12'], '202609', 40);
    await seedSettlement('A12-10', acct['A12'], '202610', 45);
    const r3 = await runAndPost('202609');
    expect(r3.status).toBe('POSTED');
    const r4 = await runAndPost('202610');
    expect(r4.status).toBe('POSTED');
    await seedReading(
      'A12-r1s', inst['A12'], meter['A12'], '202607', '2026-09-15', '1040',
      { supersedes: reading['A12-r1'] },
    );

    // recon2: anchor R1s(202607=1040) → span (202607,202610]={08,09,10},
    // actualTotal 90, fixed 120 → openUsage −30 → adjust. posted =
    // 11500+13000+14500 PLUS the prior ADJUSTMENT −3000 = 36000; without
    // C2 it would be 39000 and the recon would double-correct.
    const res2 = await post('/reconciliations', {
      waterAccountId: acct['A12'],
      actualReadingId: reading['A12-r2'],
    }).expect(201);
    recon['A12-2'] = res2.body.id;
    // allocated 90 over [35,40,45] → [26.25, 30, 33.75]; baseYtd=30 →
    // correct = 8875+10000+11125 = 30000 → adjustment 30000−36000.
    expect(res2.body).toMatchObject({
      status: 'APPLIED',
      anchorReadingId: reading['A12-r1s'],
      fromPeriod: '202608',
      toPeriod: '202610',
      actualTotalUsage: '90',
      previouslySettledUsage: '120',
      remainderUsage: '-30',
      correctChargeCent: '30000',
      postedChargeCent: '36000',
      adjustmentAmountCent: '-6000',
    });
    const detail = (await get(`/bills/${res2.body.adjustmentBill.id}`)).body;
    expect(detail.items).toHaveLength(3);
    const byDesc = new Map(
      detail.items.map((i: { description: string }) => [i.description, i]),
    );
    // 202608's posted side nets NORMAL 11500 + prior ADJUSTMENT −3000.
    expect(byDesc.get('reconcile 202608')).toMatchObject({
      qty: '-8.75', // 26.25 − 35
      amount: '375', // 8875 − (11500 − 3000)
    });
    expect(byDesc.get('reconcile 202609')).toMatchObject({
      qty: '-10',
      amount: '-3000', // 10000 − 13000
    });
    expect(byDesc.get('reconcile 202610')).toMatchObject({
      qty: '-11.25',
      amount: '-3375', // 11125 − 14500
    });
  });
});

describe('ABSORB — open remainder SET onto the DRAFT settlement', () => {
  it('A1: actual 1080 → total 80, fixed 30, openUsage 50 → settlement SET to 50, NO bill', async () => {
    // A1's estimated months — seeded only now so the runs above could
    // not bill them (the absorb path reads unbilled DRAFT/FINAL).
    await seedSettlement('A1-07', acct['A1'], '202607', 30);
    await seedSettlement('A1-08', acct['A1'], '202608', 35, 'DRAFT');
    await seedComponent(settle['A1-08'], inst['A1'], '1030', '1065', '35');

    const res = await post('/reconciliations', { waterAccountId: acct['A1'] }).expect(201);
    recon['A1'] = res.body.id;
    expect(res.body).toMatchObject({
      waterAccountId: acct['A1'],
      anchorReadingId: reading['A1-anchor'],
      actualReadingId: reading['A1-actual'],
      fromPeriod: '202607',
      toPeriod: '202608',
      actualTotalUsage: '80',
      previouslySettledUsage: '30', // FINAL-only: the DRAFT's 35 is open usage
      remainderUsage: '50',
      absorbedSettlementId: settle['A1-08'],
      status: 'ABSORBED',
      adjustmentAmountCent: '0',
      adjustmentBill: null,
    });

    const s = await settlementDetail(settle['A1-08']);
    expect(s.totalUsageQty).toBe('50'); // SET to openUsage, not 35+15

    // Dial chain rewired to the actual: usage 50, end 1080, READING.
    const comps = await componentsOf(settle['A1-08']);
    expect(comps[0]).toMatchObject({
      installationId: inst['A1'],
      usageQty: '50',
      endReadingValue: '1080',
      sourceType: 'READING',
      sourceReadingId: reading['A1-actual'],
    });

    const bills = (await get(`/bills?waterAccountId=${acct['A1']}`)).body;
    expect(bills).toHaveLength(0);
  });

  it('chains a second reconciliation: explicit actualReadingId anchors on the previous actual', async () => {
    // Next month arrives: actual 202609=1130, DRAFT settlement usage 40.
    await seedSettlement('A1-09', acct['A1'], '202609', 40, 'DRAFT');
    await seedComponent(settle['A1-09'], inst['A1'], '1080', '1120', '40');
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
      previouslySettledUsage: '0', // no FINAL settlement in the span
      remainderUsage: '50',
      status: 'ABSORBED',
    });
    const s = await settlementDetail(settle['A1-09']);
    expect(s.totalUsageQty).toBe('50'); // SET to openUsage
    const comps = await componentsOf(settle['A1-09']);
    expect(comps[0]).toMatchObject({
      usageQty: '50',
      endReadingValue: '1130',
      sourceType: 'READING',
      sourceReadingId: reading['A1-actual2'],
    });
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
      previouslySettledUsage: '30', // FINAL-only: the DRAFT's 35 is open usage
      remainderUsage: '-40', // −10 actual − 30 fixed
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

  it('A13: CLOSED account → 409 ACCOUNT_CLOSED before any probe', async () => {
    await owner.query(`UPDATE water_account SET status = 'CLOSED' WHERE id = $1`, [
      acct['A13'],
    ]);
    const res = await post('/reconciliations', { waterAccountId: acct['A13'] });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'ACCOUNT_CLOSED' });
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
