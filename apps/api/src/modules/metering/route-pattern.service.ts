import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { orgInScope, type TenantCtx } from '../../common/tenant-context.js';

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

  /**
   * P0-3 组织范围：scoped 调用者只能触达「本组织子树册内」的户/模式。
   * 返回该租户内调用者可触达的水表户 ID 集合（ALL 范围返回 null = 不限）。
   */
  private async scopedWaIds(
    tx: Tx,
    ctx: TenantCtx,
    zoneNo?: string,
  ): Promise<Set<string> | null> {
    if (ctx.scope === 'ALL') return null;
    const books = await tx.readingBook.findMany({
      where: { tenantId: ctx.tenantId },
      select: { id: true, orgUnitId: true },
    });
    const inScopeBookIds = new Set(
      books.filter((b) => orgInScope(ctx, b.orgUnitId)).map((b) => b.id),
    );
    const members = await tx.bookMeter.findMany({
      where: {
        tenantId: ctx.tenantId,
        bookId: { in: [...inScopeBookIds] },
      },
      select: { waterAccountId: true },
    });
    if (!zoneNo) return new Set(members.map((m) => m.waterAccountId));
    // BookMeter 无户关联 → 再按 zoneNo 过滤户
    const inZone = await tx.waterAccount.findMany({
      where: {
        tenantId: ctx.tenantId,
        id: { in: members.map((m) => m.waterAccountId) },
        zoneNo,
      },
      select: { id: true },
    });
    return new Set(inZone.map((a) => a.id));
  }

  /** 模式的 zoneNo 下是否有可触达户（读权限判定）；空集即越权。 */
  private async assertZoneReadable(tx: Tx, ctx: TenantCtx, zoneNo: string) {
    const waIds = await this.scopedWaIds(tx, ctx, zoneNo);
    if (waIds !== null && waIds.size === 0) {
      throw new BadRequestException({ code: 'PATTERN_ZONE_OUT_OF_SCOPE', zoneNo });
    }
  }

  list(ctx: TenantCtx, zoneNo?: string) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.routePattern.findMany({
        where: { tenantId: ctx.tenantId, zoneNo: zoneNo || undefined },
        orderBy: [{ zoneNo: 'asc' }, { name: 'asc' }],
        select: ROUTE_PATTERN_SELECT,
      });
      if (ctx.scope === 'ALL') return rows;
      // scoped：只回「本组织子树册内有户」的区号模式。
      const waIds = await this.scopedWaIds(tx, ctx);
      const acctZones = await tx.waterAccount.findMany({
        where: { tenantId: ctx.tenantId, id: { in: [...(waIds ?? [])] } },
        select: { zoneNo: true },
      });
      const readableZones = new Set(acctZones.map((a) => a.zoneNo));
      return rows.filter((r) => readableZones.has(r.zoneNo));
    });
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
    // P0-3：scoped 保存前须确认该区号下有本组织子树册内户。
    await this.assertZoneReadable(tx, ctx, body.zoneNo);
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

  /**
   * 应用模式：把快照 routeKey 写回对应用水户。
   * A2/A5 组织权限：scoped 调用者只能写本组织子树册内的户——
   * 逐户经 book_meter 解析所属册组织校验，无册户仅 ALL 可写。
   */
  async applyTx(tx: Tx, ctx: TenantCtx, id: string, req: Request) {
    const pattern = await tx.routePattern.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!pattern) throw new NotFoundException({ code: 'PATTERN_NOT_FOUND' });
    req.auditBefore = pattern;
    const entries = (pattern.entries as unknown as PatternEntry[]) ?? [];
    const waIds = entries.map((e) => e.waterAccountId);
    const memberships = waIds.length
      ? await tx.bookMeter.findMany({
          where: { tenantId: ctx.tenantId, waterAccountId: { in: waIds } },
          select: { waterAccountId: true, bookId: true },
        })
      : [];
    const books = memberships.length
      ? await tx.readingBook.findMany({
          where: { tenantId: ctx.tenantId, id: { in: memberships.map((m) => m.bookId) } },
          select: { id: true, orgUnitId: true },
        })
      : [];
    const orgOfBook = new Map(books.map((b) => [b.id, b.orgUnitId]));
    const orgOf = new Map(
      memberships.map((m) => [m.waterAccountId, orgOfBook.get(m.bookId) ?? null]),
    );
    for (const e of entries) {
      const orgUnitId = orgOf.get(e.waterAccountId) ?? null;
      if (!orgInScope(ctx, orgUnitId)) {
        throw new BadRequestException({
          code: 'PATTERN_OUT_OF_SCOPE',
          waterAccountId: e.waterAccountId,
        });
      }
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
    // P0-3：scoped 删除前同样校验区号可读（模式必须能在本范围列表中见到）。
    await this.assertZoneReadable(tx, ctx, pattern.zoneNo);
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
    await this.assertZoneReadable(tx, ctx, pattern.zoneNo);
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
