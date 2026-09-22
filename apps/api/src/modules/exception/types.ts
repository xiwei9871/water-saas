/**
 * E9 Exception Center — anomaly fact contract.
 * Facts are DERIVED from domain SoT at query/reconcile time; this type is
 * never persisted. work_item only stores episode handling state.
 * docs/product-map/E9_EXCEPTION_CENTER_DOMAIN_DESIGN.md (D1/D2).
 */

export type AnomalySeverity = 'BLOCKING' | 'WARNING';

export type ScopeAnchor = 'ACCOUNT' | 'TENANT' | 'REMOTE_SOURCE' | 'SETTLE';

export interface AnomalyFact {
  /** deterministic fact identity — see key builders below */
  key: string;
  type: string;
  severity: AnomalySeverity;
  /** set when the anomaly resolves to a WaterAccount (ACCOUNT/TENANT anchor decided by book coverage) */
  waterAccountId?: string;
  /** set when the anomaly anchors on a remote_source (REMOTE_SOURCE) */
  remoteSourceId?: string;
  /** drill-down target */
  anchorRef: { kind: 'water-account' | 'bill' | 'reading' | 'remote-event' | 'settle-account'; id: string };
  period?: string;
  summary: string;
}

// ---- anomaly types (V1 frozen catalog — 13) ----
export const A = {
  NO_ACTIVE_METER: 'NO_ACTIVE_METER',
  MULTI_ACTIVE_METER: 'MULTI_ACTIVE_METER',
  NO_BOOK: 'NO_BOOK',
  MULTI_BOOK: 'MULTI_BOOK',
  READING_QC_REVIEW: 'READING_QC_REVIEW',
  READING_QC_REJECTED: 'READING_QC_REJECTED',
  ESTIMATE_STREAK: 'ESTIMATE_STREAK',
  REMOTE_EVENT_UNBOUND: 'REMOTE_EVENT_UNBOUND',
  REMOTE_EVENT_WAITING_PLAN: 'REMOTE_EVENT_WAITING_PLAN',
  REMOTE_EVENT_FAILED: 'REMOTE_EVENT_FAILED',
  REMOTE_EVENT_CONFLICT: 'REMOTE_EVENT_CONFLICT',
  REMOTE_EVENT_KEY_CONFLICT: 'REMOTE_EVENT_KEY_CONFLICT',
  UNPAID_BILL_OVERDUE: 'UNPAID_BILL_OVERDUE',
} as const;

/** severity is deterministic by type — never operator-editable (Gate Q2). */
export const SEVERITY: Record<string, AnomalySeverity> = {
  [A.MULTI_ACTIVE_METER]: 'BLOCKING',
};

export const severityOf = (type: string): AnomalySeverity =>
  SEVERITY[type] ?? 'WARNING';

// ---- key builders / parsers (D2/D10/D22) ----
// Key suffix per type (wa keys use the full type name; object keys use a
// short suffix — Gate-frozen formats: reading:{id}:QC_REVIEW,
// bill:{id}:OVERDUE, event:{id}:UNBOUND ...).
const SUFFIX: Record<string, string> = {
  [A.READING_QC_REVIEW]: 'QC_REVIEW',
  [A.READING_QC_REJECTED]: 'QC_REJECTED',
  [A.REMOTE_EVENT_UNBOUND]: 'UNBOUND',
  [A.REMOTE_EVENT_WAITING_PLAN]: 'WAITING_PLAN',
  [A.REMOTE_EVENT_FAILED]: 'FAILED',
  [A.REMOTE_EVENT_CONFLICT]: 'CONFLICT',
  [A.REMOTE_EVENT_KEY_CONFLICT]: 'EVENT_KEY_CONFLICT',
  [A.UNPAID_BILL_OVERDUE]: 'OVERDUE',
};
const suffixOf = (type: string) => SUFFIX[type] ?? type;

export const waKey = (accountId: string, type: string) => `wa:${accountId}:${type}`;
export const billKey = (billId: string) => `bill:${billId}:${suffixOf(A.UNPAID_BILL_OVERDUE)}`;
export const readingKey = (readingId: string, type: string) => `reading:${readingId}:${suffixOf(type)}`;
export const eventKey = (eventId: string, type: string) => `event:${eventId}:${suffixOf(type)}`;
/** D22: occurrence marker — conflict-log ordinal (see detectors.ts note on
 *  why a monotonically increasing count is used instead of currentIssueAt). */
export const eventIssueKey = (eventId: string, occurrence: string) =>
  `event:${eventId}:${suffixOf(A.REMOTE_EVENT_KEY_CONFLICT)}:${occurrence}`;

const SUFFIX_TO_TYPE = new Map(Object.entries(SUFFIX).map(([t, s]) => [s, t]));

export interface ParsedKey {
  kind: 'wa' | 'bill' | 'reading' | 'event' | 'settle';
  id: string;
  /** full anomaly type */
  type: string;
  occurrence?: string;
}

/** Parse `wa:{id}:{TYPE}` / `bill:{id}:OVERDUE` / `reading:{id}:QC_*` /
 *  `event:{id}:{STATUS|EVENT_KEY_CONFLICT[:occurrence]}`. */
export function parseKey(key: string): ParsedKey | null {
  const parts = key.split(':');
  if (parts.length < 3) return null;
  const [kind, id] = parts;
  if (!['wa', 'bill', 'reading', 'event', 'settle'].includes(kind)) return null;
  const suffix = parts[2];
  if (kind === 'wa') {
    // wa keys carry the full type name
    return Object.values(A).includes(suffix as (typeof A)[keyof typeof A])
      ? { kind: 'wa', id, type: suffix }
      : null;
  }
  const type = SUFFIX_TO_TYPE.get(suffix);
  if (!type) return null;
  const occurrence = parts.length > 3 ? parts.slice(3).join(':') : undefined;
  return { kind: kind as ParsedKey['kind'], id, type, occurrence };
}

/** Rebuild the canonical key from a parsed one. */
export function buildKey(p: ParsedKey): string {
  return `${p.kind}:${p.id}:${suffixOf(p.type)}${p.occurrence ? `:${p.occurrence}` : ''}`;
}
