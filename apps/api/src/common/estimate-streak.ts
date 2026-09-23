import type { Prisma } from '@prisma/client';

/**
 * Per-settlement trailing count of consecutive estimated settlements —
 * the 补抄台账 counter (spec §2.3; the `max_consecutive_estimates`
 * threshold is evaluated by consumers, not here). Measured over the
 * account's settlement rows ordered by period; a missing (unsettled)
 * month does not reset the streak — the meter still wasn't actually read.
 *
 * Shared SoT helper (E9): SettlementService.attachDetails and the
 * exception ESTIMATE_STREAK detector must agree on streak math — single
 * implementation, do not copy.
 */
export async function estimateStreaksTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  waterAccountIds: string[],
): Promise<Map<string, number>> {
  const rows = await tx.consumptionSettlement.findMany({
    where: { tenantId, waterAccountId: { in: waterAccountIds } },
    select: { id: true, waterAccountId: true, period: true, isEstimated: true },
    orderBy: [{ waterAccountId: 'asc' }, { period: 'asc' }],
  });
  const streak = new Map<string, number>();
  const run = new Map<string, number>();
  for (const r of rows) {
    const cur = r.isEstimated ? (run.get(r.waterAccountId) ?? 0) + 1 : 0;
    run.set(r.waterAccountId, cur);
    streak.set(r.id, cur);
  }
  return streak;
}

/**
 * Per-account CURRENT estimate streak: streak value of the account's
 * latest settlement (0 when none / latest not estimated). Derived from
 * estimateStreaksTx — same underlying rows.
 */
export async function accountEstimateStreaksTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  waterAccountIds: string[],
): Promise<Map<string, number>> {
  const rows = await tx.consumptionSettlement.findMany({
    where: { tenantId, waterAccountId: { in: waterAccountIds } },
    select: { waterAccountId: true, period: true, isEstimated: true },
    orderBy: [{ waterAccountId: 'asc' }, { period: 'asc' }],
  });
  const run = new Map<string, number>();
  for (const r of rows) {
    run.set(r.waterAccountId, r.isEstimated ? (run.get(r.waterAccountId) ?? 0) + 1 : 0);
  }
  return run;
}
