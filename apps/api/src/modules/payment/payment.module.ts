import { Module } from '@nestjs/common';
import { PrepaymentModule } from '../prepayment/prepayment.module.js';
import { AccountOutstandingController } from './account-outstanding.controller.js';
import { DayCloseController } from './day-close.controller.js';
import { DayCloseService } from './day-close.service.js';
import { PaymentController } from './payment.controller.js';
import { PaymentService } from './payment.service.js';
import { ReceiptController } from './receipt.controller.js';

/**
 * Payment module （收款） — counter collection with multi-bill
 * allocation, append-only reversal （红冲退款）, receipts, and the
 * cashier day close (Task 12, spec §2.6).
 *
 * Controllers: /payments (+ GET /water-accounts/:id/outstanding — the
 * cashier's debt probe lives here because it reads bills +
 * payment_alloc, not in customer), /receipts/:id/print,
 * /cashier-day-close.
 *
 * Dependency discipline: payment sits after billing in the module
 * direction (iam ← customer ← metering ← billing ← payment) and imports
 * NO feature module — bill reads go through TenantPrismaService inside
 * the caller's tenant tx (same module-local read convention as
 * ReconciliationService reaching reading_plan_item), SequenceService
 * comes from the global CommonModule. Billing needs nothing from
 * payment: the FinancePort only reads payment_alloc rows, so there is
 * no circularity.
 */
@Module({
  imports: [PrepaymentModule],
  controllers: [
    PaymentController,
    AccountOutstandingController,
    ReceiptController,
    DayCloseController,
  ],
  providers: [PaymentService, DayCloseService],
})
export class PaymentModule {}
