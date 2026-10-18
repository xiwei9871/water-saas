/**
 * D3 — semantic deterministic key factory.
 * Same (seed, tag, seq) → same business key. UUIDs are NOT stable and
 * never participate in cross-run comparison.
 */

const S4 = (seed: number) => String(seed).padStart(4, '0');
const S6 = (seq: number) => String(seq).padStart(6, '0');

export const keys = {
  tenantCode: (seed: number) => `PILOT-${S4(seed)}`,
  /** tag = short scenario tag (e.g. 'NBK') or 'BG' for clean background. */
  accountNo: (seed: number, tag: string, seq: number) =>
    `P${S4(seed)}-${tag}-${S6(seq)}`,
  customerNo: (seed: number, tag: string, seq: number) =>
    `P${S4(seed)}-C-${tag}-${S6(seq)}`,
  settleNo: (seed: number, tag: string, seq: number) =>
    `P${S4(seed)}-SA-${tag}-${S6(seq)}`,
  meterNo: (seed: number, seq: number) => `P${S4(seed)}-M-${S6(seq)}`,
  deviceNo: (seed: number, seq: number) => `P${S4(seed)}-D-${S6(seq)}`,
  bookCode: (seed: number, seq: number) => `P${S4(seed)}-BK-${S6(seq)}`,
  orgCode: (seed: number, seq: number) => `P${S4(seed)}-ORG-${S6(seq)}`,
  orgName: (seed: number, seq: number) => `Pilot营业所 P${S4(seed)}-${S6(seq)}`,
  bookName: (seed: number, seq: number) => `Pilot抄表册 P${S4(seed)}-${S6(seq)}`,
  externalEventKey: (seed: number, seq: number) =>
    `P${S4(seed)}-EV-${S6(seq)}`,
  scenarioKey: (type: string, seq: number) => `${type}:${S6(seq)}`,
} as const;

export type Keys = typeof keys;
