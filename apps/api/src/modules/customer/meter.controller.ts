import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
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
import {
  MeterService,
  type MeterBody,
  type MeterPatchBody,
  type MeterStatus,
} from './meter.service.js';

const METER_STATUSES = new Set(['AVAILABLE', 'INSTALLED', 'MAINTENANCE', 'RETIRED']);

const pageArgs = (take?: string, skip?: string) => ({
  take: Math.min(Math.max(parseInt(take ?? '50', 10) || 50, 1), 200),
  skip: Math.max(parseInt(skip ?? '0', 10) || 0, 0),
});

@Controller('meters')
export class MeterController {
  constructor(
    private readonly svc: MeterService,
    private readonly prisma: TenantPrismaService,
    private readonly idem: IdempotencyService,
  ) {}

  /** GET /meters — optional ?status= filter. */
  @Get()
  @Permissions('customer:read')
  list(
    @Query('status') status?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    if (status !== undefined && !METER_STATUSES.has(status)) {
      throw new BadRequestException({ code: 'METER_STATUS_INVALID' });
    }
    return this.svc.list(currentTenant(), {
      ...pageArgs(take, skip),
      status: status as MeterStatus | undefined,
    });
  }

  /** GET /meters/:id — device + installation timeline (spec: 水表台账). */
  @Get(':id')
  @Permissions('customer:read')
  get(@Param('id') id: string) {
    return this.svc.getById(currentTenant(), assertUuid(id, 'id'));
  }

  /** POST /meters — register a device; meter_no from sys_sequence unless given. */
  @Post()
  @Permissions('customer:write')
  create(
    @Body() body: MeterBody & { maxDial?: unknown },
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    const ctx = currentTenant();
    const parsed: MeterBody = {
      ...body,
      maxDial: body?.maxDial !== undefined ? assertDecimal(body.maxDial, 'maxDial') : undefined,
    };
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body, responseStatus: 201 },
      (tx) => this.svc.createTx(tx, ctx, parsed),
    );
  }

  /**
   * PATCH /meters/:id — device fields + lifecycle transitions that don't touch
   * installations (spec §2.7). AVAILABLE→INSTALLED / INSTALLED→AVAILABLE belong
   * to meter_installation install/remove, not this endpoint.
   */
  @Patch(':id')
  @Permissions('customer:write')
  update(
    @Param('id') id: string,
    @Body() body: MeterPatchBody & { maxDial?: unknown },
    @Req() req: Request,
  ) {
    assertUuid(id, 'id');
    if (body.status !== undefined && !METER_STATUSES.has(body.status)) {
      throw new BadRequestException({ code: 'METER_STATUS_INVALID' });
    }
    const ctx = currentTenant();
    const parsed: MeterPatchBody = {
      ...body,
      maxDial: body?.maxDial !== undefined ? assertDecimal(body.maxDial, 'maxDial') : undefined,
    };
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.updateTx(tx, ctx, id, parsed, req),
    );
  }
}
