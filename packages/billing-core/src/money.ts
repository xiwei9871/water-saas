import { Decimal } from 'decimal.js';
import { DomainError } from './errors.js';

/**
 * Money helpers (spec §3): money is stored as bigint cents; Decimal
 * amounts convert at the boundary so no code path ever does float math.
 * Lands ahead of T9's computeBill — kept here so the conversion rule
 * (HALF_UP to 2dp) lives in exactly one place.
 */

/**
 * Decimal amount → cents, rounded HALF_UP to 2 decimal places first.
 * Accepts `Decimal | string` — a JS `number` argument is rejected because
 * binary floats lie at the boundary (`new Decimal(1.005)` = 1.0049999… →
 * 100n, while `toCents('1.005')` = 101n). Callers crossing a wire boundary
 * must stringify first.
 */
export function toCents(amount: Decimal | string): bigint {
  if (typeof amount === 'number') {
    throw new DomainError(
      'NUMBER_NOT_ALLOWED',
      'pass Decimal or string — JS number loses cents precision',
    );
  }
  const rounded = new Decimal(amount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return BigInt(rounded.times(100).toFixed(0));
}

/** bigint cents → Decimal amount (e.g. 1234n → 12.34). */
export function fromCents(cents: bigint): Decimal {
  return new Decimal(cents.toString()).div(100);
}
