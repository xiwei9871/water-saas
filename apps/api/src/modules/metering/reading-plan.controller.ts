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
import { assertOptionalDate } from '../../common/decimal.js';
import { IdempotencyService } from '../../common/idempotency.service.js';
import { withOptionalIdem } from '../../common/idempotent.js';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { assertUuid } from '../../common/uuid.js';
import { ReadingPlanService, type GenerateBody } from './reading-plan.service.js';

const PLAN_STATUSES = new Set(['OPEN', 'IN_PROGRESS', 'DONE', 'CLOSED']);
const PLAN_ITEM_STATUSES = new Set(['PENDING', 'READ', 'NO_READ', 'SKIPPED']);

/** ?take default 50, hard-capped at 200; ?skip default 0. */
const pageArgs = (take?: string, skip?: string) => ({
  take: Math.min(Math.max(parseInt(take ?? '50', 10) || 50, 1), 200),
  skip: Math.max(parseInt(skip ?? '0', 10) || 0, 0),
});

/** period is char(6) YYYYMM — reject malformed values before Prisma sees them. */
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

interface GenerateWireBody {
  bookId?: string;
  period?: string;
  planDate?: unknown;
  readerId?: string;
}

@Controller('reading-plans')
export class ReadingPlanController {
  constructor(
    private readonly svc: ReadingPlanService,
    private readonly prisma: TenantPrismaService,
    private readonly idem: IdempotencyService,
  ) {}

  /** GET /reading-plans — ?bookId= / ?period= / ?status= / paging. */
  @Get()
  @Permissions('metering:read')
  list(
    @Query('bookId') bookId?: string,
    @Query('period') period?: string,
    @Query('status') status?: string,
    @Query('waterAccountId') waterAccountId?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    if (bookId !== undefined) assertUuid(bookId, 'bookId');
    if (waterAccountId !== undefined) assertUuid(waterAccountId, 'waterAccountId');
    if (period !== undefined) assertPeriod(period);
    if (status !== undefined && !PLAN_STATUSES.has(status)) {
      throw new BadRequestException({ code: 'PLAN_STATUS_INVALID' });
    }
    return this.svc.list(currentTenant(), {
      ...pageArgs(take, skip),
      bookId,
      period,
      status: status as 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'CLOSED' | undefined,
      waterAccountId,
    });
  }

  /** GET /reading-plans/:id — plan + snapshot items (seq_no ordered). */
  @Get(':id')
  @Permissions('metering:read')
  get(@Param('id') id: string) {
    return this.svc.getById(currentTenant(), assertUuid(id, 'id'));
  }

  /** GET /reading-plans/:id/items — paginated, ?status= filter. */
  @Get(':id/items')
  @Permissions('metering:read')
  items(
    @Param('id') id: string,
    @Query('status') status?: string,
    @Query('waterAccountId') waterAccountId?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    assertUuid(id, 'id');
    if (status !== undefined && !PLAN_ITEM_STATUSES.has(status)) {
      throw new BadRequestException({ code: 'PLAN_ITEM_STATUS_INVALID' });
    }
    return this.svc.items(currentTenant(), id, {
      ...pageArgs(take, skip),
      status: status as 'PENDING' | 'READ' | 'NO_READ' | 'SKIPPED' | undefined,
    });
  }

  /** GET /reading-plans/:id/progress — per-status counts + total. */
  @Get(':id/progress')
  @Permissions('metering:read')
  progress(@Param('id') id: string) {
    return this.svc.progress(currentTenant(), assertUuid(id, 'id'));
  }

  /**
   * POST /reading-plans/generate — {bookId, period, planDate?, readerId?}:
   * creates the plan and snapshots the CURRENT book_meter rows into
   * reading_plan_item in one transaction. Same book+period with a live
   * (non-CLOSED) plan → 409; empty book → 400. Idempotency-Key supported —
   * a retried generate must not double-plan the period.
   */
  @Post('generate')
  @Permissions('metering:write')
  generate(
    @Body() body: GenerateWireBody,
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!body?.bookId || !body?.period) {
      throw new BadRequestException({ code: 'GENERATE_FIELDS_REQUIRED' });
    }
    const parsed: GenerateBody = {
      bookId: assertUuid(body.bookId, 'bookId'),
      period: assertPeriod(body.period),
      planDate: assertOptionalDate(body.planDate, 'planDate'),
      readerId: body.readerId ? assertUuid(body.readerId, 'readerId') : undefined,
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

  /** POST /reading-plans/:id/start — OPEN → IN_PROGRESS. */
  @Post(':id/start')
  @Permissions('metering:write')
  start(
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
      (tx) => this.svc.startTx(tx, ctx, id, req),
    );
  }

  /**
   * POST /reading-plans/:id/cancel — OPEN|IN_PROGRESS → CLOSED (schema has
   * no CANCELLED status; CLOSED is the terminal-inactive state). Item rows
   * are never touched — already-READ items stay READ as history.
   */
  @Post(':id/cancel')
  @Permissions('metering:write')
  cancel(
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
      (tx) => this.svc.cancelTx(tx, ctx, id, req),
    );
  }
}
