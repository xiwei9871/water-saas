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
import { assertDecimal } from '../../common/decimal.js';
import { IdempotencyService } from '../../common/idempotency.service.js';
import { withOptionalIdem } from '../../common/idempotent.js';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { assertUuid } from '../../common/uuid.js';
import { BillService } from './bill.service.js';

const BILL_STATUSES = new Set(['DRAFT', 'POSTED', 'PARTIAL_PAID', 'PAID', 'REVERSED']);

/** ?take default 50, hard-capped at 200; ?skip default 0. */
const pageArgs = (take?: string, skip?: string) => ({
  take: Math.min(Math.max(parseInt(take ?? '50', 10) || 50, 1), 200),
  skip: Math.max(parseInt(skip ?? '0', 10) || 0, 0),
});

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

/**
 * /bills — the issued debt rows (spec §2.5). GETs carry bill_item inline
 * on detail; corrections are /:id/reverse （红冲） and /:id/replace —
 * POSTED financial facts are never rewritten in place (spec §1.3).
 */
@Controller('bills')
export class BillController {
  constructor(
    private readonly svc: BillService,
    private readonly prisma: TenantPrismaService,
    private readonly idem: IdempotencyService,
  ) {}

  /**
   * GET /bills — ?period= / ?status= / ?waterAccountId= /
   * ?settleAccountId= / ?billingRunId= / paging.
   */
  @Get()
  @Permissions('billing:read')
  list(
    @Query('period') period?: string,
    @Query('status') status?: string,
    @Query('waterAccountId') waterAccountId?: string,
    @Query('settleAccountId') settleAccountId?: string,
    @Query('billingRunId') billingRunId?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    if (period !== undefined) assertPeriod(period);
    if (status !== undefined && !BILL_STATUSES.has(status)) {
      throw new BadRequestException({ code: 'BILL_STATUS_INVALID' });
    }
    if (waterAccountId !== undefined) assertUuid(waterAccountId, 'waterAccountId');
    if (settleAccountId !== undefined) assertUuid(settleAccountId, 'settleAccountId');
    if (billingRunId !== undefined) assertUuid(billingRunId, 'billingRunId');
    return this.svc.list(currentTenant(), {
      ...pageArgs(take, skip),
      period,
      status: status as 'DRAFT' | 'POSTED' | 'PARTIAL_PAID' | 'PAID' | 'REVERSED' | undefined,
      waterAccountId,
      settleAccountId,
      billingRunId,
    });
  }

  /** GET /bills/:id — bill + items inline. */
  @Get(':id')
  @Permissions('billing:read')
  get(@Param('id') id: string) {
    return this.svc.getById(currentTenant(), assertUuid(id, 'id'));
  }

  /**
   * POST /bills/:id/reverse — 红冲: POSTED|PARTIAL_PAID original →
   * REVERSED + POSTED REVERSAL bill with negated items, one tx. Second
   * reverse → 409; PAID/DRAFT/REVERSAL-kind → 409 BILL_NOT_REVERSABLE.
   */
  @Post(':id/reverse')
  @Permissions('billing:write')
  reverse(
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
      (tx) => this.svc.reverseTx(tx, ctx, id, req),
    );
  }

  /**
   * POST /bills/:id/replace — {usageQty}: reverses the original and
   * creates a POSTED REPLACEMENT recomputed on the original tariff plan
   * with the supplied usage, one tx. usageQty is mandatory — a manual
   * correction must state its quantity.
   */
  @Post(':id/replace')
  @Permissions('billing:write')
  replace(
    @Param('id') id: string,
    @Body() body: { usageQty?: unknown },
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    assertUuid(id, 'id');
    if (body?.usageQty === undefined || body.usageQty === null) {
      throw new BadRequestException({ code: 'BILL_USAGE_QTY_REQUIRED' });
    }
    const parsed = { usageQty: assertDecimal(body.usageQty, 'usageQty', { min: 0 }) };
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body, responseStatus: 201 },
      (tx) => this.svc.replaceTx(tx, ctx, id, parsed, req),
    );
  }
}
