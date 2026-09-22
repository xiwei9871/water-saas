import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DomainError } from '@ws/billing-core';
import type { Request } from 'express';
import { isUniqueViolation } from '../../common/prisma-errors.js';
import { orgInScope, type TenantCtx } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { PrepaymentService } from '../prepayment/prepayment.service.js';
import {
  computeBill,
  feeItemIdMap,
  insertBillItems,
  loadFeeItems,
  lockAccountForUpdate,
  lockPlanForUpdate,
  ytdBeforeQty,
} from './pricing.js';

export const BILL_SELECT = {
  id: true,
  tenantId: true,
  billingRunId: true,
  settleAccountId: true,
  waterAccountId: true,
  period: true,
  billKind: true,
  sourceType: true,
  sourceId: true,
  tariffPlanId: true,
  status: true,
  isEstimated: true,
  totalAmount: true,
  issuedAt: true,
  dueDate: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.BillSelect;

export const BILL_ITEM_SELECT = {
  id: true,
  tenantId: true,
  billId: true,
  feeItemId: true,
  itemType: true,
  description: true,
  qty: true,
  unitPrice: true,
  amount: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.BillItemSelect;

/** The selected shape of BILL_SELECT — used by cross-service callers. */
export type BillRow = Prisma.BillGetPayload<{ select: typeof BILL_SELECT }>;

type BillStatus = 'DRAFT' | 'POSTED' | 'PARTIAL_PAID' | 'PAID' | 'REVERSED';

const notReversable = (status: string, reason?: string) =>
  new ConflictException({ code: 'BILL_NOT_REVERSABLE', status, reason });

const outOfScope = () => new ForbiddenException({ code: 'ORG_OUT_OF_SCOPE' });

const notReplaceable = (status: string, reason?: string) =>
  new ConflictException({ code: 'BILL_NOT_REPLACEABLE', status, reason });

/** Reversal/replacement are defined on POSTED-side debt only. */
const CORRECTABLE_STATUSES = new Set(['POSTED', 'PARTIAL_PAID']);

/**
 * Bill （账单） + BillItem — the issued debt rows a billing_run produces
 * (spec §2.5). Once POSTED a bill's financial facts are immutable
 * (spec §1.3): corrections never rewrite the row — they append:
 *
 *  - POST /bills/:id/reverse — 红冲: the original flips POSTED |
 *    PARTIAL_PAID → REVERSED (guarded updateMany) and a REVERSAL bill is
 *    created POSTED with totalAmount = −original and every item negated.
 *    Reversal items carry `itemType=ADJUSTMENT` (not NORMAL): they are a
 *    corrective mirror, not a price quote — qty is negated alongside
 *    amount so qty × unit_price stays truthful, and a REVERSAL-kind bill
 *    can itself never be reversed (an "un-reversal" is a new bill, not a
 *    double negative). PAID and DRAFT bills are not reversable —
 *    refunding paid money is T12's flow, and a DRAFT is deleted, not
 *    reversed. UNIQUE(tenant, ORIGINAL_BILL, source_id, REVERSAL) makes a
 *    second reverse a 409.
 *  - POST /bills/:id/replace {usageQty} — the manual correction path:
 *    the original is reversed AND a REPLACEMENT bill (same source key)
 *    is computed POSTED in the same tx. Recomputation quotes the
 *    ORIGINAL bill's tariff_plan tiers — bill.tariff_plan_id is the
 *    pricing-version snapshot, so a later reprice/new-version never
 *    contaminates what this correction should have cost. The supplied
 *    usageQty replaces the settlement quantity; the annual ladder cursor
 *    is recomputed exactly as generation does (ytdBeforeQty). Items are
 *    NORMAL (it is a real price quote, unlike the reversal mirror).
 */
@Injectable()
export class BillService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly prepay: PrepaymentService,
  ) {}

  list(
    ctx: TenantCtx,
    q: {
      take: number;
      skip: number;
      period?: string;
      status?: BillStatus;
      waterAccountId?: string;
      settleAccountId?: string;
      billingRunId?: string;
    },
  ) {
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.bill.findMany({
        where: {
          tenantId: ctx.tenantId,
          period: q.period,
          status: q.status,
          waterAccountId: q.waterAccountId,
          settleAccountId: q.settleAccountId,
          billingRunId: q.billingRunId,
        },
        select: BILL_SELECT,
        orderBy: [{ period: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
        take: q.take,
        skip: q.skip,
      }),
    );
  }

  async getById(ctx: TenantCtx, id: string) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const bill = await tx.bill.findFirst({
        where: { tenantId: ctx.tenantId, id },
        select: BILL_SELECT,
      });
      if (!bill) throw new NotFoundException({ code: 'BILL_NOT_FOUND' });
      return this.withItems(tx, ctx, bill);
    });
  }

  /**
   * POST /bills/:id/reverse — one tx: guarded POSTED|PARTIAL_PAID →
   * REVERSED on the original + POSTED REVERSAL bill with negated items.
   * The plan row is locked FOR UPDATE before the reversal insert (T8
   * freeze contract — the reversal is a new non-DRAFT reference).
   */
  async reverseTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    id: string,
    req: Request,
  ) {
    const original = await this.loadCorrectable(tx, ctx, id, notReversable);
    await this.assertAccountScope(tx, ctx, original.waterAccountId, original.period);
    req.auditBefore = original;

    // Friendly pre-check; the unique index still guards the race.
    const dup = await tx.bill.findFirst({
      where: {
        tenantId: ctx.tenantId,
        sourceType: 'ORIGINAL_BILL',
        sourceId: id,
        billKind: 'REVERSAL',
      },
      select: { id: true },
    });
    if (dup) {
      throw new ConflictException({
        code: 'BILL_ALREADY_REVERSED',
        reversalBillId: dup.id,
      });
    }

    // E6 lock order (domain §14): water_account → settle_account →
    // tariff_plan → bill — the settle row is the prepayment-fund lock.
    await lockAccountForUpdate(tx, ctx, original.waterAccountId);
    await this.prepay.lockSettleAccountForUpdate(tx, ctx, original.settleAccountId);
    if (original.tariffPlanId) {
      await lockPlanForUpdate(tx, ctx, original.tariffPlanId);
    }
    const flip = await tx.bill.updateMany({
      where: {
        tenantId: ctx.tenantId,
        id,
        // PAID is admitted by loadCorrectable only when a PREPAYMENT
        // leg exists — the guard just fences the flip race.
        status: { in: [...CORRECTABLE_STATUSES, 'PAID'] as BillStatus[] },
      },
      data: { status: 'REVERSED', updatedBy: ctx.staffId },
    });
    if (flip.count === 0) {
      const cur = await tx.bill.findFirst({
        where: { tenantId: ctx.tenantId, id },
        select: { status: true },
      });
      throw notReversable(cur?.status ?? 'gone', 'lost guarded transition race');
    }

    // E6 (domain §10/§20): restore every PREPAYMENT APPLY via append-only
    // REVERSAL(+restore) + mirror allocation(-restore); the cash leg
    // keeps its own reversedBillCredit → payment-reversal path.
    await this.prepay.reverseAppliedForBillTx(
      tx,
      ctx,
      id,
      'bill reversal',
    );

    const items = await tx.billItem.findMany({
      where: { tenantId: ctx.tenantId, billId: id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    let reversal;
    try {
      reversal = await tx.bill.create({
        data: {
          tenantId: ctx.tenantId,
          billingRunId: null,
          settleAccountId: original.settleAccountId,
          waterAccountId: original.waterAccountId,
          period: original.period,
          billKind: 'REVERSAL',
          sourceType: 'ORIGINAL_BILL',
          sourceId: original.id,
          tariffPlanId: original.tariffPlanId,
          status: 'POSTED',
          isEstimated: original.isEstimated,
          totalAmount: -original.totalAmount,
          issuedAt: new Date(),
          dueDate: null, // a reversal demands nothing — it settles a debt
          createdBy: ctx.staffId,
          updatedBy: ctx.staffId,
        },
        select: BILL_SELECT,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException({ code: 'BILL_ALREADY_REVERSED' });
      }
      throw err;
    }
    await tx.billItem.createMany({
      data: items.map((it) => ({
        tenantId: ctx.tenantId,
        billId: reversal.id,
        feeItemId: it.feeItemId,
        // ADJUSTMENT, not NORMAL: the row is a corrective mirror of the
        // original line — negative qty keeps qty × unit_price = amount
        // honest while marking the row as a correction, not a quote.
        itemType: 'ADJUSTMENT',
        description: `reversal of ${original.id}: ${it.description ?? it.feeItemId ?? 'item'}`,
        qty: it.qty === null ? null : it.qty.neg(),
        unitPrice: it.unitPrice,
        amount: -it.amount,
        createdBy: ctx.staffId,
        updatedBy: ctx.staffId,
      })),
    });
    return this.withItems(tx, ctx, reversal);
  }

  /**
   * POST /bills/:id/replace {usageQty} — one tx: guarded reversal of the
   * original + POSTED REPLACEMENT bill recomputed on the ORIGINAL
   * tariff plan's tiers with the supplied usage and the generation-time
   * ytd ladder cursor. usageQty is REQUIRED — replacing a bill is an
   * explicit operator correction, never a silent re-read of the
   * settlement.
   */
  async replaceTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    id: string,
    body: { usageQty: Prisma.Decimal },
    req: Request,
  ) {
    const original = await this.loadCorrectable(tx, ctx, id, notReplaceable);
    await this.assertAccountScope(tx, ctx, original.waterAccountId, original.period);
    req.auditBefore = original;
    if (!original.tariffPlanId) {
      throw notReplaceable(
        original.status,
        'original bill has no tariff plan to reprice against',
      );
    }

    const dup = await tx.bill.findFirst({
      where: {
        tenantId: ctx.tenantId,
        sourceType: 'ORIGINAL_BILL',
        sourceId: id,
        billKind: 'REPLACEMENT',
      },
      select: { id: true },
    });
    if (dup) {
      throw new ConflictException({
        code: 'BILL_ALREADY_REPLACED',
        replacementBillId: dup.id,
      });
    }

    // Reprice against the ORIGINAL plan — including its household-scale
    // params — and the original settlement's frozen household snapshot,
    // never the account's current declaration.
    const plan = await tx.tariffPlan.findFirstOrThrow({
      where: { tenantId: ctx.tenantId, id: original.tariffPlanId },
      select: { id: true, baseHousehold: true, perPersonQty: true },
    });
    const feeItems = await loadFeeItems(tx, ctx, plan);
    const sourceSettlement =
      original.sourceType === 'SETTLEMENT' && original.sourceId
        ? await tx.consumptionSettlement.findFirst({
            where: { tenantId: ctx.tenantId, id: original.sourceId },
            select: { householdSizeSnapshot: true },
          })
        : null;
    const ytd = await ytdBeforeQty(tx, ctx, original.waterAccountId, original.period);
    let result;
    try {
      result = computeBill({
        usageQty: body.usageQty,
        ytdBeforeQty: ytd,
        householdSize: sourceSettlement?.householdSizeSnapshot ?? null,
        feeItems,
      });
    } catch (err) {
      if (err instanceof DomainError) {
        throw new BadRequestException({ code: err.code, message: err.message });
      }
      throw err;
    }

    // Same frozen lock order as reverseTx: water → settle → plan → bill.
    await lockAccountForUpdate(tx, ctx, original.waterAccountId);
    await this.prepay.lockSettleAccountForUpdate(tx, ctx, original.settleAccountId);
    await lockPlanForUpdate(tx, ctx, original.tariffPlanId);
    const flip = await tx.bill.updateMany({
      where: {
        tenantId: ctx.tenantId,
        id,
        status: { in: [...CORRECTABLE_STATUSES, 'PAID'] as BillStatus[] },
      },
      data: { status: 'REVERSED', updatedBy: ctx.staffId },
    });
    if (flip.count === 0) {
      const cur = await tx.bill.findFirst({
        where: { tenantId: ctx.tenantId, id },
        select: { status: true },
      });
      throw notReplaceable(cur?.status ?? 'gone', 'lost guarded transition race');
    }

    // Restore the original's PREPAYMENT APPLY before the REPLACEMENT
    // re-applies the freed balance below.
    await this.prepay.reverseAppliedForBillTx(
      tx,
      ctx,
      id,
      'bill replacement',
    );

    let replacement;
    try {
      replacement = await tx.bill.create({
        data: {
          tenantId: ctx.tenantId,
          billingRunId: null,
          settleAccountId: original.settleAccountId,
          waterAccountId: original.waterAccountId,
          period: original.period,
          billKind: 'REPLACEMENT',
          sourceType: 'ORIGINAL_BILL',
          sourceId: original.id,
          tariffPlanId: original.tariffPlanId,
          status: 'POSTED',
          // isEstimated mirrors the original: the settlement flag it
          // replaced stays the audit truth; the corrected usage is the
          // operator's own assertion recorded in this new document.
          isEstimated: original.isEstimated,
          totalAmount: result.totalAmountCent,
          issuedAt: new Date(),
          dueDate: original.dueDate, // same debt, same due date
          createdBy: ctx.staffId,
          updatedBy: ctx.staffId,
        },
        select: BILL_SELECT,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException({ code: 'BILL_ALREADY_REPLACED' });
      }
      throw err;
    }
    const idMap = await feeItemIdMap(
      tx,
      ctx,
      result.items.map((i) => i.feeItemCode),
    );
    await insertBillItems(tx, ctx, replacement.id, result.items, idMap);
    // E6 (domain §9): the REPLACEMENT is a new payable POSTED debt —
    // it consumes prepayment in this same tx.
    if (replacement.totalAmount > 0n) {
      await this.prepay.applyForPostedDebtTx(tx, ctx, original.settleAccountId);
      // Re-read — the APPLY recompute may have flipped the status.
      replacement = await tx.bill.findFirstOrThrow({
        where: { tenantId: ctx.tenantId, id: replacement.id },
        select: BILL_SELECT,
      });
    }
    return this.withItems(tx, ctx, replacement);
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private async withItems<T extends { id: string }>(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    bill: T,
  ) {
    const items = await tx.billItem.findMany({
      where: { tenantId: ctx.tenantId, billId: bill.id },
      select: BILL_ITEM_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    // E6: allocations on the bill with their source attribution — a
    // PREPAYMENT alloc links the funding ledger entry (APPLY on apply,
    // REVERSAL-of-APPLY on restore), so the UI can trace balance ⇄ debt.
    const allocs = await tx.paymentAlloc.findMany({
      where: { tenantId: ctx.tenantId, billId: bill.id },
      select: {
        id: true,
        source: true,
        paymentId: true,
        prepaymentEntryId: true,
        amount: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return { ...bill, items, allocs };
  }

  /**
   * Load the bill and enforce the correctable contract shared by reverse
   * and replace: POSTED|PARTIAL_PAID only, and never on a REVERSAL-kind
   * bill (a reversal's mirror is itself a correction — reversing it would
   * mint a positive charge out of thin air).
   */
  private async loadCorrectable(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    id: string,
    reject: (status: string, reason?: string) => ConflictException,
  ) {
    const bill = await tx.bill.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!bill) throw new NotFoundException({ code: 'BILL_NOT_FOUND' });
    if (bill.billKind === 'REVERSAL') {
      throw reject(bill.status, 'REVERSAL bills cannot be corrected');
    }
    if (!CORRECTABLE_STATUSES.has(bill.status)) {
      // E6 (domain §20): a PAID bill is correctable only when a
      // PREPAYMENT allocation exists — its restore is ledger-internal
      // (no cash moved), while a pure-cash PAID bill stays sealed
      // because refunding cash is the payment-reversal flow.
      if (
        bill.status !== 'PAID' ||
        !(await this.prepay.hasPrepaymentAllocsTx(tx, ctx, id))
      ) {
        throw reject(bill.status);
      }
    }
    return bill;
  }

  /**
   * Single-bill mutations are account facts like settlements: a scoped
   * (non-ALL) caller may only touch bills whose water_account sits in
   * their subtree — resolved the same way settlement.service does, via
   * the period's plan items → plans → books. An account in NO reading
   * plan returns permissively (same convention); run-level batch ops
   * skip this check deliberately (tenant-wide by nature — see
   * BillingRunService's class docblock).
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
