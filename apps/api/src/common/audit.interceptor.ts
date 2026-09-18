import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { Observable, tap } from 'rxjs';
import { toJsonSafe } from './json-safe.js';
import { TenantPrismaService } from './tenant-prisma.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Fields that must never land in audit_log. */
const REDACTED_KEYS = new Set(['password', 'passwordHash']);

const stripSecrets = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACTED_KEYS.has(k) ? '[redacted]' : stripSecrets(v);
    }
    return out;
  }
  return value;
};

/** Resource noun from the route: '/iam/staff/:id/password' → 'staff'. */
const entityOf = (route: string): string => {
  const seg = route
    .split('/')
    .filter((s) => s && s !== 'iam' && !s.startsWith(':'))[0];
  return seg ?? route;
};

/**
 * Append-only audit trail: after a mutating request (POST/PUT/PATCH/DELETE)
 * succeeds, inserts one audit_log row with action=METHOD /route, entity=
 * resource noun, entity_id from the result or :id param, before=pre-mutation
 * snapshot (controllers stash the loaded row on `req.auditBefore`; endpoints
 * without a loaded row — creates — leave before NULL), after=mutated row
 * (the handler's return value, falling back to the request body when the
 * handler returns nothing meaningful like {ok:true}), and the client IP.
 * Best-effort — audit failures are logged, never thrown into the response.
 *
 * NOTE: ws_app has INSERT+SELECT only on audit_log (UPDATE/DELETE revoked).
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly prisma: TenantPrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const user = req.user;
    if (!user || !MUTATING_METHODS.has(req.method)) {
      return next.handle();
    }

    return next.handle().pipe(
      tap((result) => {
        const route = (req.route?.path as string | undefined) ?? req.path;
        const entity = entityOf(route);
        const resultId =
          result && typeof result === 'object'
            ? ((result as Record<string, unknown>).id as string | undefined)
            : undefined;
        const entityId = resultId ?? (req.params?.id as string | undefined) ?? null;

        // Prefer the mutated row over the raw request body for `after`.
        const meaningful =
          result !== undefined &&
          result !== null &&
          typeof result === 'object' &&
          (resultId !== undefined || Object.keys(result as object).length > 1);
        const before: Prisma.InputJsonValue | typeof Prisma.JsonNull =
          req.auditBefore == null
            ? Prisma.JsonNull
            : (toJsonSafe(stripSecrets(req.auditBefore)) as Prisma.InputJsonValue);
        const after = toJsonSafe(
          stripSecrets(meaningful ? result : { body: req.body, resultId }),
        ) as Prisma.InputJsonValue;

        this.prisma
          .runAsTenant(user.tenantId, (tx) =>
            tx.auditLog.create({
              data: {
                tenantId: user.tenantId,
                staffId: user.sub,
                action: `${req.method} ${route}`,
                entity,
                entityId,
                before,
                after,
                ip: req.ip ?? null,
                createdBy: user.sub,
                updatedBy: user.sub,
              },
            }),
          )
          .catch((err: unknown) => {
            // Append-only audit must never break the business response.
            console.error('audit_log write failed', err);
          });
      }),
    );
  }
}
