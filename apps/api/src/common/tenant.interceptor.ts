import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable, defer } from 'rxjs';
import { withTenant } from './tenant-context.js';

/**
 * Establishes the per-request tenant ALS context from the verified JWT.
 * Runs after JwtAuthGuard (global guard order), so `req.user` is set on every
 * non-@Public route. An `X-Tenant-Id` header that disagrees with the token is
 * rejected — the token's tenant always wins.
 *
 * `defer` delays `als.run` until subscription time so the route handler and
 * everything downstream (services, runAsTenant) execute inside the context.
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const user = req.user;
    if (!user) {
      // @Public() route (login/refresh) — no tenant context.
      return next.handle();
    }

    const rawHeader = req.headers['x-tenant-id'];
    const headerTenant = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    if (headerTenant && headerTenant !== user.tenantId) {
      throw new ForbiddenException({
        code: 'TENANT_MISMATCH',
        message: 'X-Tenant-Id does not match the token tenant',
      });
    }

    const ctx = {
      tenantId: user.tenantId,
      staffId: user.sub,
      scope: user.scope ?? 'SELF',
      orgScope: user.orgScope ?? [],
    };
    return defer(() => withTenant(ctx, () => next.handle()));
  }
}
