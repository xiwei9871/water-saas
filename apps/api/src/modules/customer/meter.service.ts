import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { conflictOnUnique } from '../../common/prisma-errors.js';
import type { TenantCtx } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { SequenceService } from '../../common/sequence.service.js';

export type MeterStatus = 'AVAILABLE' | 'INSTALLED' | 'MAINTENANCE' | 'RETIRED';

export const METER_SELECT = {
  id: true,
  tenantId: true,
  meterNo: true,
  serialNo: true,
  barcode: true,
  brand: true,
  model: true,
  caliber: true,
  maxDial: true,
  parentMeterId: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.MeterSelect;

/**
 * Meter lifecycle (spec §2.7): AVAILABLE → INSTALLED → MAINTENANCE →
 * AVAILABLE | RETIRED. PATCH may only move a meter between *inventory*
 * states. Every transition OUT of INSTALLED goes through
 * POST /meter-installations/:id/remove — that's where final_reading is
 * recorded; bypassing it via PATCH would silently lose consumption data
 * (INSTALLED→MAINTENANCE/AVAILABLE/RETIRED all blocked here for the same
 * reason: pull the meter first, then repair or scrap it).
 */
const PATCH_TRANSITIONS: Record<MeterStatus, MeterStatus[]> = {
  AVAILABLE: ['MAINTENANCE', 'RETIRED'],
  INSTALLED: [],
  MAINTENANCE: ['AVAILABLE', 'RETIRED'],
  RETIRED: [],
};

export interface MeterBody {
  /** Explicit meter_no; absent → sys_sequence allocates (prefix 'M'). */
  meterNo?: string;
  serialNo?: string;
  barcode?: string;
  brand?: string;
  model?: string;
  caliber?: string;
  maxDial?: Prisma.Decimal;
}

export interface MeterPatchBody extends MeterBody {
  status?: MeterStatus;
}

/** Meter （水表） — the physical device. "Where it is" lives only in
 *  meter_installation; status describes device availability (spec §2.1). */
@Injectable()
export class MeterService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly seq: SequenceService,
  ) {}

  list(
    ctx: TenantCtx,
    q: { take: number; skip: number; status?: MeterStatus; q?: string },
  ) {
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.meter.findMany({
        where: {
          tenantId: ctx.tenantId,
          status: q.status,
          // Device-pick search — the registry can exceed one picker page.
          ...(q.q
            ? {
                OR: [
                  { meterNo: { contains: q.q } },
                  { serialNo: { contains: q.q } },
                  { barcode: { contains: q.q } },
                  { brand: { contains: q.q } },
                  { model: { contains: q.q } },
                ],
              }
            : {}),
        },
        select: METER_SELECT,
        orderBy: { meterNo: 'asc' },
        take: q.take,
        skip: q.skip,
      }),
    );
  }

  async getById(ctx: TenantCtx, id: string) {
    const row = await this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.meter.findFirst({
        where: { tenantId: ctx.tenantId, id },
        select: {
          ...METER_SELECT,
          installations: {
            select: {
              id: true,
              waterAccountId: true,
              installedAt: true,
              removedAt: true,
              initialReading: true,
              finalReading: true,
              reason: true,
              status: true,
              waterAccount: { select: { accountNo: true } },
            },
            orderBy: { installedAt: 'desc' },
          },
        },
      }),
    );
    if (!row) throw new NotFoundException({ code: 'METER_NOT_FOUND' });
    return row;
  }

  /** Register a device in inventory — always lands AVAILABLE. */
  async createTx(tx: Prisma.TransactionClient, ctx: TenantCtx, body: MeterBody) {
    const meterNo =
      body.meterNo?.trim() ||
      (await this.seq.nextFormatted(tx, ctx.tenantId, 'meter_no', 'M', ctx.staffId));
    return conflictOnUnique(
      tx.meter.create({
        data: {
          tenantId: ctx.tenantId,
          meterNo,
          serialNo: body.serialNo,
          barcode: body.barcode,
          brand: body.brand,
          model: body.model,
          caliber: body.caliber,
          maxDial: body.maxDial,
          status: 'AVAILABLE',
          createdBy: ctx.staffId,
          updatedBy: ctx.staffId,
        },
        select: METER_SELECT,
      }),
    );
  }

  async updateTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    id: string,
    body: MeterPatchBody,
    req: Request,
  ) {
    const existing = await tx.meter.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!existing) throw new NotFoundException({ code: 'METER_NOT_FOUND' });
    if (body.status !== undefined && body.status !== existing.status) {
      const allowed = PATCH_TRANSITIONS[existing.status as MeterStatus];
      if (!allowed.includes(body.status)) {
        throw new ConflictException({
          code: 'INVALID_METER_STATUS_TRANSITION',
          from: existing.status,
          to: body.status,
        });
      }
    }
    req.auditBefore = existing;
    return tx.meter.update({
      where: { tenantId_id: { tenantId: ctx.tenantId, id } },
      data: {
        serialNo: body.serialNo,
        barcode: body.barcode,
        brand: body.brand,
        model: body.model,
        caliber: body.caliber,
        maxDial: body.maxDial,
        status: body.status,
        updatedBy: ctx.staffId,
      },
      select: METER_SELECT,
    });
  }
}
