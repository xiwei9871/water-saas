import { Prisma } from '@prisma/client';

/**
 * JSON-safety convention for the whole API: Prisma returns BigInt (money/seq)
 * and Decimal (qty/unit_price) objects, both of which break or degrade under
 * plain JSON.stringify. Everything crossing the wire is normalized through
 * `toJsonSafe` — BigInt → string, Decimal → string, plain objects/arrays are
 * recursed, Dates/Buffers/other objects pass through untouched.
 */
export function toJsonSafe<T>(value: T): T {
  if (typeof value === 'bigint') {
    return value.toString() as T;
  }
  if (value instanceof Prisma.Decimal) {
    return value.toString() as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => toJsonSafe(v)) as T;
  }
  if (value !== null && typeof value === 'object') {
    if (value instanceof Date || value instanceof Buffer) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = toJsonSafe(v);
    }
    return out as T;
  }
  return value;
}
