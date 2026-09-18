import Decimal from 'decimal.js';

export { Decimal };
export { estimateAvg3 } from './estimator.js';
export { fromCents, toCents } from './money.js';

/** Round a decimal value to the given number of places (default: 2). */
export function round(value: Decimal.Value, places = 2): Decimal {
  return new Decimal(value).toDecimalPlaces(places, Decimal.ROUND_HALF_UP);
}
