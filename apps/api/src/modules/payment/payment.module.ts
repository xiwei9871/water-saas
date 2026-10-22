import { Module } from '@nestjs/common';
import { TaskModule } from '../task/task.module.js';
import { PrepaymentModule } from '../prepayment/prepayment.module.js';
import { AccountOutstandingController } from './account-outstanding.controller.js';
import { BankDebitController } from './bank-debit.controller.js';
import { BANK_DEBIT_PORT, MockBankDebitAdapter } from './bank-debit.port.js';
import { BankDebitService } from './bank-debit.service.js';
import { DayCloseController } from './day-close.controller.js';
import { DayCloseService } from './day-close.service.js';
import { NoticeController } from './notice.controller.js';
import { PaymentController } from './payment.controller.js';
import { ReconController } from './recon.controller.js';
import { ReconService } from './recon.service.js';
import { ReceiptDocController } from './receipt-doc.controller.js';
import { PaymentService } from './payment.service.js';
import { ReceiptController } from './receipt.controller.js';
import { WriteoffController } from './writeoff.controller.js';

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
  imports: [PrepaymentModule, TaskModule],
  controllers: [
    // Literal sub-paths must precede PaymentController: its @Get(':id')
    // would otherwise swallow /payments/recon|collection-notices|receipt-books|invoices.
    ReconController,
    NoticeController,
    ReceiptDocController,
    PaymentController,
    AccountOutstandingController,
    ReceiptController,
    DayCloseController,
    WriteoffController,
    BankDebitController,
  ],
  providers: [
    PaymentService,
    DayCloseService,
    ReconService,
    BankDebitService,
    // 20261021 任务F：银行直连端口 — 真实通道延后，默认 Mock 适配器。
    { provide: BANK_DEBIT_PORT, useClass: MockBankDebitAdapter },
  ],
})
export class PaymentModule {}
