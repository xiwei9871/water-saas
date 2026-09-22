import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';

/**
 * CanonicalRemoteEvent (E5 domain design §7/§23) — the single contract every
 * RemoteAdapter emits. The ingest pipeline only ever sees this shape:
 * adapter-specific parsing (CSV row, vendor JSON, webhook body) happens
 * upstream; settlement/bill facts are unreachable from here.
 */
export interface CanonicalRemoteEvent {
  /** Vendor's event key; `fp:<sha256>` fallback when the vendor sends none. */
  externalEventKey: string;
  /** Vendor device identity as received — never assumed equal to meter_no. */
  vendorDeviceKey: string;
  /** Business billing period YYYYMM produced by the adapter. */
  businessPeriod: string;
  /** Absolute UTC instant of the meter read. */
  collectedAt: Date;
  /** Canonical decimal string ("1234.5000"). */
  readingValue: string;
  vendorQuality?: string | null;
  /** The vendor row/body as received — stored verbatim (immutable). */
  rawPayload: Record<string, unknown>;
  /** Normalized projection of the fields above — hash basis. */
  canonicalPayload: Record<string, unknown>;
  /** sha256 hex of stable-stringified canonicalPayload. */
  payloadHash: string;
}

/** Deterministic JSON.stringify (sorted keys) — the canonical hash basis. */
export const stableStringify = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
};

export const sha256Hex = (s: string): string =>
  createHash('sha256').update(s).digest('hex');

/**
 * Validate + normalize a decimal reading value. Vendor exports carry
 * strings/numbers; canonical form is a plain decimal string (no exponent,
 * trimmed). Throws on non-numeric input — the caller marks the row invalid.
 */
export const canonicalDecimal = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  try {
    return new Prisma.Decimal(s).toString();
  } catch {
    return null;
  }
};

const PERIOD_RE = /^\d{6}$/;
export const isBusinessPeriod = (v: unknown): v is string =>
  typeof v === 'string' && PERIOD_RE.test(v);

/**
 * Fingerprint key for events the vendor sends without an id — a stable
 * identity over the business fields so a re-import of the same fact replays
 * idempotently instead of minting a second event.
 */
export const fingerprintEventKey = (parts: {
  vendorDeviceKey: string;
  businessPeriod: string;
  collectedAt: Date;
  readingValue: string;
}): string =>
  `fp:${sha256Hex(
    stableStringify({
      vendorDeviceKey: parts.vendorDeviceKey,
      businessPeriod: parts.businessPeriod,
      collectedAt: parts.collectedAt.toISOString(),
      readingValue: parts.readingValue,
    }),
  )}`;

/** Build the canonical payload + its hash from normalized fields. */
export const buildCanonicalPayload = (e: {
  vendorDeviceKey: string;
  businessPeriod: string;
  collectedAt: Date;
  readingValue: string;
  vendorQuality?: string | null;
}): { canonicalPayload: Record<string, unknown>; payloadHash: string } => {
  const canonicalPayload: Record<string, unknown> = {
    vendorDeviceKey: e.vendorDeviceKey,
    businessPeriod: e.businessPeriod,
    collectedAt: e.collectedAt.toISOString(),
    readingValue: e.readingValue,
  };
  if (e.vendorQuality !== undefined && e.vendorQuality !== null) {
    canonicalPayload.vendorQuality = e.vendorQuality;
  }
  return { canonicalPayload, payloadHash: sha256Hex(stableStringify(canonicalPayload)) };
};
