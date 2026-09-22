import * as XLSX from 'xlsx';
import {
  buildCanonicalPayload,
  canonicalDecimal,
  fingerprintEventKey,
  isBusinessPeriod,
  type CanonicalRemoteEvent,
} from './canonical.js';
import { naiveLocalToUtc } from './timezone.js';

/**
 * FileImportAdapter (E5 T8, design §22–§28) — vendor CSV/XLSX export →
 * CanonicalRemoteEvent[]. Column mapping is source-config driven (never
 * hard-coded vendor headers):
 *
 *   source.config = {
 *     "deviceKeyColumn": "表号",
 *     "readingColumn": "当前读数",
 *     "collectedAtColumn": "采集时间",
 *     "eventIdColumn": "流水号",       // optional → fingerprint fallback
 *     "qualityColumn": "状态",         // optional
 *     "periodColumn": "账期"           // optional → must equal targetPeriod
 *   }
 *
 * Semantics (frozen):
 *  - upload carries targetPeriod; a file-declared period column must match
 *  - naive collectedAt is interpreted in the source's timezone → UTC
 *  - decimal parsing stays string→Decimal, never Number()
 *  - per-row validity: bad rows are reported, never abort the file
 */
export interface FileColumnConfig {
  deviceKeyColumn: string;
  readingColumn: string;
  collectedAtColumn: string;
  eventIdColumn?: string;
  qualityColumn?: string;
  periodColumn?: string;
}

export interface InvalidRow {
  /** 1-based file row (header = row 1). */
  row: number;
  code: string;
  error: string;
}

export interface ParseResult {
  events: CanonicalRemoteEvent[];
  invalid: InvalidRow[];
  /** File-level sha256 — report/audit only, NOT the idempotency key. */
  fileSha256: string;
}

const REQUIRED_COLUMNS: (keyof FileColumnConfig)[] = [
  'deviceKeyColumn',
  'readingColumn',
  'collectedAtColumn',
];

export const columnConfigOf = (config: unknown): FileColumnConfig | null => {
  if (!config || typeof config !== 'object') return null;
  const c = config as Record<string, unknown>;
  for (const k of REQUIRED_COLUMNS) {
    if (typeof c[k] !== 'string' || !(c[k] as string).trim()) return null;
  }
  const out: FileColumnConfig = {
    deviceKeyColumn: (c.deviceKeyColumn as string).trim(),
    readingColumn: (c.readingColumn as string).trim(),
    collectedAtColumn: (c.collectedAtColumn as string).trim(),
  };
  for (const k of ['eventIdColumn', 'qualityColumn', 'periodColumn'] as const) {
    if (typeof c[k] === 'string' && (c[k] as string).trim()) {
      out[k] = (c[k] as string).trim();
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// CSV — minimal RFC-4180: quoted cells, embedded commas/quotes/newlines.
// ---------------------------------------------------------------------------

const parseCsvCells = (text: string): { row: number; cells: string[] }[] => {
  const rows: { row: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  let lineNo = 1;
  let rowStarted = false;
  const pushRow = () => {
    cells.push(cell);
    cell = '';
    if (cells.some((c) => c.trim() !== '')) rows.push({ row: lineNo, cells });
    cells = [];
    rowStarted = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      rowStarted = true;
      continue;
    }
    if (ch === ',') {
      cells.push(cell);
      cell = '';
      rowStarted = true;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      if (rowStarted || cell !== '') pushRow();
      lineNo++;
      continue;
    }
    cell += ch;
    rowStarted = true;
  }
  if (rowStarted || cell !== '') pushRow();
  return rows;
};

/** First sheet of an XLSX buffer → same {row,cells} shape (header = row 1). */
const parseXlsxCells = (buf: Buffer): { row: number; cells: string[] }[] => {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: '' });
  return grid
    .map((cells, i) => ({ row: i + 1, cells: cells.map((c) => String(c).trim()) }))
    .filter((r) => r.cells.some((c) => c !== ''));
};

// ---------------------------------------------------------------------------
// adapter
// ---------------------------------------------------------------------------

const parseInstant = (raw: string, timezone: string): Date | null => {
  const v = raw.trim();
  if (!v) return null;
  // Absolute timestamps (offset present) parse directly; naive local times
  // resolve through the source timezone (design §11/§23).
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return naiveLocalToUtc(v, timezone);
};

/**
 * Parse a vendor file into canonical events + per-row invalids.
 * `format` 'csv' | 'xlsx'; `content` is utf-8 text for CSV, base64 for XLSX.
 */
export const parseVendorFile = (args: {
  format: 'csv' | 'xlsx';
  content: string;
  targetPeriod: string;
  timezone: string;
  columns: FileColumnConfig;
  fileSha256: string;
}): ParseResult => {
  const { format, content, targetPeriod, timezone, columns, fileSha256 } = args;
  const grid =
    format === 'csv'
      ? parseCsvCells(content)
      : parseXlsxCells(Buffer.from(content, 'base64'));
  const events: CanonicalRemoteEvent[] = [];
  const invalid: InvalidRow[] = [];
  if (grid.length === 0) return { events, invalid, fileSha256 };

  const header = grid[0].cells;
  const col = (name: string | undefined): number =>
    name === undefined ? -1 : header.findIndex((h) => h.trim() === name);
  const idx = {
    device: col(columns.deviceKeyColumn),
    reading: col(columns.readingColumn),
    collectedAt: col(columns.collectedAtColumn),
    eventId: col(columns.eventIdColumn),
    quality: col(columns.qualityColumn),
    period: col(columns.periodColumn),
  };
  for (const [name, i] of [
    ['deviceKeyColumn', idx.device],
    ['readingColumn', idx.reading],
    ['collectedAtColumn', idx.collectedAt],
  ] as const) {
    if (i < 0) {
      invalid.push({ row: 1, code: 'COLUMN_NOT_FOUND', error: `${name} "${name === 'deviceKeyColumn' ? columns.deviceKeyColumn : name === 'readingColumn' ? columns.readingColumn : columns.collectedAtColumn}" not in header` });
    }
  }
  if (invalid.length > 0) return { events, invalid, fileSha256 };

  for (const r of grid.slice(1)) {
    const get = (i: number) => (i >= 0 ? (r.cells[i] ?? '').trim() : '');
    const rawPayload: Record<string, unknown> = { _row: r.row };
    header.forEach((h, i) => {
      rawPayload[h || `col${i}`] = r.cells[i] ?? '';
    });
    const fail = (code: string, error: string) =>
      invalid.push({ row: r.row, code, error });

    const vendorDeviceKey = get(idx.device);
    if (!vendorDeviceKey) {
      fail('MISSING_DEVICE_KEY', 'device key cell empty');
      continue;
    }
    if (idx.period >= 0) {
      const filePeriod = get(idx.period);
      if (filePeriod && filePeriod !== targetPeriod) {
        fail('PERIOD_MISMATCH', `file period ${filePeriod} != target ${targetPeriod}`);
        continue;
      }
    }
    const collectedAt = parseInstant(get(idx.collectedAt), timezone);
    if (!collectedAt) {
      fail('INVALID_COLLECTED_AT', `unparseable timestamp "${get(idx.collectedAt)}"`);
      continue;
    }
    const readingValue = canonicalDecimal(get(idx.reading));
    if (readingValue === null) {
      fail('INVALID_READING_VALUE', `unparseable reading "${get(idx.reading)}"`);
      continue;
    }
    const vendorQuality = idx.quality >= 0 ? get(idx.quality) : null;
    const externalEventKey =
      (idx.eventId >= 0 && get(idx.eventId)) ||
      fingerprintEventKey({ vendorDeviceKey, businessPeriod: targetPeriod, collectedAt, readingValue });
    const { canonicalPayload, payloadHash } = buildCanonicalPayload({
      vendorDeviceKey,
      businessPeriod: targetPeriod,
      collectedAt,
      readingValue,
      vendorQuality,
    });
    events.push({
      externalEventKey,
      vendorDeviceKey,
      businessPeriod: targetPeriod,
      collectedAt,
      readingValue,
      vendorQuality,
      rawPayload,
      canonicalPayload,
      payloadHash,
    });
  }
  return { events, invalid, fileSha256 };
};

export { isBusinessPeriod };
