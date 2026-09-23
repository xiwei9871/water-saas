import {
  BadRequestException,
  Controller,
  Get,
  Query,
} from '@nestjs/common';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { assertUuid } from '../../common/uuid.js';
import { ReportService } from './report.service.js';

/** period is char(6) YYYYMM — same guard as billing/metering controllers. */
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

/** report date is a plain calendar date 'YYYY-MM-DD' — no time component. */
const assertDate = (v: unknown, field = 'date'): string => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new BadRequestException({ code: 'INVALID_DATE', field });
  }
  const d = new Date(`${v}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
    throw new BadRequestException({ code: 'INVALID_DATE', field });
  }
  return v;
};

const required = (v: unknown, field: string): string => {
  if (v === undefined || v === null || v === '') {
    throw new BadRequestException({ code: 'REPORT_PARAM_REQUIRED', field });
  }
  return v as string;
};

/**
 * /reports — the read-only projection layer (spec §4, acceptance
 * "报表四张可对数"). Every endpoint is tenant-scoped, side-effect free
 * and gated by `report:read` — a cashier/biller without the code gets
 * 403, matching the billing:read vs billing:write split. The exact
 * aggregation predicates live on ReportService so the numbers are
 * reproducible against the source tables.
 */
@Controller('reports')
export class ReportsController {
  constructor(private readonly svc: ReportService) {}

  /**
   * GET /reports/meter-daily?date=YYYY-MM-DD[&bookId][&orgUnitId] —
   * 抄表日报： per-book plan-item status counts for the date's period
   * plus same-day readingsTaken. Scoped callers see subtree books only.
   */
  @Get('meter-daily')
  @Permissions('report:read')
  meterDaily(
    @Query('date') date?: string,
    @Query('bookId') bookId?: string,
    @Query('orgUnitId') orgUnitId?: string,
  ) {
    const parsed = {
      date: assertDate(required(date, 'date')),
      bookId: bookId !== undefined ? assertUuid(bookId, 'bookId') : undefined,
      orgUnitId:
        orgUnitId !== undefined ? assertUuid(orgUnitId, 'orgUnitId') : undefined,
    };
    return this.svc.meterDaily(currentTenant(), parsed);
  }

  /**
   * GET /reports/cashier-daily?date=YYYY-MM-DD — 收费日报： per-cashier
   * collections on the date split by channel, with a closed flag when
   * the cashier's day close for that operating date exists.
   */
  @Get('cashier-daily')
  @Permissions('report:read')
  cashierDaily(@Query('date') date?: string) {
    return this.svc.cashierDaily(currentTenant(), {
      date: assertDate(required(date, 'date')),
    });
  }

  /**
   * GET /reports/ar-monthly?period=YYYYMM — 应收月报： billed amount of
   * the period (non-REVERSAL, POSTED|PARTIAL_PAID|PAID) split by
   * usage_category.
   */
  @Get('ar-monthly')
  @Permissions('report:read')
  arMonthly(@Query('period') period?: string) {
    return this.svc.arMonthly(currentTenant(), {
      period: assertPeriod(required(period, 'period')),
    });
  }

  /**
   * GET /reports/collected-monthly?period=YYYYMM — 实收月报： collections
   * received inside the month split by channel, plus the PAYMENT-source
   * alloc-side Σ for the same month. collected and allocated are
   * distinct measures post-E6 (TOP_UP legs bypass payment_alloc) and
   * anchor differently under scope — never assert they are equal.
   */
  @Get('collected-monthly')
  @Permissions('report:read')
  collectedMonthly(@Query('period') period?: string) {
    return this.svc.collectedMonthly(currentTenant(), {
      period: assertPeriod(required(period, 'period')),
    });
  }

  /**
   * GET /reports/recovery-rate?period=YYYYMM[&through=YYYYMM] — 回收率：
   * collected/billed. Single-month window by default; `through` (must
   * be ≥ period) switches to the cumulative Σ ≤ through variant.
   * Tenant-scope only — scoped callers get 403 REPORT_SCOPE_UNDEFINED.
   */
  @Get('recovery-rate')
  @Permissions('report:read')
  recoveryRate(
    @Query('period') period?: string,
    @Query('through') through?: string,
  ) {
    const p = assertPeriod(required(period, 'period'));
    const t = through !== undefined ? assertPeriod(through, 'through') : undefined;
    if (t !== undefined && t < p) {
      throw new BadRequestException({ code: 'PERIOD_INVALID', field: 'through' });
    }
    return this.svc.recoveryRate(currentTenant(), { period: p, through: t });
  }
}
