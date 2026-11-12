import { BadRequestException, Body, ConflictException, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type { InstallApplyStatus } from '@prisma/client';
import { AnyPermissions, Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { assertUuid } from '../../common/uuid.js';
import { assertUsageCategory } from '../../common/usage-categories.js';
import { InstallService, type CreateApplyBody } from './install.service.js';
import { AllocationService, type ActivateInput, type AllocateInput } from './allocation.service.js';
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
    private readonly alloc: AllocationService,
  ) {}

  @Get()
  @Permissions('install:read')
  list(
    @Query('status') status?: string,
    @Query('take') take?: string,
    // X1-B 兜底拉取：外部系统按更新时间轮询补数。
    @Query('updatedSince') updatedSince?: string,
  ) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.installApplication.findMany({
        where: {
          tenantId: ctx.tenantId,
          ...(status && STATUSES.has(status) ? { status: status as InstallApplyStatus } : {}),
          ...(updatedSince ? { updatedAt: { gte: new Date(updatedSince) } } : {}),
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

  /**
   * POST /install/applications/:id/external-complete — X1 外部工程系统
   * 回推"安装完成"。幂等键=externalOrderNo；缺字段返回缺项清单；
   * 落库并推进至 INSTALLING（待放号）。
   */
  @Post(':id/external-complete')
  @Permissions('install:write')
  externalComplete(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.externalCompleteTx(tx, ctx, assertUuid(id, 'id'), body));
  }

  /** POST .../external-confirm — X1 人工核对确认（修订字段走 PATCH 接口留痕）。 */
  @Post(':id/external-confirm')
  @Permissions('install:write')
  externalConfirm(@Param('id') id: string) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.confirmExternalTx(tx, ctx, assertUuid(id, 'id')));
  }

  /** POST .../revert — X7 撤销回退上一步（reason 必填，留痕 statusHistory）。 */
  @Post(':id/revert')
  @Permissions('install:write')
  revert(@Param('id') id: string, @Body() body: { reason?: string }) {
    if (!body?.reason?.trim()) {
      throw new BadRequestException({ code: 'REVERT_REASON_REQUIRED' });
    }
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.revertTx(tx, ctx, assertUuid(id, 'id'), body.reason!.trim()));
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
  contract(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    // X2 双合同：供用水合同 supplyContractNo（兼容旧 contractNo）+ 施工合同 constructionContractNo。
    const pick = (k: string) =>
      typeof body?.[k] === 'string' && (body[k] as string).trim()
        ? (body[k] as string).trim().slice(0, 64)
        : null;
    const contractNo = pick('contractNo') ?? pick('supplyContractNo');
    const constructionContractNo = pick('constructionContractNo');
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
        data: {
          contractNo,
          supplyContractNo: contractNo,
          ...(body?.constructionContractNo !== undefined ? { constructionContractNo } : {}),
          ...(body?.supplyContractScan !== undefined ? { supplyContractScan: body.supplyContractScan as never } : {}),
          ...(body?.constructionContractScan !== undefined ? { constructionContractScan: body.constructionContractScan as never } : {}),
          updatedBy: ctx.staffId,
        },
      });
    });
  }

  /** B1 放号（1028v2）：工程验收完成的申请批量生成档案号 + 待上号
   *  用水户（PENDING_ASSIGN 预占）+ 立户上号任务指派给指定抄表员。
   *  替代原「归档立户 → 立户向导」流程——归档改由上号成功反写。 */
  @Post(':id/allocate')
  @Permissions('install:write')
  allocate(@Param('id') id: string, @Body() body: AllocateInput) {
    const ctx = currentTenant();
    return this.alloc.allocate(ctx, assertUuid(id, 'id'), body ?? ({} as AllocateInput));
  }

  /**
   * R12 水表安装填报（安装完成后、放号前）：{meters:[{meterNo, caliber?,
   * brand?, serialNo?, maxDial?, initialReading?, installedAt?}]}。
   * 填报完成（installCompletedAt 写入）才允许放号；表号选库存表自动带入。
   */
  @Post(':id/install-meters')
  @AnyPermissions('install:write', 'metering:write')
  installMeters(
    @Param('id') id: string,
    @Body()
    body: {
      meters?: {
        meterNo?: string;
        caliber?: string;
        brand?: string;
        serialNo?: string;
        maxDial?: unknown;
        initialReading?: unknown;
        installedAt?: string;
      }[];
    },
  ) {
    if (!Array.isArray(body?.meters) || body.meters.length === 0) {
      throw new BadRequestException({ code: 'INSTALL_METERS_REQUIRED' });
    }
    const meters = body.meters;
    for (const m of meters) {
      if (!m?.meterNo?.trim()) {
        throw new BadRequestException({ code: 'INSTALL_METER_NO_REQUIRED' });
      }
    }
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const app = await tx.installApplication.findFirst({
        where: { tenantId: ctx.tenantId, id: assertUuid(id, 'id') },
      });
      if (!app) throw new BadRequestException({ code: 'APPLY_NOT_FOUND' });
      if (app.status !== 'INSTALLING' && app.status !== 'APPROVED') {
        throw new ConflictException({
          code: 'INSTALL_STAGE_INVALID',
          message: '水表安装信息须在审批后、放号前填报',
          status: app.status,
        });
      }
      // 选表带入：登记时核对库存表档案——表号存在则校口径一致性，
      // 不在库则按填报要素补建（status=AVAILABLE，上号时挂装）。
      const out: { meterNo: string; caliber?: string | null }[] = [];
      for (const m of meters) {
        const meterNo = m.meterNo!.trim();
        const meter = await tx.meter.findFirst({
          where: { tenantId: ctx.tenantId, meterNo },
        });
        if (meter) {
          if (m.caliber && meter.caliber && m.caliber !== meter.caliber) {
            throw new BadRequestException({
              code: 'INSTALL_METER_CALIBER_MISMATCH',
              meterNo,
            });
          }
        } else {
          await tx.meter.create({
            data: {
              tenantId: ctx.tenantId,
              meterNo,
              serialNo: m.serialNo ?? null,
              brand: m.brand ?? null,
              caliber: m.caliber ?? null,
              maxDial: m.maxDial != null ? Number(m.maxDial) : null,
              status: 'AVAILABLE',
              createdBy: ctx.staffId,
              updatedBy: ctx.staffId,
            },
          });
        }
        out.push({ meterNo, caliber: m.caliber ?? null });
      }
      return tx.installApplication.update({
        where: { id: app.id },
        data: {
          installMeters: out.map((o, i) => ({
            ...o,
            brand: meters[i].brand ?? null,
            serialNo: meters[i].serialNo ?? null,
            maxDial: meters[i].maxDial ?? null,
            initialReading: meters[i].initialReading ?? null,
            installedAt: meters[i].installedAt ?? null,
          })),
          installMeterNo: out[0]?.meterNo ?? app.installMeterNo,
          installCaliber: out[0]?.caliber ?? app.installCaliber,
          installCompletedAt: new Date(),
          // 1111v6-P1-4：B途径登记完成 → WAITING_NUMBER（待放号）。
          status: 'WAITING_NUMBER',
          updatedBy: ctx.staffId,
        },
      });
    });
  }

  /** R1 退号：批量退回「待上号、未绑表」档案号（install:write）。 */
  @Post('/deallocate')
  @Permissions('install:write')
  deallocate(@Body() body: { accountIds?: string[]; reason?: string }) {
    const ctx = currentTenant();
    return this.alloc.deallocate(ctx, {
      accountIds: body?.accountIds ?? [],
      reason: body?.reason,
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
