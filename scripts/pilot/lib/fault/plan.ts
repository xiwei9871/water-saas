/**
 * G6 — profile-driven fault scenario allocator. PURE: allocation is
 * separated from construction — this module emits FaultScenarioPlan[]
 * that inject.ts consumes; no DB, no services.
 *
 * Sequence namespaces (tenant-wide business keys share one keyspace
 * per prefix, so ranges must never overlap):
 *   0–4999      baseline accounts/meters/devices (accountSeq)
 *   0–49999     baseline events (accountSeq*10 + periodIdx)
 *   6000–6999   scenario accounts/meters  (kind block stride 70)
 *   7000–7999   extra meters (MAM second meter)
 *   8000–8999   scenario remote devices / unbound vendor keys
 *   9000–9099   fault books
 *   50000+      scenario remote events
 */

import { readFileSync } from 'node:fs';
import { keys } from '../keys.ts';

export const NS = {
  ACCOUNT_BASE: 6000,
  KIND_STRIDE: 70, // max instances per kind inside its account block
  EXTRA_METER_BASE: 7000,
  DEVICE_BASE: 8000,
  BOOK_BASE: 9000,
  EVENT_BASE: 50000,
} as const;

/** construction kinds, in frozen allocation order. UNBOUND has no
 *  account; KCR/XBM are the composite constructions. */
export const FAULT_KINDS = [
  'NBK', 'NAM', 'MAM', 'MBK', 'QCR', 'QCJ', 'EST', 'WPL', 'FLD',
  'CFL', 'KCF', 'OVD', 'UNBOUND', 'KCR', 'XBM',
] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];

/** kind → GT scenario label (primary anomaly type or composite name). */
export const KIND_SCENARIO: Record<FaultKind, string> = {
  NBK: 'NO_BOOK',
  NAM: 'NO_ACTIVE_METER',
  MAM: 'MULTI_ACTIVE_METER',
  MBK: 'MULTI_BOOK',
  QCR: 'READING_QC_REVIEW',
  QCJ: 'READING_QC_REJECTED',
  EST: 'ESTIMATE_STREAK',
  WPL: 'REMOTE_EVENT_WAITING_PLAN',
  FLD: 'REMOTE_EVENT_FAILED',
  CFL: 'REMOTE_EVENT_CONFLICT',
  KCF: 'REMOTE_EVENT_KEY_CONFLICT',
  OVD: 'UNPAID_BILL_OVERDUE',
  UNBOUND: 'REMOTE_EVENT_UNBOUND',
  KCR: 'KEY_CONFLICT_RECURRENCE',
  XBM: 'CROSS_BRANCH_MULTI_BOOK',
};

/** scenario type (as named in the profile) → construction kind. */
export const SCENARIO_TO_KIND: Record<string, FaultKind> = Object.fromEntries(
  FAULT_KINDS.map((k) => [KIND_SCENARIO[k], k]),
);

const ACCOUNT_KINDS = FAULT_KINDS.filter((k) => k !== 'UNBOUND');
const DEVICE_KINDS = new Set<FaultKind>([
  'UNBOUND', 'WPL', 'FLD', 'CFL', 'KCF', 'KCR',
]);
const EVENT_KINDS = DEVICE_KINDS;

export interface FaultProfile {
  name: string;
  /** total tenant accounts for full profiles (3000–5000). */
  totalAccounts: number | null;
  branches: number;
  booksPerBranch: number;
  remoteRatio: number;
  faultBooksPerBranch: number;
  /** first instanceSeq — 0 keeps legacy `TYPE:000000` keys, 1 gives
   *  `TYPE:000001..0000NN` for scaled profiles. */
  instanceSeqStart: number;
  /** keyed by PRIMARY anomaly type name. */
  scenarioCounts: Record<string, number>;
  /** keyed by composite scenario name. */
  composites: Record<string, number>;
}

/** legacy G4/G5 matrix — one instance per scenario, :000000 keys. */
export const DEFAULT_FAULT_PROFILE: FaultProfile = {
  name: 'default',
  totalAccounts: null,
  branches: 3,
  booksPerBranch: 4,
  remoteRatio: 0.25,
  faultBooksPerBranch: 2,
  instanceSeqStart: 0,
  scenarioCounts: Object.fromEntries(
    FAULT_KINDS.filter(
      (k) => !['KCR', 'XBM'].includes(k),
    ).map((k) => [KIND_SCENARIO[k], 1]),
  ),
  composites: {
    KEY_CONFLICT_RECURRENCE: 1,
    CROSS_BRANCH_MULTI_BOOK: 1,
  },
};

export interface FaultScenarioPlan {
  kind: FaultKind;
  /** GT scenario label (primary type or composite name). */
  scenarioType: string;
  instanceSeq: number;
  scenarioKey: string;
  /** 6000+ business-key seq for the scenario account (null = UNBOUND). */
  accountSeq: number | null;
  branchIdx: number;
  /** index into the fault-book array (branch*booksPerBranch+j). */
  primaryBookIdx: number | null;
  secondaryBookIdx: number | null;
  /** 7000+ — MAM's second meter. */
  extraMeterSeq: number | null;
  /** 8000+ — device row, or the unknown vendor key for UNBOUND. */
  deviceSeq: number | null;
  /** 50000+ — external event seq (KCF/KCR re-ingest reuse one key). */
  eventSeq: number | null;
  /** KCF=1, KCR=3; 0 otherwise. */
  conflictOccurrences: number;
}

export interface FaultAllocation {
  plans: FaultScenarioPlan[];
  /** fault-book business seqs — branch-major: b*perBranch+j. */
  bookSeqs: number[];
  /** scenarios that consume a water account. */
  accountBearing: number;
  /** profile.totalAccounts - accountBearing (null for default). */
  cleanAccounts: number | null;
}

export class ProfileError extends Error {}

const intAtLeast = (v: unknown, min: number, name: string): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min)
    throw new ProfileError(`${name}: expected integer >= ${min}, got ${v}`);
  return v;
};

export function loadFaultProfile(name: string): FaultProfile {
  const url = new URL(`../../profiles/${name}.json`, import.meta.url);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(url, 'utf8'));
  } catch (e) {
    throw new ProfileError(
      `cannot load profile '${name}': ${e instanceof Error ? e.message : e}`,
    );
  }
  const p = raw as Record<string, unknown>;
  const known = new Set([...Object.keys(DEFAULT_FAULT_PROFILE)]);
  for (const k of Object.keys(p))
    if (!known.has(k)) throw new ProfileError(`profile: unknown key '${k}'`);

  const counts = (obj: unknown, label: string): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [t, c] of Object.entries((obj ?? {}) as Record<string, unknown>)) {
      if (!SCENARIO_TO_KIND[t])
        throw new ProfileError(`${label}: unknown scenario type '${t}'`);
      out[t] = intAtLeast(c, 0, `${label}.${t}`);
    }
    return out;
  };
  const profile: FaultProfile = {
    name: String(p.name ?? name),
    totalAccounts:
      p.totalAccounts == null
        ? null
        : intAtLeast(p.totalAccounts, 1, 'totalAccounts'),
    branches: intAtLeast(p.branches ?? 3, 2, 'branches'),
    booksPerBranch: intAtLeast(p.booksPerBranch ?? 4, 1, 'booksPerBranch'),
    remoteRatio:
      typeof p.remoteRatio === 'number' && p.remoteRatio >= 0 && p.remoteRatio <= 1
        ? p.remoteRatio
        : (() => { throw new ProfileError('remoteRatio must be 0..1'); })(),
    faultBooksPerBranch: intAtLeast(p.faultBooksPerBranch ?? 2, 2, 'faultBooksPerBranch'),
    instanceSeqStart: intAtLeast(p.instanceSeqStart ?? 1, 0, 'instanceSeqStart'),
    scenarioCounts: counts(p.scenarioCounts, 'scenarioCounts'),
    composites: counts(p.composites, 'composites'),
  };
  if (profile.totalAccounts !== null) {
    const bearing = countAccounts(profile);
    if (profile.totalAccounts <= bearing)
      throw new ProfileError(
        `totalAccounts=${profile.totalAccounts} <= scenario accounts=${bearing}`,
      );
    if (profile.totalAccounts < 3000 || profile.totalAccounts > 5000)
      throw new ProfileError(
        `full profile totalAccounts must be 3000–5000, got ${profile.totalAccounts}`,
      );
  }
  return profile;
}

const countAccounts = (p: FaultProfile): number =>
  [...Object.entries(p.scenarioCounts), ...Object.entries(p.composites)].reduce(
    (s, [t, c]) => s + (SCENARIO_TO_KIND[t] === 'UNBOUND' ? 0 : c),
    0,
  );

export function allocateFaults(
  profile: FaultProfile,
  branches: number,
): FaultAllocation {
  if (branches < 2)
    throw new ProfileError('fault allocation needs >= 2 branches');
  // fail closed on unknown scenario labels — even for code-built
  // profiles — and on primary/composite keys filed in the wrong bag.
  const COMPOSITES = new Set(['KEY_CONFLICT_RECURRENCE', 'CROSS_BRANCH_MULTI_BOOK']);
  for (const t of Object.keys(profile.scenarioCounts)) {
    if (!SCENARIO_TO_KIND[t]) throw new ProfileError(`unknown scenario type '${t}'`);
    if (COMPOSITES.has(t))
      throw new ProfileError(`composite '${t}' belongs in profile.composites`);
  }
  for (const t of Object.keys(profile.composites)) {
    if (!SCENARIO_TO_KIND[t]) throw new ProfileError(`unknown scenario type '${t}'`);
    if (!COMPOSITES.has(t))
      throw new ProfileError(`primary '${t}' belongs in profile.scenarioCounts`);
  }
  const perBook = profile.faultBooksPerBranch;
  const bookSeqs: number[] = [];
  for (let b = 0; b < branches; b++)
    for (let j = 0; j < perBook; j++) bookSeqs.push(NS.BOOK_BASE + b * perBook + j);

  const plans: FaultScenarioPlan[] = [];
  let devCounter = 0;
  let evCounter = 0;
  const countOf = (kind: FaultKind) =>
    (kind === 'KCR' || kind === 'XBM'
      ? profile.composites[KIND_SCENARIO[kind]]
      : profile.scenarioCounts[KIND_SCENARIO[kind]]) ?? 0;

  for (const kind of FAULT_KINDS) {
    const n = countOf(kind);
    if (n > NS.KIND_STRIDE)
      throw new ProfileError(
        `${KIND_SCENARIO[kind]}: ${n} instances exceed namespace stride ${NS.KIND_STRIDE}`,
      );
    const kindIdx = ACCOUNT_KINDS.indexOf(kind);
    for (let i = 0; i < n; i++) {
      const instanceSeq = profile.instanceSeqStart + i;
      const branchIdx = i % branches;
      const hasAccount = kind !== 'UNBOUND';
      const twoBooks = kind === 'MBK' || kind === 'FLD' || kind === 'XBM';
      plans.push({
        kind,
        scenarioType: KIND_SCENARIO[kind],
        instanceSeq,
        scenarioKey: keys.scenarioKey(KIND_SCENARIO[kind], instanceSeq),
        accountSeq: hasAccount
          ? NS.ACCOUNT_BASE + kindIdx * NS.KIND_STRIDE + instanceSeq
          : null,
        branchIdx,
        primaryBookIdx:
          hasAccount && kind !== 'NBK' ? branchIdx * perBook : null,
        secondaryBookIdx: !twoBooks
          ? null
          : kind === 'XBM'
            ? ((branchIdx + 1) % branches) * perBook // cross-branch
            : branchIdx * perBook + 1,               // same branch
        extraMeterSeq:
          kind === 'MAM' ? NS.EXTRA_METER_BASE + instanceSeq : null,
        deviceSeq: DEVICE_KINDS.has(kind) ? NS.DEVICE_BASE + devCounter++ : null,
        eventSeq: EVENT_KINDS.has(kind) ? NS.EVENT_BASE + evCounter++ : null,
        conflictOccurrences: kind === 'KCF' ? 1 : kind === 'KCR' ? 3 : 0,
      });
    }
  }
  const accountBearing = plans.filter((p) => p.accountSeq !== null).length;
  return {
    plans,
    bookSeqs,
    accountBearing,
    cleanAccounts:
      profile.totalAccounts === null
        ? null
        : profile.totalAccounts - accountBearing,
  };
}
