import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { FinancePort } from '../customer/ports/finance.port.js';

/**
 * Real FinancePort implementation (replaces StubFinancePort): the
 * outstanding balance of a water account is the NET posted debt on its
 * settle_account — Σ bill.total_amount over bills with status
 * POSTED | PARTIAL_PAID and billKind != REVERSAL.
 *
 * Why the kind filter: a reversal pair must net to zero. The REVERSED
 * original drops out by status; counting the POSTED reversal row's
 * negative total would leave a phantom credit. A REPLACEMENT bill stays
 * in (it is the live debt) while its REVERSED original drops out — the
 * pair correctly contributes only the replacement amount. ADJUSTMENT
 * bills count naturally (T11 territory).
 *
 * MVP caveats, both resolved by T12 payment_alloc:
 *  - PARTIAL_PAID counts its FULL total — no allocations exist yet to
 *    subtract, so outstanding is overstated rather than under-reported
 *    (blocks a close that might still owe, never waves one through).
 *  - The sum can go negative (net credit, e.g. an un-refunded
 *    over-payment): the raw value is returned, and close-account
 *    rejects any non-zero balance — a credit is still unsettled money
 *    owed to the customer.
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

  getOutstanding(
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
      const agg = await t.bill.aggregate({
        _sum: { totalAmount: true },
        where: {
          tenantId,
          settleAccountId: account.settleAccountId,
          status: { in: ['POSTED', 'PARTIAL_PAID'] },
          billKind: { not: 'REVERSAL' },
        },
      });
      return agg._sum.totalAmount ?? 0n;
    };
    return tx ? run(tx) : this.prisma.runAsTenant(tenantId, run);
  }
}
