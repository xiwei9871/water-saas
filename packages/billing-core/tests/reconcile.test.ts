import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import {
  allocateUsage,
  buildReconciliation,
  DomainError,
  reprice,
} from '../src/index.js';
import type { FeeItemInput, TariffTier } from '../src/index.js';

const tier = (
  tierNo: number,
  fromQty: string,
  toQty: string | null,
  unitPrice: string,
): TariffTier => ({
  tierNo,
  fromQty: new Decimal(fromQty),
  toQty: toQty === null ? null : new Decimal(toQty),
  unitPrice: new Decimal(unitPrice),
});

const perQty = (code: string, tiers: TariffTier[]): FeeItemInput => ({
  code,
  calcType: 'PER_QTY',
  tiers,
});
const fixed = (code: string, price: string): FeeItemInput => ({
  code,
  calcType: 'FIXED',
  tiers: [tier(1, '0', null, price)],
});

/** RESIDENTIAL plan: WATER 0-180@3.0 / 180+@4.5 + FIXED 10. */
const feeItems = (): FeeItemInput[] => [
  perQty('WATER', [tier(1, '0', '180', '3.0'), tier(2, '180', null, '4.5')]),
  fixed('FIXED', '10'),
];

const D = (s: string) => new Decimal(s);
const sum = (ds: Decimal[]) => ds.reduce((a, d) => a.plus(d), D('0'));

describe('buildReconciliation', () => {
  it('anchor 1000 → actual 1080 with settled [30,35]: total 80, settled 65, remainder +15', () => {
    const r = buildReconciliation({
      anchorValue: D('1000'),
      actualValue: D('1080'),
      settledUsages: [D('30'), D('35')],
    });
    expect(r.actualTotalUsage.toFixed(4)).toBe('80.0000');
    expect(r.previouslySettled.toFixed(4)).toBe('65.0000');
    expect(r.remainderUsage.toFixed(4)).toBe('15.0000');
  });

  it('anchor 1000 → actual 1055: remainder −10 (over-estimated)', () => {
    const r = buildReconciliation({
      anchorValue: D('1000'),
      actualValue: D('1055'),
      settledUsages: [D('30'), D('35')],
    });
    expect(r.actualTotalUsage.toFixed(4)).toBe('55.0000');
    expect(r.remainderUsage.toFixed(4)).toBe('-10.0000');
  });

  it('actual < anchor keeps the dial regression honest (no clamping)', () => {
    const r = buildReconciliation({
      anchorValue: D('1000'),
      actualValue: D('990'),
      settledUsages: [D('30'), D('35')],
    });
    expect(r.actualTotalUsage.toFixed(4)).toBe('-10.0000');
    expect(r.remainderUsage.toFixed(4)).toBe('-75.0000');
  });

  it('empty span: settled 0, remainder = the whole delta', () => {
    const r = buildReconciliation({
      anchorValue: D('1000'),
      actualValue: D('1080'),
      settledUsages: [],
    });
    expect(r.previouslySettled.toFixed(4)).toBe('0.0000');
    expect(r.remainderUsage.toFixed(4)).toBe('80.0000');
  });
});

describe('allocateUsage — PROPORTIONAL_TO_SETTLED', () => {
  it('80 over [30,35]: shares keep proportion, residue lands on the last period', () => {
    const out = allocateUsage({
      settledUsages: [D('30'), D('35')],
      totalUsage: D('80'),
      policy: 'PROPORTIONAL_TO_SETTLED',
    });
    // 80 × 30/65 = 36.923076… → 36.9231; last = 80 − 36.9231 = 43.0769.
    expect(out.map((d) => d.toFixed(4))).toEqual(['36.9231', '43.0769']);
    expect(sum(out).toFixed(4)).toBe('80.0000');
  });

  it('negative total distributes negative shares, still summing exactly', () => {
    const out = allocateUsage({
      settledUsages: [D('30'), D('35')],
      totalUsage: D('-10'),
      policy: 'PROPORTIONAL_TO_SETTLED',
    });
    // −10 × 30/65 = −4.61538… → −4.6154; last = −10 + 4.6154 = −5.3846.
    expect(out.map((d) => d.toFixed(4))).toEqual(['-4.6154', '-5.3846']);
    expect(sum(out).toFixed(4)).toBe('-10.0000');
  });

  it('repeating shares keep Σ = total exactly (residue on last)', () => {
    const out = allocateUsage({
      settledUsages: [D('1'), D('1'), D('1')],
      totalUsage: D('100'),
      policy: 'PROPORTIONAL_TO_SETTLED',
    });
    // 100/3 = 33.3333… → 33.3333, 33.3333; last = 100 − 66.6666 = 33.3334.
    expect(out.map((d) => d.toFixed(4))).toEqual(['33.3333', '33.3333', '33.3334']);
    expect(sum(out).toFixed(4)).toBe('100.0000');
  });

  it('S = 0 sends the whole total to the last period', () => {
    const out = allocateUsage({
      settledUsages: [D('0'), D('0')],
      totalUsage: D('80'),
      policy: 'PROPORTIONAL_TO_SETTLED',
    });
    expect(out.map((d) => d.toFixed(4))).toEqual(['0.0000', '80.0000']);
  });
});

describe('allocateUsage — ALL_TO_CURRENT', () => {
  it('keeps settled usage for all but the last period, which takes the delta', () => {
    const out = allocateUsage({
      settledUsages: [D('30'), D('35')],
      totalUsage: D('80'),
      policy: 'ALL_TO_CURRENT',
    });
    expect(out.map((d) => d.toFixed(4))).toEqual(['30.0000', '50.0000']);
    expect(sum(out).toFixed(4)).toBe('80.0000');
  });

  it('a negative delta shrinks the last period below its settled usage', () => {
    const out = allocateUsage({
      settledUsages: [D('30'), D('35')],
      totalUsage: D('55'),
      policy: 'ALL_TO_CURRENT',
    });
    expect(out.map((d) => d.toFixed(4))).toEqual(['30.0000', '25.0000']);
    expect(sum(out).toFixed(4)).toBe('55.0000');
  });
});

describe('allocateUsage — edges', () => {
  it('single-period span takes the whole total', () => {
    const out = allocateUsage({
      settledUsages: [D('30')],
      totalUsage: D('80'),
      policy: 'PROPORTIONAL_TO_SETTLED',
    });
    expect(out.map((d) => d.toFixed(4))).toEqual(['80.0000']);
  });

  it('empty span → empty allocation', () => {
    expect(
      allocateUsage({
        settledUsages: [],
        totalUsage: D('80'),
        policy: 'PROPORTIONAL_TO_SETTLED',
      }),
    ).toEqual([]);
  });
});

describe('reprice', () => {
  it('accumulates the natural-year ladder across same-year periods', () => {
    const r = reprice({
      baseYtd: D('100'),
      periods: [
        { period: '202607', allocatedUsage: D('90'), feeItems: feeItems() },
        { period: '202608', allocatedUsage: D('20'), feeItems: feeItems() },
      ],
    });
    // 202607: ytd 100 → tier1 cap 80 @3.0 = 24000 + 10 @4.5 = 4500 + FIXED 1000 → 29500.
    // 202608: ytd 190 → all tier2: 20 × 4.5 = 9000 + FIXED 1000 → 10000.
    expect(r.breakdown).toEqual([
      { period: '202607', usageQty: D('90'), amountCent: 29500n },
      { period: '202608', usageQty: D('20'), amountCent: 10000n },
    ]);
    expect(r.correctChargeCent).toBe(39500n);
  });

  it('crossing 202612 → 202701 resets the ladder cursor to 0', () => {
    const r = reprice({
      baseYtd: D('170'),
      periods: [
        { period: '202612', allocatedUsage: D('30'), feeItems: feeItems() },
        { period: '202701', allocatedUsage: D('20'), feeItems: feeItems() },
      ],
    });
    // 202612: ytd 170 → 10 @3.0 = 3000 + 20 @4.5 = 9000 + FIXED 1000 → 13000.
    // 202701: year boundary → ytd 0 → 20 @3.0 = 6000 + FIXED 1000 → 7000.
    expect(r.breakdown.map((b) => b.amountCent)).toEqual([13000n, 7000n]);
    expect(r.correctChargeCent).toBe(20000n);
  });

  it('engine DomainErrors propagate (negative usage → NEGATIVE_QTY)', () => {
    expect(() =>
      reprice({
        baseYtd: D('0'),
        periods: [
          { period: '202607', allocatedUsage: D('-5'), feeItems: feeItems() },
        ],
      }),
    ).toThrowError(DomainError);
  });

  it('empty span reprices to zero', () => {
    const r = reprice({ baseYtd: D('100'), periods: [] });
    expect(r.correctChargeCent).toBe(0n);
    expect(r.breakdown).toEqual([]);
  });
});
