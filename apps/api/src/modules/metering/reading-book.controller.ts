import {
  BadRequestException,
  Body,
  Controller,
  Delete,
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
  ReadingBookService,
  type BookMemberBody,
  type ReadingBookBody,
  type ReadingBookPatchBody,
} from './reading-book.service.js';

/** ?take default 50, hard-capped at 200; ?skip default 0. */
const pageArgs = (take?: string, skip?: string) => ({
  take: Math.min(Math.max(parseInt(take ?? '50', 10) || 50, 1), 200),
  skip: Math.max(parseInt(skip ?? '0', 10) || 0, 0),
});

const scheduleDayOf = (v: unknown): number | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const n = typeof v === 'string' ? parseInt(v, 10) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 31) {
    throw new BadRequestException({ code: 'SCHEDULE_DAY_INVALID' });
  }
  return n;
};

@Controller('reading-books')
export class ReadingBookController {
  constructor(
    private readonly svc: ReadingBookService,
    private readonly prisma: TenantPrismaService,
    private readonly idem: IdempotencyService,
  ) {}

  /** GET /reading-books — ?name= (substring) / ?bookNo= / ?orgUnitId= / paging. */
  @Get()
  @Permissions('metering:read')
  list(
    @Query('name') name?: string,
    @Query('bookNo') bookNo?: string,
    @Query('orgUnitId') orgUnitId?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    if (orgUnitId !== undefined) assertUuid(orgUnitId, 'orgUnitId');
    return this.svc.list(currentTenant(), {
      ...pageArgs(take, skip),
      name,
      bookNo,
      orgUnitId,
    });
  }

  /** GET /reading-books/:id — book + current members (seq_no ordered). */
  @Get(':id')
  @Permissions('metering:read')
  get(@Param('id') id: string) {
    return this.svc.getById(currentTenant(), assertUuid(id, 'id'));
  }

  /**
   * POST /reading-books — name + orgUnitId required; book_no from
   * sys_sequence ('B' prefix) unless supplied. readerId must be staff.
   */
  @Post()
  @Permissions('metering:write')
  create(
    @Body() body: ReadingBookBody,
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!body?.name || !body?.orgUnitId) {
      throw new BadRequestException({ code: 'BOOK_FIELDS_REQUIRED' });
    }
    const parsed: ReadingBookBody = {
      bookNo: body.bookNo,
      name: body.name,
      orgUnitId: assertUuid(body.orgUnitId, 'orgUnitId'),
      readerId: body.readerId ? assertUuid(body.readerId, 'readerId') : null,
      scheduleDay: scheduleDayOf(body.scheduleDay),
    };
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body, responseStatus: 201 },
      (tx) => this.svc.createTx(tx, ctx, parsed),
    );
  }

  /** PATCH /reading-books/:id — profile fields; book_no immutable. */
  @Patch(':id')
  @Permissions('metering:write')
  update(
    @Param('id') id: string,
    @Body() body: ReadingBookPatchBody,
    @Req() req: Request,
  ) {
    assertUuid(id, 'id');
    if (body.orgUnitId !== undefined) assertUuid(body.orgUnitId, 'orgUnitId');
    if (body.readerId !== undefined && body.readerId !== null) {
      assertUuid(body.readerId, 'readerId');
    }
    const parsed: ReadingBookPatchBody = {
      name: body.name,
      orgUnitId: body.orgUnitId,
      readerId: body.readerId,
      scheduleDay: scheduleDayOf(body.scheduleDay),
    };
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.updateTx(tx, ctx, id, parsed, req),
    );
  }

  /** DELETE /reading-books/:id — only while no plan references it. */
  @Delete(':id')
  @Permissions('metering:write')
  remove(@Param('id') id: string, @Req() req: Request) {
    assertUuid(id, 'id');
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.deleteTx(tx, ctx, id, req),
    );
  }

  /**
   * POST /reading-books/:id/meters — add a water account to the book.
   * seqNo optional (defaults to route end); duplicate membership → 409.
   */
  @Post(':id/meters')
  @Permissions('metering:write')
  addMember(
    @Param('id') id: string,
    @Body() body: BookMemberBody,
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    assertUuid(id, 'id');
    if (!body?.waterAccountId) {
      throw new BadRequestException({ code: 'BOOK_MEMBER_FIELDS_REQUIRED' });
    }
    if (body.seqNo !== undefined && (!Number.isInteger(body.seqNo) || body.seqNo < 1)) {
      throw new BadRequestException({ code: 'SEQ_NO_INVALID' });
    }
    const parsed: BookMemberBody = {
      waterAccountId: assertUuid(body.waterAccountId, 'waterAccountId'),
      seqNo: body.seqNo,
    };
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body, responseStatus: 201 },
      (tx) => this.svc.addMemberTx(tx, ctx, id, parsed),
    );
  }

  /** DELETE /reading-books/:id/meters/:waterAccountId — remove a member. */
  @Delete(':id/meters/:waterAccountId')
  @Permissions('metering:write')
  removeMember(
    @Param('id') id: string,
    @Param('waterAccountId') waterAccountId: string,
  ) {
    assertUuid(id, 'id');
    assertUuid(waterAccountId, 'waterAccountId');
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.removeMemberTx(tx, ctx, id, waterAccountId),
    );
  }
}
