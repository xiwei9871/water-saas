import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import type { TenantCtx } from '../../common/tenant-context.js';

type Tx = Prisma.TransactionClient;

export const ROUTE_PATTERN_SELECT = {
  id: true,
  tenantId: true,
  zoneNo: true,
  name: true,
  isDefault: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.RoutePatternSelect;

interface PatternEntry {
  waterAccountId: string;
  routeKey: number;
}

/**
 * R15-6 抄表顺序模式：把当前 routeKey 排序保存为命名模式，可切换、
 * 可设默认。apply 把模式内的 routeKey 快照写回各用水户。
 */
@Injectable()
export class RoutePatternService {
  constructor(private readonly prisma: TenantPrismaService) {}

  list(ctx: TenantCtx, zoneNo?: string) {
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.routePattern.findMany({
        where: { tenantId: ctx.tenantId, zoneNo: zoneNo || undefined },
        orderBy: [{ zoneNo: 'asc' }, { name: 'asc' }],
        select: ROUTE_PATTERN_SELECT,
      }),
    );
  }

  /** 保存当前区号排序为命名模式（isDefault 时清同区号其它默认）。 */
  async saveTx(
    tx: Tx,
    ctx: TenantCtx,
    body: { zoneNo: string; name: string; isDefault?: boolean },
  ) {
    if (!body.zoneNo?.trim() || !body.name?.trim()) {
      throw new BadRequestException({ code: 'PATTERN_FIELDS_REQUIRED' });
    }
    const accounts = await tx.waterAccount.findMany({
      where: {
        tenantId: ctx.tenantId,
        zoneNo: body.zoneNo,
        routeKey: { not: null },
        status: { not: 'CLOSED' },
      },
      select: { id: true, routeKey: true },
      orderBy: { routeKey: 'asc' },
    });
    if (accounts.length === 0) {
      throw new BadRequestException({ code: 'PATTERN_EMPTY_ZONE' });
    }
    const entries: PatternEntry[] = accounts.map((a) => ({
      waterAccountId: a.id,
      routeKey: Number(a.routeKey),
    }));
    if (body.isDefault) {
      await tx.routePattern.updateMany({
        where: { tenantId: ctx.tenantId, zoneNo: body.zoneNo },
        data: { isDefault: false },
      });
    }
    return tx.routePattern.create({
      data: {
        tenantId: ctx.tenantId,
        zoneNo: body.zoneNo,
        name: body.name.trim(),
        isDefault: body.isDefault ?? false,
        entries: entries as unknown as Prisma.InputJsonValue,
        createdBy: ctx.staffId,
        updatedBy: ctx.staffId,
      },
      select: ROUTE_PATTERN_SELECT,
    });
  }

  /** 应用模式：把快照 routeKey 写回对应用水户。 */
  async applyTx(tx: Tx, ctx: TenantCtx, id: string, req: Request) {
    const pattern = await tx.routePattern.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!pattern) throw new NotFoundException({ code: 'PATTERN_NOT_FOUND' });
    req.auditBefore = pattern;
    const entries = (pattern.entries as unknown as PatternEntry[]) ?? [];
    for (const e of entries) {
      await tx.waterAccount.updateMany({
        where: { tenantId: ctx.tenantId, id: e.waterAccountId },
        data: { routeKey: e.routeKey, updatedBy: ctx.staffId },
      });
    }
    return { applied: entries.length, pattern };
  }

  async removeTx(tx: Tx, ctx: TenantCtx, id: string, req: Request) {
    const pattern = await tx.routePattern.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!pattern) throw new NotFoundException({ code: 'PATTERN_NOT_FOUND' });
    req.auditBefore = pattern;
    await tx.routePattern.delete({ where: { id } });
    return { id, deleted: true };
  }

  /** 设默认：同区号其余模式清默认。 */
  async setDefaultTx(tx: Tx, ctx: TenantCtx, id: string) {
    const pattern = await tx.routePattern.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!pattern) throw new NotFoundException({ code: 'PATTERN_NOT_FOUND' });
    await tx.routePattern.updateMany({
      where: { tenantId: ctx.tenantId, zoneNo: pattern.zoneNo },
      data: { isDefault: false },
    });
    return tx.routePattern.update({
      where: { id },
      data: { isDefault: true, updatedBy: ctx.staffId },
      select: ROUTE_PATTERN_SELECT,
    });
  }
}
