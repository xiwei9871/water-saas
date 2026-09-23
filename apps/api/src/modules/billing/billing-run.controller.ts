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
import { idemRequestHash } from '../../common/idempotent.js';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { assertUuid } from '../../common/uuid.js';
import { BillingRunService } from './billing-run.service.js';

const RUN_STATUSES = new Set(['DRAFT', 'PROCESSING', 'PARTIAL', 'POSTED', 'FAILED']);

/** ?take default 50, hard-capped at 200; ?skip default 0. */
const pageArgs = (take?: string, skip?: string) => ({
  take: Math.min(Math.max(parseInt(take ?? '50', 10) || 50, 1), 200),
  skip: Math.max(parseInt(skip ?? '0', 10) || 0, 0),
});

/** period is char(6) YYYYMM — same guard as settlement.controller. */
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
 * /billing-runs — the period batch (spec §2.5): POST creates a DRAFT run
 * and synchronously generates its DRAFT bills; /:id/post executes the
 * run synchronously in-request (MVP: no worker — see BillingRunService);
 * /:id/retry re-runs failures; /:id/discard tears down a DRAFT batch.
 */
@Controller('billing-runs')
export class BillingRunController {
  constructor(
    private readonly svc: BillingRunService,
    private readonly prisma: TenantPrismaService,
  ) {}

  /** GET /billing-runs — ?period= / ?status= / paging. */
  @Get()
  @Permissions('billing:read')
  list(
    @Query('period') period?: string,
    @Query('status') status?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    if (period !== undefined) assertPeriod(period);
    if (status !== undefined && !RUN_STATUSES.has(status)) {
      throw new BadRequestException({ code: 'RUN_STATUS_INVALID' });
    }
    return this.svc.list(currentTenant(), {
      ...pageArgs(take, skip),
      period,
      status: status as 'DRAFT' | 'PROCESSING' | 'PARTIAL' | 'POSTED' | 'FAILED' | undefined,
    });
  }

  /** GET /billing-runs/:id — run + its bill list. */
  @Get(':id')
  @Permissions('billing:read')
  get(@Param('id') id: string) {
    return this.svc.getById(currentTenant(), assertUuid(id, 'id'));
  }

  /**
   * POST /billing-runs — {period}: creates the DRAFT run and generates
   * one DRAFT NORMAL bill per FINAL settlement of the period over
   * bounded multi-tx generation (RC1: GENERATING → batches → READY).
   * Unbillable settlements land in failed_settlement_ids, not as errors.
   * Idempotency-Key is claimed/completed inside the orchestrator —
   * this endpoint intentionally does NOT use the single-tx
   * withOptionalIdem wrapper.
   */
  @Post()
  @Permissions('billing:write')
  async create(
    @Body() body: { period?: string },
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!body?.period) {
      throw new BadRequestException({ code: 'BILLING_RUN_FIELDS_REQUIRED', field: 'period' });
    }
    const parsed = { period: assertPeriod(body.period) };
    const ctx = currentTenant();
    const res = await this.svc.create(
      ctx,
      parsed,
      key
        ? {
            key,
            method: 'POST',
            route: req.path,
            requestHash: idemRequestHash(body),
            responseStatus: 201,
          }
        : undefined,
    );
    return res.body;
  }

  /**
   * POST /billing-runs/:id/post — DRAFT|PARTIAL → PROCESSING → execute
   * synchronously (per-bill tx inside). No Idempotency-Key: the pipeline
   * is multi-transaction and self-idempotent — a replay hits the claim
   * guard or re-attempts only remaining DRAFT bills.
   */
  @Post(':id/post')
  @Permissions('billing:write')
  post(@Param('id') id: string, @Req() req: Request) {
    assertUuid(id, 'id');
    return this.svc.execute(currentTenant(), id, ['DRAFT', 'PARTIAL'], req);
  }

  /**
   * POST /billing-runs/:id/retry — same execution path as post, allowed
   * from PARTIAL|FAILED|PROCESSING (PROCESSING = crashed execution; the
   * guarded writes make re-entry the designed rescue).
   */
  @Post(':id/retry')
  @Permissions('billing:write')
  retry(@Param('id') id: string, @Req() req: Request) {
    assertUuid(id, 'id');
    return this.svc.execute(currentTenant(), id, ['PARTIAL', 'FAILED', 'PROCESSING'], req);
  }

  /**
   * POST /billing-runs/:id/discard — DRAFT run only (409 otherwise):
   * deletes the run + its DRAFT bills in one tx so the period can be
   * re-run. POSTED-side rows are never deleted.
   */
  @Post(':id/discard')
  @Permissions('billing:write')
  discard(@Param('id') id: string, @Req() req: Request) {
    assertUuid(id, 'id');
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.discardTx(tx, ctx, id, req),
    );
  }
}
