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
  CustomerService,
  type CustomerBody,
  type CustomerPatchBody,
} from './customer.service.js';

const CUST_TYPES = new Set(['PERSONAL', 'ORG']);

/** ?take default 50, hard-capped at 200; ?skip default 0. */
const pageArgs = (take?: string, skip?: string) => ({
  take: Math.min(Math.max(parseInt(take ?? '50', 10) || 50, 1), 200),
  skip: Math.max(parseInt(skip ?? '0', 10) || 0, 0),
});

@Controller('customers')
export class CustomerController {
  constructor(
    private readonly svc: CustomerService,
    private readonly prisma: TenantPrismaService,
    private readonly idem: IdempotencyService,
  ) {}

  /** GET /customers — optional ?name= (substring) / ?customerNo= filters. */
  @Get()
  @Permissions('customer:read')
  list(
    @Query('name') name?: string,
    @Query('customerNo') customerNo?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.svc.list(currentTenant(), { ...pageArgs(take, skip), name, customerNo });
  }

  @Get(':id')
  @Permissions('customer:read')
  get(@Param('id') id: string) {
    return this.svc.getById(currentTenant(), assertUuid(id, 'id'));
  }

  /**
   * POST /customers — create a customer; customer_no comes from sys_sequence
   * (prefix 'C' + yyyyMM + 6-digit) unless explicitly supplied.
   */
  @Post()
  @Permissions('customer:write')
  create(
    @Body() body: CustomerBody,
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!body?.name || !body?.custType) {
      throw new BadRequestException({ code: 'CUSTOMER_FIELDS_REQUIRED' });
    }
    if (!CUST_TYPES.has(body.custType)) {
      throw new BadRequestException({ code: 'CUST_TYPE_INVALID' });
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

  /** PATCH /customers/:id — profile fields; customer_no is immutable. */
  @Patch(':id')
  @Permissions('customer:write')
  update(
    @Param('id') id: string,
    @Body() body: CustomerPatchBody,
    @Req() req: Request,
  ) {
    assertUuid(id, 'id');
    if (body.custType !== undefined && !CUST_TYPES.has(body.custType)) {
      throw new BadRequestException({ code: 'CUST_TYPE_INVALID' });
    }
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.updateTx(tx, ctx, id, body, req),
    );
  }
}
