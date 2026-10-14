import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  aggregationScopeAccountIds,
  aggOwnPredicate,
} from '../../common/account-aggregation-ownership.js';
import { type TenantCtx } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';

/**
 * 'YYYYMM' → [first day of month, first day of next month) — 与
 * report.service 同一约定（收款按 received_at 月窗归集）。
 */
const monthWindow = (period: string): { gte: Date; lt: Date } => {
  const y = parseInt(period.slice(0, 4), 10);
  const m = parseInt(period.slice(4), 10);
  return { gte: new Date(Date.UTC(y, m - 1, 1)), lt: new Date(Date.UTC(y, m, 1)) };
};

const page = (take?: number, skip?: number) => ({
  take: Math.min(Math.max(take ?? 50, 1), 500),
  skip: Math.max(skip ?? 0, 0),
});



/** 导出行上限 —— F1 防超时护栏；超限请求被 controller 截断并附注。 */
export const EXPORT_ROW_CAP = 20000;

/**
 * A1–A5 查询导出（2026-10 需求 §四）—— 面向业务的人读行，全部字段在 SQL
 * 内 join 出中文可读值（户号/户名/组织名/员工名），不回传裸 UUID 给
 * 前端做主标识（id 仅用于翻页/导出对账，前端不展示）。
 *
 * Scope 约定（与既有报表一致）：
 *  - 户锚查询（accounts/usage-details/bill-details/arrears）→ AGG_OWN。
 *  - 收款流水按柜台归属 payment.org_unit_id。
 */
@Injectable()
export class QueryService {
  constructor(private readonly prisma: TenantPrismaService) {}

  /** A1 用户清单：在册及历史用水户档案。 */
  async accounts(
    ctx: TenantCtx,
    q: {
      asOf?: string; // YYYYMM — 时点账期（默认当前月）
      orgUnitId?: string;
      usageCategory?: string;
      status?: string;
      caliber?: string;
      take?: number;
      skip?: number;
    },
  ) {
    const p = page(q.take, q.skip);
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const wa = aggOwnPredicate(
        await aggregationScopeAccountIds(tx, ctx),
        Prisma.sql`wa.id`,
      );
      return tx.$queryRaw<
        {
          accountNo: string; customerName: string; addr: string;
          usageCategory: string; status: string; openedAt: Date | null;
          closedAt: Date | null; orgName: string | null;
          meterNo: string | null; caliber: string | null;
          baseReading: string | null; // 表底（最新装表初读 + 最近读数）
          lastReading: string | null; lastReadPeriod: string | null;
        }[]
      >`
        SELECT wa.account_no AS "accountNo", c.name AS "customerName",
               wa.addr, wa.usage_category AS "usageCategory",
               wa.status::text AS status, wa.opened_at AS "openedAt",
               wa.closed_at AS "closedAt", ou.name AS "orgName",
               m.meter_no AS "meterNo", m.caliber,
               mi.initial_reading::text AS "baseReading",
               lr.reading_value::text AS "lastReading", lr.period AS "lastReadPeriod"
        FROM water_account wa
        JOIN customer c ON c.tenant_id = wa.tenant_id AND c.id = wa.customer_id
        LEFT JOIN LATERAL (
          SELECT ou2.name FROM book_meter bm2
          JOIN reading_book rb2 ON rb2.tenant_id = bm2.tenant_id AND rb2.id = bm2.book_id
          JOIN org_unit ou2 ON ou2.tenant_id = rb2.tenant_id AND ou2.id = rb2.org_unit_id
          WHERE bm2.tenant_id = wa.tenant_id AND bm2.water_account_id = wa.id
          ORDER BY ou2.name LIMIT 1
        ) ou ON true
        LEFT JOIN LATERAL (
          SELECT i.meter_id, i.initial_reading
          FROM meter_installation i
          WHERE i.tenant_id = wa.tenant_id AND i.water_account_id = wa.id
            AND i.status = 'ACTIVE'
          ORDER BY i.installed_at DESC LIMIT 1
        ) mi ON true
        LEFT JOIN meter m ON m.tenant_id = wa.tenant_id AND m.id = mi.meter_id
        LEFT JOIN LATERAL (
          SELECT r.reading_value, r.period
          FROM meter_reading r
          JOIN meter_installation i2
            ON i2.tenant_id = r.tenant_id AND i2.id = r.installation_id
          WHERE r.tenant_id = wa.tenant_id AND i2.water_account_id = wa.id
            AND r.qc_status IN ('PASSED')
            AND NOT EXISTS (
              SELECT 1 FROM meter_reading ch
              WHERE ch.tenant_id = r.tenant_id AND ch.supersedes_reading_id = r.id)
          ORDER BY r.period DESC LIMIT 1
        ) lr ON true
        WHERE wa.tenant_id = ${ctx.tenantId}::uuid
          ${wa}
          ${q.status ? Prisma.sql`AND wa.status = ${q.status}::"AccountStatus"` : Prisma.empty}
          ${q.usageCategory ? Prisma.sql`AND wa.usage_category = ${q.usageCategory}` : Prisma.empty}
          ${q.orgUnitId
            ? Prisma.sql`AND EXISTS (
                SELECT 1 FROM book_meter bm3
                JOIN reading_book rb3 ON rb3.tenant_id = bm3.tenant_id AND rb3.id = bm3.book_id
                WHERE bm3.tenant_id = wa.tenant_id AND bm3.water_account_id = wa.id
                  AND rb3.org_unit_id = ${q.orgUnitId}::uuid)`
            : Prisma.empty}
          ${q.caliber ? Prisma.sql`AND m.caliber = ${q.caliber}` : Prisma.empty}
        ORDER BY wa.account_no
        LIMIT ${p.take} OFFSET ${p.skip}`;
    });
  }

  /** A2 水量明细：每户各账期表底与水量（基于结算分量）。 */
  async usageDetails(
    ctx: TenantCtx,
    q: {
      period: string;
      waterAccountId?: string;
      orgUnitId?: string;
      usageCategory?: string;
      /** 连续 N 期零用水筛选（默认 0=不筛） */
      zeroStreak?: number;
      take?: number;
      skip?: number;
    },
  ) {
    const p = page(q.take, q.skip);
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const wa = aggOwnPredicate(
        await aggregationScopeAccountIds(tx, ctx),
        Prisma.sql`wa.id`,
      );
      const rows = await tx.$queryRaw<
        {
          accountNo: string; customerName: string; addr: string;
          usageCategory: string; period: string;
          prevReading: string | null; endReading: string | null;
          usageQty: string; isEstimated: boolean;
          readSource: string | null; readerName: string | null;
          ytdUsage: string;
        }[]
      >`
        SELECT wa.account_no AS "accountNo", c.name AS "customerName",
               wa.addr, wa.usage_category AS "usageCategory", cs.period,
               sum(cc.prev_reading_value)::text AS "prevReading",
               sum(cc.end_reading_value)::text AS "endReading",
               sum(cc.usage_qty)::text AS "usageQty",
               bool_or(cc.source_type = 'ESTIMATE') AS "isEstimated",
               string_agg(DISTINCT r.source::text, ',') AS "readSource",
               max(s.name) AS "readerName",
               (SELECT sum(cs2.total_usage_qty)::text FROM consumption_settlement cs2
                 WHERE cs2.tenant_id = wa.tenant_id
                   AND cs2.water_account_id = wa.id
                   AND cs2.period <= cs.period AND cs2.status = 'FINAL'
                   AND cs2.period >= ${q.period.slice(0, 4) + '01'}) AS "ytdUsage"
        FROM consumption_settlement cs
        JOIN consumption_component cc
          ON cc.tenant_id = cs.tenant_id AND cc.settlement_id = cs.id
        JOIN water_account wa
          ON wa.tenant_id = cs.tenant_id AND wa.id = cs.water_account_id
        JOIN customer c ON c.tenant_id = wa.tenant_id AND c.id = wa.customer_id
        LEFT JOIN meter_reading r
          ON r.tenant_id = cc.tenant_id AND r.id = cc.source_reading_id
        LEFT JOIN staff s ON s.tenant_id = r.tenant_id AND s.id = r.operator_id
        WHERE cs.tenant_id = ${ctx.tenantId}::uuid
          AND cs.period = ${q.period}
          AND cs.status = 'FINAL'
          ${wa}
          ${q.waterAccountId ? Prisma.sql`AND wa.id = ${q.waterAccountId}::uuid` : Prisma.empty}
          ${q.orgUnitId
            ? Prisma.sql`AND EXISTS (
                SELECT 1 FROM book_meter bm3
                JOIN reading_book rb3 ON rb3.tenant_id = bm3.tenant_id AND rb3.id = bm3.book_id
                WHERE bm3.tenant_id = wa.tenant_id AND bm3.water_account_id = wa.id
                  AND rb3.org_unit_id = ${q.orgUnitId}::uuid)`
            : Prisma.empty}
          ${q.usageCategory ? Prisma.sql`AND wa.usage_category = ${q.usageCategory}` : Prisma.empty}
        GROUP BY wa.id, wa.account_no, c.name, wa.addr, wa.usage_category, cs.period
        ORDER BY wa.account_no
        LIMIT ${p.take} OFFSET ${p.skip}`;

      const z = q.zeroStreak ?? 0;
      if (z <= 0 || rows.length === 0) return rows;
      // 连续 N 期零用水：本行 usageQty=0 且前 N-1 期结算也都是 0。
      const zeroIds = rows.filter((r) => r.usageQty === '0').map((r) => r.accountNo);
      if (zeroIds.length === 0) return [];
      const streaks = await tx.$queryRaw<{ accountNo: string }[]>`
        WITH seq AS (
          SELECT wa.account_no AS "accountNo", cs.period, cs.total_usage_qty
          FROM consumption_settlement cs
          JOIN water_account wa ON wa.tenant_id = cs.tenant_id AND wa.id = cs.water_account_id
          WHERE cs.tenant_id = ${ctx.tenantId}::uuid
            AND wa.account_no = ANY(${zeroIds})
            AND cs.period <= ${q.period} AND cs.status = 'FINAL'
          ORDER BY wa.account_no, cs.period DESC
        ),
        ranked AS (
          SELECT "accountNo", period, total_usage_qty,
                 row_number() OVER (PARTITION BY "accountNo" ORDER BY period DESC) AS rn
          FROM seq
        )
        SELECT "accountNo" FROM ranked
        WHERE rn <= ${z} AND total_usage_qty > 0
        GROUP BY "accountNo"`;
      // streaks 里的是"前 N 期内有非零"的户 —— 连续 N 期零 = 不在其中
      const broken = new Set(streaks.map((s) => s.accountNo));
      return rows.filter(
        (r) => r.usageQty === '0' && !broken.has(r.accountNo),
      );
    });
  }

  /** A3 账单明细：账期内账单行 + 应收/销账/欠费。 */
  async billDetails(
    ctx: TenantCtx,
    q: {
      period: string;
      waterAccountId?: string;
      orgUnitId?: string;
      take?: number;
      skip?: number;
    },
  ) {
    const p = page(q.take, q.skip);
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const wa = aggOwnPredicate(
        await aggregationScopeAccountIds(tx, ctx),
        Prisma.sql`b.water_account_id`,
      );
      return tx.$queryRaw<
        {
          accountNo: string; customerName: string; period: string;
          billKind: string; status: string; isEstimated: boolean;
          usageQty: string | null; priceText: string | null;
          totalAmount: bigint; adjusted: bigint;
          allocated: bigint; remaining: bigint;
        }[]
      >`
        SELECT wa.account_no AS "accountNo", c.name AS "customerName", b.period,
               b.bill_kind::text AS "billKind", b.status::text AS status,
               b.is_estimated AS "isEstimated",
               cs.total_usage_qty::text AS "usageQty",
               (SELECT string_agg(
                     COALESCE(fi.name, '费用项') || ' ¥'
                       || to_char(bi.amount / 100.0, 'FM9999999990.00') ||
                     CASE WHEN bi.qty IS NOT NULL AND bi.unit_price IS NOT NULL
                          THEN '（¥' || to_char(bi.unit_price, 'FM9999999990.00')
                               || '/m³ × ' || trim(to_char(bi.qty, 'FM9999999990.####'))
                               || ' m³）'
                          ELSE '' END,
                     ' + ')
                  FROM bill_item bi
                  LEFT JOIN fee_item fi ON fi.tenant_id = bi.tenant_id AND fi.id = bi.fee_item_id
                  WHERE bi.tenant_id = b.tenant_id AND bi.bill_id = b.id
                    AND bi.item_type = 'NORMAL') AS "priceText",
               b.total_amount AS "totalAmount",
               COALESCE((SELECT sum(bi2.amount) FROM bill_item bi2
                  WHERE bi2.tenant_id = b.tenant_id AND bi2.bill_id = b.id
                    AND bi2.item_type = 'ADJUSTMENT'), 0)::bigint AS adjusted,
               COALESCE(a.paid, 0)::bigint AS allocated,
               (b.total_amount - COALESCE(a.paid, 0))::bigint AS remaining
        FROM bill b
        JOIN water_account wa ON wa.tenant_id = b.tenant_id AND wa.id = b.water_account_id
        JOIN customer c ON c.tenant_id = wa.tenant_id AND c.id = wa.customer_id
        LEFT JOIN consumption_settlement cs
          ON cs.tenant_id = b.tenant_id AND cs.id = b.source_id
         AND b.source_type = 'SETTLEMENT'
        LEFT JOIN LATERAL (
          SELECT sum(pa.amount) AS paid FROM payment_alloc pa
          WHERE pa.tenant_id = b.tenant_id AND pa.bill_id = b.id
        ) a ON true
        WHERE b.tenant_id = ${ctx.tenantId}::uuid
          AND b.period = ${q.period}
          AND b.bill_kind <> 'REVERSAL'
          AND b.status IN ('POSTED','PARTIAL_PAID','PAID')
          ${wa}
          ${q.waterAccountId ? Prisma.sql`AND b.water_account_id = ${q.waterAccountId}::uuid` : Prisma.empty}
          ${q.orgUnitId
            ? Prisma.sql`AND EXISTS (
                SELECT 1 FROM book_meter bm3
                JOIN reading_book rb3 ON rb3.tenant_id = bm3.tenant_id AND rb3.id = bm3.book_id
                WHERE bm3.tenant_id = wa.tenant_id AND bm3.water_account_id = wa.id
                  AND rb3.org_unit_id = ${q.orgUnitId}::uuid)`
            : Prisma.empty}
        ORDER BY wa.account_no, b.created_at
        LIMIT ${p.take} OFFSET ${p.skip}`;
    });
  }

  /** A4 缴费流水：收款行 + 户/收费员/渠道 + 销账账期。 */
  async payments(
    ctx: TenantCtx,
    q: {
      from: string;
      to: string;
      channel?: string;
      settleAccountId?: string;
      waterAccountId?: string;
      take?: number;
      skip?: number;
    },
  ) {
    const p = page(q.take, q.skip);
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const orgIn =
        ctx.scope === 'ALL'
          ? Prisma.empty
          : Prisma.sql`AND p.org_unit_id = ANY(${ctx.orgScope}::uuid[])`;
      return tx.$queryRaw<
        {
          paymentNo: string | null; settleNo: string; settleName: string;
          accountNos: string | null; receivedAt: Date; channel: string;
          cashierName: string | null; amount: bigint; status: string;
          allocPeriods: string | null;
        }[]
      >`
        SELECT p.payment_no AS "paymentNo", sa.settle_no AS "settleNo",
               sa.name AS "settleName",
               (SELECT string_agg(DISTINCT wa.account_no, ',')
                  FROM payment_alloc pa
                  JOIN bill b ON b.tenant_id = pa.tenant_id AND b.id = pa.bill_id
                  JOIN water_account wa ON wa.tenant_id = b.tenant_id AND wa.id = b.water_account_id
                  WHERE pa.tenant_id = p.tenant_id AND pa.payment_id = p.id
               ) AS "accountNos",
               p.received_at AS "receivedAt", p.channel::text AS channel,
               s.name AS "cashierName", p.amount, p.status::text AS status,
               (SELECT string_agg(DISTINCT b2.period, ',')
                  FROM payment_alloc pa2
                  JOIN bill b2 ON b2.tenant_id = pa2.tenant_id AND b2.id = pa2.bill_id
                  WHERE pa2.tenant_id = p.tenant_id AND pa2.payment_id = p.id
               ) AS "allocPeriods"
        FROM payment p
        JOIN settle_account sa ON sa.tenant_id = p.tenant_id AND sa.id = p.settle_account_id
        LEFT JOIN staff s ON s.tenant_id = p.tenant_id AND s.id = p.cashier_id
        WHERE p.tenant_id = ${ctx.tenantId}::uuid
          AND p.received_at::date >= ${q.from}::date
          AND p.received_at::date <= ${q.to}::date
          ${orgIn}
          ${q.channel ? Prisma.sql`AND p.channel = ${q.channel}::"PayChannel"` : Prisma.empty}
          ${q.settleAccountId ? Prisma.sql`AND p.settle_account_id = ${q.settleAccountId}::uuid` : Prisma.empty}
          ${q.waterAccountId
            ? Prisma.sql`AND EXISTS (
                SELECT 1 FROM payment_alloc pa
                JOIN bill b ON b.tenant_id = pa.tenant_id AND b.id = pa.bill_id
                WHERE pa.tenant_id = p.tenant_id AND pa.payment_id = p.id
                  AND b.water_account_id = ${q.waterAccountId}::uuid)`
            : Prisma.empty}
        ORDER BY p.received_at DESC
        LIMIT ${p.take} OFFSET ${p.skip}`;
    });
  }

  /** A5 欠费明细：未清账单按时点汇总到户/结算户，带账龄。 */
  async arrears(
    ctx: TenantCtx,
    q: {
      asOf: string; // YYYY-MM-DD
      agingMin?: number; // 账龄月数下限
      agingMax?: number;
      orgUnitId?: string;
      waterAccountId?: string;
      minAmount?: number; // 欠费阈值（分）
      take?: number;
      skip?: number;
    },
  ) {
    const p = page(q.take, q.skip);
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const wa = aggOwnPredicate(
        await aggregationScopeAccountIds(tx, ctx),
        Prisma.sql`b.water_account_id`,
      );
      return tx.$queryRaw<
        {
          settleNo: string; settleName: string; phone: string | null;
          accountNo: string; customerName: string;
          arrearsAmount: bigint; oldestPeriod: string;
          agingMonths: number; billCount: number;
          writtenOff: bigint;
        }[]
      >`
        SELECT sa.settle_no AS "settleNo", sa.name AS "settleName",
               sa.phone,
               wa.account_no AS "accountNo", c.name AS "customerName",
               sum(b.total_amount - COALESCE(a.paid, 0))::bigint AS "arrearsAmount",
               min(b.period) FILTER (WHERE b.total_amount - COALESCE(a.paid, 0) > 0) AS "oldestPeriod",
               (EXTRACT(YEAR FROM age(${q.asOf}::date,
                  (substr(min(b.period) FILTER (WHERE b.total_amount - COALESCE(a.paid, 0) > 0),1,4)||'-'||substr(min(b.period) FILTER (WHERE b.total_amount - COALESCE(a.paid, 0) > 0),5,2)||'-01')::date
                 )) * 12 + EXTRACT(MONTH FROM age(${q.asOf}::date,
                  (substr(min(b.period) FILTER (WHERE b.total_amount - COALESCE(a.paid, 0) > 0),1,4)||'-'||substr(min(b.period) FILTER (WHERE b.total_amount - COALESCE(a.paid, 0) > 0),5,2)||'-01')::date
                 )))::int AS "agingMonths",
               count(*) FILTER (WHERE b.total_amount - COALESCE(a.paid, 0) > 0)::int AS "billCount",
               COALESCE(wo.off_amount, 0)::bigint AS "writtenOff"
        FROM bill b
        JOIN water_account wa ON wa.tenant_id = b.tenant_id AND wa.id = b.water_account_id
        JOIN customer c ON c.tenant_id = wa.tenant_id AND c.id = wa.customer_id
        JOIN settle_account sa ON sa.tenant_id = b.tenant_id AND sa.id = b.settle_account_id
        LEFT JOIN LATERAL (
          SELECT sum(pa.amount) AS paid FROM payment_alloc pa
          WHERE pa.tenant_id = b.tenant_id AND pa.bill_id = b.id
            AND pa.created_at::date <= ${q.asOf}::date
        ) a ON true
        LEFT JOIN LATERAL (
          SELECT sum(w.amount) AS off_amount FROM bad_debt_writeoff w
          WHERE w.tenant_id = b.tenant_id AND w.settle_account_id = b.settle_account_id
            AND w.status = 'ACTIVE' AND w.effective_date <= ${q.asOf}::date
        ) wo ON true
        WHERE b.tenant_id = ${ctx.tenantId}::uuid
          AND b.status IN ('POSTED','PARTIAL_PAID')
          AND b.bill_kind <> 'REVERSAL'
          AND b.issued_at::date <= ${q.asOf}::date
          ${wa}
          ${q.waterAccountId ? Prisma.sql`AND b.water_account_id = ${q.waterAccountId}::uuid` : Prisma.empty}
          ${q.orgUnitId
            ? Prisma.sql`AND EXISTS (
                SELECT 1 FROM book_meter bm3
                JOIN reading_book rb3 ON rb3.tenant_id = bm3.tenant_id AND rb3.id = bm3.book_id
                WHERE bm3.tenant_id = wa.tenant_id AND bm3.water_account_id = wa.id
                  AND rb3.org_unit_id = ${q.orgUnitId}::uuid)`
            : Prisma.empty}
        GROUP BY sa.id, sa.settle_no, sa.name, sa.phone, wa.id, wa.account_no, c.name, wo.off_amount
        HAVING sum(b.total_amount - COALESCE(a.paid, 0)) > 0
           ${q.minAmount ? Prisma.sql`AND sum(b.total_amount - COALESCE(a.paid, 0)) >= ${BigInt(q.minAmount)}` : Prisma.empty}
        ORDER BY "arrearsAmount" DESC
        LIMIT ${p.take} OFFSET ${p.skip}`;
    });
  }
}
