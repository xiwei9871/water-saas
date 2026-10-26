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
import { parseDate } from '../service-order/service-order.types.js';

type Tx = Prisma.TransactionClient;

const bad = (code: string, extra?: Record<string, unknown>) =>
  new BadRequestException({ code, ...extra });

// 20261026 DMA-D1：表具角色废除 CHECK——监控表唯一判定 = 用水户用水类别。
export const METER_ROLES = ['NORMAL', 'MASTER', 'SUB'] as const;
export type MeterRole = (typeof METER_ROLES)[number];
export const BILLING_MODES = ['MASTER', 'SUB'] as const;

/**
 * 20261021 整改 任务C：总分表（总表挂分表）。
 *  - meter.meter_role: MASTER总表 / SUB分表 / NORMAL普通 / CHECK考核表；
 *  - meter_relation: 主表×分表×生效区间 + billingMode（MASTER=按总表计费 /
 *    SUB=按分表计费，同一主表下必须统一）；
 *  - 结算侧（settlement.service）按关系排除不计费安装行；
 *  - 漏损分析：总表用量 vs 分表合计（consumption_component 按期间汇总）。
 */
@Injectable()
export class MeterRelationService {
  constructor(private readonly prisma: TenantPrismaService) {}

  list(ctx: TenantCtx) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.$queryRaw<
        {
          id: string;
          master_meter_id: string;
          sub_meter_id: string;
          billing_mode: string;
          effective_date: Date;
          expired_date: Date | null;
          master_no: string;
          sub_no: string;
          master_role: string;
          sub_role: string;
        }[]
      >`
        SELECT r.id, r.master_meter_id, r.sub_meter_id, r.billing_mode,
               r.effective_date, r.expired_date,
               mm.meter_no AS master_no, sm.meter_no AS sub_no,
               mm.meter_role AS master_role, sm.meter_role AS sub_role
        FROM meter_relation r
        JOIN meter mm ON mm.tenant_id = r.tenant_id AND mm.id = r.master_meter_id
        JOIN meter sm ON sm.tenant_id = r.tenant_id AND sm.id = r.sub_meter_id
        WHERE r.tenant_id = ${ctx.tenantId}::uuid
        ORDER BY r.expired_date IS NOT NULL, r.effective_date DESC`;
      return rows;
    });
  }

  async createTx(
    tx: Tx,
    ctx: TenantCtx,
    body: {
      masterMeterId?: unknown;
      subMeterId?: unknown;
      billingMode?: unknown;
      effectiveDate?: unknown;
    },
    req: Request,
  ) {
    const masterId = typeof body.masterMeterId === 'string' ? body.masterMeterId : '';
    const subId = typeof body.subMeterId === 'string' ? body.subMeterId : '';
    if (!masterId || !subId) throw bad('RELATION_METERS_REQUIRED');
    if (masterId === subId) throw bad('RELATION_SELF');
    const mode =
      body.billingMode === undefined
        ? 'SUB'
        : (BILLING_MODES as readonly string[]).includes(String(body.billingMode))
          ? String(body.billingMode)
          : (() => {
              throw bad('BILLING_MODE_INVALID');
            })();
    const effective = parseDate(String(body.effectiveDate ?? ''), 'EFFECTIVE_DATE_INVALID');
    if (!effective) throw bad('EFFECTIVE_DATE_REQUIRED');

    const meters = await tx.meter.findMany({
      where: { tenantId: ctx.tenantId, id: { in: [masterId, subId] } },
      select: { id: true, meterNo: true, meterRole: true, status: true },
    });
    const master = meters.find((m) => m.id === masterId);
    const sub = meters.find((m) => m.id === subId);
    if (!master || !sub) throw new NotFoundException({ code: 'METER_NOT_FOUND' });
    if (sub.meterRole === 'MASTER') throw bad('SUB_IS_MASTER');
    // 分表同一时间只能挂一个总表；同主表下计费模式必须统一。
    const live = await tx.meterRelation.findFirst({
      where: { tenantId: ctx.tenantId, subMeterId: subId, expiredDate: null },
      select: { id: true },
    });
    if (live) throw new ConflictException({ code: 'SUB_ALREADY_RELATED' });
    const siblings = await tx.meterRelation.findFirst({
      where: { tenantId: ctx.tenantId, masterMeterId: masterId, expiredDate: null },
      select: { billingMode: true },
    });
    if (siblings && siblings.billingMode !== mode) {
      throw bad('BILLING_MODE_CONFLICT', { current: siblings.billingMode });
    }

    const rel = await tx.meterRelation.create({
      data: {
        tenantId: ctx.tenantId,
        masterMeterId: masterId,
        subMeterId: subId,
        billingMode: mode,
        effectiveDate: effective,
        createdBy: ctx.staffId,
        updatedBy: ctx.staffId,
      },
    });
    // 角色自动维护：master→MASTER，sub→SUB（失效时统一回 NORMAL）。
    await tx.meter.updateMany({
      where: { tenantId: ctx.tenantId, id: masterId, meterRole: { in: ['NORMAL', 'MASTER'] } },
      data: { meterRole: 'MASTER', updatedBy: ctx.staffId },
    });
    await tx.meter.updateMany({
      where: { tenantId: ctx.tenantId, id: subId, meterRole: { in: ['NORMAL', 'SUB'] } },
      data: { meterRole: 'SUB', updatedBy: ctx.staffId },
    });
    return rel;
  }

  async updateTx(
    tx: Tx,
    ctx: TenantCtx,
    id: string,
    body: { billingMode?: unknown; expiredDate?: unknown },
    req: Request,
  ) {
    const rel = await tx.meterRelation.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!rel) throw new NotFoundException({ code: 'RELATION_NOT_FOUND' });
    req.auditBefore = rel;
    const data: Prisma.MeterRelationUpdateManyMutationInput = { updatedBy: ctx.staffId };
    if (body.billingMode !== undefined) {
      if (!(BILLING_MODES as readonly string[]).includes(String(body.billingMode))) {
        throw bad('BILLING_MODE_INVALID');
      }
      // 切换计费模式：同主表所有在挂关系同步（模式是主表级语义）。
      const mode = String(body.billingMode);
      await tx.meterRelation.updateMany({
        where: {
          tenantId: ctx.tenantId,
          masterMeterId: rel.masterMeterId,
          expiredDate: null,
        },
        data: { billingMode: mode, updatedBy: ctx.staffId },
      });
      data.billingMode = mode;
    }
    if (body.expiredDate !== undefined) {
      data.expiredDate = body.expiredDate
        ? parseDate(String(body.expiredDate), 'EXPIRED_DATE_INVALID')
        : null;
      if (data.expiredDate) {
        // 失效：分表回 NORMAL；主表无在挂分表时也回 NORMAL。
        await tx.meter.updateMany({
          where: { tenantId: ctx.tenantId, id: rel.subMeterId, meterRole: 'SUB' },
          data: { meterRole: 'NORMAL', updatedBy: ctx.staffId },
        });
      }
    }
    await tx.meterRelation.updateMany({
      where: { tenantId: ctx.tenantId, id },
      data,
    });
    if (data.expiredDate) {
      const stillLive = await tx.meterRelation.count({
        where: { tenantId: ctx.tenantId, masterMeterId: rel.masterMeterId, expiredDate: null },
      });
      if (stillLive === 0) {
        await tx.meter.updateMany({
          where: { tenantId: ctx.tenantId, id: rel.masterMeterId, meterRole: 'MASTER' },
          data: { meterRole: 'NORMAL', updatedBy: ctx.staffId },
        });
      }
    }
    return tx.meterRelation.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: ctx.tenantId, id } },
    });
  }

  /** 漏损分析：期内总表用量 − 分表用量合计 = 差额（漏损）。 */
  async loss(
    ctx: TenantCtx,
    q: { masterMeterId: string; from?: string; to?: string },
  ) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const rels = await tx.meterRelation.findMany({
        where: {
          tenantId: ctx.tenantId,
          masterMeterId: q.masterMeterId,
          expiredDate: null,
        },
        select: { subMeterId: true },
      });
      const meterIds = [q.masterMeterId, ...rels.map((r) => r.subMeterId)];
      const rows = await tx.$queryRaw<
        { meter_id: string; usage: number | null; periods: string[] }[]
      >`
        SELECT mi.meter_id, sum(cc.usage_qty)::float AS usage,
               array_agg(DISTINCT cs.period) AS periods
        FROM consumption_component cc
        JOIN consumption_settlement cs
          ON cs.tenant_id = cc.tenant_id AND cs.id = cc.settlement_id
        JOIN meter_installation mi
          ON mi.tenant_id = cc.tenant_id AND mi.id = cc.installation_id
        WHERE cc.tenant_id = ${ctx.tenantId}::uuid
          AND mi.meter_id = ANY(${meterIds}::uuid[])
          AND (${q.from ?? null}::char(6) IS NULL OR cs.period >= ${q.from ?? null})
          AND (${q.to ?? null}::char(6) IS NULL OR cs.period <= ${q.to ?? null})
        GROUP BY mi.meter_id`;
      const master = rows.find((r) => r.meter_id === q.masterMeterId);
      const masterUsage = Number(master?.usage ?? 0);
      const subs = rows
        .filter((r) => r.meter_id !== q.masterMeterId)
        .map((r) => ({ meterId: r.meter_id, usage: Number(r.usage ?? 0), periods: r.periods }));
      const subTotal = subs.reduce((s, x) => s + x.usage, 0);
      return {
        masterMeterId: q.masterMeterId,
        masterUsage,
        subTotal,
        lossQty: masterUsage - subTotal,
        lossRate: masterUsage > 0 ? (masterUsage - subTotal) / masterUsage : null,
        subs,
        periods: master?.periods ?? [],
      };
    });
  }
}
