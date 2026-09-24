import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { assertDecimal } from '../../common/decimal.js';
import { IdempotencyService } from '../../common/idempotency.service.js';
import { withOptionalIdem } from '../../common/idempotent.js';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { assertUuid } from '../../common/uuid.js';
import {
  SettlementService,
  type SettlementBatchBody,
  type SettlementCreateBody,
  type UsageOverride,
} from './settlement.service.js';

const SETTLEMENT_STATUSES = new Set(['DRAFT', 'FINAL']);

/** ?take default 50, hard-capped at 200; ?skip default 0. */
const pageArgs = (take?: string, skip?: string) => ({
  take: Math.min(Math.max(parseInt(take ?? '50', 10) || 50, 1), 200),
  skip: Math.max(parseInt(skip ?? '0', 10) || 0, 0),
});

/** period is char(6) YYYYMM — same guard as reading-plan.controller. */
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

interface OverrideWireBody {
  installationId?: string;
  usageQty?: unknown;
}

interface BatchWireBody {
  period?: string;
  bookId?: string;
  orgUnitId?: string;
  estimateReason?: string;
}

const parseBatchBody = (body: BatchWireBody | undefined): SettlementBatchBody => {
  if (!body?.period) {
    throw new BadRequestException({ code: 'SETTLEMENT_FIELDS_REQUIRED' });
  }
  if (
    body.estimateReason !== undefined &&
    body.estimateReason !== null &&
    typeof body.estimateReason !== 'string'
  ) {
    throw new BadRequestException({ code: 'ESTIMATE_REASON_INVALID' });
  }
  return {
    period: assertPeriod(body.period),
    bookId: body.bookId === undefined ? undefined : assertUuid(body.bookId, 'bookId'),
    orgUnitId:
      body.orgUnitId === undefined ? undefined : assertUuid(body.orgUnitId, 'orgUnitId'),
    estimateReason:
      typeof body.estimateReason === 'string'
        ? body.estimateReason.trim() || null
        : null,
  };
};

interface SettlementWireBody {
  waterAccountId?: string;
  period?: string;
  estimateReason?: string;
  usageQty?: unknown;
  overrides?: OverrideWireBody[];
}

const parseOverrides = (raw: OverrideWireBody[] | undefined): UsageOverride[] | undefined => {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new BadRequestException({ code: 'OVERRIDES_INVALID' });
  }
  return raw.map((o, i) => {
    if (!o?.installationId || o.usageQty === undefined || o.usageQty === null) {
      throw new BadRequestException({ code: 'OVERRIDE_FIELDS_REQUIRED', index: i });
    }
    return {
      installationId: assertUuid(o.installationId, `overrides[${i}].installationId`),
      usageQty: assertDecimal(o.usageQty, `overrides[${i}].usageQty`, { min: 0 }),
    };
  });
};

/**
 * /consumption-settlements — settlement generation + finalize (spec §2.3).
 * GETs carry components inline so the client never needs a second hop.
 */
@Controller('consumption-settlements')
export class SettlementController {
  constructor(
    private readonly svc: SettlementService,
    private readonly prisma: TenantPrismaService,
    private readonly idem: IdempotencyService,
  ) {}

  /** GET /consumption-settlements — ?waterAccountId / ?period / ?status / ?isEstimated / paging. */
  @Get()
  @Permissions('metering:read')
  list(
    @Query('waterAccountId') waterAccountId?: string,
    @Query('period') period?: string,
    @Query('status') status?: string,
    @Query('isEstimated') isEstimated?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    if (waterAccountId !== undefined) assertUuid(waterAccountId, 'waterAccountId');
    if (period !== undefined) assertPeriod(period);
    if (status !== undefined && !SETTLEMENT_STATUSES.has(status)) {
      throw new BadRequestException({ code: 'SETTLEMENT_STATUS_INVALID' });
    }
    if (isEstimated !== undefined && !['true', 'false'].includes(isEstimated)) {
      throw new BadRequestException({ code: 'IS_ESTIMATED_INVALID' });
    }
    return this.svc.list(currentTenant(), {
      ...pageArgs(take, skip),
      waterAccountId,
      period,
      status: status as 'DRAFT' | 'FINAL' | undefined,
      isEstimated: isEstimated === undefined ? undefined : isEstimated === 'true',
    });
  }

  /** GET /consumption-settlements/:id — header + components + streak. */
  @Get(':id')
  @Permissions('metering:read')
  get(@Param('id') id: string) {
    return this.svc.getById(currentTenant(), assertUuid(id, 'id'));
  }

  /**
   * POST /consumption-settlements — {waterAccountId, period, estimateReason?,
   * usageQty?, overrides?}: generates the DRAFT settlement + one component
   * per contributing installation (see SettlementService for the source
   * rules). usageQty is the single-estimate shorthand; overrides[] targets
   * specific installations. estimateReason is mandatory whenever any
   * component lands ESTIMATE.
   */
  @Post()
  @Permissions('metering:write')
  create(
    @Body() body: SettlementWireBody,
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!body?.waterAccountId || !body?.period) {
      throw new BadRequestException({ code: 'SETTLEMENT_FIELDS_REQUIRED' });
    }
    if (
      body.estimateReason !== undefined &&
      body.estimateReason !== null &&
      typeof body.estimateReason !== 'string'
    ) {
      throw new BadRequestException({ code: 'ESTIMATE_REASON_INVALID' });
    }
    const parsed: SettlementCreateBody = {
      waterAccountId: assertUuid(body.waterAccountId, 'waterAccountId'),
      period: assertPeriod(body.period),
      estimateReason:
        typeof body.estimateReason === 'string' ? body.estimateReason.trim() || null : null,
      usageQty:
        body.usageQty === undefined || body.usageQty === null
          ? undefined
          : assertDecimal(body.usageQty, 'usageQty', { min: 0 }),
      overrides: parseOverrides(body.overrides),
    };
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body, responseStatus: 201 },
      (tx) => this.svc.generateTx(tx, ctx, parsed),
    );
  }

  /**
   * POST /consumption-settlements/batch/preview — RC1-3 (F11): classifies
   * every candidate account for the period (optional bookId/orgUnitId
   * narrowing) as READY / READY_ESTIMATED / SKIPPED_EXISTS / FAILED(code)
   * by simulating the real generation path. Never writes.
   */
  @Post('batch/preview')
  @HttpCode(200)
  @Permissions('metering:write')
  batchPreview(@Body() body: BatchWireBody) {
    return this.svc.batchPreview(currentTenant(), parseBatchBody(body));
  }

  /**
   * POST /consumption-settlements/batch — RC1-3 (F11): server-side batch
   * generation, one independent transaction per account in accountNo
   * order. A failure never aborts the batch; a rerun is idempotent
   * (existing settlements report SKIPPED_EXISTS).
   */
  @Post('batch')
  @Permissions('metering:write')
  batchExecute(@Body() body: BatchWireBody) {
    return this.svc.batchExecute(currentTenant(), parseBatchBody(body));
  }

  /**
   * POST /consumption-settlements/:id/finalize — DRAFT → FINAL guarded
   * transition (409 when already FINAL — FINAL rows never flip back;
   * corrections go through reconciliation).
   */
  @Post(':id/finalize')
  @Permissions('metering:write')
  finalize(
    @Param('id') id: string,
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    assertUuid(id, 'id');
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body: {}, responseStatus: 201 },
      (tx) => this.svc.finalizeTx(tx, ctx, id, req),
    );
  }
}
