import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type { ServiceOrderStatus } from '@prisma/client';
import { IdempotencyService } from '../../common/idempotency.service.js';
import { withOptionalIdem } from '../../common/idempotent.js';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { assertUuid } from '../../common/uuid.js';
import {
  ServiceOrderService,
  type ExecuteBody,
  type ServiceOrderBody,
} from './service-order.service.js';

const pageArgs = (take?: string, skip?: string) => ({
  take: Math.min(Math.max(parseInt(take ?? '50', 10) || 50, 1), 200),
  skip: Math.max(parseInt(skip ?? '0', 10) || 0, 0),
});

const ORDER_STATUS = new Set([
  'PENDING_APPROVAL',
  'APPROVED',
  'DISPATCHED',
  'EXECUTED',
  'ARCHIVED',
  'REJECTED',
  'CANCELLED',
]);

/**
 * 表务工单（20261019 整合需求 T1-T6）。
 * 申请 POST /service-orders（幂等键可选）→ 审批 approve/reject →
 * 派单 dispatch（自动建 Task）→ 执行 execute（域联动同事务）→ 归档 archive。
 * cancel 可在归档前任意前置状态撤销。
 */
@Controller('service-orders')
export class ServiceOrderController {
  constructor(
    private readonly svc: ServiceOrderService,
    private readonly prisma: TenantPrismaService,
    private readonly idem: IdempotencyService,
  ) {}

  @Get()
  @Permissions('metering:service')
  list(
    @Query('take') take?: string,
    @Query('skip') skip?: string,
    @Query('status') status?: string,
    @Query('serviceType') serviceType?: string,
    @Query('waterAccountId') waterAccountId?: string,
    @Query('orgUnitId') orgUnitId?: string,
    @Query('sourceType') sourceType?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const ctx = currentTenant();
    return this.svc.list(ctx, {
      ...pageArgs(take, skip),
      status: status && ORDER_STATUS.has(status) ? (status as ServiceOrderStatus) : undefined,
      serviceType,
      waterAccountId,
      orgUnitId: orgUnitId ? assertUuid(orgUnitId) : undefined,
      sourceType,
      from,
      to,
    });
  }

  /** T4 到期检定扫描：默认提前 30 天（meterService.checkLeadDays 可配）。 */
  @Post('scan-check-due')
  @Permissions('metering:service')
  scanCheckDue(@Body() body?: { leadDays?: number; asOf?: string }) {
    return this.svc.scanCheckDue(currentTenant(), {
      leadDays: body?.leadDays !== undefined ? Math.max(0, Math.trunc(body.leadDays)) : undefined,
      asOf: body?.asOf,
    });
  }

  /** T12 查询：水表生命周期轨迹（该户装/拆/换 + 工单 + 账户事件时间线）。 */
  @Get('meter-lifecycle/:waterAccountId')
  @Permissions('metering:service')
  lifecycle(@Param('waterAccountId') waterAccountId: string) {
    return this.svc.meterLifecycle(currentTenant(), assertUuid(waterAccountId));
  }

  /** T11 表务处置统计：按类型/状态分布 + 处置时长 + 按期完成率。 */
  @Get('stats')
  @Permissions('metering:service')
  stats(@Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.stats(currentTenant(), { from, to });
  }

  /** T12 换表记录：REMOVED 安装行 + 接替行（分段水量明细）。 */
  @Get('replace-records')
  @Permissions('metering:service')
  replaceRecords(
    @Query('take') take?: string,
    @Query('skip') skip?: string,
    @Query('waterAccountId') waterAccountId?: string,
  ) {
    return this.svc.replaceRecords(currentTenant(), { ...pageArgs(take, skip), waterAccountId });
  }

  @Get(':id')
  @Permissions('metering:service')
  get(@Param('id') id: string) {
    return this.svc.getById(currentTenant(), assertUuid(id));
  }

  @Post()
  @Permissions('metering:service')
  create(
    @Body() body: ServiceOrderBody,
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body, responseStatus: 201 },
      (tx) => this.svc.createTx(tx, ctx, body),
    );
  }

  @Post(':id/approve')
  @Permissions('metering:service')
  approve(
    @Param('id') id: string,
    @Body() body: { note?: string },
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body },
      (tx) => this.svc.approveTx(tx, ctx, assertUuid(id), body ?? {}, req),
    );
  }

  @Post(':id/reject')
  @Permissions('metering:service')
  reject(
    @Param('id') id: string,
    @Body() body: { note?: string },
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body },
      (tx) => this.svc.rejectTx(tx, ctx, assertUuid(id), body ?? {}, req),
    );
  }

  @Post(':id/dispatch')
  @Permissions('metering:service')
  dispatch(
    @Param('id') id: string,
    @Body() body: { assigneeId?: string; note?: string },
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body },
      (tx) => this.svc.dispatchTx(tx, ctx, assertUuid(id), body ?? {}, req),
    );
  }

  @Post(':id/execute')
  @Permissions('metering:service')
  execute(
    @Param('id') id: string,
    @Body() body: ExecuteBody,
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body },
      (tx) => this.svc.executeTx(tx, ctx, assertUuid(id), body ?? {}, req),
    );
  }

  @Post(':id/archive')
  @Permissions('metering:service')
  archive(
    @Param('id') id: string,
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body: {} },
      (tx) => this.svc.archiveTx(tx, ctx, assertUuid(id), req),
    );
  }

  @Post(':id/cancel')
  @Permissions('metering:service')
  cancel(
    @Param('id') id: string,
    @Body() body: { reason?: string },
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body },
      (tx) => this.svc.cancelTx(tx, ctx, assertUuid(id), body ?? {}, req),
    );
  }
}
