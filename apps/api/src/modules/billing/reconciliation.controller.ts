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
import { Permissions } from '../../common/permissions.decorator.js';
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
  @Permissions('billing:write')
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
