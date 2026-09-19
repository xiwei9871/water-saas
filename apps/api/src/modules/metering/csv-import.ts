/**
 * CSV line format for POST /meter-readings/import (one reading per line):
 *
 *   plan_item_id,result_type,reading_value,exception_code[,read_date]
 *
 * - plan_item_id  uuid of the reading_plan_item the reading lands on
 * - result_type   ACTUAL | REMOTE | NO_READ
 * - reading_value dial value — required for ACTUAL/REMOTE, EMPTY for NO_READ
 * - exception_code required for NO_READ (LOCKED | DIAL_DIRTY | FLOODED |
 *   OCCUPIED | STOPPED | BROKEN | SUSPECTED_THEFT | OTHER), empty otherwise
 * - read_date     optional ISO date; defaults to "now" when empty/absent
 *
 * An optional header line is auto-skipped (first cell literally
 * "plan_item_id", case-insensitive). Deliberately a plain split(',') with no
 * quoting support — every field is a uuid/enum/number, so commas inside
 * values can't occur; blank lines are ignored. Cell→field semantics and
 * per-row validation live in the controller; this only produces tokens.
 */
export interface CsvRow {
  /** 1-based line number in the submitted CSV text (for error reports). */
  row: number;
  cells: string[];
}

export const parseReadingCsv = (csv: string): CsvRow[] => {
  const rows: CsvRow[] = [];
  let headerChecked = false;
  csv.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const cells = line.split(',').map((c) => c.trim());
    if (!headerChecked) {
      headerChecked = true;
      if (cells[0].toLowerCase() === 'plan_item_id') return;
    }
    rows.push({ row: i + 1, cells });
  });
  return rows;
};
