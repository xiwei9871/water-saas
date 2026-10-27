import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import * as XLSX from 'xlsx';
import { IdempotencyService } from '../../common/idempotency.service.js';
import { withOptionalIdem } from '../../common/idempotent.js';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { isValidPeriod } from '../../common/reading-cadence.js';
import { assertUuid } from '../../common/uuid.js';
import { DmaService } from './dma.service.js';

const pageArgs = (take?: string, skip?: string) => ({
  take: Math.min(Math.max(parseInt(take ?? '50', 10) || 50, 1), 200),
  skip: Math.max(parseInt(skip ?? '0', 10) || 0, 0),
});

/**
 * 20261023 C1/C2：DMA 管理 + 产销差看板。
 * GET 走 metering:read；关系维护走 metering:service（与表务库房一致）。
 */
@Controller('dma')
export class DmaController {
  constructor(
    private readonly svc: DmaService,
    private readonly prisma: TenantPrismaService,
    private readonly idem: IdempotencyService,
  ) {}

  @Get('zones')
  @Permissions('metering:read')
  list(@Query('take') take?: string, @Query('skip') skip?: string, @Query('kw') kw?: string) {
    return this.svc.listZones(currentTenant(), { ...pageArgs(take, skip), kw: kw?.trim() || undefined });
  }

  @Post('zones')
  @Permissions('metering:service')
  create(@Body() body: Record<string, unknown>, @Req() req: Request) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.createZoneTx(tx, ctx, body, req),
    );
  }

  @Patch('zones/:id')
  @Permissions('metering:service')
  update(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() req: Request) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.updateZoneTx(tx, ctx, assertUuid(id, 'id'), body, req),
    );
  }

  /**
   * C2 看板：?period=YYYYMM 单期，?periods=YYYYMM,YYYYMM… 多期对比/趋势。
   * 漏损率 = (Σ考核表水量 − Σ挂接水量) ÷ Σ考核表水量 × 100；考核表水量为 0 → null。
   * 须先于 zones/:id 声明，否则 'dashboard' 会被当 id。
   */
  @Get('dashboard')
  @Permissions('metering:read')
  dashboard(
    @Query('period') period?: string,
    @Query('periods') periods?: string,
    @Query('zoneId') zoneId?: string,
  ) {
    const list = (periods ?? period ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .slice(0, 24);
    if (list.length === 0 || list.some((p) => !isValidPeriod(p))) {
      throw new BadRequestException({ code: 'INVALID_PERIOD' });
    }
    return this.svc.dashboard(currentTenant(), list, zoneId ? assertUuid(zoneId, 'zoneId') : undefined);
  }

  /** 问题2（1027 整合）：产销差看板导出 xlsx，列与看板一致。 */
  @Get('dashboard/export')
  @Permissions('metering:read')
  async dashboardExport(
    @Res({ passthrough: true }) res: Response,
    @Query('period') period?: string,
    @Query('periods') periods?: string,
    @Query('zoneId') zoneId?: string,
  ) {
    const list = (periods ?? period ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .slice(0, 24);
    if (list.length === 0 || list.some((p) => !isValidPeriod(p))) {
      throw new BadRequestException({ code: 'INVALID_PERIOD' });
    }
    const data = await this.svc.dashboard(
      currentTenant(),
      list,
      zoneId ? assertUuid(zoneId, 'zoneId') : undefined,
    );
    const header = ['账期', '分区编码', '分区名称', '区域', '考核表数', '挂接表数', '考核表水量m³', '挂接水量m³', '未计量水量m³', '漏损率%', '未抄考核表'];
    const aoa: unknown[][] = [header];
    for (const p of data) {
      for (const r of p.rows) {
        aoa.push([
          p.period, r.dma.code, r.dma.name, r.dma.region ?? '',
          r.checkMeterCount, r.linkedMeterCount, r.checkQty, r.linkedQty,
          r.unmeasuredQty, r.leakageRate ?? '—', r.unreadCheckMeters,
        ]);
      }
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), '产销差');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="dma-dashboard-${new Date().toISOString().slice(0, 10)}.xlsx"`,
    );
    res.send(buf);
  }

  @Get('zones/:id')
  @Permissions('metering:read')
  detail(@Param('id') id: string) {
    return this.svc.zoneDetail(currentTenant(), assertUuid(id, 'id'));
  }

  /** 看板下钻：某 DMA 某期两侧分表用量明细。 */
  @Get('zones/:id/usage')
  @Permissions('metering:read')
  usage(@Param('id') id: string, @Query('period') period?: string) {
    return this.svc.zonePeriodDetail(currentTenant(), assertUuid(id, 'id'), period ?? '');
  }

  /** 挂考核表（D1/D3：meterIds 多选；监控表户反查校验在 service）。 */
  @Post('zones/:id/check-meters')
  @Permissions('metering:service')
  addCheckMeter(
    @Param('id') id: string,
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
      (tx) => this.svc.addCheckMeterTx(tx, ctx, assertUuid(id, 'id'), body, req),
    );
  }

  /** 摘除考核表（置 effective_to，同事务级联失效其挂接）。 */
  @Delete('check-meters/:id')
  @Permissions('metering:service')
  unlinkCheckMeter(@Param('id') id: string, @Req() req: Request) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.unlinkCheckMeterTx(tx, ctx, assertUuid(id, 'id'), req),
    );
  }

  /** 考核表下挂计费侧水表（多对多，可一次多选）。 */
  @Post('check-meters/:id/links')
  @Permissions('metering:service')
  linkMeters(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
  ) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.linkMetersTx(tx, ctx, assertUuid(id, 'id'), body, req),
    );
  }

  @Delete('links/:id')
  @Permissions('metering:service')
  unlinkMeter(@Param('id') id: string, @Req() req: Request) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.unlinkMeterTx(tx, ctx, assertUuid(id, 'id'), req),
    );
  }
}
