import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
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

/**
 * Append-only audit trail: after a mutating request (POST/PUT/PATCH/DELETE)
 * succeeds, inserts one audit_log row with action=METHOD /route, entity=path
 * tail, entity_id from the result or path params, after=redacted request body
 * (plus result id), and the client IP. Best-effort — audit failures are
 * logged, never thrown into the response.
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
        const segments = route.split('/').filter((s) => s && !s.startsWith(':'));
        const entity = segments[segments.length - 1] ?? route;
        const resultId =
          result && typeof result === 'object'
            ? ((result as Record<string, unknown>).id as string | undefined)
            : undefined;
        const entityId = resultId ?? (req.params?.id as string | undefined) ?? null;

        this.prisma
          .runAsTenant(user.tenantId, (tx) =>
            tx.auditLog.create({
              data: {
                tenantId: user.tenantId,
                staffId: user.sub,
                action: `${req.method} ${route}`,
                entity,
                entityId,
                after: toJsonSafe(stripSecrets({ body: req.body, resultId }) as never),
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
