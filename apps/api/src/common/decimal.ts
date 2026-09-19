import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Parse a client-supplied decimal (string | number) into Prisma.Decimal.
 * Water quantities are numeric(18,4) — a malformed/negative value would
 * either crash Prisma (500) or silently store nonsense, so the wire value
 * gets a clean 400 instead.
 */
export const assertDecimal = (
  v: unknown,
  field: string,
  opts: { min?: number } = {},
): Prisma.Decimal => {
  if (typeof v !== 'string' && typeof v !== 'number') {
    throw new BadRequestException({ code: 'INVALID_DECIMAL', field });
  }
  let d: Prisma.Decimal;
  try {
    d = new Prisma.Decimal(v);
  } catch {
    throw new BadRequestException({ code: 'INVALID_DECIMAL', field });
  }
  if (!d.isFinite() || (opts.min !== undefined && d.lessThan(opts.min))) {
    throw new BadRequestException({ code: 'INVALID_DECIMAL', field });
  }
  return d;
};

/** Parse an optional ISO-8601 date/datetime; malformed non-empty value → 400. */
export const assertOptionalDate = (v: unknown, field: string): Date | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' && !(v instanceof Date)) {
    throw new BadRequestException({ code: 'INVALID_DATE', field });
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException({ code: 'INVALID_DATE', field });
  }
  return d;
};
