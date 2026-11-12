import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/** True for Prisma unique-constraint violations (P2002). */
export const isUniqueViolation = (err: unknown): boolean => {
  // 1111v6-R1：交互式事务内唯一冲突可能被包装在 cause 链中，逐层检查。
  let cur: unknown = err;
  while (cur) {
    if (cur instanceof Prisma.PrismaClientKnownRequestError && cur.code === 'P2002') {
      return true;
    }
    if (cur instanceof Error && /P2002/.test(cur.message)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
};

/** Wrap a Prisma write: business unique-key collisions → 409, not a bare 500. */
export const conflictOnUnique = <T>(p: Promise<T>): Promise<T> =>
  p.catch((e) => {
    if (isUniqueViolation(e)) {
      throw new ConflictException({ code: 'UNIQUE_CONSTRAINT_VIOLATION' });
    }
    throw e;
  });
