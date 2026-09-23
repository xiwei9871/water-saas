import type { Prisma } from '@prisma/client';

/** Widest data_scope across a staff's roles (ALL > ORG_SUBTREE > SELF). */
export function widestScope(roles: { dataScope: string }[]): 'ALL' | 'ORG_SUBTREE' | 'SELF' {
  if (roles.some((r) => r.dataScope === 'ALL')) return 'ALL';
  if (roles.some((r) => r.dataScope === 'ORG_SUBTREE')) return 'ORG_SUBTREE';
  return 'SELF';
}

/**
 * org_unit ids a scope covers. SELF = own unit only; ORG_SUBTREE = own
 * unit + descendants (UNION dedupe so an org-tree cycle can't loop);
 * ALL = every org unit in the tenant.
 */
export async function computeOrgScopeTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  orgUnitId: string,
  scope: 'ALL' | 'ORG_SUBTREE' | 'SELF',
): Promise<string[]> {
  if (scope === 'SELF') return [orgUnitId];
  if (scope === 'ALL') {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM org_unit WHERE tenant_id = ${tenantId}::uuid`;
    return rows.map((r) => r.id);
  }
  const rows = await tx.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE sub AS (
      SELECT id FROM org_unit WHERE tenant_id = ${tenantId}::uuid AND id = ${orgUnitId}::uuid
      UNION
      SELECT o.id FROM org_unit o
      JOIN sub s ON o.parent_id = s.id AND o.tenant_id = ${tenantId}::uuid
    )
    SELECT id::text AS id FROM sub`;
  return rows.map((r) => r.id);
}

/**
 * Effective scope of ANOTHER staff member (assignee checks — E9): the
 * caller's ctx describes the caller; this resolves the target staff's
 * own scope so visibility predicates can be re-run against it.
 */
export async function staffScopeTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  staffId: string,
): Promise<{ scope: 'ALL' | 'ORG_SUBTREE' | 'SELF'; orgScope: string[] } | null> {
  const staff = await tx.staff.findFirst({
    where: { tenantId, id: staffId, status: 'ACTIVE' },
    select: { orgUnitId: true },
  });
  if (!staff) return null;
  const links = await tx.staffRole.findMany({ where: { tenantId, staffId } });
  const roles = await tx.role.findMany({
    where: { tenantId, id: { in: links.map((l) => l.roleId) } },
    select: { dataScope: true },
  });
  const scope = widestScope(roles);
  const orgScope = await computeOrgScopeTx(tx, tenantId, staff.orgUnitId, scope);
  return { scope, orgScope };
}
