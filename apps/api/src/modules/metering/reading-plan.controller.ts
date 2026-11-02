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
    @Query('planType') planType?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    if (bookId !== undefined) assertUuid(bookId, 'bookId');
    if (waterAccountId !== undefined) assertUuid(waterAccountId, 'waterAccountId');
    if (period !== undefined) assertPeriod(period);
    if (status !== undefined && !PLAN_STATUSES.has(status)) {
      throw new BadRequestException({ code: 'PLAN_STATUS_INVALID' });
    }
    if (planType !== undefined && !['REGULAR', 'SUPPLEMENT'].includes(planType)) {
      throw new BadRequestException({ code: 'PLAN_TYPE_INVALID' });
    }
    return this.svc.list(currentTenant(), {
      ...pageArgs(take, skip),
      bookId,
      period,
      status: status as 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'CLOSED' | undefined,
      waterAccountId,
      planType,
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

  /**
   * POST /reading-plans/supplement — 20261026 追加抄表独立功能：
   * {waterAccountId, period, planDate?, readerId, remark?} → 单户
   * SUPPLEMENT 计划 + SUPPLEMENT_READING 任务直接指派给抄表员。
   * 业务键幂等：同户同期在途追加计划复用；Idempotency-Key 同样支持。
   */
  @Post('supplement')
  @Permissions('metering:write')
  supplement(
    @Body()
    body: {
      waterAccountId?: string;
      period?: string;
      planDate?: unknown;
      readerId?: string;
      remark?: string;
    },
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!body?.waterAccountId || !body?.period || !body?.readerId) {
      throw new BadRequestException({ code: 'SUPPLEMENT_FIELDS_REQUIRED' });
    }
    const parsed = {
      waterAccountId: assertUuid(body.waterAccountId, 'waterAccountId'),
      period: assertPeriod(body.period),
      planDate: assertOptionalDate(body.planDate, 'planDate'),
      readerId: assertUuid(body.readerId, 'readerId'),
      remark: typeof body.remark === 'string' ? body.remark.slice(0, 500) : undefined,
    };
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body, responseStatus: 201 },
      (tx) => this.svc.supplementTx(tx, ctx, parsed),
    );
  }

  /**
   * POST /reading-plans/auto-generate — R5 手动兜底入口：为「明日」对应的
   * 抄表段生成计划（与 18–24 点定时任务同一逻辑，幂等）。
   */
  @Post('auto-generate')
  @Permissions('metering:write')
  autoGenerate() {
    return this.svc.autoGenerateForDate(currentTenant(), new Date());
  }

  /**
   * POST /reading-plans/redistribute — R6 超段均分：
   * {zoneNo, period, sourceSegs[], targetSegs[]}，把源段未抄任务
   * 均分到 ≤ 总段数−N 的目标段。
   */
  @Post('redistribute')
  @Permissions('metering:write')
  redistribute(
    @Body()
    body: {
      zoneNo?: string;
      period?: string;
      sourceSegs?: string[];
      targetSegs?: string[];
    },
  ) {
    if (!body?.zoneNo || !body?.period || !body?.sourceSegs?.length || !body?.targetSegs?.length) {
      throw new BadRequestException({ code: 'REDISTRIBUTE_FIELDS_REQUIRED' });
    }
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.redistributeTx(tx, ctx, {
        zoneNo: body.zoneNo!,
        period: assertPeriod(body.period),
        sourceSegs: body.sourceSegs!,
        targetSegs: body.targetSegs!,
      }),
    );
  }

  /**
   * POST /reading-plans/:id/reorder — R15 人工调序：
   * {orderedItemIds:[...]} 全量计划项新顺序；写回用户级 routeKey。
   */
  @Post(':id/reorder')
  @Permissions('metering:write')
  reorder(
    @Param('id') id: string,
    @Body() body: { orderedItemIds?: string[] },
    @Req() req: Request,
  ) {
    assertUuid(id, 'id');
    if (!Array.isArray(body?.orderedItemIds) || body.orderedItemIds.length === 0) {
      throw new BadRequestException({ code: 'REORDER_ITEMS_REQUIRED' });
    }
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.reorderTx(tx, ctx, id, body.orderedItemIds!, req),
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
