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
    expect(SCENARIO_OF_TAG.NAM).toBe('NO_ACTIVE_METER');
    expect(SCENARIO_OF_TAG.NBK).toBe('NO_BOOK');
    expect(SCENARIO_OF_TAG.FLD).toBe('REMOTE_EVENT_FAILED');
    expect(ANCHOR[SCENARIO_OF_TAG.NAM]).toBe('ACCOUNT');
    expect(ANCHOR[SCENARIO_OF_TAG.NBK]).toBe('TENANT');
    expect(ANCHOR[SCENARIO_OF_TAG.FLD]).toBe('ACCOUNT');
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
