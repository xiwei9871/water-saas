import { Decimal } from 'decimal.js';

/**
 * AUTO_AVG3 estimator (spec §2.3): mean of the account's last ≤3 valid
 * ACTUAL-derived usage quantities. Averages whatever history exists —
 * 1–2 values still produce a mean; only an empty history returns null
 * (the caller then requires an operator-entered usage instead).
 *
 * All math stays in Decimal — callers pass Prisma.Decimal rows straight
 * through (Prisma.Decimal is the same decimal.js class); no JS number
 * ever enters the computation.
 */
export function estimateAvg3(validUsages: Decimal[]): Decimal | null {
  if (validUsages.length === 0) return null;
  const last3 = validUsages.slice(-3);
  return last3
    .reduce((acc, v) => acc.plus(v), new Decimal(0))
    .div(last3.length)
    .toDecimalPlaces(4);
}
