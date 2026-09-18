import { AsyncLocalStorage } from 'node:async_hooks';

/** Per-request tenant context populated by auth middleware/guard. */
export interface TenantCtx {
  tenantId: string;
  staffId: string;
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
