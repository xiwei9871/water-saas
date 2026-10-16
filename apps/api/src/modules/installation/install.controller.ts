import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import type { InstallApplyStatus } from '@prisma/client';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { assertUuid } from '../../common/uuid.js';
import { InstallService, type CreateApplyBody } from './install.service.js';
import { parseOnboardWire, type OnboardWireBody } from '../customer/onboard-wire.js';

const STATUSES = new Set(['SUBMITTED', 'SURVEYED', 'APPROVED', 'INSTALLING', 'COMPLETED', 'REJECTED', 'CANCELLED']);

/**
 * S1 报装管理（独立域）：/install/applications 申请→勘察→审批→装表→
 * 归档立户。权限 install:read/install:write 独立于营销权限码——报装
 * 域要剥离成独立服务时整体迁出即可。
 */
@Controller('install/applications')
export class InstallController {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly svc: InstallService,
  ) {}

  @Get()
  @Permissions('install:read')
  list(@Query('status') status?: string, @Query('take') take?: string) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.installApplication.findMany({
        where: {
          tenantId: ctx.tenantId,
          ...(status && STATUSES.has(status) ? { status: status as InstallApplyStatus } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: Math.min(parseInt(take ?? '50', 10) || 50, 200),
      }),
    );
  }

  @Get(':id')
  @Permissions('install:read')
  detail(@Param('id') id: string) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const app = await tx.installApplication.findFirst({
        where: { tenantId: ctx.tenantId, id: assertUuid(id, 'id') },
      });
      if (!app) throw new BadRequestException({ code: 'APPLY_NOT_FOUND' });
      return app;
    });
  }

  @Post()
  @Permissions('install:write')
  create(@Body() body: CreateApplyBody) {
    if (!body?.applicantName?.trim() || !body?.addr?.trim() || !body?.usageCategory?.trim()) {
      throw new BadRequestException({ code: 'APPLY_BODY_INVALID' });
    }
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) => this.svc.createTx(tx, ctx, body));
  }

  @Post(':id/transition')
  @Permissions('install:write')
  transition(@Param('id') id: string, @Body() body: { to?: string; note?: string }) {
    const to = body?.to;
    if (!to || !STATUSES.has(to)) throw new BadRequestException({ code: 'APPLY_TARGET_INVALID' });
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.transitionTx(tx, ctx, assertUuid(id, 'id'), to as InstallApplyStatus, body.note),
    );
  }

  /** 归档：按立户向导体创建 客户/结算户/用水户/表/安装，回写户号。
   *  客户可省略——缺省时以申请单信息建客。 */
  @Post(':id/archive')
  @Permissions('install:write')
  archive(@Param('id') id: string, @Body() body: OnboardWireBody) {
    const parsed = parseOnboardWire(body, { allowNoCustomer: true });
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.archiveTx(tx, ctx, assertUuid(id, 'id'), parsed),
    );
  }
}
