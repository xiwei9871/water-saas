/**
 * Reading-book cadence (抄表周期) — the SINGLE implementation of the
 * "is this book due in this period" rule. UI must surface the result,
 * never re-derive it.
 *
 * Absolute month-index math keeps BIMONTHLY correct across year
 * boundaries: 202612 → 202702 is one interval step, not an odd/even
 * comparison of month numbers.
 */

export type BookCadence = 'MONTHLY' | 'BIMONTHLY';
export type MeterChannel = 'MECHANICAL' | 'REMOTE_MANUAL' | 'REMOTE_AUTO';

export const BOOK_CADENCES: readonly BookCadence[] = ['MONTHLY', 'BIMONTHLY'];
export const METER_CHANNELS: readonly MeterChannel[] = [
  'MECHANICAL',
  'REMOTE_MANUAL',
  'REMOTE_AUTO',
];

const PERIOD_RE = /^\d{4}(0[1-9]|1[0-2])$/;

export const isValidPeriod = (p: string): boolean => PERIOD_RE.test(p);

/** char(6) YYYYMM → absolute month index (year * 12 + month). */
export const monthIndex = (period: string): number =>
  parseInt(period.slice(0, 4), 10) * 12 + parseInt(period.slice(4), 10);

/**
 * Whether a book is due to be read in `period`. MONTHLY is always due.
 * BIMONTHLY is due every second month counting from `anchorPeriod`
 * (inclusive both directions — a period BEFORE the anchor that differs by
 * an even number of months is also "due", e.g. a late catch-up).
 */
export const isBookDue = (
  cadence: BookCadence,
  anchorPeriod: string | null | undefined,
  period: string,
): boolean => {
  if (cadence === 'MONTHLY') return true;
  if (!anchorPeriod || !isValidPeriod(anchorPeriod) || !isValidPeriod(period)) {
    // A BIMONTHLY book without a usable anchor cannot answer "due?" —
    // the DB CHECK prevents this state; treat it as due so a legacy row
    // can never silently stop generating.
    return true;
  }
  return (monthIndex(period) - monthIndex(anchorPeriod)) % 2 === 0;
};
