import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { conflictOnUnique } from '../../common/prisma-errors.js';
import { orgInScope, type TenantCtx } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';

export const REMOTE_SOURCE_SELECT = {
  id: true,
  tenantId: true,
  code: true,
  name: true,
  type: true,
  adapterKey: true,
  timezone: true,
  orgUnitId: true,
  credentialRef: true,
  config: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.RemoteSourceSelect;

export const REMOTE_SOURCE_TYPES = ['FILE_IMPORT', 'API_PULL', 'WEBHOOK'] as const;
export type RemoteSourceType = (typeof REMOTE_SOURCE_TYPES)[number];

export interface RemoteSourceBody {
  code?: string;
  name?: string;
  type?: RemoteSourceType;
  adapterKey?: string;
  timezone?: string;
  orgUnitId?: string | null;
  credentialRef?: string | null;
  config?: Record<string, unknown> | null;
}

export interface RemoteSourcePatchBody {
  name?: string;
  status?: 'ACTIVE' | 'DISABLED';
  timezone?: string;
  orgUnitId?: string | null;
  credentialRef?: string | null;
  config?: Record<string, unknown> | null;
}

const outOfScope = () => new ForbiddenException({ code: 'ORG_OUT_OF_SCOPE' });

/**
 * RemoteSource （远传数据源） — a tenant-configured vendor platform feeding
 * canonical remote events (E5 domain design §6). `credentialRef` only ever
 * holds a vault/env secret REFERENCE — the adapter resolves it at fetch
 * time; the API never accepts or stores a plaintext credential.
 *
 * Scope: org_unit_id is optional. A NULL org means a tenant-wide source —
 * creating or mutating it requires ALL scope; a scoped caller may only
 * create/mutate sources pinned to an org inside their subtree.
 *
 * `code` / `type` / `adapterKey` are create-time identity and immutable
 * afterwards (re-keying an adapter mid-stream would silently redirect every
 * later ingest — retire the source and mint a new one).
 */
@Injectable()
export class RemoteSourceService {
  constructor(private readonly prisma: TenantPrismaService) {}

  list(
    ctx: TenantCtx,
    q: { take: number; skip: number; q?: string; type?: string; status?: string },
  ) {
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.remoteSource.findMany({
        where: {
          tenantId: ctx.tenantId,
          type: q.type as RemoteSourceType | undefined,
          status: q.status as 'ACTIVE' | 'DISABLED' | undefined,
          OR: q.q ? [{ code: { contains: q.q } }, { name: { contains: q.q } }] : undefined,
        },
        select: REMOTE_SOURCE_SELECT,
        orderBy: { code: 'asc' },
        take: q.take,
        skip: q.skip,
      }),
    );
  }

  getById(ctx: TenantCtx, id: string) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const source = await tx.remoteSource.findFirst({
        where: { tenantId: ctx.tenantId, id },
        select: REMOTE_SOURCE_SELECT,
      });
      if (!source) throw new NotFoundException({ code: 'REMOTE_SOURCE_NOT_FOUND' });
      return source;
    });
  }

  /** Timezone must be an IANA identifier — adapters use it to localize naive vendor timestamps. */
  private validateTimezone(timezone: string) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch {
      throw new UnprocessableEntityException({ code: 'INVALID_TIMEZONE', timezone });
    }
  }

  /**
   * Write-path org guard: the caller may only touch sources whose org is
   * inside their scope. A tenant-wide (NULL org) source requires ALL.
   * Passing `nextOrgUnitId` also validates a PATCH'd org target.
   */
  private async assertOrg(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    orgUnitId: string | null,
  ) {
    if (orgUnitId === null) {
      if (ctx.scope !== 'ALL') throw outOfScope();
      return;
    }
    const org = await tx.orgUnit.findFirst({
      where: { tenantId: ctx.tenantId, id: orgUnitId },
    });
    if (!org) throw new BadRequestException({ code: 'ORG_UNIT_NOT_FOUND' });
    if (!orgInScope(ctx, orgUnitId)) throw outOfScope();
  }

  /** Load the source and enforce the write-path org guard (see assertOrg). */
  private async assertSourceInScope(tx: Prisma.TransactionClient, ctx: TenantCtx, id: string) {
    const source = await tx.remoteSource.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!source) throw new NotFoundException({ code: 'REMOTE_SOURCE_NOT_FOUND' });
    if (source.orgUnitId === null) {
      if (ctx.scope !== 'ALL') throw outOfScope();
    } else if (!orgInScope(ctx, source.orgUnitId)) {
      throw outOfScope();
    }
    return source;
  }

  /** POST — code/name/type/adapterKey/timezone required; status starts ACTIVE. */
  async createTx(tx: Prisma.TransactionClient, ctx: TenantCtx, body: RemoteSourceBody) {
    if (!body.code?.trim() || !body.name?.trim() || !body.adapterKey?.trim()) {
      throw new BadRequestException({ code: 'REMOTE_SOURCE_FIELDS_REQUIRED' });
    }
    if (!body.type || !REMOTE_SOURCE_TYPES.includes(body.type)) {
      throw new UnprocessableEntityException({ code: 'INVALID_SOURCE_TYPE' });
    }
    if (!body.timezone) {
      throw new BadRequestException({ code: 'REMOTE_SOURCE_FIELDS_REQUIRED' });
    }
    this.validateTimezone(body.timezone);
    await this.assertOrg(tx, ctx, body.orgUnitId ?? null);
    return conflictOnUnique(
      tx.remoteSource.create({
        data: {
          tenantId: ctx.tenantId,
          code: body.code.trim(),
          name: body.name.trim(),
          type: body.type,
          adapterKey: body.adapterKey.trim(),
          timezone: body.timezone,
          orgUnitId: body.orgUnitId ?? null,
          credentialRef: body.credentialRef?.trim() || null,
          config: body.config === undefined || body.config === null
            ? Prisma.JsonNull
            : (body.config as Prisma.InputJsonValue),
          createdBy: ctx.staffId,
          updatedBy: ctx.staffId,
        },
        select: REMOTE_SOURCE_SELECT,
      }),
    );
  }

  /** PATCH — name/status/timezone/orgUnitId/credentialRef/config; identity immutable. */
  async updateTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    id: string,
    body: RemoteSourcePatchBody,
    req: Request,
  ) {
    const existing = await this.assertSourceInScope(tx, ctx, id);
    if (body.status !== undefined && !['ACTIVE', 'DISABLED'].includes(body.status)) {
      throw new UnprocessableEntityException({ code: 'INVALID_SOURCE_STATUS' });
    }
    if (body.timezone !== undefined) this.validateTimezone(body.timezone);
    if (body.orgUnitId !== undefined) await this.assertOrg(tx, ctx, body.orgUnitId);
    req.auditBefore = existing;
    return tx.remoteSource.update({
      where: { tenantId_id: { tenantId: ctx.tenantId, id } },
      data: {
        name: body.name?.trim(),
        status: body.status,
        timezone: body.timezone,
        orgUnitId: body.orgUnitId,
        credentialRef:
          body.credentialRef === undefined ? undefined : body.credentialRef?.trim() || null,
        config:
          body.config === undefined
            ? undefined
            : body.config === null
              ? Prisma.JsonNull
              : (body.config as Prisma.InputJsonValue),
        updatedBy: ctx.staffId,
      },
      select: REMOTE_SOURCE_SELECT,
    });
  }
}
