import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { conflictOnUnique, isUniqueViolation } from '../../common/prisma-errors.js';
import { orgInScope, type TenantCtx } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';

export const REMOTE_DEVICE_SELECT = {
  id: true,
  tenantId: true,
  remoteSourceId: true,
  vendorDeviceKey: true,
  vendorMeterNo: true,
  communicationId: true,
  model: true,
  status: true,
  metadata: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.RemoteDeviceSelect;

export const REMOTE_BINDING_SELECT = {
  id: true,
  tenantId: true,
  remoteSourceId: true,
  remoteDeviceId: true,
  installationId: true,
  effectiveFrom: true,
  effectiveTo: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.RemoteDeviceBindingSelect;

const INSTALLATION_SUMMARY = {
  id: true,
  waterAccountId: true,
  meterId: true,
  installedAt: true,
  removedAt: true,
  status: true,
  meter: { select: { meterNo: true } },
  waterAccount: { select: { accountNo: true } },
} satisfies Prisma.MeterInstallationSelect;

export interface RemoteDeviceBody {
  remoteSourceId?: string;
  vendorDeviceKey?: string;
  vendorMeterNo?: string | null;
  communicationId?: string | null;
  model?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface RemoteDevicePatchBody {
  status?: 'ACTIVE' | 'DISABLED';
  vendorMeterNo?: string | null;
  communicationId?: string | null;
  model?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface BindingBody {
  installationId?: string;
  effectiveFrom?: string;
  effectiveTo?: string | null;
}

export interface BindingPatchBody {
  effectiveTo?: string | null;
}

const outOfScope = () => new ForbiddenException({ code: 'ORG_OUT_OF_SCOPE' });

/**
 * Exclusion-constraint violation (Postgres 23P01) → 409, not a bare 500.
 * Prisma surfaces it as an UnknownRequestError whose message embeds the
 * sqlstate + constraint name — match on content, not the error class.
 */
const isOverlapViolation = (err: unknown): boolean => {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('23P01') ||
    /remote_device_binding_(device|installation)_range_excl/.test(msg);
};

const parseInstant = (v: string | undefined, field: string): Date => {
  if (!v) throw new BadRequestException({ code: 'BINDING_FIELDS_REQUIRED' });
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    throw new UnprocessableEntityException({ code: 'INVALID_TIMESTAMP', field });
  }
  return d;
};

/**
 * RemoteDevice + RemoteDeviceBinding (E5 T3).
 *
 * RemoteDevice is the vendor-side device identity — decoupled from Meter so
 * a comm-module swap is a re-binding, not a new meter. vendorDeviceKey +
 * remoteSourceId are create-time identity (immutable afterwards).
 *
 * RemoteDeviceBinding maps device → installation over a half-open
 * [effectiveFrom, effectiveTo) interval:
 *  - containment: effectiveFrom >= installation.installedAt and
 *    effectiveTo <= removedAt when the installation is REMOVED (domain
 *    service enforcement; overlap itself is a DB exclusion constraint).
 *  - closing a binding may never orphan a converted event that resolved
 *    through it: effectiveTo must stay > every resolved event collectedAt.
 *  - device/source/installation ids are immutable; only effectiveTo mutates
 *    (corrections to effectiveFrom retire the binding and mint a new one).
 *
 * Scope: device/binding writes inherit the source's org guard — the device
 * has no org of its own.
 */
@Injectable()
export class RemoteDeviceService {
  constructor(private readonly prisma: TenantPrismaService) {}

  // -------------------------------------------------------------------------
  // devices
  // -------------------------------------------------------------------------

  listDevices(
    ctx: TenantCtx,
    q: {
      take: number;
      skip: number;
      remoteSourceId?: string;
      q?: string;
      status?: string;
    },
  ) {
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.remoteDevice.findMany({
        where: {
          tenantId: ctx.tenantId,
          remoteSourceId: q.remoteSourceId,
          status: q.status as 'ACTIVE' | 'DISABLED' | undefined,
          OR: q.q
            ? [
                { vendorDeviceKey: { contains: q.q } },
                { vendorMeterNo: { contains: q.q } },
                { communicationId: { contains: q.q } },
              ]
            : undefined,
        },
        select: REMOTE_DEVICE_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: q.take,
        skip: q.skip,
      }),
    );
  }

  /** Device detail + its binding history (installation summary hydrated). */
  getDevice(ctx: TenantCtx, id: string) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const device = await tx.remoteDevice.findFirst({
        where: { tenantId: ctx.tenantId, id },
        select: REMOTE_DEVICE_SELECT,
      });
      if (!device) throw new NotFoundException({ code: 'REMOTE_DEVICE_NOT_FOUND' });
      const bindings = await tx.remoteDeviceBinding.findMany({
        where: { tenantId: ctx.tenantId, remoteDeviceId: id },
        select: REMOTE_BINDING_SELECT,
        orderBy: { effectiveFrom: 'asc' },
      });
      const installations = bindings.length
        ? await tx.meterInstallation.findMany({
            where: {
              tenantId: ctx.tenantId,
              id: { in: bindings.map((b) => b.installationId) },
            },
            select: INSTALLATION_SUMMARY,
          })
        : [];
      const instById = new Map(installations.map((i) => [i.id, i]));
      return {
        ...device,
        bindings: bindings.map((b) => ({
          ...b,
          installation: instById.get(b.installationId) ?? null,
        })),
      };
    });
  }

  /** The source's org guard, applied to device/binding writes. */
  private async assertSourceScope(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    remoteSourceId: string,
  ) {
    const source = await tx.remoteSource.findFirst({
      where: { tenantId: ctx.tenantId, id: remoteSourceId },
    });
    if (!source) throw new BadRequestException({ code: 'REMOTE_SOURCE_NOT_FOUND' });
    if (source.orgUnitId === null) {
      if (ctx.scope !== 'ALL') throw outOfScope();
    } else if (!orgInScope(ctx, source.orgUnitId)) {
      throw outOfScope();
    }
    return source;
  }

  private async assertDeviceInScope(tx: Prisma.TransactionClient, ctx: TenantCtx, id: string) {
    const device = await tx.remoteDevice.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!device) throw new NotFoundException({ code: 'REMOTE_DEVICE_NOT_FOUND' });
    await this.assertSourceScope(tx, ctx, device.remoteSourceId);
    return device;
  }

  /** POST /remote-devices — remoteSourceId + vendorDeviceKey required. */
  async createDeviceTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    body: RemoteDeviceBody,
  ) {
    if (!body.remoteSourceId || !body.vendorDeviceKey?.trim()) {
      throw new BadRequestException({ code: 'REMOTE_DEVICE_FIELDS_REQUIRED' });
    }
    await this.assertSourceScope(tx, ctx, body.remoteSourceId);
    return conflictOnUnique(
      tx.remoteDevice.create({
        data: {
          tenantId: ctx.tenantId,
          remoteSourceId: body.remoteSourceId,
          vendorDeviceKey: body.vendorDeviceKey.trim(),
          vendorMeterNo: body.vendorMeterNo?.trim() || null,
          communicationId: body.communicationId?.trim() || null,
          model: body.model?.trim() || null,
          metadata:
            body.metadata === undefined || body.metadata === null
              ? Prisma.JsonNull
              : (body.metadata as Prisma.InputJsonValue),
          createdBy: ctx.staffId,
          updatedBy: ctx.staffId,
        },
        select: REMOTE_DEVICE_SELECT,
      }),
    );
  }

  /** PATCH /remote-devices/:id — profile/status; vendorDeviceKey + source immutable. */
  async updateDeviceTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    id: string,
    body: RemoteDevicePatchBody,
    req: Request,
  ) {
    const existing = await this.assertDeviceInScope(tx, ctx, id);
    if (body.status !== undefined && !['ACTIVE', 'DISABLED'].includes(body.status)) {
      throw new UnprocessableEntityException({ code: 'INVALID_DEVICE_STATUS' });
    }
    req.auditBefore = existing;
    return tx.remoteDevice.update({
      where: { tenantId_id: { tenantId: ctx.tenantId, id } },
      data: {
        status: body.status,
        vendorMeterNo:
          body.vendorMeterNo === undefined ? undefined : body.vendorMeterNo?.trim() || null,
        communicationId:
          body.communicationId === undefined
            ? undefined
            : body.communicationId?.trim() || null,
        model: body.model === undefined ? undefined : body.model?.trim() || null,
        metadata:
          body.metadata === undefined
            ? undefined
            : body.metadata === null
              ? Prisma.JsonNull
              : (body.metadata as Prisma.InputJsonValue),
        updatedBy: ctx.staffId,
      },
      select: REMOTE_DEVICE_SELECT,
    });
  }

  // -------------------------------------------------------------------------
  // bindings
  // -------------------------------------------------------------------------

  listBindings(
    ctx: TenantCtx,
    q: { take: number; skip: number; remoteDeviceId?: string; installationId?: string },
  ) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const bindings = await tx.remoteDeviceBinding.findMany({
        where: {
          tenantId: ctx.tenantId,
          remoteDeviceId: q.remoteDeviceId,
          installationId: q.installationId,
        },
        select: REMOTE_BINDING_SELECT,
        orderBy: [{ effectiveFrom: 'asc' }, { id: 'asc' }],
        take: q.take,
        skip: q.skip,
      });
      const installations = bindings.length
        ? await tx.meterInstallation.findMany({
            where: {
              tenantId: ctx.tenantId,
              id: { in: bindings.map((b) => b.installationId) },
            },
            select: INSTALLATION_SUMMARY,
          })
        : [];
      const instById = new Map(installations.map((i) => [i.id, i]));
      return bindings.map((b) => ({ ...b, installation: instById.get(b.installationId) ?? null }));
    });
  }

  /**
   * POST /remote-devices/:id/bindings — installation containment enforced
   * in the domain service; interval overlap is the DB exclusion constraint
   * (mapped to 409 BINDING_OVERLAP here).
   */
  async createBindingTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    deviceId: string,
    body: BindingBody,
  ) {
    const device = await this.assertDeviceInScope(tx, ctx, deviceId);
    if (!body.installationId || !body.effectiveFrom) {
      throw new BadRequestException({ code: 'BINDING_FIELDS_REQUIRED' });
    }
    const effectiveFrom = parseInstant(body.effectiveFrom, 'effectiveFrom');
    const effectiveTo =
      body.effectiveTo === undefined || body.effectiveTo === null
        ? null
        : parseInstant(body.effectiveTo, 'effectiveTo');
    if (effectiveTo !== null && effectiveTo <= effectiveFrom) {
      throw new UnprocessableEntityException({ code: 'INVALID_BINDING_RANGE' });
    }
    const installation = await tx.meterInstallation.findFirst({
      where: { tenantId: ctx.tenantId, id: body.installationId },
      select: INSTALLATION_SUMMARY,
    });
    if (!installation) {
      throw new BadRequestException({ code: 'INSTALLATION_NOT_FOUND' });
    }
    // Containment: the binding may only cover the installation's own life.
    if (effectiveFrom < installation.installedAt) {
      throw new UnprocessableEntityException({
        code: 'BINDING_OUTSIDE_INSTALLATION',
        installedAt: installation.installedAt,
      });
    }
    if (installation.removedAt !== null && (effectiveTo === null || effectiveTo > installation.removedAt)) {
      throw new UnprocessableEntityException({
        code: 'BINDING_OUTSIDE_INSTALLATION',
        removedAt: installation.removedAt,
      });
    }
    try {
      return await tx.remoteDeviceBinding.create({
        data: {
          tenantId: ctx.tenantId,
          remoteSourceId: device.remoteSourceId,
          remoteDeviceId: device.id,
          installationId: installation.id,
          effectiveFrom,
          effectiveTo,
          createdBy: ctx.staffId,
          updatedBy: ctx.staffId,
        },
        select: REMOTE_BINDING_SELECT,
      });
    } catch (e) {
      if (isOverlapViolation(e)) {
        throw new ConflictException({ code: 'BINDING_OVERLAP' });
      }
      if (isUniqueViolation(e)) {
        throw new ConflictException({ code: 'UNIQUE_CONSTRAINT_VIOLATION' });
      }
      throw e;
    }
  }

  /**
   * PATCH /remote-device-bindings/:id — only effectiveTo mutates. Closing
   * may never orphan an event that already resolved through this binding:
   * effectiveTo must stay strictly above every resolved collectedAt.
   */
  async updateBindingTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    id: string,
    body: BindingPatchBody,
    req: Request,
  ) {
    const binding = await tx.remoteDeviceBinding.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!binding) throw new NotFoundException({ code: 'BINDING_NOT_FOUND' });
    await this.assertSourceScope(tx, ctx, binding.remoteSourceId);
    if (body.effectiveTo === undefined) {
      throw new BadRequestException({ code: 'BINDING_FIELDS_REQUIRED' });
    }
    const effectiveTo =
      body.effectiveTo === null ? null : parseInstant(body.effectiveTo, 'effectiveTo');
    if (effectiveTo !== null && effectiveTo <= binding.effectiveFrom) {
      throw new UnprocessableEntityException({ code: 'INVALID_BINDING_RANGE' });
    }
    if (effectiveTo !== null) {
      const orphan = await tx.rawRemoteEvent.findFirst({
        where: {
          tenantId: ctx.tenantId,
          resolvedBindingId: id,
          collectedAt: { gte: effectiveTo },
        },
        select: { id: true, collectedAt: true },
      });
      if (orphan) {
        throw new ConflictException({ code: 'BINDING_CLOSE_ORPHANS_EVENT', eventId: orphan.id });
      }
      const installation = await tx.meterInstallation.findFirst({
        where: { tenantId: ctx.tenantId, id: binding.installationId },
        select: { removedAt: true },
      });
      if (installation?.removedAt && effectiveTo > installation.removedAt) {
        throw new UnprocessableEntityException({
          code: 'BINDING_OUTSIDE_INSTALLATION',
          removedAt: installation.removedAt,
        });
      }
    }
    req.auditBefore = binding;
    try {
      return await tx.remoteDeviceBinding.update({
        where: { tenantId_id: { tenantId: ctx.tenantId, id } },
        data: { effectiveTo, updatedBy: ctx.staffId },
        select: REMOTE_BINDING_SELECT,
      });
    } catch (e) {
      if (isOverlapViolation(e)) {
        throw new ConflictException({ code: 'BINDING_OVERLAP' });
      }
      throw e;
    }
  }
}
