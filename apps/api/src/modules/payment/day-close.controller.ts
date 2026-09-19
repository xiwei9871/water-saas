import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { assertUuid } from '../../common/uuid.js';
import { DayCloseService } from './day-close.service.js';

/** ?take default 50, hard-capped at 200; ?skip default 0. */
const pageArgs = (take?: string, skip?: string) => ({
  take: Math.min(Math.max(parseInt(take ?? '50', 10) || 50, 1), 200),
  skip: Math.max(parseInt(skip ?? '0', 10) || 0, 0),
});

/** closeDate is a plain calendar date 'YYYY-MM-DD' — no time component. */
const assertCloseDate = (v: unknown, field = 'closeDate'): string => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new BadRequestException({ code: 'INVALID_DATE', field });
  }
  const d = new Date(`${v}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
    throw new BadRequestException({ code: 'INVALID_DATE', field });
  }
  return v;
};

interface CloseWireBody {
  closeDate?: string;
}

/**
 * /cashier-day-close — the cashier's signed daily summary (spec §2.6).
 * POST close sweeps the caller's unclosed RECEIVED payments (received
 * on-or-before closeDate) into one POSTED document; a second close for
 * the same (cashier, date) is 409 — the document is never re-issued.
 */
@Controller('cashier-day-close')
export class DayCloseController {
  constructor(
    private readonly svc: DayCloseService,
    private readonly prisma: TenantPrismaService,
  ) {}

  /** GET /cashier-day-close — ?cashierId / ?closeDate / paging. */
  @Get()
  @Permissions('payment:read')
  list(
    @Query('cashierId') cashierId?: string,
    @Query('closeDate') closeDate?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    if (cashierId !== undefined) assertUuid(cashierId, 'cashierId');
    if (closeDate !== undefined) assertCloseDate(closeDate);
    return this.svc.list(currentTenant(), {
      ...pageArgs(take, skip),
      cashierId,
      closeDate,
    });
  }

  /** GET /cashier-day-close/:id — the close + the payments it swept. */
  @Get(':id')
  @Permissions('payment:read')
  get(@Param('id') id: string) {
    return this.svc.getById(currentTenant(), assertUuid(id, 'id'));
  }

  /**
   * POST /cashier-day-close/close {closeDate?} — closeDate is the
   * OPERATING date keyed on received_at (defaults to the server's
   * CURRENT_DATE). The close is NOT idempotency-wrapped on purpose:
   * replay-safe by construction — a duplicate attempt hits
   * DAY_CLOSE_EXISTS (or DAY_CLOSE_EMPTY when nothing is pending), so a
   * retried request can never double-post a drawer.
   */
  @Post('close')
  @Permissions('payment:write')
  close(@Body() body: CloseWireBody) {
    const parsed = {
      closeDate:
        body?.closeDate === undefined || body.closeDate === null
          ? undefined
          : assertCloseDate(body.closeDate),
    };
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.closeTx(tx, ctx, parsed),
    );
  }
}
