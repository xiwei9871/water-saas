import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/** True for Prisma unique-constraint violations (P2002). */
export const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/** Wrap a Prisma write: business unique-key collisions → 409, not a bare 500. */
export const conflictOnUnique = <T>(p: Promise<T>): Promise<T> =>
  p.catch((e) => {
    if (isUniqueViolation(e)) {
      throw new ConflictException({ code: 'UNIQUE_CONSTRAINT_VIOLATION' });
    }
    throw e;
  });
