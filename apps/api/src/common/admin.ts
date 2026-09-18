import { ForbiddenException } from '@nestjs/common';
import type { JwtUser } from './auth.guard.js';

/**
 * Admin-only gate: role management and role binding are grant surfaces — a
 * non-admin iam:write user must not mint wider scope/permissions than they
 * hold, nor bind roles (self-assign → re-login → tenant takeover). Only '*'
 * perms (the admin role wildcard) pass.
 *
 * Delegated orgScope writes (staff profile edits inside your subtree) are
 * unaffected — this is for grant surfaces, not everyday writes.
 */
export const assertAdmin = (user?: JwtUser): void => {
  if (!(user?.perms ?? []).includes('*')) {
    throw new ForbiddenException({ code: 'ADMIN_REQUIRED' });
  }
};
