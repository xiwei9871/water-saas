import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { DashboardService } from './dashboard.service.js';

const assertPeriod = (v: unknown): string => {
  if (typeof v !== 'string' || !/^\d{6}$/.test(v)) {
    throw new BadRequestException({ code: 'PERIOD_INVALID', field: 'period' });
  }
  const month = parseInt(v.slice(4), 10);
  if (month < 1 || month > 12) {
    throw new BadRequestException({ code: 'PERIOD_INVALID', field: 'period' });
  }
  return v;
};

/**
 * /dashboard — E10 foundation surface. Exposes only the Metric Dictionary
 * Rev4-frozen metrics; HOLD metrics are listed by name in `hold` and never
 * carry a numeric value. Read-only; `report:read` gates it like /reports.
 */
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly svc: DashboardService) {}

  @Get('metrics')
  @Permissions('report:read')
  metrics(@Query('period') period?: string) {
    if (period === undefined || period === '') {
      throw new BadRequestException({ code: 'REPORT_PARAM_REQUIRED', field: 'period' });
    }
    return this.svc.metrics(currentTenant(), assertPeriod(period));
  }
}
