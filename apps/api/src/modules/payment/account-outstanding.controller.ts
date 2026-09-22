import { Controller, Get, Param, Query } from '@nestjs/common';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { assertUuid } from '../../common/uuid.js';
import { PaymentService } from './payment.service.js';

const pageArgs = (take?: string, skip?: string) => ({
  take: Math.min(Math.max(parseInt(take ?? '50', 10) || 50, 1), 200),
  skip: Math.max(parseInt(skip ?? '0', 10) || 0, 0),
});

/**
 * GET /water-accounts/:id/outstanding — the cashier's open-debt probe
 * (spec §2.6 收款台查欠费): every POSTED | PARTIAL_PAID non-REVERSAL bill
 * on the account's settle account with paidAmount/outstanding per bill
 * and the total. Registered under the water-accounts prefix from the
 * payment module — it reads bills + payment_alloc, so it lives here,
 * not in customer (module direction billing ← payment).
 */
@Controller('water-accounts')
export class AccountOutstandingController {
  constructor(
    private readonly svc: PaymentService,
    private readonly prisma: TenantPrismaService,
  ) {}

  @Get(':id/outstanding')
  @Permissions('payment:read')
  outstanding(@Param('id') id: string) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.outstandingTx(tx, ctx, assertUuid(id, 'id')),
    );
  }

  /**
   * GET /water-accounts/:id/payment-activity — 本户账单偿付记录 (E8 D4):
   * payment_alloc rows on this account's bills, discriminated union on
   * `source` (PAYMENT counter payments + PREPAYMENT auto-apply).
   */
  @Get(':id/payment-activity')
  @Permissions('payment:read')
  paymentActivity(
    @Param('id') id: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    const ctx = currentTenant();
    const args = pageArgs(take, skip);
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.paymentActivityTx(tx, ctx, assertUuid(id, 'id'), args),
    );
  }
}
