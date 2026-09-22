import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { assertUuid } from '../../common/uuid.js';
import { RemoteEventService } from './remote-event.service.js';
import { RemoteEventProcessorService } from './remote-processor.service.js';

/** ?take default 50, hard-capped at 200; ?skip default 0. */
const pageArgs = (take?: string, skip?: string) => ({
  take: Math.min(Math.max(parseInt(take ?? '50', 10) || 50, 1), 200),
  skip: Math.max(parseInt(skip ?? '0', 10) || 0, 0),
});

interface ResolveConflictBody {
  decision?: 'USE_REMOTE' | 'KEEP_ACTUAL';
  note?: string;
}

/**
 * /remote-events (E5 T4/T5) — raw ingest facts, their processing trail,
 * explicit replay, and CONFLICT adjudication. Ingest itself is adapter-
 * driven (file import in T8); this controller exposes inspection + the
 * two operator actions.
 */
@Controller('remote-events')
export class RemoteEventController {
  constructor(
    private readonly svc: RemoteEventService,
    private readonly processor: RemoteEventProcessorService,
    private readonly prisma: TenantPrismaService,
  ) {}

  /** GET /remote-events — ?remoteSourceId= ?processingStatus= ?businessPeriod= ?vendorDeviceKey= / paging. */
  @Get()
  @Permissions('metering:read')
  list(
    @Query('remoteSourceId') remoteSourceId?: string,
    @Query('processingStatus') processingStatus?: string,
    @Query('businessPeriod') businessPeriod?: string,
    @Query('vendorDeviceKey') vendorDeviceKey?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    if (remoteSourceId !== undefined) assertUuid(remoteSourceId, 'remoteSourceId');
    return this.svc.list(currentTenant(), {
      ...pageArgs(take, skip),
      remoteSourceId,
      processingStatus,
      businessPeriod,
      vendorDeviceKey,
    });
  }

  /** GET /remote-events/:id — event + payload + process log + linked reading. */
  @Get(':id')
  @Permissions('metering:read')
  get(@Param('id') id: string) {
    return this.svc.getById(currentTenant(), assertUuid(id, 'id'));
  }

  /**
   * POST /remote-events/:id/replay — explicit operator reprocess, allowed
   * only from UNBOUND / FAILED / WAITING_PLAN (CONVERTED/IGNORED terminal,
   * CONFLICT needs resolve-conflict instead).
   */
  @Post(':id/replay')
  @Permissions('metering:remote:manage')
  replay(@Param('id') id: string) {
    const eventId = assertUuid(id, 'id');
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.processor.replayTx(tx, ctx, eventId),
    );
  }

  /**
   * POST /remote-events/:id/resolve-conflict — CONFLICT only.
   *   {decision:"USE_REMOTE"}  → correction reading supersedes the actual
   *   {decision:"KEEP_ACTUAL"} → event IGNORED (only path into IGNORED)
   */
  @Post(':id/resolve-conflict')
  @Permissions('metering:remote:manage')
  resolveConflict(@Param('id') id: string, @Body() body: ResolveConflictBody) {
    const eventId = assertUuid(id, 'id');
    const decision = body?.decision;
    if (decision !== 'USE_REMOTE' && decision !== 'KEEP_ACTUAL') {
      throw new BadRequestException({ code: 'CONFLICT_DECISION_REQUIRED' });
    }
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.processor.resolveConflictTx(tx, ctx, eventId, decision, body.note),
    );
  }
}
