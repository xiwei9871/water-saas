import {
  BadRequestException,
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
import { IdempotencyService } from '../../common/idempotency.service.js';
import { withOptionalIdem } from '../../common/idempotent.js';
import { AnyPermissions, Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { assertUuid } from '../../common/uuid.js';
import { ReconciliationService } from './reconciliation.service.js';

const RECON_STATUSES = new Set(['DRAFT', 'ABSORBED', 'APPLIED', 'MANUAL_REVIEW']);

/** ?take default 50, hard-capped at 200; ?skip default 0. */
const pageArgs = (take?: string, skip?: string) => ({
  take: Math.min(Math.max(parseInt(take ?? '50', 10) || 50, 1), 200),
  skip: Math.max(parseInt(skip ?? '0', 10) || 0, 0),
});

/** period is char(6) YYYYMM — same guard as bill.controller. */
const assertPeriod = (v: unknown, field = 'period'): string => {
  if (typeof v !== 'string' || !/^\d{6}$/.test(v)) {
    throw new BadRequestException({ code: 'PERIOD_INVALID', field });
  }
  const month = parseInt(v.slice(4), 10);
  if (month < 1 || month > 12) {
    throw new BadRequestException({ code: 'PERIOD_INVALID', field });
  }
  return v;
};

interface ReconciliationWireBody {
  waterAccountId?: string;
  actualReadingId?: string;
}

/**
 * /reconciliations — anchor-based calibration between two trusted
 * readings (spec §2.4). POST resolves actual+anchor+span and lands
 * ABSORBED (catch-up usage into the current DRAFT settlement), APPLIED
 * (repriced ADJUSTMENT bill) or MANUAL_REVIEW (meter swap / dial
 * regression) in one tx; rows are append-only audit facts.
 */
@Controller('reconciliations')
export class ReconciliationController {
  constructor(
    private readonly svc: ReconciliationService,
    private readonly prisma: TenantPrismaService,
    private readonly idem: IdempotencyService,
  ) {}

  /**
   * GET /reconciliations — ?waterAccountId / ?status / ?period (a
   * "covers" filter: rows whose [fromPeriod, toPeriod] span it) / paging.
   */
  @Get()
  @Permissions('billing:read')
  list(
    @Query('waterAccountId') waterAccountId?: string,
    @Query('status') status?: string,
    @Query('period') period?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    if (waterAccountId !== undefined) assertUuid(waterAccountId, 'waterAccountId');
    if (status !== undefined && !RECON_STATUSES.has(status)) {
      throw new BadRequestException({ code: 'RECONCILIATION_STATUS_INVALID' });
    }
    if (period !== undefined) assertPeriod(period);
    return this.svc.list(currentTenant(), {
      ...pageArgs(take, skip),
      waterAccountId,
      status: status as 'DRAFT' | 'ABSORBED' | 'APPLIED' | 'MANUAL_REVIEW' | undefined,
      period,
    });
  }

  /**
   * GET /reconciliations/account-lookup?q= — 户号/客户名搜索器
   * (Round-2 报告 §8)。挂在业务权限上而非 customer:read —— 有补差权限
   * 的角色（billing / metering:qc）都可用它选户，返回仅 id+户号+客户名。
   * Literal route MUST precede :id.
   */
  @Get('account-lookup')
  @AnyPermissions(
    'billing:read',
    'billing:write',
    'metering:qc',
    'metering:write',
    'metering:read',
    'payment:read',
    'payment:write',
    'customer:read',
    'customer:write',
    'prepayment:reverse',
  )
  accountLookup(@Query('q') q?: string, @Query('includeClosed') ic?: string) {
    // 筛选场景须能选到已销户的历史户 —— includeClosed=1 放行；业务
    // 办理场景保持默认（不给已销户开新单）。
    return this.svc.accountLookup(
      currentTenant(),
      q?.trim() || undefined,
      ic === '1' || ic === 'true',
    );
  }

  /**
   * GET /reconciliations/settle-account-lookup?q= — 结算户号/名称搜索器
   * (10/8 报告 §1-2)。同 account-lookup 的业务权限与 scope 语义。
   * Literal route MUST precede :id.
   */
  @Get('settle-account-lookup')
  @AnyPermissions(
    'billing:read',
    'billing:write',
    'metering:qc',
    'metering:write',
    'metering:read',
    'payment:read',
    'payment:write',
  )
  settleAccountLookup(@Query('q') q?: string, @Query('includeClosed') ic?: string) {
    return this.svc.settleAccountLookup(
      currentTenant(),
      q?.trim() || undefined,
      ic === '1' || ic === 'true',
    );
  }

  /**
   * GET /reconciliations/drift-hints — 已结算读数被修正但未补差
   * (Round-2 报告 §7 补差需求闭环)。录入员/复核员/账务都能看到待办。
   */
  @Get('drift-hints')
  @AnyPermissions(
    'billing:read',
    'billing:write',
    'metering:qc',
    'metering:write',
  )
  driftHints() {
    return this.svc.driftHints(currentTenant());
  }

  /** GET /reconciliations/:id — the reconciliation row. */
  @Get(':id')
  @Permissions('billing:read')
  get(@Param('id') id: string) {
    return this.svc.getById(currentTenant(), assertUuid(id, 'id'));
  }

  /**
   * POST /reconciliations — {waterAccountId, actualReadingId?}: when
   * actualReadingId is omitted the account's latest trusted reading is
   * used. One actual reconciles exactly once — a repeat → 409
   * RECONCILIATION_EXISTS (UNIQUE(tenant_id, actual_reading_id)).
   */
  @Post()
  @AnyPermissions('billing:write', 'metering:qc')
  create(
    @Body() body: ReconciliationWireBody,
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!body?.waterAccountId) {
      throw new BadRequestException({ code: 'RECONCILIATION_FIELDS_REQUIRED' });
    }
    const parsed = {
      waterAccountId: assertUuid(body.waterAccountId, 'waterAccountId'),
      actualReadingId:
        body.actualReadingId === undefined || body.actualReadingId === null
          ? undefined
          : assertUuid(body.actualReadingId, 'actualReadingId'),
    };
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body, responseStatus: 201 },
      (tx) => this.svc.createTx(tx, ctx, parsed, req),
    );
  }
}
