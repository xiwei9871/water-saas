import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { DomainError, roundCent, tieredAmount } from '../src/index.js';
import type { TariffTier } from '../src/index.js';

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

describe('roundCent', () => {
  it('rounds half-up to integer cents', () => {
    expect(roundCent(new Decimal('153.60'))).toBe(15360n);
    expect(roundCent(new Decimal('1.005'))).toBe(101n); // tie → away from zero
    expect(roundCent(new Decimal('1.004'))).toBe(100n);
  });

  it('rounds negative ties away from zero (credit rows)', () => {
    // decimal.js ROUND_HALF_UP is symmetric: -1.005 × 100 = -100.5 → -101.
    // (Task brief stated -100; spec §1.3's HALF_UP rule and the brief's own
    // ROUND_HALF_UP formula both yield -101 — verified against decimal.js.)
    expect(roundCent(new Decimal('-1.005'))).toBe(-101n);
    expect(roundCent(new Decimal('-0.005'))).toBe(-1n);
    expect(roundCent(new Decimal('-1.004'))).toBe(-100n);
  });

  it('maps zero and negative zero to 0n', () => {
    expect(roundCent(new Decimal('0'))).toBe(0n);
    expect(roundCent(new Decimal('-0.0000'))).toBe(0n);
  });
});

describe('tieredAmount', () => {
  it('prices a flat single tier (48 m³ × 3.2 = 153.60)', () => {
    const r = tieredAmount(new Decimal('48'), new Decimal('0'), [
      tier(1, '0', null, '3.2'),
    ]);
    expect(r.amountCent).toBe(15360n);
    expect(r.parts).toHaveLength(1);
    expect(r.parts[0].qty.toFixed(4)).toBe('48.0000');
    expect(r.parts[0].unitPrice.toString()).toBe('3.2');
    expect(r.parts[0].amountCent).toBe(15360n);
  });

  it('splits mid-bill at a cumulative tier boundary (ytd=170, qty=15)', () => {
    const tiers = [tier(1, '0', '180', '3.0'), tier(2, '180', null, '4.5')];
    const r = tieredAmount(new Decimal('15'), new Decimal('170'), tiers);
    expect(r.parts).toHaveLength(2);
    expect(r.parts[0].tierNo).toBe(1);
    expect(r.parts[0].qty.toFixed(4)).toBe('10.0000');
    expect(r.parts[0].amountCent).toBe(3000n); // 10 × 3.0
    expect(r.parts[1].tierNo).toBe(2);
    expect(r.parts[1].qty.toFixed(4)).toBe('5.0000');
    expect(r.parts[1].amountCent).toBe(2250n); // 5 × 4.5
    expect(r.amountCent).toBe(5250n);
  });

  it('prices everything in the top tier when ytd is past all bounded tiers', () => {
    const tiers = [tier(1, '0', '180', '3.0'), tier(2, '180', null, '4.5')];
    const r = tieredAmount(new Decimal('15'), new Decimal('1000'), tiers);
    expect(r.parts).toHaveLength(1);
    expect(r.parts[0].tierNo).toBe(2);
    expect(r.parts[0].qty.toFixed(4)).toBe('15.0000');
    expect(r.amountCent).toBe(6750n); // 15 × 4.5
  });

  it('handles ytd = 0 (first bill of the calendar year)', () => {
    const tiers = [tier(1, '0', '180', '3.0'), tier(2, '180', null, '4.5')];
    const r = tieredAmount(new Decimal('200'), new Decimal('0'), tiers);
    expect(r.parts).toHaveLength(2);
    expect(r.parts[0].qty.toFixed(4)).toBe('180.0000');
    expect(r.parts[0].amountCent).toBe(54000n); // 180 × 3.0
    expect(r.parts[1].qty.toFixed(4)).toBe('20.0000');
    expect(r.parts[1].amountCent).toBe(9000n); // 20 × 4.5
    expect(r.amountCent).toBe(63000n);
  });

  it('keeps 4-decimal segment precision, rounding only at row level', () => {
    // ytd 179.9999 → only 0.0001 m³ lands in tier 1 (0.0003元 → 0分),
    // remaining 10 m³ bills at the top tier.
    const tiers = [tier(1, '0', '180', '3.0'), tier(2, '180', null, '4.5')];
    const r = tieredAmount(new Decimal('10.0001'), new Decimal('179.9999'), tiers);
    expect(r.parts).toHaveLength(2);
    expect(r.parts[0].qty.toFixed(4)).toBe('0.0001');
    expect(r.parts[0].amountCent).toBe(0n);
    expect(r.parts[1].qty.toFixed(4)).toBe('10.0000');
    expect(r.parts[1].amountCent).toBe(4500n);
    expect(r.amountCent).toBe(4500n);
  });

  it('avoids the 0.1+0.2 float trap (exact Decimal product, single HALF_UP)', () => {
    // 33.3333 × 3.141593 = 104.7196619469 exactly → 10472分
    const r = tieredAmount(new Decimal('33.3333'), new Decimal('0'), [
      tier(1, '0', null, '3.141593'),
    ]);
    expect(r.amountCent).toBe(10472n);
    // Float path 0.335*3 = 1.0050000000000001; exact Decimal = 1.005 → 101分.
    const r2 = tieredAmount(new Decimal('0.335'), new Decimal('0'), [
      tier(1, '0', null, '3'),
    ]);
    expect(r2.amountCent).toBe(101n);
  });

  it('handles large values without precision loss (99999999.9999 m³)', () => {
    // 99999999.9999 × 3.141593 = 314159299.9996858407 → 31415930000分
    const r = tieredAmount(new Decimal('99999999.9999'), new Decimal('0'), [
      tier(1, '0', null, '3.141593'),
    ]);
    expect(r.amountCent).toBe(31415930000n);
    expect(r.parts[0].qty.toFixed(4)).toBe('99999999.9999');
  });

  it('accepts tiers in any input order (walks by tierNo)', () => {
    const tiers = [tier(2, '180', null, '4.5'), tier(1, '0', '180', '3.0')];
    const r = tieredAmount(new Decimal('15'), new Decimal('170'), tiers);
    expect(r.parts.map((p) => p.tierNo)).toEqual([1, 2]);
    expect(r.amountCent).toBe(5250n);
  });

  it('returns no parts for zero / negative-zero qty', () => {
    const tiers = [tier(1, '0', null, '3.0')];
    expect(tieredAmount(new Decimal('0'), new Decimal('0'), tiers)).toEqual({
      amountCent: 0n,
      parts: [],
    });
    expect(
      tieredAmount(new Decimal('-0.0000'), new Decimal('0'), tiers),
    ).toEqual({ amountCent: 0n, parts: [] });
  });

  it('throws DomainError on negative qty / ytd', () => {
    const tiers = [tier(1, '0', null, '3.0')];
    expect(() => tieredAmount(new Decimal('-1'), new Decimal('0'), tiers))
      .toThrowError(DomainError);
    try {
      tieredAmount(new Decimal('-1'), new Decimal('0'), tiers);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DomainError);
      expect((e as DomainError).code).toBe('NEGATIVE_QTY');
    }
    try {
      tieredAmount(new Decimal('1'), new Decimal('-0.5'), tiers);
      expect.unreachable();
    } catch (e) {
      expect((e as DomainError).code).toBe('NEGATIVE_YTD_BEFORE_QTY');
    }
  });

  it('throws TARIFF_NO_TIERS when pricing qty with an empty tier list', () => {
    try {
      tieredAmount(new Decimal('5'), new Decimal('0'), []);
      expect.unreachable();
    } catch (e) {
      expect((e as DomainError).code).toBe('TARIFF_NO_TIERS');
    }
  });

  it('throws TARIFF_TIERS_EXHAUSTED when qty outruns all bounded tiers', () => {
    // No unbounded top tier: 150 m³ but only 0–100 priced.
    expect(() =>
      tieredAmount(new Decimal('150'), new Decimal('0'), [
        tier(1, '0', '100', '3.0'),
      ]),
    ).toThrowError(DomainError);
    try {
      tieredAmount(new Decimal('150'), new Decimal('0'), [
        tier(1, '0', '100', '3.0'),
      ]);
      expect.unreachable();
    } catch (e) {
      expect((e as DomainError).code).toBe('TARIFF_TIERS_EXHAUSTED');
    }
  });
});
