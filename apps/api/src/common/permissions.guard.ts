import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  ANY_PERMISSIONS_KEY,
  PERMISSIONS_KEY,
} from './permissions.decorator.js';

/**
 * Checks @Permissions(...) metadata against the JWT's `perms` claim.
 * Runs after JwtAuthGuard, so `req.user` is always populated on protected
 * routes. Endpoints without @Permissions only need a valid token.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    const alternatives = this.reflector.getAllAndOverride<string[]>(
      ANY_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    const req = context.switchToHttp().getRequest<Request>();
    const perms = req.user?.perms ?? [];
    if (perms.includes('*')) return true;
    const hasRequired = (required ?? []).every((code) => perms.includes(code));
    const hasAlternative =
      alternatives === undefined ||
      alternatives.some((code) => perms.includes(code));
    if (hasRequired && hasAlternative) return true;

    throw new ForbiddenException({
      code: 'PERMISSION_DENIED',
      required,
      alternatives,
    });
  }
}
