import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import type { TenantCtx } from '../../../common/tenant-context.js';
import { FinancePort } from '../ports/finance.port.js';
import { WaterAccountService, type EventBody } from '../water-account.service.js';

/**
 * 销户编排 (application layer): the customer domain must not import billing
 * (dependency direction iam ← customer ← … ← billing), so the outstanding
 * balance check goes through FinancePort — BillingFinancePort (T10) sums the
 * settle account's POSTED-side bills.
 *
 * The domain only executes an already-verified close: outstanding ≠ 0 → 409
 * (a negative balance is a credit owed to the customer — it must be refunded
 * first, not written off), otherwise WaterAccountService.closeTx performs the
 * guarded transition and writes the CLOSE account_event. Runs inside the
 * caller's tenant tx so the check + transition + event commit atomically.
 */
@Injectable()
export class CloseAccountUseCase {
  constructor(
    private readonly finance: FinancePort,
    private readonly accounts: WaterAccountService,
  ) {}

  async execute(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    accountId: string,
    body: EventBody,
    req: Request,
  ) {
    // Read inside this tx: the balance check and the guarded CLOSED flip
    // commit under one consistent view of the account's bills.
    const outstanding = await this.finance.getOutstanding(ctx.tenantId, accountId, tx);
    // Non-zero blocks close in both directions: a credit balance means the
    // tenant owes the customer money that must be refunded first.
    if (outstanding !== 0n) {
      throw new ConflictException({
        code: 'ACCOUNT_OUTSTANDING_BALANCE',
        outstanding: outstanding.toString(),
      });
    }
    return this.accounts.closeTx(tx, ctx, accountId, body, req);
  }
}
