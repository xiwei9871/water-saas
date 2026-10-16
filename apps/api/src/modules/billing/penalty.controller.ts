import { BadRequestException, Body, Controller, Get, Post } from '@nestjs/common';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { PenaltyService, PENALTY_PARAM_KEY } from './penalty.service.js';

const assertDate = (v: unknown): Date => {
  const d = v ? new Date(String(v)) : new Date();
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException({ code: 'DATE_INVALID', field: 'asOfDate' });
  }
  return d;
};

/**
 * G1 违约金：POST /billing/penalties/accrue 按 tenant_param
 * 'billing.penalty' 口径计提；GET /config 返回当前生效口径（含默认值）。
 */
@Controller('billing/penalties')
export class PenaltyController {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly svc: PenaltyService,
  ) {}

  @Get('config')
  @Permissions('billing:read')
  async config() {
    const ctx = currentTenant();
    const cfg = await this.prisma.runAsTenant(ctx.tenantId, (tx) => this.svc.configTx(tx, ctx));
    return { paramKey: PENALTY_PARAM_KEY, ...cfg };
  }

  @Post('accrue')
  @Permissions('billing:write')
  accrue(@Body() body: { asOfDate?: string }) {
    const ctx = currentTenant();
    const asOf = assertDate(body?.asOfDate);
    return this.prisma.runAsTenant(ctx.tenantId, (tx) => this.svc.accrueTx(tx, ctx, asOf));
  }
}
