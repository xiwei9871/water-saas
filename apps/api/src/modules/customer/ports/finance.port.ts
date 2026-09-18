import { Injectable } from '@nestjs/common';

/**
 * Port out of the customer domain into billing/finance (spec §2.8): "how much
 * does this water account still owe". The module dependency direction
 * `iam ← customer ← metering ← billing` forbids customer from importing
 * billing, so the close-account use case talks to this interface only.
 *
 * The real implementation lands with billing (T10); T13 consolidates all
 * module ports under src/modules/integration. Until then this stub is bound
 * in CustomerModule.
 */
export abstract class FinancePort {
  /** Outstanding amount in cents for a water account (0 = clear to close). */
  abstract getOutstanding(tenantId: string, waterAccountId: string): Promise<bigint>;
}

/**
 * Pre-billing stub: returns the configured `outstanding` (default 0n, i.e.
 * "billing not wired yet, nothing owed"). The field is deliberately mutable
 * so e2e tests can simulate a non-zero balance and exercise the
 * close-rejection path.
 */
@Injectable()
export class StubFinancePort extends FinancePort {
  outstanding = 0n;

  getOutstanding(_tenantId: string, _waterAccountId: string): Promise<bigint> {
    return Promise.resolve(this.outstanding);
  }
}
