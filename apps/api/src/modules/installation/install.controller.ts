import { BadRequestException, Body, ConflictException, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type { InstallApplyStatus } from '@prisma/client';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { assertUuid } from '../../common/uuid.js';
import { assertUsageCategory } from '../../common/usage-categories.js';
import { InstallService, type CreateApplyBody } from './install.service.js';
import type { OnboardWireBody } from '../customer/onboard-wire.js';

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
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.installApplication.findMany({
        where: {
          tenantId: ctx.tenantId,
          ...(status && STATUSES.has(status) ? { status: status as InstallApplyStatus } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: Math.min(parseInt(take ?? '50', 10) || 50, 200),
      });
      const waIds = rows.map((r) => r.waterAccountId).filter((v): v is string => !!v);
      const saIds = rows.map((r) => r.settleAccountId).filter((v): v is string => !!v);
      const [was, sas] = await Promise.all([
        tx.waterAccount.findMany({
          where: { tenantId: ctx.tenantId, id: { in: waIds } },
          select: { id: true, accountNo: true },
        }),
        tx.settleAccount.findMany({
          where: { tenantId: ctx.tenantId, id: { in: saIds } },
          select: { id: true, settleNo: true },
        }),
      ]);
      const noOf = new Map(was.map((w) => [w.id, w.accountNo]));
      const settleOf = new Map(sas.map((s) => [s.id, s.settleNo]));
      return rows.map((r) => ({
        ...r,
        waterAccountNo: r.waterAccountId ? (noOf.get(r.waterAccountId) ?? null) : null,
        settleNo: r.settleAccountId ? (settleOf.get(r.settleAccountId) ?? null) : null,
      }));
    });
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
      const wa = app.waterAccountId
        ? await tx.waterAccount.findFirst({
            where: { tenantId: ctx.tenantId, id: app.waterAccountId },
            select: { accountNo: true },
          })
        : null;
      const sa = app.settleAccountId
        ? await tx.settleAccount.findFirst({
            where: { tenantId: ctx.tenantId, id: app.settleAccountId },
            select: { settleNo: true },
          })
        : null;
      return { ...app, waterAccountNo: wa?.accountNo ?? null, settleNo: sa?.settleNo ?? null };
    });
  }

  @Post()
  @Permissions('install:write')
  create(@Body() body: CreateApplyBody) {
    if (!body?.applicantName?.trim() || !body?.addr?.trim() || !body?.usageCategory?.trim()) {
      throw new BadRequestException({ code: 'APPLY_BODY_INVALID' });
    }
    assertUsageCategory(body.usageCategory);
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) => this.svc.createTx(tx, ctx, body));
  }

  @Post(':id/transition')
  @Permissions('install:write')
  transition(
    @Param('id') id: string,
    @Body()
    body: {
      to?: string;
      note?: string;
      installInitialReading?: unknown;
      installMeterNo?: string;
      installCaliber?: string;
      installCompletedAt?: string;
      feeRequired?: unknown;
      feeReceived?: unknown;
      feeNote?: string;
    },
  ) {
    const to = body?.to;
    if (!to || !STATUSES.has(to)) throw new BadRequestException({ code: 'APPLY_TARGET_INVALID' });
    const iir =
      body?.installInitialReading === undefined || body.installInitialReading === null
        ? undefined
        : Number(body.installInitialReading);
    if (iir !== undefined && (!Number.isFinite(iir) || iir < 0)) {
      throw new BadRequestException({ code: 'INSTALL_READING_INVALID' });
    }
    const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));
    const feeRequired = num(body?.feeRequired);
    const feeReceived = num(body?.feeReceived);
    if ((feeRequired !== undefined && !Number.isFinite(feeRequired)) ||
        (feeReceived !== undefined && !Number.isFinite(feeReceived))) {
      throw new BadRequestException({ code: 'FEE_INVALID' });
    }
    const installInfo =
      to === 'INSTALLING'
        ? {
            meterNo: body?.installMeterNo?.trim() || undefined,
            caliber: body?.installCaliber?.trim() || undefined,
            completedAt: body?.installCompletedAt ? new Date(body.installCompletedAt) : undefined,
            feeRequired,
            feeReceived,
            feeNote: body?.feeNote?.trim() || undefined,
          }
        : undefined;
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.transitionTx(
        tx,
        ctx,
        assertUuid(id, 'id'),
        to as InstallApplyStatus,
        body.note,
        iir,
        installInfo,
      ),
    );
  }

  /** V6 合同扫描件：{scans: dataURL[]} 覆盖写入（≤3 张，与任务佐证同口径）。 */
  @Post(':id/contract-scan')
  @Permissions('install:write')
  contractScan(@Param('id') id: string, @Body() body: { scans?: unknown }) {
    const scans = Array.isArray(body?.scans)
      ? body.scans.filter((s): s is string => typeof s === 'string').slice(0, 3).map((s) => s.slice(0, 900_000))
      : null;
    if (!scans) throw new BadRequestException({ code: 'SCAN_BODY_INVALID' });
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const app = await tx.installApplication.findFirst({
        where: { tenantId: ctx.tenantId, id: assertUuid(id, 'id') },
        select: { id: true },
      });
      if (!app) throw new BadRequestException({ code: 'APPLY_NOT_FOUND' });
      return tx.installApplication.update({
        where: { id: app.id },
        data: { contractScan: scans, updatedBy: ctx.staffId },
      });
    });
  }

  /** Q5/R6 合同编号录入：装表完成后（INSTALLING）、归档立户前可编辑。 */
  @Patch(':id/contract')
  @Permissions('install:write')
  contract(@Param('id') id: string, @Body() body: { contractNo?: unknown }) {
    const contractNo =
      typeof body?.contractNo === 'string' && body.contractNo.trim()
        ? body.contractNo.trim().slice(0, 64)
        : null;
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const app = await tx.installApplication.findFirst({
        where: { tenantId: ctx.tenantId, id: assertUuid(id, 'id') },
        select: { id: true, status: true },
      });
      if (!app) throw new BadRequestException({ code: 'APPLY_NOT_FOUND' });
      if (!['INSTALLING', 'APPROVED'].includes(app.status)) {
        throw new ConflictException({
          code: 'CONTRACT_STAGE_INVALID',
          message: '合同编号在装表完成后、归档立户前录入',
        });
      }
      return tx.installApplication.update({
        where: { id: app.id },
        data: { contractNo, updatedBy: ctx.staffId },
      });
    });
  }

  /** R3：归档确认 —— 立户唯一入口是 onboard(sourceApplyNo)；本端点只做状态核对。 */
  @Post(':id/archive')
  @Permissions('install:write')
  archive(@Param('id') id: string) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.archiveTx(tx, ctx, assertUuid(id, 'id')),
    );
  }
}
