/**
 * Reading-book cadence (抄表周期) — the SINGLE implementation of the
 * "is this book due in this period" rule. UI must surface the result,
 * never re-derive it.
 *
 * 20261023 B1：周期精确为四种——每月 / 单月（奇数月）/ 双月（偶数月）/
 * 季度（anchorPeriod 定首抄月，之后每 3 个月一期）。
 * 单月册首个年段跨年：1 月抄表覆盖上年 12 月—1 月；其余分段均为
 * 「上期读数月+1 … 本期读数月」的连续区间，年累计量即首尾表底相减。
 */

export type BookCadence = 'MONTHLY' | 'ODD_MONTH' | 'EVEN_MONTH' | 'QUARTERLY';
export type MeterChannel = 'MECHANICAL' | 'REMOTE_MANUAL' | 'REMOTE_AUTO';

export const BOOK_CADENCES: readonly BookCadence[] = [
  'MONTHLY',
  'ODD_MONTH',
  'EVEN_MONTH',
  'QUARTERLY',
];
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

/** 该册在 `period` 是否到期应抄。
 *  MONTHLY 恒到期；ODD_MONTH 奇数月；EVEN_MONTH 偶数月；
 *  QUARTERLY 自 anchorPeriod 起每 3 个月一期（双向延伸，
 *  anchor 之前相差 3 的倍数月的追补期同样到期）。 */
export const isBookDue = (
  cadence: BookCadence,
  anchorPeriod: string | null | undefined,
  period: string,
): boolean => {
  if (cadence === 'MONTHLY') return true;
  if (!isValidPeriod(period)) return true;
  const month = parseInt(period.slice(4), 10);
  if (cadence === 'ODD_MONTH') return month % 2 === 1;
  if (cadence === 'EVEN_MONTH') return month % 2 === 0;
  // QUARTERLY：无锚点无法判定——DB CHECK 保证有锚；兜底视为到期，
  // 历史坏行也不能静默停止生成。
  if (!anchorPeriod || !isValidPeriod(anchorPeriod)) return true;
  return (monthIndex(period) - monthIndex(anchorPeriod)) % 3 === 0;
};
