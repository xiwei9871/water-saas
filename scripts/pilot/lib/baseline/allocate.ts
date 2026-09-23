/**
 * G3 deterministic allocation — PURE. Every assignment derives from
 * (seed-independent) seq arithmetic so the same --accounts always yields
 * the same distribution. UUIDs vary; business keys and counts don't.
 */

export type PayProfile = 'A' | 'B' | 'C';

export interface AccountPlan {
  seq: number;
  tag: 'BG';
  branchIdx: number;
  bookIdx: number; // global book index
  remote: boolean;
  payProfile: PayProfile;
  /** deterministic per-account usage in m³, period 0 and period 1 */
  usage: [number, number];
}

export interface AllocationParams {
  accounts: number;
  branches: number;
  booksPerBranch: number;
  /** 0..1 — fraction of accounts on the remote path. */
  remotePct: number;
}

export const DEFAULT_ALLOCATION: AllocationParams = {
  accounts: 4000,
  branches: 3,
  booksPerBranch: 4,
  remotePct: 0.25,
};

/**
 * remote flag — seq % round(1/pct) === 0 → exact 1/N subset.
 * Kept seq-based (not PRNG) so the subset is stable under re-runs.
 */
export const isRemote = (seq: number, pct = 0.25): boolean =>
  seq % Math.round(1 / pct) === 0;

/**
 * Payment profile — 60% A (full cash), 25% B (partial cash + TOP_UP
 * remainder), 15% C (TOP_UP lot before billing → APPLY at post).
 */
export const payProfile = (seq: number): PayProfile => {
  const r = seq % 20;
  if (r < 12) return 'A';
  if (r < 17) return 'B';
  return 'C';
};

export function allocateAccounts(p: AllocationParams): AccountPlan[] {
  const out: AccountPlan[] = [];
  for (let seq = 0; seq < p.accounts; seq++) {
    const branchIdx = seq % p.branches;
    const bookIdx =
      branchIdx * p.booksPerBranch +
      (Math.floor(seq / p.branches) % p.booksPerBranch);
    const base = 8 + (seq % 20); // 8..27 m³ — realistic residential range
    out.push({
      seq,
      tag: 'BG',
      branchIdx,
      bookIdx,
      remote: isRemote(seq, p.remotePct),
      payProfile: payProfile(seq),
      usage: [base, base + 3],
    });
  }
  return out;
}

/** Period date helpers — all UTC, deterministic. */
export const periodStart = (period: string): Date =>
  new Date(Date.UTC(+period.slice(0, 4), +period.slice(4) - 1, 1));
export const periodEnd = (period: string): Date =>
  new Date(Date.UTC(+period.slice(0, 4), +period.slice(4), 1));
export const periodDay = (period: string, day: number): Date =>
  new Date(Date.UTC(+period.slice(0, 4), +period.slice(4) - 1, day));

export const listPeriods = (from: string, to: string): string[] => {
  const out: string[] = [];
  let p = from;
  while (p <= to) {
    out.push(p);
    const y = +p.slice(0, 4);
    const m = +p.slice(4);
    p = m === 12 ? `${y + 1}01` : `${y}${String(m + 1).padStart(2, '0')}`;
  }
  return out;
};
