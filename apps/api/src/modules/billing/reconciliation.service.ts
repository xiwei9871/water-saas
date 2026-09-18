import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  allocateUsage,
  buildReconciliation,
  DomainError,
  reprice,
  type FeeItemInput,
} from '@ws/billing-core';
import type { Request } from 'express';
import { isUniqueViolation } from '../../common/prisma-errors.js';
import { orgInScope, type TenantCtx } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { BILL_SELECT } from './bill.service.js';
import {
  loadFeeItems,
  lockAccountForUpdate,
  lockPlanForUpdate,
  pickPlan,
  ytdBeforeQty,
} from './pricing.js';

export const RECONCILIATION_SELECT = {
  id: true,
  tenantId: true,
  waterAccountId: true,
  anchorReadingId: true,
  actualReadingId: true,
  fromPeriod: true,
  toPeriod: true,
  actualTotalUsage: true,
  previouslySettledUsage: true,
  remainderUsage: true,
  absorbedSettlementId: true,
  correctChargeCent: true,
  postedChargeCent: true,
  adjustmentAmountCent: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ReconciliationSelect;

type ReconStatus = 'DRAFT' | 'ABSORBED' | 'APPLIED' | 'MANUAL_REVIEW';

const outOfScope = () => new ForbiddenException({ code: 'ORG_OUT_OF_SCOPE' });

interface TrustedReading {
  id: string;
  installationId: string;
  period: string;
  readDate: Date;
  readingValue: Prisma.Decimal;
}

/** Candidate row before the not-null narrowing the where clause guarantees. */
type ReadingCandidate = Omit<TrustedReading, 'readingValue'> & {
  readingValue: Prisma.Decimal | null;
};

const READING_SELECT = {
  id: true,
  installationId: true,
  period: true,
  readDate: true,
  readingValue: true,
} satisfies Prisma.MeterReadingSelect;

/** Bill statuses that count as posted-side debt (spec §2.5 已开账). */
const POSTED_STATUSES = ['POSTED', 'PARTIAL_PAID', 'PAID'] as const;

/**
 * Reconciliation （补差， spec §2.4) — anchor-based calibration between
 * two trusted readings. A new trusted ACTUAL|REMOTE reading is compared
 * against the previous trusted reading (the anchor — always a real dial,
 * never an estimate's synthetic end) and the true cumulative usage
 * `actual − anchor` is reconciled against the settlements billed in the
 * span (anchor.period, actual.period]:
 *
 *  - POST /reconciliations resolves the actual (explicit id or the
 *    account's latest trusted reading) + anchor + span in ONE tx, then:
 *      · meter swap (anchor/actual on different installations) →
 *        MANUAL_REVIEW — cross-meter usage attribution is out of MVP
 *        scope; the row records the raw computed facts for an operator.
 *      · actual < anchor (dial regression) → tenant param
 *        `negative_usage_policy` (jsonb string, spec §2.4, default
 *        CLAMP_REVIEW): MANUAL_REVIEW. Under ALLOW_NEGATIVE the reprice
 *        path is still attempted and any engine DomainError on the
 *        negative quantities lands the row in MANUAL_REVIEW instead of
 *        failing the request.
 *      · remainder ≥ 0 AND the settlement covering actual.period is
 *        DRAFT with NO NORMAL bill → ABSORB: remainder is added into
 *        that settlement's total_usage_qty (guarded updateMany; a lost
 *        race to FINAL falls through to the adjustment path). This is
 *        the normal estimate-catch-up — no bill, adjustment_amount = 0.
 *      · otherwise → ADJUST: `reconcile_alloc_policy` (default
 *        PROPORTIONAL_TO_SETTLED, alt ALL_TO_CURRENT) redistributes the
 *        true usage over the span, `reprice()` rebills each period at
 *        its own tariff version with the natural-year ladder, and
 *        `correct − posted` (posted = NORMAL|REPLACEMENT bills in
 *        POSTED|PARTIAL_PAID|PAID) becomes ONE POSTED ADJUSTMENT bill
 *        (source RECONCILIATION, negative = credit). adjustment = 0 →
 *        APPLIED with no bill.
 *
 * Immutability: FINAL settlements and POSTED bills are NEVER mutated
 * (spec §1.3/§2.4) — the adjustment appends a new document. The recon
 * row is append-only and lands BEFORE its bill (the bill's sourceId);
 * UNIQUE(tenant_id, actual_reading_id) makes one actual reconcilable
 * exactly once — a repeat POST is 409, not a second calibration.
 */
@Injectable()
export class ReconciliationService {
  constructor(private readonly prisma: TenantPrismaService) {}

  list(
    ctx: TenantCtx,
    q: {
      take: number;
      skip: number;
      waterAccountId?: string;
      status?: ReconStatus;
      /** "Covers" filter: rows whose [fromPeriod, toPeriod] span it. */
      period?: string;
    },
  ) {
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.reconciliation.findMany({
        where: {
          tenantId: ctx.tenantId,
          waterAccountId: q.waterAccountId,
          status: q.status,
          ...(q.period !== undefined
            ? { fromPeriod: { lte: q.period }, toPeriod: { gte: q.period } }
            : {}),
        },
        select: RECONCILIATION_SELECT,
        orderBy: [{ toPeriod: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
        take: q.take,
        skip: q.skip,
      }),
    );
  }

  async getById(ctx: TenantCtx, id: string) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const row = await tx.reconciliation.findFirst({
        where: { tenantId: ctx.tenantId, id },
        select: RECONCILIATION_SELECT,
      });
      if (!row) throw new NotFoundException({ code: 'RECONCILIATION_NOT_FOUND' });
      return row;
    });
  }

  /**
   * POST /reconciliations — resolve + decide + persist in ONE tx. See the
   * class docblock for the decision table; the ordering below mirrors it:
   * account → actual → anchor → dup guard → span → scope → outcome.
   */
  async createTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    body: { waterAccountId: string; actualReadingId?: string },
    req: Request,
  ) {
    const account = await tx.waterAccount.findFirst({
      where: { tenantId: ctx.tenantId, id: body.waterAccountId },
      select: {
        id: true,
        usageCategory: true,
        settleAccountId: true,
      },
    });
    if (!account) {
      throw new NotFoundException({ code: 'WATER_ACCOUNT_NOT_FOUND' });
    }

    // Actual: the explicit reading (must itself be trusted + on this
    // account) or the account's latest trusted reading.
    const actual = body.actualReadingId
      ? await this.trustedById(tx, ctx, body.waterAccountId, body.actualReadingId)
      : await this.latestTrusted(tx, ctx, body.waterAccountId);
    if (!actual) {
      throw new NotFoundException({ code: 'READING_NOT_FOUND' });
    }

    // Anchor: the trusted reading immediately before the actual — a
    // same-period anchor is legitimate (two actuals in one period), but
    // never a later-period one (require anchor.period <= actual.period).
    const anchor = await this.anchorBefore(tx, ctx, body.waterAccountId, actual);
    if (!anchor) {
      throw new NotFoundException({ code: 'ANCHOR_NOT_FOUND' });
    }

    // Friendly pre-check; UNIQUE(tenant_id, actual_reading_id) is the
    // race backstop inside record().
    const dup = await tx.reconciliation.findFirst({
      where: { tenantId: ctx.tenantId, actualReadingId: actual.id },
      select: { id: true },
    });
    if (dup) {
      throw new ConflictException({
        code: 'RECONCILIATION_EXISTS',
        reconciliationId: dup.id,
      });
    }

    // Span: every settlement billed inside (anchor, actual] — any status,
    // a DRAFT still counts as settled usage (absorb adds on top).
    const span = await tx.consumptionSettlement.findMany({
      where: {
        tenantId: ctx.tenantId,
        waterAccountId: account.id,
        period: { gt: anchor.period, lte: actual.period },
      },
      orderBy: [{ period: 'asc' }, { id: 'asc' }],
    });
    if (span.length === 0) {
      throw new ConflictException({
        code: 'RECONCILIATION_EMPTY_SPAN',
        anchorPeriod: anchor.period,
        actualPeriod: actual.period,
      });
    }

    // Org scope BEFORE any write: resolved per affected period through
    // the plan-item → plan → book chain (same resolution as
    // BillService.assertAccountScope). A reconciliation touches a period
    // range, so every period's bindings must be in the caller's subtree.
    for (const p of new Set([actual.period, ...span.map((s) => s.period)])) {
      await this.assertAccountScope(tx, ctx, account.id, p);
    }

    const amounts = buildReconciliation({
      anchorValue: anchor.readingValue,
      actualValue: actual.readingValue,
      settledUsages: span.map((s) => s.totalUsageQty),
    });
    // Re-wrap in Prisma.Decimal: decimal.js instances from another module
    // copy would slip past toJsonSafe's instanceof check (same rule as
    // settlement.service / insertBillItems).
    const usageFields = {
      actualTotalUsage: new Prisma.Decimal(amounts.actualTotalUsage.toString()),
      previouslySettledUsage: new Prisma.Decimal(
        amounts.previouslySettled.toString(),
      ),
      remainderUsage: new Prisma.Decimal(amounts.remainderUsage.toString()),
    };
    const baseFields = {
      tenantId: ctx.tenantId,
      waterAccountId: account.id,
      anchorReadingId: anchor.id,
      actualReadingId: actual.id,
      fromPeriod: span[0].period,
      toPeriod: actual.period,
      ...usageFields,
      createdBy: ctx.staffId,
      updatedBy: ctx.staffId,
    };

    // Meter swap: usage attribution across installations is out of MVP
    // scope — park the facts for an operator.
    if (actual.installationId !== anchor.installationId) {
      const row = await this.record(tx, ctx, {
        ...baseFields,
        status: 'MANUAL_REVIEW',
      });
      return { ...row, adjustmentBill: null };
    }

    // Dial regression (actual < anchor): the default CLAMP_REVIEW parks
    // it; ALLOW_NEGATIVE still attempts the reprice path, where a
    // DomainError on negative quantities degrades to MANUAL_REVIEW.
    const negativeAllowed =
      amounts.actualTotalUsage.isNegative() &&
      (await this.tenantParam(tx, ctx, 'negative_usage_policy')) ===
        'ALLOW_NEGATIVE';
    if (amounts.actualTotalUsage.isNegative() && !negativeAllowed) {
      const row = await this.record(tx, ctx, {
        ...baseFields,
        status: 'MANUAL_REVIEW',
      });
      return { ...row, adjustmentBill: null };
    }

    // ABSORB path: a non-negative remainder is the current period's own
    // catch-up usage — it lands on the DRAFT settlement covering
    // actual.period when that settlement has no NORMAL bill yet.
    const target = span.find((s) => s.period === actual.period);
    if (!amounts.remainderUsage.isNegative() && target?.status === 'DRAFT') {
      const billed = await tx.bill.findFirst({
        where: {
          tenantId: ctx.tenantId,
          sourceType: 'SETTLEMENT',
          sourceId: target.id,
          billKind: 'NORMAL',
        },
        select: { id: true },
      });
      if (!billed) {
        const bumped = await tx.consumptionSettlement.updateMany({
          where: { tenantId: ctx.tenantId, id: target.id, status: 'DRAFT' },
          data: {
            totalUsageQty: { increment: usageFields.remainderUsage },
            updatedBy: ctx.staffId,
          },
        });
        if (bumped.count === 1) {
          // The mutated settlement's pre-image for audit_log.before.
          req.auditBefore = target;
          const row = await this.record(tx, ctx, {
            ...baseFields,
            status: 'ABSORBED',
            absorbedSettlementId: target.id,
            adjustmentAmountCent: 0n, // ABSORBED is always net-zero (spec §2.4)
          });
          return { ...row, adjustmentBill: null };
        }
        // count=0: the settlement flipped FINAL between our read and the
        // write — fall through to the adjustment path rather than fail.
      }
    }

    // ADJUST path: every span period must be priceable — an unpriced
    // period can't be reconciled, so the whole op fails loud.
    const allocPolicy =
      (await this.tenantParam(tx, ctx, 'reconcile_alloc_policy')) ===
      'ALL_TO_CURRENT'
        ? 'ALL_TO_CURRENT'
        : 'PROPORTIONAL_TO_SETTLED';
    const planIds: string[] = [];
    const feeItemsPerPeriod: FeeItemInput[][] = [];
    for (const s of span) {
      const plan = await pickPlan(tx, ctx, account.usageCategory, s.period);
      if (!plan) {
        throw new UnprocessableEntityException({
          code: 'RECONCILIATION_TARIFF_MISSING',
          period: s.period,
        });
      }
      planIds.push(plan.id);
      feeItemsPerPeriod.push(await loadFeeItems(tx, ctx, plan.id));
    }

    const allocated = allocateUsage({
      settledUsages: span.map((s) => s.totalUsageQty),
      totalUsage: amounts.actualTotalUsage,
      policy: allocPolicy,
    });
    const baseYtd = await ytdBeforeQty(tx, ctx, account.id, span[0].period);
    let priced;
    try {
      priced = reprice({
        baseYtd,
        periods: span.map((s, i) => ({
          period: s.period,
          allocatedUsage: allocated[i],
          feeItems: feeItemsPerPeriod[i],
        })),
      });
    } catch (err) {
      if (err instanceof DomainError) {
        if (negativeAllowed) {
          const row = await this.record(tx, ctx, {
            ...baseFields,
            status: 'MANUAL_REVIEW',
          });
          return { ...row, adjustmentBill: null };
        }
        throw new BadRequestException({ code: err.code, message: err.message });
      }
      throw err;
    }

    // Posted-side charge of the span: NORMAL|REPLACEMENT bills in
    // POSTED|PARTIAL_PAID|PAID (a DRAFT bill never collected anything;
    // a REVERSED one is already undone). Per-period sums size the
    // adjustment bill_item rows below.
    const postedBills = await tx.bill.findMany({
      where: {
        tenantId: ctx.tenantId,
        waterAccountId: account.id,
        period: { in: span.map((s) => s.period) },
        billKind: { in: ['NORMAL', 'REPLACEMENT'] },
        status: { in: [...POSTED_STATUSES] },
      },
      select: { period: true, totalAmount: true },
    });
    const postedByPeriod = new Map<string, bigint>();
    let postedChargeCent = 0n;
    for (const b of postedBills) {
      postedChargeCent += b.totalAmount;
      postedByPeriod.set(
        b.period,
        (postedByPeriod.get(b.period) ?? 0n) + b.totalAmount,
      );
    }
    const adjustmentAmountCent = priced.correctChargeCent - postedChargeCent;

    // The reconciliation lands BEFORE the bill — the bill needs its id
    // as sourceId; both commit in this same tx.
    const recon = await this.record(tx, ctx, {
      ...baseFields,
      status: 'APPLIED',
      correctChargeCent: priced.correctChargeCent,
      postedChargeCent,
      adjustmentAmountCent,
    });
    if (adjustmentAmountCent === 0n) {
      return { ...recon, adjustmentBill: null };
    }

    // Mint the adjustment debt: water_account FOR UPDATE first
    // (close-vs-post serialization, same contract + lock order as
    // BillingRunService.postOneBill — status is re-read under the lock),
    // then the last span period's plan FOR UPDATE — the T8 freeze
    // contract for any non-DRAFT reference.
    await lockAccountForUpdate(tx, ctx, account.id);
    const acc = await tx.waterAccount.findFirst({
      where: { tenantId: ctx.tenantId, id: account.id },
      select: { status: true },
    });
    if (acc?.status === 'CLOSED') {
      throw new ConflictException({
        code: 'ACCOUNT_CLOSED',
        waterAccountId: account.id,
      });
    }
    const lastPlanId = planIds[planIds.length - 1];
    await lockPlanForUpdate(tx, ctx, lastPlanId);
    const bill = await tx.bill.create({
      data: {
        tenantId: ctx.tenantId,
        billingRunId: null,
        settleAccountId: account.settleAccountId,
        waterAccountId: account.id,
        // The correction lands in the period the actual read arrived.
        period: actual.period,
        billKind: 'ADJUSTMENT',
        sourceType: 'RECONCILIATION',
        sourceId: recon.id,
        tariffPlanId: lastPlanId,
        status: 'POSTED',
        // actual-derived correction, not an estimate-based charge.
        isEstimated: false,
        totalAmount: adjustmentAmountCent, // negative = credit correction
        issuedAt: new Date(),
        // an adjustment settles a past debt, it demands nothing new —
        // same convention as the REVERSAL bill.
        dueDate: null,
        createdBy: ctx.staffId,
        updatedBy: ctx.staffId,
      },
      select: BILL_SELECT,
    });
    await tx.billItem.createMany({
      data: span.map((s, i) => ({
        tenantId: ctx.tenantId,
        billId: bill.id,
        // The row is a per-period aggregate delta, not a fee-item quote.
        feeItemId: null,
        itemType: 'ADJUSTMENT' as const,
        description: `reconcile ${s.period}`,
        qty: new Prisma.Decimal(
          allocated[i].minus(s.totalUsageQty).toString(),
        ),
        unitPrice: null,
        amount:
          priced.breakdown[i].amountCent - (postedByPeriod.get(s.period) ?? 0n),
        createdBy: ctx.staffId,
        updatedBy: ctx.staffId,
      })),
    });
    return { ...recon, adjustmentBill: bill };
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /** Insert the recon row; the unique index turns a lost create race
   *  into the same 409 the friendly pre-check produces. */
  private async record(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    data: Prisma.ReconciliationUncheckedCreateInput,
  ) {
    try {
      return await tx.reconciliation.create({
        data,
        select: RECONCILIATION_SELECT,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException({ code: 'RECONCILIATION_EXISTS' });
      }
      throw err;
    }
  }

  /**
   * The trusted-reading predicate (spec §2.4): ACTUAL|REMOTE result, QC
   * PASSED, a real dial value, on ANY installation of the account — the
   * anchor may legitimately live on the meter that was swapped out.
   * Supersession is excluded separately by the child probe (see
   * dropSuperseded).
   */
  private trustedWhere(
    ctx: TenantCtx,
    waterAccountId: string,
  ): Prisma.MeterReadingWhereInput {
    return {
      tenantId: ctx.tenantId,
      installation: { tenantId: ctx.tenantId, waterAccountId },
      resultType: { in: ['ACTUAL', 'REMOTE'] },
      qcStatus: 'PASSED',
      readingValue: { not: null },
    };
  }

  /**
   * Drop superseded rows via the child-row probe — NOT
   * `supersedes_reading_id IS NULL`: a superseded parent keeps that
   * field NULL while its correcting child carries the link (the same
   * rule SettlementService.validReadings applies, T6 review).
   */
  private async dropSuperseded<T extends { id: string }>(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    rows: T[],
  ): Promise<T[]> {
    if (rows.length === 0) return rows;
    const children = await tx.meterReading.findMany({
      where: {
        tenantId: ctx.tenantId,
        supersedesReadingId: { in: rows.map((r) => r.id) },
      },
      select: { supersedesReadingId: true },
    });
    const superseded = new Set(children.map((c) => c.supersedesReadingId));
    return rows.filter((r) => !superseded.has(r.id));
  }

  /** The where clause already excludes null values — this narrows the type. */
  private onlyValued(rows: ReadingCandidate[]): TrustedReading[] {
    return rows.filter((r): r is TrustedReading => r.readingValue !== null);
  }

  /** Latest trusted reading of the account (period desc → readDate → id). */
  private async latestTrusted(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    waterAccountId: string,
  ): Promise<TrustedReading | null> {
    const candidates = await tx.meterReading.findMany({
      where: this.trustedWhere(ctx, waterAccountId),
      select: READING_SELECT,
      orderBy: [{ period: 'desc' }, { readDate: 'desc' }, { id: 'desc' }],
    });
    const valid = await this.dropSuperseded(tx, ctx, candidates);
    return this.onlyValued(valid)[0] ?? null;
  }

  /** A caller-named reading counts only if it is itself trusted. */
  private async trustedById(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    waterAccountId: string,
    readingId: string,
  ): Promise<TrustedReading | null> {
    const row = await tx.meterReading.findFirst({
      where: { ...this.trustedWhere(ctx, waterAccountId), id: readingId },
      select: READING_SELECT,
    });
    if (!row) return null;
    const valid = await this.dropSuperseded(tx, ctx, [row]);
    return this.onlyValued(valid)[0] ?? null;
  }

  /**
   * The anchor: the trusted reading immediately before `actual` —
   * ordered strictly by (readDate, id), restricted to
   * `period <= actual.period` so a later-period row can never anchor a
   * past actual, while a same-period earlier actual still can.
   */
  private async anchorBefore(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    waterAccountId: string,
    actual: TrustedReading,
  ): Promise<TrustedReading | null> {
    const candidates = await tx.meterReading.findMany({
      where: {
        ...this.trustedWhere(ctx, waterAccountId),
        id: { not: actual.id },
        period: { lte: actual.period },
        OR: [
          { readDate: { lt: actual.readDate } },
          { readDate: actual.readDate, id: { lt: actual.id } },
        ],
      },
      select: READING_SELECT,
      orderBy: [{ readDate: 'desc' }, { id: 'desc' }],
    });
    const valid = await this.dropSuperseded(tx, ctx, candidates);
    return this.onlyValued(valid)[0] ?? null;
  }

  /** jsonb-string tenant param → string value (null when unset/wrong type). */
  private async tenantParam(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    key: string,
  ): Promise<string | null> {
    const row = await tx.tenantParam.findUnique({
      where: { tenantId_key: { tenantId: ctx.tenantId, key } },
      select: { value: true },
    });
    return typeof row?.value === 'string' ? row.value : null;
  }

  /**
   * Org guard — verbatim mirror of BillService.assertAccountScope (the
   * same plan-item → plan → book resolution settlement.service uses):
   * every covering book's org must be in the caller's subtree; an
   * account+period with no plan item has no org anchor and returns
   * permissively (the established MVP carve-out).
   */
  private async assertAccountScope(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    waterAccountId: string,
    period: string,
  ) {
    const items = await tx.readingPlanItem.findMany({
      where: {
        tenantId: ctx.tenantId,
        waterAccountId,
        plan: { tenantId: ctx.tenantId, period },
      },
      select: { planId: true },
    });
    if (items.length === 0) return;
    const plans = await tx.readingPlan.findMany({
      where: { tenantId: ctx.tenantId, id: { in: items.map((i) => i.planId) } },
      select: { bookId: true },
    });
    const books = await tx.readingBook.findMany({
      where: { tenantId: ctx.tenantId, id: { in: plans.map((p) => p.bookId) } },
      select: { orgUnitId: true },
    });
    for (const b of books) {
      if (!orgInScope(ctx, b.orgUnitId)) throw outOfScope();
    }
  }
}
