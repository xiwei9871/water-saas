import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { orgInScope, type TenantCtx } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { localDateOf } from './timezone.js';

export const REMOTE_EVENT_SELECT = {
  id: true,
  tenantId: true,
  remoteSourceId: true,
  externalEventKey: true,
  canonicalPayloadHash: true,
  vendorDeviceKey: true,
  businessPeriod: true,
  collectedAt: true,
  readingValue: true,
  vendorQuality: true,
  processingStatus: true,
  resolvedRemoteDeviceId: true,
  resolvedBindingId: true,
  currentIssueCode: true,
  currentIssueAt: true,
  receivedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.RawRemoteEventSelect;

export const PROCESS_LOG_SELECT = {
  id: true,
  remoteEventId: true,
  action: true,
  fromStatus: true,
  toStatus: true,
  code: true,
  message: true,
  actorType: true,
  actorStaffId: true,
  detail: true,
  createdAt: true,
} satisfies Prisma.RemoteEventProcessLogSelect;

type Actor = { type: 'SYSTEM' | 'USER'; staffId?: string | null };
export const SYSTEM: Actor = { type: 'SYSTEM' };
export const userActor = (staffId: string): Actor => ({ type: 'USER', staffId });

type EventStatus =
  | 'RECEIVED'
  | 'UNBOUND'
  | 'WAITING_PLAN'
  | 'FAILED'
  | 'CONFLICT'
  | 'CONVERTED'
  | 'IGNORED';

/** States an explicit replay may start from (design §12). */
const REPLAYABLE: EventStatus[] = ['UNBOUND', 'FAILED', 'WAITING_PLAN'];

/**
 * RemoteEventProcessor (E5 T5–T7) — the only path from RawRemoteEvent to
 * MeterReading. Every transition is one transaction: state flip + process
 * log + (on conversion) the meter_reading + plan item + plan progress land
 * or roll back together.
 *
 * Resolution order (frozen):
 *   device (source + vendorDeviceKey)
 *   → binding covering collectedAt (half-open interval)
 *   → installation → waterAccountId
 *   → plan item (waterAccountId + businessPeriod; plannedInstallationId
 *     exact match preferred, single-candidate fallback, else ambiguous)
 *   → conflict matrix on the item's completed reading
 *   → RemoteReadingWriter (normal | late-recovery mode)
 *
 * CONVERTED/IGNORED are terminal; REPLAYABLE states accept an explicit
 * staff replay; CONFLICT resolves only through resolveConflict.
 */
@Injectable()
export class RemoteEventProcessorService {
  constructor(private readonly prisma: TenantPrismaService) {}

  // -------------------------------------------------------------------------
  // process log
  // -------------------------------------------------------------------------

  /** Append one process-log row; every transition/replay/resolution writes one. */
  async log(
    tx: Prisma.TransactionClient,
    e: {
      tenantId: string;
      remoteEventId: string;
      action: string;
      fromStatus?: EventStatus | null;
      toStatus?: EventStatus | null;
      code?: string;
      message?: string;
      actor: Actor;
      detail?: Record<string, unknown>;
    },
  ) {
    await tx.remoteEventProcessLog.create({
      data: {
        tenantId: e.tenantId,
        remoteEventId: e.remoteEventId,
        action: e.action,
        fromStatus: e.fromStatus ?? null,
        toStatus: e.toStatus ?? null,
        code: e.code ?? null,
        message: e.message ?? null,
        actorType: e.actor.type,
        actorStaffId: e.actor.staffId ?? null,
        detail: (e.detail ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      },
    });
  }

  /** Set status + issue marker + log in one go. */
  private async transition(
    tx: Prisma.TransactionClient,
    ctx: { tenantId: string; staffId?: string | null },
    event: { id: string; processingStatus: string },
    to: EventStatus,
    actor: Actor,
    opts: { action?: string; code?: string; message?: string; detail?: Record<string, unknown>; resolvedRemoteDeviceId?: string | null; resolvedBindingId?: string | null },
  ) {
    await tx.rawRemoteEvent.update({
      where: { tenantId_id: { tenantId: ctx.tenantId, id: event.id } },
      data: {
        processingStatus: to,
        resolvedRemoteDeviceId: opts.resolvedRemoteDeviceId ?? undefined,
        resolvedBindingId: opts.resolvedBindingId ?? undefined,
        currentIssueCode: opts.code ?? null,
        currentIssueAt: opts.code ? new Date() : null,
        updatedBy: ctx.staffId ?? null,
      },
    });
    await this.log(tx, {
      tenantId: ctx.tenantId,
      remoteEventId: event.id,
      action: opts.action ?? to,
      fromStatus: event.processingStatus as EventStatus,
      toStatus: to,
      code: opts.code,
      message: opts.message,
      actor,
      detail: opts.detail,
    });
  }

  // -------------------------------------------------------------------------
  // resolvers
  // -------------------------------------------------------------------------

  /** device → binding covering collectedAt → installation. */
  private async resolveBindingChain(tx: Prisma.TransactionClient, tenantId: string, event: {
    remoteSourceId: string;
    vendorDeviceKey: string;
    collectedAt: Date;
  }) {
    const device = await tx.remoteDevice.findFirst({
      where: {
        tenantId,
        remoteSourceId: event.remoteSourceId,
        vendorDeviceKey: event.vendorDeviceKey,
      },
      select: { id: true, remoteSourceId: true, status: true },
    });
    if (!device || device.status !== 'ACTIVE') return { device };
    const binding = await tx.remoteDeviceBinding.findFirst({
      where: {
        tenantId,
        remoteDeviceId: device.id,
        effectiveFrom: { lte: event.collectedAt },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: event.collectedAt } }],
      },
      select: { id: true, installationId: true },
      orderBy: { effectiveFrom: 'desc' },
    });
    if (!binding) return { device };
    const installation = await tx.meterInstallation.findFirst({
      where: { tenantId, id: binding.installationId },
      select: { id: true, waterAccountId: true, meterId: true },
    });
    if (!installation) return { device };
    return { device, binding, installation };
  }

  /**
   * Two-stage plan resolution (frozen): candidates = waterAccountId +
   * businessPeriod; prefer exact plannedInstallationId = binding's
   * installation; single-candidate fallback otherwise; still-ambiguous →
   * PLAN_ITEM_AMBIGUOUS.
   */
  private async resolvePlanItem(
    tx: Prisma.TransactionClient,
    tenantId: string,
    waterAccountId: string,
    businessPeriod: string,
    installationId: string,
  ) {
    const candidates = await tx.readingPlanItem.findMany({
      where: {
        tenantId,
        waterAccountId,
        plan: { tenantId, period: businessPeriod },
      },
      select: { id: true, planId: true, status: true, plannedInstallationId: true, completedReadingId: true },
    });
    if (candidates.length === 0) return { status: 'NONE' as const };
    const exact = candidates.filter((c) => c.plannedInstallationId === installationId);
    if (exact.length === 1) return { status: 'OK' as const, item: exact[0] };
    if (exact.length === 0 && candidates.length === 1) {
      return { status: 'OK' as const, item: candidates[0] };
    }
    return { status: 'AMBIGUOUS' as const, count: candidates.length };
  }

  // -------------------------------------------------------------------------
  // processing
  // -------------------------------------------------------------------------

  /**
   * Process one event inside its own transaction. Locks the event row FOR
   * UPDATE first — a concurrent ingest/replay on the same event serializes
   * here and observes the winner's committed status.
   */
  async processEventTx(
    tx: Prisma.TransactionClient,
    ctx: { tenantId: string; staffId?: string | null },
    eventId: string,
    actor: Actor,
  ): Promise<{ status: EventStatus; readingId?: string }> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM raw_remote_event
      WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${eventId}::uuid
      FOR UPDATE`;
    if (locked.length === 0) throw new NotFoundException({ code: 'REMOTE_EVENT_NOT_FOUND' });
    const event = await tx.rawRemoteEvent.findFirstOrThrow({
      where: { tenantId: ctx.tenantId, id: eventId },
    });
    // Terminal states never re-enter the pipeline.
    if (event.processingStatus === 'CONVERTED' || event.processingStatus === 'IGNORED') {
      return { status: event.processingStatus };
    }

    const source = await tx.remoteSource.findFirstOrThrow({
      where: { tenantId: ctx.tenantId, id: event.remoteSourceId },
      select: { timezone: true },
    });
    const { device, binding, installation } = await this.resolveBindingChain(
      tx,
      ctx.tenantId,
      event,
    );
    if (!device || !binding || !installation) {
      const code = !device
        ? 'DEVICE_NOT_FOUND'
        : device.status !== 'ACTIVE'
          ? 'DEVICE_DISABLED'
          : !binding
            ? 'NO_EFFECTIVE_BINDING'
            : 'INSTALLATION_NOT_FOUND';
      await this.transition(tx, ctx, event, 'UNBOUND', actor, {
        code,
        resolvedRemoteDeviceId: device?.id,
      });
      return { status: 'UNBOUND' };
    }

    const resolved = await this.resolvePlanItem(
      tx,
      ctx.tenantId,
      installation.waterAccountId,
      event.businessPeriod,
      binding.installationId,
    );
    if (resolved.status === 'NONE') {
      await this.transition(tx, ctx, event, 'WAITING_PLAN', actor, {
        code: 'PLAN_ITEM_NOT_FOUND',
        resolvedRemoteDeviceId: device.id,
        resolvedBindingId: binding.id,
      });
      return { status: 'WAITING_PLAN' };
    }
    if (resolved.status === 'AMBIGUOUS') {
      await this.transition(tx, ctx, event, 'FAILED', actor, {
        code: 'PLAN_ITEM_AMBIGUOUS',
        message: `${resolved.count} plan items match account+period; cannot pick uniquely`,
        resolvedRemoteDeviceId: device.id,
        resolvedBindingId: binding.id,
      });
      return { status: 'FAILED' };
    }
    const item = resolved.item;
    const plan = await tx.readingPlan.findFirstOrThrow({
      where: { tenantId: ctx.tenantId, id: item.planId },
      select: { id: true, period: true, status: true },
    });

    // Serialize against a concurrent manual entry BEFORE judging state:
    // lock the plan item, then re-read status/completedReadingId under the
    // lock — the conflict matrix must never run on a pre-lock snapshot.
    await tx.$queryRaw`
      SELECT id FROM reading_plan_item
      WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${item.id}::uuid
      FOR UPDATE`;
    const fresh = await tx.readingPlanItem.findFirstOrThrow({
      where: { tenantId: ctx.tenantId, id: item.id },
      select: { id: true, planId: true, status: true, completedReadingId: true },
    });

    // Conflict matrix (design §30): the item's completed reading decides
    // whether this remote fact is a fresh write, a correction after a
    // rejected QC verdict, or a human review case.
    if (fresh.status === 'READ' && fresh.completedReadingId) {
      const completed = await tx.meterReading.findFirst({
        where: { tenantId: ctx.tenantId, id: fresh.completedReadingId },
        select: { id: true, qcStatus: true, resultType: true, installationId: true, meterId: true },
      });
      if (completed && completed.qcStatus !== 'REJECTED') {
        await this.transition(tx, ctx, event, 'CONFLICT', actor, {
          code:
            completed.resultType === 'REMOTE' ? 'REMOTE_VS_REMOTE' : 'REMOTE_VS_ACTUAL',
          resolvedRemoteDeviceId: device.id,
          resolvedBindingId: binding.id,
          detail: { completedReadingId: completed.id, qcStatus: completed.qcStatus },
        });
        return { status: 'CONFLICT' };
      }
      // Rejected fact → the remote reading supersedes it (append-only).
      const reading = await this.writeCorrectionTx(tx, ctx, {
        event,
        itemId: item.id,
        original: completed!,
        period: plan.period,
        readDate: localDateOf(event.collectedAt, source.timezone),
      });
      await this.transition(tx, ctx, event, 'CONVERTED', actor, {
        resolvedRemoteDeviceId: device.id,
        resolvedBindingId: binding.id,
        detail: {
          readingId: reading.id,
          mode: 'CORRECTION',
          supersedesReadingId: completed!.id,
        },
      });
      return { status: 'CONVERTED', readingId: reading.id };
    }

    const readDate = localDateOf(event.collectedAt, source.timezone);
    const late = plan.status === 'DONE' || plan.status === 'CLOSED';
    const reading = await this.writeReadingTx(tx, ctx, {
      event,
      item: fresh,
      plan,
      installation,
      readDate,
      late,
    });
    await this.transition(tx, ctx, event, 'CONVERTED', actor, {
      resolvedRemoteDeviceId: device.id,
      resolvedBindingId: binding.id,
      detail: { readingId: reading.id, mode: late ? 'LATE_RECOVERY' : 'NORMAL' },
    });
    return { status: 'CONVERTED', readingId: reading.id };
  }

  /**
   * RemoteReadingWriter — create the REMOTE reading + flip the plan item.
   * Normal mode (plan OPEN/IN_PROGRESS): guarded PENDING|NO_READ→READ flip
   * races a manual entry for the same item; the loser sees count=0 → the
   * event lands CONFLICT on its next pass. Late-recovery mode (plan
   * DONE/CLOSED): the item was estimated (NO_READ) or unread — repoint
   * completed_reading_id at the remote fact; plan status is left alone.
   */
  private async writeReadingTx(
    tx: Prisma.TransactionClient,
    ctx: { tenantId: string; staffId?: string | null },
    args: {
      event: { id: string; readingValue: Prisma.Decimal };
      item: { id: string; status: string };
      plan: { id: string; period: string; status: string };
      installation: { id: string; meterId: string };
      readDate: Date;
      late: boolean;
    },
  ) {
    const { event, item, plan, installation, readDate, late } = args;
    // The caller holds the plan-item FOR UPDATE lock (see processEventTx)
    // — the guarded status flip below is the atomic backstop either way.
    const reading = await tx.meterReading.create({
      data: {
        tenantId: ctx.tenantId,
        planItemId: item.id,
        installationId: installation.id,
        meterId: installation.meterId,
        period: plan.period,
        readDate,
        resultType: 'REMOTE',
        readingValue: event.readingValue,
        qcStatus: 'PENDING',
        source: 'REMOTE',
        sourceEventId: event.id,
        operatorId: null,
        createdBy: ctx.staffId ?? null,
        updatedBy: ctx.staffId ?? null,
      },
      select: { id: true },
    });
    if (late) {
      // Late recovery: item may be PENDING (plan closed early), NO_READ
      // (estimated) or SKIPPED. READ means a fact already landed — the
      // conflict matrix guards that case before we ever get here.
      const flipped = await tx.readingPlanItem.updateMany({
        where: {
          tenantId: ctx.tenantId,
          id: item.id,
          status: { in: ['PENDING', 'NO_READ', 'SKIPPED'] },
        },
        data: { status: 'READ', completedReadingId: reading.id, updatedBy: ctx.staffId ?? null },
      });
      if (flipped.count === 0) {
        throw new ConflictException({ code: 'ITEM_ALREADY_DONE', status: item.status });
      }
    } else {
      const flipped = await tx.readingPlanItem.updateMany({
        where: {
          tenantId: ctx.tenantId,
          id: item.id,
          status: { in: ['PENDING', 'NO_READ', 'SKIPPED'] },
        },
        data: { status: 'READ', completedReadingId: reading.id, updatedBy: ctx.staffId ?? null },
      });
      if (flipped.count === 0) {
        throw new ConflictException({ code: 'ITEM_ALREADY_DONE', status: item.status });
      }
      // Plan progress: OPEN→IN_PROGRESS; →DONE when the last PENDING lands —
      // mirrors MeterReadingService.advancePlans (lock first so two
      // concurrent "last item" writes can't both see PENDING=1).
      await tx.$queryRaw`
        SELECT id FROM reading_plan
        WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${plan.id}::uuid
        FOR UPDATE`;
      await tx.readingPlan.updateMany({
        where: { tenantId: ctx.tenantId, id: plan.id, status: 'OPEN' },
        data: { status: 'IN_PROGRESS', updatedBy: ctx.staffId ?? null },
      });
      const pending = await tx.readingPlanItem.count({
        where: { tenantId: ctx.tenantId, planId: plan.id, status: 'PENDING' },
      });
      if (pending === 0) {
        await tx.readingPlan.updateMany({
          where: {
            tenantId: ctx.tenantId,
            id: plan.id,
            status: { in: ['OPEN', 'IN_PROGRESS'] },
          },
          data: { status: 'DONE', updatedBy: ctx.staffId ?? null },
        });
      }
    }
    return reading;
  }

  /**
   * Correction write — a new REMOTE fact superseding an existing reading
   * (rejected-QC redo or a CONFLICT resolved USE_REMOTE). The plan item's
   * completed_reading_id re-points at the new row; item status is left
   * READ. Callers hold the item lock before invoking.
   */
  private async writeCorrectionTx(
    tx: Prisma.TransactionClient,
    ctx: { tenantId: string; staffId?: string | null },
    args: {
      event: { id: string; readingValue: Prisma.Decimal };
      itemId: string;
      original: { id: string; installationId: string; meterId: string };
      period: string;
      readDate: Date;
    },
  ) {
    const { event, itemId, original, period, readDate } = args;
    const reading = await tx.meterReading.create({
      data: {
        tenantId: ctx.tenantId,
        planItemId: itemId,
        installationId: original.installationId,
        meterId: original.meterId,
        period,
        readDate,
        resultType: 'REMOTE',
        readingValue: event.readingValue,
        qcStatus: 'PENDING',
        source: 'REMOTE',
        sourceEventId: event.id,
        operatorId: null,
        supersedesReadingId: original.id,
        createdBy: ctx.staffId ?? null,
        updatedBy: ctx.staffId ?? null,
      },
      select: { id: true },
    });
    await tx.readingPlanItem.update({
      where: { tenantId_id: { tenantId: ctx.tenantId, id: itemId } },
      data: { completedReadingId: reading.id, updatedBy: ctx.staffId ?? null },
    });
    return reading;
  }

  // -------------------------------------------------------------------------
  // replay + conflict resolution
  // -------------------------------------------------------------------------

  /**
   * Operator actions (replay / resolve-conflict) are writes — they must
   * respect the event source's org scope, same as reads do. The pipeline's
   * own SYSTEM-driven transitions never reach this guard (no caller org).
   */
  private async assertEventInScope(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    event: { remoteSourceId: string },
  ) {
    const source = await tx.remoteSource.findFirstOrThrow({
      where: { tenantId: ctx.tenantId, id: event.remoteSourceId },
      select: { orgUnitId: true },
    });
    if (!orgInScope(ctx, source.orgUnitId)) {
      throw new ForbiddenException({ code: 'ORG_OUT_OF_SCOPE' });
    }
  }

  /**
   * POST /remote-events/:id/replay — explicit operator replay from
   * UNBOUND/FAILED/WAITING_PLAN only. The replay itself is logged, then the
   * event re-runs the full pipeline under the same row lock.
   */
  async replayTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    eventId: string,
  ) {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM raw_remote_event
      WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${eventId}::uuid
      FOR UPDATE`;
    if (locked.length === 0) throw new NotFoundException({ code: 'REMOTE_EVENT_NOT_FOUND' });
    const event = await tx.rawRemoteEvent.findFirstOrThrow({
      where: { tenantId: ctx.tenantId, id: eventId },
    });
    await this.assertEventInScope(tx, ctx, event);
    if (!REPLAYABLE.includes(event.processingStatus as EventStatus)) {
      throw new ConflictException({
        code: 'REMOTE_EVENT_NOT_REPLAYABLE',
        status: event.processingStatus,
      });
    }
    await this.log(tx, {
      tenantId: ctx.tenantId,
      remoteEventId: eventId,
      action: 'REPLAY',
      fromStatus: event.processingStatus as EventStatus,
      actor: userActor(ctx.staffId),
    });
    // Reprocess under the same lock; status transitions from here are the
    // processor's (SYSTEM actor — the human intent is the REPLAY row above).
    const result = await this.processEventTx(tx, ctx, eventId, SYSTEM);
    return { id: eventId, status: result.status, readingId: result.readingId };
  }

  /**
   * POST /remote-events/:id/resolve-conflict — CONFLICT only.
   *   USE_REMOTE  → supersede-style correction reading (REMOTE fact
   *     supersedes the completed one) → event CONVERTED.
   *   KEEP_ACTUAL → event IGNORED (the only path into IGNORED).
   */
  async resolveConflictTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    eventId: string,
    decision: 'USE_REMOTE' | 'KEEP_ACTUAL',
    note?: string,
  ) {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM raw_remote_event
      WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${eventId}::uuid
      FOR UPDATE`;
    if (locked.length === 0) throw new NotFoundException({ code: 'REMOTE_EVENT_NOT_FOUND' });
    const event = await tx.rawRemoteEvent.findFirstOrThrow({
      where: { tenantId: ctx.tenantId, id: eventId },
    });
    await this.assertEventInScope(tx, ctx, event);
    if (event.processingStatus !== 'CONFLICT') {
      throw new ConflictException({
        code: 'REMOTE_EVENT_NOT_IN_CONFLICT',
        status: event.processingStatus,
      });
    }
    const actor = userActor(ctx.staffId);

    if (decision === 'KEEP_ACTUAL') {
      await this.transition(tx, ctx, event, 'IGNORED', actor, {
        action: 'CONFLICT_RESOLVED',
        detail: { decision, note: note ?? null },
      });
      return { id: eventId, status: 'IGNORED' as const };
    }

    // USE_REMOTE: a correction row supersedes the item's current completed
    // reading (append-only chain — the actual fact row is never rewritten).
    if (!event.resolvedBindingId) {
      throw new ConflictException({ code: 'REMOTE_EVENT_UNRESOLVED' });
    }
    const binding = await tx.remoteDeviceBinding.findFirstOrThrow({
      where: { tenantId: ctx.tenantId, id: event.resolvedBindingId },
      select: { installationId: true },
    });
    const installation = await tx.meterInstallation.findFirstOrThrow({
      where: { tenantId: ctx.tenantId, id: binding.installationId },
      select: { id: true, waterAccountId: true, meterId: true },
    });
    const resolved = await this.resolvePlanItem(
      tx,
      ctx.tenantId,
      installation.waterAccountId,
      event.businessPeriod,
      binding.installationId,
    );
    if (resolved.status !== 'OK') {
      throw new ConflictException({ code: 'PLAN_ITEM_AMBIGUOUS' });
    }
    const item = resolved.item;
    const plan = await tx.readingPlan.findFirstOrThrow({
      where: { tenantId: ctx.tenantId, id: item.planId },
      select: { id: true, period: true },
    });
    await tx.$queryRaw`
      SELECT id FROM reading_plan_item
      WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${item.id}::uuid
      FOR UPDATE`;
    // Re-read under the lock — a manual write committed between the
    // unlocked candidate scan and this lock must not be missed.
    const fresh = await tx.readingPlanItem.findFirstOrThrow({
      where: { tenantId: ctx.tenantId, id: item.id },
      select: { completedReadingId: true },
    });
    const original = fresh.completedReadingId
      ? await tx.meterReading.findFirst({
          where: { tenantId: ctx.tenantId, id: fresh.completedReadingId },
          select: { id: true, installationId: true, meterId: true },
        })
      : null;
    if (!original) {
      throw new ConflictException({ code: 'REMOTE_EVENT_UNRESOLVED' });
    }
    const source = await tx.remoteSource.findFirstOrThrow({
      where: { tenantId: ctx.tenantId, id: event.remoteSourceId },
      select: { timezone: true },
    });
    const reading = await this.writeCorrectionTx(tx, ctx, {
      event,
      itemId: item.id,
      original,
      period: plan.period,
      readDate: localDateOf(event.collectedAt, source.timezone),
    });
    await this.transition(tx, ctx, event, 'CONVERTED', actor, {
      action: 'CONFLICT_RESOLVED',
      detail: {
        decision,
        note: note ?? null,
        readingId: reading.id,
        supersedesReadingId: original.id,
      },
    });
    return { id: eventId, status: 'CONVERTED' as const, readingId: reading.id };
  }
}
