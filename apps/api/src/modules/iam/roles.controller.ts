import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { assertAdmin } from '../../common/admin.js';
import { IdempotencyService } from '../../common/idempotency.service.js';
import { Permissions } from '../../common/permissions.decorator.js';
import { conflictOnUnique } from '../../common/prisma-errors.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { assertUuid } from '../../common/uuid.js';

/**
 * Role CRUD + permission binding. `role.code === 'admin'` bypasses all
 * permission checks ('*' in the JWT) — other roles need explicit
 * role_permission rows.
 *
 * The whole role-management surface (create/patch/delete/permission-bind) is
 * ADMIN-ONLY (assertAdmin): a non-admin iam:write user must not mint wider
 * scope/permissions than they hold — that's the tenant-takeover chain
 * (grant → self-assign → re-login). Reads stay iam:read.
 */
@Controller('iam/roles')
export class RolesController {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly idem: IdempotencyService,
  ) {}

  @Get()
  @Permissions('iam:read')
  list() {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const roles = await tx.role.findMany({
        where: { tenantId: ctx.tenantId },
        orderBy: { code: 'asc' },
      });
      const binds = await tx.rolePermission.findMany({
        where: { tenantId: ctx.tenantId, roleId: { in: roles.map((r) => r.id) } },
      });
      const permRows = await tx.permission.findMany({
        where: { tenantId: ctx.tenantId, id: { in: binds.map((b) => b.permissionId) } },
      });
      const byRole = new Map<string, string[]>();
      for (const b of binds) {
        const code = permRows.find((p) => p.id === b.permissionId)?.code;
        if (code) byRole.set(b.roleId, [...(byRole.get(b.roleId) ?? []), code]);
      }
      return roles.map((r) => ({ ...r, perms: byRole.get(r.id) ?? [] }));
    });
  }

  /**
   * POST /iam/roles — create a role. Honors Idempotency-Key like staff POST;
   * field validation lives inside the keyed fn so an in-flight replay check
   * always precedes input validation.
   */
  @Post()
  @Permissions('iam:write')
  async create(
    @Body() body: { code?: string; name?: string; dataScope?: 'ALL' | 'ORG_SUBTREE' | 'SELF' },
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    const ctx = currentTenant();
    assertAdmin(req.user);
    const doCreate = (tx: Prisma.TransactionClient) => {
      if (!body?.code || !body?.name || !body?.dataScope) {
        throw new BadRequestException({ code: 'ROLE_FIELDS_REQUIRED' });
      }
      return conflictOnUnique(
        tx.role.create({
          data: {
            tenantId: ctx.tenantId,
            code: body.code!,
            name: body.name!,
            dataScope: body.dataScope!,
            createdBy: ctx.staffId,
            updatedBy: ctx.staffId,
          },
        }),
      );
    };
    if (!key) {
      return this.prisma.runAsTenant(ctx.tenantId, doCreate);
    }
    const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const result = await this.idem.runWithKey(
      ctx.tenantId,
      { key, method: 'POST', route: '/iam/roles', requestHash, responseStatus: 201 },
      doCreate,
    );
    return result.body;
  }

  @Patch(':id')
  @Permissions('iam:write')
  update(
    @Param('id') id: string,
    @Body() body: { name?: string; dataScope?: 'ALL' | 'ORG_SUBTREE' | 'SELF' },
    @Req() req: Request,
  ) {
    const ctx = currentTenant();
    assertAdmin(req.user);
    assertUuid(id, 'id');
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.role.findFirst({ where: { tenantId: ctx.tenantId, id } });
      if (!existing) throw new NotFoundException({ code: 'ROLE_NOT_FOUND' });
      req.auditBefore = existing;
      return tx.role.update({
        where: { id },
        data: { name: body.name, dataScope: body.dataScope, updatedBy: ctx.staffId },
      });
    });
  }

  /**
   * DELETE /iam/roles/:id — refused while any staff still holds the role;
   * the role's own permission bindings are removed with it.
   */
  @Delete(':id')
  @Permissions('iam:write')
  remove(@Param('id') id: string, @Req() req: Request) {
    const ctx = currentTenant();
    assertAdmin(req.user);
    assertUuid(id, 'id');
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.role.findFirst({ where: { tenantId: ctx.tenantId, id } });
      if (!existing) throw new NotFoundException({ code: 'ROLE_NOT_FOUND' });
      // The built-in 'admin' role is never deletable — removing it would
      // brick the tenant's administration (and its '*' wildcard must not be
      // casually churned even by an admin).
      if (existing.code === 'admin') {
        throw new ForbiddenException({ code: 'ROLE_PROTECTED' });
      }
      const holders = await tx.staffRole.count({
        where: { tenantId: ctx.tenantId, roleId: id },
      });
      if (holders > 0) {
        throw new ConflictException({ code: 'ROLE_IN_USE', holders });
      }
      req.auditBefore = existing;
      await tx.rolePermission.deleteMany({
        where: { tenantId: ctx.tenantId, roleId: id },
      });
      return tx.role.delete({ where: { id } });
    });
  }

  /** PUT /iam/roles/:id/permissions {permissionIds: []} — full replace. Admin-only. */
  @Put(':id/permissions')
  @Permissions('iam:write')
  setPermissions(
    @Param('id') id: string,
    @Body() body: { permissionIds?: string[] },
    @Req() req: Request,
  ) {
    const ctx = currentTenant();
    assertAdmin(req.user);
    assertUuid(id, 'id');
    if (body.permissionIds !== undefined && !Array.isArray(body.permissionIds)) {
      throw new BadRequestException({ code: 'PERMISSION_IDS_MUST_BE_ARRAY' });
    }
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.role.findFirst({ where: { tenantId: ctx.tenantId, id } });
      if (!existing) throw new NotFoundException({ code: 'ROLE_NOT_FOUND' });
      const permIds = [...new Set(body.permissionIds ?? [])];
      if (permIds.length) {
        const perms = await tx.permission.findMany({
          where: { tenantId: ctx.tenantId, id: { in: permIds } },
        });
        if (perms.length !== permIds.length) {
          throw new BadRequestException({ code: 'PERMISSION_NOT_FOUND' });
        }
      }
      req.auditBefore = existing;
      await tx.rolePermission.deleteMany({ where: { tenantId: ctx.tenantId, roleId: id } });
      for (const permissionId of permIds) {
        await tx.rolePermission.create({
          data: {
            tenantId: ctx.tenantId,
            roleId: id,
            permissionId,
            createdBy: ctx.staffId,
            updatedBy: ctx.staffId,
          },
        });
      }
      return { ok: true };
    });
  }

  // ---- permission dictionary ----

  @Get('/permissions/list')
  @Permissions('iam:read')
  listPermissions() {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.permission.findMany({
        where: { tenantId: ctx.tenantId },
        orderBy: { code: 'asc' },
      }),
    );
  }

  @Post('/permissions')
  @Permissions('iam:write')
  createPermission(
    @Body() body: { code?: string; type?: 'MENU' | 'ACTION' | 'DATA' },
    @Req() req: Request,
  ) {
    // Minting permission codes is part of the grant surface — admin-only,
    // same as the rest of role management.
    assertAdmin(req.user);
    if (!body?.code || !body?.type) {
      throw new BadRequestException({ code: 'PERMISSION_FIELDS_REQUIRED' });
    }
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      conflictOnUnique(
        tx.permission.create({
          data: {
            tenantId: ctx.tenantId,
            code: body.code!,
            type: body.type!,
            createdBy: ctx.staffId,
            updatedBy: ctx.staffId,
          },
        }),
      ),
    );
  }
}
