import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  aggregationScopeAccountIds,
  aggOwnPredicate,
} from '../../common/account-aggregation-ownership.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import type { TenantCtx } from '../../common/tenant-context.js';

/** 'YYYYMM' → [月初, 次月初) UTC 窗口（与 report.service 同一约定）。 */
const monthWindow = (period: string): { gte: Date; lt: Date } => ({
  gte: new Date(Date.UTC(+period.slice(0, 4), +period.slice(4) - 1, 1)),
  lt: new Date(Date.UTC(+period.slice(0, 4), +period.slice(4), 1)),
});

/**
 * E10 foundation — 仅实现 Metric Dictionary Rev4 中**已冻结**的指标。
 * HOLD 指标（RECOVERY_RATE / ESTIMATE_RATE / REMOTE_ONLINE_RATE）刻意不实现，
 * 等 Pilot 拍板；这里绝不返回假 0。
 *
 * Org anchor 规则（D24）：
 *  - WaterAccount-anchor → ACCOUNT_AGGREGATION_OWNERSHIP（off-book=0 册 →
 *    scoped 排除；全部覆盖册在 scope 才计入）
 *  - ReadingBook.orgUnitId / Payment.orgUnitId → 各自 ∈ orgScope
 *  - PREPAYMENT_BALANCE 是 D20 tenant-only aggregate（scoped → null）
 *
 * WaterAccount-anchor 的历史 period 指标 = CURRENT-PORTFOLIO VIEW（D25）——
 * 按查询时点归属，不是历史营业所绩效。
 */
@Injectable()
export class DashboardService {
  constructor(private readonly prisma: TenantPrismaService) {}

  async metrics(ctx: TenantCtx, period: string) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const win = monthWindow(period);
      const inScope = await aggregationScopeAccountIds(tx, ctx);
      const wa = (col: Prisma.Sql) => aggOwnPredicate(inScope, col);
      // ReadingBook / Payment org anchors: column qualified per query.
      const orgIn = (col: Prisma.Sql) =>
        ctx.scope === 'ALL'
          ? Prisma.empty
          : Prisma.sql`AND ${col} = ANY(${ctx.orgScope}::uuid[])`;

      const [
        readingCounts,
        actualReads,
        anomalyCount,
        usageQty,
        billed,
        cashier,
        territory,
        receivable,
        activeMeters,
        replacements,
        closed,
        prepayBalance,
      ] = await Promise.all([
        // --- ReadingBook-anchored: 册 orgUnit ∈ scope ---
        tx.$queryRaw<{ status: string; cnt: bigint }[]>`
          SELECT i.status::text, count(*)::bigint AS cnt
          FROM reading_plan_item i
          JOIN reading_plan p ON p.tenant_id = i.tenant_id AND p.id = i.plan_id
          JOIN reading_book rb ON rb.tenant_id = p.tenant_id AND rb.id = p.book_id
          WHERE i.tenant_id = ${ctx.tenantId}::uuid
            AND p.period = ${period}
            ${orgIn(Prisma.sql`rb.org_unit_id`)}
          GROUP BY i.status`,
        // --- ACTUAL_READ_RATE 分子：book-anchored 首采纳实读 ---
        tx.$queryRaw<{ cnt: bigint }[]>`
          SELECT count(*)::bigint AS cnt
          FROM meter_reading r
          JOIN reading_plan_item i ON i.tenant_id = r.tenant_id AND i.id = r.plan_item_id
          JOIN reading_plan p ON p.tenant_id = i.tenant_id AND p.id = i.plan_id
          JOIN reading_book rb ON rb.tenant_id = p.tenant_id AND rb.id = p.book_id
          WHERE r.tenant_id = ${ctx.tenantId}::uuid
            AND r.period = ${period}
            AND r.qc_status = 'PASSED'
            AND r.result_type IN ('ACTUAL', 'REMOTE')
            AND NOT EXISTS (
              SELECT 1 FROM meter_reading c
              WHERE c.tenant_id = r.tenant_id AND c.supersedes_reading_id = r.id
            )
            ${orgIn(Prisma.sql`rb.org_unit_id`)}`,
        // --- WaterAccount-anchored (AGG_OWN) ---
        tx.$queryRaw<{ cnt: bigint }[]>`
          SELECT count(*)::bigint AS cnt
          FROM meter_reading r
          JOIN meter_installation mi
            ON mi.tenant_id = r.tenant_id AND mi.id = r.installation_id
          WHERE r.tenant_id = ${ctx.tenantId}::uuid
            AND r.period = ${period}
            AND r.qc_status IN ('MANUAL_REVIEW', 'REJECTED')
            AND NOT EXISTS (
              SELECT 1 FROM meter_reading c
              WHERE c.tenant_id = r.tenant_id AND c.supersedes_reading_id = r.id
            )
            ${wa(Prisma.sql`mi.water_account_id`)}`,
        tx.$queryRaw<{ qty: Prisma.Decimal | null }[]>`
          SELECT sum(s.total_usage_qty) AS qty
          FROM consumption_settlement s
          WHERE s.tenant_id = ${ctx.tenantId}::uuid
            AND s.period = ${period}
            AND s.status = 'FINAL'
            ${wa(Prisma.sql`s.water_account_id`)}`,
        tx.$queryRaw<{ amount: bigint | null }[]>`
          SELECT sum(b.total_amount)::bigint AS amount
          FROM bill b
          WHERE b.tenant_id = ${ctx.tenantId}::uuid
            AND b.period = ${period}
            AND b.bill_kind <> 'REVERSAL'
            AND b.status IN ('POSTED', 'PARTIAL_PAID', 'PAID')
            ${wa(Prisma.sql`b.water_account_id`)}`,
        // --- Payment.orgUnitId-anchored ---
        tx.$queryRaw<{ amount: bigint | null }[]>`
          SELECT sum(p.amount)::bigint AS amount
          FROM payment p
          WHERE p.tenant_id = ${ctx.tenantId}::uuid
            AND p.status IN ('RECEIVED', 'DAY_CLOSED')
            AND p.received_at >= ${win.gte} AND p.received_at < ${win.lt}
            ${orgIn(Prisma.sql`p.org_unit_id`)}`,
        // --- TERRITORY_DEBT_COLLECTION: signed PAYMENT-source allocs → bill → account ---
        tx.$queryRaw<{ amount: bigint | null }[]>`
          SELECT sum(a.amount)::bigint AS amount
          FROM payment_alloc a
          JOIN payment p ON p.tenant_id = a.tenant_id AND p.id = a.payment_id
          JOIN bill b ON b.tenant_id = a.tenant_id AND b.id = a.bill_id
          WHERE a.tenant_id = ${ctx.tenantId}::uuid
            AND a.source = 'PAYMENT'
            AND p.status IN ('RECEIVED', 'DAY_CLOSED')
            AND p.received_at >= ${win.gte} AND p.received_at < ${win.lt}
            ${wa(Prisma.sql`b.water_account_id`)}`,
        // --- GROSS_BILL_RECEIVABLE (D27): 时点快照 ---
        tx.$queryRaw<{ amount: bigint | null }[]>`
          SELECT sum(greatest(b.total_amount - COALESCE(a.paid, 0), 0))::bigint AS amount
          FROM bill b
          LEFT JOIN LATERAL (
            SELECT sum(pa.amount) AS paid
            FROM payment_alloc pa
            WHERE pa.tenant_id = b.tenant_id AND pa.bill_id = b.id
          ) a ON true
          WHERE b.tenant_id = ${ctx.tenantId}::uuid
            AND b.bill_kind <> 'REVERSAL'
            AND b.status IN ('POSTED', 'PARTIAL_PAID')
            ${wa(Prisma.sql`b.water_account_id`)}`,
        tx.$queryRaw<{ cnt: bigint }[]>`
          SELECT count(*)::bigint AS cnt
          FROM meter_installation mi
          WHERE mi.tenant_id = ${ctx.tenantId}::uuid
            AND mi.status = 'ACTIVE'
            ${wa(Prisma.sql`mi.water_account_id`)}`,
        tx.$queryRaw<{ cnt: bigint }[]>`
          SELECT count(*)::bigint AS cnt
          FROM meter_installation mi
          WHERE mi.tenant_id = ${ctx.tenantId}::uuid
            AND mi.reason = 'REPLACE'
            AND mi.installed_at >= ${win.gte}::date AND mi.installed_at < ${win.lt}::date
            ${wa(Prisma.sql`mi.water_account_id`)}`,
        tx.$queryRaw<{ cnt: bigint }[]>`
          SELECT count(*)::bigint AS cnt
          FROM account_event e
          WHERE e.tenant_id = ${ctx.tenantId}::uuid
            AND e.type = 'CLOSE'
            AND e.effective_date >= ${win.gte}::date AND e.effective_date < ${win.lt}::date
            ${wa(Prisma.sql`e.water_account_id`)}`,
        // --- PREPAYMENT_BALANCE: D20 tenant-only aggregate ---
        ctx.scope === 'ALL'
          ? tx.$queryRaw<{ amount: bigint | null }[]>`
              SELECT sum(amount)::bigint AS amount
              FROM prepayment_ledger_entry
              WHERE tenant_id = ${ctx.tenantId}::uuid`
          : Promise.resolve([{ amount: null }] as { amount: bigint | null }[]),
      ]);

      const due = readingCounts.reduce((n, r) => n + Number(r.cnt), 0);
      const byStatus = Object.fromEntries(
        readingCounts.map((r) => [r.status, Number(r.cnt)]),
      );
      return {
        period,
        asOf: new Date().toISOString(),
        /** CURRENT-PORTFOLIO VIEW（D25）— WaterAccount-anchor 按查询时点归属。 */
        attribution: 'CURRENT_PORTFOLIO_VIEW',
        metrics: {
          READING_DUE_COUNT: due,
          READING_DONE_COUNT: byStatus['READ'] ?? 0,
          READING_MISSING_COUNT: byStatus['PENDING'] ?? 0,
          READING_ANOMALY_COUNT: Number(anomalyCount[0]?.cnt ?? 0),
          ACTUAL_READ_RATE:
            due === 0
              ? null
              : (Number(actualReads[0]?.cnt ?? 0) / due).toFixed(4),
          PERIOD_USAGE_QTY: usageQty[0]?.qty ?? null,
          BILLED_AMOUNT: billed[0]?.amount ?? 0n,
          CASHIER_COLLECTED: cashier[0]?.amount ?? 0n,
          TERRITORY_DEBT_COLLECTION: territory[0]?.amount ?? 0n,
          GROSS_BILL_RECEIVABLE: receivable[0]?.amount ?? 0n,
          ACTIVE_METER_COUNT: Number(activeMeters[0]?.cnt ?? 0),
          METER_REPLACEMENT_COUNT: Number(replacements[0]?.cnt ?? 0),
          ACCOUNT_CLOSED_COUNT: Number(closed[0]?.cnt ?? 0),
          PREPAYMENT_BALANCE: ctx.scope === 'ALL' ? (prepayBalance[0]?.amount ?? 0n) : null,
        },
        /** HOLD — Pilot 未拍板，刻意不返回数值（B5：禁止假 0）。 */
        hold: ['RECOVERY_RATE', 'ESTIMATE_RATE', 'REMOTE_ONLINE_RATE'],
      };
    });
  }
}
