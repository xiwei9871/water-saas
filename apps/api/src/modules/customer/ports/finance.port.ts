import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Port out of the customer domain into billing/finance (spec §2.8): "how much
 * does this water account still owe". The module dependency direction
 * `iam ← customer ← metering ← billing` forbids customer domain code from
 * importing billing, so the close-account use case talks to this interface
 * only.
 *
 * The real implementation is BillingFinancePort in the billing module
 * (T10) — bound in CustomerModule via `useExisting`. T13 consolidates all
 * module ports under src/modules/integration.
 */
export abstract class FinancePort {
  /**
   * Outstanding amount in cents for a water account (0 = clear to close).
   * `tx` lets the caller keep the read inside its own tenant transaction;
   * implementations must run tenant-scoped either way.
   */
  abstract getOutstanding(
    tenantId: string,
    waterAccountId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<bigint>;
}

/**
 * Pre-billing stub kept for tests/scaffolding: returns the configured
 * `outstanding` (default 0n, i.e. "billing not wired yet, nothing owed").
 * The field is deliberately mutable so tests can simulate a non-zero
 * balance without billing fixtures.
 */
@Injectable()
export class StubFinancePort extends FinancePort {
  outstanding = 0n;

  getOutstanding(
    _tenantId: string,
    _waterAccountId: string,
    _tx?: Prisma.TransactionClient,
  ): Promise<bigint> {
    return Promise.resolve(this.outstanding);
  }
}
