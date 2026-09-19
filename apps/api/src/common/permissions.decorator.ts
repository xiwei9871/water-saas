import { SetMetadata } from '@nestjs/common';

/**
 * Permission codes follow `module:action` (e.g. 'customer:write',
 * 'iam:read'). PermissionsGuard requires ALL listed codes in the JWT's
 * `perms` array; the wildcard '*' (granted to the admin role) allows anything.
 */
export const PERMISSIONS_KEY = 'requiredPermissions';
export const Permissions = (...codes: string[]) => SetMetadata(PERMISSIONS_KEY, codes);
