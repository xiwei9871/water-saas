import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SequenceService } from '../../common/sequence.service.js';
import { orgInScope, type TenantCtx } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';

const RECOMPUTE_STATUSES: ('POSTED' | 'PARTIAL_PAID')[] = [
  'POSTED',
  'PARTIAL_PAID',
];
const PAY_CHANNELS = new Set(['CASH', 'POS', 'TRANSFER']);

const PAYMENT_SELECT = {
  id: true,
  paymentNo: true,
  settleAccountId: true,
  cashierId: true,
  orgUnitId: true,
  dayCloseId: true,
  reversalOfId: true,
  channel: true,
  amount: true,
  status: true,
  receivedAt: true,
  createdAt: true,
} as const;

interface LedgerRow {
  id: string;
  settle_account_id: string;
  type: 'TOP_UP' | 'APPLY' | 'REFUND' | 'REVERSAL';
  amount: bigint;
  payment_id: string | null;
  bill_id: string | null;
  origin_top_up_id: string | null;
  reversal_of_entry_id: string | null;
  idempotency_key: string;
  operator_id: string | null;
  reason: string | null;
  created_at: Date;
  created_by: string;
}

interface DebtRow {
  id: string;
  total: bigint;
  outstanding: bigint;
}

const mapEntry = (r: LedgerRow) => ({
  id: r.id,
  settleAccountId: r.settle_account_id,
  type: r.type,
  amount: r.amount.toString(),
  paymentId: r.payment_id,
  billId: r.bill_id,
  originTopUpId: r.origin_top_up_id,
  reversalOfEntryId: r.reversal_of_entry_id,
  idempotencyKey: r.idempotency_key,
  operatorId: r.operator_id,
  reason: r.reason,
  createdAt: r.created_at,
  createdBy: r.created_by,
});

const mapPayment = (p: {
  id: string;
  paymentNo: string;
  settleAccountId: string;
  cashierId: string;
  orgUnitId: string | null;
  dayCloseId: string | null;
  reversalOfId: string | null;
  channel: string;
  amount: bigint;
  status: string;
  receivedAt: Date;
  createdAt: Date;
}) => ({
  id: p.id,
  paymentNo: p.paymentNo,
  settleAccountId: p.settleAccountId,
  cashierId: p.cashierId,
  orgUnitId: p.orgUnitId,
  dayCloseId: p.dayCloseId,
  reversalOfId: p.reversalOfId,
  channel: p.channel,
  amount: p.amount.toString(),
  status: p.status,
  receivedAt: p.receivedAt,
  createdAt: p.createdAt,
});

/**
 * Prepayment domain core (E6 domain design §3–§14). SettleAccount is the
 * sole money subject; the ledger is the only balance source — balance is
 * ALWAYS Σ ledger, never cached. All money mutations funnel through the
 * `…Tx` methods so billing/payment callers stay inside their own
 * transactions with the frozen lock order
 * (water_account → settle_account → tariff_plan → bills(sorted) → ledger).
 */
@Injectable()
export class PrepaymentService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly seq: SequenceService,
  ) {}

  // -----------------------------------------------------------------------
  // primitives
  // -----------------------------------------------------------------------

  /**
   * FOR UPDATE on the settle_account row — the prepayment-fund lock.
   * Callers that already hold the water_account lock MUST take this next
   * (never before it): the only legal direction is water → settle.
   */
  async lockSettleAccountForUpdate(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    settleAccountId: string,
  ): Promise<void> {
    await tx.$queryRaw`
      SELECT id FROM settle_account
      WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${settleAccountId}::uuid
      FOR UPDATE`;
  }

  /** Σ ledger — the ONLY balance source (domain §5). */
  async balanceTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    settleAccountId: string,
  ): Promise<bigint> {
    const rows = await tx.$queryRaw<{ balance: bigint | null }[]>`
      SELECT SUM(amount)::bigint AS balance
      FROM prepayment_ledger_entry
      WHERE tenant_id = ${ctx.tenantId}::uuid
        AND settle_account_id = ${settleAccountId}::uuid`;
    return rows[0]?.balance ?? 0n;
  }

  /**
   * TOP_UP lots in FIFO order (createdAt ASC → id ASC, domain §5) with
   * remaining = TOP_UP.amount + Σ(origin entries) — a single-level
   * aggregate because every lot-affecting entry carries origin_top_up_id.
   */
  async lotsTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    settleAccountId: string,
  ): Promise<{ id: string; amount: bigint; remaining: bigint; createdAt: Date }[]> {
    const rows = await tx.$queryRaw<
      { id: string; amount: bigint; remaining: bigint; created_at: Date }[]
    >`
      SELECT e.id, e.amount::bigint AS amount,
             (e.amount + COALESCE(SUM(c.amount), 0))::bigint AS remaining,
             e.created_at
      FROM prepayment_ledger_entry e
      LEFT JOIN prepayment_ledger_entry c
        ON c.tenant_id = e.tenant_id AND c.origin_top_up_id = e.id
      WHERE e.tenant_id = ${ctx.tenantId}::uuid
        AND e.settle_account_id = ${settleAccountId}::uuid
        AND e.type = 'TOP_UP'
      GROUP BY e.id
      ORDER BY e.created_at ASC, e.id ASC`;
    return rows.map((r) => ({ ...r, createdAt: r.created_at }));
  }

  /** remaining of one TOP_UP lot (TOP_UP.amount + Σ origin entries). */
  async lotRemainingTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    topUpId: string,
  ): Promise<bigint> {
    const rows = await tx.$queryRaw<{ remaining: bigint | null }[]>`
      SELECT (e.amount + COALESCE(SUM(c.amount), 0))::bigint AS remaining
      FROM prepayment_ledger_entry e
      LEFT JOIN prepayment_ledger_entry c
        ON c.tenant_id = e.tenant_id AND c.origin_top_up_id = e.id
      WHERE e.tenant_id = ${ctx.tenantId}::uuid AND e.id = ${topUpId}::uuid
      GROUP BY e.id`;
    return rows[0]?.remaining ?? 0n;
  }

  /**
   * Payable debt of a settle account in the frozen comparator order
   * (domain §8a): effectiveDueKey = dueDate ?? period-month-end ASC →
   * period ASC → issuedAt NULLS LAST → id ASC. Outstanding is computed
   * per bill from ALL allocation sources (Σ is source-agnostic).
   */
  async debtQueueTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    settleAccountId: string,
  ): Promise<DebtRow[]> {
    return tx.$queryRaw<DebtRow[]>`
      SELECT b.id, b.total_amount::bigint AS total,
             b.total_amount - COALESCE(SUM(a.amount), 0) AS outstanding
      FROM bill b
      LEFT JOIN payment_alloc a
        ON a.tenant_id = b.tenant_id AND a.bill_id = b.id
      WHERE b.tenant_id = ${ctx.tenantId}::uuid
        AND b.settle_account_id = ${settleAccountId}::uuid
        AND b.bill_kind <> 'REVERSAL'
        AND b.status IN ('POSTED', 'PARTIAL_PAID')
      GROUP BY b.id
      HAVING b.total_amount - COALESCE(SUM(a.amount), 0) > 0
      ORDER BY COALESCE(b.due_date,
                        (b.period || '01')::date + interval '1 month' - interval '1 day') ASC,
               b.period ASC, b.issued_at ASC NULLS LAST, b.id ASC`;
  }

  /**
   * Idempotent ledger insert (domain §12): ON CONFLICT DO NOTHING
   * RETURNING, never catch-unique-then-SELECT inside the aborted tx.
   * Returns the entry id (existing row's id on a replayed key).
   */
  async insertLedgerTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    data: {
      settleAccountId: string;
      type: 'TOP_UP' | 'APPLY' | 'REFUND' | 'REVERSAL';
      amount: bigint;
      paymentId?: string | null;
      billId?: string | null;
      originTopUpId?: string | null;
      reversalOfEntryId?: string | null;
      idempotencyKey: string;
      reason?: string | null;
      // Audit identity: undefined → acting staff; explicit null → SYSTEM
      // (automatic APPLY is a system money move, not an operator's).
      operatorId?: string | null;
    },
  ): Promise<{ id: string; replayed: boolean }> {
    const operatorId = data.operatorId === undefined ? ctx.staffId : data.operatorId;
    const ins = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO prepayment_ledger_entry
        (id, tenant_id, settle_account_id, type, amount, payment_id, bill_id,
         origin_top_up_id, reversal_of_entry_id, idempotency_key,
         operator_id, reason, created_by)
      VALUES (gen_random_uuid(), ${ctx.tenantId}::uuid,
              ${data.settleAccountId}::uuid, ${data.type}::"PrepaymentEntryType",
              ${data.amount}, ${data.paymentId ?? null}::uuid,
              ${data.billId ?? null}::uuid, ${data.originTopUpId ?? null}::uuid,
              ${data.reversalOfEntryId ?? null}::uuid, ${data.idempotencyKey},
              ${operatorId}::uuid, ${data.reason ?? null}, ${ctx.staffId}::uuid)
      ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
      RETURNING id`;
    if (ins.length) return { id: ins[0].id, replayed: false };
    const existing = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM prepayment_ledger_entry
      WHERE tenant_id = ${ctx.tenantId}::uuid
        AND idempotency_key = ${data.idempotencyKey}`;
    return { id: existing[0].id, replayed: true };
  }

  /** ledger entries created by a Payment (TOP_UP / REFUND legs). */
  async ledgerOfPaymentTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    paymentId: string,
    types: ('TOP_UP' | 'APPLY' | 'REFUND' | 'REVERSAL')[],
  ): Promise<ReturnType<typeof mapEntry>[]> {
    const rows = await tx.$queryRaw<LedgerRow[]>`
      SELECT * FROM prepayment_ledger_entry
      WHERE tenant_id = ${ctx.tenantId}::uuid
        AND payment_id = ${paymentId}::uuid
        AND type = ANY(${types}::"PrepaymentEntryType"[])
      ORDER BY created_at ASC, id ASC`;
    return rows.map(mapEntry);
  }

  /** true when the bill carries any PREPAYMENT-source allocation. */
  async hasPrepaymentAllocsTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    billId: string,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*)::bigint AS n FROM payment_alloc
      WHERE tenant_id = ${ctx.tenantId}::uuid
        AND bill_id = ${billId}::uuid AND source = 'PREPAYMENT'`;
    return (rows[0]?.n ?? 0n) > 0n;
  }

  // -----------------------------------------------------------------------
  // domain operations
  // -----------------------------------------------------------------------

  /**
   * APPLY available prepayment to the settle account's payable debt
   * (domain §9). Called inside the tx that produced a new payable POSTED
   * debt — BillingRunService.postOneBill, BillService.replaceTx and the
   * positive reconciliation ADJUSTMENT. The caller must already hold the
   * water_account lock; this takes the settle lock then bill locks
   * (sorted ids), then writes APPLY entries + PREPAYMENT allocations.
   */
  async applyForPostedDebtTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    settleAccountId: string,
  ): Promise<{ appliedCent: bigint; entries: number }> {
    await this.lockSettleAccountForUpdate(tx, ctx, settleAccountId);
    const balance = await this.balanceTx(tx, ctx, settleAccountId);
    if (balance <= 0n) return { appliedCent: 0n, entries: 0 };

    const queue = await this.debtQueueTx(tx, ctx, settleAccountId);
    if (!queue.length) return { appliedCent: 0n, entries: 0 };

    // Lock every candidate bill in sorted-id order BEFORE re-reading
    // their paid sums — a concurrent payment/apply on the same settle
    // serializes on these rows, never on the comparator order.
    const ids = queue.map((b) => b.id).sort();
    await tx.$queryRaw`
      SELECT id FROM bill
      WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ANY(${ids}::uuid[])
      ORDER BY id FOR UPDATE`;

    const paidRows = await tx.paymentAlloc.groupBy({
      by: ['billId'],
      where: { tenantId: ctx.tenantId, billId: { in: ids } },
      _sum: { amount: true },
    });
    const paidByBill = new Map(paidRows.map((r) => [r.billId, r._sum.amount ?? 0n]));

    const lots = await this.lotsTx(tx, ctx, settleAccountId);
    let applied = 0n;
    let entries = 0;
    const touched = new Set<string>();

    for (const bill of queue) {
      let outstanding = bill.total - (paidByBill.get(bill.id) ?? 0n);
      if (outstanding <= 0n) continue;
      for (const lot of lots) {
        if (outstanding <= 0n) break;
        if (lot.remaining <= 0n) continue;
        const take = lot.remaining < outstanding ? lot.remaining : outstanding;
        const entry = await this.insertLedgerTx(tx, ctx, {
          settleAccountId,
          type: 'APPLY',
          amount: -take,
          billId: bill.id,
          originTopUpId: lot.id,
          idempotencyKey: `apply:${bill.id}:${lot.id}`,
          operatorId: null,
        });
        // A replayed apply key means the alloc already exists — the
        // UNIQUE(tenant, prepayment_entry_id) constraint enforces the
        // 1:1 alloc↔settlement-entry relation (domain §7).
        await tx.$queryRaw`
          INSERT INTO payment_alloc
            (id, tenant_id, source, payment_id, prepayment_entry_id,
             bill_id, amount, created_at, updated_at, created_by, updated_by)
          VALUES (gen_random_uuid(), ${ctx.tenantId}::uuid, 'PREPAYMENT',
                  NULL, ${entry.id}::uuid, ${bill.id}::uuid, ${take},
                  now(), now(), ${ctx.staffId}::uuid, ${ctx.staffId}::uuid)
          ON CONFLICT (tenant_id, prepayment_entry_id) DO NOTHING`;
        outstanding -= take;
        lot.remaining -= take;
        applied += take;
        entries += 1;
      }
      touched.add(bill.id);
    }

    for (const billId of touched) {
      await this.recomputeBillStatusTx(tx, ctx, billId);
    }
    return { appliedCent: applied, entries };
  }

  /**
   * Bill red-flush prepayment leg (domain §10/§20): for every APPLY on
   * the original bill append REVERSAL(+restore) + a mirror PREPAYMENT
   * allocation(-restore). Original APPLY entries are never touched;
   * the restored amount lands back on the funding lot via
   * origin_top_up_id. Idempotent via `reverse:{applyEntryId}`.
   */
  async reverseAppliedForBillTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    billId: string,
    reason: string,
  ): Promise<{ restoredCent: bigint }> {
    const applies = await tx.$queryRaw<LedgerRow[]>`
      SELECT * FROM prepayment_ledger_entry
      WHERE tenant_id = ${ctx.tenantId}::uuid
        AND bill_id = ${billId}::uuid AND type = 'APPLY'
      ORDER BY created_at ASC, id ASC`;
    let restored = 0n;
    for (const apply of applies) {
      const revRows = await tx.$queryRaw<{ total: bigint | null }[]>`
        SELECT SUM(amount)::bigint AS total FROM prepayment_ledger_entry
        WHERE tenant_id = ${ctx.tenantId}::uuid
          AND reversal_of_entry_id = ${apply.id}::uuid`;
      // apply.amount is negative; -apply.amount is the consumable sum.
      const restore = -apply.amount - (revRows[0]?.total ?? 0n);
      if (restore <= 0n) continue;
      const entry = await this.insertLedgerTx(tx, ctx, {
        settleAccountId: apply.settle_account_id,
        type: 'REVERSAL',
        amount: restore,
        billId,
        originTopUpId: apply.origin_top_up_id,
        reversalOfEntryId: apply.id,
        idempotencyKey: `reverse:${apply.id}`,
        reason,
      });
      await tx.$queryRaw`
        INSERT INTO payment_alloc
          (id, tenant_id, source, payment_id, prepayment_entry_id,
           bill_id, amount, created_at, updated_at, created_by, updated_by)
        VALUES (gen_random_uuid(), ${ctx.tenantId}::uuid, 'PREPAYMENT',
                NULL, ${entry.id}::uuid, ${billId}::uuid, ${-restore},
                now(), now(), ${ctx.staffId}::uuid, ${ctx.staffId}::uuid)
        ON CONFLICT (tenant_id, prepayment_entry_id) DO NOTHING`;
      restored += restore;
    }
    return { restoredCent: restored };
  }

  /**
   * TOP_UP (domain §8): one counter payment whose funds clear existing
   * debt FIRST (comparator order) then park the remainder as a TOP_UP
   * lot. Always one Payment + one Receipt + one cash event; the split
   * is computed in memory under the settle lock, not by insert order.
   */
  async topUpTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    body: { settleAccountId: string; channel: string; amount: bigint },
  ) {
    if (!PAY_CHANNELS.has(body.channel)) {
      throw new BadRequestException({ code: 'PAY_CHANNEL_INVALID' });
    }
    const settle = await tx.settleAccount.findFirst({
      where: { id: body.settleAccountId, tenantId: ctx.tenantId },
      select: { id: true },
    });
    if (!settle) {
      throw new NotFoundException({
        code: 'SETTLE_ACCOUNT_NOT_FOUND',
        id: body.settleAccountId,
      });
    }
    await this.assertSettleScope(tx, ctx, body.settleAccountId);
    await this.lockSettleAccountForUpdate(tx, ctx, body.settleAccountId);

    // Debt split: comparator-ordered payable bills, allocated in memory.
    const queue = await this.debtQueueTx(tx, ctx, body.settleAccountId);
    const ids = queue.map((b) => b.id).sort();
    if (ids.length) {
      await tx.$queryRaw`
        SELECT id FROM bill
        WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ANY(${ids}::uuid[])
        ORDER BY id FOR UPDATE`;
    }
    const paidRows = ids.length
      ? await tx.paymentAlloc.groupBy({
          by: ['billId'],
          where: { tenantId: ctx.tenantId, billId: { in: ids } },
          _sum: { amount: true },
        })
      : [];
    const paidByBill = new Map(paidRows.map((r) => [r.billId, r._sum.amount ?? 0n]));

    let remaining = body.amount;
    const allocs: { billId: string; amount: bigint }[] = [];
    for (const bill of queue) {
      if (remaining <= 0n) break;
      const outstanding = bill.total - (paidByBill.get(bill.id) ?? 0n);
      if (outstanding <= 0n) continue;
      const take = outstanding < remaining ? outstanding : remaining;
      allocs.push({ billId: bill.id, amount: take });
      remaining -= take;
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
        channel: body.channel as 'CASH' | 'POS' | 'TRANSFER',
        amount: body.amount,
        status: 'RECEIVED',
        createdBy: ctx.staffId,
        updatedBy: ctx.staffId,
      },
      select: PAYMENT_SELECT,
    });

    const billAllocs: { billId: string; amount: string }[] = [];
    for (const a of allocs) {
      await tx.paymentAlloc.create({
        data: {
          tenantId: ctx.tenantId,
          paymentId: payment.id,
          billId: a.billId,
          amount: a.amount,
          createdBy: ctx.staffId,
          updatedBy: ctx.staffId,
        },
      });
      billAllocs.push({ billId: a.billId, amount: a.amount.toString() });
    }

    let topUpEntryId: string | null = null;
    if (remaining > 0n) {
      const entry = await this.insertLedgerTx(tx, ctx, {
        settleAccountId: body.settleAccountId,
        type: 'TOP_UP',
        amount: remaining,
        paymentId: payment.id,
        idempotencyKey: `topup:${payment.id}`,
      });
      topUpEntryId = entry.id;
    }

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
        receiptNo,
        paymentId: payment.id,
        createdBy: ctx.staffId,
        updatedBy: ctx.staffId,
      },
      select: { id: true, receiptNo: true, printedAt: true },
    });

    for (const a of allocs) {
      await this.recomputeBillStatusTx(tx, ctx, a.billId);
    }

    return {
      payment: mapPayment(payment),
      receipt,
      billAllocs,
      topUp: remaining.toString(),
      topUpEntryId,
      balance: (await this.balanceTx(tx, ctx, body.settleAccountId)).toString(),
    };
  }

  /**
   * REFUND (domain §11): real money out — a negative Payment in the
   * refunding cashier's drawer plus per-lot REFUND entries split FIFO.
   * Never exceeds the current balance; balance can never go negative.
   */
  async refundTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    body: { settleAccountId: string; channel: string; amount: bigint; reason: string },
  ) {
    if (!PAY_CHANNELS.has(body.channel)) {
      throw new BadRequestException({ code: 'PAY_CHANNEL_INVALID' });
    }
    if (!body.reason?.trim()) {
      throw new BadRequestException({ code: 'REFUND_REASON_REQUIRED' });
    }
    const settle = await tx.settleAccount.findFirst({
      where: { id: body.settleAccountId, tenantId: ctx.tenantId },
      select: { id: true },
    });
    if (!settle) {
      throw new NotFoundException({
        code: 'SETTLE_ACCOUNT_NOT_FOUND',
        id: body.settleAccountId,
      });
    }
    await this.assertSettleScope(tx, ctx, body.settleAccountId);
    await this.lockSettleAccountForUpdate(tx, ctx, body.settleAccountId);

    const balance = await this.balanceTx(tx, ctx, body.settleAccountId);
    if (body.amount > balance) {
      throw new ConflictException({
        code: 'PREPAYMENT_INSUFFICIENT_BALANCE',
        balance: balance.toString(),
        amount: body.amount.toString(),
      });
    }

    const lots = await this.lotsTx(tx, ctx, body.settleAccountId);
    let remaining = body.amount;
    const legs: { lotId: string; amount: bigint }[] = [];
    for (const lot of lots) {
      if (remaining <= 0n) break;
      if (lot.remaining <= 0n) continue;
      const take = lot.remaining < remaining ? lot.remaining : remaining;
      legs.push({ lotId: lot.id, amount: take });
      remaining -= take;
    }
    // balance ≥ amount under the settle lock ⇒ legs always cover it.

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
        channel: body.channel as 'CASH' | 'POS' | 'TRANSFER',
        amount: -body.amount,
        status: 'RECEIVED',
        createdBy: ctx.staffId,
        updatedBy: ctx.staffId,
      },
      select: PAYMENT_SELECT,
    });

    const entries: { id: string; originTopUpId: string; amount: string }[] = [];
    for (const leg of legs) {
      const entry = await this.insertLedgerTx(tx, ctx, {
        settleAccountId: body.settleAccountId,
        type: 'REFUND',
        amount: -leg.amount,
        paymentId: payment.id,
        originTopUpId: leg.lotId,
        idempotencyKey: `refund:${payment.id}:${leg.lotId}`,
        reason: body.reason,
      });
      entries.push({
        id: entry.id,
        originTopUpId: leg.lotId,
        amount: (-leg.amount).toString(),
      });
    }

    return {
      payment: mapPayment(payment),
      entries,
      balance: (await this.balanceTx(tx, ctx, body.settleAccountId)).toString(),
    };
  }

  /**
   * Payment-reversal prepayment leg (domain §10): the TOP_UP funded by
   * the original payment is reversed by an append-only REVERSAL
   * (-topUp.amount) chained through reversal_of_entry_id — the TOP_UP
   * row itself is never touched.
   */
  async reverseTopUpsForPaymentTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    original: { id: string; settleAccountId: string },
    reversalPaymentId: string,
  ): Promise<void> {
    const topUps = await this.ledgerOfPaymentTx(tx, ctx, original.id, ['TOP_UP']);
    for (const t of topUps) {
      await this.insertLedgerTx(tx, ctx, {
        settleAccountId: original.settleAccountId,
        type: 'REVERSAL',
        amount: -BigInt(t.amount),
        paymentId: reversalPaymentId,
        originTopUpId: t.id,
        reversalOfEntryId: t.id,
        idempotencyKey: `reverse:${t.id}`,
        reason: 'payment reversal',
      });
    }
  }

  // -----------------------------------------------------------------------
  // read side
  // -----------------------------------------------------------------------

  async balance(ctx: TenantCtx, settleAccountId: string) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const settle = await tx.settleAccount.findFirst({
        where: { id: settleAccountId, tenantId: ctx.tenantId },
        select: { id: true, settleNo: true, name: true },
      });
      if (!settle) {
        throw new NotFoundException({
          code: 'SETTLE_ACCOUNT_NOT_FOUND',
          id: settleAccountId,
        });
      }
      // Read-side org scope — same gate as the write path; an
      // ORG_SUBTREE/SELF cashier must not read another branch's funds.
      await this.assertSettleScope(tx, ctx, settleAccountId);
      const lots = await this.lotsTx(tx, ctx, settleAccountId);
      return {
        settleAccount: settle,
        balance: lots.reduce((s, l) => s + l.remaining, 0n).toString(),
        lots: lots.map((l) => ({
          topUpEntryId: l.id,
          amount: l.amount.toString(),
          remaining: l.remaining.toString(),
          createdAt: l.createdAt,
        })),
      };
    });
  }

  async entries(
    ctx: TenantCtx,
    args: { settleAccountId?: string; take: number; skip: number; type?: string },
  ) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      if (args.settleAccountId) {
        await this.assertSettleScope(tx, ctx, args.settleAccountId);
      }
      // Unfiltered reads: ALL sees the tenant; ORG_SUBTREE/SELF only see
      // settle accounts whose covering books are ALL inside orgScope —
      // the same coverage rule as assertSettleScope (out-of-scope
      // covering book ⇒ the whole settle account is hidden). The
      // off-book carve-out is preserved: no covering book ⇒ visible.
      const scopeFilter =
        ctx.scope === 'ALL'
          ? Prisma.empty
          : Prisma.sql`AND NOT EXISTS (
              SELECT 1 FROM water_account wa
              JOIN reading_plan_item rpi
                ON rpi.tenant_id = wa.tenant_id
               AND rpi.water_account_id = wa.id
              JOIN reading_plan rp
                ON rp.tenant_id = wa.tenant_id AND rp.id = rpi.plan_id
              JOIN reading_book rb
                ON rb.tenant_id = wa.tenant_id AND rb.id = rp.book_id
              WHERE wa.tenant_id = prepayment_ledger_entry.tenant_id
                AND wa.settle_account_id = prepayment_ledger_entry.settle_account_id
                AND rb.org_unit_id <> ALL(${ctx.orgScope}::uuid[])
            )`;
      const rows = await tx.$queryRaw<LedgerRow[]>`
        SELECT * FROM prepayment_ledger_entry
        WHERE tenant_id = ${ctx.tenantId}::uuid
          AND (${args.settleAccountId ?? null}::uuid IS NULL
               OR settle_account_id = ${args.settleAccountId ?? null}::uuid)
          AND (${args.type ?? null}::"PrepaymentEntryType" IS NULL
               OR type = ${args.type ?? null}::"PrepaymentEntryType")
          ${scopeFilter}
        ORDER BY created_at DESC, id DESC
        LIMIT ${args.take} OFFSET ${args.skip}`;
      const count = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT COUNT(*)::bigint AS n FROM prepayment_ledger_entry
        WHERE tenant_id = ${ctx.tenantId}::uuid
          AND (${args.settleAccountId ?? null}::uuid IS NULL
               OR settle_account_id = ${args.settleAccountId ?? null}::uuid)
          AND (${args.type ?? null}::"PrepaymentEntryType" IS NULL
               OR type = ${args.type ?? null}::"PrepaymentEntryType")
          ${scopeFilter}`;
      return { total: Number(count[0]?.n ?? 0n), items: rows.map(mapEntry) };
    });
  }

  // -----------------------------------------------------------------------
  // internals
  // -----------------------------------------------------------------------

  /**
   * Same org-scope gate as PaymentService.assertSettleScope — EVERY
   * covering book's org must sit in the caller's subtree; a settle
   * account with no bound reading plan has no org anchor and returns
   * permissively (the established off-book carve-out).
   */
  private async assertSettleScope(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    settleAccountId: string,
  ): Promise<void> {
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
      if (!orgInScope(ctx, b.orgUnitId)) {
        throw new ForbiddenException({ code: 'ORG_OUT_OF_SCOPE' });
      }
    }
  }

  /**
   * Guarded status recompute — Σ allocs vs totalAmount, no bill row is
   * ever flipped from outside RECOMPUTE_STATUSES (same contract as
   * PaymentService).
   */
  private async recomputeBillStatusTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    billId: string,
  ): Promise<void> {
    const paid = await tx.paymentAlloc.aggregate({
      where: { tenantId: ctx.tenantId, billId },
      _sum: { amount: true },
    });
    const bill = await tx.bill.findFirst({
      where: { tenantId: ctx.tenantId, id: billId },
      select: { totalAmount: true, status: true },
    });
    if (!bill || !(RECOMPUTE_STATUSES as string[]).includes(bill.status)) {
      return;
    }
    const paidSum = paid._sum.amount ?? 0n;
    const next =
      paidSum >= bill.totalAmount
        ? 'PAID'
        : paidSum > 0n
          ? 'PARTIAL_PAID'
          : 'POSTED';
    if (next === bill.status) return;
    await tx.bill.updateMany({
      where: {
        tenantId: ctx.tenantId,
        id: billId,
        status: { in: RECOMPUTE_STATUSES },
      },
      data: { status: next, updatedBy: ctx.staffId },
    });
  }
}
