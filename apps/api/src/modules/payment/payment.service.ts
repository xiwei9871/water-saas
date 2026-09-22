import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { SequenceService } from '../../common/sequence.service.js';
import { orgInScope, type TenantCtx } from '../../common/tenant-context.js';
import {
  assertAccountScopeTx,
  outOfScopeSettleAccountIds,
} from '../../common/account-scope.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { lockAccountForUpdate } from '../billing/pricing.js';
import { PrepaymentService } from '../prepayment/prepayment.service.js';

export const PAYMENT_SELECT = {
  id: true,
  tenantId: true,
  paymentNo: true,
  settleAccountId: true,
  cashierId: true,
  orgUnitId: true,
  channel: true,
  amount: true,
  status: true,
  receivedAt: true,
  reversalOfId: true,
  dayCloseId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PaymentSelect;

export const PAYMENT_ALLOC_SELECT = {
  id: true,
  tenantId: true,
  source: true,
  paymentId: true,
  prepaymentEntryId: true,
  billId: true,
  amount: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PaymentAllocSelect;

export const RECEIPT_SELECT = {
  id: true,
  tenantId: true,
  paymentId: true,
  receiptNo: true,
  rcpType: true,
  printedAt: true,
  voidFlag: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ReceiptSelect;

type PayChannel = 'CASH' | 'POS' | 'TRANSFER';
type PaymentStatus = 'RECEIVED' | 'DAY_CLOSED' | 'REVERSED';
type BillStatus = 'DRAFT' | 'POSTED' | 'PARTIAL_PAID' | 'PAID' | 'REVERSED';

/** Statuses whose outstanding balance a payment may reduce. */
const PAYABLE_STATUSES = new Set<BillStatus>(['POSTED', 'PARTIAL_PAID']);
/** The guarded-update predicate shared by both recompute directions. */
const RECOMPUTE_STATUSES: BillStatus[] = ['POSTED', 'PARTIAL_PAID', 'PAID'];

const outOfScope = () => new ForbiddenException({ code: 'ORG_OUT_OF_SCOPE' });

const notPayable = (billId: string, status: string, reason?: string) =>
  new ConflictException({ code: 'BILL_NOT_PAYABLE', billId, status, reason });

export interface CreatePaymentBody {
  settleAccountId: string;
  channel: PayChannel;
  /** Positive integer cents — the controller guarantees > 0. */
  amount: bigint;
  /** Non-empty, unique billIds, Σ amount == amount (controller-verified). */
  allocs: { billId: string; amount: bigint }[];
}

/**
 * `SELECT … FOR UPDATE` on ONE bill row. Bill rows are always locked one
 * at a time in caller-sorted id order — the same contract the T8 plan
 * freeze uses — so every transaction that touches several bills walks the
 * identical lock sequence and concurrent payments/reversals on
 * overlapping bills serialize instead of deadlocking.
 */
const lockBillForUpdate = async (
  tx: Prisma.TransactionClient,
  ctx: TenantCtx,
  billId: string,
) => {
  await tx.$queryRaw`
    SELECT id FROM bill
    WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${billId}::uuid
    FOR UPDATE`;
};

/**
 * `SELECT … FOR UPDATE` on the payment row — taken BEFORE the
 * already-reversed probe in reverseTx so two concurrent reverses of the
 * same payment serialize: the loser reads the winner's committed
 * reversal and 409s (a plain check alone would let both inserts pass).
 */
const lockPaymentForUpdate = async (
  tx: Prisma.TransactionClient,
  ctx: TenantCtx,
  paymentId: string,
) => {
  await tx.$queryRaw`
    SELECT id FROM payment
    WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${paymentId}::uuid
    FOR UPDATE`;
};

/**
 * Payment （收款） + PaymentAlloc （销账分摊） + Receipt （收据） — counter
 * collection and write-off allocation (spec §2.6).
 *
 *  - POST /payments — one tx: bill rows locked FOR UPDATE in sorted id
 *    order, each target validated payable (non-REVERSAL, POSTED |
 *    PARTIAL_PAID, positive outstanding), payment + allocs + receipt
 *    inserted, each bill's status recomputed from Σ allocs
 *    (≥ total → PAID, > 0 → PARTIAL_PAID). payment_no/receipt_no come
 *    from sys_sequence inside the same tx — a rolled-back request
 *    returns its numbers (unique, not gapless).
 *  - POST /payments/:id/reverse — APPEND-ONLY reversal (T12 decided
 *    semantics): the original payment's status is NEVER mutated — a
 *    RECEIVED original must still enter its day close at face value so
 *    the +amount/−amount pair nets to zero in the drawer, and a
 *    DAY_CLOSED original must not change a signed close. The reversal is
 *    a NEW payment (amount negated, reversal_of_id → original, same
 *    channel/settle_account, RECEIVED) that lands in the NEXT close as a
 *    negative line — the patch's "9/18 close +100 stays, 9/19 close
 *    carries −100". It is attributed to the ORIGINAL payment's cashier
 *    and org_unit (the +/− pair nets inside one cashier's drawer
 *    sequence); createdBy records whoever ran the refund.
 *    PaymentStatus.REVERSED is therefore vestigial in the
 *    enum: nothing ever transitions into it. Mirror allocs (−amount
 *    each) release the bills' outstanding and statuses are recomputed
 *    back (Σ = 0 → POSTED, partial → PARTIAL_PAID). The original's
 *    receipt is voided in the same tx. Reversing a reversal → 400;
 *    double-reverse → 409 behind the payment row lock; a reversal that
 *    would resurrect debt on a CLOSED water account → 409
 *    PAYMENT_ACCOUNT_CLOSED (account rows are locked FOR UPDATE first,
 *    serializing against close-account).
 *  - No receipt is issued for a reversal payment: a receipt documents
 *    money received at the counter; the reversal is a correction line —
 *    the voided original receipt is the audit trail.
 *  - Over-payment / credit is OUT of MVP scope: every alloc must fit
 *    the bill's remaining outstanding (409 PAYMENT_OVER_ALLOCATION).
 */
@Injectable()
export class PaymentService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly seq: SequenceService,
    private readonly prepay: PrepaymentService,
  ) {}

  list(
    ctx: TenantCtx,
    q: {
      take: number;
      skip: number;
      settleAccountId?: string;
      cashierId?: string;
      status?: PaymentStatus;
      channel?: PayChannel;
    },
  ) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      // E8 read-scope: explicit settleAccountId asserts strict scope;
      // unfiltered scoped lists drop payments on out-of-scope settle
      // accounts (E6 strict coverage rule).
      if (q.settleAccountId) {
        await this.assertSettleScope(tx, ctx, q.settleAccountId);
      }
      const hidden =
        !q.settleAccountId && ctx.scope !== 'ALL'
          ? await outOfScopeSettleAccountIds(tx, ctx)
          : [];
      return tx.payment.findMany({
        where: {
          tenantId: ctx.tenantId,
          settleAccountId: q.settleAccountId,
          ...(hidden.length ? { settleAccountId: { notIn: hidden } } : {}),
          cashierId: q.cashierId,
          status: q.status,
          channel: q.channel,
        },
        select: PAYMENT_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: q.take,
        skip: q.skip,
      });
    });
  }

  /** GET /payments/:id — payment + its allocs + the receipt (null on a
   *  reversal payment, which is never issued one). */
  async getById(ctx: TenantCtx, id: string) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const payment = await tx.payment.findFirst({
        where: { tenantId: ctx.tenantId, id },
        select: PAYMENT_SELECT,
      });
      if (!payment) throw new NotFoundException({ code: 'PAYMENT_NOT_FOUND' });
      await this.assertSettleScope(tx, ctx, payment.settleAccountId);
      return this.withDetail(tx, ctx, payment);
    });
  }

  /**
   * POST /payments — validated input (controller) → one tx. Order:
   * settle_account → scope probe → sorted bill FOR UPDATE locks →
   * per-alloc payable/outstanding checks → staff lookup → payment +
   * allocs + receipt inserts → guarded bill status recompute. The bill
   * row locks precede every outstanding read so a concurrent payment on
   * the same bill can never split the difference.
   *
   * Account status is NOT gated: paying onto a SUSPENDED account is
   * normal residual-debt collection (suspension stops water, not owed
   * money), and a CLOSED account simply has no payable bills left — the
   * per-alloc 409s cover it naturally without a special case.
   */
  async createTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    body: CreatePaymentBody,
  ) {
    const settleAccount = await tx.settleAccount.findFirst({
      where: { tenantId: ctx.tenantId, id: body.settleAccountId },
      select: { id: true },
    });
    if (!settleAccount) {
      throw new NotFoundException({ code: 'SETTLE_ACCOUNT_NOT_FOUND' });
    }
    await this.assertSettleScope(tx, ctx, body.settleAccountId);

    // Sorted FOR UPDATE on every target bill — serializes concurrent
    // payments (and reversals) against the same rows in the same order.
    const billIds = [...new Set(body.allocs.map((a) => a.billId))].sort();
    for (const billId of billIds) {
      await lockBillForUpdate(tx, ctx, billId);
    }
    const bills = await tx.bill.findMany({
      where: { tenantId: ctx.tenantId, id: { in: billIds } },
      select: {
        id: true,
        settleAccountId: true,
        billKind: true,
        status: true,
        totalAmount: true,
      },
    });
    const byId = new Map(bills.map((b) => [b.id, b]));
    // Money already applied per bill — negative reversal allocs net out
    // inside the sum automatically.
    const paidByBill = await this.appliedByBill(tx, ctx, billIds);

    for (const alloc of body.allocs) {
      const bill = byId.get(alloc.billId);
      if (!bill) {
        throw new NotFoundException({ code: 'BILL_NOT_FOUND', billId: alloc.billId });
      }
      if (bill.settleAccountId !== body.settleAccountId) {
        throw new BadRequestException({
          code: 'PAYMENT_BILL_ACCOUNT_MISMATCH',
          billId: alloc.billId,
        });
      }
      if (bill.billKind === 'REVERSAL' || !PAYABLE_STATUSES.has(bill.status)) {
        throw notPayable(alloc.billId, bill.status, `kind ${bill.billKind}`);
      }
      const outstanding = bill.totalAmount - (paidByBill.get(bill.id) ?? 0n);
      if (outstanding <= 0n) {
        throw notPayable(alloc.billId, bill.status, 'no outstanding balance');
      }
      if (alloc.amount > outstanding) {
        throw new ConflictException({
          code: 'PAYMENT_OVER_ALLOCATION',
          billId: alloc.billId,
          outstanding: outstanding.toString(),
        });
      }
    }

    const staff = await tx.staff.findFirst({
      where: { tenantId: ctx.tenantId, id: ctx.staffId },
      select: { orgUnitId: true },
    });
    if (!staff) throw new NotFoundException({ code: 'STAFF_NOT_FOUND' });

    const paymentNo = await this.seq.nextFormatted(
      tx,
      ctx.tenantId,
      'payment_no',
      'P',
      ctx.staffId,
    );
    const payment = await tx.payment.create({
      data: {
        tenantId: ctx.tenantId,
        paymentNo,
        settleAccountId: body.settleAccountId,
        cashierId: ctx.staffId,
        orgUnitId: staff.orgUnitId,
        channel: body.channel,
        amount: body.amount,
        status: 'RECEIVED',
        createdBy: ctx.staffId,
        updatedBy: ctx.staffId,
      },
      select: PAYMENT_SELECT,
    });
    await tx.paymentAlloc.createMany({
      data: body.allocs.map((a) => ({
        tenantId: ctx.tenantId,
        paymentId: payment.id,
        billId: a.billId,
        amount: a.amount,
        createdBy: ctx.staffId,
        updatedBy: ctx.staffId,
      })),
    });
    const receiptNo = await this.seq.nextFormatted(
      tx,
      ctx.tenantId,
      'receipt_no',
      'R',
      ctx.staffId,
    );
    const receipt = await tx.receipt.create({
      data: {
        tenantId: ctx.tenantId,
        paymentId: payment.id,
        receiptNo,
        createdBy: ctx.staffId,
        updatedBy: ctx.staffId,
      },
      select: RECEIPT_SELECT,
    });

    // Recompute each bill: new paid = pre-existing Σ allocs + this alloc.
    // The row lock is already held, so the guarded updateMany can only
    // lose to a pathological status write outside this module — reported,
    // never silently skipped.
    for (const alloc of body.allocs) {
      const bill = byId.get(alloc.billId)!;
      const paid = (paidByBill.get(bill.id) ?? 0n) + alloc.amount;
      const next: BillStatus = paid >= bill.totalAmount ? 'PAID' : 'PARTIAL_PAID';
      const flip = await tx.bill.updateMany({
        where: {
          tenantId: ctx.tenantId,
          id: bill.id,
          status: { in: RECOMPUTE_STATUSES },
        },
        data: { status: next, updatedBy: ctx.staffId },
      });
      if (flip.count === 0) {
        throw notPayable(bill.id, bill.status, 'lost guarded transition race');
      }
    }

    const allocs = await tx.paymentAlloc.findMany({
      where: { tenantId: ctx.tenantId, paymentId: payment.id },
      select: PAYMENT_ALLOC_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return { ...payment, allocs, receipt };
  }

  /**
   * GET /water-accounts/:id/outstanding — the cashier's open-debt view:
   * every POSTED | PARTIAL_PAID non-REVERSAL bill on the account's settle
   * account with its remaining balance > 0, plus the net total. This is
   * the per-bill projection of BillingFinancePort.getOutstanding minus
   * the in-flight DRAFT term (a DRAFT is not yet payable at the counter)
   * — INCLUDING its credit leg: `reversedBillCredit` surfaces money
   * applied to bills that were red-flushed afterwards (the customer is
   * owed it back via a payment reversal — a refund, not more
   * collection). Without it the probe would overstate collectible debt
   * by exactly the orphaned alloc sum.
   */
  async outstandingTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    waterAccountId: string,
  ) {
    const account = await tx.waterAccount.findFirst({
      where: { tenantId: ctx.tenantId, id: waterAccountId },
      select: { id: true, settleAccountId: true },
    });
    if (!account) {
      throw new NotFoundException({ code: 'WATER_ACCOUNT_NOT_FOUND' });
    }
    // E8 read-scope: the counter probe must not expose another branch's debt.
    await assertAccountScopeTx(tx, ctx, waterAccountId);
    const bills = await tx.bill.findMany({
      where: {
        tenantId: ctx.tenantId,
        settleAccountId: account.settleAccountId,
        status: { in: ['POSTED', 'PARTIAL_PAID'] },
        billKind: { not: 'REVERSAL' },
      },
      select: { id: true, period: true, billKind: true, totalAmount: true },
      orderBy: [{ period: 'asc' }, { id: 'asc' }],
    });
    const paidByBill = await this.appliedByBill(
      tx,
      ctx,
      bills.map((b) => b.id),
    );
    const lines = bills.map((b) => {
      const paidAmount = paidByBill.get(b.id) ?? 0n;
      return {
        billId: b.id,
        period: b.period,
        billKind: b.billKind,
        totalAmount: b.totalAmount,
        paidAmount,
        outstanding: b.totalAmount - paidAmount,
      };
    });
    // The REVERSED-side credit: a bill red-flushed AFTER money was
    // applied (PARTIAL_PAID → reverse/replace) leaves its allocs behind
    // — append-only, so they survive the status flip and the gross
    // contribution vanishes with the status. Σ allocs on REVERSED bills
    // is money the customer prepaid on voided debt — owed back, and it
    // must net against what the cashier is asked to collect (this is
    // BillingFinancePort.getOutstanding's alloc term, minus the DRAFT
    // term the counter doesn't see). A positive reversedBillCredit says
    // "run a payment reversal (refund), don't collect more".
    const reversedBillCredit = await tx.paymentAlloc.aggregate({
      _sum: { amount: true },
      where: {
        tenantId: ctx.tenantId,
        bill: {
          tenantId: ctx.tenantId,
          settleAccountId: account.settleAccountId,
          status: 'REVERSED',
          billKind: { not: 'REVERSAL' },
        },
      },
    });
    const credit = reversedBillCredit._sum.amount ?? 0n;
    // items = the payable lines (outstanding > 0 — a zero/negative bill
    // is nothing the cashier can act on, and alloc targets require
    // positive outstanding anyway). totalOutstanding = the settle
    // account's NET position: Σ over every live line (a negative
    // ADJUSTMENT nets against real debt) minus the reversed-bill credit
    // — so the total can differ from Σ items and can itself go negative.
    const items = lines.filter((i) => i.outstanding > 0n);
    const totalOutstanding =
      lines.reduce((s, i) => s + i.outstanding, 0n) - credit;
    // E6: the settle account's prepayment balance — the counter needs it
    // beside the debt view (it auto-consumes on the next posted debt).
    const prepaymentBalance = await this.prepay.balanceTx(
      tx,
      ctx,
      account.settleAccountId,
    );
    return {
      waterAccountId: account.id,
      settleAccountId: account.settleAccountId,
      items,
      reversedBillCredit: credit,
      totalOutstanding,
      prepaymentBalance,
    };
  }

  /**
   * GET /water-accounts/:id/payment-activity — E8 D4: 本户账单偿付记录.
   * Rows are payment_allocs on THIS account's bills (never payment.amount
   * — a settle account may span accounts and a payment may split across
   * bills). Discriminated union on `source`: PAYMENT → counter payment
   * object; PREPAYMENT → the ledger entry that produced the APPLY —
   * never dressed up as a fake payment row.
   */
  async paymentActivityTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    waterAccountId: string,
    q: { take: number; skip: number },
  ) {
    const account = await tx.waterAccount.findFirst({
      where: { tenantId: ctx.tenantId, id: waterAccountId },
      select: { id: true },
    });
    if (!account) {
      throw new NotFoundException({ code: 'WATER_ACCOUNT_NOT_FOUND' });
    }
    await assertAccountScopeTx(tx, ctx, waterAccountId);
    const allocs = await tx.paymentAlloc.findMany({
      where: {
        tenantId: ctx.tenantId,
        bill: { tenantId: ctx.tenantId, waterAccountId },
      },
      select: {
        id: true,
        source: true,
        amount: true,
        createdAt: true,
        bill: {
          select: {
            id: true,
            period: true,
            billKind: true,
            status: true,
            totalAmount: true,
          },
        },
        payment: { select: PAYMENT_SELECT },
        prepaymentEntry: {
          select: {
            id: true,
            type: true,
            amount: true,
            operatorId: true,
            reason: true,
            createdAt: true,
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: q.take,
      skip: q.skip,
    });
    return allocs.map((a) => ({
      id: a.id,
      source: a.source,
      allocatedAmount: a.amount,
      createdAt: a.createdAt,
      bill: a.bill,
      ...(a.source === 'PAYMENT'
        ? { payment: a.payment }
        : { prepaymentEntry: a.prepaymentEntry }),
    }));
  }

  /**
   * POST /payments/:id/reverse — append-only 红冲退款 (see class
   * docblock for why the original is never mutated). Order: payment row
   * FOR UPDATE (serializes double-reverse) → load → already-reversed
   * probe → scope → affected water_account rows FOR UPDATE in sorted id
   * order → CLOSED refuses → sorted bill locks → reversal payment +
   * mirror allocs + receipt void → bill status recompute.
   *
   * The account locks serialize against close-account (closeTx takes the
   * same row lock before its guarded CLOSED flip) and against bill
   * posting (postOneBill: account → plan → bill). A payment reversal is
   * the common path that can RAISE an account's outstanding — without
   * the lock, a racing or already-committed close would leave a CLOSED
   * account carrying resurrected debt with no recovery path. (Known
   * same-class residual: bill.reverseTx on a NEGATIVE bill — e.g. an
   * ADJUSTMENT — also resurrects debt and takes no account lock yet;
   * flagged for a follow-up, not this path.) Lock order
   * is payment → accounts → bills → seq: nothing else takes a payment
   * row lock and then waits on accounts (day-close flips payments under
   * the staff lock; postOneBill never touches payment rows), so no
   * lock-order cycle exists with either writer.
   *
   * Attribution: the reversal's cashierId/orgUnitId are the ORIGINAL
   * payment's — the correction belongs in that cashier's drawer
   * sequence so the +/− pair nets inside one cashier's closes, no matter
   * who performs the refund. createdBy still records the actor.
   */
  async reverseTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    id: string,
    req: Request,
  ) {
    await lockPaymentForUpdate(tx, ctx, id);
    const original = await tx.payment.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!original) throw new NotFoundException({ code: 'PAYMENT_NOT_FOUND' });
    if (original.reversalOfId !== null) {
      // A reversal is itself a correction — reversing it would mint a
      // positive leg out of a negative one (same rule as REVERSAL bills).
      throw new BadRequestException({
        code: 'PAYMENT_NOT_REVERSABLE',
        paymentId: id,
      });
    }
    req.auditBefore = original;

    // Serialized by the payment row lock above — the winner's reversal
    // row is committed-visible to the loser.
    const dup = await tx.payment.findFirst({
      where: { tenantId: ctx.tenantId, reversalOfId: id },
      select: { id: true },
    });
    if (dup) {
      throw new ConflictException({
        code: 'PAYMENT_ALREADY_REVERSED',
        reversalPaymentId: dup.id,
      });
    }
    await this.assertSettleScope(tx, ctx, original.settleAccountId);

    // E6 (domain §10): a REFUND payment is itself a money-out fact —
    // "undoing a refund" is a fresh top-up, never a reversal.
    const refundLegs = await this.prepay.ledgerOfPaymentTx(tx, ctx, id, ['REFUND']);
    if (refundLegs.length) {
      throw new BadRequestException({
        code: 'PAYMENT_NOT_REVERSABLE',
        paymentId: id,
      });
    }
    const topUpLegs = await this.prepay.ledgerOfPaymentTx(tx, ctx, id, ['TOP_UP']);

    // E6 (domain §13): the route guard admits either permission; the
    // precise requirement is decided on this payment's facts —
    // 本人当日未日结 → payment:write; otherwise a TOP_UP-containing
    // reversal requires prepayment:reverse. That perm never grants the
    // ordinary cash-reversal right: a cash-only payment still demands
    // payment:write.
    const perms = (req.user as { perms?: string[] } | undefined)?.perms ?? [];
    const hasPerm = (c: string) => perms.includes('*') || perms.includes(c);
    if (topUpLegs.length) {
      const sameDayRows = await tx.$queryRaw<{ same_day: boolean }[]>`
        SELECT (received_at::date = CURRENT_DATE) AS same_day
        FROM payment
        WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${id}::uuid`;
      const sameDaySelf =
        original.cashierId === ctx.staffId &&
        original.dayCloseId === null &&
        (sameDayRows[0]?.same_day ?? false);
      const required = sameDaySelf ? 'payment:write' : 'prepayment:reverse';
      if (!hasPerm(required)) {
        throw new ForbiddenException({
          code: 'PERMISSION_DENIED',
          required: [required],
        });
      }
    } else if (!hasPerm('payment:write')) {
      throw new ForbiddenException({
        code: 'PERMISSION_DENIED',
        required: ['payment:write'],
      });
    }

    const origAllocs = await tx.paymentAlloc.findMany({
      where: { tenantId: ctx.tenantId, paymentId: id },
      select: { billId: true, amount: true },
    });
    const billIds = [...new Set(origAllocs.map((a) => a.billId))].sort();

    // Discover the affected water accounts before locking anything —
    // bill.waterAccountId is immutable so an unlocked read suffices to
    // choose the lock set. Every distinct account locks in sorted id
    // order (all multi-row lockers in this codebase walk sorted ids).
    const allocBills = billIds.length
      ? await tx.bill.findMany({
          where: { tenantId: ctx.tenantId, id: { in: billIds } },
          select: { waterAccountId: true },
        })
      : [];
    const accountIds = [
      ...new Set(allocBills.map((b) => b.waterAccountId)),
    ].sort();
    for (const accountId of accountIds) {
      await lockAccountForUpdate(tx, ctx, accountId);
    }
    if (accountIds.length > 0) {
      const closed = await tx.waterAccount.findFirst({
        where: {
          tenantId: ctx.tenantId,
          id: { in: accountIds },
          status: 'CLOSED',
        },
        select: { id: true },
      });
      if (closed) {
        // A reversal RAISES outstanding — on a closed account that is
        // resurrected debt no close-out path can ever settle. The
        // refund path for closed accounts is out of MVP scope; the
        // operator reverses the payment BEFORE closing instead.
        throw new ConflictException({
          code: 'PAYMENT_ACCOUNT_CLOSED',
          waterAccountId: closed.id,
        });
      }
    }
    // E6 lock order (domain §14): payment → water_accounts(sorted) →
    // settle_account → bills(sorted). The settle row is the prepayment
    // fund lock — the lot check below MUST run under it so a concurrent
    // APPLY can't consume a lot after we verified it unspent.
    await this.prepay.lockSettleAccountForUpdate(tx, ctx, original.settleAccountId);
    for (const t of topUpLegs) {
      const remaining = await this.prepay.lotRemainingTx(tx, ctx, t.id);
      if (remaining < BigInt(t.amount)) {
        throw new ConflictException({
          code: 'PREPAYMENT_ALREADY_APPLIED',
          topUpEntryId: t.id,
        });
      }
    }
    for (const billId of billIds) {
      await lockBillForUpdate(tx, ctx, billId);
    }

    const paymentNo = await this.seq.nextFormatted(
      tx,
      ctx.tenantId,
      'payment_no',
      'P',
      ctx.staffId,
    );
    const reversal = await tx.payment.create({
      data: {
        tenantId: ctx.tenantId,
        paymentNo,
        settleAccountId: original.settleAccountId,
        // Original's drawer, not the actor's (see docblock).
        cashierId: original.cashierId,
        orgUnitId: original.orgUnitId,
        channel: original.channel,
        amount: -original.amount,
        status: 'RECEIVED', // enters the NEXT close as a negative line
        reversalOfId: id,
        createdBy: ctx.staffId,
        updatedBy: ctx.staffId,
      },
      select: PAYMENT_SELECT,
    });
    if (origAllocs.length > 0) {
      await tx.paymentAlloc.createMany({
        data: origAllocs.map((a) => ({
          tenantId: ctx.tenantId,
          paymentId: reversal.id,
          billId: a.billId,
          amount: -a.amount,
          createdBy: ctx.staffId,
          updatedBy: ctx.staffId,
        })),
      });
    }
    // E6: the TOP_UP leg reverses through the ledger — an append-only
    // REVERSAL(-topUp.amount) chained via reversal_of_entry_id; the
    // TOP_UP row itself is never touched.
    await this.prepay.reverseTopUpsForPaymentTx(
      tx,
      ctx,
      { id: original.id, settleAccountId: original.settleAccountId },
      reversal.id,
    );
    // The original's receipt is void — a re-print must fail.
    await tx.receipt.updateMany({
      where: { tenantId: ctx.tenantId, paymentId: id, voidFlag: false },
      data: { voidFlag: true, updatedBy: ctx.staffId },
    });

    // Bills recover outstanding: Σ allocs after the negative mirrors.
    // A bill red-flushed meanwhile (REVERSED) keeps its status — the
    // mirror allocs still land so the money trail stays complete, and
    // the getOutstanding port turns the residue into a customer credit.
    for (const billId of billIds) {
      const bill = await tx.bill.findFirst({
        where: { tenantId: ctx.tenantId, id: billId },
        select: { id: true, status: true, totalAmount: true },
      });
      if (!bill || !RECOMPUTE_STATUSES.includes(bill.status)) continue;
      const paid = (await this.appliedByBill(tx, ctx, [billId])).get(billId) ?? 0n;
      const next: BillStatus =
        paid <= 0n ? 'POSTED' : paid >= bill.totalAmount ? 'PAID' : 'PARTIAL_PAID';
      await tx.bill.updateMany({
        where: {
          tenantId: ctx.tenantId,
          id: billId,
          status: { in: RECOMPUTE_STATUSES },
        },
        data: { status: next, updatedBy: ctx.staffId },
      });
    }
    return this.withDetail(tx, ctx, reversal);
  }

  /**
   * POST /receipts/:id/print — sets printed_at. A re-print is allowed
   * (it updates printed_at — a document reprint, not a financial fact);
   * a voided receipt can never print again (409 RECEIPT_VOID).
   */
  async printTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    id: string,
    req: Request,
  ) {
    const receipt = await tx.receipt.findFirst({
      where: { tenantId: ctx.tenantId, id },
      select: RECEIPT_SELECT,
    });
    if (!receipt) throw new NotFoundException({ code: 'RECEIPT_NOT_FOUND' });
    if (receipt.voidFlag) throw new ConflictException({ code: 'RECEIPT_VOID' });
    req.auditBefore = receipt;
    // receipt has no (tenant,id) unique — the tenant-scoped findFirst +
    // RLS are the ownership check; the update keys on the PK.
    return tx.receipt.update({
      where: { id: receipt.id },
      data: { printedAt: new Date(), updatedBy: ctx.staffId },
      select: RECEIPT_SELECT,
    });
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /** payment + allocs + receipt (null when none was issued). */
  private async withDetail<T extends { id: string }>(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    payment: T,
  ) {
    const allocs = await tx.paymentAlloc.findMany({
      where: { tenantId: ctx.tenantId, paymentId: payment.id },
      select: PAYMENT_ALLOC_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const receipt = await tx.receipt.findFirst({
      where: { tenantId: ctx.tenantId, paymentId: payment.id },
      select: RECEIPT_SELECT,
    });
    // E6: the payment's ledger legs (TOP_UP on a top-up payment, REFUND
    // on a money-out, REVERSAL on a payment reversal) — the receipt
    // explanation needs debtCollection + topUp attribution.
    const prepaymentEntries = await this.prepay.ledgerOfPaymentTx(
      tx,
      ctx,
      payment.id,
      ['TOP_UP', 'REFUND', 'REVERSAL'],
    );
    return { ...payment, allocs, receipt, prepaymentEntries };
  }

  /** Σ payment_alloc.amount per bill (reversal allocs net negative). */
  private async appliedByBill(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    billIds: string[],
  ): Promise<Map<string, bigint>> {
    if (billIds.length === 0) return new Map();
    const rows = await tx.paymentAlloc.groupBy({
      by: ['billId'],
      where: { tenantId: ctx.tenantId, billId: { in: billIds } },
      _sum: { amount: true },
    });
    return new Map(rows.map((r) => [r.billId, r._sum.amount ?? 0n]));
  }

  /**
   * Org guard for payment writes on a settle_account — the
   * settleAccount → waterAccounts → plan-items → plans → books chain.
   * A payment is a write on every bound book's account, so EVERY
   * covering book's org must be in the caller's subtree (same rule as
   * ReconciliationService.assertAccountScope: all bindings, any period).
   * A settle account whose water accounts are bound to no reading plan
   * has no org anchor and returns permissively (the established MVP
   * carve-out for off-book accounts).
   */
  private async assertSettleScope(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    settleAccountId: string,
  ) {
    const accounts = await tx.waterAccount.findMany({
      where: { tenantId: ctx.tenantId, settleAccountId },
      select: { id: true },
    });
    if (accounts.length === 0) return;
    const items = await tx.readingPlanItem.findMany({
      where: {
        tenantId: ctx.tenantId,
        waterAccountId: { in: accounts.map((a) => a.id) },
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
