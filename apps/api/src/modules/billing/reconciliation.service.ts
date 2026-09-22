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
import { PrepaymentService } from '../prepayment/prepayment.service.js';
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
  createdAt: Date;
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
  createdAt: true,
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
 * span (anchor.period, actual.period].
 *
 * Field semantics (post-review, C1/I2): `previously_settled_usage`
 * counts FINAL settlements ONLY — a DRAFT settlement's usage is not a
 * fixed fact, it is still open usage. `remainder_usage` is therefore
 * the OPEN remainder `actualTotal − ΣFINAL`: what the actual period's
 * settlement should carry once estimates are corrected.
 *
 *  - POST /reconciliations resolves the actual (explicit id or the
 *    account's latest trusted reading) + anchor + span in ONE tx, then:
 *      · meter swap (anchor/actual on different installations) →
 *        MANUAL_REVIEW — cross-meter usage attribution is out of MVP
 *        scope; the row records the raw computed facts for an operator.
 *      · actual < anchor (dial regression) → MANUAL_REVIEW under EVERY
 *        posture. Tenant param `negative_usage_policy` is still read but
 *        RESERVED (M4): CLAMP_REVIEW and ALLOW_NEGATIVE both land here
 *        today — the old ALLOW_NEGATIVE reprice attempt was dead code,
 *        a negative total always hit a DomainError anyway.
 *      · remainder ≥ 0 AND the settlement covering actual.period exists,
 *        is DRAFT with NO NORMAL bill, and EVERY other span settlement
 *        is FINAL → ABSORB: `total_usage_qty := remainder` — SET, not
 *        increment (the estimate was wrong wholesale; SET is also
 *        idempotent under replay). The component on the actual's
 *        installation is rewired to the real dial (end_reading_value =
 *        actual value, sourceType READING, usage = remainder − Σ other
 *        components) so the next period's prevChain starts at the true
 *        dial — without it the absorbed delta bills twice (I1). A
 *        settlement with no matching component, or a computed component
 *        usage < 0 (multi-installation attribution impossible) →
 *        MANUAL_REVIEW instead of absorbing.
 *      · otherwise → ADJUST — but only when the span is fully closed:
 *        EVERY settlement FINAL and covered by posted-side debt
 *        (NORMAL|REPLACEMENT in POSTED|PARTIAL_PAID|PAID), else 422
 *        RECONCILIATION_UNBILLED_SPAN — repricing an unbilled period
 *        would mint an adjustment on top of the NORMAL bill that still
 *        arrives later (double charge). `reconcile_alloc_policy`
 *        (default PROPORTIONAL_TO_SETTLED, alt ALL_TO_CURRENT)
 *        redistributes the true usage, `reprice()` rebills each period
 *        at its own tariff version with the natural-year ladder, and
 *        `correct − posted` becomes ONE POSTED ADJUSTMENT bill (source
 *        RECONCILIATION, negative = credit). `posted` counts NORMAL +
 *        REPLACEMENT + prior ADJUSTMENT bills (C2 — prior corrections
 *        are real debt; counting them is what makes successive
 *        reconciliations converge instead of double-correcting).
 *        adjustment = 0 and effective per-period quantities unchanged → APPLIED
 *        with no bill. A quantity-only correction retains a zero-value
 *        adjustment document so later annual-tier pricing can recover it.
 *
 * Immutability: FINAL settlements and POSTED bills are NEVER mutated
 * (spec §1.3/§2.4) — the adjustment appends a new document. The recon
 * row is append-only and lands BEFORE its bill (the bill's sourceId);
 * UNIQUE(tenant_id, actual_reading_id) makes one actual reconcilable
 * exactly once — a repeat POST is 409, not a second calibration.
 * Same-period anchor+actual → span (P,P] is empty → 409 — so a
 * same-period superseding re-read has NO recalibration path in MVP
 * (documented M1; the correcting reading must land in a later period).
 */
@Injectable()
export class ReconciliationService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly prepay: PrepaymentService,
  ) {}

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
   * POST /reconciliations — resolve + decide + persist in ONE tx. The
   * ordering is deliberate (C3/M3/M6): account → water_account FOR
   * UPDATE → CLOSED check → scope probe → actual → anchor → dup →
   * span → outcome. One row lock taken BEFORE any state read serializes
   * reconcile vs postOneBill vs close-account vs a sibling reconcile;
   * the scope probe precedes the span/dup probes (account 404 and the
   * CLOSED 409 necessarily come first — same ordering as
   * settlement.service.generateTx).
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
        billable: true,
      },
    });
    if (!account) {
      throw new NotFoundException({ code: 'WATER_ACCOUNT_NOT_FOUND' });
    }
    // Non-billable (MONITORING) accounts never bill, so there is nothing to
    // reconcile — refuse before any outcome leg could mint an adjustment bill.
    if (!account.billable) {
      throw new ConflictException({
        code: 'ACCOUNT_NOT_BILLABLE',
        waterAccountId: account.id,
      });
    }

    // Serialization anchor: the row lock must precede every state read
    // (readings, settlements, bills) or the checks below could decide on
    // a snapshot a concurrent post/close has already invalidated (C3).
    // Status is re-read under the lock — CLOSED refuses every outcome
    // leg uniformly, absorb included (M6).
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

    // Scope BEFORE the probes (M3): every plan-item binding of the
    // account resolves to a book → org; any out-of-scope org → 403.
    // The probe covers all binding periods (the span isn't resolved
    // yet), which subsumes a per-period check.
    await this.assertAccountScope(tx, ctx, account.id);

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

    // Span: every settlement inside (anchor, actual]. An empty span —
    // including the same-period (P,P] case — means nothing was settled
    // between the two readings, so there is nothing to reconcile.
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

    // settled = FINAL only (C1/I2): a DRAFT settlement's usage is not a
    // fixed fact — its period is either the absorb target or part of
    // the still-open remainder. remainderUsage is therefore the OPEN
    // usage the actual period should carry once estimates correct.
    const amounts = buildReconciliation({
      anchorValue: anchor.readingValue,
      actualValue: actual.readingValue,
      settledUsages: span
        .filter((s) => s.status === 'FINAL')
        .map((s) => s.totalUsageQty),
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

    // Dial regression: actual < anchor is unsafe under every tenant
    // posture — the `negative_usage_policy` param is RESERVED, unread
    // (M4; see class docblock). `.lt(0)`, not `.isNegative()`:
    // Decimal('-0') reports negative yet is absorbable zero.
    if (amounts.actualTotalUsage.lt(0)) {
      const row = await this.record(tx, ctx, {
        ...baseFields,
        status: 'MANUAL_REVIEW',
      });
      return { ...row, adjustmentBill: null };
    }

    // ABSORB: the open remainder lands on the actual period's own
    // settlement — SET, not increment (C1): the DRAFT's estimate was
    // wrong wholesale, so `total_usage_qty := remainder`, which is also
    // replay-idempotent. Preconditions: remainder ≥ 0, the actual-period
    // settlement exists and is DRAFT with no NORMAL bill, and every
    // OTHER span settlement is FINAL (a second open period can't be
    // corrected in place).
    const target = span.find((s) => s.period === actual.period);
    const othersFinal = span.every(
      (s) => s.id === target?.id || s.status === 'FINAL',
    );
    if (
      amounts.remainderUsage.gte(0) &&
      target?.status === 'DRAFT' &&
      othersFinal
    ) {
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
        // I1: prove component attribution BEFORE writing — the
        // component on the actual's installation takes
        // `remainder − Σ(other components)` so Σ components ==
        // totalUsageQty. No matching component or a negative result
        // (multi-installation attribution impossible) → MANUAL_REVIEW,
        // never a guessed absorb.
        const components = await tx.consumptionComponent.findMany({
          where: { tenantId: ctx.tenantId, settlementId: target.id },
          select: { id: true, installationId: true, usageQty: true },
        });
        const comp = components.find(
          (c) => c.installationId === actual.installationId,
        );
        const otherQty = components
          .filter((c) => c !== comp)
          .reduce((sum, c) => sum.plus(c.usageQty), new Prisma.Decimal(0));
        const compQty =
          comp === undefined
            ? null
            : amounts.remainderUsage.minus(otherQty);
        if (comp === undefined || compQty === null || compQty.lt(0)) {
          const row = await this.record(tx, ctx, {
            ...baseFields,
            status: 'MANUAL_REVIEW',
          });
          return { ...row, adjustmentBill: null };
        }
        const bumped = await tx.consumptionSettlement.updateMany({
          where: { tenantId: ctx.tenantId, id: target.id, status: 'DRAFT' },
          data: {
            totalUsageQty: usageFields.remainderUsage,
            updatedBy: ctx.staffId,
          },
        });
        if (bumped.count === 1) {
          // Rewire the dial chain: the estimate's synthetic end is
          // replaced by the REAL dial so next period's prevChain starts
          // at the actual — without this the absorbed delta bills twice.
          await tx.consumptionComponent.update({
            where: { id: comp.id },
            data: {
              usageQty: new Prisma.Decimal(compQty.toString()),
              endReadingValue: actual.readingValue,
              sourceType: 'READING',
              sourceReadingId: actual.id,
              updatedBy: ctx.staffId,
            },
          });
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
        // write — fall through to the span gate below, which 422s this
        // now-unbilled span (the in-memory span row still says DRAFT).
      }
    }

    // ADJUST: the span must be fully closed — every settlement FINAL
    // AND covered by posted-side debt (NORMAL|REPLACEMENT in
    // POSTED|PARTIAL_PAID|PAID). Repricing an unbilled period would mint
    // an adjustment on top of the NORMAL bill that still arrives later
    // (double charge, C1); the first offending period fails the op.
    // `posted` counts prior ADJUSTMENT bills too (C2): a posted
    // correction is real debt, and counting it is what makes successive
    // reconciliations converge instead of double-correcting.
    const postedBills = await tx.bill.findMany({
      where: {
        tenantId: ctx.tenantId,
        waterAccountId: account.id,
        period: { in: span.map((s) => s.period) },
        billKind: { in: ['NORMAL', 'REPLACEMENT', 'ADJUSTMENT'] },
        status: { in: [...POSTED_STATUSES] },
      },
      select: {
        id: true,
        period: true,
        totalAmount: true,
        billKind: true,
        sourceType: true,
        sourceId: true,
      },
    });
    // Coverage per settlement: a NORMAL bill links the settlement
    // directly (sourceType SETTLEMENT); a REPLACEMENT links its original
    // bill (sourceType ORIGINAL_BILL) — resolve through it.
    const replSourceIds = postedBills
      .filter((b) => b.billKind === 'REPLACEMENT')
      .map((b) => b.sourceId);
    const replacedSettlements = replSourceIds.length
      ? await tx.bill.findMany({
          where: {
            tenantId: ctx.tenantId,
            id: { in: replSourceIds },
            sourceType: 'SETTLEMENT',
          },
          select: { sourceId: true },
        })
      : [];
    const billedSettlements = new Set<string>([
      ...postedBills
        .filter(
          (b) => b.billKind === 'NORMAL' && b.sourceType === 'SETTLEMENT',
        )
        .map((b) => b.sourceId),
      ...replacedSettlements.map((b) => b.sourceId),
    ]);
    for (const s of span) {
      if (s.status !== 'FINAL' || !billedSettlements.has(s.id)) {
        throw new UnprocessableEntityException({
          code: 'RECONCILIATION_UNBILLED_SPAN',
          period: s.period,
        });
      }
    }

    // Every span period must be priceable — an unpriced period can't be
    // reconciled, so the whole op fails loud.
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
      feeItemsPerPeriod.push(await loadFeeItems(tx, ctx, plan));
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
          // Each period reprices at ITS OWN frozen household snapshot —
          // a mid-span declaration change must not rewrite earlier bills.
          householdSize: s.householdSizeSnapshot,
        })),
      });
    } catch (err) {
      if (err instanceof DomainError) {
        throw new BadRequestException({ code: err.code, message: err.message });
      }
      throw err;
    }

    // Posted-side charge of the span, per-period — sizes both the net
    // adjustment and each adjustment bill_item row below. (A DRAFT bill
    // never collected anything; a REVERSED original is already undone.)
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
    // Compare with the latest effective quantities, not only the frozen
    // settlements: a zero-money revision may restore an earlier estimate.
    const priorAdjustments = await tx.bill.findMany({
      where: { tenantId: ctx.tenantId, waterAccountId: account.id,
        billKind: 'ADJUSTMENT', sourceType: 'RECONCILIATION',
        status: { in: [...POSTED_STATUSES] }, period: { lte: actual.period } },
      select: { id: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const priorItems = priorAdjustments.length ? await tx.billItem.findMany({
      where: { tenantId: ctx.tenantId, billId: { in: priorAdjustments.map((b) => b.id) },
        itemType: 'ADJUSTMENT' },
      select: { billId: true, description: true, qty: true },
    }) : [];
    const priorDelta = new Map<string, Prisma.Decimal>();
    for (const bill of priorAdjustments) {
      for (const item of priorItems.filter((i) => i.billId === bill.id)) {
        const sourcePeriod = /^reconcile (\d{6})$/.exec(item.description ?? '')?.[1];
        if (sourcePeriod && item.qty !== null && !priorDelta.has(sourcePeriod)) {
          priorDelta.set(sourcePeriod, item.qty);
        }
      }
    }
    const quantityChanged = span.some((s, i) =>
      !allocated[i].equals(s.totalUsageQty.plus(priorDelta.get(s.period) ?? 0)),
    );
    if (adjustmentAmountCent === 0n && !quantityChanged) {
      return { ...recon, adjustmentBill: null };
    }

    // Freeze every plan the reprice referenced (M2): the T8 contract is
    // FOR UPDATE on the plan row before a non-DRAFT bill points at it —
    // one unpriced-at-checkout plan would silently misprice the whole
    // span. Distinct ids, sorted for a stable lock order; the water
    // account row is already held (top of this tx, same order as
    // postOneBill: account → plan). The bill's tariffPlanId stays the
    // last span period's plan — the documented approximation.
    // E6 lock order (domain §14): the water_account row is already held
    // (top of this tx) — the settle_account fund lock must come BEFORE
    // the plan locks so every path agrees on water → settle → plan.
    await this.prepay.lockSettleAccountForUpdate(tx, ctx, account.settleAccountId);
    for (const planId of [...new Set(planIds)].sort()) {
      await lockPlanForUpdate(tx, ctx, planId);
    }
    const lastPlanId = planIds[planIds.length - 1];
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
    // E6 (domain §9): a POSITIVE adjustment is new payable POSTED debt —
    // it consumes prepayment in this same tx; zero/negative corrections
    // (credit) never trigger APPLY.
    if (adjustmentAmountCent > 0n) {
      await this.prepay.applyForPostedDebtTx(tx, ctx, account.settleAccountId);
    }
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

  /**
   * Latest trusted reading of the account (period desc → readDate →
   * createdAt → id). take:1 per probe — a superseded top row is skipped
   * and the NEXT candidate fetched (M7: never load-all-then-pick).
   */
  private async latestTrusted(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    waterAccountId: string,
  ): Promise<TrustedReading | null> {
    const skipped: string[] = [];
    for (;;) {
      const row = await tx.meterReading.findFirst({
        where: {
          ...this.trustedWhere(ctx, waterAccountId),
          id: { notIn: skipped },
        },
        select: READING_SELECT,
        orderBy: [
          { period: 'desc' },
          { readDate: 'desc' },
          { createdAt: 'desc' },
          { id: 'desc' },
        ],
      });
      if (!row) return null;
      const valid = await this.dropSuperseded(tx, ctx, [row]);
      if (valid.length === 1) return this.onlyValued(valid)[0] ?? null;
      skipped.push(row.id);
    }
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
   * ordered by real chronology (readDate → createdAt → id), restricted to
   * `period <= actual.period` so a later-period row can never anchor a
   * past actual, while a same-period earlier actual still can.
   * read_date is day-granular, so intra-day order falls to created_at —
   * the id tie-break is ONLY a deterministic final comparator and must
   * never carry time semantics (v4 uuids are random; RC audit I-1).
   * take:1 per probe; a superseded top row is skipped (M7).
   */
  private async anchorBefore(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    waterAccountId: string,
    actual: TrustedReading,
  ): Promise<TrustedReading | null> {
    const skipped: string[] = [actual.id];
    for (;;) {
      const row = await tx.meterReading.findFirst({
        where: {
          ...this.trustedWhere(ctx, waterAccountId),
          id: { notIn: skipped },
          period: { lte: actual.period },
          OR: [
            { readDate: { lt: actual.readDate } },
            {
              readDate: actual.readDate,
              createdAt: { lt: actual.createdAt },
            },
            {
              readDate: actual.readDate,
              createdAt: actual.createdAt,
              id: { lt: actual.id },
            },
          ],
        },
        select: READING_SELECT,
        orderBy: [{ readDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      });
      if (!row) return null;
      const valid = await this.dropSuperseded(tx, ctx, [row]);
      if (valid.length === 1) return this.onlyValued(valid)[0] ?? null;
      skipped.push(row.id);
    }
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
   * Org guard — the same plan-item → plan → book resolution as
   * BillService/SettlementService.assertAccountScope, but WITHOUT the
   * period filter: it runs before actual/anchor/span resolution (M3),
   * so it must cover EVERY period binding of the account. Every
   * covering book's org must be in the caller's subtree; an account
   * with no plan items at all has no org anchor and returns
   * permissively (the established MVP carve-out).
   */
  private async assertAccountScope(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    waterAccountId: string,
  ) {
    const items = await tx.readingPlanItem.findMany({
      where: { tenantId: ctx.tenantId, waterAccountId },
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
