import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from './public.decorator.js';

/** JWT access-token payload signed at login. */
export interface JwtUser {
  /** staff id */
  sub: string;
  tenantId: string;
  /** widest role data_scope — distinguishes ALL from a subtree covering everything */
  scope: 'ALL' | 'ORG_SUBTREE' | 'SELF';
  /** org_unit ids the staff may see (ALL scope = every org id in the tenant) */
  orgScope: string[];
  /** permission codes; '*' = admin, allow everything */
  perms: string[];
  type: 'access';
}

declare module 'express' {
  interface Request {
    user?: JwtUser;
    /**
     * Pre-mutation row snapshot set by controllers that already loaded the
     * existing entity — AuditInterceptor writes it to audit_log.before.
     */
    auditBefore?: unknown;
  }
}

/**
 * Global auth guard: verifies `Authorization: Bearer <jwt>` and attaches
 * `req.user` (JwtUser). Routes marked @Public() are skipped.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) {
      throw new UnauthorizedException({ code: 'AUTH_TOKEN_MISSING' });
    }
    try {
      const payload = await this.jwt.verifyAsync<JwtUser>(token);
      if (payload.type !== 'access') {
        throw new Error('not an access token');
      }
      req.user = payload;
      return true;
    } catch {
      throw new UnauthorizedException({ code: 'AUTH_TOKEN_INVALID' });
    }
  }
}
