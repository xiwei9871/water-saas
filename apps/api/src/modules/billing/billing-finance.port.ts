import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { FinancePort } from '../customer/ports/finance.port.js';

/**
 * Real FinancePort implementation (replaces StubFinancePort): the
 * outstanding balance of a water account is the NET posted-side debt on
 * its settle_account — Σ (bill.total_amount − Σ payment_alloc.amount)
 * over the live bill set, plus the credit a paid-then-reversed bill
 * leaves behind.
 *
 * Bill set for the gross term: status DRAFT | POSTED | PARTIAL_PAID and
 * billKind != REVERSAL.
 *
 * Why DRAFT counts: a DRAFT bill is computed debt in flight — excluding
 * it would let close-account slip past a bill that posts a moment later
 * (the close-vs-post race is also serialized by the water_account row
 * lock both sides take). Overstating is always the safe direction here:
 * a blocked close is an operator retry, a leaked close is orphan debt.
 *
 * Why the kind filter: a reversal pair must net to zero. The REVERSED
 * original drops out by status; counting the POSTED reversal row's
 * negative total would leave a phantom credit. A REPLACEMENT bill stays
 * in (it is the live debt) while its REVERSED original drops out — the
 * pair correctly contributes only the replacement amount. ADJUSTMENT
 * bills count naturally (T11 territory).
 *
 * The alloc term (T12): payment_alloc rows are the money applied against
 * a bill — subtracting them turns a PARTIAL_PAID bill into its remaining
 * balance and a fully-paid PAID bill into zero (it drops out of the
 * gross set anyway). Reversal payments write NEGATIVE allocs, so the
 * subtraction nets automatically: pay 60 then reverse → 60 − 60 = 0.
 *
 * The alloc term covers one MORE status than the gross term — REVERSED:
 * when a PARTIAL_PAID/POSTED bill is red-flushed AFTER money was applied,
 * its gross contribution disappears by status while its allocs survive
 * (payment_alloc is append-only). Keeping them in the subtraction makes
 * the bill contribute −paidAmount — the customer prepaid on a voided
 * debt, which is a real credit owed back and must block the close until
 * the payment itself is reversed (the refund path). This is the T12
 * resolution of the T10 "PARTIAL_PAID reversal orphans payment_alloc"
 * note: the orphan becomes a blocking credit, never a silent write-off.
 * A PAID bill never hits this case (PAID is not bill-reversable —
 * refund the payment first, which returns it to POSTED/PARTIAL_PAID).
 *
 * The sum can go negative (net credit, e.g. an un-refunded payment or
 * the reversed-bill case above): the raw value is returned, and
 * close-account rejects any non-zero balance — a credit is still
 * unsettled money owed to the customer.
 *
 * The optional `tx` parameter lets the close orchestration run the sum
 * inside its own tenant transaction (one consistent read against the
 * guarded CLOSED flip); standalone callers get a fresh runAsTenant tx.
 */
@Injectable()
export class BillingFinancePort extends FinancePort {
  constructor(private readonly prisma: TenantPrismaService) {
    super();
  }

  async getOutstanding(
    tenantId: string,
    waterAccountId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<bigint> {
    const run = async (t: Prisma.TransactionClient) => {
      const account = await t.waterAccount.findFirst({
        where: { tenantId, id: waterAccountId },
        select: { settleAccountId: true },
      });
      if (!account) return 0n;
      const gross = await t.bill.aggregate({
        _sum: { totalAmount: true },
        where: {
          tenantId,
          settleAccountId: account.settleAccountId,
          status: { in: ['DRAFT', 'POSTED', 'PARTIAL_PAID'] },
          billKind: { not: 'REVERSAL' },
        },
      });
      // See the class docblock: the alloc term spans the gross statuses
      // PLUS REVERSED so a reversed bill's surviving allocs become a
      // customer credit instead of vanishing. Reversal payments carry
      // negative allocs, so refunded money nets out by itself.
      const applied = await t.paymentAlloc.aggregate({
        _sum: { amount: true },
        where: {
          tenantId,
          bill: {
            tenantId,
            settleAccountId: account.settleAccountId,
            status: { in: ['DRAFT', 'POSTED', 'PARTIAL_PAID', 'REVERSED'] },
            billKind: { not: 'REVERSAL' },
          },
        },
      });
      return (gross._sum.totalAmount ?? 0n) - (applied._sum.amount ?? 0n);
    };
    return tx ? run(tx) : this.prisma.runAsTenant(tenantId, run);
  }
}
