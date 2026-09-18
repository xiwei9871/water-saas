import { Decimal } from 'decimal.js';

/**
 * Engine-wide Decimal configuration (spec §1.3): quantities are
 * numeric(18,4) and unit prices numeric(18,6), so a qty×price product can
 * carry ~34 significant digits — default precision 20 could silently lose
 * digits mid-computation. 40 digits of headroom keep every product exact;
 * the only rounding point is roundCent at bill-item materialization.
 * Idempotent; runs once when this module is imported (all engine modules
 * depend on it transitively).
 */
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

/**
 * Decimal yuan amount → bigint cents: `v × 100`, HALF_UP to integer cents.
 *
 * This is THE single rounding point for every `bill_item.amount`
 * (spec §1.3: 每条 bill_item.amount 按 qty × unit_price 以 HALF_UP 入到分,
 * bill.total = Σ items). Decimal.ROUND_HALF_UP rounds ties AWAY FROM ZERO,
 * so it applies symmetrically to charge and credit (negative) rows:
 *   1.005 → 101n,  -1.005 → -101n,  -0.005 → -1n.
 * Zero and negative zero both yield 0n.
 */
export function roundCent(v: Decimal): bigint {
  return BigInt(v.times(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0));
}
