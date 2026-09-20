import { SetMetadata } from '@nestjs/common';

/**
 * Permission codes follow `module:action` (e.g. 'customer:write',
 * 'iam:read'). PermissionsGuard requires ALL listed codes in the JWT's
 * `perms` array; the wildcard '*' (granted to the admin role) allows anything.
 */
export const PERMISSIONS_KEY = 'requiredPermissions';
export const Permissions = (...codes: string[]) =>
  SetMetadata(PERMISSIONS_KEY, codes);

/** Explicit alternatives; combined with Permissions, BOTH conditions apply. */
export const ANY_PERMISSIONS_KEY = 'anyPermissions';
export const AnyPermissions = (...codes: string[]) =>
  SetMetadata(ANY_PERMISSIONS_KEY, codes);
