import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  aggregationScopeAccountIds,
  aggOwnPredicate,
} from '../../common/account-aggregation-ownership.js';
import { type TenantCtx } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { METRIC_DICT, METRIC_DICT_VERSION } from './metric-dictionary.js';

const monthWindow = (period: string): { gte: Date; lt: Date } => {
  const y = parseInt(period.slice(0, 4), 10);
  const m = parseInt(period.slice(4), 10);
  return { gte: new Date(Date.UTC(y, m - 1, 1)), lt: new Date(Date.UTC(y, m, 1)) };
};

/** 'YYYYMM' + N 个月（可为负） */
const shiftPeriod = (period: string, delta: number): string => {
  const y = parseInt(period.slice(0, 4), 10);
  const m = parseInt(period.slice(4), 10) - 1 + delta;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}${String(mm + 1).padStart(2, '0')}`;
};

const ratio = (num: bigint | number | null, den: bigint | number | null): number | null => {
  if (den === null || den === 0 || den === 0n || num === null) return null;
  return Number(num) / Number(den);
};

/**
 * B1–B3 分析报表（2026-10 需求 §五）—— 指标口径以 C1 字典
 * （metric-dictionary.ts / METRIC_DICT_VERSION）为唯一来源；响应中
 * metricCode ↔ 字典 code 一一对应，便于对账。所有金额分（bigint→string
 * 由全局拦截器序列化）。
 *
 * Scope：户锚聚合走 AGG_OWN；收款按柜台 org_unit_id；比率类指标在
 * scoped caller 下与 recovery-rate 同样存在分母错位 —— B 系列按
 * "scoped 用户只见所内口径"处理（与字典记录一致），不做跨域比率。
 */
@Injectable()
export class AnalysisService {
  constructor(private readonly prisma: TenantPrismaService) {}

  metricsDictionary() {
    return { version: METRIC_DICT_VERSION, metrics: METRIC_DICT };
  }

  // ------------------------------------------------------------------
  // B1 日报（运营监控）
  // ------------------------------------------------------------------
  async opsDaily(ctx: TenantCtx, q: { date: string }) {
    const period = q.date.slice(0, 7).replace('-', '');
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const wa = aggOwnPredicate(
        await aggregationScopeAccountIds(tx, ctx),
        Prisma.sql`b.water_account_id`,
      );
      const orgIn =
        ctx.scope === 'ALL'
          ? Prisma.empty
          : Prisma.sql`AND p.org_unit_id = ANY(${ctx.orgScope}::uuid[])`;

      // 当日应收：当日 issued 的账单（含其结算水量）
      const billed = await tx.$queryRaw<
        { amount: bigint | null; qty: string | null; cnt: number }[]
      >`
        SELECT sum(b.total_amount)::bigint AS amount, count(*)::int AS cnt,
               sum(cs.total_usage_qty)::text AS qty
        FROM bill b
        LEFT JOIN consumption_settlement cs
          ON cs.tenant_id = b.tenant_id AND cs.id = b.source_id
         AND b.source_type = 'SETTLEMENT'
        WHERE b.tenant_id = ${ctx.tenantId}::uuid
          AND b.issued_at::date = ${q.date}::date
          AND b.bill_kind <> 'REVERSAL' AND b.status <> 'REVERSED'
          ${wa}`;

      // 当日实收：柜台口径 + 当期/陈欠分列（分摊到本月账期 vs 历史账期）
      // p→a 一对多：amount 只对 payment 单表聚合（子查询），否则一笔
      // 分摊到多张账单的收款在 amount 里会被重复计数。
      const collected = await tx.$queryRaw<
        {
          amount: bigint | null;
          current: bigint | null;
          arrears: bigint | null;
        }[]
      >`
        SELECT (SELECT sum(p.amount) FROM payment p
                  WHERE p.tenant_id = ${ctx.tenantId}::uuid
                    AND p.status IN ('RECEIVED','DAY_CLOSED')
                    AND p.received_at::date = ${q.date}::date ${orgIn})::bigint AS amount,
               sum(CASE WHEN b.period = ${period} THEN a.amount ELSE 0 END)::bigint AS current,
               sum(CASE WHEN b.period < ${period} THEN a.amount ELSE 0 END)::bigint AS arrears
        FROM payment p
        LEFT JOIN payment_alloc a
          ON a.tenant_id = p.tenant_id AND a.payment_id = p.id
        LEFT JOIN bill b ON b.tenant_id = a.tenant_id AND b.id = a.bill_id
        WHERE p.tenant_id = ${ctx.tenantId}::uuid
          AND p.status IN ('RECEIVED','DAY_CLOSED')
          AND p.received_at::date = ${q.date}::date
          ${orgIn}`;

      // 抄表进度：当日账期的计划项（应抄/已抄/抄见率）
      const plan = await tx.$queryRaw<
        { total: number; read: number; noRead: number }[]
      >`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE i.status = 'READ')::int AS read,
               count(*) FILTER (WHERE i.status = 'NO_READ')::int AS "noRead"
        FROM reading_plan_item i
        JOIN reading_plan p ON p.tenant_id = i.tenant_id AND p.id = i.plan_id
        WHERE i.tenant_id = ${ctx.tenantId}::uuid AND p.period = ${period}`;

      // 欠费总额 / 在册户数（时点快照）
      const snap = await tx.$queryRaw<
        { arrears: bigint | null; accounts: number }[]
      >`
        SELECT (SELECT sum(b.total_amount - COALESCE(a.paid,0))
                  FROM bill b
                  LEFT JOIN LATERAL (
                    SELECT sum(pa.amount)::bigint AS paid FROM payment_alloc pa
                    WHERE pa.tenant_id = b.tenant_id AND pa.bill_id = b.id) a ON true
                  WHERE b.tenant_id = ${ctx.tenantId}::uuid
                    AND b.status IN ('POSTED','PARTIAL_PAID')
                    AND b.bill_kind <> 'REVERSAL') AS arrears,
               (SELECT count(*)::int FROM water_account w
                  WHERE w.tenant_id = ${ctx.tenantId}::uuid AND w.status = 'NORMAL') AS accounts`;

      // 按组织（柜台）实收
      const byOrg = await tx.$queryRaw<
        { org: string | null; amount: bigint | null; cnt: number }[]
      >`
        SELECT ou.name AS org, sum(p.amount)::bigint AS amount, count(*)::int AS cnt
        FROM payment p
        LEFT JOIN org_unit ou ON ou.tenant_id = p.tenant_id AND ou.id = p.org_unit_id
        WHERE p.tenant_id = ${ctx.tenantId}::uuid
          AND p.status IN ('RECEIVED','DAY_CLOSED')
          AND p.received_at::date = ${q.date}::date
          ${orgIn}
        GROUP BY ou.name ORDER BY ou.name`;

      // 按渠道
      const byChannel = await tx.$queryRaw<
        { channel: string; amount: bigint | null; cnt: number }[]
      >`
        SELECT p.channel::text AS channel, sum(p.amount)::bigint AS amount, count(*)::int AS cnt
        FROM payment p
        WHERE p.tenant_id = ${ctx.tenantId}::uuid
          AND p.status IN ('RECEIVED','DAY_CLOSED')
          AND p.received_at::date = ${q.date}::date
          ${orgIn}
        GROUP BY p.channel ORDER BY p.channel`;

      // 按抄表员质量：当日录入读数按操作员 × QC 状态
      const byReader = await tx.$queryRaw<
        { reader: string | null; total: number; passed: number; flagged: number }[]
      >`
        SELECT s.name AS reader, count(*)::int AS total,
               count(*) FILTER (WHERE r.qc_status = 'PASSED')::int AS passed,
               count(*) FILTER (WHERE r.qc_status IN ('MANUAL_REVIEW','REJECTED'))::int AS flagged
        FROM meter_reading r
        LEFT JOIN staff s ON s.tenant_id = r.tenant_id AND s.id = r.operator_id
        WHERE r.tenant_id = ${ctx.tenantId}::uuid
          AND r.read_date = ${q.date}::date
          AND NOT EXISTS (
            SELECT 1 FROM meter_reading ch
            WHERE ch.tenant_id = r.tenant_id AND ch.supersedes_reading_id = r.id)
        GROUP BY s.name ORDER BY s.name`;

      // 异常明细：当日大额退费/红冲（负收款）、抄表异常、欠费 TOP 户
      const bigReversals = await tx.$queryRaw<
        { settleNo: string; name: string; amount: bigint; channel: string }[]
      >`
        SELECT sa.settle_no AS "settleNo", sa.name, p.amount, p.channel::text AS channel
        FROM payment p
        JOIN settle_account sa ON sa.tenant_id = p.tenant_id AND sa.id = p.settle_account_id
        WHERE p.tenant_id = ${ctx.tenantId}::uuid
          AND p.status IN ('RECEIVED','DAY_CLOSED')
          AND p.received_at::date = ${q.date}::date
          AND p.amount < 0
          ${orgIn}
        ORDER BY p.amount ASC LIMIT 20`;

      const topArrears = await tx.$queryRaw<
        { accountNo: string; customerName: string; arrears: bigint }[]
      >`
        SELECT wa.account_no AS "accountNo", c.name AS "customerName",
               sum(b.total_amount - COALESCE(a.paid,0))::bigint AS arrears
        FROM bill b
        JOIN water_account wa ON wa.tenant_id = b.tenant_id AND wa.id = b.water_account_id
        JOIN customer c ON c.tenant_id = wa.tenant_id AND c.id = wa.customer_id
        LEFT JOIN LATERAL (
          SELECT sum(pa.amount)::bigint AS paid FROM payment_alloc pa
          WHERE pa.tenant_id = b.tenant_id AND pa.bill_id = b.id) a ON true
        WHERE b.tenant_id = ${ctx.tenantId}::uuid
          AND b.status IN ('POSTED','PARTIAL_PAID')
          AND b.bill_kind <> 'REVERSAL'
          ${aggOwnPredicate(
            await aggregationScopeAccountIds(tx, ctx),
            Prisma.sql`b.water_account_id`,
          )}
        GROUP BY wa.id, wa.account_no, c.name
        HAVING sum(b.total_amount - COALESCE(a.paid,0)) > 0
        ORDER BY arrears DESC LIMIT 10`;

      const plan0 = plan[0] ?? { total: 0, read: 0, noRead: 0 };
      return {
        date: q.date,
        period,
        metricVersion: METRIC_DICT_VERSION,
        totals: {
          billedAmount: billed[0]?.amount ?? 0n,
          billedCount: billed[0]?.cnt ?? 0,
          soldQty: billed[0]?.qty ?? '0',
          collected: collected[0]?.amount ?? 0n,
          currentCollected: collected[0]?.current ?? 0n,
          arrearsCollected: collected[0]?.arrears ?? 0n,
          plannedReads: plan0.total,
          doneReads: plan0.read,
          readCoverage: ratio(plan0.read, plan0.total),
          arrearsTotal: snap[0]?.arrears ?? 0n,
          accountCount: snap[0]?.accounts ?? 0,
        },
        byOrg,
        byChannel,
        byReader,
        anomalies: { bigReversals, topArrears },
      };
    });
  }

  // ------------------------------------------------------------------
  // B2 月报（经营分析）
  // ------------------------------------------------------------------
  async analysisMonthly(ctx: TenantCtx, q: { period: string }) {
    const w = monthWindow(q.period);
    const prevYear = shiftPeriod(q.period, -12);
    const prevMonth = shiftPeriod(q.period, -1);
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const inScope = await aggregationScopeAccountIds(tx, ctx);
      const waB = aggOwnPredicate(inScope, Prisma.sql`b.water_account_id`);
      const waCs = aggOwnPredicate(inScope, Prisma.sql`cs.water_account_id`);
      const orgIn =
        ctx.scope === 'ALL'
          ? Prisma.empty
          : Prisma.sql`AND p.org_unit_id = ANY(${ctx.orgScope}::uuid[])`;

      // ---- 总量 ----
      const soldQty = await tx.$queryRaw<{ qty: string | null; cnt: number }[]>`
        SELECT sum(cs.total_usage_qty)::text AS qty, count(*)::int AS cnt
        FROM consumption_settlement cs
        WHERE cs.tenant_id = ${ctx.tenantId}::uuid
          AND cs.period = ${q.period} AND cs.status = 'FINAL' ${waCs}`;

      const ar = await tx.$queryRaw<{ amount: bigint | null }[]>`
        SELECT sum(b.total_amount)::bigint AS amount FROM bill b
        WHERE b.tenant_id = ${ctx.tenantId}::uuid AND b.period = ${q.period}
          AND b.bill_kind <> 'REVERSAL'
          AND b.status IN ('POSTED','PARTIAL_PAID','PAID') ${waB}`;

      const collected = await tx.$queryRaw<{ amount: bigint | null }[]>`
        SELECT sum(p.amount)::bigint AS amount FROM payment p
        WHERE p.tenant_id = ${ctx.tenantId}::uuid
          AND p.status IN ('RECEIVED','DAY_CLOSED')
          AND p.received_at >= ${w.gte} AND p.received_at < ${w.lt} ${orgIn}`;

      // 当期实收（窗口内）+ 陈欠收取 + 期末欠费 + 期初陈欠
      const allocSplit = await tx.$queryRaw<
        { current: bigint | null; arrears: bigint | null }[]
      >`
        SELECT sum(CASE WHEN b.period = ${q.period}
                         AND (b.due_date IS NULL OR COALESCE(p.received_at, e.created_at)::date <= b.due_date)
                        THEN a.amount ELSE 0 END)::bigint AS current,
               sum(CASE WHEN b.period < ${q.period} THEN a.amount ELSE 0 END)::bigint AS arrears
        FROM payment_alloc a
        JOIN bill b ON b.tenant_id = a.tenant_id AND b.id = a.bill_id
        LEFT JOIN payment p ON p.tenant_id = a.tenant_id AND p.id = a.payment_id
         AND p.status IN ('RECEIVED','DAY_CLOSED')
        LEFT JOIN prepayment_ledger_entry e
          ON e.tenant_id = a.tenant_id AND e.id = a.prepayment_entry_id
        WHERE a.tenant_id = ${ctx.tenantId}::uuid
          AND COALESCE(p.received_at, e.created_at) >= ${w.gte}
          AND COALESCE(p.received_at, e.created_at) < ${w.lt}
          ${aggOwnPredicate(inScope, Prisma.sql`b.water_account_id`)}`;

      // 期末/期初欠费快照（账龄分段复用同一行集）
      const arrearsRows = await tx.$queryRaw<
        { period: string; remaining: bigint }[]
      >`
        SELECT b.period,
               (b.total_amount - COALESCE(a.paid, 0))::bigint AS remaining
        FROM bill b
        LEFT JOIN LATERAL (
          SELECT sum(pa.amount)::bigint AS paid FROM payment_alloc pa
          WHERE pa.tenant_id = b.tenant_id AND pa.bill_id = b.id) a ON true
        WHERE b.tenant_id = ${ctx.tenantId}::uuid
          AND b.status IN ('POSTED','PARTIAL_PAID')
          AND b.bill_kind <> 'REVERSAL' ${waB}`;
      const endOfMonth = w.lt;
      const arrearsEnd = arrearsRows
        .filter((r) => r.period <= q.period)
        .reduce((s, r) => s + r.remaining, 0n);
      const arrearsStart = arrearsRows
        .filter((r) => r.period < q.period)
        .reduce((s, r) => s + r.remaining, 0n);
      // 账龄分段（截至月末）：0-3 / 3-6 / 6-12 / 12+ 个月
      const aging = { '0-3': 0n, '3-6': 0n, '6-12': 0n, '12+': 0n };
      for (const r of arrearsRows) {
        if (r.period > q.period || r.remaining <= 0n) continue;
        const months =
          (endOfMonth.getUTCFullYear() - parseInt(r.period.slice(0, 4), 10)) * 12 +
          (endOfMonth.getUTCMonth() + 1 - parseInt(r.period.slice(4), 10));
        if (months <= 3) aging['0-3'] += r.remaining;
        else if (months <= 6) aging['3-6'] += r.remaining;
        else if (months <= 12) aging['6-12'] += r.remaining;
        else aging['12+'] += r.remaining;
      }

      // 综合单价：水费类费用项账单行 ÷ 售水量
      const waterFee = await tx.$queryRaw<{ amount: bigint | null }[]>`
        SELECT sum(bi.amount)::bigint AS amount
        FROM bill_item bi
        JOIN bill b ON b.tenant_id = bi.tenant_id AND b.id = bi.bill_id
        JOIN fee_item fi ON fi.tenant_id = bi.tenant_id AND fi.id = bi.fee_item_id
        WHERE bi.tenant_id = ${ctx.tenantId}::uuid
          AND b.period = ${q.period}
          AND b.bill_kind <> 'REVERSAL'
          AND b.status IN ('POSTED','PARTIAL_PAID','PAID')
          AND fi.kind = 'WATER_FEE'
          ${aggOwnPredicate(inScope, Prisma.sql`b.water_account_id`)}`;

      // 同比/环比应收与实收
      const arYoY = await tx.$queryRaw<{ amount: bigint | null }[]>`
        SELECT sum(b.total_amount)::bigint AS amount FROM bill b
        WHERE b.tenant_id = ${ctx.tenantId}::uuid AND b.period = ${prevYear}
          AND b.bill_kind <> 'REVERSAL'
          AND b.status IN ('POSTED','PARTIAL_PAID','PAID') ${waB}`;
      const arMoM = await tx.$queryRaw<{ amount: bigint | null }[]>`
        SELECT sum(b.total_amount)::bigint AS amount FROM bill b
        WHERE b.tenant_id = ${ctx.tenantId}::uuid AND b.period = ${prevMonth}
          AND b.bill_kind <> 'REVERSAL'
          AND b.status IN ('POSTED','PARTIAL_PAID','PAID') ${waB}`;

      // 抄表质量四率
      const qcRows = await tx.$queryRaw<
        { qc: string; cnt: number }[]
      >`
        SELECT r.qc_status::text AS qc, count(*)::int AS cnt
        FROM meter_reading r
        JOIN meter_installation i ON i.tenant_id = r.tenant_id AND i.id = r.installation_id
        JOIN water_account wa ON wa.tenant_id = i.tenant_id AND wa.id = i.water_account_id
        WHERE r.tenant_id = ${ctx.tenantId}::uuid AND r.period = ${q.period}
          AND r.qc_status IN ('PASSED','REJECTED','MANUAL_REVIEW')
          AND NOT EXISTS (
            SELECT 1 FROM meter_reading ch
            WHERE ch.tenant_id = r.tenant_id AND ch.supersedes_reading_id = r.id)
          ${aggOwnPredicate(inScope, Prisma.sql`wa.id`)}
        GROUP BY r.qc_status`;
      const qcTotal = qcRows.reduce((s, r) => s + r.cnt, 0);
      const qcPassed = qcRows.find((r) => r.qc === 'PASSED')?.cnt ?? 0;

      const planItems = await tx.$queryRaw<{ status: string; cnt: number }[]>`
        SELECT i.status::text AS status, count(*)::int AS cnt
        FROM reading_plan_item i
        JOIN reading_plan p ON p.tenant_id = i.tenant_id AND p.id = i.plan_id
        JOIN water_account wa ON wa.tenant_id = i.tenant_id AND wa.id = i.water_account_id
        WHERE i.tenant_id = ${ctx.tenantId}::uuid AND p.period = ${q.period}
          ${aggOwnPredicate(inScope, Prisma.sql`i.water_account_id`)}
        GROUP BY i.status`;
      const planTotal = planItems.reduce((s, r) => s + r.cnt, 0);
      const planRead = planItems.find((r) => r.status === 'READ')?.cnt ?? 0;

      const estRows = await tx.$queryRaw<{ est: number; total: number }[]>`
        SELECT count(*) FILTER (WHERE cc.source_type = 'ESTIMATE')::int AS est,
               count(*)::int AS total
        FROM consumption_component cc
        JOIN consumption_settlement cs
          ON cs.tenant_id = cc.tenant_id AND cs.id = cc.settlement_id
        WHERE cc.tenant_id = ${ctx.tenantId}::uuid
          AND cs.period = ${q.period} AND cs.status = 'FINAL'
          ${aggOwnPredicate(inScope, Prisma.sql`cs.water_account_id`)}`;

      const timelyRows = await tx.$queryRaw<{ timely: number; total: number }[]>`
        SELECT count(*) FILTER (WHERE r.read_date <= p.plan_date)::int AS timely,
               count(*)::int AS total
        FROM meter_reading r
        JOIN reading_plan_item i ON i.tenant_id = r.tenant_id AND i.id = r.plan_item_id
        JOIN reading_plan p ON p.tenant_id = i.tenant_id AND p.id = i.plan_id
        JOIN meter_installation mi ON mi.tenant_id = r.tenant_id AND mi.id = r.installation_id
        JOIN water_account wa ON wa.tenant_id = mi.tenant_id AND wa.id = mi.water_account_id
        WHERE r.tenant_id = ${ctx.tenantId}::uuid AND p.period = ${q.period}
          AND NOT EXISTS (
            SELECT 1 FROM meter_reading ch
            WHERE ch.tenant_id = r.tenant_id AND ch.supersedes_reading_id = r.id)
          ${aggOwnPredicate(inScope, Prisma.sql`wa.id`)}`;

      // ---- 分类汇总 ----
      const byCategory = await tx.$queryRaw<
        { category: string; billed: bigint | null }[]
      >`
        SELECT wa.usage_category AS category, sum(b.total_amount)::bigint AS billed
        FROM bill b
        JOIN water_account wa ON wa.tenant_id = b.tenant_id AND wa.id = b.water_account_id
        WHERE b.tenant_id = ${ctx.tenantId}::uuid AND b.period = ${q.period}
          AND b.bill_kind <> 'REVERSAL'
          AND b.status IN ('POSTED','PARTIAL_PAID','PAID') ${waB}
        GROUP BY wa.usage_category ORDER BY wa.usage_category`;

      const qtyByCategory = await tx.$queryRaw<
        { category: string; qty: string | null }[]
      >`
        SELECT wa.usage_category AS category, sum(cs.total_usage_qty)::text AS qty
        FROM consumption_settlement cs
        JOIN water_account wa ON wa.tenant_id = cs.tenant_id AND wa.id = cs.water_account_id
        WHERE cs.tenant_id = ${ctx.tenantId}::uuid AND cs.period = ${q.period}
          AND cs.status = 'FINAL'
          ${aggOwnPredicate(inScope, Prisma.sql`cs.water_account_id`)}
        GROUP BY wa.usage_category`;

      const byOrg = await tx.$queryRaw<
        { org: string | null; billed: bigint | null; collected: bigint | null }[]
      >`
        SELECT ou.name AS org,
               sum(b.total_amount)::bigint AS billed,
               NULL::bigint AS collected
        FROM bill b
        JOIN water_account wa ON wa.tenant_id = b.tenant_id AND wa.id = b.water_account_id
        LEFT JOIN LATERAL (
          SELECT rb.tenant_id, rb.org_unit_id FROM book_meter bm
          JOIN reading_book rb ON rb.tenant_id = bm.tenant_id AND rb.id = bm.book_id
          WHERE bm.tenant_id = wa.tenant_id AND bm.water_account_id = wa.id
          LIMIT 1) bm ON true
        LEFT JOIN org_unit ou ON ou.tenant_id = bm.tenant_id AND ou.id = bm.org_unit_id
        WHERE b.tenant_id = ${ctx.tenantId}::uuid AND b.period = ${q.period}
          AND b.bill_kind <> 'REVERSAL'
          AND b.status IN ('POSTED','PARTIAL_PAID','PAID') ${waB}
        GROUP BY ou.name ORDER BY ou.name`;

      const collectedByOrg = await tx.$queryRaw<
        { org: string | null; collected: bigint | null }[]
      >`
        SELECT ou.name AS org, sum(p.amount)::bigint AS collected
        FROM payment p
        LEFT JOIN org_unit ou ON ou.tenant_id = p.tenant_id AND ou.id = p.org_unit_id
        WHERE p.tenant_id = ${ctx.tenantId}::uuid
          AND p.status IN ('RECEIVED','DAY_CLOSED')
          AND p.received_at >= ${w.gte} AND p.received_at < ${w.lt} ${orgIn}
        GROUP BY ou.name`;

      const byChannel = await tx.$queryRaw<
        { channel: string; amount: bigint | null; cnt: number }[]
      >`
        SELECT p.channel::text AS channel, sum(p.amount)::bigint AS amount, count(*)::int AS cnt
        FROM payment p
        WHERE p.tenant_id = ${ctx.tenantId}::uuid
          AND p.status IN ('RECEIVED','DAY_CLOSED')
          AND p.received_at >= ${w.gte} AND p.received_at < ${w.lt} ${orgIn}
        GROUP BY p.channel`;

      const byReader = await tx.$queryRaw<
        { reader: string | null; total: number; passed: number; flagged: number }[]
      >`
        SELECT s.name AS reader, count(*)::int AS total,
               count(*) FILTER (WHERE r.qc_status = 'PASSED')::int AS passed,
               count(*) FILTER (WHERE r.qc_status IN ('MANUAL_REVIEW','REJECTED'))::int AS flagged
        FROM meter_reading r
        JOIN meter_installation mi ON mi.tenant_id = r.tenant_id AND mi.id = r.installation_id
        JOIN water_account wa ON wa.tenant_id = mi.tenant_id AND wa.id = mi.water_account_id
        LEFT JOIN staff s ON s.tenant_id = r.tenant_id AND s.id = r.operator_id
        WHERE r.tenant_id = ${ctx.tenantId}::uuid AND r.period = ${q.period}
          AND NOT EXISTS (
            SELECT 1 FROM meter_reading ch
            WHERE ch.tenant_id = r.tenant_id AND ch.supersedes_reading_id = r.id)
          ${aggOwnPredicate(inScope, Prisma.sql`wa.id`)}
        GROUP BY s.name ORDER BY s.name`;

      // ---- 异常明细 ----
      const arrearsList = await tx.$queryRaw<
        { accountNo: string; customerName: string; arrears: bigint; oldestPeriod: string }[]
      >`
        SELECT wa.account_no AS "accountNo", c.name AS "customerName",
               sum(b.total_amount - COALESCE(a.paid,0))::bigint AS arrears,
               min(b.period)::bigint AS "oldestPeriod"
        FROM bill b
        JOIN water_account wa ON wa.tenant_id = b.tenant_id AND wa.id = b.water_account_id
        JOIN customer c ON c.tenant_id = wa.tenant_id AND c.id = wa.customer_id
        LEFT JOIN LATERAL (
          SELECT sum(pa.amount)::bigint AS paid FROM payment_alloc pa
          WHERE pa.tenant_id = b.tenant_id AND pa.bill_id = b.id) a ON true
        WHERE b.tenant_id = ${ctx.tenantId}::uuid
          AND b.status IN ('POSTED','PARTIAL_PAID')
          AND b.bill_kind <> 'REVERSAL' ${waB}
        GROUP BY wa.id, wa.account_no, c.name
        HAVING sum(b.total_amount - COALESCE(a.paid,0)) > 0
        ORDER BY arrears DESC LIMIT 50`;

      const reversalList = await tx.$queryRaw<
        { settleNo: string; name: string; amount: bigint; receivedAt: Date; channel: string }[]
      >`
        SELECT sa.settle_no AS "settleNo", sa.name, p.amount,
               p.received_at AS "receivedAt", p.channel::text AS channel
        FROM payment p
        JOIN settle_account sa ON sa.tenant_id = p.tenant_id AND sa.id = p.settle_account_id
        WHERE p.tenant_id = ${ctx.tenantId}::uuid
          AND p.status IN ('RECEIVED','DAY_CLOSED')
          AND p.received_at >= ${w.gte} AND p.received_at < ${w.lt}
          AND p.amount < 0 ${orgIn}
        ORDER BY p.received_at DESC LIMIT 50`;

      const adjustList = await tx.$queryRaw<
        { accountNo: string; customerName: string; period: string; amount: bigint; kind: string }[]
      >`
        SELECT wa.account_no AS "accountNo", c.name AS "customerName", b.period,
               bi.amount, b.bill_kind::text AS kind
        FROM bill_item bi
        JOIN bill b ON b.tenant_id = bi.tenant_id AND b.id = bi.bill_id
        JOIN water_account wa ON wa.tenant_id = b.tenant_id AND wa.id = b.water_account_id
        JOIN customer c ON c.tenant_id = wa.tenant_id AND c.id = wa.customer_id
        WHERE bi.tenant_id = ${ctx.tenantId}::uuid
          AND b.period = ${q.period}
          AND bi.item_type = 'ADJUSTMENT'
          AND b.status IN ('POSTED','PARTIAL_PAID','PAID') ${waB}
        ORDER BY bi.amount LIMIT 50`;

      const abnormalReadings = await tx.$queryRaw<
        { accountNo: string; period: string; qc: string; readingValue: string }[]
      >`
        SELECT wa.account_no AS "accountNo", r.period,
               r.qc_status::text AS qc, r.reading_value::text AS "readingValue"
        FROM meter_reading r
        JOIN meter_installation mi ON mi.tenant_id = r.tenant_id AND mi.id = r.installation_id
        JOIN water_account wa ON wa.tenant_id = mi.tenant_id AND wa.id = mi.water_account_id
        WHERE r.tenant_id = ${ctx.tenantId}::uuid
          AND r.period = ${q.period}
          AND r.qc_status IN ('MANUAL_REVIEW','REJECTED')
          AND NOT EXISTS (
            SELECT 1 FROM meter_reading ch
            WHERE ch.tenant_id = r.tenant_id AND ch.supersedes_reading_id = r.id)
          ${aggOwnPredicate(inScope, Prisma.sql`wa.id`)}
        ORDER BY r.period LIMIT 50`;

      const ar0 = ar[0]?.amount ?? 0n;
      const soldQtyNum = Number(soldQty[0]?.qty ?? '0');
      const collectedByOrgMap = new Map(collectedByOrg.map((r) => [r.org, r.collected]));
      const cumAr = await tx.$queryRaw<{ amount: bigint | null }[]>`
        SELECT sum(b.total_amount)::bigint AS amount FROM bill b
        WHERE b.tenant_id = ${ctx.tenantId}::uuid
          AND b.bill_kind <> 'REVERSAL'
          AND b.status IN ('POSTED','PARTIAL_PAID','PAID') ${waB}`;

      const unavailable = new Map(
        METRIC_DICT.filter((m) => !m.available).map((m) => [m.code, m.unavailableReason]),
      );

      return {
        period: q.period,
        metricVersion: METRIC_DICT_VERSION,
        totals: {
          SOLD_QTY: soldQty[0]?.qty ?? '0',
          SOLD_QTY_TARGET_RATE: { value: null, reason: unavailable.get('SOLD_QTY_TARGET_RATE') },
          AR_AMOUNT: ar0,
          COLLECTED: collected[0]?.amount ?? 0n,
          CURRENT_COLLECTED: allocSplit[0]?.current ?? 0n,
          ARREARS_COLLECTED: allocSplit[0]?.arrears ?? 0n,
          RECOVERY_RATE: ratio(allocSplit[0]?.current ?? 0n, ar0),
          ARREARS_RECOVERY_RATE: ratio(allocSplit[0]?.arrears ?? 0n, arrearsStart),
          ARREARS_TOTAL: arrearsEnd,
          ARREARS_RATE: ratio(arrearsEnd, cumAr[0]?.amount ?? 0n),
          COMPOSITE_PRICE:
            soldQtyNum > 0 ? Number(waterFee[0]?.amount ?? 0n) / soldQtyNum : null,
          REVENUE_GROWTH: ratio((ar0 ?? 0n) - (arYoY[0]?.amount ?? 0n), arYoY[0]?.amount ?? 0n),
          REVENUE_GROWTH_MOM: ratio((ar0 ?? 0n) - (arMoM[0]?.amount ?? 0n), arMoM[0]?.amount ?? 0n),
          READ_ACCURACY: ratio(qcPassed, qcTotal),
          READ_COVERAGE: ratio(planRead, planTotal),
          ESTIMATE_RATE: ratio(estRows[0]?.est ?? 0, estRows[0]?.total ?? 0),
          READ_TIMELINESS: ratio(timelyRows[0]?.timely ?? 0, timelyRows[0]?.total ?? 0),
          DUN_SUCCESS_RATE: { value: null, reason: unavailable.get('DUN_SUCCESS_RATE') },
        },
        byCategory: byCategory.map((r) => ({
          ...r,
          qty: qtyByCategory.find((x) => x.category === r.category)?.qty ?? '0',
        })),
        byOrg: byOrg.map((r) => ({
          org: r.org,
          billed: r.billed,
          collected: collectedByOrgMap.get(r.org) ?? 0n,
        })),
        byAging: aging,
        byChannel,
        byReader,
        lists: { arrearsList, reversalList, adjustList, abnormalReadings },
      };
    });
  }

  // ------------------------------------------------------------------
  // B3 年报（KPI + 12 月趋势 + 同比 + 年度清单）
  // ------------------------------------------------------------------
  async analysisYearly(ctx: TenantCtx, q: { year: string }) {
    const y = parseInt(q.year, 10);
    const prevYear = `${y - 1}`;
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const inScope = await aggregationScopeAccountIds(tx, ctx);
      const waB = aggOwnPredicate(inScope, Prisma.sql`b.water_account_id`);
      const orgIn =
        ctx.scope === 'ALL'
          ? Prisma.empty
          : Prisma.sql`AND p.org_unit_id = ANY(${ctx.orgScope}::uuid[])`;
      const gte = new Date(Date.UTC(y, 0, 1));
      const lt = new Date(Date.UTC(y + 1, 0, 1));
      const pyGte = new Date(Date.UTC(y - 1, 0, 1));
      const pyLt = gte;

      // 月度趋势：每月 应收/实收/售水量
      const trend = await tx.$queryRaw<
        { period: string; billed: bigint | null }[]
      >`
        SELECT b.period, sum(b.total_amount)::bigint AS billed
        FROM bill b
        JOIN water_account wa ON wa.tenant_id = b.tenant_id AND wa.id = b.water_account_id
        WHERE b.tenant_id = ${ctx.tenantId}::uuid
          AND b.period >= ${y + '01'} AND b.period <= ${y + '12'}
          AND b.bill_kind <> 'REVERSAL'
          AND b.status IN ('POSTED','PARTIAL_PAID','PAID') ${waB}
        GROUP BY b.period ORDER BY b.period`;

      const qtyTrend = await tx.$queryRaw<
        { period: string; qty: string | null }[]
      >`
        SELECT cs.period, sum(cs.total_usage_qty)::text AS qty
        FROM consumption_settlement cs
        WHERE cs.tenant_id = ${ctx.tenantId}::uuid
          AND cs.period >= ${y + '01'} AND cs.period <= ${y + '12'}
          AND cs.status = 'FINAL'
          ${aggOwnPredicate(inScope, Prisma.sql`cs.water_account_id`)}
        GROUP BY cs.period`;
      const qtyByPeriod = new Map(qtyTrend.map((r) => [r.period, r.qty]));

      const collectedTrend = await tx.$queryRaw<
        { m: number; collected: bigint | null }[]
      >`
        SELECT EXTRACT(MONTH FROM p.received_at)::int AS m, sum(p.amount)::bigint AS collected
        FROM payment p
        WHERE p.tenant_id = ${ctx.tenantId}::uuid
          AND p.status IN ('RECEIVED','DAY_CLOSED')
          AND p.received_at >= ${gte} AND p.received_at < ${lt} ${orgIn}
        GROUP BY m ORDER BY m`;
      const collectedByMonth = new Map(
        collectedTrend.map((r) => [`${y}${String(r.m).padStart(2, '0')}`, r.collected]),
      );

      // 年度总量
      const totals = await tx.$queryRaw<
        { billed: bigint | null; collected: bigint | null; pyBilled: bigint | null; pyCollected: bigint | null }[]
      >`
        SELECT
          (SELECT sum(b.total_amount) FROM bill b
            WHERE b.tenant_id = ${ctx.tenantId}::uuid
              AND b.period >= ${y + '01'} AND b.period <= ${y + '12'}
              AND b.bill_kind <> 'REVERSAL'
              AND b.status IN ('POSTED','PARTIAL_PAID','PAID') ${waB})::bigint AS billed,
          (SELECT sum(p.amount) FROM payment p
            WHERE p.tenant_id = ${ctx.tenantId}::uuid
              AND p.status IN ('RECEIVED','DAY_CLOSED')
              AND p.received_at >= ${gte} AND p.received_at < ${lt} ${orgIn})::bigint AS collected,
          (SELECT sum(b.total_amount) FROM bill b
            WHERE b.tenant_id = ${ctx.tenantId}::uuid
              AND b.period >= ${prevYear + '01'} AND b.period <= ${prevYear + '12'}
              AND b.bill_kind <> 'REVERSAL'
              AND b.status IN ('POSTED','PARTIAL_PAID','PAID') ${waB})::bigint AS "pyBilled",
          (SELECT sum(p.amount) FROM payment p
            WHERE p.tenant_id = ${ctx.tenantId}::uuid
              AND p.status IN ('RECEIVED','DAY_CLOSED')
              AND p.received_at >= ${pyGte} AND p.received_at < ${pyLt} ${orgIn})::bigint AS "pyCollected"`;

      const accountStats = await tx.$queryRaw<
        { active: number; opened: number; closed: number }[]
      >`
        SELECT (SELECT count(*)::int FROM water_account w
                  WHERE w.tenant_id = ${ctx.tenantId}::uuid AND w.status = 'NORMAL') AS active,
               (SELECT count(*)::int FROM water_account w
                  WHERE w.tenant_id = ${ctx.tenantId}::uuid
                    AND w.opened_at >= ${gte}::date AND w.opened_at < ${lt}::date) AS opened,
               (SELECT count(*)::int FROM water_account w
                  WHERE w.tenant_id = ${ctx.tenantId}::uuid
                    AND w.closed_at >= ${gte}::date AND w.closed_at < ${lt}::date) AS closed`;

      // 坏账核销清单（G2）
      const writeoffs = await tx.$queryRaw<
        {
          settleNo: string; name: string; amount: bigint;
          reasonCode: string; reasonName: string | null;
          effectiveDate: Date; status: string;
        }[]
      >`
        SELECT sa.settle_no AS "settleNo", sa.name, w.amount,
               w.reason_code AS "reasonCode", d.name AS "reasonName",
               w.effective_date AS "effectiveDate",
               w.status::text AS status
        FROM bad_debt_writeoff w
        JOIN settle_account sa ON sa.tenant_id = w.tenant_id AND sa.id = w.settle_account_id
        LEFT JOIN sys_dict d
          ON d.tenant_id = w.tenant_id AND d.category = 'WRITEOFF_REASON'
          AND d.code = w.reason_code
        WHERE w.tenant_id = ${ctx.tenantId}::uuid
          AND w.effective_date >= ${gte}::date AND w.effective_date < ${lt}::date
        ORDER BY w.effective_date`;

      const writeoffTotal = writeoffs
        .filter((r) => r.status === 'ACTIVE')
        .reduce((s, r) => s + r.amount, 0n);

      // 大额欠费户 TOP 20
      const topArrears = await tx.$queryRaw<
        { accountNo: string; customerName: string; arrears: bigint; oldestPeriod: string }[]
      >`
        SELECT wa.account_no AS "accountNo", c.name AS "customerName",
               sum(b.total_amount - COALESCE(a.paid,0))::bigint AS arrears,
               min(b.period)::bigint AS "oldestPeriod"
        FROM bill b
        JOIN water_account wa ON wa.tenant_id = b.tenant_id AND wa.id = b.water_account_id
        JOIN customer c ON c.tenant_id = wa.tenant_id AND c.id = wa.customer_id
        LEFT JOIN LATERAL (
          SELECT sum(pa.amount)::bigint AS paid FROM payment_alloc pa
          WHERE pa.tenant_id = b.tenant_id AND pa.bill_id = b.id) a ON true
        WHERE b.tenant_id = ${ctx.tenantId}::uuid
          AND b.status IN ('POSTED','PARTIAL_PAID')
          AND b.bill_kind <> 'REVERSAL' ${waB}
        GROUP BY wa.id, wa.account_no, c.name
        HAVING sum(b.total_amount - COALESCE(a.paid,0)) > 0
        ORDER BY arrears DESC LIMIT 20`;

      // 红冲/退费汇总（按渠道）
      const reversals = await tx.$queryRaw<
        { channel: string; amount: bigint | null; cnt: number }[]
      >`
        SELECT p.channel::text AS channel, sum(p.amount)::bigint AS amount, count(*)::int AS cnt
        FROM payment p
        WHERE p.tenant_id = ${ctx.tenantId}::uuid
          AND p.status IN ('RECEIVED','DAY_CLOSED')
          AND p.received_at >= ${gte} AND p.received_at < ${lt}
          AND p.amount < 0 ${orgIn}
        GROUP BY p.channel`;

      // 销户/流失清单
      const closedList = await tx.$queryRaw<
        { accountNo: string; customerName: string; closedAt: Date | null }[]
      >`
        SELECT wa.account_no AS "accountNo", c.name AS "customerName",
               wa.closed_at AS "closedAt"
        FROM water_account wa
        JOIN customer c ON c.tenant_id = wa.tenant_id AND c.id = wa.customer_id
        WHERE wa.tenant_id = ${ctx.tenantId}::uuid
          AND wa.closed_at >= ${gte}::date AND wa.closed_at < ${lt}::date
          ${aggOwnPredicate(inScope, Prisma.sql`wa.id`)}
        ORDER BY wa.closed_at`;

      const t0 = totals[0] ?? { billed: 0n, collected: 0n, pyBilled: 0n, pyCollected: 0n };
      return {
        year: q.year,
        metricVersion: METRIC_DICT_VERSION,
        totals: {
          AR_AMOUNT: t0.billed ?? 0n,
          COLLECTED: t0.collected ?? 0n,
          REVENUE_GROWTH: ratio((t0.billed ?? 0n) - (t0.pyBilled ?? 0n), t0.pyBilled ?? 0n),
          ACCOUNT_COUNT: accountStats[0]?.active ?? 0,
          NEW_ACCOUNTS: accountStats[0]?.opened ?? 0,
          CLOSED_ACCOUNTS: accountStats[0]?.closed ?? 0,
          NET_NEW_ACCOUNTS:
            (accountStats[0]?.opened ?? 0) - (accountStats[0]?.closed ?? 0),
          BAD_DEBT_WRITEOFF: writeoffTotal,
        },
        trend: trend.map((r) => ({
          period: r.period,
          billed: r.billed ?? 0n,
          collected: collectedByMonth.get(r.period) ?? 0n,
          soldQty: qtyByPeriod.get(r.period) ?? '0',
        })),
        lists: { topArrears, writeoffs, reversals, closedList },
      };
    });
  }
}
