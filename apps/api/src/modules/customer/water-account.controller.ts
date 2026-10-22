import {
  BadRequestException,
  Body,
  ConflictException,
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
import { assertDecimal, assertOptionalDate } from '../../common/decimal.js';
import { IdempotencyService } from '../../common/idempotency.service.js';
import { withOptionalIdem } from '../../common/idempotent.js';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { assertUuid } from '../../common/uuid.js';

import { CloseAccountUseCase } from './use-cases/close-account.use-case.js';
import {
  WaterAccountService,
  type EventBody,
  type TransferBody,
  type WaterAccountBody,
  type FieldContactBody,
  type WaterAccountPatchBody,
} from './water-account.service.js';

import { parseOnboardWire, type OnboardWireBody } from './onboard-wire.js';
import { TaskService } from '../task/task.service.js';

const ACCOUNT_STATUSES = new Set(['NORMAL', 'SUSPENDED', 'CLOSED']);

const pageArgs = (take?: string, skip?: string) => ({
  take: Math.min(Math.max(parseInt(take ?? '50', 10) || 50, 1), 200),
  skip: Math.max(parseInt(skip ?? '0', 10) || 0, 0),
});

interface EventWireBody {
  effectiveDate?: unknown;
  remark?: string;
}

const parseEventBody = (body: EventWireBody | undefined): EventBody => ({
  effectiveDate: assertOptionalDate(body?.effectiveDate, 'effectiveDate'),
  remark: body?.remark,
});

@Controller('water-accounts')
export class WaterAccountController {
  constructor(
    private readonly svc: WaterAccountService,
    private readonly closeAccount: CloseAccountUseCase,
    private readonly prisma: TenantPrismaService,
    private readonly idem: IdempotencyService,
    private readonly tasks: TaskService,
  ) {}

  /**
   * GET /water-accounts — ?customerId= / ?settleAccountId= / ?status= /
   * ?accountNo= / ?q= (RC1-4 unified: 户号/客户名/客户号/电话/地址/在装表号).
   * Rows carry currentMeterNo (ACTIVE install, installedAt desc, id desc).
   */
  @Get()
  @Permissions('customer:read')
  list(
    @Query('customerId') customerId?: string,
    @Query('settleAccountId') settleAccountId?: string,
    @Query('status') status?: string,
    @Query('accountNo') accountNo?: string,
    @Query('q') q?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    if (customerId !== undefined) assertUuid(customerId, 'customerId');
    if (settleAccountId !== undefined) assertUuid(settleAccountId, 'settleAccountId');
    if (status !== undefined && !ACCOUNT_STATUSES.has(status)) {
      throw new BadRequestException({ code: 'ACCOUNT_STATUS_INVALID' });
    }
    return this.svc.list(currentTenant(), {
      ...pageArgs(take, skip),
      customerId,
      settleAccountId,
      status: status as 'NORMAL' | 'SUSPENDED' | 'CLOSED' | undefined,
      accountNo,
      q,
    });
  }

  /** Category suggestions for onboarding; no billing write/read privilege required. */
  @Get('usage-categories')
  @Permissions('customer:read')
  usageCategories() {
    return this.svc.usageCategories(currentTenant());
  }

  @Get(':id')
  @Permissions('customer:read')
  get(@Param('id') id: string) {
    return this.svc.getById(currentTenant(), assertUuid(id, 'id'));
  }

  /**
   * GET /water-accounts/:id/360 — E8 core summary (customer:read domain
   * only; cross-domain cards load through their own permissioned APIs).
   */
  @Get(':id/360')
  @Permissions('customer:read')
  summary(@Param('id') id: string) {
    return this.svc.summary360(currentTenant(), assertUuid(id, 'id'));
  }

  /** GET /water-accounts/:id/events — account lifecycle timeline. */
  @Get(':id/events')
  @Permissions('customer:read')
  events(
    @Param('id') id: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.svc.listEvents(
      currentTenant(),
      assertUuid(id, 'id'),
      pageArgs(take, skip),
    );
  }

  /**
   * POST /water-accounts — standalone open against existing customer +
   * settle_account; account_no from sys_sequence unless supplied.
   */
  @Post()
  @Permissions('customer:write')
  create(
    @Body() body: WaterAccountBody & { openedAt?: unknown },
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!body?.customerId || !body?.settleAccountId || !body?.usageCategory || !body?.addr) {
      throw new BadRequestException({ code: 'WATER_ACCOUNT_FIELDS_REQUIRED' });
    }
    const parsed: WaterAccountBody = {
      accountNo: body.accountNo,
      customerId: assertUuid(body.customerId, 'customerId'),
      settleAccountId: assertUuid(body.settleAccountId, 'settleAccountId'),
      usageCategory: body.usageCategory,
      addr: body.addr,
      openedAt: assertOptionalDate(body.openedAt, 'openedAt'),
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

  /**
   * POST /water-accounts/onboard — 立户向导: one transaction builds
   * customer + settle_account + water_account + meter + ACTIVE installation.
   * `customerId`/`settleAccountId`/`meterId` link existing rows instead of
   * creating; omitting settle_account entirely defaults it to the customer's
   * own name/phone. Idempotency-Key supported — a retried wizard must never
   * double-open an account.
   */
  @Post('onboard')
  @Permissions('customer:write')
  onboard(
    @Body() body: OnboardWireBody,
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    // ---- shape validation (deterministic, safe outside the idem fn) ----
    const parsed = parseOnboardWire(body);
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body, responseStatus: 201 },
      async (tx) => {
        const result = await this.svc.onboardTx(tx, ctx, parsed);
        // 报装纳入（2.2）：向导带来源单号时，同事务办结该申请——
        // 正向回写户/结算户/表号 + INSTALL_REVIEW 任务自动完成。
        // 与 archive 同链路：挂接向导不再要求操作员回申请页补归档动作。
        if (parsed.sourceApplyNo) {
          const app = await tx.installApplication.findFirst({
            where: { tenantId: ctx.tenantId, applyNo: parsed.sourceApplyNo },
            select: { id: true, status: true, applyNo: true },
          });
          if (!app) throw new BadRequestException({ code: 'SOURCE_APPLY_NOT_FOUND' });
          if (['COMPLETED', 'REJECTED', 'CANCELLED'].includes(app.status)) {
            throw new ConflictException({ code: 'SOURCE_APPLY_CLOSED', status: app.status });
          }
          await tx.installApplication.update({
            where: { tenantId_id: { tenantId: ctx.tenantId, id: app.id } },
            data: {
              status: 'COMPLETED',
              waterAccountId: result.waterAccount.id,
              settleAccountId: result.settleAccount.id,
              meterNo: result.meter.meterNo,
              updatedBy: ctx.staffId,
            },
          });
          await this.tasks.autoCompleteByBiz(
            tx,
            ctx,
            'INSTALL_REVIEW',
            'INSTALL_APPLICATION',
            app.id,
            '立户向导带入归档完成',
          );
          // V7 工程费闭环：应收>实收差额 → 催缴任务（与归档路径同口径）。
          const fees = await tx.installApplication.findFirst({
            where: { tenantId: ctx.tenantId, id: app.id },
            select: { applyNo: true, feeRequired: true, feeReceived: true },
          });
          if (fees?.feeRequired) {
            const deficit = fees.feeRequired.minus(fees.feeReceived ?? 0);
            if (deficit.gt(0)) {
              await this.tasks.createTask(tx, ctx, {
                type: 'COLLECTION',
                title: `工程费补收：${fees.applyNo} 差额 ¥${deficit.toFixed(2)}`,
                bizType: 'settleAccount',
                bizId: result.settleAccount.id,
                bizLabel: result.settleAccount.settleNo,
                reason: `报装 ${fees.applyNo} 工程费应收 ¥${fees.feeRequired} 实收 ¥${fees.feeReceived ?? 0}，差额随户挂账`,
                context: {
                  settleNo: result.settleAccount.settleNo,
                  arrearsCent: deficit.mul(100).toFixed(0),
                  overdueDays: 0,
                  feeApplyNo: fees.applyNo,
                  feeRequired: fees.feeRequired.toString(),
                  feeReceived: fees.feeReceived?.toString() ?? '0',
                },
                orgUnitId: null,
              });
            }
          }
        }
        return result;
      },
    );
  }

  /** GET /water-accounts/:id/household-profiles — declaration history. */
  @Get(':id/household-profiles')
  @Permissions('customer:read')
  householdProfiles(@Param('id') id: string) {
    return this.svc.listHouseholdProfiles(
      currentTenant(),
      assertUuid(id, 'id'),
    );
  }

  /**
   * POST /water-accounts/:id/household-profiles — append an effective-dated
   * household declaration (一户多人口申报). Same-period duplicates → 409.
   */
  @Post(':id/household-profiles')
  @Permissions('customer:write')
  createHouseholdProfile(
    @Param('id') id: string,
    @Body() body: { householdSize?: unknown; effectiveFromPeriod?: unknown },
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    assertUuid(id, 'id');
    const parsed = {
      householdSize:
        body?.householdSize === undefined ? undefined : Number(body.householdSize),
      effectiveFromPeriod:
        typeof body?.effectiveFromPeriod === 'string'
          ? body.effectiveFromPeriod
          : undefined,
    };
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body, responseStatus: 201 },
      (tx) => this.svc.createHouseholdProfileTx(tx, ctx, id, parsed),
    );
  }

  /**
   * PATCH /water-accounts/:id/household-profiles/:profileId — correct a
   * declared value. Settlements already generated keep their snapshot.
   */
  @Patch(':id/household-profiles/:profileId')
  @Permissions('customer:write')
  patchHouseholdProfile(
    @Param('id') id: string,
    @Param('profileId') profileId: string,
    @Body() body: { householdSize?: unknown },
    @Req() req: Request,
  ) {
    assertUuid(id, 'id');
    assertUuid(profileId, 'profileId');
    const parsed = {
      householdSize:
        body?.householdSize === undefined ? undefined : Number(body.householdSize),
    };
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.patchHouseholdProfileTx(tx, ctx, id, profileId, parsed, req),
    );
  }

  /**
   * PATCH /water-accounts/:id/field-contact — 抄表 APP 现场更正
   * {addr?, phone?, locationRemark?}。metering:write 或 customer:write 可用。
   */
  @Patch(':id/field-contact')
  @Permissions('metering:write', 'customer:write')
  fieldContact(
    @Param('id') id: string,
    @Body() body: FieldContactBody,
    @Req() req: Request,
  ) {
    assertUuid(id, 'id');
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.fieldContactTx(tx, ctx, id, body ?? {}, req),
    );
  }

  /** PATCH /water-accounts/:id — usageCategory/addr only. */
  @Patch(':id')
  @Permissions('customer:write')
  update(
    @Param('id') id: string,
    @Body() body: WaterAccountPatchBody,
    @Req() req: Request,
  ) {
    assertUuid(id, 'id');
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.updateTx(tx, ctx, id, body, req),
    );
  }

  /** POST /water-accounts/:id/transfer — 过户 to another customer/settle_account. */
  @Post(':id/transfer')
  @Permissions('customer:write')
  transfer(
    @Param('id') id: string,
    @Body() body: TransferBody & { effectiveDate?: unknown },
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    assertUuid(id, 'id');
    if (!body?.customerId && !body?.settleAccountId) {
      throw new BadRequestException({ code: 'TRANSFER_TARGET_REQUIRED' });
    }
    const parsed: TransferBody = {
      customerId: body.customerId ? assertUuid(body.customerId, 'customerId') : undefined,
      settleAccountId: body.settleAccountId
        ? assertUuid(body.settleAccountId, 'settleAccountId')
        : undefined,
      effectiveDate: assertOptionalDate(body.effectiveDate, 'effectiveDate'),
      remark: body.remark,
    };
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body, responseStatus: 201 },
      (tx) => this.svc.transferTx(tx, ctx, id, parsed, req),
    );
  }

  /** POST /water-accounts/:id/suspend — NORMAL → SUSPENDED + event. */
  @Post(':id/suspend')
  @Permissions('customer:write')
  suspend(
    @Param('id') id: string,
    @Body() body: EventWireBody,
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    assertUuid(id, 'id');
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body, responseStatus: 201 },
      (tx) => this.svc.suspendTx(tx, ctx, id, parseEventBody(body), req),
    );
  }

  /** POST /water-accounts/:id/resume — SUSPENDED → NORMAL + event. */
  @Post(':id/resume')
  @Permissions('customer:write')
  resume(
    @Param('id') id: string,
    @Body() body: EventWireBody,
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    assertUuid(id, 'id');
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body, responseStatus: 201 },
      (tx) => this.svc.resumeTx(tx, ctx, id, parseEventBody(body), req),
    );
  }

  /**
   * POST /water-accounts/:id/close — 销户 via CloseAccountUseCase:
   * FinancePort.getOutstanding must be 0 before the CLOSED transition +
   * CLOSE event commit.
   */
  @Post(':id/close')
  @Permissions('customer:write')
  close(
    @Param('id') id: string,
    @Body() body: EventWireBody,
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    assertUuid(id, 'id');
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body, responseStatus: 201 },
      (tx) => this.closeAccount.execute(tx, ctx, id, parseEventBody(body), req),
    );
  }
}
