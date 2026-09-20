import { Decimal } from 'decimal.js';
import { DomainError } from './errors.js';
import { fromCents } from './money.js';
import { roundCent } from './round.js';
import { type TariffTier, tieredAmount } from './tariff.js';

/** `fee_item.calc_type` (spec §2.5). */
export type FeeCalcType = 'PER_QTY' | 'FIXED' | 'PERCENT';

/**
 * One fee item with the tariff tiers that price it. For ALL calc types the
 * rate source is `tiers[].unitPrice`:
 * - PER_QTY — one or more tiers; qty walks cumulative-annual boundaries
 *   (see tieredAmount).
 * - FIXED — exactly one tier; `unitPrice` is the flat charge in yuan.
 *   `tierNo`/`fromQty`/`toQty` are ignored (toQty may be null).
 * - PERCENT — exactly one tier; `unitPrice` is the rate AS A FRACTION
 *   (0.05 = 5%), applied to the bill's non-PERCENT subtotal.
 */
export interface FeeItemInput {
  code: string;
  calcType: FeeCalcType;
  tiers: TariffTier[];
  /**
   * Household-population tier scaling (一户多人口申报): when present AND
   * `ComputeBillInput.householdSize` exceeds `baseHousehold`, every finite
   * `toQty` boundary shifts right by
   * `(householdSize - baseHousehold) × perPersonQty` (annual m³). The
   * unbounded top tier (`toQty = null`) never moves. Flat/single-tier items
   * are unaffected in practice since their only bound is null.
   */
  householdScale?: { baseHousehold: number; perPersonQty: Decimal };
}

/**
 * Draft `bill_item` row (spec §2.5: `item_type` NORMAL for all rows the
 * engine produces; qty/unitPrice are the price snapshot for audit).
 * `qty`/`unitPrice` are absent where the calc type has no such notion:
 * FIXED rows carry no `qty`; PERCENT rows carry no `qty` and put the
 * fraction in `unitPrice`.
 */
export interface BillItemDraft {
  feeItemCode: string;
  itemType: 'NORMAL';
  qty?: Decimal;
  unitPrice?: Decimal;
  amountCent: bigint;
  description: string;
}

export interface ComputeBillInput {
  /** Settlement `total_usage_qty` for the period (m³). */
  usageQty: Decimal;
  /** Consumption already billed this calendar year before this bill. */
  ytdBeforeQty: Decimal;
  /**
   * Declared household population snapshot for the billed period (see
   * `FeeItemInput.householdScale`). null/undefined → no scaling.
   */
  householdSize?: number | null;
  feeItems: FeeItemInput[];
}

export interface ComputeBillResult {
  items: BillItemDraft[];
  totalAmountCent: bigint;
}

/**
 * Shift every finite `toQty` boundary right by
 * `max(0, householdSize - baseHousehold) × perPersonQty`.
 * `toQty = null` (unbounded top tier) and `fromQty` never move —
 * `tieredAmount` allocates by `toQty` + cursor, so shifted bounds alone
 * widen each tier's capacity consistently.
 */
function scaleTierBounds(
  tiers: TariffTier[],
  scale: NonNullable<FeeItemInput['householdScale']>,
  householdSize: number,
): TariffTier[] {
  const extra = Math.max(0, householdSize - scale.baseHousehold);
  const shift = scale.perPersonQty.times(extra);
  if (shift.isZero()) return tiers;
  return tiers.map((t) =>
    t.toQty === null ? t : { ...t, toQty: t.toQty.plus(shift) },
  );
}

function singleTier(fi: FeeItemInput): TariffTier {
  if (fi.tiers.length === 0) {
    throw new DomainError(
      'FEE_ITEM_NO_TIERS',
      `fee item ${fi.code} (${fi.calcType}) has no tiers`,
    );
  }
  if (fi.tiers.length !== 1) {
    throw new DomainError(
      'FEE_ITEM_INVALID_TIER_COUNT',
      `fee item ${fi.code} (${fi.calcType}) requires exactly 1 tier, got ${fi.tiers.length}`,
    );
  }
  return fi.tiers[0];
}

/**
 * Compute all `bill_item` rows for one settlement bill. Pure: no IO, no
 * clock — `ytdBeforeQty` is supplied by the caller.
 *
 * Row semantics:
 * - PER_QTY → ONE ROW PER TIER PART (each tier segment is its own
 *   bill_item row; qty = segment qty, unitPrice = tier price, amountCent =
 *   independently rounded line). `usageQty = 0` → no PER_QTY rows at all.
 * - FIXED → one row per fee item: amountCent = roundCent(unitPrice), no
 *   qty. Owed regardless of usage (fixed monthly charge).
 * - PERCENT → one row per fee item: amountCent = roundCent(base × rate)
 *   where `base` is the subtotal IN YUAN of all non-PERCENT rows already
 *   computed in THIS bill. PERCENT items do NOT compound — with several
 *   PERCENT items each applies to the same non-PERCENT subtotal.
 *
 * Ordering: all PER_QTY + FIXED rows first (in input fee-item order),
 * then PERCENT rows (in input order). `totalAmountCent = Σ amountCent`.
 *
 * Errors (all DomainError):
 * - `NEGATIVE_QTY` / `NEGATIVE_YTD_BEFORE_QTY` — negative inputs
 *   (Decimal('-0.0000') counts as zero, not negative).
 * - `FEE_ITEM_NO_TIERS` — fee item with an empty tiers array (any type;
 *   validated even when usageQty = 0 — invalid config is never skipped).
 * - `FEE_ITEM_INVALID_TIER_COUNT` — FIXED/PERCENT with ≠ 1 tier.
 * - `UNKNOWN_CALC_TYPE` — calcType outside the union (defends JS callers).
 * - plus `TARIFF_NO_TIERS` / `TARIFF_TIERS_EXHAUSTED` from tieredAmount.
 */
export function computeBill(input: ComputeBillInput): ComputeBillResult {
  const { usageQty, ytdBeforeQty, householdSize, feeItems } = input;
  if (!usageQty.isFinite()) {
    throw new DomainError('INVALID_QTY', `usageQty must be finite, got ${usageQty}`);
  }
  if (!ytdBeforeQty.isFinite()) {
    throw new DomainError(
      'INVALID_YTD',
      `ytdBeforeQty must be finite, got ${ytdBeforeQty}`,
    );
  }
  if (usageQty.lt(0)) {
    throw new DomainError('NEGATIVE_QTY', `usageQty must be >= 0, got ${usageQty}`);
  }
  if (ytdBeforeQty.lt(0)) {
    throw new DomainError(
      'NEGATIVE_YTD_BEFORE_QTY',
      `ytdBeforeQty must be >= 0, got ${ytdBeforeQty}`,
    );
  }
  if (
    householdSize != null &&
    (!Number.isInteger(householdSize) || householdSize < 0)
  ) {
    throw new DomainError(
      'INVALID_HOUSEHOLD_SIZE',
      `householdSize must be a non-negative integer, got ${householdSize}`,
    );
  }
  for (const fi of feeItems) {
    const s = fi.householdScale;
    if (!s) continue;
    if (
      !Number.isInteger(s.baseHousehold) ||
      s.baseHousehold < 1 ||
      !s.perPersonQty.isFinite() ||
      s.perPersonQty.lt(0)
    ) {
      throw new DomainError(
        'INVALID_HOUSEHOLD_SCALE',
        `fee item ${fi.code}: householdScale requires integer baseHousehold >= 1 and finite perPersonQty >= 0`,
      );
    }
  }

  const items: BillItemDraft[] = [];

  // Pass 1: PER_QTY + FIXED, in input order.
  for (const fi of feeItems) {
    if (fi.calcType === 'PER_QTY') {
      if (fi.tiers.length === 0) {
        throw new DomainError(
          'FEE_ITEM_NO_TIERS',
          `fee item ${fi.code} (PER_QTY) has no tiers`,
        );
      }
      if (usageQty.isZero()) continue;
      const tiers =
        fi.householdScale && householdSize != null
          ? scaleTierBounds(fi.tiers, fi.householdScale, householdSize)
          : fi.tiers;
      for (const p of tieredAmount(usageQty, ytdBeforeQty, tiers).parts) {
        items.push({
          feeItemCode: fi.code,
          itemType: 'NORMAL',
          qty: p.qty,
          unitPrice: p.unitPrice,
          amountCent: p.amountCent,
          description: `${fi.code} tier ${p.tierNo}: ${p.qty} m³ @ ${p.unitPrice}`,
        });
      }
    } else if (fi.calcType === 'FIXED') {
      const tier = singleTier(fi);
      items.push({
        feeItemCode: fi.code,
        itemType: 'NORMAL',
        unitPrice: tier.unitPrice,
        amountCent: roundCent(tier.unitPrice),
        description: `${fi.code} fixed @ ${tier.unitPrice}`,
      });
    } else if (fi.calcType !== 'PERCENT') {
      throw new DomainError(
        'UNKNOWN_CALC_TYPE',
        `fee item ${fi.code}: unknown calcType ${fi.calcType}`,
      );
    }
    // PERCENT handled in pass 2 — needs the non-PERCENT subtotal.
  }

  // Pass 2: PERCENT rows over the non-PERCENT subtotal.
  const baseCent = items.reduce((sum, i) => sum + i.amountCent, 0n);
  const baseYuan = fromCents(baseCent);
  for (const fi of feeItems) {
    if (fi.calcType !== 'PERCENT') continue;
    const tier = singleTier(fi);
    const amountCent = roundCent(baseYuan.times(tier.unitPrice));
    // A zero row is pure noise — "5% of nothing" is not a billable fact.
    if (amountCent === 0n) continue;
    items.push({
      feeItemCode: fi.code,
      itemType: 'NORMAL',
      unitPrice: tier.unitPrice,
      amountCent,
      description: `${fi.code} ${tier.unitPrice} × ${baseYuan}`,
    });
  }

  const totalAmountCent = items.reduce((sum, i) => sum + i.amountCent, 0n);
  return { items, totalAmountCent };
}
