import type { DataScope, OrgType, PermType, StaffStatus } from '@ws/types';

/** Re-exported shared enums so pages can import everything from here. */
export type { DataScope, OrgType, PermType, StaffStatus } from '@ws/types';

/**
 * Wire shapes returned by the API (apps/api). Dates serialize as ISO
 * strings; Decimal/BigInt columns serialize as strings. Keep in sync with
 * the iam controllers — spec §4.
 */

export interface RoleSummary {
  code: string;
  name: string;
  dataScope: DataScope;
}

/** POST /auth/login */
export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  staff: { id: string; login: string; name: string; orgUnitId: string };
  roles: RoleSummary[];
  perms: string[];
}

/** POST /auth/refresh */
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

/** GET /auth/me — the session user's fresh identity view. */
export interface SessionUser {
  id: string;
  login: string;
  name: string;
  status: StaffStatus;
  orgUnitId: string;
  tenantId: string;
  roles: RoleSummary[];
  perms: string[];
  scope: DataScope;
  orgScope: string[];
}

export interface OrgUnit {
  id: string;
  tenantId: string;
  parentId: string | null;
  name: string;
  type: OrgType;
  createdAt: string;
  updatedAt: string;
}

export interface Staff {
  id: string;
  tenantId: string;
  orgUnitId: string;
  login: string;
  name: string;
  status: StaffStatus;
  createdAt: string;
  updatedAt: string;
}

/** GET /iam/roles — rows carry their bound permission CODES in `perms`. */
export interface Role {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  dataScope: DataScope;
  perms: string[];
  createdAt: string;
  updatedAt: string;
}

/** GET /iam/roles/permissions/list — the tenant's permission dictionary. */
export interface Permission {
  id: string;
  tenantId: string;
  code: string;
  type: PermType;
  createdAt: string;
  updatedAt: string;
}

/** GET /iam/tenant-params — PK is (tenantId, key); value is arbitrary JSON. */
export interface TenantParam {
  tenantId: string;
  key: string;
  value: unknown;
  createdAt: string;
  updatedAt: string;
}

/** GET /iam/audit-logs — append-only operation log (before/after omitted). */
export interface AuditLog {
  id: string;
  staffId: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  ip: string | null;
  createdAt: string;
}
