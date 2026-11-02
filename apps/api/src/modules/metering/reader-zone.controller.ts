import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { IdempotencyService } from '../../common/idempotency.service.js';
import { withOptionalIdem } from '../../common/idempotent.js';
import { AnyPermissions, Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { assertUuid } from '../../common/uuid.js';
import {
  ReaderZoneService,
  type ReaderZoneBody,
  type ReaderZonePatchBody,
} from './reader-zone.service.js';

/**
 * R14 区号管理（系统管理 → 区号—抄表员绑定维护）。
 * 列表/选项对业务角色开放（下拉数据源）；绑定/变更/解绑属管理动作，
 * 由 iam:write（系统管理岗）或 metering:write（抄表管理岗）维护。
 */
@Controller('reading-zones')
export class ReaderZoneController {
  constructor(
    private readonly svc: ReaderZoneService,
    private readonly prisma: TenantPrismaService,
    private readonly idem: IdempotencyService,
  ) {}

  @Get()
  @AnyPermissions('iam:read', 'metering:read', 'customer:read', 'install:read')
  list(@Query('status') status?: string) {
    return this.svc.list(currentTenant(), { status: status?.trim() || undefined });
  }

  /** GET /reading-zones/options — 区号+抄表员下拉统一数据源（R14-3）。 */
  @Get('options')
  @AnyPermissions('iam:read', 'metering:read', 'customer:read', 'install:read')
  options() {
    return this.svc.options(currentTenant());
  }

  /** GET /reading-zones/history — 绑定/变更/解绑留痕（audit_log）。 */
  @Get('history')
  @AnyPermissions('iam:read', 'metering:read')
  history(@Query('zoneNo') zoneNo?: string) {
    return this.svc.history(currentTenant(), zoneNo?.trim() || undefined);
  }

  @Post()
  @AnyPermissions('iam:write', 'metering:write')
  create(
    @Body() body: ReaderZoneBody,
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!body?.zoneNo?.trim()) {
      throw new BadRequestException({ code: 'ZONE_NO_REQUIRED' });
    }
    const parsed: ReaderZoneBody = {
      zoneNo: body.zoneNo,
      readerId:
        body.readerId === undefined || body.readerId === null
          ? null
          : assertUuid(body.readerId, 'readerId'),
      remark: body.remark ?? null,
    };
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body, responseStatus: 201 },
      (tx) => this.svc.createTx(tx, ctx, parsed),
    );
  }

  /** PATCH /reading-zones/:id — 变更绑定/解绑/停用（留痕走 audit_log）。 */
  @Patch(':id')
  @AnyPermissions('iam:write', 'metering:write')
  update(
    @Param('id') id: string,
    @Body() body: ReaderZonePatchBody,
    @Req() req: Request,
  ) {
    assertUuid(id, 'id');
    if (body?.readerId !== undefined && body.readerId !== null) {
      assertUuid(body.readerId, 'readerId');
    }
    const parsed: ReaderZonePatchBody = {
      readerId: body?.readerId,
      status: body?.status,
      remark: body?.remark,
    };
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.updateTx(tx, ctx, id, parsed, req),
    );
  }
}
