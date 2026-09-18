import Decimal from 'decimal.js';

export { Decimal };
export { estimateAvg3 } from './estimator.js';
export { DomainError } from './errors.js';
export { fromCents, toCents } from './money.js';
export {
  allocateUsage,
  buildReconciliation,
  reprice,
} from './reconcile.js';
export type {
  AllocateUsageInput,
  BuildReconciliationInput,
  ReconcileAllocPolicy,
  ReconciliationAmounts,
  RepriceBreakdownRow,
  RepricePeriod,
  RepriceResult,
} from './reconcile.js';
export { roundCent } from './round.js';
export { computeBill } from './settle.js';
export type {
  BillItemDraft,
  ComputeBillInput,
  ComputeBillResult,
  FeeCalcType,
  FeeItemInput,
} from './settle.js';
export { tieredAmount } from './tariff.js';
export type { TariffTier, TieredAmount, TierPart } from './tariff.js';

/** Round a decimal value to the given number of places (default: 2). */
export function round(value: Decimal.Value, places = 2): Decimal {
  return new Decimal(value).toDecimalPlaces(places, Decimal.ROUND_HALF_UP);
}
