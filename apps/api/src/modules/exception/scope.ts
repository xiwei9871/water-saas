import type { Prisma } from '@prisma/client';
import type { TenantCtx } from '../../common/tenant-context.js';
import type { AnomalyFact } from './types.js';

/**
 * E9 anomaly visibility (D5/D12/D21) — operational OWNERSHIP, deliberately
 * stricter than E8 read scope: an off-book account's anomalies are
 * TENANT-anchored (no determinable branch owner), never broadcast to every
 * branch just because E8 read is permissive.
 *
 * Anchor resolution:
 *   fact.waterAccountId → current BookMeter count
 *     = 0 → TENANT (ctx.scope === 'ALL' only)
 *     ≥ 1 → ACCOUNT: every covering book's orgUnit must sit inside caller
 *           orgScope (fail closed if any covering book is out of scope)
 *   fact.remoteSourceId → remote_source.orgUnitId ∈ orgScope; null → TENANT
 *   neither → TENANT
 */

export interface AnchoredFact extends AnomalyFact {
  anchor: 'ACCOUNT' | 'TENANT' | 'REMOTE_SOURCE';
  /** covering org units for ACCOUNT anchor; [orgUnitId] or [] for
   *  REMOTE_SOURCE (empty = tenant-wide source); null for TENANT */
  coveringOrgs: string[] | null;
}

/** One batch resolution: BookMeter counts + covering orgs + source orgs. */
export async function resolveAnchors(
  tx: Prisma.TransactionClient,
  tenantId: string,
  facts: AnomalyFact[],
): Promise<AnchoredFact[]> {
  const accountIds = [...new Set(facts.map((f) => f.waterAccountId).filter((x): x is string => !!x))];
  const sourceIds = [...new Set(facts.map((f) => f.remoteSourceId).filter((x): x is string => !!x))];

  // current BookMeter is the ONLY ownership SoT (D12/D24): historical
  // reading_plan_item rows must NOT widen coverage — a stale plan item on an
  // out-of-scope book would otherwise hide the anomaly from its true owner.
  const bookCounts = new Map<string, number>();
  const covering = new Map<string, Set<string>>();
  if (accountIds.length) {
    const bm = await tx.$queryRaw<{ water_account_id: string; org_unit_id: string }[]>`
      SELECT bm.water_account_id::text, rb.org_unit_id::text
      FROM book_meter bm
      JOIN reading_book rb ON rb.tenant_id = bm.tenant_id AND rb.id = bm.book_id
      WHERE bm.tenant_id = ${tenantId}::uuid
        AND bm.water_account_id = ANY(${accountIds}::uuid[])`;
    for (const r of bm) {
      bookCounts.set(r.water_account_id, (bookCounts.get(r.water_account_id) ?? 0) + 1);
      let s = covering.get(r.water_account_id);
      if (!s) covering.set(r.water_account_id, (s = new Set()));
      s.add(r.org_unit_id);
    }
  }

  const sourceOrgs = new Map<string, string | null>();
  if (sourceIds.length) {
    const src = await tx.remoteSource.findMany({
      where: { tenantId, id: { in: sourceIds } },
      select: { id: true, orgUnitId: true },
    });
    for (const s of src) sourceOrgs.set(s.id, s.orgUnitId);
  }

  return facts.map((f) => {
    if (f.waterAccountId) {
      const count = bookCounts.get(f.waterAccountId) ?? 0;
      return {
        ...f,
        anchor: count === 0 ? 'TENANT' : 'ACCOUNT',
        coveringOrgs: count === 0 ? null : [...(covering.get(f.waterAccountId) ?? [])],
      } satisfies AnchoredFact;
    }
    if (f.remoteSourceId) {
      const org = sourceOrgs.get(f.remoteSourceId);
      return {
        ...f,
        anchor: 'REMOTE_SOURCE',
        coveringOrgs: org ? [org] : [],
      } satisfies AnchoredFact;
    }
    return { ...f, anchor: 'TENANT', coveringOrgs: null } satisfies AnchoredFact;
  });
}

type ScopeLike = { scope: TenantCtx['scope']; orgScope: string[] };

/** visibility predicate for one anchored fact against a scope. */
export function anchoredVisible(f: AnchoredFact, who: ScopeLike): boolean {
  if (who.scope === 'ALL') return true;
  switch (f.anchor) {
    case 'TENANT':
      return false; // ownership-less — tenant-level only (D12)
    case 'REMOTE_SOURCE':
      // empty coveringOrgs = tenant-wide source → tenant-level only
      return f.coveringOrgs !== null && f.coveringOrgs.length > 0 &&
        f.coveringOrgs.every((o) => who.orgScope.includes(o));
    case 'ACCOUNT':
      return (f.coveringOrgs ?? []).length > 0 &&
        f.coveringOrgs!.every((o) => who.orgScope.includes(o));
  }
}

export async function filterVisible(
  tx: Prisma.TransactionClient,
  ctx: TenantCtx,
  facts: AnomalyFact[],
): Promise<AnchoredFact[]> {
  const anchored = await resolveAnchors(tx, ctx.tenantId, facts);
  if (ctx.scope === 'ALL') return anchored;
  return anchored.filter((f) => anchoredVisible(f, ctx));
}

/** single-fact visibility for write-path checks (caller + assignee). */
export async function factVisibleTo(
  tx: Prisma.TransactionClient,
  tenantId: string,
  fact: AnomalyFact,
  who: ScopeLike,
): Promise<boolean> {
  if (who.scope === 'ALL') return true;
  const [anchored] = await resolveAnchors(tx, tenantId, [fact]);
  return !!anchored && anchoredVisible(anchored, who);
}

/**
 * Object-level anchor resolution from a parsed anomaly KEY — independent
 * of whether the fact currently holds. Needed on write paths that run
 * after the fact disappears (resolve, episode ops on history) where the
 * scope must come from the underlying business object, not the anomaly.
 */
export async function objectAnchorTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  parsed: { kind: string; id: string; type?: string },
): Promise<AnchoredFact | null> {
  let fact: AnomalyFact | null = null;
  switch (parsed.kind) {
    case 'wa':
      fact = { key: '', type: '', severity: 'WARNING', waterAccountId: parsed.id, anchorRef: { kind: 'water-account', id: parsed.id }, summary: '' };
      break;
    case 'bill': {
      const b = await tx.bill.findFirst({ where: { tenantId, id: parsed.id }, select: { waterAccountId: true } });
      if (b) fact = { key: '', type: '', severity: 'WARNING', waterAccountId: b.waterAccountId, anchorRef: { kind: 'bill', id: parsed.id }, summary: '' };
      break;
    }
    case 'reading': {
      const r = await tx.meterReading.findFirst({
        where: { tenantId, id: parsed.id },
        select: { installation: { select: { waterAccountId: true } } },
      });
      if (r) fact = { key: '', type: '', severity: 'WARNING', waterAccountId: r.installation.waterAccountId, anchorRef: { kind: 'reading', id: parsed.id }, summary: '' };
      break;
    }
    case 'event': {
      const e = await tx.rawRemoteEvent.findFirst({
        where: { tenantId, id: parsed.id },
        select: {
          remoteSourceId: true,
          resolvedBinding: { select: { installation: { select: { waterAccountId: true } } } },
        },
      });
      if (e) {
        const wa = e.resolvedBinding?.installation.waterAccountId;
        // D21: REMOTE_SOURCE only for UNBOUND / KEY_CONFLICT keys; resolved-
        // account anomaly types fall to TENANT when the account is gone.
        const sourceAnchored =
          parsed.type === 'REMOTE_EVENT_UNBOUND' ||
          parsed.type === 'REMOTE_EVENT_KEY_CONFLICT';
        fact = wa
          ? { key: '', type: '', severity: 'WARNING', waterAccountId: wa, anchorRef: { kind: 'remote-event', id: parsed.id }, summary: '' }
          : sourceAnchored
            ? { key: '', type: '', severity: 'WARNING', remoteSourceId: e.remoteSourceId, anchorRef: { kind: 'remote-event', id: parsed.id }, summary: '' }
            : { key: '', type: '', severity: 'WARNING', anchorRef: { kind: 'remote-event', id: parsed.id }, summary: '' };
      }
      break;
    }
    case 'settle':
      // settle-anchored anomalies: strict settle scope is applied by the
      // caller via outOfScopeSettleAccountIds; represented as TENANT here
      // because no V1 detector produces SETTLE-anchor queue items.
      return null;
  }
  if (!fact) return null;
  const [anchored] = await resolveAnchors(tx, tenantId, [fact]);
  return anchored ?? null;
}
