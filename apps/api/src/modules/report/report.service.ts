import { ForbiddenException, Injectable } from '@nestjs/common';
import { PayChannel, Prisma } from '@prisma/client';
import {
  aggregationScopeAccountIds,
  aggOwnPredicate,
} from '../../common/account-aggregation-ownership.js';
import { type TenantCtx } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';

type PlanItemStatus = 'PENDING' | 'READ' | 'NO_READ' | 'SKIPPED';

/** All plan-item statuses are always present (0-filled) like plan progress. */
const EMPTY_ITEM_COUNTS: Record<PlanItemStatus, number> = {
  PENDING: 0,
  READ: 0,
  NO_READ: 0,
  SKIPPED: 0,
};

const emptyChannelBuckets = () =>
  Object.fromEntries(
    Object.values(PayChannel).map((c) => [c, { count: 0, amount: 0n }]),
  ) as Record<PayChannel, { count: number; amount: bigint }>;

/** 'YYYY-MM-DD' → 'YYYYMM' (the plan/bill period of that calendar day). */
const periodOfDate = (date: string) => date.slice(0, 7).replace('-', '');

/**
 * 'YYYYMM' → [first day of month, first day of next month) as UTC Dates —
 * the received_at window for a monthly bucket. received_at is a timestamp
 * (the server clock that also derives received_at::date for day closes).
 */
const monthWindow = (period: string): { gte: Date; lt: Date } => {
  const y = parseInt(period.slice(0, 4), 10);
  const m = parseInt(period.slice(4), 10);
  return {
    gte: new Date(Date.UTC(y, m - 1, 1)),
    lt: new Date(Date.UTC(y, m, 1)),
  };
};

/**
 * ReportService （报表） — read-only projections over metering + billing +
 * payment rows (spec §4). Report is the TOP of the module chain
 * (billing ← payment ← report): there is no cross-module aggregate
 * service to reuse, so the queries run directly against TenantPrisma
 * inside the caller's tenant tx — every read stays tenant-scoped and
 * nothing is ever written.
 *
 * Money convention: bigint cents → string on the wire via the global
 * BigIntInterceptor (same as /payments); byChannel buckets always carry
 * every PayChannel (0-filled) so a future channel can never be dropped.
 *
 * Reconciliation predicates （报表四张可对数 — the four reports must tie
 * out against the source tables):
 *  - billed （应收） = Σ bill.total_amount WHERE period = P AND
 *    bill_kind <> 'REVERSAL' AND status IN ('POSTED','PARTIAL_PAID','PAID').
 *    A DRAFT is not yet debt; a REVERSED original and its REVERSAL-kind
 *    counter-bill are BOTH excluded so the red-flush pair nets to zero.
 *  - collected （实收） = Σ payment.amount WHERE received_at ∈ month AND
 *    status IN ('RECEIVED','DAY_CLOSED'). Both statuses are real money
 *    taken at the counter (DAY_CLOSED just entered a signed close);
 *    reversal payments are RECEIVED rows with negative amounts so
 *    refunds net naturally. PaymentStatus.REVERSED is vestigial (T12
 *    append-only semantics) and would be excluded if it ever appeared.
 *  - allocated （销账） = Σ PAYMENT-source payment_alloc.amount joined to
 *    its payment's received_at month and to the allocated bill. Since
 *    E6, collected and allocated are DISTINCT measures: a payment's
 *    TOP_UP leg lands in prepayment_ledger_entry, not payment_alloc, so
 *    allocated ≤ collected and a divergence is expected, not an error.
 *    The two columns also anchor differently under scope — collected
 *    follows payment.org_unit_id (the counter), allocated follows the
 *    bill's water account (AGG_OWN territory) — so they are reported
 *    side by side and must never be asserted equal.
 *
 * Org scope (scoped callers, ctx.scope ≠ ALL):
 *  - meter-daily: books whose org_unit_id ∈ ctx.orgScope.
 *  - cashier-daily: payments whose org_unit_id ∈ ctx.orgScope (counter
 *    anchor).
 *  - ar-monthly: bills whose water account passes AGG_OWN.
 *  - collected-monthly: collected side scoped by payment.org_unit_id;
 *    allocated side scoped by AGG_OWN on the bill's account.
 *  - recovery-rate: TENANT-ONLY — 403 REPORT_SCOPE_UNDEFINED for scoped
 *    callers (the ratio's two sides anchor to different populations).
 */
@Injectable()
export class ReportService {
  constructor(private readonly prisma: TenantPrismaService) {}

  /**
   * GET /reports/meter-daily?date= — 抄表日报， one row per reading book.
   * A book appears when it has ≥1 reading_plan in the date's period
   * (YYYYMM of `date`) OR ≥1 attributed reading taken on that date —
   * so a late back-period read on a book with no current-period plan
   * still shows up as that day's work.
   *
   * Per row:
   *  - total/read/noRead/pending/skipped — plan_item status counts over
   *    ALL plans of the book in the date's period (the month's route
   *    sheet snapshot — same counts as GET /reading-plans/:id/progress,
   *    grouped per book; a re-generated CLOSED plan's items still count,
   *    they are historical work rows).
   *  - readingsTaken — meter_reading rows with read_date = `date` whose
   *    plan_item belongs to ANY plan of the book (any period). read_date
   *    is the visit date stamped at entry (default now(), back-datable),
   *    so this answers "how many reads happened on this book that day".
   *    Ad-hoc readings (plan_item_id NULL) cannot be attributed to a
   *    book and are excluded by construction.
   *  - plans — number of the book's plans in the date's period (context
   *    for the status counts).
   *
   * Scoped callers (scope ≠ ALL) see only books whose orgUnitId ∈
   * ctx.orgScope — pushed into the WHERE clause, never a post-filter.
   */
  async meterDaily(
    ctx: TenantCtx,
    q: { date: string; bookId?: string; orgUnitId?: string },
  ) {
    const period = periodOfDate(q.date);
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      // Plans of the date's period → (bookId, planId) pairs.
      const plans = await tx.readingPlan.findMany({
        where: { tenantId: ctx.tenantId, period },
        select: { id: true, bookId: true },
      });
      const planIds = plans.map((p) => p.id);
      const bookIds = new Set(plans.map((p) => p.bookId));

      // Item status counts per plan → folded into per-book counters.
      const itemCounts = new Map<string, Record<PlanItemStatus, number>>();
      const planCount = new Map<string, number>();
      if (planIds.length > 0) {
        const rows = await tx.readingPlanItem.groupBy({
          by: ['planId', 'status'],
          where: { tenantId: ctx.tenantId, planId: { in: planIds } },
          _count: { _all: true },
        });
        const bookOf = new Map(plans.map((p) => [p.id, p.bookId]));
        for (const p of plans) {
          planCount.set(p.bookId, (planCount.get(p.bookId) ?? 0) + 1);
        }
        for (const r of rows) {
          const bookId = bookOf.get(r.planId)!;
          const counts =
            itemCounts.get(bookId) ?? { ...EMPTY_ITEM_COUNTS };
          counts[r.status] += r._count._all;
          itemCounts.set(bookId, counts);
        }
      }

      // Readings taken ON the date, attributed via plan_item → plan → book.
      const takenRows = await tx.$queryRaw<
        { book_id: string; taken: number }[]
      >`
        SELECT p.book_id::text AS book_id, count(*)::int AS taken
        FROM meter_reading r
        JOIN reading_plan_item i
          ON i.tenant_id = r.tenant_id AND i.id = r.plan_item_id
        JOIN reading_plan p
          ON p.tenant_id = i.tenant_id AND p.id = i.plan_id
        WHERE r.tenant_id = ${ctx.tenantId}::uuid
          AND r.read_date = ${q.date}::date
          -- valid-fact convention: a superseded row is no longer the
          -- fact (its child is), so a same-day correction chain counts
          -- once, not twice.
          AND NOT EXISTS (
            SELECT 1 FROM meter_reading c
            WHERE c.tenant_id = r.tenant_id
              AND c.supersedes_reading_id = r.id
          )
        GROUP BY p.book_id`;
      const taken = new Map(takenRows.map((r) => [r.book_id, r.taken]));
      for (const bookId of taken.keys()) bookIds.add(bookId);

      if (bookIds.size === 0) return [];
      const books = await tx.readingBook.findMany({
        where: {
          tenantId: ctx.tenantId,
          AND: [
            { id: { in: [...bookIds] } },
            q.bookId !== undefined ? { id: q.bookId } : {},
            q.orgUnitId !== undefined ? { orgUnitId: q.orgUnitId } : {},
            // Scoped read filter: non-ALL callers only see subtree books.
            ctx.scope === 'ALL' ? {} : { orgUnitId: { in: ctx.orgScope } },
          ],
        },
        select: {
          id: true,
          bookNo: true,
          name: true,
          orgUnitId: true,
        },
        orderBy: { bookNo: 'asc' },
      });
      return books.map((b) => {
        const counts = itemCounts.get(b.id) ?? { ...EMPTY_ITEM_COUNTS };
        return {
          bookId: b.id,
          bookNo: b.bookNo,
          name: b.name,
          orgUnitId: b.orgUnitId,
          plans: planCount.get(b.id) ?? 0,
          total: counts.PENDING + counts.READ + counts.NO_READ + counts.SKIPPED,
          read: counts.READ,
          noRead: counts.NO_READ,
          pending: counts.PENDING,
          skipped: counts.SKIPPED,
          readingsTaken: taken.get(b.id) ?? 0,
        };
      });
    });
  }

  /**
   * GET /reports/cashier-daily?date= — 收费日报， one row per cashier who
   * received ≥1 payment on the date (received_at::date basis — the same
   * clock the day close sweeps). byChannel buckets carry every
   * PayChannel; reversal payments contribute negative amounts to their
   * channel so the drawer nets naturally. `closed` = a POSTED
   * cashier_day_close exists for (cashier, close_date = date) — the
   * operating date, matching how closes are keyed.
   */
  async cashierDaily(ctx: TenantCtx, q: { date: string }) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const orgIn =
        ctx.scope === 'ALL'
          ? Prisma.empty
          : Prisma.sql`AND p.org_unit_id = ANY(${ctx.orgScope}::uuid[])`;
      const rows = await tx.$queryRaw<
        {
          cashier_id: string;
          name: string | null;
          channel: PayChannel;
          cnt: number;
          amount: bigint;
        }[]
      >`
        SELECT p.cashier_id::text AS cashier_id, s.name,
               p.channel::text AS channel,
               count(*)::int AS cnt, sum(p.amount)::bigint AS amount
        FROM payment p
        LEFT JOIN staff s
          ON s.tenant_id = p.tenant_id AND s.id = p.cashier_id
        WHERE p.tenant_id = ${ctx.tenantId}::uuid
          AND p.status IN ('RECEIVED', 'DAY_CLOSED')
          AND p.received_at::date = ${q.date}::date
          ${orgIn}
        GROUP BY p.cashier_id, s.name, p.channel
        ORDER BY p.cashier_id, p.channel`;

      const closes = await tx.cashierDayClose.findMany({
        where: {
          tenantId: ctx.tenantId,
          closeDate: new Date(`${q.date}T00:00:00.000Z`),
        },
        select: { cashierId: true },
      });
      const closed = new Set(closes.map((c) => c.cashierId));

      const byCashier = new Map<
        string,
        {
          cashierId: string;
          name: string | null;
          byChannel: Record<PayChannel, { count: number; amount: bigint }>;
          total: { count: number; amount: bigint };
          closed: boolean;
        }
      >();
      for (const r of rows) {
        let row = byCashier.get(r.cashier_id);
        if (!row) {
          row = {
            cashierId: r.cashier_id,
            name: r.name,
            byChannel: emptyChannelBuckets(),
            total: { count: 0, amount: 0n },
            closed: closed.has(r.cashier_id),
          };
          byCashier.set(r.cashier_id, row);
        }
        const bucket = row.byChannel[r.channel];
        bucket.count += r.cnt;
        bucket.amount += r.amount;
        row.total.count += r.cnt;
        row.total.amount += r.amount;
      }
      return [...byCashier.values()];
    });
  }

  /**
   * GET /reports/ar-monthly?period= — 应收月报： Σ billed per the
   * documented predicate, split by the water account's usage_category.
   */
  async arMonthly(ctx: TenantCtx, q: { period: string }) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const wa = aggOwnPredicate(
        await aggregationScopeAccountIds(tx, ctx),
        Prisma.sql`b.water_account_id`,
      );
      const rows = await tx.$queryRaw<
        { category: string; amount: bigint; cnt: number }[]
      >`
        SELECT wa.usage_category AS category,
               sum(b.total_amount)::bigint AS amount, count(*)::int AS cnt
        FROM bill b
        JOIN water_account wa
          ON wa.tenant_id = b.tenant_id AND wa.id = b.water_account_id
        WHERE b.tenant_id = ${ctx.tenantId}::uuid
          AND b.period = ${q.period}
          AND b.bill_kind <> 'REVERSAL'
          AND b.status IN ('POSTED', 'PARTIAL_PAID', 'PAID')
          ${wa}
        GROUP BY wa.usage_category
        ORDER BY wa.usage_category`;
      const byCategory: Record<string, { count: number; amount: bigint }> = {};
      let billed = 0n;
      for (const r of rows) {
        byCategory[r.category] = {
          count: r.cnt,
          amount: r.amount,
        };
        billed += r.amount;
      }
      return { period: q.period, billed, byCategory };
    });
  }

  /**
   * GET /reports/collected-monthly?period= — 实收月报： Σ payment.amount
   * for received_at inside the month (documented predicate), split by
   * channel, plus the alloc-side Σ (PAYMENT-source debt allocs only —
   * the TOP_UP leg lives in prepayment_ledger_entry, so post-E6
   * allocated ≤ collected; a divergence is no longer an error).
   */
  async collectedMonthly(ctx: TenantCtx, q: { period: string }) {
    const window = monthWindow(q.period);
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const orgIn =
        ctx.scope === 'ALL'
          ? Prisma.empty
          : Prisma.sql`AND p.org_unit_id = ANY(${ctx.orgScope}::uuid[])`;
      const wa = aggOwnPredicate(
        await aggregationScopeAccountIds(tx, ctx),
        Prisma.sql`b.water_account_id`,
      );
      const rows = await tx.$queryRaw<
        { channel: PayChannel; amount: bigint; cnt: number }[]
      >`
        SELECT channel::text AS channel, sum(amount)::bigint AS amount, count(*)::int AS cnt
        FROM payment p
        WHERE p.tenant_id = ${ctx.tenantId}::uuid
          AND p.status IN ('RECEIVED', 'DAY_CLOSED')
          AND received_at >= ${window.gte}
          AND received_at < ${window.lt}
          ${orgIn}
        GROUP BY channel`;
      const byChannel = emptyChannelBuckets();
      let collected = 0n;
      for (const r of rows) {
        const bucket = byChannel[r.channel];
        bucket.count += r.cnt;
        bucket.amount += r.amount;
        collected += r.amount;
      }
      const allocRows = await tx.$queryRaw<{ amount: bigint | null }[]>`
        SELECT sum(a.amount)::bigint AS amount
        FROM payment_alloc a
        JOIN payment p
          ON p.tenant_id = a.tenant_id AND p.id = a.payment_id
        JOIN bill b ON b.tenant_id = a.tenant_id AND b.id = a.bill_id
        WHERE a.tenant_id = ${ctx.tenantId}::uuid
          AND p.status IN ('RECEIVED', 'DAY_CLOSED')
          AND p.received_at >= ${window.gte}
          AND p.received_at < ${window.lt}
          ${wa}`;
      return {
        period: q.period,
        collected,
        byChannel,
        allocated: allocRows[0]?.amount ?? 0n,
      };
    });
  }

  /**
   * GET /reports/recovery-rate?period=[&through=] — 回收率.
   * Without `through`: single-month window — billed for bill.period = P
   * over collected for received_at in month P. With `through=T`
   * (T ≥ P): the cumulative variant — billed for bill.period ≤ T over
   * collected received before the first day of month T+1 (Σ ≤ T on both
   * sides). rate = collected / billed as a Decimal string at 4dp;
   * billed = 0 → rate null (undefined ratio, not a fake 0 or ∞).
   *
   * Scope: TENANT-ONLY. The two sides of the ratio anchor differently —
   * billed follows the bill's water account (AGG_OWN), collected follows
   * the cashier counter (payment.org_unit_id) — so a scoped ratio would
   * divide different populations and is meaningless. Scoped callers get
   * 403 REPORT_SCOPE_UNDEFINED rather than a misleading number. A proper
   * scoped recovery definition is an E10 IMPLEMENTATION-HOLD decision.
   */
  async recoveryRate(ctx: TenantCtx, q: { period: string; through?: string }) {
    if (ctx.scope !== 'ALL') {
      throw new ForbiddenException({ code: 'REPORT_SCOPE_UNDEFINED' });
    }
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      let billed: bigint;
      let collected: bigint;
      if (q.through === undefined) {
        const billRows = await tx.$queryRaw<{ amount: bigint | null }[]>`
          SELECT sum(total_amount)::bigint AS amount
          FROM bill b
          WHERE b.tenant_id = ${ctx.tenantId}::uuid
            AND b.period = ${q.period}
            AND b.bill_kind <> 'REVERSAL'
            AND b.status IN ('POSTED', 'PARTIAL_PAID', 'PAID')`;
        billed = billRows[0]?.amount ?? 0n;
        const window = monthWindow(q.period);
        const payRows = await tx.$queryRaw<{ amount: bigint | null }[]>`
          SELECT sum(amount)::bigint AS amount
          FROM payment p
          WHERE p.tenant_id = ${ctx.tenantId}::uuid
            AND p.status IN ('RECEIVED', 'DAY_CLOSED')
            AND p.received_at >= ${window.gte}
            AND p.received_at < ${window.lt}`;
        collected = payRows[0]?.amount ?? 0n;
      } else {
        const billRows = await tx.$queryRaw<{ amount: bigint | null }[]>`
          SELECT sum(total_amount)::bigint AS amount
          FROM bill b
          WHERE b.tenant_id = ${ctx.tenantId}::uuid
            AND b.period <= ${q.through}
            AND b.bill_kind <> 'REVERSAL'
            AND b.status IN ('POSTED', 'PARTIAL_PAID', 'PAID')`;
        billed = billRows[0]?.amount ?? 0n;
        const window = monthWindow(q.through);
        const payRows = await tx.$queryRaw<{ amount: bigint | null }[]>`
          SELECT sum(amount)::bigint AS amount
          FROM payment p
          WHERE p.tenant_id = ${ctx.tenantId}::uuid
            AND p.status IN ('RECEIVED', 'DAY_CLOSED')
            AND p.received_at < ${window.lt}`;
        collected = payRows[0]?.amount ?? 0n;
      }
      const rate =
        billed === 0n
          ? null
          : new Prisma.Decimal(collected.toString())
              .div(new Prisma.Decimal(billed.toString()))
              .toFixed(4);
      return {
        period: q.period,
        through: q.through ?? null,
        billed,
        collected,
        rate,
      };
    });
  }
}
