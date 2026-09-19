import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import type { TenantCtx } from '../../common/tenant-context.js';
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
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.meterInstallation.findMany({
        where: {
          tenantId: ctx.tenantId,
          waterAccountId: q.waterAccountId,
          meterId: q.meterId,
          status: q.status,
        },
        select: { ...INSTALLATION_SELECT, ...INSTALLATION_INCLUDE },
        orderBy: { installedAt: 'desc' },
        take: q.take,
        skip: q.skip,
      }),
    );
  }

  async getById(ctx: TenantCtx, id: string) {
    const row = await this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.meterInstallation.findFirst({
        where: { tenantId: ctx.tenantId, id },
        select: { ...INSTALLATION_SELECT, ...INSTALLATION_INCLUDE },
      }),
    );
    if (!row) throw new NotFoundException({ code: 'INSTALLATION_NOT_FOUND' });
    return row;
  }

  /**
   * Install/reinstall: meter must exist and be AVAILABLE (the state machine's
   * only path to INSTALLED). Runs inside the caller's tenant tx.
   */
  async installTx(tx: Prisma.TransactionClient, ctx: TenantCtx, body: InstallBody) {
    const account = await tx.waterAccount.findFirst({
      where: { tenantId: ctx.tenantId, id: body.waterAccountId },
    });
    if (!account) {
      throw new BadRequestException({ code: 'WATER_ACCOUNT_NOT_FOUND' });
    }
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
    if (existing.status !== 'ACTIVE') {
      throw new ConflictException({ code: 'INSTALLATION_NOT_ACTIVE' });
    }
    if (body.finalReading.lessThan(existing.initialReading)) {
      throw new BadRequestException({
        code: 'FINAL_READING_BEFORE_INITIAL',
        initialReading: existing.initialReading.toString(),
        finalReading: body.finalReading.toString(),
      });
    }
    req.auditBefore = existing;

    // Guarded transition (see installTx): a concurrent remove loses the race
    // here instead of overwriting the winner's final_reading.
    const flipped = await tx.meterInstallation.updateMany({
      where: { tenantId: ctx.tenantId, id, status: 'ACTIVE' },
      data: {
        status: 'REMOVED',
        removedAt: body.removedAt ?? new Date(),
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
    return tx.meterInstallation.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: ctx.tenantId, id } },
      select: { ...INSTALLATION_SELECT, ...INSTALLATION_INCLUDE },
    });
  }
}
