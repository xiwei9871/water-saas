import { Decimal } from 'decimal.js';
import { computeBill, type FeeItemInput } from './settle.js';

/**
 * Anchor-based reconciliation (锚点校准, spec §2.4) — the pure math behind
 * POST /reconciliations. All money math stays in Decimal/bigint; the API
 * layer supplies the persisted facts (readings, settlement usages, fee
 * items, ytd cursor) and consumes the results verbatim.
 *
 * Vocabulary: a trusted actual reading arrives (the ACTUAL) and is
 * compared against the previous trusted reading (the ANCHOR — always a
 * real dial, never an estimate's synthetic end). The settlements billed
 * between the two readings are the SPAN; their recorded usage was
 * estimate-based, so the true cumulative usage `actual − anchor` is
 * redistributed over the span and repriced at each period's own tariff.
 */

export interface BuildReconciliationInput {
  /** Anchor reading's dial value (m³). */
  anchorValue: Decimal;
  /** New actual reading's dial value (m³). */
  actualValue: Decimal;
  /** Per-period settled usage of the span, chronological order. */
  settledUsages: Decimal[];
}

export interface ReconciliationAmounts {
  /** actual − anchor: the true cumulative usage of the span. */
  actualTotalUsage: Decimal;
  /** Σ settled usage — what the span was billed for. */
  previouslySettled: Decimal;
  /** actualTotalUsage − previouslySettled (negative = over-estimated). */
  remainderUsage: Decimal;
}

/**
 * The three reconciliation quantities (spec §2.4): `remainder ≥ 0` is
 * absorbable under-read usage belonging to the current period's
 * settlement; `remainder < 0` is over-billed usage that must be
 * repriced into a credit adjustment. A negative `actualTotalUsage`
 * (dial regression, e.g. meter swap or fraud) is left to the caller —
 * the math stays honest and reports it as-is.
 */
export function buildReconciliation(
  input: BuildReconciliationInput,
): ReconciliationAmounts {
  const actualTotalUsage = input.actualValue.minus(input.anchorValue);
  const previouslySettled = input.settledUsages.reduce(
    (acc, u) => acc.plus(u),
    new Decimal(0),
  );
  return {
    actualTotalUsage,
    previouslySettled,
    remainderUsage: actualTotalUsage.minus(previouslySettled),
  };
}

export type ReconcileAllocPolicy =
  | 'PROPORTIONAL_TO_SETTLED'
  | 'ALL_TO_CURRENT';

export interface AllocateUsageInput {
  /** Per-period settled usage of the span, chronological order. */
  settledUsages: Decimal[];
  /** The true cumulative usage to distribute over the span. */
  totalUsage: Decimal;
  /** Tenant param `reconcile_alloc_policy`. */
  policy: ReconcileAllocPolicy;
}

/**
 * Distribute `totalUsage` across the span (spec §2.4 reprice input).
 *
 * - PROPORTIONAL_TO_SETTLED — `allocated_i = total × s_i/S` (S = Σs_i):
 *   each period keeps its estimated share's proportion of the truth.
 *   `S = 0` (every estimate was zero — nothing to proportion against)
 *   sends the whole total to the LAST period, the only defensible
 *   landing spot.
 * - ALL_TO_CURRENT — every period keeps its settled usage; the last
 *   period absorbs the entire delta (`s_last + (total − S)`).
 *
 * Shares are rounded to 4dp (the numeric(18,4) storage quantum of
 * bill_item.qty) so a persisted quantity never carries hidden residue;
 * the rounding residue ALWAYS lands on the LAST period
 * (`last = total − Σ previous`), which makes `Σ allocated = total`
 * exact for every policy — including negative totals.
 */
export function allocateUsage(input: AllocateUsageInput): Decimal[] {
  const { settledUsages, totalUsage, policy } = input;
  const n = settledUsages.length;
  if (n === 0) return [];
  const last = n - 1;
  const S = settledUsages.reduce((acc, u) => acc.plus(u), new Decimal(0));

  const out = new Array<Decimal>(n);
  if (policy === 'ALL_TO_CURRENT') {
    for (let i = 0; i < last; i++) out[i] = settledUsages[i];
  } else if (S.isZero()) {
    // PROPORTIONAL with nothing to proportion against — whole total
    // lands on the last period (the loop below then no-ops).
    for (let i = 0; i < last; i++) out[i] = new Decimal(0);
  } else {
    for (let i = 0; i < last; i++) {
      out[i] = totalUsage
        .times(settledUsages[i])
        .div(S)
        .toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    }
  }
  // Residue — rounding noise under PROPORTIONAL, the whole delta under
  // ALL_TO_CURRENT — always belongs to the last period.
  out[last] = totalUsage.minus(
    out.slice(0, last).reduce((acc, u) => acc.plus(u), new Decimal(0)),
  );
  return out;
}

export interface RepricePeriod {
  /** char(6) YYYYMM — used for the natural-year tier reset. */
  period: string;
  allocatedUsage: Decimal;
  feeItems: FeeItemInput[];
  /** Settlement snapshot for this period — history must use the
   *  declaration effective THEN, never the account's current value. */
  householdSize?: number | null;
}

export interface RepriceBreakdownRow {
  period: string;
  usageQty: Decimal;
  amountCent: bigint;
}

export interface RepriceResult {
  correctChargeCent: bigint;
  breakdown: RepriceBreakdownRow[];
}

/**
 * Rebill the span with corrected quantities (spec §2.4 重计价): each
 * period runs through computeBill at ITS OWN tariff version's fee items
 * while the cumulative-annual ladder cursor walks chronologically —
 * `baseYtd` (billed usage in earlier same-year periods before the span)
 * seeds the first period, allocated usage accumulates while the calendar
 * year holds, and the cursor RESETS to 0 at a year boundary
 * (自然年阶梯归零).
 *
 * `correctChargeCent` is what the span SHOULD have billed; the caller
 * nets it against the actually-posted charge to size the adjustment.
 * Engine DomainErrors (e.g. NEGATIVE_QTY under an ALLOW_NEGATIVE tenant
 * policy) propagate — the service decides whether they mean 400 or
 * MANUAL_REVIEW.
 */
export function reprice(input: {
  periods: RepricePeriod[];
  baseYtd: Decimal;
}): RepriceResult {
  let ytd = input.baseYtd;
  let year: string | null = null;
  let correctChargeCent = 0n;
  const breakdown: RepriceBreakdownRow[] = [];

  for (const p of input.periods) {
    const y = p.period.slice(0, 4);
    if (year === null) {
      year = y; // first span period: cursor = pre-span billed usage
    } else if (y !== year) {
      year = y;
      ytd = new Decimal(0); // natural-year tier reset
    }
    const result = computeBill({
      usageQty: p.allocatedUsage,
      ytdBeforeQty: ytd,
      householdSize: p.householdSize,
      feeItems: p.feeItems,
    });
    breakdown.push({
      period: p.period,
      usageQty: p.allocatedUsage,
      amountCent: result.totalAmountCent,
    });
    correctChargeCent += result.totalAmountCent;
    ytd = ytd.plus(p.allocatedUsage);
  }
  return { correctChargeCent, breakdown };
}
