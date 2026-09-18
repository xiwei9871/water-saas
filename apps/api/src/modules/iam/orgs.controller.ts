import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';

/**
 * Org-unit tree CRUD. All queries go through runAsTenant; callers with a
 * restricted data scope (ORG_SUBTREE) only see orgs inside ctx.orgScope.
 */
@Controller('iam/orgs')
export class OrgsController {
  constructor(private readonly prisma: TenantPrismaService) {}

  @Get()
  @Permissions('iam:read')
  list() {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.orgUnit.findMany({
        where: { tenantId: ctx.tenantId, id: { in: ctx.orgScope } },
        orderBy: [{ parentId: 'asc' }, { name: 'asc' }],
      }),
    );
  }

  @Post()
  @Permissions('iam:write')
  create(@Body() body: { name?: string; type?: 'COMPANY' | 'BRANCH' | 'DEPT'; parentId?: string }) {
    if (!body?.name || !body?.type) {
      throw new BadRequestException({ code: 'ORG_FIELDS_REQUIRED' });
    }
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      if (body.parentId) {
        const parent = await tx.orgUnit.findFirst({
          where: { tenantId: ctx.tenantId, id: body.parentId },
        });
        if (!parent) throw new NotFoundException({ code: 'ORG_PARENT_NOT_FOUND' });
      }
      return tx.orgUnit.create({
        data: {
          tenantId: ctx.tenantId,
          name: body.name!,
          type: body.type!,
          parentId: body.parentId ?? null,
          createdBy: ctx.staffId,
          updatedBy: ctx.staffId,
        },
      });
    });
  }

  @Patch(':id')
  @Permissions('iam:write')
  update(
    @Param('id') id: string,
    @Body() body: { name?: string; type?: 'COMPANY' | 'BRANCH' | 'DEPT'; parentId?: string | null },
  ) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.orgUnit.findFirst({ where: { tenantId: ctx.tenantId, id } });
      if (!existing) throw new NotFoundException({ code: 'ORG_NOT_FOUND' });
      if (body.parentId) {
        const parent = await tx.orgUnit.findFirst({
          where: { tenantId: ctx.tenantId, id: body.parentId },
        });
        if (!parent) throw new NotFoundException({ code: 'ORG_PARENT_NOT_FOUND' });
      }
      return tx.orgUnit.update({
        where: { tenantId_id: { tenantId: ctx.tenantId, id } },
        data: {
          name: body.name,
          type: body.type,
          parentId: body.parentId === undefined ? undefined : body.parentId,
          updatedBy: ctx.staffId,
        },
      });
    });
  }

  @Delete(':id')
  @Permissions('iam:write')
  remove(@Param('id') id: string) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.orgUnit.findFirst({ where: { tenantId: ctx.tenantId, id } });
      if (!existing) throw new NotFoundException({ code: 'ORG_NOT_FOUND' });
      const children = await tx.orgUnit.count({
        where: { tenantId: ctx.tenantId, parentId: id },
      });
      if (children > 0) {
        throw new BadRequestException({ code: 'ORG_HAS_CHILDREN' });
      }
      const staffCount = await tx.staff.count({
        where: { tenantId: ctx.tenantId, orgUnitId: id },
      });
      if (staffCount > 0) {
        throw new BadRequestException({ code: 'ORG_HAS_STAFF' });
      }
      return tx.orgUnit.delete({
        where: { tenantId_id: { tenantId: ctx.tenantId, id } },
      });
    });
  }
}
