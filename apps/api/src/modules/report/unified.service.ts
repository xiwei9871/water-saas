import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  aggregationScopeAccountIds,
  aggOwnPredicate,
} from '../../common/account-aggregation-ownership.js';
import { type TenantCtx } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import {
  FIELD_MAP,
  IDENTITY_KEYS,
  PERIOD_SPAN_MAX,
  UNIFIED_FIELDS,
  expandPeriods,
  type UnifiedFieldDef,
} from './unified-fields.js';

/** 'YYYYMM' → 月末 23:59:59（as-of 快照上界，含当日）。 */
const periodEnd = (p: string): Date =>
  new Date(Date.UTC(parseInt(p.slice(0, 4), 10), parseInt(p.slice(4), 10), 1) - 1);

export interface UnifiedQuery {
  periodFrom: string;
  periodTo: string;
  /** 对象筛选 —— 任一组合即为对象集合；全空 = 范围内全部户。 */
  waterAccountIds?: string[];
  settleAccountIds?: string[];
  customerIds?: string[];
  bookIds?: string[];
  /** X2-2：按抄表册册号文本筛选（模糊包含，命中该册下用水户）。 */
  bookNo?: string;
  /** R6：按供用水合同编号模糊筛选。 */
  contractNo?: string;
  orgUnitId?: string;
  usageCategories?: string[];
  statuses?: string[];
  /** 'ONLY' 范围内任一期估抄；'EXCLUDE' 范围内无估抄；否则不筛。 */
  estimated?: 'ONLY' | 'EXCLUDE';
  /** 欠费金额下限（分，截至 periodTo 快照）。 */
  arrearsMin?: number;
  /** 账龄下限（月，截至 periodTo 快照）。 */
  agingMin?: number;
  fields: string[];
  take?: number;
  skip?: number;
}

export interface UnifiedRow {
  waterAccountId: string;
  fixed: Record<string, unknown>;
  periods: Record<string, Record<string, unknown>>;
  cumulative: Record<string, unknown>;
}

/**
 * 统一数据查询（2026-10-15 设计方案）——一个入口覆盖原 A1–A5：
 * 行 = 用水户；账期级字段 × 起止账期横向展开；欠费累计按截至 periodTo
 * 快照取值（文档 §六：累计列为右侧固定列）。
 *
 * 字段懒查：只联查被勾选主题对应的源表；未授权字段从结果剔除并回传
 * deniedFields，不静默返 0。数据范围走 AGG_OWN（与其他户锚报表一致）。
 */
@Injectable()
export class UnifiedQueryService {
  constructor(private readonly prisma: TenantPrismaService) {}

  /** 字段池（按调用者权限过滤）——前端勾选面板数据源。 */
  fieldPool(perms: string[]): UnifiedFieldDef[] {
    const has = (c: string | null) =>
      c === null || perms.includes('*') || perms.includes(c);
    return UNIFIED_FIELDS.filter((f) => has(f.perm));
  }

  async unified(
    ctx: TenantCtx,
    q: UnifiedQuery,
    perms: string[],
  ): Promise<{
    rows: UnifiedRow[];
    total: number;
    periods: string[];
    fields: UnifiedFieldDef[];
    deniedFields: string[];
  }> {
    const periods = expandPeriods(q.periodFrom, q.periodTo);
    if (!periods) {
      throw new BadRequestException({
        code: 'PERIOD_SPAN_EXCEEDED',
        max: PERIOD_SPAN_MAX,
        message: `账期跨度超过 ${PERIOD_SPAN_MAX} 期上限，请分段查询`,
      });
    }
    const has = (c: string | null) =>
      c === null || perms.includes('*') || perms.includes(c);
    const requested = (q.fields ?? []).filter((f) => FIELD_MAP.has(f));
    const fields = IDENTITY_KEYS.map((k) => FIELD_MAP.get(k)!).concat(
      UNIFIED_FIELDS.filter(
        (f) => requested.includes(f.key) && !IDENTITY_KEYS.includes(f.key as never),
      ),
    );
    const deniedFields = requested.filter(
      (k) => !has(FIELD_MAP.get(k)!.perm),
    );
    const granted = fields.filter((f) => has(f.perm));
    const want = (theme: string) => granted.some((f) => f.theme === theme);
    const wantKey = (key: string) => granted.some((f) => f.key === key);

    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const scopeIds = await aggregationScopeAccountIds(tx, ctx);
      const waScope = aggOwnPredicate(scopeIds, Prisma.sql`wa.id`);
      const arrearsCutoff = periodEnd(q.periodTo);

      // ---- 欠费预筛（arrearsMin/agingMin → 截至 periodTo 快照）----
      let arrearsGate: string[] | null = null;
      if (q.arrearsMin !== undefined || q.agingMin !== undefined) {
        const rows = await tx.$queryRaw<
          { id: string; arrears: bigint; aging: number | null }[]
        >`
          SELECT wa.id,
                 sum(b.total_amount - COALESCE(a.paid, 0))::bigint AS arrears,
                 (EXTRACT(YEAR FROM age(${arrearsCutoff}::date,
                    (substr(min(b.period) FILTER (WHERE b.total_amount - COALESCE(a.paid, 0) > 0),1,4)||'-'||
                     substr(min(b.period) FILTER (WHERE b.total_amount - COALESCE(a.paid, 0) > 0),5,2)||'-01')::date
                   )) * 12 + EXTRACT(MONTH FROM age(${arrearsCutoff}::date,
                    (substr(min(b.period) FILTER (WHERE b.total_amount - COALESCE(a.paid, 0) > 0),1,4)||'-'||
                     substr(min(b.period) FILTER (WHERE b.total_amount - COALESCE(a.paid, 0) > 0),5,2)||'-01')::date
                   )))::int AS aging
          FROM water_account wa
          JOIN bill b ON b.tenant_id = wa.tenant_id AND b.water_account_id = wa.id
          LEFT JOIN LATERAL (
            SELECT sum(pa.amount) AS paid FROM payment_alloc pa
            WHERE pa.tenant_id = b.tenant_id AND pa.bill_id = b.id
              AND pa.created_at <= ${arrearsCutoff}
          ) a ON true
          WHERE wa.tenant_id = ${ctx.tenantId}::uuid
            ${waScope}
            AND b.status IN ('POSTED','PARTIAL_PAID')
            AND b.bill_kind <> 'REVERSAL'
            AND b.issued_at <= ${arrearsCutoff}
          GROUP BY wa.id
          HAVING sum(b.total_amount - COALESCE(a.paid, 0)) > 0`;
        arrearsGate = rows
          .filter(
            (r) =>
              (q.arrearsMin === undefined || r.arrears >= BigInt(q.arrearsMin)) &&
              (q.agingMin === undefined || (r.aging ?? 0) >= q.agingMin),
          )
          .map((r) => r.id);
        if (arrearsGate.length === 0) {
          return { rows: [], total: 0, periods, fields: granted, deniedFields };
        }
      }

      // ---- 户分页（对象 + 档案筛选 + 估抄筛选）----
      const est = q.estimated;
      const where = Prisma.sql`
        WHERE wa.tenant_id = ${ctx.tenantId}::uuid
          ${waScope}
          ${arrearsGate ? Prisma.sql`AND wa.id = ANY(${arrearsGate}::uuid[])` : Prisma.empty}
          ${q.waterAccountIds?.length ? Prisma.sql`AND wa.id = ANY(${q.waterAccountIds}::uuid[])` : Prisma.empty}
          ${q.settleAccountIds?.length ? Prisma.sql`AND wa.settle_account_id = ANY(${q.settleAccountIds}::uuid[])` : Prisma.empty}
          ${q.customerIds?.length ? Prisma.sql`AND wa.customer_id = ANY(${q.customerIds}::uuid[])` : Prisma.empty}
          ${q.bookIds?.length
            ? Prisma.sql`AND EXISTS (
                SELECT 1 FROM book_meter bm WHERE bm.tenant_id = wa.tenant_id
                  AND bm.water_account_id = wa.id AND bm.book_id = ANY(${q.bookIds}::uuid[]))`
            : Prisma.empty}
          ${q.bookNo
            ? Prisma.sql`AND EXISTS (
                SELECT 1 FROM book_meter bm
                JOIN reading_book rb ON rb.tenant_id = bm.tenant_id AND rb.id = bm.book_id
                WHERE bm.tenant_id = wa.tenant_id AND bm.water_account_id = wa.id
                  AND rb.book_no ILIKE ${'%' + q.bookNo + '%'})`
            : Prisma.empty}
          ${q.orgUnitId
            ? Prisma.sql`AND EXISTS (
                SELECT 1 FROM book_meter bm
                JOIN reading_book rb ON rb.tenant_id = bm.tenant_id AND rb.id = bm.book_id
                WHERE bm.tenant_id = wa.tenant_id AND bm.water_account_id = wa.id
                  AND rb.org_unit_id = ${q.orgUnitId}::uuid)`
            : Prisma.empty}
          ${q.contractNo ? Prisma.sql`AND wa.contract_no ILIKE ${'%' + q.contractNo + '%'}` : Prisma.empty}
          ${q.usageCategories?.length ? Prisma.sql`AND wa.usage_category = ANY(${q.usageCategories})` : Prisma.empty}
          ${q.statuses?.length ? Prisma.sql`AND wa.status = ANY(${q.statuses}::"AccountStatus"[])` : Prisma.empty}
          ${est === 'ONLY'
            ? Prisma.sql`AND EXISTS (
                SELECT 1 FROM consumption_settlement cs
                WHERE cs.tenant_id = wa.tenant_id AND cs.water_account_id = wa.id
                  AND cs.status = 'FINAL' AND cs.is_estimated
                  AND cs.period BETWEEN ${q.periodFrom} AND ${q.periodTo})`
            : est === 'EXCLUDE'
              ? Prisma.sql`AND NOT EXISTS (
                  SELECT 1 FROM consumption_settlement cs
                  WHERE cs.tenant_id = wa.tenant_id AND cs.water_account_id = wa.id
                    AND cs.status = 'FINAL' AND cs.is_estimated
                    AND cs.period BETWEEN ${q.periodFrom} AND ${q.periodTo})`
              : Prisma.empty}`;

      const totalRows = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*)::bigint AS n FROM water_account wa ${where}`;
      const total = Number(totalRows[0]?.n ?? 0);
      if (total === 0) {
        return { rows: [], total, periods, fields: granted, deniedFields };
      }
      const take = Math.min(Math.max(q.take ?? 200, 1), 500);
      const skip = Math.max(q.skip ?? 0, 0);

      const accounts = await tx.$queryRaw<
        {
          id: string; accountNo: string; customerName: string; addr: string;
          usageCategory: string; accountStatus: string;
          openedAt: Date | null; closedAt: Date | null; orgName: string | null;
          settleNo: string; settleName: string;
          meterNo: string | null; caliber: string | null;
          bookNos: string | null; contractNo: string | null;
        }[]
      >`
        SELECT wa.id, wa.account_no AS "accountNo", c.name AS "customerName",
               wa.addr, wa.usage_category AS "usageCategory",
               wa.status::text AS "accountStatus",
               wa.opened_at AS "openedAt", wa.closed_at AS "closedAt",
               ou.name AS "orgName",
               sa.settle_no AS "settleNo", sa.name AS "settleName",
               m.meter_no AS "meterNo", m.caliber,
               wa.contract_no AS "contractNo",
               bs."bookNos"
        FROM water_account wa
        JOIN customer c ON c.tenant_id = wa.tenant_id AND c.id = wa.customer_id
        JOIN settle_account sa ON sa.tenant_id = wa.tenant_id AND sa.id = wa.settle_account_id
        LEFT JOIN LATERAL (
          SELECT ou2.name FROM book_meter bm2
          JOIN reading_book rb2 ON rb2.tenant_id = bm2.tenant_id AND rb2.id = bm2.book_id
          JOIN org_unit ou2 ON ou2.tenant_id = rb2.tenant_id AND ou2.id = rb2.org_unit_id
          WHERE bm2.tenant_id = wa.tenant_id AND bm2.water_account_id = wa.id
          ORDER BY ou2.name LIMIT 1
        ) ou ON true
        LEFT JOIN LATERAL (
          SELECT i.meter_id FROM meter_installation i
          WHERE i.tenant_id = wa.tenant_id AND i.water_account_id = wa.id
            AND i.status = 'ACTIVE'
          ORDER BY i.installed_at DESC LIMIT 1
        ) mi ON true
        LEFT JOIN meter m ON m.tenant_id = wa.tenant_id AND m.id = mi.meter_id
        LEFT JOIN LATERAL (
          SELECT string_agg(rb3.book_no, '、' ORDER BY rb3.book_no) AS "bookNos"
          FROM book_meter bm3
          JOIN reading_book rb3 ON rb3.tenant_id = bm3.tenant_id AND rb3.id = bm3.book_id
          WHERE bm3.tenant_id = wa.tenant_id AND bm3.water_account_id = wa.id
        ) bs ON true
        ${where}
        ORDER BY wa.account_no
        LIMIT ${take} OFFSET ${skip}`;
      const ids = accounts.map((a) => a.id);

      // ---- 主题懒查：勾选哪些字段才联查哪些源表 ----
      type Pv = Record<string, Record<string, Record<string, unknown>>>;
      const cell = (map: Pv, aid: string, period: string, vals: Record<string, unknown>) => {
        (map[aid] ??= {})[period] = { ...(map[aid][period] ?? {}), ...vals };
      };
      const periodVals: Pv = {};

      if (want('usage')) {
        const rows = await tx.$queryRaw<
          {
            accountId: string; period: string; usageQty: string;
            isEstimated: boolean; readSource: string | null;
            readerName: string | null;
          }[]
        >`
          SELECT cs.water_account_id AS "accountId", cs.period,
                 sum(cc.usage_qty)::text AS "usageQty",
                 bool_or(cc.source_type = 'ESTIMATE') AS "isEstimated",
                 string_agg(DISTINCT r.source::text, ',') AS "readSource",
                 max(s.name) AS "readerName"
          FROM consumption_settlement cs
          JOIN consumption_component cc
            ON cc.tenant_id = cs.tenant_id AND cc.settlement_id = cs.id
          LEFT JOIN meter_reading r
            ON r.tenant_id = cc.tenant_id AND r.id = cc.source_reading_id
          LEFT JOIN staff s ON s.tenant_id = r.tenant_id AND s.id = r.operator_id
          WHERE cs.tenant_id = ${ctx.tenantId}::uuid
            AND cs.status = 'FINAL'
            AND cs.period BETWEEN ${q.periodFrom} AND ${q.periodTo}
            AND cs.water_account_id = ANY(${ids}::uuid[])
          GROUP BY cs.water_account_id, cs.period`;
        for (const r of rows) {
          cell(periodVals, r.accountId, r.period, {
            ...(wantKey('usageQty') ? { usageQty: r.usageQty } : {}),
            ...(wantKey('isEstimated') ? { isEstimated: r.isEstimated } : {}),
            ...(wantKey('readSource') ? { readSource: r.readSource } : {}),
            ...(wantKey('readerName') ? { readerName: r.readerName } : {}),
          });
        }
        if (wantKey('ytdUsage')) {
          const ytd = await tx.$queryRaw<
            { accountId: string; period: string; ytd: string }[]
          >`
            SELECT cs.water_account_id AS "accountId", cs.period,
                   sum(cs.total_usage_qty) OVER (
                     PARTITION BY cs.water_account_id, substr(cs.period, 1, 4)
                     ORDER BY cs.period)::text AS ytd
            FROM consumption_settlement cs
            WHERE cs.tenant_id = ${ctx.tenantId}::uuid
              AND cs.status = 'FINAL'
              AND cs.water_account_id = ANY(${ids}::uuid[])
              AND cs.period <= ${q.periodTo}
              AND cs.period >= ${q.periodFrom.slice(0, 4) + '01'}`;
          for (const r of ytd) {
            if (r.period >= q.periodFrom) {
              cell(periodVals, r.accountId, r.period, { ytdUsage: r.ytd });
            }
          }
        }
      }

      if (want('billing')) {
        const rows = await tx.$queryRaw<
          {
            accountId: string; period: string; billKind: string;
            billStatus: string; priceText: string | null;
            totalAmount: bigint; allocated: bigint; remaining: bigint;
          }[]
        >`
          SELECT b.water_account_id AS "accountId", b.period,
                 string_agg(DISTINCT b.bill_kind::text, '、') AS "billKind",
                 string_agg(DISTINCT b.status::text, '、') AS "billStatus",
                 string_agg(bt.price_text, '；') AS "priceText",
                 sum(b.total_amount)::bigint AS "totalAmount",
                 sum(COALESCE(a.paid, 0))::bigint AS "allocated",
                 sum(b.total_amount - COALESCE(a.paid, 0))::bigint AS "remaining"
          FROM bill b
          LEFT JOIN LATERAL (
            SELECT sum(pa.amount) AS paid FROM payment_alloc pa
            WHERE pa.tenant_id = b.tenant_id AND pa.bill_id = b.id
          ) a ON true
          LEFT JOIN LATERAL (
            SELECT string_agg(
                COALESCE(fi.name, '费用项') || ' ¥'
                  || to_char(bi.amount / 100.0, 'FM9999999990.00') ||
                CASE WHEN bi.qty IS NOT NULL AND bi.unit_price IS NOT NULL
                     THEN '（¥' || to_char(bi.unit_price, 'FM9999999990.00')
                          || '/m³ × ' || trim(to_char(bi.qty, 'FM9999999990.####'))
                          || ' m³）'
                     ELSE '' END,
                ' + ') AS price_text
            FROM bill_item bi
            LEFT JOIN fee_item fi ON fi.tenant_id = bi.tenant_id AND fi.id = bi.fee_item_id
            WHERE bi.tenant_id = b.tenant_id AND bi.bill_id = b.id
              AND bi.item_type = 'NORMAL'
          ) bt ON true
          WHERE b.tenant_id = ${ctx.tenantId}::uuid
            AND b.period BETWEEN ${q.periodFrom} AND ${q.periodTo}
            AND b.water_account_id = ANY(${ids}::uuid[])
            AND b.bill_kind <> 'REVERSAL'
            AND b.status IN ('POSTED','PARTIAL_PAID','PAID')
          GROUP BY b.water_account_id, b.period`;
        for (const r of rows) {
          cell(periodVals, r.accountId, r.period, {
            ...(wantKey('billKind') ? { billKind: r.billKind } : {}),
            ...(wantKey('billStatus') ? { billStatus: r.billStatus } : {}),
            ...(wantKey('priceText') ? { priceText: r.priceText } : {}),
            ...(wantKey('totalAmount') ? { totalAmount: String(r.totalAmount) } : {}),
            ...(wantKey('allocated') ? { allocated: String(r.allocated) } : {}),
            ...(wantKey('remaining') ? { remaining: String(r.remaining) } : {}),
          });
        }
      }

      if (want('collection')) {
        const rows = await tx.$queryRaw<
          {
            accountId: string; period: string; collectedAmount: bigint;
            channels: string | null; lastPaidAt: Date | null;
            paymentNos: string | null;
          }[]
        >`
          SELECT b.water_account_id AS "accountId", b.period,
                 sum(pa.amount)::bigint AS "collectedAmount",
                 string_agg(DISTINCT COALESCE(p.channel::text, 'PREPAY'), '、') AS channels,
                 max(COALESCE(p.received_at, e.created_at)) AS "lastPaidAt",
                 string_agg(DISTINCT COALESCE(p.payment_no, '预存抵扣'), '、') AS "paymentNos"
          FROM payment_alloc pa
          JOIN bill b ON b.tenant_id = pa.tenant_id AND b.id = pa.bill_id
          LEFT JOIN payment p
            ON p.tenant_id = pa.tenant_id AND p.id = pa.payment_id
           AND p.status IN ('RECEIVED','DAY_CLOSED')
          LEFT JOIN prepayment_ledger_entry e
            ON e.tenant_id = pa.tenant_id AND e.id = pa.prepayment_entry_id
          WHERE pa.tenant_id = ${ctx.tenantId}::uuid
            AND b.period BETWEEN ${q.periodFrom} AND ${q.periodTo}
            AND b.water_account_id = ANY(${ids}::uuid[])
            AND b.bill_kind <> 'REVERSAL'
            AND b.status IN ('POSTED','PARTIAL_PAID','PAID')
            AND (p.id IS NOT NULL OR e.id IS NOT NULL)
          GROUP BY b.water_account_id, b.period`;
        for (const r of rows) {
          cell(periodVals, r.accountId, r.period, {
            ...(wantKey('collectedAmount') ? { collectedAmount: String(r.collectedAmount) } : {}),
            ...(wantKey('channels') ? { channels: r.channels } : {}),
            ...(wantKey('lastPaidAt') ? { lastPaidAt: r.lastPaidAt } : {}),
            ...(wantKey('paymentNos') ? { paymentNos: r.paymentNos } : {}),
          });
        }
      }

      // ---- 欠费累计（截至 periodTo 快照，右侧固定列）----
      const cumulative: Record<string, Record<string, unknown>> = {};
      if (want('arrears')) {
        const rows = await tx.$queryRaw<
          {
            accountId: string; arrearsAmount: bigint;
            oldestPeriod: string | null; agingMonths: number | null;
            billCount: number; writtenOff: bigint;
          }[]
        >`
          SELECT b.water_account_id AS "accountId",
                 sum(b.total_amount - COALESCE(a.paid, 0))::bigint AS "arrearsAmount",
                 min(b.period) FILTER (WHERE b.total_amount - COALESCE(a.paid, 0) > 0) AS "oldestPeriod",
                 (EXTRACT(YEAR FROM age(${arrearsCutoff}::date,
                    (substr(min(b.period) FILTER (WHERE b.total_amount - COALESCE(a.paid, 0) > 0),1,4)||'-'||
                     substr(min(b.period) FILTER (WHERE b.total_amount - COALESCE(a.paid, 0) > 0),5,2)||'-01')::date
                   )) * 12 + EXTRACT(MONTH FROM age(${arrearsCutoff}::date,
                    (substr(min(b.period) FILTER (WHERE b.total_amount - COALESCE(a.paid, 0) > 0),1,4)||'-'||
                     substr(min(b.period) FILTER (WHERE b.total_amount - COALESCE(a.paid, 0) > 0),5,2)||'-01')::date
                   )))::int AS "agingMonths",
                 count(*) FILTER (WHERE b.total_amount - COALESCE(a.paid, 0) > 0)::int AS "billCount",
                 COALESCE(wo.off_amount, 0)::bigint AS "writtenOff"
          FROM bill b
          LEFT JOIN LATERAL (
            SELECT sum(pa.amount) AS paid FROM payment_alloc pa
            WHERE pa.tenant_id = b.tenant_id AND pa.bill_id = b.id
              AND pa.created_at <= ${arrearsCutoff}
          ) a ON true
          LEFT JOIN LATERAL (
            SELECT sum(w.amount) AS off_amount FROM bad_debt_writeoff w
            WHERE w.tenant_id = b.tenant_id AND w.water_account_id = b.water_account_id
              AND w.status = 'ACTIVE' AND w.effective_date <= ${arrearsCutoff}::date
          ) wo ON true
          WHERE b.tenant_id = ${ctx.tenantId}::uuid
            AND b.water_account_id = ANY(${ids}::uuid[])
            AND b.status IN ('POSTED','PARTIAL_PAID')
            AND b.bill_kind <> 'REVERSAL'
            AND b.issued_at <= ${arrearsCutoff}
          GROUP BY b.water_account_id, wo.off_amount`;
        for (const r of rows) {
          cumulative[r.accountId] = {
            ...(wantKey('arrearsAmount') ? { arrearsAmount: String(r.arrearsAmount) } : {}),
            ...(wantKey('oldestPeriod') ? { oldestPeriod: r.oldestPeriod } : {}),
            ...(wantKey('agingMonths') ? { agingMonths: r.agingMonths } : {}),
            ...(wantKey('arrearsBillCount') ? { arrearsBillCount: r.billCount } : {}),
            ...(wantKey('writtenOff') ? { writtenOff: String(r.writtenOff) } : {}),
          };
        }
      }

      const rows: UnifiedRow[] = accounts.map((a) => ({
        waterAccountId: a.id,
        fixed: Object.fromEntries(
          granted
            .filter((f) => f.grain === 'account')
            .map((f) => [f.key, (a as Record<string, unknown>)[f.key]]),
        ),
        periods: periodVals[a.id] ?? {},
        cumulative: cumulative[a.id] ?? {},
      }));
      return { rows, total, periods, fields: granted, deniedFields };
    });
  }
}
