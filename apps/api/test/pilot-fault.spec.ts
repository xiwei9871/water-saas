/**
 * G4 fault-injection unit tests — pure parts only: scenario coverage,
 * seq-space determinism, faultPeriod math, and the expected-keys
 * plumbing in verifyBaseline's option bag. No DB.
 */
import { describe, expect, it } from 'vitest';
import {
  SCENARIO_OF_TAG,
  SCENARIO_TYPES,
  TAG_SEQ,
} from '../../scripts/pilot/lib/fault/inject.ts';
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
    // 14 tags with accounts + 1 account-less UNBOUND entry = 15 GT entries
    expect(Object.keys(TAG_SEQ)).toHaveLength(14);
    expect(Object.keys(SCENARIO_OF_TAG)).toHaveLength(14);
  });

  it('seq space is unique and disjoint from baseline books/devices', () => {
    const seqs = Object.values(TAG_SEQ);
    expect(new Set(seqs).size).toBe(seqs.length);
    for (const s of seqs) {
      expect(s).toBeGreaterThanOrEqual(100);
      expect(s).toBeLessThan(900); // fault books 900+, devices 910+
    }
  });

  it('scenario business keys are deterministic per (seed,tag,seq)', () => {
    for (const [tag, seq] of Object.entries(TAG_SEQ)) {
      expect(keys.accountNo(42, tag, seq)).toBe(`P0042-${tag}-${String(seq).padStart(6, '0')}`);
      expect(keys.customerNo(42, tag, seq)).toContain(`C-${tag}-`);
    }
    expect(keys.scenarioKey('NO_BOOK', 0)).toBe('NO_BOOK:000000');
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
