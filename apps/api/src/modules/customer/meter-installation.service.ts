import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import type { TenantCtx } from '../../common/tenant-context.js';
import {
  assertAccountScopeTx,
  outOfScopeAccountIds,
} from '../../common/account-scope.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';

export const INSTALLATION_SELECT = {
  id: true,
  tenantId: true,
  waterAccountId: true,
  meterId: true,
  installedAt: true,
  removedAt: true,
  initialReading: true,
  finalReading: true,
  reason: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.MeterInstallationSelect;

const INSTALLATION_INCLUDE = {
  meter: { select: { id: true, meterNo: true, status: true, brand: true, model: true } },
  waterAccount: { select: { id: true, accountNo: true, status: true } },
} satisfies Prisma.MeterInstallationInclude;

export interface InstallBody {
  waterAccountId: string;
  meterId: string;
  initialReading: Prisma.Decimal;
  installedAt?: Date;
  reason?: 'NEW' | 'REPLACE' | 'FAULT' | 'PERIODIC_CHECK';
}

export interface RemoveBody {
  finalReading: Prisma.Decimal;
  removedAt?: Date;
}

export interface ReplaceBody {
  newMeterId: string;
  /** 旧表止码 — belongs to the OLD installation's own dial chain. */
  oldFinalReading: Prisma.Decimal;
  /** 新表始码 — independent physical dial; never defaults to oldFinalReading. */
  newInitialReading: Prisma.Decimal;
  replacedAt?: Date;
  reason?: 'REPLACE' | 'FAULT' | 'PERIODIC_CHECK';
}

/**
 * MeterInstallation （安装关系） — one row = one meter mounted on one water
 * account for a time span (spec §2.1). The schema deliberately allows several
 * ACTIVE installations per account （一户多表 phase-2); the MVP UI limits to
 * one, the API does not.
 *
 * Lifecycle: install → ACTIVE (meter AVAILABLE→INSTALLED); remove → REMOVED
 * (removedAt + final_reading, meter →AVAILABLE so it can be reinstalled).
 */
@Injectable()
export class MeterInstallationService {
  constructor(private readonly prisma: TenantPrismaService) {}

  list(
    ctx: TenantCtx,
    q: {
      take: number;
      skip: number;
      waterAccountId?: string;
      meterId?: string;
      status?: 'ACTIVE' | 'REMOVED';
    },
  ) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      // Mutually exclusive filters: an explicit waterAccountId is a scoped
      // single-account read (403 when out of scope, strict equality
      // otherwise); only the unfiltered list applies the notIn exclusion.
      if (q.waterAccountId) {
        await assertAccountScopeTx(tx, ctx, q.waterAccountId);
      }
      const scopedIds =
        !q.waterAccountId && ctx.scope !== 'ALL'
          ? await outOfScopeAccountIds(tx, ctx)
          : null;
      return tx.meterInstallation.findMany({
        where: {
          tenantId: ctx.tenantId,
          ...(q.waterAccountId
            ? { waterAccountId: q.waterAccountId }
            : scopedIds && scopedIds.length > 0
              ? { waterAccountId: { notIn: scopedIds } }
              : {}),
          meterId: q.meterId,
          status: q.status,
        },
        select: { ...INSTALLATION_SELECT, ...INSTALLATION_INCLUDE },
        orderBy: { installedAt: 'desc' },
        take: q.take,
        skip: q.skip,
      });
    });
  }

  async getById(ctx: TenantCtx, id: string) {
    const row = await this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const r = await tx.meterInstallation.findFirst({
        where: { tenantId: ctx.tenantId, id },
        select: { ...INSTALLATION_SELECT, ...INSTALLATION_INCLUDE },
      });
      if (r) await assertAccountScopeTx(tx, ctx, r.waterAccountId);
      return r;
    });
    if (!row) throw new NotFoundException({ code: 'INSTALLATION_NOT_FOUND' });
    return row;
  }

  /**
   * Install/reinstall: meter must exist and be AVAILABLE (the state machine's
   * only path to INSTALLED). Runs inside the caller's tenant tx.
   *
   * E7 C1: the water_account row is locked FOR UPDATE first and its status
   * re-checked inside the lock — this serializes install against a
   * concurrent account close so `CLOSED + ACTIVE installation` can never
   * commit.
   */
  async installTx(tx: Prisma.TransactionClient, ctx: TenantCtx, body: InstallBody) {
    await assertAccountScopeTx(tx, ctx, body.waterAccountId);
    const account = await this.lockAccountForUpdateTx(tx, ctx, body.waterAccountId);
    if (account.status === 'CLOSED') {
      throw new ConflictException({ code: 'ACCOUNT_CLOSED' });
    }
    const meter = await tx.meter.findFirst({
      where: { tenantId: ctx.tenantId, id: body.meterId },
    });
    if (!meter) {
      throw new BadRequestException({ code: 'METER_NOT_FOUND' });
    }
    if (meter.status !== 'AVAILABLE') {
      throw new ConflictException({
        code: 'METER_NOT_AVAILABLE',
        status: meter.status,
      });
    }

    const installation = await tx.meterInstallation.create({
      data: {
        tenantId: ctx.tenantId,
        waterAccountId: body.waterAccountId,
        meterId: body.meterId,
        installedAt: body.installedAt ?? new Date(),
        initialReading: body.initialReading,
        reason: body.reason ?? 'NEW',
        status: 'ACTIVE',
        createdBy: ctx.staffId,
        updatedBy: ctx.staffId,
      },
    });
    // Guarded transition: the AVAILABLE check above is check-then-act, so the
    // state predicate is repeated in the UPDATE itself — a concurrent install
    // on the same meter loses the race here (count=0) instead of silently
    // producing two ACTIVE installations.
    const flipped = await tx.meter.updateMany({
      where: { tenantId: ctx.tenantId, id: body.meterId, status: 'AVAILABLE' },
      data: { status: 'INSTALLED', updatedBy: ctx.staffId },
    });
    if (flipped.count === 0) {
      throw new ConflictException({ code: 'METER_NOT_AVAILABLE' });
    }
    return tx.meterInstallation.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: ctx.tenantId, id: installation.id } },
      select: { ...INSTALLATION_SELECT, ...INSTALLATION_INCLUDE },
    });
  }

  /**
   * Remove （拆表）: final_reading is mandatory and must be ≥ initial_reading
   * (a rolled-back dial means the reading is wrong, not negative usage).
   * Installation → REMOVED, meter → AVAILABLE (re-installable per spec).
   */
  async removeTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    id: string,
    body: RemoveBody,
    req: Request,
  ) {
    const existing = await tx.meterInstallation.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!existing) throw new NotFoundException({ code: 'INSTALLATION_NOT_FOUND' });
    await assertAccountScopeTx(tx, ctx, existing.waterAccountId);
    // Uniform lock direction (E7 §10): water_account → installation →
    // meter → binding. The account lock serializes against close/install.
    await this.lockAccountForUpdateTx(tx, ctx, existing.waterAccountId);
    const removedAt = await this.assertRemovableTx(tx, ctx, existing, {
      finalReading: body.finalReading,
      at: body.removedAt,
    });
    req.auditBefore = existing;

    // Guarded transition (see installTx): a concurrent remove/replace loses
    // the race here instead of overwriting the winner's final_reading.
    const flipped = await tx.meterInstallation.updateMany({
      where: { tenantId: ctx.tenantId, id, status: 'ACTIVE' },
      data: {
        status: 'REMOVED',
        removedAt,
        finalReading: body.finalReading,
        updatedBy: ctx.staffId,
      },
    });
    if (flipped.count === 0) {
      throw new ConflictException({ code: 'INSTALLATION_NOT_ACTIVE' });
    }
    await tx.meter.update({
      where: { tenantId_id: { tenantId: ctx.tenantId, id: existing.meterId } },
      data: { status: 'AVAILABLE', updatedBy: ctx.staffId },
    });
    await this.closeBindingsTx(tx, ctx, id, removedAt);
    return tx.meterInstallation.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: ctx.tenantId, id } },
      select: { ...INSTALLATION_SELECT, ...INSTALLATION_INCLUDE },
    });
  }

  /**
   * Replace （换表） — atomic remove+install in ONE transaction (E7 §3).
   * The two readings belong to two different physical dials and are both
   * explicit inputs; nothing defaults newInitialReading to oldFinalReading.
   * Bindings close on the old installation and are NEVER migrated — the
   * remote device is a physical fact that needs explicit re-binding.
   */
  async replaceTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    id: string,
    body: ReplaceBody,
    req: Request,
  ) {
    const existing = await tx.meterInstallation.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!existing) throw new NotFoundException({ code: 'INSTALLATION_NOT_FOUND' });
    await assertAccountScopeTx(tx, ctx, existing.waterAccountId);
    if (existing.meterId === body.newMeterId) {
      throw new BadRequestException({ code: 'SAME_METER_REPLACE' });
    }
    const account = await this.lockAccountForUpdateTx(
      tx,
      ctx,
      existing.waterAccountId,
    );
    if (account.status === 'CLOSED') {
      throw new ConflictException({ code: 'ACCOUNT_CLOSED' });
    }
    // Recheck on the locked row — a concurrent remove/replace may have
    // already closed this installation since the head read.
    const lockedRows = await tx.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM meter_installation
      WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${id}::uuid
      FOR UPDATE`;
    if (!lockedRows.length) {
      throw new NotFoundException({ code: 'INSTALLATION_NOT_FOUND' });
    }
    if (lockedRows[0].status !== 'ACTIVE') {
      throw new ConflictException({ code: 'INSTALLATION_NOT_ACTIVE' });
    }
    const at = await this.assertRemovableTx(tx, ctx, existing, {
      finalReading: body.oldFinalReading,
      at: body.replacedAt,
    });
    const oldMeter = await tx.meter.findFirst({
      where: { tenantId: ctx.tenantId, id: existing.meterId },
      select: { id: true, status: true },
    });
    if (!oldMeter || oldMeter.status !== 'INSTALLED') {
      throw new ConflictException({
        code: 'METER_NOT_INSTALLED',
        status: oldMeter?.status ?? 'gone',
      });
    }
    const newMeter = await tx.meter.findFirst({
      where: { tenantId: ctx.tenantId, id: body.newMeterId },
    });
    if (!newMeter) throw new BadRequestException({ code: 'METER_NOT_FOUND' });
    if (newMeter.status !== 'AVAILABLE') {
      throw new ConflictException({
        code: 'METER_NOT_AVAILABLE',
        status: newMeter.status,
      });
    }
    req.auditBefore = existing;

    const flipped = await tx.meterInstallation.updateMany({
      where: { tenantId: ctx.tenantId, id, status: 'ACTIVE' },
      data: {
        status: 'REMOVED',
        removedAt: at,
        finalReading: body.oldFinalReading,
        updatedBy: ctx.staffId,
      },
    });
    if (flipped.count === 0) {
      throw new ConflictException({ code: 'INSTALLATION_NOT_ACTIVE' });
    }
    const oldFlip = await tx.meter.updateMany({
      where: {
        tenantId: ctx.tenantId,
        id: existing.meterId,
        status: 'INSTALLED',
      },
      data: { status: 'AVAILABLE', updatedBy: ctx.staffId },
    });
    if (oldFlip.count === 0) {
      throw new ConflictException({ code: 'METER_NOT_INSTALLED' });
    }
    const newFlip = await tx.meter.updateMany({
      where: { tenantId: ctx.tenantId, id: body.newMeterId, status: 'AVAILABLE' },
      data: { status: 'INSTALLED', updatedBy: ctx.staffId },
    });
    if (newFlip.count === 0) {
      throw new ConflictException({ code: 'METER_NOT_AVAILABLE' });
    }
    await this.closeBindingsTx(tx, ctx, id, at);
    const installation = await tx.meterInstallation.create({
      data: {
        tenantId: ctx.tenantId,
        waterAccountId: existing.waterAccountId,
        meterId: body.newMeterId,
        installedAt: at,
        initialReading: body.newInitialReading,
        reason: body.reason ?? 'REPLACE',
        status: 'ACTIVE',
        createdBy: ctx.staffId,
        updatedBy: ctx.staffId,
      },
      select: { ...INSTALLATION_SELECT, ...INSTALLATION_INCLUDE },
    });
    // Replacement lineage — set only when the new meter has no parent yet.
    await tx.meter.updateMany({
      where: {
        tenantId: ctx.tenantId,
        id: body.newMeterId,
        parentMeterId: null,
      },
      data: { parentMeterId: existing.meterId, updatedBy: ctx.staffId },
    });
    // Canonical post-write snapshot — audit-after and the API response must
    // reflect committed columns, not the stale head read.
    const removed = await tx.meterInstallation.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: ctx.tenantId, id } },
      select: { ...INSTALLATION_SELECT, ...INSTALLATION_INCLUDE },
    });
    return { removed, installed: installation };
  }

  // -----------------------------------------------------------------------
  // internals
  // -----------------------------------------------------------------------

  /**
   * `SELECT … FOR UPDATE` on water_account — the first lock in the E7
   * order. Serializes meter ops against account close (C1) and lets the
   * caller re-read status on the locked row.
   */
  private async lockAccountForUpdateTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    waterAccountId: string,
  ): Promise<{ status: string }> {
    const rows = await tx.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM water_account
      WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${waterAccountId}::uuid
      FOR UPDATE`;
    if (!rows.length) {
      throw new BadRequestException({ code: 'WATER_ACCOUNT_NOT_FOUND' });
    }
    return rows[0];
  }

  /**
   * Shared removal leg for removeTx/replaceTx: reading-domain checks +
   * fail-closed period check (RC audit I-2 — a removal dated into a FINAL
   * settlement or posted-debt period would orphan the final_reading delta
   * above the settled chain-end). Returns the effective removal instant.
   */
  private async assertRemovableTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    existing: {
      waterAccountId: string;
      installedAt: Date;
      initialReading: Prisma.Decimal;
      status: string;
    },
    args: { finalReading: Prisma.Decimal; at?: Date },
  ): Promise<Date> {
    if (existing.status !== 'ACTIVE') {
      throw new ConflictException({ code: 'INSTALLATION_NOT_ACTIVE' });
    }
    if (args.finalReading.lessThan(existing.initialReading)) {
      throw new BadRequestException({
        code: 'FINAL_READING_BEFORE_INITIAL',
        initialReading: existing.initialReading.toString(),
        finalReading: args.finalReading.toString(),
      });
    }
    const at = args.at ?? new Date();
    if (at < existing.installedAt) {
      throw new BadRequestException({
        code: 'REMOVE_BEFORE_INSTALL',
        installedAt: existing.installedAt,
      });
    }
    const period = `${at.getUTCFullYear()}${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
    const [finalized, posted] = await Promise.all([
      tx.consumptionSettlement.findFirst({
        where: {
          tenantId: ctx.tenantId,
          waterAccountId: existing.waterAccountId,
          period,
          status: 'FINAL',
        },
        select: { id: true },
      }),
      tx.bill.findFirst({
        where: {
          tenantId: ctx.tenantId,
          waterAccountId: existing.waterAccountId,
          period,
          status: { in: ['POSTED', 'PARTIAL_PAID', 'PAID'] },
        },
        select: { id: true },
      }),
    ]);
    if (finalized || posted) {
      throw new ConflictException({
        code: 'SETTLEMENT_PERIOD_ALREADY_FINALIZED',
        period,
      });
    }
    return at;
  }

  /**
   * E5 T3 binding close, shared by removeTx/replaceTx: bindings ending
   * after `at` (or open-ended) are closed at `at`; a resolved event
   * collected after `at` refuses the whole operation (orphan provenance).
   */
  private async closeBindingsTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    installationId: string,
    at: Date,
  ) {
    const closable = await tx.remoteDeviceBinding.findMany({
      where: {
        tenantId: ctx.tenantId,
        installationId,
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
      },
      select: { id: true },
    });
    if (closable.length === 0) return;
    const orphan = await tx.rawRemoteEvent.findFirst({
      where: {
        tenantId: ctx.tenantId,
        resolvedBindingId: { in: closable.map((b) => b.id) },
        collectedAt: { gte: at },
      },
      select: { id: true },
    });
    if (orphan) {
      throw new ConflictException({
        code: 'BINDING_CLOSE_ORPHANS_EVENT',
        eventId: orphan.id,
      });
    }
    await tx.remoteDeviceBinding.updateMany({
      where: { tenantId: ctx.tenantId, id: { in: closable.map((b) => b.id) } },
      data: { effectiveTo: at, updatedBy: ctx.staffId },
    });
  }

}
