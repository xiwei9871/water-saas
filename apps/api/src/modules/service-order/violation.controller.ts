import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
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
import { ViolationService } from './violation.service.js';

const pageArgs = (take?: string, skip?: string) => ({
  take: Math.min(Math.max(parseInt(take ?? '50', 10) || 50, 1), 200),
  skip: Math.max(parseInt(skip ?? '0', 10) || 0, 0),
});

/** 20261021 整改 任务E：违章用水（稽查登记 + 抄表上报 → 核实 → 处理 → 归档）。 */
@Controller()
export class ViolationController {
  constructor(
    private readonly svc: ViolationService,
    private readonly prisma: TenantPrismaService,
    private readonly idem: IdempotencyService,
  ) {}

  @Get('violations')
  @Permissions('metering:service', 'metering:read')
  list(
    @Query('status') status?: string,
    @Query('waterAccountId') waterAccountId?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.svc.list(currentTenant(), {
      status,
      waterAccountId: waterAccountId ? assertUuid(waterAccountId, 'waterAccountId') : undefined,
      ...pageArgs(take, skip),
    });
  }

  /** 稽查登记（INSPECT 直接进入待处理，仅稽查岗）/ 现场上报（FIELD → 待核实，抄表岗可报）。 */
  @Post('violations')
  @AnyPermissions('metering:service', 'metering:write')
  create(
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    const perms = ((req as Request & { user?: { perms?: string[] } }).user?.perms ?? []) as string[];
    if (
      body?.sourceType !== 'FIELD' &&
      !perms.includes('*') &&
      !perms.includes('metering:service')
    ) {
      throw new ForbiddenException({ code: 'VIOLATION_INSPECT_ONLY', message: '稽查登记仅稽查岗可录' });
    }
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body, responseStatus: 201 },
      (tx) => this.svc.createTx(tx, ctx, body, req),
    );
  }

  /** 抄表员上报疑似违章：POST /meter-readings/:id/report-violation */
  @Post('meter-readings/:id/report-violation')
  @AnyPermissions('metering:write', 'metering:service')
  reportByReading(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    const ctx = currentTenant();
    const readingId = assertUuid(id, 'id');
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body, responseStatus: 201 },
      async (tx) => {
        const reading = await tx.meterReading.findFirst({
          where: { tenantId: ctx.tenantId, id: readingId },
          select: { installationId: true },
        });
        if (!reading) throw new BadRequestException({ code: 'READING_NOT_FOUND' });
        const inst = await tx.meterInstallation.findFirstOrThrow({
          where: { tenantId: ctx.tenantId, id: reading.installationId },
          select: { waterAccountId: true },
        });
        return this.svc.createTx(
          tx,
          ctx,
          { ...body, waterAccountId: inst.waterAccountId, sourceType: 'READING', sourceReadingId: readingId },
          req,
        );
      },
    );
  }

  /** 核实：{confirm:true→PROCESSING | false→DISMISSED误报} */
  @Post('violations/:id/verify')
  @Permissions('metering:service')
  verify(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() req: Request) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.verifyTx(tx, ctx, assertUuid(id, 'id'), body, req),
    );
  }

  /** 处理：{penaltyAmount, backbillAmount, note, serviceOrderId?} */
  @Post('violations/:id/process')
  @Permissions('metering:service')
  process(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() req: Request) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.processTx(tx, ctx, assertUuid(id, 'id'), body, req),
    );
  }

  /** 归档：须 evidence.site[] + evidence.penaltyDoc[]（现场照片+处罚文书）。 */
  @Post('violations/:id/archive')
  @Permissions('metering:service')
  archive(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() req: Request) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.archiveTx(tx, ctx, assertUuid(id, 'id'), body, req),
    );
  }
}
