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
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { assertUuid } from '../../common/uuid.js';
import { MeterRelationService } from './meter-relation.service.js';

/** 20261021 整改 任务C：总分表关系（归属抄表管理模块）。 */
@Controller('meter-relations')
export class MeterRelationController {
  constructor(
    private readonly svc: MeterRelationService,
    private readonly prisma: TenantPrismaService,
    private readonly idem: IdempotencyService,
  ) {}

  @Get()
  @Permissions('metering:read', 'metering:service')
  list() {
    return this.svc.list(currentTenant());
  }

  /** GET /meter-relations/loss?masterMeterId=&from=&to= — 总表-分表漏损差额。 */
  @Get('loss')
  @Permissions('metering:read', 'metering:service')
  loss(
    @Query('masterMeterId') masterMeterId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    if (!masterMeterId) throw new BadRequestException({ code: 'MASTER_REQUIRED' });
    return this.svc.loss(currentTenant(), {
      masterMeterId: assertUuid(masterMeterId, 'masterMeterId'),
      from: from?.match(/^\d{6}$/) ? from : undefined,
      to: to?.match(/^\d{6}$/) ? to : undefined,
    });
  }

  @Post()
  @Permissions('metering:service', 'customer:write')
  create(
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body, responseStatus: 201 },
      (tx) => this.svc.createTx(tx, ctx, body, req),
    );
  }

  /** PATCH /meter-relations/:id — {billingMode?, expiredDate?} 切换计费模式 / 失效。 */
  @Patch(':id')
  @Permissions('metering:service', 'customer:write')
  update(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() req: Request) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.updateTx(tx, ctx, assertUuid(id, 'id'), body, req),
    );
  }
}
