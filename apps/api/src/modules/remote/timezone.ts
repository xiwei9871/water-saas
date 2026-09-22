/**
 * IANA timezone helpers (E5): vendor exports carry naive local timestamps
 * ("2026-09-21 08:00:00"); RemoteSource.timezone gives them meaning. All
 * persisted instants are absolute UTC (timestamptz); read_date is the
 * calendar date the reading occurred on in the source's local wall clock.
 */

const TZ_FMT = (tz: string) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

/** Wall-clock parts of `d` as seen in `tz`. */
const partsInZone = (d: Date, tz: string) => {
  const map: Record<string, number> = {};
  for (const p of TZ_FMT(tz).formatToParts(d)) {
    if (p.type !== 'literal') map[p.type] = parseInt(p.value, 10);
  }
  return map as { year: number; month: number; day: number; hour: number; minute: number; second: number };
};

/**
 * Interpret a naive local timestamp in `tz` as an absolute UTC instant.
 * Two passes handle zones whose offset differs across the guessed instant
 * (DST edges); single-pass is exact for fixed-offset zones like Asia/Shanghai.
 * Returns null for unparseable input.
 */
export const naiveLocalToUtc = (naive: string, tz: string): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(naive.trim());
  if (!m) return null;
  const guessUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
  let utc = guessUtc;
  for (let i = 0; i < 2; i++) {
    const wall = partsInZone(new Date(utc), tz);
    const wallUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
    const next = utc + (guessUtc - wallUtc);
    if (next === utc) break;
    utc = next;
  }
  return new Date(utc);
};

/** The source-local calendar date (YYYY-MM-DD) an instant falls on → UTC midnight Date for read_date. */
export const localDateOf = (d: Date, tz: string): Date => {
  const w = partsInZone(d, tz);
  return new Date(Date.UTC(w.year, w.month - 1, w.day));
};
