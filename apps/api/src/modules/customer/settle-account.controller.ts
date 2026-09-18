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
import {
  SettleAccountService,
  type SettleAccountBody,
  type SettleAccountPatchBody,
} from './settle-account.service.js';

const SETTLE_STATUSES = new Set(['NORMAL', 'SUSPENDED', 'CLOSED']);
const PATCH_STATUSES = new Set(['NORMAL', 'SUSPENDED']);

const pageArgs = (take?: string, skip?: string) => ({
  take: Math.min(Math.max(parseInt(take ?? '50', 10) || 50, 1), 200),
  skip: Math.max(parseInt(skip ?? '0', 10) || 0, 0),
});

@Controller('settle-accounts')
export class SettleAccountController {
  constructor(
    private readonly svc: SettleAccountService,
    private readonly prisma: TenantPrismaService,
    private readonly idem: IdempotencyService,
  ) {}

  /** GET /settle-accounts — optional ?name= / ?status= filters. */
  @Get()
  @Permissions('customer:read')
  list(
    @Query('name') name?: string,
    @Query('status') status?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    if (status !== undefined && !SETTLE_STATUSES.has(status)) {
      throw new BadRequestException({ code: 'ACCOUNT_STATUS_INVALID' });
    }
    return this.svc.list(currentTenant(), {
      ...pageArgs(take, skip),
      name,
      status: status as 'NORMAL' | 'SUSPENDED' | 'CLOSED' | undefined,
    });
  }

  @Get(':id')
  @Permissions('customer:read')
  get(@Param('id') id: string) {
    return this.svc.getById(currentTenant(), assertUuid(id, 'id'));
  }

  /** POST /settle-accounts — settle_no from sys_sequence unless supplied. */
  @Post()
  @Permissions('customer:write')
  create(
    @Body() body: SettleAccountBody,
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!body?.name) {
      throw new BadRequestException({ code: 'SETTLE_ACCOUNT_FIELDS_REQUIRED' });
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

  /**
   * PATCH /settle-accounts/:id — name/phone + NORMAL↔SUSPENDED. settle_no is
   * immutable; CLOSED is only reachable through a business flow, not PATCH.
   */
  @Patch(':id')
  @Permissions('customer:write')
  update(
    @Param('id') id: string,
    @Body() body: SettleAccountPatchBody,
    @Req() req: Request,
  ) {
    assertUuid(id, 'id');
    if (body.status !== undefined && !PATCH_STATUSES.has(body.status)) {
      throw new BadRequestException({ code: 'ACCOUNT_STATUS_INVALID' });
    }
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.updateTx(tx, ctx, id, body, req),
    );
  }
}
