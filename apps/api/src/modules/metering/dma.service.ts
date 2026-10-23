import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { TenantCtx, orgInScope } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { isValidPeriod } from '../../common/reading-cadence.js';

type Tx = Prisma.TransactionClient;

const bad = (code: string, extra?: Record<string, unknown>) =>
  new BadRequestException({ code, ...extra });

/**
 * 20261023 C1/C2：DMA 独立计量分区。
 * 仅做水量监控（产销差分析），不涉水价/水费/计费；考核表 = meter_role CHECK
 * 的监控表，挂接水表为计费侧表计。两侧水量同口径：期内最新有效读数 −
 * 期前最新读数（无前期读数时退到安装初始读数）。
 */
@Injectable()
export class DmaService {
  constructor(private readonly prisma: TenantPrismaService) {}

  // ---------- 分区 ----------

  listZones(ctx: TenantCtx, q: { take: number; skip: number; kw?: string }) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const where: Prisma.DmaZoneWhereInput = {
        tenantId: ctx.tenantId,
        ...(q.kw
          ? {
              OR: [
                { name: { contains: q.kw, mode: 'insensitive' } },
                { code: { contains: q.kw, mode: 'insensitive' } },
                { region: { contains: q.kw, mode: 'insensitive' } },
              ],
            }
          : {}),
      };
      const rows = await tx.dmaZone.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: q.take,
        skip: q.skip,
      });
      const links = rows.length
        ? await tx.dmaCheckMeter.findMany({
            where: {
              tenantId: ctx.tenantId,
              dmaId: { in: rows.map((r) => r.id) },
              effectiveTo: null,
            },
            select: { id: true, dmaId: true },
          })
        : [];
      const meterLinks = links.length
        ? await tx.dmaMeterLink.groupBy({
            by: ['checkMeterId'],
            where: {
              tenantId: ctx.tenantId,
              checkMeterId: { in: links.map((l) => l.id) },
              effectiveTo: null,
            },
            _count: { _all: true },
          })
        : [];
      const linkCount = new Map(meterLinks.map((m) => [m.checkMeterId, m._count._all]));
      const perZone = new Map<string, { check: number; linked: number }>();
      for (const l of links) {
        const agg = perZone.get(l.dmaId) ?? { check: 0, linked: 0 };
        agg.check += 1;
        agg.linked += linkCount.get(l.id) ?? 0;
        perZone.set(l.dmaId, agg);
      }
      return rows.map((r) => ({
        ...r,
        checkMeterCount: perZone.get(r.id)?.check ?? 0,
        linkedMeterCount: perZone.get(r.id)?.linked ?? 0,
      }));
    });
  }

  async createZoneTx(
    tx: Tx,
    ctx: TenantCtx,
    body: { code?: unknown; name?: unknown; region?: unknown; orgUnitId?: unknown },
    req: Request,
  ) {
    const code = String(body.code ?? '').trim();
    const name = String(body.name ?? '').trim();
    if (!code || !name) throw bad('DMA_FIELDS_REQUIRED');
    const orgUnitId = typeof body.orgUnitId === 'string' ? body.orgUnitId : null;
    if (orgUnitId && !orgInScope(ctx, orgUnitId)) {
      throw new ConflictException({ code: 'OUT_OF_SCOPE' });
    }
    const dup = await tx.dmaZone.findFirst({
      where: { tenantId: ctx.tenantId, code },
      select: { id: true },
    });
    if (dup) throw new ConflictException({ code: 'DMA_CODE_EXISTS' });
    const row = await tx.dmaZone.create({
      data: {
        tenantId: ctx.tenantId,
        code,
        name,
        region: body.region ? String(body.region) : null,
        orgUnitId,
        createdBy: ctx.staffId,
        updatedBy: ctx.staffId,
      },
    });
    req.auditBefore = undefined;
    return row;
  }

  async updateZoneTx(
    tx: Tx,
    ctx: TenantCtx,
    id: string,
    body: { name?: unknown; region?: unknown; orgUnitId?: unknown; status?: unknown },
    req: Request,
  ) {
    const z = await tx.dmaZone.findFirst({ where: { tenantId: ctx.tenantId, id } });
    if (!z) throw new NotFoundException({ code: 'DMA_NOT_FOUND' });
    const data: Prisma.DmaZoneUpdateManyMutationInput = { updatedBy: ctx.staffId };
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) throw bad('DMA_FIELDS_REQUIRED');
      data.name = name;
    }
    if (body.region !== undefined) data.region = body.region ? String(body.region) : null;
    if (body.orgUnitId !== undefined) {
      const ou = body.orgUnitId ? String(body.orgUnitId) : null;
      if (ou && !orgInScope(ctx, ou)) throw new ConflictException({ code: 'OUT_OF_SCOPE' });
      data.orgUnitId = ou;
    }
    if (body.status !== undefined) {
      const s = String(body.status);
      if (!['ACTIVE', 'DISABLED'].includes(s)) throw bad('DMA_STATUS_INVALID');
      data.status = s;
    }
    const row = await tx.dmaZone.update({ where: { id: z.id }, data });
    req.auditBefore = z;
    return row;
  }

  async zoneDetail(ctx: TenantCtx, id: string) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const z = await tx.dmaZone.findFirst({ where: { tenantId: ctx.tenantId, id } });
      if (!z) throw new NotFoundException({ code: 'DMA_NOT_FOUND' });
      const checks = await tx.dmaCheckMeter.findMany({
        where: { tenantId: ctx.tenantId, dmaId: z.id },
        orderBy: { effectiveFrom: 'desc' },
      });
      const links = checks.length
        ? await tx.dmaMeterLink.findMany({
            where: {
              tenantId: ctx.tenantId,
              checkMeterId: { in: checks.map((c) => c.id) },
            },
            orderBy: { effectiveFrom: 'desc' },
          })
        : [];
      const meterIds = [
        ...new Set([...checks.map((c) => c.meterId), ...links.map((l) => l.meterId)]),
      ];
      const meters = meterIds.length
        ? await tx.meter.findMany({
            where: { tenantId: ctx.tenantId, id: { in: meterIds } },
            select: { id: true, meterNo: true, meterRole: true, status: true, caliber: true },
          })
        : [];
      const mMap = new Map(meters.map((m) => [m.id, m]));
      return {
        ...z,
        checkMeters: checks.map((c) => ({
          ...c,
          meter: mMap.get(c.meterId) ?? null,
          linkedMeters: links
            .filter((l) => l.checkMeterId === c.id)
            .map((l) => ({ ...l, meter: mMap.get(l.meterId) ?? null })),
        })),
      };
    });
  }

  // ---------- 考核表挂接 ----------

  async addCheckMeterTx(
    tx: Tx,
    ctx: TenantCtx,
    dmaId: string,
    body: { meterId?: unknown; effectiveFrom?: unknown },
    req: Request,
  ) {
    const z = await tx.dmaZone.findFirst({
      where: { tenantId: ctx.tenantId, id: dmaId },
      select: { id: true, orgUnitId: true },
    });
    if (!z) throw new NotFoundException({ code: 'DMA_NOT_FOUND' });
    if (z.orgUnitId && !orgInScope(ctx, z.orgUnitId)) {
      throw new ConflictException({ code: 'OUT_OF_SCOPE' });
    }
    const meterId = String(body.meterId ?? '');
    const meter = await tx.meter.findFirst({
      where: { tenantId: ctx.tenantId, id: meterId },
      select: { id: true, meterNo: true, meterRole: true },
    });
    if (!meter) throw new NotFoundException({ code: 'METER_NOT_FOUND' });
    // C1：考核表 = CHECK 角色（监控表），沿用现有表具角色定义。
    if (meter.meterRole !== 'CHECK') {
      throw bad('DMA_METER_NOT_CHECK', { meterNo: meter.meterNo });
    }
    const open = await tx.dmaCheckMeter.findFirst({
      where: { tenantId: ctx.tenantId, dmaId, meterId, effectiveTo: null },
      select: { id: true },
    });
    if (open) throw new ConflictException({ code: 'DMA_METER_ALREADY_LINKED', meterNo: meter.meterNo });
    const row = await tx.dmaCheckMeter.create({
      data: {
        tenantId: ctx.tenantId,
        dmaId,
        meterId,
        effectiveFrom: body.effectiveFrom ? new Date(String(body.effectiveFrom)) : new Date(),
        createdBy: ctx.staffId,
        updatedBy: ctx.staffId,
      },
    });
    req.auditBefore = undefined;
    return row;
  }

  async unlinkCheckMeterTx(tx: Tx, ctx: TenantCtx, checkMeterId: string, req: Request) {
    const row = await tx.dmaCheckMeter.findFirst({
      where: { tenantId: ctx.tenantId, id: checkMeterId, effectiveTo: null },
    });
    if (!row) throw new NotFoundException({ code: 'DMA_CHECK_NOT_FOUND' });
    // 先失效其下挂接，再失效考核表本身。
    await tx.dmaMeterLink.updateMany({
      where: { tenantId: ctx.tenantId, checkMeterId: row.id, effectiveTo: null },
      data: { effectiveTo: new Date(), updatedBy: ctx.staffId },
    });
    const updated = await tx.dmaCheckMeter.update({
      where: { id: row.id },
      data: { effectiveTo: new Date(), updatedBy: ctx.staffId },
    });
    req.auditBefore = row;
    return updated;
  }

  // ---------- 挂接水表 ----------

  async linkMetersTx(
    tx: Tx,
    ctx: TenantCtx,
    checkMeterId: string,
    body: { meterIds?: unknown; effectiveFrom?: unknown },
    req: Request,
  ) {
    const check = await tx.dmaCheckMeter.findFirst({
      where: { tenantId: ctx.tenantId, id: checkMeterId, effectiveTo: null },
      include: { dma: { select: { orgUnitId: true } } },
    });
    if (!check) throw new NotFoundException({ code: 'DMA_CHECK_NOT_FOUND' });
    if (check.dma.orgUnitId && !orgInScope(ctx, check.dma.orgUnitId)) {
      throw new ConflictException({ code: 'OUT_OF_SCOPE' });
    }
    const meterIds = Array.isArray(body.meterIds)
      ? [...new Set(body.meterIds.map((x) => String(x)))]
      : [];
    if (meterIds.length === 0) throw bad('LINK_METERS_REQUIRED');
    const meters = await tx.meter.findMany({
      where: { tenantId: ctx.tenantId, id: { in: meterIds } },
      select: { id: true, meterNo: true, meterRole: true },
    });
    if (meters.length !== meterIds.length) {
      throw new NotFoundException({ code: 'METER_NOT_FOUND' });
    }
    // 挂接对象是计费侧表计（普通/总/分表），CHECK 表之间不互挂。
    const badMeter = meters.find((m) => m.meterRole === 'CHECK');
    if (badMeter) throw bad('DMA_LINK_CHECK_FORBIDDEN', { meterNo: badMeter.meterNo });
    const from = body.effectiveFrom ? new Date(String(body.effectiveFrom)) : new Date();
    const existing = await tx.dmaMeterLink.findMany({
      where: {
        tenantId: ctx.tenantId,
        checkMeterId,
        meterId: { in: meterIds },
        effectiveTo: null,
      },
      select: { meterId: true },
    });
    const skip = new Set(existing.map((e) => e.meterId));
    const created: string[] = [];
    for (const m of meters) {
      if (skip.has(m.id)) continue;
      const row = await tx.dmaMeterLink.create({
        data: {
          tenantId: ctx.tenantId,
          checkMeterId,
          meterId: m.id,
          effectiveFrom: from,
          createdBy: ctx.staffId,
          updatedBy: ctx.staffId,
        },
      });
      created.push(row.id);
    }
    req.auditBefore = undefined;
    return { linkIds: created, count: created.length, skipped: existing.length };
  }

  async unlinkMeterTx(tx: Tx, ctx: TenantCtx, linkId: string, req: Request) {
    const row = await tx.dmaMeterLink.findFirst({
      where: { tenantId: ctx.tenantId, id: linkId, effectiveTo: null },
    });
    if (!row) throw new NotFoundException({ code: 'DMA_LINK_NOT_FOUND' });
    const updated = await tx.dmaMeterLink.update({
      where: { id: row.id },
      data: { effectiveTo: new Date(), updatedBy: ctx.staffId },
    });
    req.auditBefore = row;
    return updated;
  }

  // ---------- C2 产销差看板 ----------

  /**
   * 每个 DMA/账期一行：考核表总水量 − 挂接水表总水量 = 未计量水量；
   * 漏损率 = 未计量 ÷ 考核表 × 100（考核表为 0 时返回 null 除零保护）。
   * 水量口径（两侧一致，纯计量不含计费）：期内最新有效读数 − 期前最近
   * 读数，无前期读数时退到安装初始读数。
   */
  async dashboard(ctx: TenantCtx, periods: string[]) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const zones = await tx.dmaZone.findMany({
        where: { tenantId: ctx.tenantId, status: 'ACTIVE' },
        orderBy: { code: 'asc' },
      });
      const result: {
        period: string;
        rows: {
          dma: { id: string; code: string; name: string; region: string | null };
          checkMeterCount: number;
          linkedMeterCount: number;
          checkQty: string;
          linkedQty: string;
          unmeasuredQty: string;
          leakageRate: string | null;
          unreadCheckMeters: number;
        }[];
      }[] = [];
      for (const period of periods) {
        const rows = await Promise.all(
          zones.map((z) => this.zonePeriodRow(tx, ctx, z, period)),
        );
        result.push({ period, rows });
      }
      return result;
    });
  }

  /** 单 DMA 某期的分表明细（看板下钻）。 */
  async zonePeriodDetail(ctx: TenantCtx, dmaId: string, period: string) {
    if (!isValidPeriod(period)) throw bad('INVALID_PERIOD');
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const z = await tx.dmaZone.findFirst({ where: { tenantId: ctx.tenantId, id: dmaId } });
      if (!z) throw new NotFoundException({ code: 'DMA_NOT_FOUND' });
      return this.zoneDetailRows(tx, ctx, z.id, period);
    });
  }

  private async zonePeriodRow(
    tx: Tx,
    ctx: TenantCtx,
    z: { id: string; code: string; name: string; region: string | null },
    period: string,
  ) {
    const detail = await this.zoneDetailRows(tx, ctx, z.id, period);
    const checkQty = detail.checkMeters.reduce(
      (acc, c) => acc.plus(c.usageQty),
      new Prisma.Decimal(0),
    );
    const linkedQty = detail.linkedMeters.reduce(
      (acc, c) => acc.plus(c.usageQty),
      new Prisma.Decimal(0),
    );
    const unmeasured = checkQty.minus(linkedQty);
    const leakageRate = checkQty.gt(0)
      ? unmeasured.div(checkQty).mul(100).toFixed(2)
      : null;
    return {
      dma: { id: z.id, code: z.code, name: z.name, region: z.region },
      checkMeterCount: detail.checkMeters.length,
      linkedMeterCount: detail.linkedMeters.length,
      checkQty: checkQty.toFixed(2),
      linkedQty: linkedQty.toFixed(2),
      unmeasuredQty: unmeasured.toFixed(2),
      leakageRate,
      unreadCheckMeters: detail.checkMeters.filter((c) => !c.measured).length,
    };
  }

  /** 期初/期末窗口内有效的挂接关系 → 两侧分表用量明细。 */
  private async zoneDetailRows(tx: Tx, ctx: TenantCtx, dmaId: string, period: string) {
    const checks = await tx.dmaCheckMeter.findMany({
      where: {
        tenantId: ctx.tenantId,
        dmaId,
        effectiveFrom: { lt: periodEnd(period) },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: periodStart(period) } }],
      },
      select: { id: true, meterId: true },
    });
    const links = checks.length
      ? await tx.dmaMeterLink.findMany({
          where: {
            tenantId: ctx.tenantId,
            checkMeterId: { in: checks.map((c) => c.id) },
            effectiveFrom: { lt: periodEnd(period) },
            OR: [{ effectiveTo: null }, { effectiveTo: { gt: periodStart(period) } }],
          },
          select: { meterId: true },
        })
      : [];
    const [checkMeters, linkedMeters, meters] = await Promise.all([
      this.usageByMeter(tx, ctx.tenantId, checks.map((c) => c.meterId), period),
      this.usageByMeter(tx, ctx.tenantId, links.map((l) => l.meterId), period),
      tx.meter.findMany({
        where: {
          tenantId: ctx.tenantId,
          id: { in: [...new Set([...checks.map((c) => c.meterId), ...links.map((l) => l.meterId)])] },
        },
        select: { id: true, meterNo: true, caliber: true },
      }),
    ]);
    const mMap = new Map(meters.map((m) => [m.id, m]));
    const label = (u: { meterId: string; usageQty: Prisma.Decimal; measured: boolean }) => ({
      ...u,
      meterNo: mMap.get(u.meterId)?.meterNo ?? null,
      caliber: mMap.get(u.meterId)?.caliber ?? null,
      usageQty: u.usageQty.toFixed(2),
    });
    return {
      dmaId,
      period,
      checkMeters: checkMeters.map(label),
      linkedMeters: linkedMeters.map(label),
    };
  }

  /**
   * 批量算一组表在某期的用量：期内最新未替代 NORMAL 读数 − 期前最近
   * 未替代读数；无前期读数退到活动安装的 initial_reading；本期无读数
   * 记 0 且 measured=false（看板标注"未抄到"）。
   */
  private async usageByMeter(
    tx: Tx,
    tenantId: string,
    meterIds: string[],
    period: string,
  ): Promise<{ meterId: string; usageQty: Prisma.Decimal; measured: boolean }[]> {
    if (meterIds.length === 0) return [];
    const cur = await tx.$queryRaw<{ meter_id: string; v: string }[]>`
      SELECT i.meter_id::text AS meter_id, MAX(r.reading_value)::text AS v
      FROM meter_reading r
      JOIN meter_installation i ON i.id = r.installation_id
      WHERE r.tenant_id = ${tenantId}::uuid
        AND i.meter_id = ANY(${meterIds}::uuid[])
        AND r.period = ${period}
        AND r.result_type = 'ACTUAL'
        AND NOT EXISTS (SELECT 1 FROM meter_reading s WHERE s.supersedes_reading_id = r.id)
      GROUP BY i.meter_id`;
    const prev = await tx.$queryRaw<{ meter_id: string; v: string }[]>`
      SELECT DISTINCT ON (i.meter_id) i.meter_id::text AS meter_id, r.reading_value::text AS v
      FROM meter_reading r
      JOIN meter_installation i ON i.id = r.installation_id
      WHERE r.tenant_id = ${tenantId}::uuid
        AND i.meter_id = ANY(${meterIds}::uuid[])
        AND r.period < ${period}
        AND r.result_type = 'ACTUAL'
        AND NOT EXISTS (SELECT 1 FROM meter_reading s WHERE s.supersedes_reading_id = r.id)
      ORDER BY i.meter_id, r.period DESC, r.read_date DESC, r.created_at DESC`;
    const base = await tx.meterInstallation.findMany({
      where: { tenantId, meterId: { in: meterIds }, status: 'ACTIVE' },
      select: { meterId: true, initialReading: true },
    });
    const baseMap = new Map(base.map((b) => [b.meterId, b.initialReading]));
    const curMap = new Map(cur.map((c) => [c.meter_id, new Prisma.Decimal(c.v)]));
    const prevMap = new Map(prev.map((p) => [p.meter_id, new Prisma.Decimal(p.v)]));
    return meterIds.map((meterId) => {
      const end = curMap.get(meterId);
      if (!end) return { meterId, usageQty: new Prisma.Decimal(0), measured: false };
      const begin = prevMap.get(meterId) ?? baseMap.get(meterId) ?? new Prisma.Decimal(0);
      return { meterId, usageQty: end.minus(begin), measured: true };
    });
  }
}

const periodStart = (period: string) =>
  new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(4, 6)) - 1, 1));
const periodEnd = (period: string) =>
  new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(4, 6)), 1));
