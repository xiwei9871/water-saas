import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { assertUuid } from '../../common/uuid.js';
import { RoutePatternService } from './route-pattern.service.js';

/** R15-6 抄表顺序模式（命名路线，可保存/切换/设默认，Web+APP 共用）。 */
@Controller('route-patterns')
export class RoutePatternController {
  constructor(
    private readonly svc: RoutePatternService,
    private readonly prisma: TenantPrismaService,
  ) {}

  @Get()
  @Permissions('metering:read')
  list(@Query('zoneNo') zoneNo?: string) {
    return this.svc.list(currentTenant(), zoneNo?.trim() || undefined);
  }

  @Post()
  @Permissions('metering:write')
  save(@Body() body: { zoneNo?: string; name?: string; isDefault?: boolean }) {
    if (!body?.zoneNo?.trim() || !body?.name?.trim()) {
      throw new BadRequestException({ code: 'PATTERN_FIELDS_REQUIRED' });
    }
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.saveTx(tx, ctx, {
        zoneNo: body.zoneNo!,
        name: body.name!,
        isDefault: body.isDefault,
      }),
    );
  }

  @Post(':id/apply')
  @Permissions('metering:write')
  apply(@Param('id') id: string, @Req() req: Request) {
    assertUuid(id, 'id');
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.applyTx(tx, ctx, id, req),
    );
  }

  @Post(':id/default')
  @Permissions('metering:write')
  setDefault(@Param('id') id: string) {
    assertUuid(id, 'id');
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.setDefaultTx(tx, ctx, id),
    );
  }

  @Delete(':id')
  @Permissions('metering:write')
  remove(@Param('id') id: string, @Req() req: Request) {
    assertUuid(id, 'id');
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.removeTx(tx, ctx, id, req),
    );
  }
}
