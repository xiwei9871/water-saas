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
import { IdempotencyService } from '../../common/idempotency.service.js';
import { withOptionalIdem } from '../../common/idempotent.js';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { assertUuid } from '../../common/uuid.js';
import { FeeItemService, type FeeItemBody } from './fee-item.service.js';

const CALC_TYPES = new Set(['PER_QTY', 'FIXED', 'PERCENT']);

/** ?take default 50, hard-capped at 200; ?skip default 0. */
const pageArgs = (take?: string, skip?: string) => ({
  take: Math.min(Math.max(parseInt(take ?? '50', 10) || 50, 1), 200),
  skip: Math.max(parseInt(skip ?? '0', 10) || 0, 0),
});

/**
 * /fee-items — the priced line kinds tariffs quote against (spec §2.5).
 * code/calcType are write-once: a PATCH carrying either is rejected rather
 * than silently ignored, because the caller believes the item's meaning
 * changed while bill_item snapshots keep the old semantics.
 */
@Controller('fee-items')
export class FeeItemController {
  constructor(
    private readonly svc: FeeItemService,
    private readonly prisma: TenantPrismaService,
    private readonly idem: IdempotencyService,
  ) {}

  /** GET /fee-items — ?code= / ?calcType= / paging. */
  @Get()
  @Permissions('billing:read')
  list(
    @Query('code') code?: string,
    @Query('calcType') calcType?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    if (calcType !== undefined && !CALC_TYPES.has(calcType)) {
      throw new BadRequestException({ code: 'CALC_TYPE_INVALID' });
    }
    return this.svc.list(currentTenant(), {
      ...pageArgs(take, skip),
      code,
      calcType: calcType as 'PER_QTY' | 'FIXED' | 'PERCENT' | undefined,
    });
  }

  /** GET /fee-items/:id */
  @Get(':id')
  @Permissions('billing:read')
  get(@Param('id') id: string) {
    return this.svc.getById(currentTenant(), assertUuid(id, 'id'));
  }

  /** POST /fee-items — {code, name, calcType}; duplicate code → 409. */
  @Post()
  @Permissions('billing:write')
  create(
    @Body() body: FeeItemBody,
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!body?.code || !body?.name || !body?.calcType) {
      throw new BadRequestException({ code: 'FEE_ITEM_FIELDS_REQUIRED' });
    }
    if (!CALC_TYPES.has(body.calcType)) {
      throw new BadRequestException({ code: 'CALC_TYPE_INVALID', value: body.calcType });
    }
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body, responseStatus: 201 },
      (tx) => this.svc.createTx(tx, ctx, body),
    );
  }

  /** PATCH /fee-items/:id — {name} only; code/calcType → 400. */
  @Patch(':id')
  @Permissions('billing:write')
  update(
    @Param('id') id: string,
    @Body() body: { name?: string; code?: string; calcType?: string },
    @Req() req: Request,
  ) {
    assertUuid(id, 'id');
    if (body?.code !== undefined || body?.calcType !== undefined) {
      throw new BadRequestException({ code: 'FEE_ITEM_IMMUTABLE_FIELD' });
    }
    if (body?.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) {
      throw new BadRequestException({ code: 'FEE_ITEM_NAME_INVALID' });
    }
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.updateTx(tx, ctx, id, { name: body?.name?.trim() }, req),
    );
  }
}
