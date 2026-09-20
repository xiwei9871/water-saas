import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { computeBill, DomainError } from '../src/index.js';
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

/**
 * Chengdu-style ladder (一户一表): 0–216 / 216–300 / 300+ per YEAR.
 * baseHousehold=4, perPersonQty=51 → each extra person shifts every
 * finite toQty right by 51: 5 people ⇒ 0–267–351–∞.
 */
const waterFee = (withScale = true): FeeItemInput => ({
  code: 'WATER',
  calcType: 'PER_QTY',
  tiers: [tier(1, '0', '216', '3.0'), tier(2, '216', '300', '4.0'), tier(3, '300', null, '5.0')],
  ...(withScale
    ? { householdScale: { baseHousehold: 4, perPersonQty: new Decimal('51') } }
    : {}),
});

/** Flat sewage fee — single-tier PER_QTY, never household-scaled. */
const sewageFee = (): FeeItemInput => ({
  code: 'SEWAGE',
  calcType: 'PER_QTY',
  tiers: [tier(1, '0', null, '1.0')],
});

const bill = (usage: string, ytd: string, householdSize?: number | null, items = [waterFee()]) =>
  computeBill({
    usageQty: new Decimal(usage),
    ytdBeforeQty: new Decimal(ytd),
    householdSize,
    feeItems: items,
  });

describe('computeBill — household tier scaling', () => {
  it('4 people (base) keeps standard boundaries — 217 splits at 216', () => {
    const r = bill('217', '0', 4);
    const water = r.items.filter((i) => i.feeItemCode === 'WATER');
    expect(water.map((i) => i.qty!.toFixed(4))).toEqual(['216.0000', '1.0000']);
    expect(water.map((i) => i.unitPrice!.toString())).toEqual(['3', '4']);
  });

  it.each(['215', '216'])('5 people: qty=%s stays entirely in tier 1', (q) => {
    const r = bill(q, '0', 5);
    const water = r.items.filter((i) => i.feeItemCode === 'WATER');
    expect(water).toHaveLength(1);
    expect(water[0].qty!.toFixed(4)).toBe(new Decimal(q).toFixed(4));
    expect(water[0].unitPrice!.toString()).toBe('3');
  });

  it('5 people: 217 still in tier 1 (boundary moved to 267)', () => {
    const r = bill('217', '0', 5);
    const water = r.items.filter((i) => i.feeItemCode === 'WATER');
    expect(water).toHaveLength(1);
    expect(water[0].unitPrice!.toString()).toBe('3');
  });

  it.each(['266', '267'])('5 people: qty=%s still within shifted tier 1', (q) => {
    const r = bill(q, '0', 5);
    const water = r.items.filter((i) => i.feeItemCode === 'WATER');
    expect(water).toHaveLength(1);
  });

  it('5 people: 268 splits 267@tier1 + 1@tier2', () => {
    const r = bill('268', '0', 5);
    const water = r.items.filter((i) => i.feeItemCode === 'WATER');
    expect(water.map((i) => i.qty!.toFixed(4))).toEqual(['267.0000', '1.0000']);
    expect(water.map((i) => i.unitPrice!.toString())).toEqual(['3', '4']);
    expect(water.map((i) => i.amountCent)).toEqual([80100n, 400n]);
  });

  it('5 people: second boundary shifts too — 352 crosses 351 into tier 3', () => {
    const r = bill('352', '0', 5);
    const water = r.items.filter((i) => i.feeItemCode === 'WATER');
    expect(water.map((i) => i.qty!.toFixed(4))).toEqual([
      '267.0000',
      '84.0000',
      '1.0000',
    ]);
    expect(water[2].unitPrice!.toString()).toBe('5');
  });

  it('mid-year YTD crossing: ytd=265, qty=5 → 265–267 tier1, 267–270 tier2', () => {
    const r = bill('5', '265', 5);
    const water = r.items.filter((i) => i.feeItemCode === 'WATER');
    expect(water.map((i) => i.qty!.toFixed(4))).toEqual(['2.0000', '3.0000']);
    expect(water.map((i) => i.unitPrice!.toString())).toEqual(['3', '4']);
  });

  it('cross-year: new-year ytd=0 resets ladder (scaled boundaries intact)', () => {
    const r = bill('10', '0', 5);
    const water = r.items.filter((i) => i.feeItemCode === 'WATER');
    expect(water).toHaveLength(1);
    expect(water[0].unitPrice!.toString()).toBe('3');
  });

  it('householdSize below base (3) does NOT shrink standard boundaries', () => {
    const r = bill('217', '0', 3);
    const water = r.items.filter((i) => i.feeItemCode === 'WATER');
    expect(water.map((i) => i.qty!.toFixed(4))).toEqual(['216.0000', '1.0000']);
  });

  it.each([null, undefined])(
    'householdSize=%s with scale params → no scaling',
    (size) => {
      const r = bill('217', '0', size);
      const water = r.items.filter((i) => i.feeItemCode === 'WATER');
      expect(water.map((i) => i.qty!.toFixed(4))).toEqual(['216.0000', '1.0000']);
    },
  );

  it('householdSize=5 but item has no householdScale → standard boundaries', () => {
    const r = bill('217', '0', 5, [waterFee(false)]);
    const water = r.items.filter((i) => i.feeItemCode === 'WATER');
    expect(water.map((i) => i.qty!.toFixed(4))).toEqual(['216.0000', '1.0000']);
  });

  it('single-tier fee item is unaffected even when scaled params exist', () => {
    const r = computeBill({
      usageQty: new Decimal('10'),
      ytdBeforeQty: new Decimal('0'),
      householdSize: 6,
      feeItems: [
        {
          code: 'SEWAGE',
          calcType: 'PER_QTY',
          tiers: [tier(1, '0', null, '1.0')],
          householdScale: { baseHousehold: 4, perPersonQty: new Decimal('51') },
        },
      ],
    });
    expect(r.items).toHaveLength(1);
    expect(r.items[0].qty!.toFixed(4)).toBe('10.0000');
    expect(r.items[0].amountCent).toBe(1000n);
  });

  it('水费 tiered (scaled) + 污水费 flat (not scaled) in one bill', () => {
    const r = bill('268', '0', 5, [waterFee(), sewageFee()]);
    const water = r.items.filter((i) => i.feeItemCode === 'WATER');
    const sewage = r.items.filter((i) => i.feeItemCode === 'SEWAGE');
    expect(water.map((i) => i.qty!.toFixed(4))).toEqual(['267.0000', '1.0000']);
    expect(sewage.map((i) => i.qty!.toFixed(4))).toEqual(['268.0000']);
    expect(r.totalAmountCent).toBe(80100n + 400n + 26800n);
  });

  it('bimonthly: one bill covers two months, annual bounds still apply', () => {
    // Two months ≈ 60 m³ for a 5-person household — all in shifted tier 1.
    const r = bill('60', '0', 5);
    const water = r.items.filter((i) => i.feeItemCode === 'WATER');
    expect(water).toHaveLength(1);
    expect(water[0].qty!.toFixed(4)).toBe('60.0000');
  });

  it('rejects non-integer householdSize', () => {
    expect(() => bill('10', '0', 4.5)).toThrow(DomainError);
    expect(() => bill('10', '0', 4.5)).toThrow(/householdSize/i);
  });

  it('rejects negative householdSize', () => {
    expect(() => bill('10', '0', -1)).toThrow(DomainError);
  });
});
