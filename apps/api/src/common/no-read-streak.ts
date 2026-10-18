import type { Prisma } from '@prisma/client';

/**
 * 连续未抄见期数（Round-2 报告 §10）— per-reading trailing count of
 * consecutive no-read PERIODS for the account, ending AT that row's
 * period. Mirrors estimateStreaksTx semantics: a month with no reading
 * at all does not reset the streak (the meter still wasn't actually
 * read). A period counts as read when ANY non-superseded ACTUAL/REMOTE
 * row exists for it — a later real retry cures the same period even if
 * the earlier NO_READ row was never formally superseded.
 *
 * One grouped query per request — not per row.
 */
export async function noReadStreaksTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  refs: { waterAccountId: string; period: string }[],
): Promise<Map<string, number>> {
  const accountIds = [...new Set(refs.map((r) => r.waterAccountId))];
  const out = new Map<string, number>();
  if (accountIds.length === 0) return out;
  const rows = await tx.$queryRaw<
    { water_account_id: string; period: string; result_type: string }[]
  >`
    SELECT mi.water_account_id::text, r.period, r.result_type::text
    FROM meter_reading r
    JOIN meter_installation mi
      ON mi.tenant_id = r.tenant_id AND mi.id = r.installation_id
    WHERE r.tenant_id = ${tenantId}::uuid
      AND mi.water_account_id = ANY(${accountIds}::uuid[])
      AND NOT EXISTS (
        SELECT 1 FROM meter_reading child
        WHERE child.tenant_id = r.tenant_id
          AND child.supersedes_reading_id = r.id
      )
    ORDER BY mi.water_account_id, r.period`;
  // Per account: period → was actually read?
  const readPeriods = new Map<string, Map<string, boolean>>();
  const orderedPeriods = new Map<string, string[]>();
  for (const r of rows) {
    let acc = readPeriods.get(r.water_account_id);
    let order = orderedPeriods.get(r.water_account_id);
    if (!acc) {
      acc = new Map();
      order = [];
      readPeriods.set(r.water_account_id, acc);
      orderedPeriods.set(r.water_account_id, order!);
    }
    if (!acc.has(r.period)) order!.push(r.period);
    const wasRead = acc.get(r.period) ?? false;
    acc.set(r.period, wasRead || r.result_type !== 'NO_READ');
  }
  for (const ref of refs) {
    const acc = readPeriods.get(ref.waterAccountId);
    const order = orderedPeriods.get(ref.waterAccountId) ?? [];
    let streak = 0;
    if (acc?.get(ref.period) === false) {
      // ref.period itself is a no-read period — walk back over periods
      // that have readings; missing months don't reset (unsettled month
      // ≠ read month, same rule as estimate streaks).
      const idx = order.lastIndexOf(ref.period);
      for (let i = idx; i >= 0; i--) {
        if (acc.get(order[i]) === false) streak += 1;
        else break;
      }
    }
    out.set(`${ref.waterAccountId}:${ref.period}`, streak);
  }
  return out;
}
