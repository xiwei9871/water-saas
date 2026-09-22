import { Prisma } from '@prisma/client';
import type { TenantCtx } from './tenant-context.js';

/**
 * E10 ACCOUNT_AGGREGATION_OWNERSHIP (D24) — dashboard 聚合归属，刻意独立于
 * E8 ACCOUNT_READ_SCOPE（读宽放）。只读 helper，不产出任何写。
 *
 *   current BookMeter count = 0  → UNASSIGNED/TENANT
 *     → scoped branch aggregate 一律排除（同一 off-book 户不得计入多个所）
 *     → tenant aggregate（scope=ALL）计入
 *   count ≥ 1 → 全部覆盖册 orgUnitId ∈ caller orgScope → 计入且仅一次；
 *     任一覆盖册出 scope → 排除（fail closed）
 *
 * WaterAccount-anchor 指标一律先取本集合再做 SQL 过滤。ReadingBook /
 * Payment.orgUnitId / RemoteSource.orgUnitId anchor 的指标不使用本 helper。
 */

/** accountId → 当前覆盖册的 orgUnitId 集合（BookMeter 唯一 SoT）。 */
export async function loadCoveringOrgsTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  accountIds?: string[],
): Promise<Map<string, Set<string>>> {
  const rows = await tx.$queryRaw<
    { water_account_id: string; org_unit_id: string }[]
  >`
    SELECT bm.water_account_id::text, rb.org_unit_id::text
    FROM book_meter bm
    JOIN reading_book rb
      ON rb.tenant_id = bm.tenant_id AND rb.id = bm.book_id
    WHERE bm.tenant_id = ${tenantId}::uuid
      ${accountIds?.length ? Prisma.sql`AND bm.water_account_id = ANY(${accountIds}::uuid[])` : Prisma.empty}`;
  const map = new Map<string, Set<string>>();
  for (const r of rows) {
    let s = map.get(r.water_account_id);
    if (!s) map.set(r.water_account_id, (s = new Set()));
    s.add(r.org_unit_id);
  }
  return map;
}

/** 单户判定：ALL → true；scoped → ≥1 覆盖册且全部在 orgScope 内。 */
export function aggregationInScope(
  coveringOrgs: Set<string> | undefined,
  ctx: Pick<TenantCtx, 'scope' | 'orgScope'>,
): boolean {
  if (ctx.scope === 'ALL') return true;
  if (!coveringOrgs || coveringOrgs.size === 0) return false; // off-book → TENANT only
  for (const org of coveringOrgs) {
    if (!ctx.orgScope.includes(org)) return false; // fail closed
  }
  return true;
}

/**
 * SQL 过滤入口：返回 scoped 可见的 WaterAccount id 数组；
 * `null` 表示 caller 是 ALL scope —— 不加谓词（tenant 汇总自然含 off-book）。
 */
export async function aggregationScopeAccountIds(
  tx: Prisma.TransactionClient,
  ctx: Pick<TenantCtx, 'tenantId' | 'scope' | 'orgScope'>,
): Promise<string[] | null> {
  if (ctx.scope === 'ALL') return null;
  const covering = await loadCoveringOrgsTx(tx, ctx.tenantId);
  const ids: string[] = [];
  for (const [id, orgs] of covering) {
    if (aggregationInScope(orgs, ctx)) ids.push(id);
  }
  return ids;
}

/** 拼 SQL 片段：WaterAccount 列按 AGG_OWN 过滤。`null` → 不加条件。 */
export function aggOwnPredicate(
  inScope: string[] | null,
  column: Prisma.Sql,
): Prisma.Sql {
  if (inScope === null) return Prisma.empty;
  if (inScope.length === 0) return Prisma.sql`AND false`; // 租户无任何可见户
  return Prisma.sql`AND ${column} = ANY(${inScope}::uuid[])`;
}
