import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
} from '@nestjs/common';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { assertUuid } from '../../common/uuid.js';
import {
  SettlementService,
  type EstimatePreviewBody,
} from './settlement.service.js';

/** period is char(6) YYYYMM — same guard as the other metering endpoints. */
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

interface PreviewWireBody {
  waterAccountId?: string;
  period?: string;
}

/**
 * /estimate — estimation helpers. preview is a POST only because it takes
 * a structured body; it writes nothing, so it answers 200 and sits behind
 * metering:read like the other read paths.
 */
@Controller('estimate')
export class EstimateController {
  constructor(
    private readonly svc: SettlementService,
    private readonly prisma: TenantPrismaService,
  ) {}

  /**
   * POST /estimate/preview — {waterAccountId, period} → {suggestedUsage,
   * method, basis}: the AUTO_AVG3 suggestion over the account's last ≤3
   * READING-derived component usages. suggestedUsage is null when the
   * account has no valid history (generation then requires usageQty).
   */
  @Post('preview')
  @HttpCode(200)
  @Permissions('metering:read')
  preview(@Body() body: PreviewWireBody) {
    if (!body?.waterAccountId || !body?.period) {
      throw new BadRequestException({ code: 'PREVIEW_FIELDS_REQUIRED' });
    }
    const parsed: EstimatePreviewBody = {
      waterAccountId: assertUuid(body.waterAccountId, 'waterAccountId'),
      period: assertPeriod(body.period),
    };
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.previewTx(tx, ctx, parsed),
    );
  }
}
