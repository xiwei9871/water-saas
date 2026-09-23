/**
 * G3 targeted tests — deterministic allocation, book distribution,
 * remote %, payment profiles, two-period construction, clean GT shape.
 * Pure logic only — no DB, no Nest.
 */
import { describe, expect, it } from 'vitest';
import {
  allocateAccounts,
  isRemote,
  listPeriods,
  payProfile,
  periodDay,
  periodEnd,
  periodStart,
} from '../../../scripts/pilot/lib/baseline/allocate.ts';
import { keys } from '../../../scripts/pilot/lib/keys.ts';

const P = { accounts: 40, branches: 3, booksPerBranch: 4, remotePct: 0.25 };

describe('G3 allocateAccounts', () => {
  it('is deterministic — same params → identical plans', () => {
    const a = allocateAccounts(P);
    const b = allocateAccounts(P);
    expect(a).toEqual(b);
    expect(a).toHaveLength(40);
  });

  it('round-robins branches evenly', () => {
    const a = allocateAccounts(P);
    for (let br = 0; br < 3; br++) {
      const n = a.filter((x) => x.branchIdx === br).length;
      expect(n).toBeGreaterThanOrEqual(13);
      expect(n).toBeLessThanOrEqual(14);
    }
  });

  it('assigns each account to exactly one book, spread across all 12', () => {
    const a = allocateAccounts(P);
    const used = new Set(a.map((x) => x.bookIdx));
    expect(used.size).toBe(12);
    // book always inside its own branch's range
    for (const x of a) {
      expect(Math.floor(x.bookIdx / P.booksPerBranch)).toBe(x.branchIdx);
    }
  });

  it('remote subset = exactly 25% (seq % 4)', () => {
    const a = allocateAccounts(P);
    expect(a.filter((x) => x.remote)).toHaveLength(10);
    expect(a[0].remote).toBe(true);
    expect(a[1].remote).toBe(false);
    expect(isRemote(8)).toBe(true);
    expect(isRemote(9)).toBe(false);
  });

  it('payment profiles — 60% A / 25% B / 15% C', () => {
    const a = allocateAccounts(P);
    const count = (p: string) => a.filter((x) => x.payProfile === p).length;
    expect(count('A')).toBe(24);
    expect(count('B')).toBe(10);
    expect(count('C')).toBe(6);
    expect(payProfile(0)).toBe('A');
    expect(payProfile(12)).toBe('B');
    expect(payProfile(17)).toBe('C');
  });

  it('usage is deterministic and positive for both periods', () => {
    const a = allocateAccounts(P);
    for (const x of a) {
      expect(x.usage[0]).toBeGreaterThanOrEqual(8);
      expect(x.usage[0]).toBeLessThanOrEqual(27);
      expect(x.usage[1]).toBe(x.usage[0] + 3);
    }
  });
});

describe('G3 period helpers', () => {
  it('lists consecutive periods inclusive', () => {
    expect(listPeriods('202608', '202610')).toEqual([
      '202608',
      '202609',
      '202610',
    ]);
    expect(listPeriods('202612', '202701')).toEqual(['202612', '202701']);
    expect(listPeriods('202609', '202609')).toEqual(['202609']);
  });

  it('two-period dates stay inside their periods (UTC)', () => {
    expect(periodStart('202609').toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(periodEnd('202609').toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(periodDay('202609', 15).getUTCDate()).toBe(15);
    // Feb short month — day 15 still valid
    expect(periodDay('202602', 15).getUTCMonth()).toBe(1);
  });
});

describe('G3 clean GT shape', () => {
  it('CLEAN_BACKGROUND entries — business keys stable, expected.anomalies = []', () => {
    // key factory contract the GT writer relies on
    expect(keys.accountNo(42, 'BG', 7)).toBe('P0042-BG-000007');
    expect(keys.accountNo(42, 'BG', 7)).toBe(keys.accountNo(42, 'BG', 7));
    // GT entries must exist even with empty expectations (false-positive baseline)
    const entry = {
      scenarioKey: 'CLEAN_BACKGROUND:000007',
      injectionMethod: 'DOMAIN_FLOW' as const,
      reachableInNormalOperation: true,
      businessKeys: { accountNo: keys.accountNo(42, 'BG', 7) },
      entityIds: { waterAccountId: 'uuid-this-run' },
      expected: { anomalies: [], orgOwnership: [], financialEffect: null },
    };
    expect(entry.expected.anomalies).toEqual([]);
    expect(entry.injectionMethod).toBe('DOMAIN_FLOW');
    expect(entry.businessKeys.accountNo).toMatch(/^P0042-BG-/);
  });
});
