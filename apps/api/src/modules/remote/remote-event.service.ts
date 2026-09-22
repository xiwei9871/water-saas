import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { conflictOnUnique } from '../../common/prisma-errors.js';
import { orgInScope, type TenantCtx } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import type { CanonicalRemoteEvent } from './canonical.js';
import {
  PROCESS_LOG_SELECT,
  REMOTE_EVENT_SELECT,
  RemoteEventProcessorService,
  SYSTEM,
} from './remote-processor.service.js';

export interface EventListQuery {
  take: number;
  skip: number;
  remoteSourceId?: string;
  processingStatus?: string;
  businessPeriod?: string;
  vendorDeviceKey?: string;
}

export type IngestOutcomeKind =
  | 'CONVERTED'
  | 'UNBOUND'
  | 'WAITING_PLAN'
  | 'FAILED'
  | 'CONFLICT'
  | 'IDEMPOTENT_REPLAY'
  | 'EVENT_KEY_CONFLICT';

export interface IngestOutcome {
  /** 0-based position in the submitted batch. */
  index: number;
  externalEventKey: string;
  outcome: IngestOutcomeKind;
  eventId?: string;
  readingId?: string;
  code?: string;
}

/**
 * RawRemoteEvent ingest + queries (E5 T4).
 *
 * Idempotency (frozen): UNIQUE(tenant, source, externalEventKey).
 *  - same key + same canonicalPayloadHash → IDEMPOTENT_REPLAY: return the
 *    original event, insert nothing, write a replay log row.
 *  - same key + different hash → EVENT_KEY_CONFLICT: the original payload
 *    is NEVER overwritten; the conflict is logged + flagged on the
 *    original event (current_issue_*), nothing converted.
 *
 * Each event runs in its own transaction — one bad event can never poison
 * a batch (file-import partial success relies on this).
 */
@Injectable()
export class RemoteEventService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly processor: RemoteEventProcessorService,
  ) {}

  list(ctx: TenantCtx, q: EventListQuery) {
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.rawRemoteEvent.findMany({
        where: {
          tenantId: ctx.tenantId,
          remoteSourceId: q.remoteSourceId,
          processingStatus: q.processingStatus as never,
          businessPeriod: q.businessPeriod,
          vendorDeviceKey: q.vendorDeviceKey
            ? { contains: q.vendorDeviceKey }
            : undefined,
        },
        select: REMOTE_EVENT_SELECT,
        orderBy: [{ receivedAt: 'desc' }, { id: 'asc' }],
        take: q.take,
        skip: q.skip,
      }),
    );
  }

  /** Event detail: payloads + resolution + process log + linked reading. */
  getById(ctx: TenantCtx, id: string) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const event = await tx.rawRemoteEvent.findFirst({
        where: { tenantId: ctx.tenantId, id },
      });
      if (!event) throw new NotFoundException({ code: 'REMOTE_EVENT_NOT_FOUND' });
      const logs = await tx.remoteEventProcessLog.findMany({
        where: { tenantId: ctx.tenantId, remoteEventId: id },
        select: PROCESS_LOG_SELECT,
        orderBy: { createdAt: 'asc' },
      });
      const reading = await tx.meterReading.findFirst({
        where: { tenantId: ctx.tenantId, sourceEventId: id },
        select: { id: true, qcStatus: true, period: true, readingValue: true },
      });
      return { ...event, processLogs: logs, reading };
    });
  }

  /** Write-path scope guard: the source's org (NULL org → ALL scope). */
  private async assertSourceWritable(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    sourceId: string,
  ) {
    const source = await tx.remoteSource.findFirst({
      where: { tenantId: ctx.tenantId, id: sourceId },
    });
    if (!source) throw new BadRequestException({ code: 'REMOTE_SOURCE_NOT_FOUND' });
    if (source.orgUnitId === null) {
      if (ctx.scope !== 'ALL') throw new ForbiddenException({ code: 'ORG_OUT_OF_SCOPE' });
    } else if (!orgInScope(ctx, source.orgUnitId)) {
      throw new ForbiddenException({ code: 'ORG_OUT_OF_SCOPE' });
    }
    return source;
  }

  /**
   * Ingest one canonical event in a fresh transaction. Called once per
   * canonical event by adapters/endpoints; outcomes are per-event.
   */
  async ingestOne(
    ctx: TenantCtx,
    sourceId: string,
    event: CanonicalRemoteEvent,
  ): Promise<IngestOutcome> {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const source = await this.assertSourceWritable(tx, ctx, sourceId);
      if (source.status !== 'ACTIVE') {
        throw new BadRequestException({ code: 'REMOTE_SOURCE_DISABLED' });
      }
      const actor = { type: 'USER' as const, staffId: ctx.staffId };
      // INSERT ... ON CONFLICT DO NOTHING: a thrown P2002 would abort the
      // surrounding transaction and poison every later statement — the
      // replay/conflict fork below must see a clean tx.
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO raw_remote_event (
          id, tenant_id, remote_source_id, external_event_key, canonical_payload_hash,
          vendor_device_key, business_period, collected_at, reading_value,
          vendor_quality, raw_payload, canonical_payload,
          created_by, updated_by, updated_at
        ) VALUES (
          gen_random_uuid(),
          ${ctx.tenantId}::uuid, ${sourceId}::uuid, ${event.externalEventKey},
          ${event.payloadHash}, ${event.vendorDeviceKey}, ${event.businessPeriod},
          ${event.collectedAt}, ${event.readingValue}::numeric,
          ${event.vendorQuality ?? null},
          ${JSON.stringify(event.rawPayload)}::jsonb,
          ${JSON.stringify(event.canonicalPayload)}::jsonb,
          ${ctx.staffId}::uuid, ${ctx.staffId}::uuid, now()
        )
        ON CONFLICT (tenant_id, remote_source_id, external_event_key) DO NOTHING
        RETURNING id`;
      if (inserted.length > 0) {
        const created = inserted[0];
        await this.processor.log(tx, {
          tenantId: ctx.tenantId,
          remoteEventId: created.id,
          action: 'RECEIVED',
          toStatus: 'RECEIVED',
          actor,
        });
        const result = await this.processor.processEventTx(tx, ctx, created.id, SYSTEM);
        return {
          index: 0,
          externalEventKey: event.externalEventKey,
          outcome: result.status as IngestOutcomeKind,
          eventId: created.id,
          readingId: result.readingId,
        };
      }
      {
        // Key already present — replay vs payload-conflict fork.
        const existing = await tx.rawRemoteEvent.findFirstOrThrow({
          where: {
            tenantId: ctx.tenantId,
            remoteSourceId: sourceId,
            externalEventKey: event.externalEventKey,
          },
          select: { id: true, canonicalPayloadHash: true, processingStatus: true },
        });
        if (existing.canonicalPayloadHash === event.payloadHash) {
          await this.processor.log(tx, {
            tenantId: ctx.tenantId,
            remoteEventId: existing.id,
            action: 'IDEMPOTENT_REPLAY',
            code: 'IDEMPOTENT_REPLAY',
            message: 'same externalEventKey + same canonical payload',
            actor,
          });
          return {
            index: 0,
            externalEventKey: event.externalEventKey,
            outcome: 'IDEMPOTENT_REPLAY',
            eventId: existing.id,
          };
        }
        await tx.rawRemoteEvent.update({
          where: { tenantId_id: { tenantId: ctx.tenantId, id: existing.id } },
          data: {
            currentIssueCode: 'EVENT_KEY_CONFLICT',
            currentIssueAt: new Date(),
            updatedBy: ctx.staffId,
          },
        });
        await this.processor.log(tx, {
          tenantId: ctx.tenantId,
          remoteEventId: existing.id,
          action: 'EVENT_KEY_CONFLICT',
          code: 'EVENT_KEY_CONFLICT',
          message: 'same externalEventKey with a different canonical payload — original preserved',
          actor,
          detail: { incomingPayloadHash: event.payloadHash },
        });
        return {
          index: 0,
          externalEventKey: event.externalEventKey,
          outcome: 'EVENT_KEY_CONFLICT',
          eventId: existing.id,
          code: 'EVENT_KEY_CONFLICT',
        };
      }
    });
  }

  /** Batch ingest — each event isolated in its own transaction. */
  async ingestBatch(
    ctx: TenantCtx,
    sourceId: string,
    events: CanonicalRemoteEvent[],
  ): Promise<IngestOutcome[]> {
    const outcomes: IngestOutcome[] = [];
    for (let i = 0; i < events.length; i++) {
      try {
        const o = await this.ingestOne(ctx, sourceId, events[i]);
        outcomes.push({ ...o, index: i });
      } catch (e) {
        // A structural failure (source disabled/not found/scope) fails the
        // whole batch — per-event isolation only shields business outcomes.
        if (i === 0) throw e;
        outcomes.push({
          index: i,
          externalEventKey: events[i].externalEventKey,
          outcome: 'FAILED',
          code: 'INGEST_ABORTED',
        });
      }
    }
    return outcomes;
  }

  /** Convenience: create is also used by tests/tools needing a typed row. */
  async createRawTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    data: Prisma.RawRemoteEventUncheckedCreateInput,
  ) {
    return conflictOnUnique(tx.rawRemoteEvent.create({ data }));
  }
}
