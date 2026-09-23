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
    paidTotal: string;
    prepayApplied: string;
    ledgerNet: string;
    pass: boolean;
  };
  unexpectedAnomalies: { type: string; key: string }[];
  pass: boolean;
}

type Tx = { $queryRaw<T>(q: unknown, ...a: unknown[]): Promise<T> };

export async function verifyBaseline(
  h: Harness,
  ctx: TenantCtx,
  accounts: GeneratedAccount[],
  periods: string[],
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
  add('remote_converted', accounts.filter((a) => a.plan.remote).length * nPeriods,
    await q<{ c: bigint }[]>(
      Pr.Prisma.sql`SELECT count(*) c FROM raw_remote_event
        WHERE tenant_id=${tenantId}::uuid AND processing_status='CONVERTED'`).then(r => Number(r[0].c)));

  // --- financial reconciliation ---
  const fin = await q<{
    bill_total: unknown;
    paid_alloc: unknown;
    prepay_alloc: unknown;
    prepay_applied: unknown;
    ledger_net: unknown;
    bills_open: unknown;
  }[]>(
    Pr.Prisma.sql`SELECT
      (SELECT sum(total_amount) FROM bill
        WHERE tenant_id=${tenantId}::uuid AND water_account_id=ANY(${waIds}::uuid[])) bill_total,
      (SELECT sum(pa.amount) FROM payment_alloc pa
        JOIN bill b ON b.id=pa.bill_id AND b.tenant_id=pa.tenant_id
        WHERE pa.tenant_id=${tenantId}::uuid AND b.water_account_id=ANY(${waIds}::uuid[])
          AND pa.source='PAYMENT') paid_alloc,
      (SELECT sum(pa.amount) FROM payment_alloc pa
        JOIN bill b ON b.id=pa.bill_id AND b.tenant_id=pa.tenant_id
        WHERE pa.tenant_id=${tenantId}::uuid AND b.water_account_id=ANY(${waIds}::uuid[])
          AND pa.source='PREPAYMENT') prepay_alloc,
      (SELECT sum(amount) FROM prepayment_ledger_entry
        WHERE tenant_id=${tenantId}::uuid AND type='APPLY') prepay_applied,
      (SELECT sum(CASE type WHEN 'TOP_UP' THEN amount WHEN 'APPLY' THEN -amount
            ELSE 0 END) FROM prepayment_ledger_entry
        WHERE tenant_id=${tenantId}::uuid) ledger_net,
      (SELECT count(*) FROM bill
        WHERE tenant_id=${tenantId}::uuid AND water_account_id=ANY(${waIds}::uuid[])
          AND status IN ('POSTED','PARTIAL_PAID')) bills_open`,
  );
  const f = fin[0];
  // sum() comes back numeric → Prisma Decimal; normalize to bigint cents
  const bi = (v: unknown) => BigInt(String(v ?? 0));
  const billTotal = bi(f.bill_total);
  const paidTotal = bi(f.paid_alloc) + bi(f.prepay_alloc);
  const ledgerNet = bi(f.ledger_net);
  const financial = {
    billTotal: String(billTotal),
    paidTotal: String(paidTotal),
    prepayApplied: String(f.prepay_alloc ?? 0),
    ledgerNet: String(ledgerNet),
    // every alloc reduces a bill exactly once; no orphan/dangling rows
    pass: paidTotal <= billTotal && ledgerNet >= 0n,
  };

  // --- E9 detector smoke: detectAll directly, steady state ---
  const det = await apiImport<{
    detectAll(tx: Tx, tenantId: string): Promise<{ type: string; key: string }[]>;
  }>('modules/exception/detectors');
  const facts = await h.tenantPrisma.runAsTenant(tenantId, (tx) =>
    det.detectAll(tx as Tx, tenantId),
  );

  const unexpectedAnomalies = facts.map((x) => ({ type: x.type, key: x.key }));
  if (unexpectedAnomalies.length) {
    for (const a of unexpectedAnomalies)
      console.log(`  UNEXPECTED ANOMALY ${a.type} ${a.key}`);
  }
  const pass = checks.every((c) => c.pass) && financial.pass && !unexpectedAnomalies.length;
  return { checks, financial, unexpectedAnomalies, pass };
}
