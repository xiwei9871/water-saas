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
import { assertDecimal, assertOptionalDate } from '../../common/decimal.js';
import { IdempotencyService } from '../../common/idempotency.service.js';
import { withOptionalIdem } from '../../common/idempotent.js';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { assertUuid } from '../../common/uuid.js';
import {
  MeterInstallationService,
  type InstallBody,
  type RemoveBody,
} from './meter-installation.service.js';

const INSTALL_REASONS = new Set(['NEW', 'REPLACE', 'FAULT', 'PERIODIC_CHECK']);
const INSTALLATION_STATUSES = new Set(['ACTIVE', 'REMOVED']);

const pageArgs = (take?: string, skip?: string) => ({
  take: Math.min(Math.max(parseInt(take ?? '50', 10) || 50, 1), 200),
  skip: Math.max(parseInt(skip ?? '0', 10) || 0, 0),
});

interface InstallWireBody {
  waterAccountId?: string;
  meterId?: string;
  initialReading?: unknown;
  installedAt?: unknown;
  reason?: string;
}

interface RemoveWireBody {
  finalReading?: unknown;
  removedAt?: unknown;
}

@Controller('meter-installations')
export class MeterInstallationController {
  constructor(
    private readonly svc: MeterInstallationService,
    private readonly prisma: TenantPrismaService,
    private readonly idem: IdempotencyService,
  ) {}

  /** GET /meter-installations — ?waterAccountId= / ?meterId= / ?status=. */
  @Get()
  @Permissions('customer:read')
  list(
    @Query('waterAccountId') waterAccountId?: string,
    @Query('meterId') meterId?: string,
    @Query('status') status?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    if (waterAccountId !== undefined) assertUuid(waterAccountId, 'waterAccountId');
    if (meterId !== undefined) assertUuid(meterId, 'meterId');
    if (status !== undefined && !INSTALLATION_STATUSES.has(status)) {
      throw new BadRequestException({ code: 'INSTALLATION_STATUS_INVALID' });
    }
    return this.svc.list(currentTenant(), {
      ...pageArgs(take, skip),
      waterAccountId,
      meterId,
      status: status as 'ACTIVE' | 'REMOVED' | undefined,
    });
  }

  @Get(':id')
  @Permissions('customer:read')
  get(@Param('id') id: string) {
    return this.svc.getById(currentTenant(), assertUuid(id, 'id'));
  }

  /**
   * POST /meter-installations — 装表/复装. Meter must be AVAILABLE; per spec
   * the API does not enforce single-active-installation per account.
   */
  @Post()
  @Permissions('customer:write')
  install(
    @Body() body: InstallWireBody,
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!body?.waterAccountId || !body?.meterId || body?.initialReading === undefined) {
      throw new BadRequestException({ code: 'INSTALLATION_FIELDS_REQUIRED' });
    }
    const parsed: InstallBody = {
      waterAccountId: assertUuid(body.waterAccountId, 'waterAccountId'),
      meterId: assertUuid(body.meterId, 'meterId'),
      initialReading: assertDecimal(body.initialReading, 'initialReading', { min: 0 }),
      installedAt: assertOptionalDate(body.installedAt, 'installedAt'),
      reason: body.reason as InstallBody['reason'],
    };
    if (body.reason !== undefined && !INSTALL_REASONS.has(body.reason)) {
      throw new BadRequestException({ code: 'INSTALL_REASON_INVALID' });
    }
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body, responseStatus: 201 },
      (tx) => this.svc.installTx(tx, ctx, parsed),
    );
  }

  /**
   * POST /meter-installations/:id/remove — 拆表. final_reading mandatory and
   * ≥ initial_reading; installation → REMOVED, meter → AVAILABLE.
   */
  @Post(':id/remove')
  @Permissions('customer:write')
  remove(
    @Param('id') id: string,
    @Body() body: RemoveWireBody,
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    assertUuid(id, 'id');
    if (body?.finalReading === undefined || body?.finalReading === null) {
      throw new BadRequestException({ code: 'FINAL_READING_REQUIRED' });
    }
    const parsed: RemoveBody = {
      finalReading: assertDecimal(body.finalReading, 'finalReading', { min: 0 }),
      removedAt: assertOptionalDate(body.removedAt, 'removedAt'),
    };
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body, responseStatus: 201 },
      (tx) => this.svc.removeTx(tx, ctx, id, parsed, req),
    );
  }
}
