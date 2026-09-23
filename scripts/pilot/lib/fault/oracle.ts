/**
 * G4 independent Ground-Truth oracle. Encodes the FROZEN product key
 * contract (E9 D2/D10/D22) as literals — deliberately does NOT import
 * modules/exception/types so a production key-format change shows up as
 * an oracle-vs-detector mismatch in construction smoke, never silently
 * propagates into Ground Truth.
 */

/** frozen anomaly type catalog (13 primary). */
export const T = {
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

/** frozen anchor contract (RC1 P1-3) — what resolveAnchors must yield
 *  for each scenario's expected fact, given its constructed state. */
export const ANCHOR: Record<string, 'ACCOUNT' | 'TENANT' | 'REMOTE_SOURCE'> = {
  [T.NO_ACTIVE_METER]: 'ACCOUNT',
  [T.MULTI_ACTIVE_METER]: 'ACCOUNT',
  [T.NO_BOOK]: 'TENANT', // off-book account → no determinable owner (D12)
  [T.MULTI_BOOK]: 'ACCOUNT',
  [T.READING_QC_REVIEW]: 'ACCOUNT',
  [T.READING_QC_REJECTED]: 'ACCOUNT',
  [T.ESTIMATE_STREAK]: 'ACCOUNT',
  [T.REMOTE_EVENT_UNBOUND]: 'REMOTE_SOURCE',
  [T.REMOTE_EVENT_WAITING_PLAN]: 'ACCOUNT',
  [T.REMOTE_EVENT_FAILED]: 'ACCOUNT',
  [T.REMOTE_EVENT_CONFLICT]: 'ACCOUNT',
  [T.REMOTE_EVENT_KEY_CONFLICT]: 'REMOTE_SOURCE',
  [T.UNPAID_BILL_OVERDUE]: 'ACCOUNT',
};

/** frozen key formats — literals, not production helpers. */
export const oKey = {
  wa: (id: string, type: string) => `wa:${id}:${type}`,
  bill: (id: string) => `bill:${id}:OVERDUE`,
  qcReview: (id: string) => `reading:${id}:QC_REVIEW`,
  qcRejected: (id: string) => `reading:${id}:QC_REJECTED`,
  eventUnbound: (id: string) => `event:${id}:UNBOUND`,
  eventWaitingPlan: (id: string) => `event:${id}:WAITING_PLAN`,
  eventFailed: (id: string) => `event:${id}:FAILED`,
  eventConflict: (id: string) => `event:${id}:CONFLICT`,
  eventKeyConflict: (id: string, occurrence: number) =>
    `event:${id}:EVENT_KEY_CONFLICT:${occurrence}`,
};
