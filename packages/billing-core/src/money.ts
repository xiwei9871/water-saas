import { Decimal } from 'decimal.js';

/**
 * Money helpers (spec §3): money is stored as bigint cents; Decimal
 * amounts convert at the boundary so no code path ever does float math.
 * Lands ahead of T9's computeBill — kept here so the conversion rule
 * (HALF_UP to 2dp) lives in exactly one place.
 */

/** Decimal amount → cents, rounded HALF_UP to 2 decimal places first. */
export function toCents(amount: Decimal.Value): bigint {
  const rounded = new Decimal(amount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return BigInt(rounded.times(100).toFixed(0));
}

/** bigint cents → Decimal amount (e.g. 1234n → 12.34). */
export function fromCents(cents: bigint): Decimal {
  return new Decimal(cents.toString()).div(100);
}
