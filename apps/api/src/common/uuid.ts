import { BadRequestException } from '@nestjs/common';

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Cheap uuid shape check — Prisma throws P2023 (a 500) on a malformed uuid
 * filter value, so ids coming off the wire get a clean 400 instead.
 */
export const isUuid = (v: unknown): v is string =>
  typeof v === 'string' && UUID_RE.test(v);

export const assertUuid = (v: unknown, field = 'id'): string => {
  if (!isUuid(v)) {
    throw new BadRequestException({ code: 'INVALID_ID_FORMAT', field });
  }
  return v;
};
