/**
 * G4+G6 fault-injection unit tests — pure parts only: scenario
 * coverage, allocator namespaces, instance determinism, faultPeriod
 * math. No DB.
 */
import { describe, expect, it } from 'vitest';
import { SCENARIO_TYPES } from '../../scripts/pilot/lib/fault/inject.ts';
import {
  allocateFaults,
  DEFAULT_FAULT_PROFILE,
  FAULT_KINDS,
  KIND_SCENARIO,
  loadFaultProfile,
  NS,
  ProfileError,
} from '../../scripts/pilot/lib/fault/plan.ts';
import { ANCHOR, oKey, T } from '../../scripts/pilot/lib/fault/oracle.ts';
import {
  A,
  billKey,
  eventIssueKey,
  eventKey,
  readingKey,
  waKey,
} from '../src/modules/exception/types.js';
import { shiftPeriod } from '../../scripts/pilot/lib/baseline/allocate.ts';
import { keys } from '../../scripts/pilot/lib/keys.ts';
import { parseArgs } from '../../scripts/pilot/lib/cli.ts';

const A_TYPES = [
  'NO_ACTIVE_METER', 'MULTI_ACTIVE_METER', 'NO_BOOK', 'MULTI_BOOK',
  'READING_QC_REVIEW', 'READING_QC_REJECTED', 'ESTIMATE_STREAK',
  'REMOTE_EVENT_UNBOUND', 'REMOTE_EVENT_WAITING_PLAN',
  'REMOTE_EVENT_FAILED', 'REMOTE_EVENT_CONFLICT',
  'REMOTE_EVENT_KEY_CONFLICT', 'UNPAID_BILL_OVERDUE',
];

describe('G4 scenario matrix', () => {
  it('covers all 13 primary anomaly types + 2 composites', () => {
    const scenarios = new Set(SCENARIO_TYPES);
    for (const t of A_TYPES) expect(scenarios).toContain(t);
    expect(scenarios).toContain('KEY_CONFLICT_RECURRENCE');
    expect(scenarios).toContain('CROSS_BRANCH_MULTI_BOOK');
    expect(scenarios.size).toBe(15);
    expect(FAULT_KINDS).toHaveLength(15); // 14 account-bearing + UNBOUND
  });

  it('default profile → legacy single instances with :000000 keys', () => {
    const { plans } = allocateFaults(DEFAULT_FAULT_PROFILE, 3);
    expect(plans).toHaveLength(15);
    for (const p of plans)
      expect(p.scenarioKey).toBe(`${p.scenarioType}:000000`);
    expect(plans.filter((p) => p.accountSeq !== null)).toHaveLength(14);
  });

  it('scenario business keys are deterministic per (seed,kind,seq)', () => {
    const { plans } = allocateFaults(DEFAULT_FAULT_PROFILE, 3);
    for (const p of plans.filter((x) => x.accountSeq !== null)) {
      expect(keys.accountNo(42, p.kind, p.accountSeq!)).toBe(
        `P0042-${p.kind}-${String(p.accountSeq).padStart(6, '0')}`,
      );
    }
    expect(keys.scenarioKey('NO_BOOK', 0)).toBe('NO_BOOK:000000');
    expect(keys.scenarioKey('NO_BOOK', 40)).toBe('NO_BOOK:000040');
  });
});

describe('G6 allocator namespaces', () => {
  const full = loadFaultProfile('full');
  const alloc = allocateFaults(full, 3);

  it('full profile: 600 plans, 560 account-bearing, clean=3440', () => {
    expect(alloc.plans).toHaveLength(600);
    expect(alloc.accountBearing).toBe(560); // 600 - 40 UNBOUND
    expect(alloc.cleanAccounts).toBe(3440);
    expect(alloc.bookSeqs).toHaveLength(6); // 3 branches × 2
  });

  it('instance-scoped scenarioKeys: TYPE:000001..000040', () => {
    const nbk = alloc.plans.filter((p) => p.kind === 'NBK');
    expect(nbk).toHaveLength(40);
    expect(nbk[0].scenarioKey).toBe('NO_BOOK:000001');
    expect(nbk[39].scenarioKey).toBe('NO_BOOK:000040');
    expect(new Set(alloc.plans.map((p) => p.scenarioKey)).size).toBe(600);
  });

  it('all business-key seqs are unique inside their namespace', () => {
    const acctSeqs = alloc.plans.filter((p) => p.accountSeq !== null).map((p) => p.accountSeq!);
    expect(new Set(acctSeqs).size).toBe(acctSeqs.length);
    for (const s of acctSeqs) {
      expect(s).toBeGreaterThanOrEqual(NS.ACCOUNT_BASE);
      expect(s).toBeLessThan(NS.ACCOUNT_BASE + 1000);
    }
    // meterNo shares one keyspace: account seqs and extra-meter seqs
    // must be disjoint
    const extra = alloc.plans.filter((p) => p.extraMeterSeq !== null).map((p) => p.extraMeterSeq!);
    for (const s of extra) expect(acctSeqs).not.toContain(s);
    const dev = alloc.plans.filter((p) => p.deviceSeq !== null).map((p) => p.deviceSeq!);
    expect(new Set(dev).size).toBe(dev.length);
    for (const s of dev) expect(s).toBeGreaterThanOrEqual(NS.DEVICE_BASE);
    const ev = alloc.plans.filter((p) => p.eventSeq !== null).map((p) => p.eventSeq!);
    expect(new Set(ev).size).toBe(ev.length);
    // baseline events use accountSeq*10+periodIdx ≤ 49999
    for (const s of ev) expect(s).toBeGreaterThanOrEqual(NS.EVENT_BASE);
    for (const s of alloc.bookSeqs) expect(s).toBeGreaterThanOrEqual(NS.BOOK_BASE);
  });

  it('same profile + branches → identical plans (determinism)', () => {
    const a = allocateFaults(full, 3);
    const b = allocateFaults(full, 3);
    expect(a.plans).toEqual(b.plans);
  });

  it('book ownership: MBK/FLD same-branch, XBM cross-branch', () => {
    const mbk = alloc.plans.find((p) => p.kind === 'MBK')!;
    expect(Math.floor(mbk.primaryBookIdx! / 2)).toBe(Math.floor(mbk.secondaryBookIdx! / 2));
    const xbm = alloc.plans.find((p) => p.kind === 'XBM')!;
    expect(Math.floor(xbm.primaryBookIdx! / 2)).not.toBe(Math.floor(xbm.secondaryBookIdx! / 2));
    const fld = alloc.plans.find((p) => p.kind === 'FLD')!;
    expect(Math.floor(fld.primaryBookIdx! / 2)).toBe(Math.floor(fld.secondaryBookIdx! / 2));
  });

  it('conflict occurrences: KCF=1, KCR=3', () => {
    expect(alloc.plans.find((p) => p.kind === 'KCF')!.conflictOccurrences).toBe(1);
    expect(alloc.plans.find((p) => p.kind === 'KCR')!.conflictOccurrences).toBe(3);
  });

  it('UNBOUND: no account, device seq is a bare vendor key', () => {
    const unb = alloc.plans.filter((p) => p.kind === 'UNBOUND');
    expect(unb.every((p) => p.accountSeq === null)).toBe(true);
    expect(unb.every((p) => p.deviceSeq !== null && p.eventSeq !== null)).toBe(true);
  });

  it('profile validation: unknown scenario type → reject', () => {
    expect(() =>
      allocateFaults(
        { ...DEFAULT_FAULT_PROFILE, scenarioCounts: { NOT_A_TYPE: 1 } },
        3,
      ),
    ).toThrow(ProfileError);
    expect(() => loadFaultProfile('does-not-exist')).toThrow(ProfileError);
  });
});

describe('independent oracle (P1-4)', () => {
  const id = 'aaaaaaaa-0000-4000-8000-000000000001';
  it('frozen key formats', () => {
    expect(oKey.wa(id, T.NO_BOOK)).toBe(`wa:${id}:NO_BOOK`);
    expect(oKey.qcReview(id)).toBe(`reading:${id}:QC_REVIEW`);
    expect(oKey.qcRejected(id)).toBe(`reading:${id}:QC_REJECTED`);
    expect(oKey.eventUnbound(id)).toBe(`event:${id}:UNBOUND`);
    expect(oKey.eventWaitingPlan(id)).toBe(`event:${id}:WAITING_PLAN`);
    expect(oKey.eventFailed(id)).toBe(`event:${id}:FAILED`);
    expect(oKey.eventConflict(id)).toBe(`event:${id}:CONFLICT`);
    expect(oKey.eventKeyConflict(id, 3)).toBe(`event:${id}:EVENT_KEY_CONFLICT:3`);
    expect(oKey.bill(id)).toBe(`bill:${id}:OVERDUE`);
  });

  it('oracle format == current production format (regression only)', () => {
    // GT generation must NOT use production helpers — this test only
    // proves the frozen contract still matches the product encoding.
    expect(oKey.wa(id, T.ESTIMATE_STREAK)).toBe(waKey(id, A.ESTIMATE_STREAK));
    expect(oKey.qcReview(id)).toBe(readingKey(id, A.READING_QC_REVIEW));
    expect(oKey.qcRejected(id)).toBe(readingKey(id, A.READING_QC_REJECTED));
    expect(oKey.eventUnbound(id)).toBe(eventKey(id, A.REMOTE_EVENT_UNBOUND));
    expect(oKey.eventWaitingPlan(id)).toBe(eventKey(id, A.REMOTE_EVENT_WAITING_PLAN));
    expect(oKey.eventFailed(id)).toBe(eventKey(id, A.REMOTE_EVENT_FAILED));
    expect(oKey.eventConflict(id)).toBe(eventKey(id, A.REMOTE_EVENT_CONFLICT));
    expect(oKey.eventKeyConflict(id, 3)).toBe(eventIssueKey(id, '3'));
    expect(oKey.bill(id)).toBe(billKey(id));
    for (const t of A_TYPES) expect(Object.values(T)).toContain(t);
  });
});

describe('frozen anchor contract (P1-3)', () => {
  it('per-type anchors', () => {
    expect(ANCHOR[T.NO_ACTIVE_METER]).toBe('ACCOUNT');
    expect(ANCHOR[T.MULTI_ACTIVE_METER]).toBe('ACCOUNT');
    expect(ANCHOR[T.NO_BOOK]).toBe('TENANT');
    expect(ANCHOR[T.MULTI_BOOK]).toBe('ACCOUNT');
    expect(ANCHOR[T.READING_QC_REVIEW]).toBe('ACCOUNT');
    expect(ANCHOR[T.READING_QC_REJECTED]).toBe('ACCOUNT');
    expect(ANCHOR[T.ESTIMATE_STREAK]).toBe('ACCOUNT');
    expect(ANCHOR[T.REMOTE_EVENT_UNBOUND]).toBe('REMOTE_SOURCE');
    expect(ANCHOR[T.REMOTE_EVENT_WAITING_PLAN]).toBe('ACCOUNT');
    expect(ANCHOR[T.REMOTE_EVENT_FAILED]).toBe('ACCOUNT');
    expect(ANCHOR[T.REMOTE_EVENT_CONFLICT]).toBe('ACCOUNT');
    expect(ANCHOR[T.REMOTE_EVENT_KEY_CONFLICT]).toBe('REMOTE_SOURCE');
    expect(ANCHOR[T.UNPAID_BILL_OVERDUE]).toBe('ACCOUNT');
  });

  it('primary-isolated scenario expectations', () => {
    // NAM → only NO_ACTIVE_METER (in FA, not bookless)
    // NBK → only NO_BOOK (bookless → TENANT anchor)
    // FLD → only REMOTE_EVENT_FAILED (FB membership removed post-plan)
    expect(KIND_SCENARIO.NAM).toBe('NO_ACTIVE_METER');
    expect(KIND_SCENARIO.NBK).toBe('NO_BOOK');
    expect(KIND_SCENARIO.FLD).toBe('REMOTE_EVENT_FAILED');
    expect(ANCHOR[KIND_SCENARIO.NAM]).toBe('ACCOUNT');
    expect(ANCHOR[KIND_SCENARIO.NBK]).toBe('TENANT');
    expect(ANCHOR[KIND_SCENARIO.FLD]).toBe('ACCOUNT');
  });
});

describe('faultPeriod math', () => {
  it('3 months before asOf → due date already past', () => {
    expect(shiftPeriod('202609', -3)).toBe('202606');
    expect(shiftPeriod('202601', -3)).toBe('202510'); // year wrap
    expect(shiftPeriod('202612', -1)).toBe('202611');
    expect(shiftPeriod('202612', 1)).toBe('202701');
  });
});

describe('--faults flag', () => {
  const base = [
    '--tenant', '0c1390fc-15ca-406d-b428-2f5fde9cee93',
    '--seed', '42', '--period-from', '202608',
  ];
  it('defaults to false (clean G3 path unchanged)', () => {
    expect(parseArgs(base).faults).toBe(false);
  });
  it('parses --faults', () => {
    expect(parseArgs([...base, '--faults']).faults).toBe(true);
  });
});
