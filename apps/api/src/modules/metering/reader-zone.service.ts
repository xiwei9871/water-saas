import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { conflictOnUnique } from '../../common/prisma-errors.js';
import {
  isRemoteZone,
  isValidZoneNo,
  REMOTE_ZONE_NO,
} from '../../common/metering-model.js';
import { embedStaffNames } from '../../common/account-identity.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import type { TenantCtx } from '../../common/tenant-context.js';

type Tx = Prisma.TransactionClient;

export const READER_ZONE_SELECT = {
  id: true,
  tenantId: true,
  zoneNo: true,
  readerId: true,
  status: true,
  remark: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ReaderZoneSelect;

export interface ReaderZoneBody {
  zoneNo?: string;
  readerId?: string | null;
  remark?: string | null;
}

export interface ReaderZonePatchBody {
  readerId?: string | null;
  status?: string;
  remark?: string | null;
}

/**
 * R14 区号—抄表员绑定维护：一个区号同一时间只绑一名抄表员。
 * 变更/解绑走 audit_log 留痕（req.auditBefore → 审计拦截器）。
 * 区号绑定是立户/抄表册/放号等处「区号↔抄表员」下拉的统一数据源。
 */
@Injectable()
export class ReaderZoneService {
  constructor(private readonly prisma: TenantPrismaService) {}

  /** 绑定关系列表（含抄表员姓名内嵌——展示层「区号 + 姓名」中文可读）。 */
  list(ctx: TenantCtx, q: { status?: string }) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.readerZone.findMany({
        where: { tenantId: ctx.tenantId, status: q.status },
        orderBy: { zoneNo: 'asc' },
        select: READER_ZONE_SELECT,
      });
      return embedStaffNames(tx, ctx.tenantId, rows, { readerId: 'readerName' });
    });
  }

  /**
   * 下拉数据源（R14-3）：立户/抄表册/放号统一取这里——
   * 选「区号」即自动带出绑定抄表员。远传区号 readerName 为空。
   */
  async options(ctx: TenantCtx) {
    const rows = await this.list(ctx, { status: 'ACTIVE' });
    return rows.map((r) => {
      const readerName = (r as { readerName?: string | null }).readerName ?? null;
      return {
        zoneNo: r.zoneNo,
        readerId: r.readerId,
        readerName,
        isRemote: isRemoteZone(r.zoneNo),
        label: isRemoteZone(r.zoneNo)
          ? `${r.zoneNo} · 远传`
          : `${r.zoneNo}${readerName ? ` · ${readerName}` : ''}`,
      };
    });
  }

  private async assertReader(tx: Tx, ctx: TenantCtx, readerId: string) {
    const reader = await tx.staff.findFirst({
      where: { tenantId: ctx.tenantId, id: readerId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!reader) throw new BadRequestException({ code: 'READER_NOT_FOUND' });
  }

  /** 新增绑定：zoneNo 唯一；非远传区号必须指定抄表员。 */
  async createTx(tx: Tx, ctx: TenantCtx, body: ReaderZoneBody) {
    const zoneNo = body.zoneNo?.trim();
    if (!zoneNo || !isValidZoneNo(zoneNo)) {
      throw new BadRequestException({ code: 'ZONE_NO_INVALID', zoneNo });
    }
    if (!isRemoteZone(zoneNo) && !body.readerId) {
      throw new BadRequestException({ code: 'ZONE_READER_REQUIRED' });
    }
    if (body.readerId) await this.assertReader(tx, ctx, body.readerId);
    return conflictOnUnique(
      tx.readerZone.create({
        data: {
          tenantId: ctx.tenantId,
          zoneNo,
          readerId: body.readerId ?? null,
          remark: body.remark ?? null,
          createdBy: ctx.staffId,
          updatedBy: ctx.staffId,
        },
        select: READER_ZONE_SELECT,
      }),
    );
  }

  /**
   * 变更/解绑/停用（PATCH）：
   *  - readerId 改绑 → 新区号-抄表员对应（历史数据保留原归属，不追溯改写）
   *  - readerId:null → 解绑（区号释放可再分配）
   *  - status:DISABLED → 停用
   */
  async updateTx(tx: Tx, ctx: TenantCtx, id: string, body: ReaderZonePatchBody, req: Request) {
    const existing = await tx.readerZone.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!existing) throw new NotFoundException({ code: 'ZONE_NOT_FOUND' });
    if (body.status !== undefined && !['ACTIVE', 'DISABLED'].includes(body.status)) {
      throw new BadRequestException({ code: 'ZONE_STATUS_INVALID' });
    }
    if (body.readerId !== undefined && body.readerId !== null) {
      await this.assertReader(tx, ctx, body.readerId);
    }
    if (
      body.readerId === null &&
      !isRemoteZone(existing.zoneNo) &&
      body.status !== 'DISABLED'
    ) {
      // 解绑即停用——避免留下「有区号无抄表员」的 ACTIVE 脏行。
      body.status = 'DISABLED';
    }
    req.auditBefore = existing;
    return tx.readerZone.update({
      where: { id },
      data: {
        readerId: body.readerId === undefined ? undefined : body.readerId,
        status: body.status,
        remark: body.remark === undefined ? undefined : body.remark,
        updatedBy: ctx.staffId,
      },
      select: READER_ZONE_SELECT,
    });
  }

  /** 区号→绑定抄表员解析（立户/放号带出抄表员；无绑定返回 null）。 */
  async readerOfZone(tx: Tx, ctx: TenantCtx, zoneNo: string) {
    const zone = await tx.readerZone.findFirst({
      where: { tenantId: ctx.tenantId, zoneNo, status: 'ACTIVE' },
      select: { id: true, readerId: true },
    });
    return zone;
  }

  /** 保证远传区号存在（readerId 恒空）。 */
  async ensureRemoteZone(tx: Tx, ctx: TenantCtx) {
    const existing = await tx.readerZone.findFirst({
      where: { tenantId: ctx.tenantId, zoneNo: REMOTE_ZONE_NO },
      select: { id: true },
    });
    if (existing) return existing;
    try {
      return await tx.readerZone.create({
        data: {
          tenantId: ctx.tenantId,
          zoneNo: REMOTE_ZONE_NO,
          readerId: null,
          remark: '远传水表专用区号',
          createdBy: ctx.staffId,
          updatedBy: ctx.staffId,
        },
        select: { id: true },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return tx.readerZone.findFirstOrThrow({
          where: { tenantId: ctx.tenantId, zoneNo: REMOTE_ZONE_NO },
          select: { id: true },
        });
      }
      throw e;
    }
  }

  /**
   * 区号变更历史：audit_log 查询（entity=ReaderZone）。
   * 绑定/变更/解绑均经 PATCH/POST，审计拦截器自动留痕。
   */
  history(ctx: TenantCtx, zoneNo?: string) {
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.auditLog.findMany({
        where: {
          tenantId: ctx.tenantId,
          entity: 'ReaderZone',
          ...(zoneNo
            ? {
                OR: [
                  { before: { path: ['zoneNo'], equals: zoneNo } },
                  { after: { path: ['zoneNo'], equals: zoneNo } },
                ],
              }
            : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    );
  }
}
