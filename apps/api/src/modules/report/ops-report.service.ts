import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  aggregationScopeAccountIds,
  aggOwnPredicate,
} from '../../common/account-aggregation-ownership.js';
import type { TenantCtx } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { METRIC_DICT, METRIC_DICT_VERSION } from './metric-dictionary.js';
import {
  buildMonthlyChecks,
  buildYearlyChecks,
  loadCheckThresholds,
  type CheckThresholds,
} from './report-checks.js';

/**
 * 窗口化经营指标引擎（2026-10-16 修订意见 Q1/Q2/R4/R5/R7/H1 共用内核）。
 *
 * 口径唯一来源 = METRIC_DICT 公式；本类把 analysis.service 的「单账期」
 * 计算参数化为任意账期窗口 [from..to]（YYYYMM 闭区间），同一条 SQL 同时
 * 支撑「本月数 / 上年同期 / 本年累计 / 上年同期累计」四种窗口，天然同源。
 *
 * 时点指标（欠费/预存/在册户）一律取窗口末日快照；流量指标为窗口求和；
 * 比率指标由窗口内的分子分母重算，绝不把各月比率做平均。
 *
 * R7 组织归属：
 *   - 户锚定指标（水量/账单/欠费/户数/抄表质量）→ 户的覆盖册 orgUnitId
 *     （aggregationScopeAccountIds，一册一户常态；多册异态 fail-closed）
 *   - 收款锚定指标（实收/当期/陈欠收取）→ payment.org_unit_id
 *   - orgUnitId 参数取 org_unit 子树后与 caller orgScope 求交（无权越界放大）。
 */

export interface WindowMetrics {
  soldQty: string;
  waterFee: bigint;
  arAmount: bigint;
  collected: bigint;
  currentCollected: bigint;
  arrearsCollected: bigint;
  /** 窗口期账单在期末前的全部销账（含期前提前收款），R1 资金滚动用 */
  windowPaid: bigint;
  arrearsTotal: bigint;
  arrearsStart: bigint;
  cumAr: bigint;
  prepayBalance: bigint;
  accountCount: number;
  openedCount: number;
  closedCount: number;
  qcPassed: number;
  qcTotal: number;
  planRead: number;
  planTotal: number;
  estCount: number;
  estTotal: number;
  timely: number;
  timelyTotal: number;
}

export interface ReportMeta {
  companyName: string;
  orgLabel: string;
  orgUnitId: string | null;
  preparedBy: string;
  preparedAt: string;
  /** 指标口径版本 —— 与指标字典页/日周月年报一致的版本标识。 */
  metricVersion: string;
  /**
   * 存档报表金额单位（N6）：tenant_param `report.amountUnit`，
   * '元'（默认）或 '万元'。数据层值恒为元，展示/导出按此换算。
   */
  amountUnit: '元' | '万元';
}

const num = (v: string | null | undefined) => (v ? Number(v) : 0);
const pct = (a: number, b: number) => (b === 0 ? null : (a / b) * 100);
const pctBig = (a: bigint, b: bigint) =>
  b === 0n ? null : (Number(a) / Number(b)) * 100;
const yoyPct = (cur: number, prev: number | null) =>
  prev === null || prev === 0 ? null : ((cur - prev) / Math.abs(prev)) * 100;

/** YYYYMM → [月初 00:00, 次月初 00:00)。 */
const monthStart = (period: string): Date =>
  new Date(Date.UTC(+period.slice(0, 4), +period.slice(4) - 1, 1));
const monthEndExclusive = (period: string): Date =>
  new Date(Date.UTC(+period.slice(0, 4), +period.slice(4), 1));
const shiftPeriod = (period: string, months: number): string => {
  const y = +period.slice(0, 4);
  const m = +period.slice(4) - 1 + months;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12 + 1;
  return `${yy}${String(mm).padStart(2, '0')}`;
};

@Injectable()
export class OpsReportService {
  constructor(private readonly prisma: TenantPrismaService) {}

  /**
   * orgUnitId → 子树 ids（含自身），与 caller orgScope 求交。
   * 返回 narrowed ctx + 报表「填报单位」标签链。
   */
  private async resolveScope(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    orgUnitId?: string,
  ): Promise<{ effCtx: TenantCtx; orgLabel: string; subtree: string[] | null }> {
    if (!orgUnitId) return { effCtx: ctx, orgLabel: '全公司', subtree: null };
    const subtree = await tx.$queryRaw<{ id: string }[]>`
      WITH RECURSIVE sub AS (
        SELECT id FROM org_unit
         WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${orgUnitId}::uuid
        UNION ALL
        SELECT o.id FROM org_unit o
        JOIN sub s ON o.parent_id = s.id
         WHERE o.tenant_id = ${ctx.tenantId}::uuid
      )
      SELECT id FROM sub`;
    const ids = subtree.map((r) => r.id);
    if (ids.length === 0) {
      throw new NotFoundException({ code: 'ORG_NOT_FOUND', orgUnitId });
    }
    const org = await tx.orgUnit.findFirst({
      where: { tenantId: ctx.tenantId, id: orgUnitId },
      select: { name: true },
    });
    if (!org) throw new NotFoundException({ code: 'ORG_NOT_FOUND', orgUnitId });
    const eff =
      ctx.scope === 'ALL' ? ids : ids.filter((id) => ctx.orgScope.includes(id));
    return {
      effCtx: { ...ctx, scope: 'ORG_SUBTREE', orgScope: eff },
      orgLabel: org.name,
      subtree: ids,
    };
  }

  /** 报表元信息：公司名（tenant_param company.name ?? tenant.name）+ 填报单位。 */
  private async reportMeta(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    orgLabel: string,
  ): Promise<ReportMeta> {
    const [param, unitParam, tenant, staff] = await Promise.all([
      tx.tenantParam.findUnique({
        where: { tenantId_key: { tenantId: ctx.tenantId, key: 'company.name' } },
      }),
      tx.tenantParam.findUnique({
        where: { tenantId_key: { tenantId: ctx.tenantId, key: 'report.amountUnit' } },
      }),
      tx.tenant.findUnique({ where: { id: ctx.tenantId }, select: { name: true } }),
      tx.staff.findUnique({
        where: { tenantId_id: { tenantId: ctx.tenantId, id: ctx.staffId } },
        select: { name: true },
      }),
    ]);
    const companyName =
      (typeof param?.value === 'string' ? param.value : null) ??
      tenant?.name ??
      '';
    return {
      companyName,
      orgLabel,
      orgUnitId: orgLabel === '全公司' ? null : orgLabel,
      preparedBy: staff?.name ?? '',
      preparedAt: new Date().toISOString().slice(0, 10),
      metricVersion: METRIC_DICT_VERSION,
      amountUnit: unitParam?.value === '万元' ? '万元' : '元',
    };
  }

  /**
   * 窗口指标计算 —— R4/R5/Q1/Q2/H1 的共用内核。
   * `from`/`to` 为 YYYYMM 闭区间；时点指标取 to 月末快照。
   */
  private async metricsWindow(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    from: string,
    to: string,
  ): Promise<WindowMetrics> {
    const inScope = await aggregationScopeAccountIds(tx, ctx);
    const waB = aggOwnPredicate(inScope, Prisma.sql`b.water_account_id`);
    const waCs = aggOwnPredicate(inScope, Prisma.sql`cs.water_account_id`);
    const waW = aggOwnPredicate(inScope, Prisma.sql`w.id`);
    const waI = aggOwnPredicate(inScope, Prisma.sql`i.water_account_id`);
    const orgIn =
      ctx.scope === 'ALL'
        ? Prisma.empty
        : Prisma.sql`AND p.org_unit_id = ANY(${ctx.orgScope}::uuid[])`;
    const gte = monthStart(from);
    const lt = monthEndExclusive(to);

    const [soldQty, ar, collected, allocSplit, arrearsRows, waterFee, cumAr,
      prepay, accountStats, qcRows, planItems, estRows, timelyRows] =
      await Promise.all([
        tx.$queryRaw<{ qty: string | null }[]>`
          SELECT sum(cs.total_usage_qty)::text AS qty
          FROM consumption_settlement cs
          WHERE cs.tenant_id = ${ctx.tenantId}::uuid
            AND cs.period >= ${from} AND cs.period <= ${to}
            AND cs.status = 'FINAL' ${waCs}`,
        tx.$queryRaw<{ amount: bigint | null }[]>`
          SELECT sum(b.total_amount)::bigint AS amount FROM bill b
          WHERE b.tenant_id = ${ctx.tenantId}::uuid
            AND b.period >= ${from} AND b.period <= ${to}
            AND b.bill_kind <> 'REVERSAL'
            AND b.status IN ('POSTED','PARTIAL_PAID','PAID') ${waB}`,
        tx.$queryRaw<{ amount: bigint | null }[]>`
          SELECT sum(p.amount)::bigint AS amount FROM payment p
          WHERE p.tenant_id = ${ctx.tenantId}::uuid
            AND p.status IN ('RECEIVED','DAY_CLOSED')
            AND p.received_at >= ${gte} AND p.received_at < ${lt} ${orgIn}`,
        // 当期实收 = 窗口内账单的销账额（销账发生在窗口内、且按期口径）；
        // 陈欠收取 = 更早账单的销账额。与 analysis.service 同口径。
        // 1029 G1：另返回 windowPaid = 窗口期账单在期末前的全部销账
        // （含提前收款）——R1 资金滚动需要它，否则"9 月收款付 10 月单"
        // 会被误判为欠费滞留。
        tx.$queryRaw<{ current: bigint | null; arrears: bigint | null; windowPaid: bigint | null }[]>`
          SELECT sum(CASE WHEN b.period >= ${from} AND b.period <= ${to}
                           AND COALESCE(p.received_at, e.created_at) >= ${gte}
                           AND (b.due_date IS NULL
                                OR COALESCE(p.received_at, e.created_at)::date <= b.due_date)
                          THEN a.amount ELSE 0 END)::bigint AS current,
                 sum(CASE WHEN b.period < ${from}
                           AND COALESCE(p.received_at, e.created_at) >= ${gte}
                          THEN a.amount ELSE 0 END)::bigint AS arrears,
                 sum(CASE WHEN b.period >= ${from} AND b.period <= ${to}
                          THEN a.amount ELSE 0 END)::bigint AS "windowPaid"
          FROM payment_alloc a
          JOIN bill b ON b.tenant_id = a.tenant_id AND b.id = a.bill_id
          LEFT JOIN payment p ON p.tenant_id = a.tenant_id AND p.id = a.payment_id
           AND p.status IN ('RECEIVED','DAY_CLOSED')
          LEFT JOIN prepayment_ledger_entry e
            ON e.tenant_id = a.tenant_id AND e.id = a.prepayment_entry_id
          WHERE a.tenant_id = ${ctx.tenantId}::uuid
            AND b.period <= ${to}
            AND COALESCE(p.received_at, e.created_at) < ${lt}
            AND (COALESCE(p.received_at, e.created_at) >= ${gte}
                 OR (b.period >= ${from} AND b.period <= ${to}))
            ${aggOwnPredicate(inScope, Prisma.sql`b.water_account_id`)}`,
        // 1028v3 核查 F1/F3/F4：期初/期末欠费取「时点余额」——期初=窗口
        // 开始前已核销分摊、期末=窗口截止前已核销分摊；此前用全时分摊会把
        // 期内收款提前计入期初、期后收款提前计入期末，两期均被低估。
        tx.$queryRaw<{ period: string; rem_start: bigint; rem_end: bigint }[]>`
          SELECT b.period,
                 GREATEST(b.total_amount - COALESCE(pb.paid, 0), 0)::bigint AS rem_start,
                 GREATEST(b.total_amount - COALESCE(pe.paid, 0), 0)::bigint AS rem_end
          FROM bill b
          LEFT JOIN LATERAL (
            SELECT sum(pa.amount)::bigint AS paid FROM payment_alloc pa
            LEFT JOIN payment p ON p.tenant_id = pa.tenant_id AND p.id = pa.payment_id
            LEFT JOIN prepayment_ledger_entry e
              ON e.tenant_id = pa.tenant_id AND e.id = pa.prepayment_entry_id
            WHERE pa.tenant_id = b.tenant_id AND pa.bill_id = b.id
              AND COALESCE(p.received_at, e.created_at) < ${gte}) pb ON true
          LEFT JOIN LATERAL (
            SELECT sum(pa.amount)::bigint AS paid FROM payment_alloc pa
            LEFT JOIN payment p ON p.tenant_id = pa.tenant_id AND p.id = pa.payment_id
            LEFT JOIN prepayment_ledger_entry e
              ON e.tenant_id = pa.tenant_id AND e.id = pa.prepayment_entry_id
            WHERE pa.tenant_id = b.tenant_id AND pa.bill_id = b.id
              AND COALESCE(p.received_at, e.created_at) < ${lt}) pe ON true
          WHERE b.tenant_id = ${ctx.tenantId}::uuid
            AND b.status IN ('POSTED','PARTIAL_PAID','PAID')
            AND b.bill_kind <> 'REVERSAL' ${waB}`,
        tx.$queryRaw<{ amount: bigint | null }[]>`
          SELECT sum(bi.amount)::bigint AS amount
          FROM bill_item bi
          JOIN bill b ON b.tenant_id = bi.tenant_id AND b.id = bi.bill_id
          JOIN fee_item fi ON fi.tenant_id = bi.tenant_id AND fi.id = bi.fee_item_id
          WHERE bi.tenant_id = ${ctx.tenantId}::uuid
            AND b.period >= ${from} AND b.period <= ${to}
            AND b.bill_kind <> 'REVERSAL'
            AND b.status IN ('POSTED','PARTIAL_PAID','PAID')
            AND fi.kind = 'WATER_FEE'
            ${aggOwnPredicate(inScope, Prisma.sql`b.water_account_id`)}`,
        tx.$queryRaw<{ amount: bigint | null }[]>`
          SELECT sum(b.total_amount)::bigint AS amount FROM bill b
          WHERE b.tenant_id = ${ctx.tenantId}::uuid AND b.period <= ${to}
            AND b.bill_kind <> 'REVERSAL'
            AND b.status IN ('POSTED','PARTIAL_PAID','PAID') ${waB}`,
        tx.$queryRaw<{ balance: bigint | null }[]>`
          SELECT sum(e.amount)::bigint AS balance
          FROM prepayment_ledger_entry e
          JOIN settle_account sa ON sa.tenant_id = e.tenant_id AND sa.id = e.settle_account_id
          WHERE e.tenant_id = ${ctx.tenantId}::uuid AND sa.status <> 'CLOSED'`,
        // 1028v3 核查 2.3/F7：户数口径剔除监控表户（MONITORING 为计量
        // 监控点、非计费用水户）；opened_at 可能为空，回退 created_at。
        // 1029 G2：三项户数一律取「窗口时点快照」而非当前状态——
        // active = 期末在册（期前已立户且期末未销户），历史周期回放
        // 也能还原当时在册数；pending 户（放号/补录中）尚未入册不计。
        tx.$queryRaw<{ active: number; opened: number; closed: number }[]>`
          SELECT count(*) FILTER (WHERE COALESCE(w.opened_at, w.created_at) < ${lt}::date
                                   AND (w.closed_at IS NULL OR w.closed_at >= ${lt}::date))::int AS active,
                 count(*) FILTER (WHERE COALESCE(w.opened_at, w.created_at) >= ${gte}::date
                                   AND COALESCE(w.opened_at, w.created_at) < ${lt}::date)::int AS opened,
                 count(*) FILTER (WHERE w.closed_at >= ${gte}::date
                                   AND w.closed_at < ${lt}::date)::int AS closed
          FROM water_account w
          WHERE w.tenant_id = ${ctx.tenantId}::uuid
            AND w.usage_category <> 'MONITORING'
            AND w.status NOT IN ('PENDING_ASSIGN','PENDING_COMPLETE') ${waW}`,
        tx.$queryRaw<{ qc: string; cnt: number }[]>`
          SELECT r.qc_status::text AS qc, count(*)::int AS cnt
          FROM meter_reading r
          JOIN meter_installation i ON i.tenant_id = r.tenant_id AND i.id = r.installation_id
          JOIN water_account wa ON wa.tenant_id = i.tenant_id AND wa.id = i.water_account_id
          WHERE r.tenant_id = ${ctx.tenantId}::uuid
            AND r.period >= ${from} AND r.period <= ${to}
            AND r.qc_status IN ('PASSED','REJECTED','MANUAL_REVIEW')
            AND NOT EXISTS (
              SELECT 1 FROM meter_reading ch
              WHERE ch.tenant_id = r.tenant_id AND ch.supersedes_reading_id = r.id)
            ${aggOwnPredicate(inScope, Prisma.sql`wa.id`)}
          GROUP BY r.qc_status`,
        tx.$queryRaw<{ status: string; cnt: number }[]>`
          SELECT i.status::text AS status, count(*)::int AS cnt
          FROM reading_plan_item i
          JOIN reading_plan p ON p.tenant_id = i.tenant_id AND p.id = i.plan_id
          JOIN water_account wa2 ON wa2.tenant_id = i.tenant_id
            AND wa2.id = i.water_account_id
          WHERE i.tenant_id = ${ctx.tenantId}::uuid
            AND p.period >= ${from} AND p.period <= ${to}
            AND wa2.status = 'NORMAL' AND wa2.billable
            AND wa2.usage_category <> 'MONITORING'
            ${waI}
          GROUP BY i.status`,
        tx.$queryRaw<{ est: number; total: number }[]>`
          SELECT count(*) FILTER (WHERE cc.source_type = 'ESTIMATE')::int AS est,
                 count(*)::int AS total
          FROM consumption_component cc
          JOIN consumption_settlement cs
            ON cs.tenant_id = cc.tenant_id AND cs.id = cc.settlement_id
          WHERE cc.tenant_id = ${ctx.tenantId}::uuid
            AND cs.period >= ${from} AND cs.period <= ${to}
            AND cs.status = 'FINAL' ${waCs}`,
        tx.$queryRaw<{ timely: number; total: number }[]>`
          SELECT count(*) FILTER (WHERE r.read_date <= p.plan_date)::int AS timely,
                 count(*)::int AS total
          FROM meter_reading r
          JOIN reading_plan_item i ON i.tenant_id = r.tenant_id AND i.id = r.plan_item_id
          JOIN reading_plan p ON p.tenant_id = i.tenant_id AND p.id = i.plan_id
          JOIN meter_installation mi ON mi.tenant_id = r.tenant_id AND mi.id = r.installation_id
          JOIN water_account wa ON wa.tenant_id = mi.tenant_id AND wa.id = mi.water_account_id
          WHERE r.tenant_id = ${ctx.tenantId}::uuid
            AND p.period >= ${from} AND p.period <= ${to}
            AND NOT EXISTS (
              SELECT 1 FROM meter_reading ch
              WHERE ch.tenant_id = r.tenant_id AND ch.supersedes_reading_id = r.id)
            ${aggOwnPredicate(inScope, Prisma.sql`wa.id`)}`,
      ]);

    const qcTotal = qcRows.reduce((s, r) => s + r.cnt, 0);
    const planTotal = planItems.reduce((s, r) => s + r.cnt, 0);
    return {
      soldQty: soldQty[0]?.qty ?? '0',
      waterFee: waterFee[0]?.amount ?? 0n,
      arAmount: ar[0]?.amount ?? 0n,
      collected: collected[0]?.amount ?? 0n,
      currentCollected: allocSplit[0]?.current ?? 0n,
      arrearsCollected: allocSplit[0]?.arrears ?? 0n,
      windowPaid: allocSplit[0]?.windowPaid ?? 0n,
      arrearsTotal: arrearsRows
        .filter((r) => r.period <= to && r.rem_end > 0n)
        .reduce((s, r) => s + r.rem_end, 0n),
      arrearsStart: arrearsRows
        .filter((r) => r.period < from && r.rem_start > 0n)
        .reduce((s, r) => s + r.rem_start, 0n),
      cumAr: cumAr[0]?.amount ?? 0n,
      prepayBalance: prepay[0]?.balance ?? 0n,
      accountCount: accountStats[0]?.active ?? 0,
      openedCount: accountStats[0]?.opened ?? 0,
      closedCount: accountStats[0]?.closed ?? 0,
      qcPassed: qcRows.find((r) => r.qc === 'PASSED')?.cnt ?? 0,
      qcTotal,
      planRead: planItems.find((r) => r.status === 'READ')?.cnt ?? 0,
      planTotal,
      estCount: estRows[0]?.est ?? 0,
      estTotal: estRows[0]?.total ?? 0,
      timely: timelyRows[0]?.timely ?? 0,
      timelyTotal: timelyRows[0]?.total ?? 0,
    };
  }

  /**
   * 数据自检（1028 v3）补充数据：期初户数 / 已结算未出账 / 单户用量
   * 异常 / 大额收款 —— 窗口口径与 metricsWindow 完全同源。
   */
  private async checkExtras(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    from: string,
    to: string,
    thresholds: CheckThresholds,
  ): Promise<{
    openingAccounts: number;
    missingBills: number;
    usageAnomalies: string[];
    bigPayments: string[];
  }> {
    const inScope = await aggregationScopeAccountIds(tx, ctx);
    const waW = aggOwnPredicate(inScope, Prisma.sql`w.id`);
    const waCs = aggOwnPredicate(inScope, Prisma.sql`cs.water_account_id`);

    const orgIn =
      ctx.scope === 'ALL'
        ? Prisma.empty
        : Prisma.sql`AND p.org_unit_id = ANY(${ctx.orgScope}::uuid[])`;
    const gte = monthStart(from);
    const lt = monthEndExclusive(to);
    const bigCents = BigInt(Math.round(thresholds.bigPayment * 100));
    const x = thresholds.usageAnomalyX;

    const [openRow, missRow, anomalyRows, bigRows] = await Promise.all([
      // 期初在册：窗口开始前已立户且尚未销户（含窗口内销户的户——
      // 它们期初在册、同时计入 closedCount，等式才平衡）；剔除监控表户；
      // opened_at 为空的历史导入户按 created_at 计入期初。
      tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM water_account w
        WHERE w.tenant_id = ${ctx.tenantId}::uuid
          AND w.usage_category <> 'MONITORING'
          AND COALESCE(w.opened_at, w.created_at) < ${gte}::date
          AND (w.closed_at IS NULL OR w.closed_at >= ${gte}::date)
          AND w.status NOT IN ('PENDING_ASSIGN','PENDING_COMPLETE')
          ${waW}`,
      // 完整性：窗口内已 FINAL 结算但没有有效账单（=遗漏户）
      tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n
        FROM consumption_settlement cs
        WHERE cs.tenant_id = ${ctx.tenantId}::uuid
          AND cs.period >= ${from} AND cs.period <= ${to}
          AND cs.status = 'FINAL'
          ${waCs}
          AND NOT EXISTS (
            SELECT 1 FROM bill b
            WHERE b.tenant_id = cs.tenant_id
              AND b.source_type = 'SETTLEMENT' AND b.source_id = cs.id
              AND b.bill_kind <> 'REVERSAL' AND b.status <> 'REVERSED')`,
      // R12 单户用量异常：本期结算量 > X × 近 3 期均值（近 3 期各户独立取）
      tx.$queryRaw<{ accountNo: string }[]>`
        WITH cur AS (
          SELECT cs.water_account_id, cs.total_usage_qty
          FROM consumption_settlement cs
          WHERE cs.tenant_id = ${ctx.tenantId}::uuid
            AND cs.period = ${to} AND cs.status = 'FINAL'
            ${waCs}
        ),
        prev3 AS (
          SELECT water_account_id, avg(total_usage_qty) AS avg_qty
          FROM (
            SELECT cs.water_account_id, cs.total_usage_qty,
                   row_number() OVER (
                     PARTITION BY cs.water_account_id ORDER BY cs.period DESC
                   ) AS rn
            FROM consumption_settlement cs
            JOIN cur ON cur.water_account_id = cs.water_account_id
            WHERE cs.tenant_id = ${ctx.tenantId}::uuid
              AND cs.period < ${to} AND cs.status = 'FINAL'
          ) s
          WHERE rn <= 3
          GROUP BY water_account_id
        )
        SELECT wa.account_no AS "accountNo"
        FROM cur
        JOIN prev3 ON prev3.water_account_id = cur.water_account_id
        JOIN water_account wa ON wa.tenant_id = ${ctx.tenantId}::uuid
          AND wa.id = cur.water_account_id
        WHERE prev3.avg_qty > 0
          AND cur.total_usage_qty > ${x}::numeric * prev3.avg_qty
        ORDER BY wa.account_no LIMIT 20`,
      // R13 大额收款：窗口内单笔 > 阈值
      tx.$queryRaw<{ amount: bigint; label: string }[]>`
        SELECT p.amount,
               concat_ws(' ', sa.settle_no, sa.name) AS label
        FROM payment p
        JOIN settle_account sa ON sa.tenant_id = p.tenant_id
          AND sa.id = p.settle_account_id
        WHERE p.tenant_id = ${ctx.tenantId}::uuid
          AND p.status IN ('RECEIVED','DAY_CLOSED')
          AND p.received_at >= ${gte} AND p.received_at < ${lt}
          AND p.amount > ${bigCents}
          ${orgIn}
        ORDER BY p.amount DESC LIMIT 10`,
    ]);

    return {
      openingAccounts: openRow[0]?.n ?? 0,
      missingBills: missRow[0]?.n ?? 0,
      usageAnomalies: anomalyRows.map((r) => r.accountNo),
      bigPayments: bigRows.map(
        (r) => `${r.label ?? ''} ¥${(Number(r.amount) / 100).toLocaleString('zh-CN')}`,
      ),
    };
  }

  /** 月度活动检测（R9 缺失月用）：该月是否有任何业务数据。 */
  private async monthHasActivity(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    period: string,
  ): Promise<boolean> {
    const inScope = await aggregationScopeAccountIds(tx, ctx);
    const waB = aggOwnPredicate(inScope, Prisma.sql`b.water_account_id`);
    const waCs = aggOwnPredicate(inScope, Prisma.sql`cs.water_account_id`);
    const waI = aggOwnPredicate(inScope, Prisma.sql`i.water_account_id`);
    const orgIn =
      ctx.scope === 'ALL'
        ? Prisma.empty
        : Prisma.sql`AND p.org_unit_id = ANY(${ctx.orgScope}::uuid[])`;
    const gte = monthStart(period);
    const lt = monthEndExclusive(period);
    const rows = await tx.$queryRaw<{ n: number }[]>`
      SELECT (
        (SELECT count(*) FROM bill b WHERE b.tenant_id = ${ctx.tenantId}::uuid
          AND b.period = ${period} AND b.bill_kind <> 'REVERSAL' ${waB}) +
        (SELECT count(*) FROM consumption_settlement cs
          WHERE cs.tenant_id = ${ctx.tenantId}::uuid AND cs.period = ${period} ${waCs}) +
        (SELECT count(*) FROM meter_reading r
          JOIN meter_installation i ON i.tenant_id = r.tenant_id AND i.id = r.installation_id
          WHERE r.tenant_id = ${ctx.tenantId}::uuid AND r.period = ${period} ${waI}) +
        (SELECT count(*) FROM payment p WHERE p.tenant_id = ${ctx.tenantId}::uuid
          AND p.status IN ('RECEIVED','DAY_CLOSED')
          AND p.received_at >= ${gte} AND p.received_at < ${lt} ${orgIn})
      )::int AS n`;
    return (rows[0]?.n ?? 0) > 0;
  }

  // ------------------------------------------------------------------
  // R4 营销经营月报表 —— doc §3.4：六大类 21 指标 × 本期/同比/累计
  // ------------------------------------------------------------------
  async opsMonthly(ctx: TenantCtx, q: { period: string; orgUnitId?: string }) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const { effCtx, orgLabel } = await this.resolveScope(tx, ctx, q.orgUnitId);
      const prevYear = shiftPeriod(q.period, -12);
      const prevMonth = shiftPeriod(q.period, -1);
      const yearStart = `${q.period.slice(0, 4)}01`;
      const prevYearStart = `${prevYear.slice(0, 4)}01`;
      const [thresholds, [cur, prev, cum, prevCum, prevM]] = await Promise.all([
        loadCheckThresholds(tx, ctx.tenantId),
        Promise.all([
          this.metricsWindow(tx, effCtx, q.period, q.period),
          this.metricsWindow(tx, effCtx, prevYear, prevYear),
          this.metricsWindow(tx, effCtx, yearStart, q.period),
          this.metricsWindow(tx, effCtx, prevYearStart, prevYear),
          // R6 环比：上一自然月窗口
          this.metricsWindow(tx, effCtx, prevMonth, prevMonth),
        ]),
      ]);
      const extras = await this.checkExtras(tx, effCtx, q.period, q.period, thresholds);
      const meta = await this.reportMeta(tx, ctx, orgLabel);

      type Row = {
        key: string; name: string; unit: string;
        current: number | null; prevYear: number | null;
        cum: number | null; prevCum: number | null;
      };
      const F = (m: WindowMetrics) => ({
        soldQty: num(m.soldQty),
        waterFee: Number(m.waterFee) / 100,
        ar: Number(m.arAmount) / 100,
        collected: Number(m.collected) / 100,
        current: Number(m.currentCollected) / 100,
        arrearsCol: Number(m.arrearsCollected) / 100,
        recovery: pct(m.currentCollected === 0n ? 0 : Number(m.currentCollected), Number(m.arAmount)),
        prepayBal: Number(m.prepayBalance) / 100,
        prepayRate: pctBig(m.prepayBalance, m.cumAr),
        arrearsTotal: Number(m.arrearsTotal) / 100,
        arrearsRate: pctBig(m.arrearsTotal, m.cumAr),
        arrearsRecRate: pctBig(m.arrearsCollected, m.arrearsStart),
        readAcc: pct(m.qcPassed, m.qcTotal),
        readCov: pct(m.planRead, m.planTotal),
        estRate: pct(m.estCount, m.estTotal),
        readTimely: pct(m.timely, m.timelyTotal),
        accounts: m.accountCount,
        opened: m.openedCount,
        closed: m.closedCount,
        revGrowth: null as number | null,
      });
      const C = F(cur); const P = F(prev); const Y = F(cum); const PY = F(prevCum);
      const revGrowth = (a: number, b: number | null) =>
        b === null || b === 0 ? null : ((a - b) / Math.abs(b)) * 100;

      const row = (
        key: string, name: string, unit: string,
        pick: (f: ReturnType<typeof F>) => number | null,
        opts?: { stock?: boolean },
      ): Row => ({
        key, name, unit,
        current: pick(C), prevYear: pick(P),
        cum: opts?.stock ? null : pick(Y),
        prevCum: opts?.stock ? null : pick(PY),
      });

      const sections = [
        {
          name: '一、售水及收入',
          rows: [
            row('SOLD_QTY', '售水量', 'm³', (f) => f.soldQty),
            row('WATER_FEE', '售水收入', '元', (f) => f.waterFee),
            row('COMPOSITE_PRICE', '综合单价', '元/m³',
              (f) => (f.soldQty > 0 ? f.waterFee / f.soldQty : null)),
          ],
        },
        {
          name: '二、收费',
          rows: [
            row('COLLECTED', '实收水费', '元', (f) => f.collected),
            row('CURRENT_COLLECTED', '其中：当期实收', '元', (f) => f.current),
            row('ARREARS_COLLECTED', '其中：欠费收取', '元', (f) => f.arrearsCol),
            row('RECOVERY_RATE', '水费回收率（当期）', '%', (f) => f.recovery),
            row('PREPAY_BALANCE', '预存余额', '元', (f) => f.prepayBal, { stock: true }),
            row('PREPAY_RATE', '预存比率', '%', (f) => f.prepayRate, { stock: true }),
          ],
        },
        {
          name: '三、欠费',
          rows: [
            row('ARREARS_TOTAL', '期末欠费余额', '元', (f) => f.arrearsTotal, { stock: true }),
            row('ARREARS_RATE', '欠费率', '%', (f) => f.arrearsRate, { stock: true }),
            row('ARREARS_RECOVERY_RATE', '欠费回收率（陈欠）', '%', (f) => f.arrearsRecRate, { stock: true }),
          ],
        },
        {
          name: '四、抄表质量',
          rows: [
            row('READ_ACCURACY', '抄表准确率', '%', (f) => f.readAcc),
            row('READ_COVERAGE', '抄见率', '%', (f) => f.readCov),
            row('ESTIMATE_RATE', '估抄率', '%', (f) => f.estRate),
            row('READ_TIMELINESS', '抄表及时率', '%', (f) => f.readTimely),
          ],
        },
        {
          name: '五、客户',
          rows: [
            row('ACCOUNT_COUNT', '在册户数（期末）', '户', (f) => f.accounts, { stock: true }),
            row('NEW_ACCOUNTS', '本月立户', '户', (f) => f.opened),
            row('CLOSED_ACCOUNTS', '本月销户', '户', (f) => f.closed),
            row('NET_NEW_ACCOUNTS', '净增客户', '户',
              (f) => f.opened - f.closed),
          ],
        },
        {
          name: '六、经营效益',
          rows: [
            row('REVENUE_GROWTH', '营收增长率（同比）', '%', () => null),
          ],
        },
      ];
      // 营收增长率 = 本期应收同比（金额指标、非窗口派生）
      const rg = sections[5].rows[0];
      rg.current = revGrowth(C.ar, P.ar);
      rg.prevYear = revGrowth(P.ar, null);
      rg.cum = revGrowth(Y.ar, PY.ar);
      rg.prevCum = null;

      // 1028 v3 数据自检：13 规则五维校验，结果随报表同返。
      const priceOf = (m: WindowMetrics) =>
        num(m.soldQty) > 0 ? Number(m.waterFee) / 100 / num(m.soldQty) : null;
      const checkResults = buildMonthlyChecks(
        {
          arAmount: Number(cur.arAmount),
          collected: Number(cur.collected),
          currentCollected: Number(cur.currentCollected),
          arrearsCollected: Number(cur.arrearsCollected),
          windowPaid: Number(cur.windowPaid),
          arrearsTotal: Number(cur.arrearsTotal),
          arrearsStart: Number(cur.arrearsStart),
          recoveryRate: pct(
            cur.currentCollected === 0n ? 0 : Number(cur.currentCollected),
            Number(cur.arAmount),
          ),
          compositePrice: priceOf(cur),
          compositePricePrev: priceOf(prev),
          arYoy: revGrowth(Number(cur.arAmount), Number(prev.arAmount) || null),
          arMom: revGrowth(Number(cur.arAmount), Number(prevM.arAmount) || null),
          readAcc: pct(cur.qcPassed, cur.qcTotal),
          readCov: pct(cur.planRead, cur.planTotal),
          estRate: pct(cur.estCount, cur.estTotal),
          readTimely: pct(cur.timely, cur.timelyTotal),
          accountCount: cur.accountCount,
          openingAccounts: extras.openingAccounts,
          openedCount: cur.openedCount,
          closedCount: cur.closedCount,
          planRead: cur.planRead,
          planTotal: cur.planTotal,
          missingBills: extras.missingBills,
          usageAnomalies: extras.usageAnomalies,
          bigPayments: extras.bigPayments,
        },
        thresholds,
      );

      return {
        meta: { ...meta, periodLabel: `${q.period.slice(0, 4)} 年 ${+q.period.slice(4)} 月`, unit: meta.amountUnit },
        period: q.period,
        checkResults,
        sections: sections.map((s) => ({
          ...s,
          rows: s.rows.map((r, i) => ({
            seq: i + 1 + sections.slice(0, sections.indexOf(s)).reduce((n, x) => n + x.rows.length, 0),
            ...r,
            yoyPct: yoyPct(r.current ?? 0, r.prevYear),
            cumYoyPct: yoyPct(r.cum ?? 0, r.prevCum),
          })),
        })),
      };
    });
  }

  // ------------------------------------------------------------------
  // R5 营销经营年度汇总表（分月）—— doc §3.5
  // ------------------------------------------------------------------
  async opsYearly(
    ctx: TenantCtx,
    q: { year: string; orgUnitId?: string; columns?: string[] },
  ) {
    const year = q.year;
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const { effCtx, orgLabel } = await this.resolveScope(tx, ctx, q.orgUnitId);
      const meta = await this.reportMeta(tx, ctx, orgLabel);
      const thresholds = await loadCheckThresholds(tx, ctx.tenantId);
      const months = Array.from({ length: 12 }, (_, i) =>
        `${year}${String(i + 1).padStart(2, '0')}`);
      const monthWindows: WindowMetrics[] = [];
      const missingMonths: string[] = [];
      const rows = [] as Record<string, number | string | null>[];
      for (const m of months) {
        const w = await this.metricsWindow(tx, effCtx, m, m);
        monthWindows.push(w);
        if (!(await this.monthHasActivity(tx, effCtx, m))) {
          missingMonths.push(`${+m.slice(4)}月`);
        }
        rows.push({
          month: `${+m.slice(4)} 月`,
          period: m,
          soldQty: num(w.soldQty),
          waterFee: Number(w.waterFee) / 100,
          collected: Number(w.collected) / 100,
          recoveryRate: pct(Number(w.currentCollected), Number(w.arAmount)),
          compositePrice: num(w.soldQty) > 0 ? Number(w.waterFee) / 100 / num(w.soldQty) : null,
          arrearsTotal: Number(w.arrearsTotal) / 100,
        });
      }
      const sum = (k: 'soldQty' | 'waterFee' | 'collected') =>
        rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
      const totals = {
        month: '全年合计 / 平均',
        soldQty: sum('soldQty'),
        waterFee: sum('waterFee'),
        collected: sum('collected'),
        recoveryRate: pct(
          rows.reduce((s, r) => s + Number(r.recoveryRate ?? 0), 0),
          rows.filter((r) => r.recoveryRate !== null).length * 100 || 1,
        ),
        compositePrice: sum('soldQty') > 0 ? sum('waterFee') / sum('soldQty') : null,
        arrearsTotal: rows[11]?.arrearsTotal ?? null,
      };

      // 1028 v3 数据自检（年报口径）：年度窗口 + Σ各月 + 缺失月。
      const yw = await this.metricsWindow(tx, effCtx, `${year}01`, `${year}12`);
      const ywp = await this.metricsWindow(
        tx, effCtx, `${Number(year) - 1}01`, `${Number(year) - 1}12`);
      const yExtras = await this.checkExtras(
        tx, effCtx, `${year}01`, `${year}12`, thresholds);
      const sumW = (pick: (m: WindowMetrics) => bigint) =>
        monthWindows.reduce((s, m) => s + Number(pick(m)), 0);
      const yoyOf = (a: number, b: number) =>
        b === 0 ? null : ((a - b) / Math.abs(b)) * 100;
      const priceOf = (m: WindowMetrics) =>
        num(m.soldQty) > 0 ? Number(m.waterFee) / 100 / num(m.soldQty) : null;
      const checkResults = buildYearlyChecks(
        {
          arAmount: Number(yw.arAmount),
          collected: Number(yw.collected),
          currentCollected: Number(yw.currentCollected),
          arrearsCollected: Number(yw.arrearsCollected),
          windowPaid: Number(yw.windowPaid),
          arrearsTotal: Number(yw.arrearsTotal),
          arrearsStart: Number(yw.arrearsStart),
          recoveryRate: pct(
            yw.currentCollected === 0n ? 0 : Number(yw.currentCollected),
            Number(yw.arAmount),
          ),
          compositePrice: priceOf(yw),
          compositePricePrev: priceOf(ywp),
          arYoy: yoyOf(Number(yw.arAmount), Number(ywp.arAmount)),
          readAcc: pct(yw.qcPassed, yw.qcTotal),
          readCov: pct(yw.planRead, yw.planTotal),
          estRate: pct(yw.estCount, yw.estTotal),
          readTimely: pct(yw.timely, yw.timelyTotal),
          accountCount: yw.accountCount,
          openingAccounts: yExtras.openingAccounts,
          openedCount: yw.openedCount,
          closedCount: yw.closedCount,
          planRead: yw.planRead,
          planTotal: yw.planTotal,
          usageAnomalies: yExtras.usageAnomalies,
          bigPayments: yExtras.bigPayments,
          yearVsMonthSum: [
            { label: '售水量(m³)', year: num(yw.soldQty), months: monthWindows.reduce((s, m) => s + num(m.soldQty), 0), isMoney: false },
            { label: '售水收入(元)', year: Number(yw.waterFee), months: sumW((m) => m.waterFee) },
            { label: '应收(元)', year: Number(yw.arAmount), months: sumW((m) => m.arAmount) },
            { label: '实收(元)', year: Number(yw.collected), months: sumW((m) => m.collected) },
          ],
          missingMonths,
        },
        thresholds,
      );

      return {
        meta: { ...meta, periodLabel: `${year} 年度`, unit: meta.amountUnit },
        year,
        checkResults,
        columns: q.columns ?? [
          'soldQty', 'waterFee', 'collected', 'recoveryRate', 'compositePrice', 'arrearsTotal',
        ],
        rows: [...rows, totals],
      };
    });
  }

  // ------------------------------------------------------------------
  // Q1 汇总趋势 —— 明细/汇总双模式的汇总侧：近 N 年 + 同比 + 维度
  // ------------------------------------------------------------------
  async unifiedSummary(
    ctx: TenantCtx,
    q: { groupBy?: 'ALL' | 'ORG' | 'CATEGORY'; years?: number; endYear?: number },
  ) {
    const years = Math.min(Math.max(q.years ?? 3, 1), 10);
    const endYear = q.endYear ?? new Date().getUTCFullYear();
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const groupBy = q.groupBy ?? 'ALL';
      const yearList = Array.from({ length: years }, (_, i) => endYear - years + 1 + i);

      if (groupBy === 'ALL') {
        const rows = [];
        for (const y of yearList) {
          const w = await this.metricsWindow(tx, ctx, `${y}01`, `${y}12`);
          const wp = await this.metricsWindow(tx, ctx, `${y - 1}01`, `${y - 1}12`);
          rows.push({
            year: y,
            soldQty: num(w.soldQty), waterFee: Number(w.waterFee) / 100,
            arAmount: Number(w.arAmount) / 100, collected: Number(w.collected) / 100,
            recoveryRate: pct(Number(w.currentCollected), Number(w.arAmount)),
            arrearsTotal: Number(w.arrearsTotal) / 100,
            compositePrice: num(w.soldQty) > 0 ? Number(w.waterFee) / num(w.soldQty) : null,
            accountCount: w.accountCount,
            yoy: {
              soldQty: yoyPct(num(w.soldQty), num(wp.soldQty)),
              waterFee: yoyPct(Number(w.waterFee), Number(wp.waterFee)),
              arAmount: yoyPct(Number(w.arAmount), Number(wp.arAmount)),
              collected: yoyPct(Number(w.collected), Number(wp.collected)),
            },
          });
        }
        return { groupBy, years: yearList, rows };
      }

      // ORG / CATEGORY 维度：按组 × 年聚合（流量三项：售水量/应收/实收）
      const dimSql =
        groupBy === 'ORG'
          ? Prisma.sql`ou.name`
          : Prisma.sql`wa.usage_category`;
      const orgJoin =
        groupBy === 'ORG'
          ? Prisma.sql`LEFT JOIN LATERAL (
              SELECT rb.org_unit_id FROM book_meter bm
              JOIN reading_book rb ON rb.tenant_id = bm.tenant_id AND rb.id = bm.book_id
              WHERE bm.tenant_id = wa.tenant_id AND bm.water_account_id = wa.id
              LIMIT 1) bml ON true
            LEFT JOIN org_unit ou ON ou.tenant_id = wa.tenant_id AND ou.id = bml.org_unit_id`
          : Prisma.empty;

      const grouped = [] as {
        group: string; year: number; soldQty: number; arAmount: number; collected: number;
      }[];
      for (const y of yearList) {
        const from = `${y}01`;
        const to = `${y}12`;
        const gte = monthStart(from);
        const lt = monthEndExclusive(to);
        const [qtyRows, arRows, colRows] = await Promise.all([
          tx.$queryRaw<{ g: string | null; v: string | null }[]>`
            SELECT ${dimSql} AS g, sum(cs.total_usage_qty)::text AS v
            FROM consumption_settlement cs
            JOIN water_account wa ON wa.tenant_id = cs.tenant_id AND wa.id = cs.water_account_id
            ${orgJoin}
            WHERE cs.tenant_id = ${ctx.tenantId}::uuid
              AND cs.period >= ${from} AND cs.period <= ${to}
              AND cs.status = 'FINAL'
            GROUP BY 1`,
          tx.$queryRaw<{ g: string | null; v: bigint | null }[]>`
            SELECT ${dimSql} AS g, sum(b.total_amount)::bigint AS v
            FROM bill b
            JOIN water_account wa ON wa.tenant_id = b.tenant_id AND wa.id = b.water_account_id
            ${orgJoin}
            WHERE b.tenant_id = ${ctx.tenantId}::uuid
              AND b.period >= ${from} AND b.period <= ${to}
              AND b.bill_kind <> 'REVERSAL'
              AND b.status IN ('POSTED','PARTIAL_PAID','PAID')
            GROUP BY 1`,
          groupBy === 'ORG'
            ? tx.$queryRaw<{ g: string | null; v: bigint | null }[]>`
                SELECT ou2.name AS g, sum(p.amount)::bigint AS v
                FROM payment p
                LEFT JOIN org_unit ou2 ON ou2.tenant_id = p.tenant_id AND ou2.id = p.org_unit_id
                WHERE p.tenant_id = ${ctx.tenantId}::uuid
                  AND p.status IN ('RECEIVED','DAY_CLOSED')
                  AND p.received_at >= ${gte} AND p.received_at < ${lt}
                  AND p.org_unit_id = ANY(${ctx.orgScope}::uuid[])
                GROUP BY 1`
            : tx.$queryRaw<{ g: string | null; v: bigint | null }[]>`
                SELECT wa2.usage_category AS g, sum(a.amount)::bigint AS v
                FROM payment_alloc a
                JOIN bill b2 ON b2.tenant_id = a.tenant_id AND b2.id = a.bill_id
                JOIN water_account wa2 ON wa2.tenant_id = b2.tenant_id AND wa2.id = b2.water_account_id
                LEFT JOIN payment p ON p.tenant_id = a.tenant_id AND p.id = a.payment_id
                 AND p.status IN ('RECEIVED','DAY_CLOSED')
                LEFT JOIN prepayment_ledger_entry e
                  ON e.tenant_id = a.tenant_id AND e.id = a.prepayment_entry_id
                WHERE a.tenant_id = ${ctx.tenantId}::uuid
                  AND COALESCE(p.received_at, e.created_at) >= ${gte}
                  AND COALESCE(p.received_at, e.created_at) < ${lt}
                GROUP BY 1`,
        ]);
        const groups = new Set<string>();
        for (const r of [...qtyRows, ...arRows, ...colRows]) groups.add(r.g ?? '未分组');
        for (const g of groups) {
          const qty = num(qtyRows.find((r) => (r.g ?? '未分组') === g)?.v);
          const ar = Number(arRows.find((r) => (r.g ?? '未分组') === g)?.v ?? 0n) / 100;
          const col = Number(colRows.find((r) => (r.g ?? '未分组') === g)?.v ?? 0n) / 100;
          grouped.push({ group: g, year: y, soldQty: qty, arAmount: ar, collected: col });
        }
      }
      // 年度同比：组内相邻年
      const rows = grouped.map((r) => {
        const prev = grouped.find((x) => x.group === r.group && x.year === r.year - 1);
        return {
          ...r,
          compositePrice: r.soldQty > 0 ? r.arAmount / r.soldQty : null,
          yoy: {
            soldQty: yoyPct(r.soldQty, prev?.soldQty ?? null),
            arAmount: yoyPct(r.arAmount, prev?.arAmount ?? null),
            collected: yoyPct(r.collected, prev?.collected ?? null),
          },
        };
      });
      return { groupBy, years: yearList, rows };
    });
  }

  // ------------------------------------------------------------------
  // Q2 指标查询 —— 字典检索 + 当前值 + 近 N 期趋势
  // ------------------------------------------------------------------
  metricSearch(q?: string) {
    const term = (q ?? '').trim();
    const list = METRIC_DICT.filter(
      (m) =>
        !term ||
        m.name.includes(term) ||
        m.code.toLowerCase().includes(term.toLowerCase()) ||
        m.formula.includes(term),
    );
    return { version: '2026-10.v2', items: list };
  }

  async metricDetail(
    ctx: TenantCtx,
    code: string,
    q: { periods?: number; endPeriod?: string },
  ) {
    const def = METRIC_DICT.find((m) => m.code === code);
    if (!def) throw new NotFoundException({ code: 'METRIC_NOT_FOUND', metric: code });
    const n = Math.min(Math.max(q.periods ?? 12, 1), 36);
    const end = q.endPeriod ?? new Date().toISOString().slice(0, 7).replace('-', '');
    const periods = Array.from({ length: n }, (_, i) => shiftPeriod(end, -(n - 1 - i)));

    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const trend = [] as { period: string; value: number | null }[];
      for (const p of periods) {
        const w = await this.metricsWindow(tx, ctx, p, p);
        trend.push({ period: p, value: this.metricValue(def.code, w) });
      }
      return {
        def,
        periods: trend,
        current: trend[trend.length - 1]?.value ?? null,
      };
    });
  }

  // ------------------------------------------------------------------
  // H1 经营驾驶舱 —— 五区聚合：KPI 卡 / 实时 / 12月趋势 / 预警 / 片区排名
  // ------------------------------------------------------------------
  async cockpit(ctx: TenantCtx, q: { orgUnitId?: string; periods?: number }) {
    const now = new Date();
    const curPeriod = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const n = Math.min(Math.max(q.periods ?? 12, 3), 36);
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const { effCtx, orgLabel } = await this.resolveScope(tx, ctx, q.orgUnitId);
      const meta = await this.reportMeta(tx, ctx, orgLabel);

      const trendPeriods = Array.from({ length: n }, (_, i) =>
        shiftPeriod(curPeriod, -(n - 1 - i)));
      const trend = [] as {
        period: string; soldQty: number; revenue: number;
        collected: number; recoveryRate: number | null; compositePrice: number | null;
      }[];
      for (const p of trendPeriods) {
        const w = await this.metricsWindow(tx, effCtx, p, p);
        trend.push({
          period: p,
          soldQty: num(w.soldQty),
          revenue: Number(w.waterFee) / 100,
          collected: Number(w.collected) / 100,
          recoveryRate: pct(Number(w.currentCollected), Number(w.arAmount)),
          compositePrice: num(w.soldQty) > 0 ? Number(w.waterFee) / num(w.soldQty) : null,
        });
      }

      const cur = await this.metricsWindow(tx, effCtx, curPeriod, curPeriod);
      const prev = await this.metricsWindow(tx, effCtx, shiftPeriod(curPeriod, -1), shiftPeriod(curPeriod, -1));
      const prevYr = await this.metricsWindow(tx, effCtx, shiftPeriod(curPeriod, -12), shiftPeriod(curPeriod, -12));

      // 实时区：当日实收 + 当日抄录数 + 本期计划进度
      const dayGte = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const dayLt = new Date(dayGte.getTime() + 86400_000);
      const [todayPay, todayReadings, tasksOpen, exceptionRows] = await Promise.all([
        tx.$queryRaw<{ amount: bigint | null; cnt: number }[]>`
          SELECT sum(p.amount)::bigint AS amount, count(*)::int AS cnt
          FROM payment p
          WHERE p.tenant_id = ${ctx.tenantId}::uuid
            AND p.status IN ('RECEIVED','DAY_CLOSED')
            AND p.received_at >= ${dayGte} AND p.received_at < ${dayLt}
            ${effCtx.scope === 'ALL' ? Prisma.empty : Prisma.sql`AND p.org_unit_id = ANY(${effCtx.orgScope}::uuid[])`}`,
        tx.$queryRaw<{ cnt: number }[]>`
          SELECT count(*)::int AS cnt FROM meter_reading r
          WHERE r.tenant_id = ${ctx.tenantId}::uuid
            AND r.created_at >= ${dayGte} AND r.created_at < ${dayLt}`,
        tx.$queryRaw<{ cnt: number }[]>`
          SELECT count(*)::int AS cnt FROM task t
          WHERE t.tenant_id = ${ctx.tenantId}::uuid AND t.status IN ('PENDING','CLAIMED','ASSIGNED')`,
        tx.$queryRaw<{ cnt: number }[]>`
          SELECT count(*)::int AS cnt FROM meter_reading r
          JOIN meter_installation mi ON mi.tenant_id = r.tenant_id AND mi.id = r.installation_id
          JOIN water_account wa ON wa.tenant_id = mi.tenant_id AND wa.id = mi.water_account_id
          WHERE r.tenant_id = ${ctx.tenantId}::uuid AND r.period = ${curPeriod}
            AND r.qc_status IN ('MANUAL_REVIEW','REJECTED')
            AND NOT EXISTS (
              SELECT 1 FROM meter_reading ch
              WHERE ch.tenant_id = r.tenant_id AND ch.supersedes_reading_id = r.id)
            ${aggOwnPredicate(await aggregationScopeAccountIds(tx, effCtx), Prisma.sql`wa.id`)}`,
      ]);

      // 片区排名：本月各组织实收 + 回收率
      const orgRows = await tx.$queryRaw<{ id: string; name: string }[]>`
        SELECT id, name FROM org_unit WHERE tenant_id = ${ctx.tenantId}::uuid ORDER BY created_at`;
      const orgRanking = [] as {
        orgUnitId: string; name: string; collected: number; recoveryRate: number | null;
      }[];
      for (const o of orgRows) {
        const sub = await tx.$queryRaw<{ id: string }[]>`
          WITH RECURSIVE sub AS (
            SELECT id FROM org_unit
             WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${o.id}::uuid
            UNION ALL
            SELECT ou.id FROM org_unit ou JOIN sub s ON ou.parent_id = s.id
             WHERE ou.tenant_id = ${ctx.tenantId}::uuid
          ) SELECT id FROM sub`;
        const ids = sub.map((r) => r.id);
        const allowed =
          ctx.scope === 'ALL' ? ids : ids.filter((id) => ctx.orgScope.includes(id));
        if (allowed.length === 0) continue;
        const col = await tx.$queryRaw<{ amount: bigint | null }[]>`
          SELECT sum(p.amount)::bigint AS amount FROM payment p
          WHERE p.tenant_id = ${ctx.tenantId}::uuid
            AND p.status IN ('RECEIVED','DAY_CLOSED')
            AND p.received_at >= ${monthStart(curPeriod)} AND p.received_at < ${monthEndExclusive(curPeriod)}
            AND p.org_unit_id = ANY(${allowed}::uuid[])`;
        orgRanking.push({
          orgUnitId: o.id,
          name: o.name,
          collected: Number(col[0]?.amount ?? 0n) / 100,
          recoveryRate: null, // 组织级回收率需户锚定口径，此处仅做实收排名
        });
      }
      orgRanking.sort((a, b) => b.collected - a.collected);

      const card = (
        value: number | null, prevV: number | null, prevYrV: number | null,
      ) => ({ value, momPct: yoyPct(value ?? 0, prevV), yoyPct: yoyPct(value ?? 0, prevYrV) });

      return {
        meta: { ...meta, periodLabel: `${curPeriod.slice(0, 4)} 年 ${+curPeriod.slice(4)} 月` },
        period: curPeriod,
        cards: {
          SOLD_QTY: card(num(cur.soldQty), num(prev.soldQty), num(prevYr.soldQty)),
          REVENUE: card(Number(cur.waterFee) / 100, Number(prev.waterFee) / 100, Number(prevYr.waterFee) / 100),
          RECOVERY_RATE: card(
            pct(Number(cur.currentCollected), Number(cur.arAmount)),
            pct(Number(prev.currentCollected), Number(prev.arAmount)),
            pct(Number(prevYr.currentCollected), Number(prevYr.arAmount)),
          ),
          COMPOSITE_PRICE: card(
            num(cur.soldQty) > 0 ? Number(cur.waterFee) / num(cur.soldQty) : null,
            num(prev.soldQty) > 0 ? Number(prev.waterFee) / num(prev.soldQty) : null,
            num(prevYr.soldQty) > 0 ? Number(prevYr.waterFee) / num(prevYr.soldQty) : null,
          ),
          READ_ACCURACY: card(
            pct(cur.qcPassed, cur.qcTotal),
            pct(prev.qcPassed, prev.qcTotal),
            pct(prevYr.qcPassed, prevYr.qcTotal),
          ),
        },
        realtime: {
          todayCollected: Number(todayPay[0]?.amount ?? 0n) / 100,
          todayPaymentCount: todayPay[0]?.cnt ?? 0,
          todayReadings: todayReadings[0]?.cnt ?? 0,
          planRead: cur.planRead,
          planTotal: cur.planTotal,
        },
        alerts: {
          arrearsTotal: Number(cur.arrearsTotal) / 100,
          openTasks: tasksOpen[0]?.cnt ?? 0,
          abnormalReadings: exceptionRows[0]?.cnt ?? 0,
        },
        trend,
        orgRanking,
      };
    });
  }

  /** 字典 code → metricsWindow 字段映射；比率统一返回百分数。 */
  private metricValue(code: string, w: WindowMetrics): number | null {
    switch (code) {
      case 'SOLD_QTY': return num(w.soldQty);
      case 'AR_AMOUNT': return Number(w.arAmount) / 100;
      case 'COLLECTED': return Number(w.collected) / 100;
      case 'CURRENT_COLLECTED': return Number(w.currentCollected) / 100;
      case 'ARREARS_COLLECTED': return Number(w.arrearsCollected) / 100;
      case 'RECOVERY_RATE': return pct(Number(w.currentCollected), Number(w.arAmount));
      case 'ARREARS_RECOVERY_RATE': return pctBig(w.arrearsCollected, w.arrearsStart);
      case 'ARREARS_TOTAL': return Number(w.arrearsTotal) / 100;
      case 'ARREARS_RATE': return pctBig(w.arrearsTotal, w.cumAr);
      case 'COMPOSITE_PRICE':
        return num(w.soldQty) > 0 ? Number(w.waterFee) / num(w.soldQty) : null;
      case 'READ_ACCURACY': return pct(w.qcPassed, w.qcTotal);
      case 'READ_COVERAGE': return pct(w.planRead, w.planTotal);
      case 'ESTIMATE_RATE': return pct(w.estCount, w.estTotal);
      case 'READ_TIMELINESS': return pct(w.timely, w.timelyTotal);
      case 'PREPAY_RATE': return pctBig(w.prepayBalance, w.cumAr);
      case 'PREPAY_BALANCE': return Number(w.prepayBalance) / 100;
      case 'ACCOUNT_COUNT': return w.accountCount;
      case 'NEW_ACCOUNTS': return w.openedCount;
      case 'CLOSED_ACCOUNTS': return w.closedCount;
      case 'NET_NEW_ACCOUNTS': return w.openedCount - w.closedCount;
      default: return null;
    }
  }
}
