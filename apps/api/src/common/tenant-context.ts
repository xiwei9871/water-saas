import { AsyncLocalStorage } from 'node:async_hooks';

/** Per-request tenant context populated by auth middleware/guard. */
export interface TenantCtx {
  tenantId: string;
  staffId: string;
  /** Widest data scope across the staff's roles (from role.data_scope). */
  scope: 'ALL' | 'ORG_SUBTREE' | 'SELF';
  /** org_unit ids the staff may see (derived from role.data_scope). */
  orgScope: string[];
}

export const als = new AsyncLocalStorage<TenantCtx>();

export const withTenant = <T>(ctx: TenantCtx, fn: () => T): T => als.run(ctx, fn);

export const currentTenant = (): TenantCtx => {
  const c = als.getStore();
  if (!c) throw new Error('tenant context missing');
  return c;
};

/**
 * Write-path org guard (I1): a non-ALL caller may only mutate rows whose
 * org_unit lives inside ctx.orgScope. ALL scope bypasses the check.
 */
export const orgInScope = (
  ctx: TenantCtx,
  orgUnitId: string | null | undefined,
): boolean =>
  ctx.scope === 'ALL' || (orgUnitId != null && ctx.orgScope.includes(orgUnitId));
