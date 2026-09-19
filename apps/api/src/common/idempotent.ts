import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { IdempotencyService } from './idempotency.service.js';
import type { TenantCtx } from './tenant-context.js';
import { TenantPrismaService } from './tenant-prisma.js';

/**
 * Write-endpoint helper (pattern: staff.controller create): when the caller
 * sent an `Idempotency-Key` header, the business write runs inside
 * IdempotencyService.runWithKey (key row + write + COMPLETED mark commit in
 * ONE transaction); without a key it's a plain runAsTenant write.
 *
 * `route` is part of the stored key scope — pass the concrete request path
 * (`req.path`) so a key can't be replayed against a different target.
 */
export const withOptionalIdem = async <T>(
  prisma: TenantPrismaService,
  idem: IdempotencyService,
  ctx: TenantCtx,
  meta: {
    key?: string;
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
    route: string;
    body: unknown;
    responseStatus?: number;
  },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> => {
  if (!meta.key) {
    return prisma.runAsTenant(ctx.tenantId, fn);
  }
  const requestHash = createHash('sha256')
    .update(JSON.stringify(meta.body))
    .digest('hex');
  const result = await idem.runWithKey(
    ctx.tenantId,
    {
      key: meta.key,
      method: meta.method,
      route: meta.route,
      requestHash,
      responseStatus: meta.responseStatus ?? 200,
    },
    fn,
  );
  return result.body;
};
