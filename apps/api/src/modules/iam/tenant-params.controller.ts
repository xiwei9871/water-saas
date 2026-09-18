import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Put,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';

/** Tenant-scoped key/value params (estimate limits, policies, ...). */
@Controller('iam/tenant-params')
export class TenantParamsController {
  constructor(private readonly prisma: TenantPrismaService) {}

  @Get()
  @Permissions('iam:read')
  list() {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.tenantParam.findMany({
        where: { tenantId: ctx.tenantId },
        orderBy: { key: 'asc' },
      }),
    );
  }

  @Get(':key')
  @Permissions('iam:read')
  async get(@Param('key') key: string) {
    const ctx = currentTenant();
    const row = await this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.tenantParam.findUnique({
        where: { tenantId_key: { tenantId: ctx.tenantId, key } },
      }),
    );
    return row?.value ?? null;
  }

  /** PUT /iam/tenant-params/:key {value} — upsert a JSON value. */
  @Put(':key')
  @Permissions('iam:write')
  put(@Param('key') key: string, @Body() body: { value?: Prisma.InputJsonValue }) {
    if (body === null || body === undefined || !('value' in body)) {
      throw new BadRequestException({ code: 'PARAM_VALUE_REQUIRED' });
    }
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.tenantParam.upsert({
        where: { tenantId_key: { tenantId: ctx.tenantId, key } },
        create: {
          tenantId: ctx.tenantId,
          key,
          value: body.value as Prisma.InputJsonValue,
          createdBy: ctx.staffId,
          updatedBy: ctx.staffId,
        },
        update: { value: body.value as Prisma.InputJsonValue, updatedBy: ctx.staffId },
      }),
    );
  }
}
