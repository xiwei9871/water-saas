import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import bcrypt from 'bcrypt';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import type { JwtUser } from '../../common/auth.guard.js';

const INVALID_CREDENTIALS = () =>
  new UnauthorizedException({ code: 'INVALID_CREDENTIALS' });

/**
 * Compared against when the login is unknown — keeps the response timing of
 * "user not found" indistinguishable from "wrong password".
 */
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer', 10);

interface TenantDirRow {
  id: string;
  code: string;
  name: string;
  status: string;
}

export interface LoginBody {
  tenantCode: string;
  login: string;
  password: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly jwt: JwtService,
  ) {}

  /**
   * Pre-auth tenant lookup. The `tenant` table is behind FORCE RLS, so the
   * login path goes through `tenant_directory` — a postgres-owned view that
   * bypasses RLS and exposes only id/code/name/status.
   */
  private async resolveTenant(code: string): Promise<TenantDirRow> {
    const rows = await this.prisma.raw.$queryRaw<TenantDirRow[]>`
      SELECT id::text AS id, code, name, status::text AS status
      FROM tenant_directory WHERE code = ${code} LIMIT 1`;
    const tenant = rows[0];
    if (!tenant) throw INVALID_CREDENTIALS();
    if (tenant.status !== 'ACTIVE') {
      throw new ForbiddenException({ code: 'TENANT_SUSPENDED' });
    }
    return tenant;
  }

  /** Widest scope wins when a staff holds multiple roles. */
  private widestScope(roles: { dataScope: string }[]): 'ALL' | 'ORG_SUBTREE' | 'SELF' {
    if (roles.some((r) => r.dataScope === 'ALL')) return 'ALL';
    if (roles.some((r) => r.dataScope === 'ORG_SUBTREE')) return 'ORG_SUBTREE';
    return 'SELF';
  }

  private async computeOrgScope(
    tx: Prisma.TransactionClient,
    tenantId: string,
    orgUnitId: string,
    scope: 'ALL' | 'ORG_SUBTREE' | 'SELF',
  ): Promise<string[]> {
    if (scope === 'SELF') return [orgUnitId];
    if (scope === 'ALL') {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM org_unit WHERE tenant_id = ${tenantId}::uuid`;
      return rows.map((r) => r.id);
    }
    // ORG_SUBTREE — staff's own org plus all descendants. UNION (dedupe)
    // instead of UNION ALL so a cycle in the org tree can never loop forever.
    const rows = await tx.$queryRaw<{ id: string }[]>`
      WITH RECURSIVE sub AS (
        SELECT id FROM org_unit WHERE tenant_id = ${tenantId}::uuid AND id = ${orgUnitId}::uuid
        UNION
        SELECT o.id FROM org_unit o
        JOIN sub s ON o.parent_id = s.id AND o.tenant_id = ${tenantId}::uuid
      )
      SELECT id::text AS id FROM sub`;
    return rows.map((r) => r.id);
  }

  /** staff + roles + perms + orgScope — the login payload's source of truth. */
  private async loadIdentity(tx: Prisma.TransactionClient, tenantId: string, staffId: string) {
    const staff = await tx.staff.findFirst({ where: { tenantId, id: staffId } });
    if (!staff) throw INVALID_CREDENTIALS();
    // NOTE (MVP accepted risk): disabling a staff blocks login/refresh/me but
    // access tokens already issued stay valid until expiry (≤15min). Phase 2:
    // token version / revocation list for immediate cut-off.
    if (staff.status !== 'ACTIVE') {
      throw new ForbiddenException({ code: 'STAFF_DISABLED' });
    }

    const links = await tx.staffRole.findMany({ where: { tenantId, staffId } });
    const roles = await tx.role.findMany({
      where: { tenantId, id: { in: links.map((l) => l.roleId) } },
    });

    let perms: string[];
    if (roles.some((r) => r.code === 'admin')) {
      perms = ['*'];
    } else {
      const roleIds = roles.map((r) => r.id);
      const binds = roleIds.length
        ? await tx.rolePermission.findMany({
            where: { tenantId, roleId: { in: roleIds } },
          })
        : [];
      const permRows = binds.length
        ? await tx.permission.findMany({
            where: { tenantId, id: { in: binds.map((b) => b.permissionId) } },
          })
        : [];
      perms = [...new Set(permRows.map((p) => p.code))];
    }

    const scope = this.widestScope(roles);
    const orgScope = await this.computeOrgScope(tx, tenantId, staff.orgUnitId, scope);
    return { staff, roles, perms, orgScope, scope };
  }

  private signTokens(identity: {
    staff: { id: string };
    perms: string[];
    orgScope: string[];
    scope: 'ALL' | 'ORG_SUBTREE' | 'SELF';
    tenantId: string;
  }) {
    const access: JwtUser = {
      sub: identity.staff.id,
      tenantId: identity.tenantId,
      scope: identity.scope,
      orgScope: identity.orgScope,
      perms: identity.perms,
      type: 'access',
    };
    const refresh = {
      sub: identity.staff.id,
      tenantId: identity.tenantId,
      type: 'refresh',
    };
    return Promise.all([
      this.jwt.signAsync(access, { expiresIn: '15m' }),
      this.jwt.signAsync(refresh, { expiresIn: '7d' }),
    ]).then(([accessToken, refreshToken]) => ({ accessToken, refreshToken }));
  }

  async login(body: LoginBody) {
    const tenant = await this.resolveTenant(body.tenantCode);
    const tenantId = tenant.id;

    return this.prisma.runAsTenant(tenantId, async (tx) => {
      const staff = await tx.staff.findFirst({
        where: { tenantId, login: body.login },
      });
      // Always bcrypt.compare — a missing login must cost the same time as a
      // wrong password (no user-existence timing oracle).
      if (!(await bcrypt.compare(body.password, staff?.passwordHash ?? DUMMY_HASH))) {
        throw INVALID_CREDENTIALS();
      }
      if (!staff) throw INVALID_CREDENTIALS();
      if (staff.status !== 'ACTIVE') {
        throw new ForbiddenException({ code: 'STAFF_DISABLED' });
      }

      const identity = await this.loadIdentity(tx, tenantId, staff.id);
      const tokens = await this.signTokens({ ...identity, tenantId });
      return {
        ...tokens,
        staff: {
          id: staff.id,
          login: staff.login,
          name: staff.name,
          orgUnitId: staff.orgUnitId,
        },
        roles: identity.roles.map((r) => ({
          code: r.code,
          name: r.name,
          dataScope: r.dataScope,
        })),
        perms: identity.perms,
      };
    });
  }

  /**
   * MVP refresh: verify the 7d refresh token, re-issue the token pair.
   * Simplified — every call mints a fresh pair; rotation + reuse detection is
   * phase-2 work. Tenant suspension IS re-checked here so a suspended tenant
   * cannot self-renew forever.
   */
  async refresh(refreshToken: string) {
    let payload: { sub: string; tenantId: string; type: string };
    try {
      payload = await this.jwt.verifyAsync(refreshToken);
    } catch {
      throw new UnauthorizedException({ code: 'AUTH_TOKEN_INVALID' });
    }
    if (payload.type !== 'refresh') {
      throw new UnauthorizedException({ code: 'AUTH_TOKEN_INVALID' });
    }
    return this.prisma.runAsTenant(payload.tenantId, async (tx) => {
      // Inside the tenant's own RLS scope the tenant row is visible.
      const tenant = await tx.tenant.findUnique({ where: { id: payload.tenantId } });
      if (!tenant || tenant.status !== 'ACTIVE') {
        throw new ForbiddenException({ code: 'TENANT_SUSPENDED' });
      }
      const identity = await this.loadIdentity(tx, payload.tenantId, payload.sub);
      return this.signTokens({ ...identity, tenantId: payload.tenantId });
    });
  }

  /** GET /auth/me — fresh staff + role + perm view for the token holder. */
  async me(user: JwtUser) {
    return this.prisma.runAsTenant(user.tenantId, async (tx) => {
      const { staff, roles, perms, orgScope, scope } = await this.loadIdentity(
        tx,
        user.tenantId,
        user.sub,
      );
      return {
        id: staff.id,
        login: staff.login,
        name: staff.name,
        status: staff.status,
        orgUnitId: staff.orgUnitId,
        tenantId: user.tenantId,
        roles: roles.map((r) => ({ code: r.code, name: r.name, dataScope: r.dataScope })),
        perms,
        scope,
        orgScope,
      };
    });
  }
}
