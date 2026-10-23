import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { TenantCtx } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';

type Tx = Prisma.TransactionClient;

const bad = (code: string, extra?: Record<string, unknown>) =>
  new BadRequestException({ code, ...extra });

/** 检定周期按口径（DN≤25→6年 / 25–50→4 / >50→2，20261020 T4 规则）。 */
const checkPeriodYearsOf = (caliber: string | null): number | null => {
  const m = /(\d+(?:\.\d+)?)/.exec(caliber ?? '');
  if (!m) return null;
  const dn = Number(m[1]);
  if (!Number.isFinite(dn)) return null;
  return dn <= 25 ? 6 : dn <= 50 ? 4 : 2;
};

export const MOVEMENT_TYPES = [
  'PURCHASE_IN',
  'ISSUE_OUT',
  'RETURN_IN',
  'SCRAP_OUT',
  'TRANSFER',
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

const IN_TYPES = new Set<MovementType>(['PURCHASE_IN', 'RETURN_IN']);
const OUT_TYPES = new Set<MovementType>(['ISSUE_OUT', 'SCRAP_OUT', 'TRANSFER']);

/**
 * 20261021 整改 任务D：水表库房全生命周期。
 * 状态映射：在库 AVAILABLE（+warehouseId）/ 在途 IN_TRANSIT / 已领用 ISSUED /
 * 在用 INSTALLED / 已报废 RETIRED。
 * 装表/换表取表规则在 meter-installation.service 钩：绑定库位的表自动记领用出库；
 * 租户已建库房时，未入库的表禁止安装（METER_NOT_IN_STOCK）。
 */
@Injectable()
export class MeterStockService {
  constructor(private readonly prisma: TenantPrismaService) {}

  // ---- 库房 / 货位 ----
  listWarehouses(ctx: TenantCtx) {
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.meterWarehouse.findMany({
        where: { tenantId: ctx.tenantId },
        include: { locations: { orderBy: { code: 'asc' } } },
        orderBy: { code: 'asc' },
      }),
    );
  }

  async createWarehouseTx(
    tx: Tx,
    ctx: TenantCtx,
    body: { code?: unknown; name?: unknown; owner?: unknown },
    req: Request,
  ) {
    const code = String(body.code ?? '').trim();
    const name = String(body.name ?? '').trim();
    if (!code || !name) throw bad('WAREHOUSE_FIELDS_REQUIRED');
    const dup = await tx.meterWarehouse.findFirst({
      where: { tenantId: ctx.tenantId, code },
      select: { id: true },
    });
    if (dup) throw new ConflictException({ code: 'WAREHOUSE_CODE_EXISTS' });
    const row = await tx.meterWarehouse.create({
      data: {
        tenantId: ctx.tenantId,
        code,
        name,
        owner: body.owner ? String(body.owner) : null,
        createdBy: ctx.staffId,
        updatedBy: ctx.staffId,
      },
    });
    req.auditBefore = undefined;
    return row;
  }

  async createLocationTx(
    tx: Tx,
    ctx: TenantCtx,
    warehouseId: string,
    body: { code?: unknown; name?: unknown },
  ) {
    const wh = await tx.meterWarehouse.findFirst({
      where: { tenantId: ctx.tenantId, id: warehouseId },
      select: { id: true },
    });
    if (!wh) throw new NotFoundException({ code: 'WAREHOUSE_NOT_FOUND' });
    const code = String(body.code ?? '').trim();
    const name = String(body.name ?? '').trim();
    if (!code || !name) throw bad('LOCATION_FIELDS_REQUIRED');
    const dup = await tx.meterWarehouseLocation.findFirst({
      where: { tenantId: ctx.tenantId, warehouseId, code },
      select: { id: true },
    });
    if (dup) throw new ConflictException({ code: 'LOCATION_CODE_EXISTS' });
    return tx.meterWarehouseLocation.create({
      data: { tenantId: ctx.tenantId, warehouseId, code, name },
    });
  }

  // ---- 出入库流水 ----
  /** 批量流水：meterIds[] 逐只记一条 movement + 状态/库位联动（同事务）。 */
  async moveTx(
    tx: Tx,
    ctx: TenantCtx,
    body: {
      type?: unknown;
      meterIds?: unknown;
      meterNos?: unknown;
      warehouseId?: unknown;
      locationId?: unknown;
      brand?: unknown;
      model?: unknown;
      caliber?: unknown;
      docNo?: unknown;
      supplier?: unknown;
      batchNo?: unknown;
      remark?: unknown;
    },
    req: Request,
  ) {
    const type = String(body.type ?? '') as MovementType;
    if (!(MOVEMENT_TYPES as readonly string[]).includes(type)) {
      throw bad('MOVEMENT_TYPE_INVALID');
    }
    const warehouseId = typeof body.warehouseId === 'string' ? body.warehouseId : null;
    const locationId = typeof body.locationId === 'string' ? body.locationId : null;

    if (IN_TYPES.has(type) || type === 'TRANSFER') {
      if (!warehouseId) throw bad('MOVEMENT_WAREHOUSE_REQUIRED');
      const wh = await tx.meterWarehouse.findFirst({
        where: { tenantId: ctx.tenantId, id: warehouseId },
        select: { id: true },
      });
      if (!wh) throw new NotFoundException({ code: 'WAREHOUSE_NOT_FOUND' });
      if (locationId) {
        const loc = await tx.meterWarehouseLocation.findFirst({
          where: { tenantId: ctx.tenantId, id: locationId, warehouseId },
          select: { id: true },
        });
        if (!loc) throw bad('LOCATION_NOT_IN_WAREHOUSE');
      }
    }

    // 20261023 D1：采购入库录入新表号批量建档（meterIds 与 meterNos 二选一）。
    if (type === 'PURCHASE_IN' && Array.isArray(body.meterNos)) {
      return this.purchaseInTx(tx, ctx, {
        meterNos: body.meterNos,
        warehouseId: warehouseId!,
        locationId,
        brand: typeof body.brand === 'string' ? body.brand : null,
        model: typeof body.model === 'string' ? body.model : null,
        caliber: typeof body.caliber === 'string' ? body.caliber : null,
        docNo: body.docNo,
        supplier: body.supplier,
        batchNo: body.batchNo,
        remark: body.remark,
      }, req);
    }

    const meterIds = Array.isArray(body.meterIds)
      ? (body.meterIds.filter((x): x is string => typeof x === 'string') as string[])
      : [];
    if (meterIds.length === 0) throw bad('MOVEMENT_METERS_REQUIRED');

    const meters = await tx.meter.findMany({
      where: { tenantId: ctx.tenantId, id: { in: meterIds } },
      select: { id: true, meterNo: true, status: true, warehouseId: true, locationId: true },
    });
    if (meters.length !== meterIds.length) {
      throw new NotFoundException({ code: 'METER_NOT_FOUND' });
    }

    const now = new Date();
    const results: string[] = [];
    for (const m of meters) {
      // 状态机校验
      if (type === 'PURCHASE_IN' && m.status !== 'AVAILABLE' && m.warehouseId) {
        throw bad('PURCHASE_IN_STATUS', { meterNo: m.meterNo, status: m.status });
      }
      if (type === 'ISSUE_OUT' && !m.warehouseId) {
        throw bad('ISSUE_NOT_IN_STOCK', { meterNo: m.meterNo });
      }
      if (type === 'ISSUE_OUT' && m.status !== 'AVAILABLE') {
        throw bad('ISSUE_STATUS_INVALID', { meterNo: m.meterNo, status: m.status });
      }
      if (type === 'RETURN_IN' && m.status !== 'ISSUED' && m.status !== 'IN_TRANSIT') {
        throw bad('RETURN_STATUS_INVALID', { meterNo: m.meterNo, status: m.status });
      }
      if (type === 'SCRAP_OUT' && m.status === 'INSTALLED') {
        throw bad('SCRAP_INSTALLED_FIRST', { meterNo: m.meterNo });
      }

      // 状态/库位联动
      const patch: Prisma.MeterUpdateManyMutationInput = { updatedBy: ctx.staffId };
      if (type === 'PURCHASE_IN' || type === 'RETURN_IN' || type === 'TRANSFER') {
        patch.warehouseId = warehouseId;
        patch.locationId = locationId;
        patch.status = type === 'TRANSFER' ? 'IN_TRANSIT' : 'AVAILABLE';
      } else if (type === 'ISSUE_OUT') {
        patch.status = 'ISSUED';
        patch.warehouseId = null;
        patch.locationId = null;
      } else if (type === 'SCRAP_OUT') {
        patch.status = 'RETIRED';
        patch.warehouseId = null;
        patch.locationId = null;
      }
      await tx.meter.updateMany({
        where: { tenantId: ctx.tenantId, id: m.id },
        data: patch,
      });
      const mv = await tx.meterStockMovement.create({
        data: {
          tenantId: ctx.tenantId,
          meterId: m.id,
          movementType: type,
          docNo: body.docNo ? String(body.docNo) : null,
          supplier: body.supplier ? String(body.supplier) : null,
          batchNo: body.batchNo ? String(body.batchNo) : null,
          warehouseId: IN_TYPES.has(type) || type === 'TRANSFER' ? warehouseId : m.warehouseId,
          locationId: IN_TYPES.has(type) || type === 'TRANSFER' ? locationId : m.locationId,
          operatorId: ctx.staffId,
          movedAt: now,
          remark: body.remark ? String(body.remark) : null,
        },
      });
      results.push(mv.id);
    }
    req.auditBefore = undefined;
    return { movementIds: results, count: results.length };
  }

  /**
   * 20261023 D1 采购入库：批量录入新表号 → 同批建 meter 档案 + 入库流水。
   * 表号与全局水表档案池比对（含历史/在用/已报废）——重号整单拒绝，
   * 避免同一表号在档案池出现两条表记录。
   */
  private async purchaseInTx(
    tx: Tx,
    ctx: TenantCtx,
    body: {
      meterNos: unknown[];
      warehouseId: string;
      locationId: string | null;
      brand: string | null;
      model: string | null;
      caliber: string | null;
      docNo?: unknown;
      supplier?: unknown;
      batchNo?: unknown;
      remark?: unknown;
    },
    req: Request,
  ) {
    const nos = [
      ...new Set(
        body.meterNos
          .map((x) => String(x ?? '').trim())
          .filter((x) => x.length > 0),
      ),
    ];
    if (nos.length === 0) throw bad('MOVEMENT_METERS_REQUIRED');
    if (nos.length > 200) throw bad('MOVEMENT_BATCH_TOO_LARGE', { max: 200 });
    for (const no of nos) {
      if (no.length > 64 || !/^[A-Za-z0-9_-]+$/.test(no)) {
        throw bad('METER_NO_INVALID', { meterNo: no });
      }
    }
    const dup = await tx.meter.findFirst({
      where: { tenantId: ctx.tenantId, meterNo: { in: nos } },
      select: { meterNo: true },
    });
    if (dup) {
      throw new ConflictException({ code: 'METER_NO_EXISTS', meterNo: dup.meterNo });
    }
    const checkYears = checkPeriodYearsOf(body.caliber);
    const now = new Date();
    const ids: string[] = [];
    for (const meterNo of nos) {
      const meter = await tx.meter.create({
        data: {
          tenantId: ctx.tenantId,
          meterNo,
          brand: body.brand,
          model: body.model,
          caliber: body.caliber,
          checkPeriodYears: checkYears,
          status: 'AVAILABLE',
          warehouseId: body.warehouseId,
          locationId: body.locationId,
          createdBy: ctx.staffId,
          updatedBy: ctx.staffId,
        },
      });
      await tx.meterStockMovement.create({
        data: {
          tenantId: ctx.tenantId,
          meterId: meter.id,
          movementType: 'PURCHASE_IN',
          docNo: body.docNo ? String(body.docNo) : null,
          supplier: body.supplier ? String(body.supplier) : null,
          batchNo: body.batchNo ? String(body.batchNo) : null,
          warehouseId: body.warehouseId,
          locationId: body.locationId,
          operatorId: ctx.staffId,
          movedAt: now,
          remark: body.remark ? String(body.remark) : null,
        },
      });
      ids.push(meter.id);
    }
    req.auditBefore = undefined;
    return { movementIds: ids, meterIds: ids, count: ids.length };
  }

  /**
   * 20261023 D1 出入库分源多选：按流水类型返回可选表清单
   * （出库/调拨=在库；退库=已出库未报废未装表）。
   */
  async selectable(ctx: TenantCtx, type: string, kw?: string, take = 50) {
    const t = String(type ?? '') as MovementType;
    if (!(MOVEMENT_TYPES as readonly string[]).includes(t)) {
      throw bad('MOVEMENT_TYPE_INVALID');
    }
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const statusCond: Prisma.MeterWhereInput =
        t === 'ISSUE_OUT' || t === 'TRANSFER'
          ? { status: 'AVAILABLE', warehouseId: { not: null } }
          : t === 'RETURN_IN'
            ? { status: { in: ['ISSUED', 'IN_TRANSIT'] } }
            : t === 'SCRAP_OUT'
              ? { status: { in: ['AVAILABLE', 'ISSUED', 'IN_TRANSIT'] } }
              : { id: '__none__' }; // PURCHASE_IN 录入新号，无候选表
      const rows = await tx.meter.findMany({
        where: {
          tenantId: ctx.tenantId,
          ...statusCond,
          ...(kw ? { meterNo: { contains: kw, mode: 'insensitive' } } : {}),
        },
        select: {
          id: true,
          meterNo: true,
          status: true,
          brand: true,
          caliber: true,
          warehouseId: true,
          locationId: true,
        },
        orderBy: { meterNo: 'asc' },
        take: Math.min(Math.max(take, 1), 200),
      });
      const whIds = [...new Set(rows.map((r) => r.warehouseId).filter((x): x is string => !!x))];
      const loIds = [...new Set(rows.map((r) => r.locationId).filter((x): x is string => !!x))];
      const [whs, locs] = await Promise.all([
        whIds.length
          ? tx.meterWarehouse.findMany({
              where: { tenantId: ctx.tenantId, id: { in: whIds } },
              select: { id: true, name: true, code: true },
            })
          : Promise.resolve([]),
        loIds.length
          ? tx.meterWarehouseLocation.findMany({
              where: { tenantId: ctx.tenantId, id: { in: loIds } },
              select: { id: true, name: true, code: true },
            })
          : Promise.resolve([]),
      ]);
      const wMap = new Map(whs.map((w) => [w.id, w]));
      const lMap = new Map(locs.map((l) => [l.id, l]));
      return rows.map((r) => ({
        ...r,
        warehouse: r.warehouseId ? (wMap.get(r.warehouseId) ?? null) : null,
        location: r.locationId ? (lMap.get(r.locationId) ?? null) : null,
      }));
    });
  }

  /** 表号全生命周期历史：出入库流水 + 装拆履历。 */
  async meterTrail(ctx: TenantCtx, meterId: string) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const meter = await tx.meter.findFirst({
        where: { tenantId: ctx.tenantId, id: meterId },
        select: {
          id: true, meterNo: true, status: true, meterRole: true,
          warehouseId: true, locationId: true, createdAt: true,
        },
      });
      if (!meter) throw new NotFoundException({ code: 'METER_NOT_FOUND' });
      const [movements, installations] = await Promise.all([
        tx.meterStockMovement.findMany({
          where: { tenantId: ctx.tenantId, meterId },
          orderBy: { movedAt: 'asc' },
        }),
        tx.meterInstallation.findMany({
          where: { tenantId: ctx.tenantId, meterId },
          select: {
            id: true, waterAccountId: true, installedAt: true, removedAt: true,
            initialReading: true, finalReading: true, reason: true, status: true,
          },
          orderBy: { installedAt: 'asc' },
        }),
      ]);
      // 名称水合
      const whIds = [
        ...new Set(
          [meter.warehouseId, ...movements.map((m) => m.warehouseId)].filter(
            (x): x is string => !!x,
          ),
        ),
      ];
      const whs = whIds.length
        ? await tx.meterWarehouse.findMany({
            where: { tenantId: ctx.tenantId, id: { in: whIds } },
            select: { id: true, code: true, name: true },
          })
        : [];
      const whMap = new Map(whs.map((w) => [w.id, w]));
      return {
        meter,
        movements: movements.map((m) => ({
          ...m,
          warehouse: m.warehouseId ? (whMap.get(m.warehouseId) ?? null) : null,
        })),
        installations,
      };
    });
  }

  /** 出入库流水分页（meterId/docNo/warehouseId 过滤）。 */
  async listMovements(
    ctx: TenantCtx,
    q: { meterId?: string; docNo?: string; warehouseId?: string; take: number; skip: number },
  ) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const where: Prisma.MeterStockMovementWhereInput = {
        tenantId: ctx.tenantId,
        ...(q.meterId ? { meterId: q.meterId } : {}),
        ...(q.docNo ? { docNo: q.docNo } : {}),
        ...(q.warehouseId ? { warehouseId: q.warehouseId } : {}),
      };
      const [total, items] = await Promise.all([
        tx.meterStockMovement.count({ where }),
        tx.meterStockMovement.findMany({
          where,
          orderBy: { movedAt: 'desc' },
          take: q.take,
          skip: q.skip,
        }),
      ]);
      const meterIds = [...new Set(items.map((i) => i.meterId))];
      const whIds = [...new Set(items.map((i) => i.warehouseId).filter((x): x is string => !!x))];
      const [meters, whs] = await Promise.all([
        meterIds.length
          ? tx.meter.findMany({
              where: { tenantId: ctx.tenantId, id: { in: meterIds } },
              select: { id: true, meterNo: true },
            })
          : Promise.resolve([]),
        whIds.length
          ? tx.meterWarehouse.findMany({
              where: { tenantId: ctx.tenantId, id: { in: whIds } },
              select: { id: true, code: true, name: true },
            })
          : Promise.resolve([]),
      ]);
      const mMap = new Map(meters.map((m) => [m.id, m.meterNo]));
      const wMap = new Map(whs.map((w) => [w.id, w]));
      return {
        total,
        items: items.map((i) => ({
          ...i,
          meterNo: mMap.get(i.meterId) ?? null,
          warehouse: i.warehouseId ? (wMap.get(i.warehouseId) ?? null) : null,
        })),
      };
    });
  }

  /** 库存查询：在库表（按库房/货位分组）。 */
  async stock(ctx: TenantCtx, q: { warehouseId?: string; take: number; skip: number }) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const where: Prisma.MeterWhereInput = {
        tenantId: ctx.tenantId,
        warehouseId: q.warehouseId ?? { not: null },
      };
      const [total, items] = await Promise.all([
        tx.meter.count({ where }),
        tx.meter.findMany({
          where,
          select: {
            id: true, meterNo: true, brand: true, model: true, caliber: true,
            status: true, warehouseId: true, locationId: true, updatedAt: true,
          },
          orderBy: { updatedAt: 'desc' },
          take: q.take,
          skip: q.skip,
        }),
      ]);
      const whIds = [...new Set(items.map((i) => i.warehouseId).filter((x): x is string => !!x))];
      const loIds = [...new Set(items.map((i) => i.locationId).filter((x): x is string => !!x))];
      const [whs, locs] = await Promise.all([
        whIds.length
          ? tx.meterWarehouse.findMany({
              where: { tenantId: ctx.tenantId, id: { in: whIds } },
              select: { id: true, code: true, name: true },
            })
          : Promise.resolve([]),
        loIds.length
          ? tx.meterWarehouseLocation.findMany({
              where: { tenantId: ctx.tenantId, id: { in: loIds } },
              select: { id: true, code: true, name: true },
            })
          : Promise.resolve([]),
      ]);
      const whMap = new Map(whs.map((w) => [w.id, w]));
      const loMap = new Map(locs.map((l) => [l.id, l]));
      return {
        total,
        items: items.map((i) => ({
          ...i,
          warehouse: i.warehouseId ? (whMap.get(i.warehouseId) ?? null) : null,
          location: i.locationId ? (loMap.get(i.locationId) ?? null) : null,
        })),
      };
    });
  }
}
