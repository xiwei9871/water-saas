import {
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
  RemoteSourceService,
  type RemoteSourceBody,
  type RemoteSourcePatchBody,
} from './remote-source.service.js';

/** ?take default 50, hard-capped at 200; ?skip default 0. */
const pageArgs = (take?: string, skip?: string) => ({
  take: Math.min(Math.max(parseInt(take ?? '50', 10) || 50, 1), 200),
  skip: Math.max(parseInt(skip ?? '0', 10) || 0, 0),
});

/**
 * /remote-sources — vendor platform configuration (E5 T2). Reads need
 * metering:read (config objects, not meter data); writes need
 * metering:remote:manage + org scope on org_unit_id.
 */
@Controller('remote-sources')
export class RemoteSourceController {
  constructor(
    private readonly svc: RemoteSourceService,
    private readonly prisma: TenantPrismaService,
    private readonly idem: IdempotencyService,
  ) {}

  /** GET /remote-sources — ?q= (code/name substring) / ?type= / ?status= / paging. */
  @Get()
  @Permissions('metering:read')
  list(
    @Query('q') q?: string,
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.svc.list(currentTenant(), {
      ...pageArgs(take, skip),
      q,
      type,
      status,
    });
  }

  /** GET /remote-sources/:id */
  @Get(':id')
  @Permissions('metering:read')
  get(@Param('id') id: string) {
    return this.svc.getById(currentTenant(), assertUuid(id, 'id'));
  }

  /**
   * POST /remote-sources — code/name/sourceType/adapterKey/timezone
   * required; orgUnitId nullable (tenant-wide → ALL scope only);
   * credentialRef is a vault/env REFERENCE, never a plaintext secret.
   */
  @Post()
  @Permissions('metering:remote:manage')
  create(
    @Body() body: RemoteSourceBody,
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    const parsed: RemoteSourceBody = {
      code: body?.code,
      name: body?.name,
      type: body?.type,
      adapterKey: body?.adapterKey,
      timezone: body?.timezone,
      orgUnitId:
        body?.orgUnitId === undefined || body?.orgUnitId === null
          ? null
          : assertUuid(body.orgUnitId, 'orgUnitId'),
      credentialRef: body?.credentialRef,
      config: body?.config,
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

  /** PATCH /remote-sources/:id — mutable profile only; code/type/adapterKey immutable. */
  @Patch(':id')
  @Permissions('metering:remote:manage')
  update(@Param('id') id: string, @Body() body: RemoteSourcePatchBody, @Req() req: Request) {
    assertUuid(id, 'id');
    if (body.orgUnitId !== undefined && body.orgUnitId !== null) {
      assertUuid(body.orgUnitId, 'orgUnitId');
    }
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.updateTx(tx, ctx, id, body, req),
    );
  }
}
