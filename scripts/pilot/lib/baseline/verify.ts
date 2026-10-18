/**
 * G3 baseline verification — READ-ONLY. Runs once at final steady
 * state: structural counts, financial reconciliation, and a direct
 * detectAll() call on the tenant (NOT via WorkItems). Any unexpected
 * fact is printed and the G3 gate goes HOLD — never auto-fixed.
 */

import { apiImport } from '../api-import.ts';
import { apiRequire } from '../pg.ts';
import type { Harness, TenantCtx } from '../harness.ts';
import type { GeneratedAccount } from './flow.ts';

const Pr = apiRequire('@prisma/client') as typeof import('@prisma/client');

export interface VerifyResult {
  checks: { name: string; expected: number; actual: number; pass: boolean }[];
  financial: {
    billTotal: string;
    paymentAllocTotal: string;
    prepaymentAllocTotal: string;
    topUpLedgerTotal: string;
    applyLedgerTotal: string;
    ledgerNet: string;
    openBills: number;
    overAllocatedBills: number;
    orphanAllocs: number;
    pass: boolean;
  };
  unexpectedAnomalies: { type: string; key: string }[];
  /** G4 construction smoke — expected keys injected but NOT produced. */
  missingExpectedAnomalies: { type: string; key: string }[];
  /** G4 RC1 — expected anchor != resolved anchor. */
  anchorMismatches: { key: string; expected: string; actual: string }[];
  /** G4 RC1 — ACCOUNT coveringOrgs != GT orgOwnership. */
  ownershipMismatches: { key: string; expected: string[]; actual: string[] }[];
  pass: boolean;
}

type Tx = { $queryRaw<T>(q: unknown, ...a: unknown[]): Promise<T> };

export interface ExpectedFact {
  type: string;
  key: string;
  anchor: string;
  orgOwnership: string[];
}

export interface VerifyOpts {
  /** G4 expected anomalies — facts matching these keys are not
   *  "unexpected"; anchor + coveringOrgs are cross-checked. */
  expectedAnomalies?: ExpectedFact[];
  /** G4 extra CONVERTED remote events beyond the baseline remote accounts. */
  extraRemoteConverted?: number;
}

export async function verifyBaseline(
  h: Harness,
  ctx: TenantCtx,
  accounts: GeneratedAccount[],
  periods: string[],
  opts: VerifyOpts = {},
): Promise<VerifyResult> {
  const tenantId = ctx.tenantId;
  const waIds = accounts.map((a) => a.waterAccountId);
  const n = accounts.length;
  const nPeriods = periods.length;

  const checks: VerifyResult['checks'] = [];
  const add = (name: string, expected: number, actual: number) =>
    checks.push({ name, expected, actual, pass: expected === actual });

  const q = async <T>(sql: unknown, ...args: unknown[]): Promise<T> =>
    h.tenantPrisma.runAsTenant(tenantId, (tx) =>
      (tx as Tx).$queryRaw<T>(sql, ...args),
    );

  add('water_account', n, await q<{ c: bigint }[]>(
    Pr.Prisma.sql`SELECT count(*) c FROM water_account
      WHERE tenant_id=${tenantId}::uuid AND id=ANY(${waIds}::uuid[])`).then(r => Number(r[0].c)));
  add('active_installation', n, await q<{ c: bigint }[]>(
    Pr.Prisma.sql`SELECT count(*) c FROM meter_installation
      WHERE tenant_id=${tenantId}::uuid AND water_account_id=ANY(${waIds}::uuid[])
        AND status='ACTIVE'`).then(r => Number(r[0].c)));
  add('book_meter', n, await q<{ c: bigint }[]>(
    Pr.Prisma.sql`SELECT count(*) c FROM book_meter
      WHERE tenant_id=${tenantId}::uuid AND water_account_id=ANY(${waIds}::uuid[])`).then(r => Number(r[0].c)));
  add('reading', n * nPeriods, await q<{ c: bigint }[]>(
    Pr.Prisma.sql`SELECT count(*) c FROM meter_reading r
      JOIN reading_plan_item i ON i.id=r.plan_item_id AND i.tenant_id=r.tenant_id
      WHERE r.tenant_id=${tenantId}::uuid AND i.water_account_id=ANY(${waIds}::uuid[])
        AND r.qc_status='PASSED'
        AND NOT EXISTS (SELECT 1 FROM meter_reading s
          WHERE s.tenant_id=r.tenant_id AND s.supersedes_reading_id=r.id)`).then(r => Number(r[0].c)));
  add('settlement_final', n * nPeriods, await q<{ c: bigint }[]>(
    Pr.Prisma.sql`SELECT count(*) c FROM consumption_settlement
      WHERE tenant_id=${tenantId}::uuid AND water_account_id=ANY(${waIds}::uuid[])
        AND status='FINAL' AND total_usage_qty>=0`).then(r => Number(r[0].c)));
  add('bill_posted_or_paid', n * nPeriods, await q<{ c: bigint }[]>(
    Pr.Prisma.sql`SELECT count(*) c FROM bill
      WHERE tenant_id=${tenantId}::uuid AND water_account_id=ANY(${waIds}::uuid[])
        AND status IN ('POSTED','PARTIAL_PAID','PAID')`).then(r => Number(r[0].c)));
  add('remote_converted',
    accounts.filter((a) => a.plan.remote).length * nPeriods
      + (opts.extraRemoteConverted ?? 0),
    await q<{ c: bigint }[]>(
      Pr.Prisma.sql`SELECT count(*) c FROM raw_remote_event
        WHERE tenant_id=${tenantId}::uuid AND processing_status='CONVERTED'`).then(r => Number(r[0].c)));

  // --- financial reconciliation (P1-2 strict) ---
  const fin = await q<{
    bill_total: unknown;
    payment_alloc: unknown;
    prepayment_alloc: unknown;
    topup_ledger: unknown;
    apply_ledger: unknown;
    open_bills: unknown;
    over_alloc: unknown;
    orphan_alloc: unknown;
  }[]>(
    Pr.Prisma.sql`SELECT
      (SELECT sum(total_amount) FROM bill
        WHERE tenant_id=${tenantId}::uuid AND water_account_id=ANY(${waIds}::uuid[])) bill_total,
      (SELECT sum(pa.amount) FROM payment_alloc pa
        JOIN bill b ON b.id=pa.bill_id AND b.tenant_id=pa.tenant_id
        WHERE pa.tenant_id=${tenantId}::uuid AND b.water_account_id=ANY(${waIds}::uuid[])
          AND pa.source='PAYMENT') payment_alloc,
      (SELECT sum(pa.amount) FROM payment_alloc pa
        JOIN bill b ON b.id=pa.bill_id AND b.tenant_id=pa.tenant_id
        WHERE pa.tenant_id=${tenantId}::uuid AND b.water_account_id=ANY(${waIds}::uuid[])
          AND pa.source='PREPAYMENT') prepayment_alloc,
      (SELECT sum(amount) FROM prepayment_ledger_entry
        WHERE tenant_id=${tenantId}::uuid AND type='TOP_UP') topup_ledger,
      (SELECT sum(amount) FROM prepayment_ledger_entry
        WHERE tenant_id=${tenantId}::uuid AND type='APPLY') apply_ledger,
      (SELECT count(*) FROM bill
        WHERE tenant_id=${tenantId}::uuid AND water_account_id=ANY(${waIds}::uuid[])
          AND status IN ('POSTED','PARTIAL_PAID')) open_bills,
      (SELECT count(*) FROM (
          SELECT b.id FROM bill b
          JOIN payment_alloc pa ON pa.bill_id=b.id AND pa.tenant_id=b.tenant_id
          WHERE b.tenant_id=${tenantId}::uuid AND b.water_account_id=ANY(${waIds}::uuid[])
          GROUP BY b.id, b.total_amount
          HAVING sum(pa.amount) > b.total_amount) t) over_alloc,
      (SELECT count(*) FROM payment_alloc pa
        WHERE pa.tenant_id=${tenantId}::uuid
          AND (NOT EXISTS (SELECT 1 FROM bill b
                WHERE b.tenant_id=pa.tenant_id AND b.id=pa.bill_id)
            OR (pa.source='PAYMENT' AND NOT EXISTS (SELECT 1 FROM payment p
                WHERE p.tenant_id=pa.tenant_id AND p.id=pa.payment_id))
            OR (pa.source='PREPAYMENT' AND NOT EXISTS (SELECT 1 FROM prepayment_ledger_entry le
                WHERE le.tenant_id=pa.tenant_id AND le.id=pa.prepayment_entry_id)))) orphan_alloc`,
  );
  const f = fin[0];
  // sum() comes back numeric → Prisma Decimal; normalize to bigint cents
  const bi = (v: unknown) => BigInt(String(v ?? 0));
  const billTotal = bi(f.bill_total);
  const paymentAllocTotal = bi(f.payment_alloc);
  const prepaymentAllocTotal = bi(f.prepayment_alloc);
  const topUpLedgerTotal = bi(f.topup_ledger);
  const applyLedgerTotal = bi(f.apply_ledger); // stored signed (<0)
  const ledgerNet = topUpLedgerTotal + applyLedgerTotal;
  const openBills = Number(f.open_bills ?? 0);
  const overAllocatedBills = Number(f.over_alloc ?? 0);
  const orphanAllocs = Number(f.orphan_alloc ?? 0);
  const financial = {
    billTotal: String(billTotal),
    paymentAllocTotal: String(paymentAllocTotal),
    prepaymentAllocTotal: String(prepaymentAllocTotal),
    topUpLedgerTotal: String(topUpLedgerTotal),
    applyLedgerTotal: String(applyLedgerTotal),
    ledgerNet: String(ledgerNet),
    openBills,
    overAllocatedBills,
    orphanAllocs,
    // frozen clean-baseline invariants
    pass:
      openBills === 0 &&
      billTotal === paymentAllocTotal + prepaymentAllocTotal &&
      prepaymentAllocTotal === -applyLedgerTotal &&
      topUpLedgerTotal > 0n &&
      applyLedgerTotal < 0n &&
      prepaymentAllocTotal > 0n &&
      ledgerNet === 0n &&
      overAllocatedBills === 0 &&
      orphanAllocs === 0,
  };

  // --- E9 detector smoke: detectAll + resolveAnchors, steady state ---
  const det = await apiImport<{
    detectAll(tx: Tx, tenantId: string): Promise<{ type: string; key: string }[]>;
  }>('modules/exception/detectors');
  const scope = await apiImport<{
    resolveAnchors(
      tx: Tx, tenantId: string,
      facts: { type: string; key: string }[],
    ): Promise<
      { key: string; type: string; anchor: string; coveringOrgs: string[] | null }[]
    >;
  }>('modules/exception/scope');
  const anchored = await h.tenantPrisma.runAsTenant(tenantId, async (tx) => {
    const facts = await det.detectAll(tx as Tx, tenantId);
    return scope.resolveAnchors(tx as Tx, tenantId, facts);
  });

  const expectedList = opts.expectedAnomalies ?? [];
  const expected = new Set(expectedList.map((x) => x.key));
  const unexpectedAnomalies = anchored
    .filter((x) => !expected.has(x.key))
    .map((x) => ({ type: x.type, key: x.key }));
  const found = new Map(anchored.map((x) => [x.key, x]));
  const missingExpectedAnomalies: VerifyResult['missingExpectedAnomalies'] = [];
  const anchorMismatches: VerifyResult['anchorMismatches'] = [];
  const ownershipMismatches: VerifyResult['ownershipMismatches'] = [];
  const sorted = (a: string[]) => [...a].sort();
  for (const e of expectedList) {
    const f = found.get(e.key);
    if (!f) {
      missingExpectedAnomalies.push({ type: e.type, key: e.key });
      continue;
    }
    if (f.type !== e.type)
      anchorMismatches.push({ key: e.key, expected: `type:${e.type}`, actual: `type:${f.type}` });
    if (f.anchor !== e.anchor)
      anchorMismatches.push({ key: e.key, expected: e.anchor, actual: f.anchor });
    // ownership comparison only where a covering set is defined:
    // ACCOUNT anchor → coveringOrgs must equal GT orgOwnership.
    if (e.anchor === 'ACCOUNT' && f.anchor === 'ACCOUNT') {
      const exp = sorted(e.orgOwnership);
      const act = sorted(f.coveringOrgs ?? []);
      if (exp.join(',') !== act.join(','))
        ownershipMismatches.push({ key: e.key, expected: exp, actual: act });
    }
  }
  for (const a of unexpectedAnomalies)
    console.log(`  UNEXPECTED ANOMALY ${a.type} ${a.key}`);
  for (const a of missingExpectedAnomalies)
    console.log(`  MISSING EXPECTED   ${a.type} ${a.key}`);
  for (const a of anchorMismatches)
    console.log(`  ANCHOR MISMATCH    ${a.key} expected=${a.expected} actual=${a.actual}`);
  for (const a of ownershipMismatches)
    console.log(`  OWNERSHIP MISMATCH ${a.key} expected=[${a.expected.join(',')}] actual=[${a.actual.join(',')}]`);
  const pass =
    checks.every((c) => c.pass) &&
    financial.pass &&
    !unexpectedAnomalies.length &&
    !missingExpectedAnomalies.length &&
    !anchorMismatches.length &&
    !ownershipMismatches.length;
  return {
    checks, financial, unexpectedAnomalies, missingExpectedAnomalies,
    anchorMismatches, ownershipMismatches, pass,
  };
}
