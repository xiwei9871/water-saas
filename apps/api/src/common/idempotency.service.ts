import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { toJsonSafe } from './json-safe.js';
import { TenantPrismaService } from './tenant-prisma.js';

export interface IdemMeta {
  /** Client-supplied Idempotency-Key header. */
  key: string;
  method: string;
  route: string;
  /** sha256 hex of JSON.stringify(request body). */
  requestHash: string;
  /** HTTP status the original response carried (default 200). */
  responseStatus?: number;
}

export interface IdemResult<T> {
  /** true = stored response replayed, fn did NOT run again. */
  replayed: boolean;
  status: number;
  body: T;
}

/** Sentinel: the PROCESSING insert hit a concurrent/finished key holder. */
class IdemKeyRace extends Error {}

const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/**
 * Idempotency contract (spec: POST-with-key must not double-apply):
 *
 *  1. Inside ONE runAsTenant transaction: INSERT idempotency_key
 *     (status=PROCESSING) → run fn (business write) → UPDATE the same row to
 *     COMPLETED with response_ref + response_status.
 *  2. Same key + different request_hash → 409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST.
 *  3. Same key + same hash + COMPLETED → return the stored response_ref
 *     verbatim (the client gets the original response, business never re-runs).
 *  4. Same key still PROCESSING → 409 IDEMPOTENCY_IN_PROGRESS (concurrent retry).
 *  5. If fn throws, the whole tx rolls back — the key row disappears and the
 *     client may safely retry. No "business landed, key missing" window.
 *
 * Implementation note: a unique-violation aborts the interactive transaction,
 * so the conflict can't be inspected on the aborted tx — a sentinel error
 * (IdemKeyRace) triggers a second lookup in a fresh transaction.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: TenantPrismaService) {}

  async runWithKey<T>(
    tenantId: string,
    meta: IdemMeta,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<IdemResult<T>> {
    try {
      return await this.attempt(tenantId, meta, fn);
    } catch (err) {
      if (err instanceof IdemKeyRace) {
        // The aborted tx is gone; inspect the committed key row in a new tx.
        return this.prisma.runAsTenant(tenantId, async (tx) =>
          this.replayOrConflict<T>(tx, tenantId, meta),
        );
      }
      throw err;
    }
  }

  private async replayOrConflict<T>(
    tx: Prisma.TransactionClient,
    tenantId: string,
    meta: IdemMeta,
  ): Promise<IdemResult<T>> {
    const { key, requestHash } = meta;
    const existing = await tx.idempotencyKey.findUnique({
      where: { tenantId_key: { tenantId, key } },
    });
    if (existing && existing.requestHash !== requestHash) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
      });
    }
    if (existing && existing.status === 'COMPLETED') {
      return {
        replayed: true,
        status: existing.responseStatus ?? 200,
        body: (existing.responseRef ? JSON.parse(existing.responseRef) : null) as T,
      };
    }
    // Row absent (rare) or still PROCESSING — a concurrent request holds it.
    throw new ConflictException({ code: 'IDEMPOTENCY_IN_PROGRESS' });
  }

  private async attempt<T>(
    tenantId: string,
    meta: IdemMeta,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<IdemResult<T>> {
    const { key, method, route, requestHash, responseStatus = 200 } = meta;
    return this.prisma.runAsTenant(tenantId, async (tx) => {
      const existing = await tx.idempotencyKey.findUnique({
        where: { tenantId_key: { tenantId, key } },
      });
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
          });
        }
        if (existing.status === 'COMPLETED') {
          return {
            replayed: true,
            status: existing.responseStatus ?? 200,
            body: (existing.responseRef ? JSON.parse(existing.responseRef) : null) as T,
          };
        }
        throw new ConflictException({ code: 'IDEMPOTENCY_IN_PROGRESS' });
      }

      try {
        await tx.idempotencyKey.create({
          data: { tenantId, key, method, route, requestHash, status: 'PROCESSING' },
        });
      } catch (err) {
        // A concurrent request inserted the same key after our findUnique.
        if (isUniqueViolation(err)) throw new IdemKeyRace();
        throw err;
      }

      const body = await fn(tx);

      await tx.idempotencyKey.update({
        where: { tenantId_key: { tenantId, key } },
        data: {
          status: 'COMPLETED',
          responseRef: JSON.stringify(toJsonSafe(body)),
          responseStatus,
        },
      });
      return { replayed: false, status: responseStatus, body };
    });
  }
}
