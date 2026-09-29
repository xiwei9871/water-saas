import type { Prisma } from '@prisma/client';

/**
 * Round-2 report §4/§9: operational documents carry their account's
 * display identity inline — accountNo + customerName are part of the
 * business record (settlement / bill / reconciliation / billing-run
 * bill), not gated on `customer:read`. Without this, any role lacking
 * customer:read degrades to raw uuids in every list (综合核查 saw
 * "10d9cc06… / —"). One batched lookup per response, no N+1.
 *
 * customerName stays null only when the row's account is somehow
 * missing (should not happen — FK'd); callers render '—' then.
 */
export async function embedAccountIdentity<
  T extends { waterAccountId?: string | null },
>(
  tx: Prisma.TransactionClient,
  tenantId: string,
  rows: T[],
): Promise<(T & { accountNo: string | null; customerName: string | null })[]> {
  if (rows.length === 0) return rows.map((r) => ({ ...r, accountNo: null, customerName: null }));
  const ids = [
    ...new Set(
      rows.map((r) => r.waterAccountId).filter((v): v is string => typeof v === 'string'),
    ),
  ];
  const accounts = ids.length
    ? await tx.waterAccount.findMany({
        where: { tenantId, id: { in: ids } },
        select: {
          id: true,
          accountNo: true,
          customer: { select: { name: true } },
        },
      })
    : [];
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return rows.map((r) => {
    const acc = r.waterAccountId ? byId.get(r.waterAccountId) : undefined;
    return {
      ...r,
      accountNo: acc?.accountNo ?? null,
      customerName: acc?.customer.name ?? null,
    };
  });
}
