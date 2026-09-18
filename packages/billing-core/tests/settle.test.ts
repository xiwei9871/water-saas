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
const percent = (code: string, fraction: string): FeeItemInput => ({
  code,
  calcType: 'PERCENT',
  tiers: [tier(1, '0', null, fraction)],
});

const D = (s: string) => new Decimal(s);

describe('computeBill — PER_QTY', () => {
  it('produces one row for a flat single-tier fee item', () => {
    const r = computeBill({
      usageQty: D('48'),
      ytdBeforeQty: D('0'),
      feeItems: [perQty('水费', [tier(1, '0', null, '3.2')])],
    });
    expect(r.items).toHaveLength(1);
    const row = r.items[0];
    expect(row.feeItemCode).toBe('水费');
    expect(row.itemType).toBe('NORMAL');
    expect(row.qty!.toFixed(4)).toBe('48.0000');
    expect(row.unitPrice!.toString()).toBe('3.2');
    expect(row.amountCent).toBe(15360n);
    expect(r.totalAmountCent).toBe(15360n);
  });

  it('produces one row PER TIER PART for tiered pricing', () => {
    const r = computeBill({
      usageQty: D('15'),
      ytdBeforeQty: D('170'),
      feeItems: [
        perQty('水费', [tier(1, '0', '180', '3.0'), tier(2, '180', null, '4.5')]),
      ],
    });
    expect(r.items).toHaveLength(2);
    expect(r.items[0].qty!.toFixed(4)).toBe('10.0000');
    expect(r.items[0].unitPrice!.toString()).toBe('3');
    expect(r.items[0].amountCent).toBe(3000n);
    expect(r.items[1].qty!.toFixed(4)).toBe('5.0000');
    expect(r.items[1].amountCent).toBe(2250n);
    expect(r.totalAmountCent).toBe(5250n);
  });

  it('emits no PER_QTY rows when usageQty is zero', () => {
    const r = computeBill({
      usageQty: D('0'),
      ytdBeforeQty: D('0'),
      feeItems: [perQty('水费', [tier(1, '0', null, '3.2')])],
    });
    expect(r.items).toHaveLength(0);
    expect(r.totalAmountCent).toBe(0n);
  });

  it('treats Decimal(-0.0000) usage as zero — no rows, no error', () => {
    const r = computeBill({
      usageQty: D('-0.0000'),
      ytdBeforeQty: D('0'),
      feeItems: [perQty('水费', [tier(1, '0', null, '3.2')])],
    });
    expect(r.items).toHaveLength(0);
    expect(r.totalAmountCent).toBe(0n);
  });
});

describe('computeBill — FIXED', () => {
  it('emits a fixed row even when usageQty is zero', () => {
    const r = computeBill({
      usageQty: D('0'),
      ytdBeforeQty: D('0'),
      feeItems: [fixed('垃圾处理费', '5.00')],
    });
    expect(r.items).toHaveLength(1);
    expect(r.items[0].amountCent).toBe(500n);
    expect(r.items[0].qty).toBeUndefined();
    expect(r.items[0].unitPrice!.toString()).toBe('5');
    expect(r.totalAmountCent).toBe(500n);
  });

  it('rounds the fixed amount HALF_UP to cents', () => {
    const r = computeBill({
      usageQty: D('0'),
      ytdBeforeQty: D('0'),
      feeItems: [fixed('附加', '1.005')],
    });
    expect(r.items[0].amountCent).toBe(101n);
  });
});

describe('computeBill — PERCENT', () => {
  it('applies percent to the non-PERCENT subtotal of this bill', () => {
    const r = computeBill({
      usageQty: D('0'),
      ytdBeforeQty: D('0'),
      feeItems: [fixed('垃圾处理费', '100'), percent('附加费', '0.05')],
    });
    expect(r.items).toHaveLength(2);
    const pct = r.items[1];
    expect(pct.feeItemCode).toBe('附加费');
    expect(pct.itemType).toBe('NORMAL');
    expect(pct.qty).toBeUndefined();
    expect(pct.unitPrice!.toString()).toBe('0.05'); // fraction, not % points
    expect(pct.amountCent).toBe(500n); // 100.00元 × 0.05 = 5.00元
    expect(r.totalAmountCent).toBe(10500n);
  });

  it('applies percent over the FIXED subtotal when usageQty is zero', () => {
    const r = computeBill({
      usageQty: D('0'),
      ytdBeforeQty: D('0'),
      feeItems: [
        perQty('水费', [tier(1, '0', null, '3.2')]), // no rows
        fixed('垃圾处理费', '5.00'),
        percent('附加费', '0.05'),
      ],
    });
    expect(r.items).toHaveLength(2);
    expect(r.items[1].amountCent).toBe(25n); // 5.00 × 0.05 = 0.25元
    expect(r.totalAmountCent).toBe(525n);
  });

  it('does not compound: two PERCENT items share the same base', () => {
    const r = computeBill({
      usageQty: D('0'),
      ytdBeforeQty: D('0'),
      feeItems: [
        fixed('基本费', '100'),
        percent('附加A', '0.05'),
        percent('附加B', '0.10'),
      ],
    });
    expect(r.items.map((i) => i.amountCent)).toEqual([10000n, 500n, 1000n]);
    expect(r.totalAmountCent).toBe(11500n);
  });

  it('emits a zero-amount PERCENT row when the base is zero', () => {
    const r = computeBill({
      usageQty: D('5'),
      ytdBeforeQty: D('0'),
      feeItems: [percent('附加费', '0.05')],
    });
    expect(r.items).toHaveLength(1);
    expect(r.items[0].amountCent).toBe(0n);
    expect(r.totalAmountCent).toBe(0n);
  });
});

describe('computeBill — multi fee item bill', () => {
  it('水费 tiered + 污水费 flat + 垃圾处理费 fixed + 附加费 5%', () => {
    const r = computeBill({
      usageQty: D('100'),
      ytdBeforeQty: D('0'),
      feeItems: [
        perQty('水费', [tier(1, '0', '60', '3.0'), tier(2, '60', null, '4.5')]),
        perQty('污水费', [tier(1, '0', null, '1.2')]),
        fixed('垃圾处理费', '5.00'),
        percent('附加费', '0.05'),
      ],
    });
    // 水费: 60×3.0=18000n + 40×4.5=18000n; 污水费: 100×1.2=12000n; 固定: 500n
    // 附加费: (18000+18000+12000+500)=48500分 → 485.00元 ×0.05 = 24.25元 → 2425n
    expect(r.items).toHaveLength(5);
    expect(r.items.map((i) => i.feeItemCode)).toEqual([
      '水费',
      '水费',
      '污水费',
      '垃圾处理费',
      '附加费',
    ]);
    expect(r.items.map((i) => i.amountCent)).toEqual([
      18000n, 18000n, 12000n, 500n, 2425n,
    ]);
    expect(r.totalAmountCent).toBe(50925n);
    // shape spot checks
    expect(r.items[2].qty!.toFixed(4)).toBe('100.0000');
    expect(r.items[3].qty).toBeUndefined();
    expect(r.items[4].qty).toBeUndefined();
    expect(r.items[4].unitPrice!.toString()).toBe('0.05');
    for (const i of r.items) {
      expect(i.itemType).toBe('NORMAL');
      expect(i.description).toContain(i.feeItemCode);
    }
  });
});

describe('computeBill — DomainError paths', () => {
  it('throws NEGATIVE_QTY on negative usageQty', () => {
    try {
      computeBill({
        usageQty: D('-1'),
        ytdBeforeQty: D('0'),
        feeItems: [],
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DomainError);
      expect((e as DomainError).code).toBe('NEGATIVE_QTY');
    }
  });

  it('throws NEGATIVE_YTD_BEFORE_QTY even when usageQty is zero', () => {
    try {
      computeBill({ usageQty: D('0'), ytdBeforeQty: D('-5'), feeItems: [] });
      expect.unreachable();
    } catch (e) {
      expect((e as DomainError).code).toBe('NEGATIVE_YTD_BEFORE_QTY');
    }
  });

  it('throws FEE_ITEM_NO_TIERS for a tierless PER_QTY fee item', () => {
    // validated even when usageQty = 0 — invalid config is never skipped
    try {
      computeBill({
        usageQty: D('0'),
        ytdBeforeQty: D('0'),
        feeItems: [{ code: '水费', calcType: 'PER_QTY', tiers: [] }],
      });
      expect.unreachable();
    } catch (e) {
      expect((e as DomainError).code).toBe('FEE_ITEM_NO_TIERS');
    }
  });

  it('throws FEE_ITEM_NO_TIERS / FEE_ITEM_INVALID_TIER_COUNT for FIXED', () => {
    try {
      computeBill({
        usageQty: D('0'),
        ytdBeforeQty: D('0'),
        feeItems: [{ code: '垃圾费', calcType: 'FIXED', tiers: [] }],
      });
      expect.unreachable();
    } catch (e) {
      expect((e as DomainError).code).toBe('FEE_ITEM_NO_TIERS');
    }
    try {
      computeBill({
        usageQty: D('0'),
        ytdBeforeQty: D('0'),
        feeItems: [
          {
            code: '垃圾费',
            calcType: 'FIXED',
            tiers: [tier(1, '0', '10', '5'), tier(2, '10', null, '8')],
          },
        ],
      });
      expect.unreachable();
    } catch (e) {
      expect((e as DomainError).code).toBe('FEE_ITEM_INVALID_TIER_COUNT');
    }
  });

  it('throws FEE_ITEM_INVALID_TIER_COUNT for multi-tier PERCENT', () => {
    try {
      computeBill({
        usageQty: D('0'),
        ytdBeforeQty: D('0'),
        feeItems: [
          fixed('基本费', '100'),
          {
            code: '附加费',
            calcType: 'PERCENT',
            tiers: [tier(1, '0', null, '0.05'), tier(2, '0', null, '0.03')],
          },
        ],
      });
      expect.unreachable();
    } catch (e) {
      expect((e as DomainError).code).toBe('FEE_ITEM_INVALID_TIER_COUNT');
    }
  });

  it('propagates TARIFF_TIERS_EXHAUSTED from tieredAmount', () => {
    try {
      computeBill({
        usageQty: D('150'),
        ytdBeforeQty: D('0'),
        feeItems: [perQty('水费', [tier(1, '0', '100', '3.0')])],
      });
      expect.unreachable();
    } catch (e) {
      expect((e as DomainError).code).toBe('TARIFF_TIERS_EXHAUSTED');
    }
  });
});
