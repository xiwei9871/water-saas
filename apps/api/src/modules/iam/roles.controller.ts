import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';

/**
 * Role CRUD + permission binding. `role.code === 'admin'` bypasses all
 * permission checks ('*' in the JWT) — other roles need explicit
 * role_permission rows.
 */
@Controller('iam/roles')
export class RolesController {
  constructor(private readonly prisma: TenantPrismaService) {}

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

  @Post()
  @Permissions('iam:write')
  create(@Body() body: { code?: string; name?: string; dataScope?: 'ALL' | 'ORG_SUBTREE' | 'SELF' }) {
    if (!body?.code || !body?.name || !body?.dataScope) {
      throw new BadRequestException({ code: 'ROLE_FIELDS_REQUIRED' });
    }
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
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
  }

  @Patch(':id')
  @Permissions('iam:write')
  update(
    @Param('id') id: string,
    @Body() body: { name?: string; dataScope?: 'ALL' | 'ORG_SUBTREE' | 'SELF' },
  ) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.role.findFirst({ where: { tenantId: ctx.tenantId, id } });
      if (!existing) throw new NotFoundException({ code: 'ROLE_NOT_FOUND' });
      return tx.role.update({
        where: { id },
        data: { name: body.name, dataScope: body.dataScope, updatedBy: ctx.staffId },
      });
    });
  }

  /** PUT /iam/roles/:id/permissions {permissionIds: []} — full replace. */
  @Put(':id/permissions')
  @Permissions('iam:write')
  setPermissions(@Param('id') id: string, @Body() body: { permissionIds?: string[] }) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.role.findFirst({ where: { tenantId: ctx.tenantId, id } });
      if (!existing) throw new NotFoundException({ code: 'ROLE_NOT_FOUND' });
      const permIds = body.permissionIds ?? [];
      if (permIds.length) {
        const perms = await tx.permission.findMany({
          where: { tenantId: ctx.tenantId, id: { in: permIds } },
        });
        if (perms.length !== permIds.length) {
          throw new BadRequestException({ code: 'PERMISSION_NOT_FOUND' });
        }
      }
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
  createPermission(@Body() body: { code?: string; type?: 'MENU' | 'ACTION' | 'DATA' }) {
    if (!body?.code || !body?.type) {
      throw new BadRequestException({ code: 'PERMISSION_FIELDS_REQUIRED' });
    }
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.permission.create({
        data: {
          tenantId: ctx.tenantId,
          code: body.code!,
          type: body.type!,
          createdBy: ctx.staffId,
          updatedBy: ctx.staffId,
        },
      }),
    );
  }
}
