/**
 * D4 — transaction ownership registry. Pure data: the single place that
 * decides whether a service entry point owns its transaction or expects
 * the caller's. Registered lazily per service at G2; extended as G3/G4
 * onboard more flows. Frozen rule: never nested runAsTenant.
 */

export type TxOwnership = 'TX_CALLER_MANAGED' | 'TX_SELF_MANAGED';

/**
 * 'ServiceClass.method' → ownership.
 *  CALLER_MANAGED: *Tx(tx, ctx, dto) — wrap in runAsTenant.
 *  SELF_MANAGED:   service opens its own runAsTenant/tx per unit —
 *                  call directly, NEVER wrap.
 */
export const TX_REGISTRY: Readonly<Record<string, TxOwnership>> = {
  // customer / metering write paths (caller-managed *Tx signatures)
  'WaterAccountService.onboardTx': 'TX_CALLER_MANAGED',
  'WaterAccountService.createTx': 'TX_CALLER_MANAGED',
  'WaterAccountService.updateTx': 'TX_CALLER_MANAGED',
  'MeterInstallationService.installTx': 'TX_CALLER_MANAGED',
  'MeterInstallationService.removeTx': 'TX_CALLER_MANAGED',
  'ReadingBookService.addMemberTx': 'TX_CALLER_MANAGED',
  'ReadingBookService.removeMemberTx': 'TX_CALLER_MANAGED',
  // remote ingest manages one transaction PER EVENT internally
  'RemoteEventService.ingestOne': 'TX_SELF_MANAGED',
  'RemoteEventService.ingestBatch': 'TX_SELF_MANAGED',
  'RemoteEventService.replay': 'TX_SELF_MANAGED',
} as const;

export class OwnershipError extends Error {}

/**
 * Guard used by withTenantTx: refuses to wrap anything registered (or
 * assumed) SELF_MANAGED. The default for UNKNOWN entries is to refuse —
 * caller must register the method first. fail-closed by design.
 */
export function assertCallerManaged(serviceMethod: string): void {
  const o = TX_REGISTRY[serviceMethod];
  if (o === 'TX_SELF_MANAGED') {
    throw new OwnershipError(
      `${serviceMethod} is TX_SELF_MANAGED — wrapping it in runAsTenant would nest transactions (forbidden by D4)`,
    );
  }
  if (o !== 'TX_CALLER_MANAGED') {
    throw new OwnershipError(
      `${serviceMethod} is not in TX_REGISTRY — register its transaction ownership before wrapping (fail-closed)`,
    );
  }
}
