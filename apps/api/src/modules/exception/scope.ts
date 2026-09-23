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
  /** current covering BookMeter book ids — ACCOUNT anchor only, else null.
   *  Used by the bookId list filter (A1): never widens visibility, only
   *  narrows an already-visible ACCOUNT anomaly. */
  coveringBookIds: string[] | null;
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
  const coveringBooks = new Map<string, Set<string>>();
  if (accountIds.length) {
    const bm = await tx.$queryRaw<{ water_account_id: string; org_unit_id: string; book_id: string }[]>`
      SELECT bm.water_account_id::text, rb.org_unit_id::text, bm.book_id::text
      FROM book_meter bm
      JOIN reading_book rb ON rb.tenant_id = bm.tenant_id AND rb.id = bm.book_id
      WHERE bm.tenant_id = ${tenantId}::uuid
        AND bm.water_account_id = ANY(${accountIds}::uuid[])`;
    for (const r of bm) {
      bookCounts.set(r.water_account_id, (bookCounts.get(r.water_account_id) ?? 0) + 1);
      let s = covering.get(r.water_account_id);
      if (!s) covering.set(r.water_account_id, (s = new Set()));
      s.add(r.org_unit_id);
      let b = coveringBooks.get(r.water_account_id);
      if (!b) coveringBooks.set(r.water_account_id, (b = new Set()));
      b.add(r.book_id);
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
        coveringBookIds: count === 0 ? null : [...(coveringBooks.get(f.waterAccountId) ?? [])],
      } satisfies AnchoredFact;
    }
    if (f.remoteSourceId) {
      const org = sourceOrgs.get(f.remoteSourceId);
      return {
        ...f,
        anchor: 'REMOTE_SOURCE',
        coveringOrgs: org ? [org] : [],
        coveringBookIds: null,
      } satisfies AnchoredFact;
    }
    return { ...f, anchor: 'TENANT', coveringOrgs: null, coveringBookIds: null } satisfies AnchoredFact;
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
        // D21 — anchor by anomaly TYPE first: UNBOUND / KEY_CONFLICT
        // episodes belong to the remote source forever, even if the
        // event later gains a resolvedBinding. Other remote types
        // anchor to the resolved account; unresolved → TENANT.
        const sourceAnchored =
          parsed.type === 'REMOTE_EVENT_UNBOUND' ||
          parsed.type === 'REMOTE_EVENT_KEY_CONFLICT';
        const wa = e.resolvedBinding?.installation.waterAccountId;
        fact = sourceAnchored
          ? { key: '', type: '', severity: 'WARNING', remoteSourceId: e.remoteSourceId, anchorRef: { kind: 'remote-event', id: parsed.id }, summary: '' }
          : wa
            ? { key: '', type: '', severity: 'WARNING', waterAccountId: wa, anchorRef: { kind: 'remote-event', id: parsed.id }, summary: '' }
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

/**
 * Batch variant of objectAnchorTx — one query per object kind, then a single
 * resolveAnchors over the collected minimal facts. Used by summary() where
 * per-key resolution would N+1 under a busy day of episodes.
 * Keys whose object can't be resolved map to `null` (caller treats as
 * TENANT-level → ALL scope only).
 */
export async function objectAnchorsBatchTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  keys: { kind: string; id: string; type?: string }[],
): Promise<Map<number, AnchoredFact | null>> {
  const facts: (AnomalyFact | null)[] = Array.from({ length: keys.length }, () => null);
  const idxBy = (kind: string) =>
    keys.map((k, i) => ({ k, i })).filter(({ k }) => k.kind === kind);

  // wa:{accountId}:* — direct account anchor
  for (const { i } of idxBy('wa')) {
    facts[i] = {
      key: '', type: '', severity: 'WARNING', waterAccountId: keys[i].id,
      anchorRef: { kind: 'water-account', id: keys[i].id }, summary: '',
    };
  }

  const billIdx = idxBy('bill');
  if (billIdx.length) {
    const rows = await tx.bill.findMany({
      where: { tenantId, id: { in: billIdx.map(({ k }) => k.id) } },
      select: { id: true, waterAccountId: true },
    });
    const m = new Map(rows.map((r) => [r.id, r.waterAccountId]));
    for (const { k, i } of billIdx) {
      const wa = m.get(k.id);
      if (wa) {
        facts[i] = {
          key: '', type: '', severity: 'WARNING', waterAccountId: wa,
          anchorRef: { kind: 'bill', id: k.id }, summary: '',
        };
      }
    }
  }

  const readingIdx = idxBy('reading');
  if (readingIdx.length) {
    const rows = await tx.meterReading.findMany({
      where: { tenantId, id: { in: readingIdx.map(({ k }) => k.id) } },
      select: { id: true, installation: { select: { waterAccountId: true } } },
    });
    const m = new Map(rows.map((r) => [r.id, r.installation.waterAccountId]));
    for (const { k, i } of readingIdx) {
      const wa = m.get(k.id);
      if (wa) {
        facts[i] = {
          key: '', type: '', severity: 'WARNING', waterAccountId: wa,
          anchorRef: { kind: 'reading', id: k.id }, summary: '',
        };
      }
    }
  }

  const eventIdx = idxBy('event');
  if (eventIdx.length) {
    const rows = await tx.rawRemoteEvent.findMany({
      where: { tenantId, id: { in: eventIdx.map(({ k }) => k.id) } },
      select: {
        id: true, remoteSourceId: true,
        resolvedBinding: { select: { installation: { select: { waterAccountId: true } } } },
      },
    });
    const m = new Map(rows.map((r) => [r.id, r]));
    for (const { k, i } of eventIdx) {
      const e = m.get(k.id);
      if (!e) continue;
      // D21 — anchor by anomaly TYPE first (see objectAnchorTx):
      // UNBOUND / KEY_CONFLICT stay REMOTE_SOURCE even after the event
      // gains a resolvedBinding; other types use the resolved account,
      // unresolved → TENANT.
      const sourceAnchored =
        k.type === 'REMOTE_EVENT_UNBOUND' || k.type === 'REMOTE_EVENT_KEY_CONFLICT';
      const wa = e.resolvedBinding?.installation.waterAccountId;
      facts[i] = sourceAnchored
        ? { key: '', type: '', severity: 'WARNING', remoteSourceId: e.remoteSourceId, anchorRef: { kind: 'remote-event', id: k.id }, summary: '' }
        : wa
          ? { key: '', type: '', severity: 'WARNING', waterAccountId: wa, anchorRef: { kind: 'remote-event', id: k.id }, summary: '' }
          : { key: '', type: '', severity: 'WARNING', anchorRef: { kind: 'remote-event', id: k.id }, summary: '' };
    }
  }

  const live = facts.filter((f): f is AnomalyFact => f !== null);
  const anchored = await resolveAnchors(tx, tenantId, live);
  const out = new Map<number, AnchoredFact | null>();
  let j = 0;
  facts.forEach((f, i) => {
    out.set(i, f === null ? null : (anchored[j++] ?? null));
  });
  return out;
}
