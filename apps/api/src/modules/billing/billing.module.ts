import { Module } from '@nestjs/common';
import { PrepaymentModule } from '../prepayment/prepayment.module.js';
import { BillController } from './bill.controller.js';
import { BillService } from './bill.service.js';
import { BillingFinancePort } from './billing-finance.port.js';
import { BillingRunController } from './billing-run.controller.js';
import { BillingRunService } from './billing-run.service.js';
import { FeeItemController } from './fee-item.controller.js';
import { FeeItemService } from './fee-item.service.js';
import { ReconciliationController } from './reconciliation.controller.js';
import { ReconciliationService } from './reconciliation.service.js';
import { TariffPlanController } from './tariff-plan.controller.js';
import { TariffPlanService } from './tariff-plan.service.js';

/**
 * Billing module （计费） — fee_item + tariff_plan/tariff_tier versioned
 * price configuration (Task 8), billing_core engine (Task 9),
 * billing_run + bill lifecycle: synchronous in-request run execution,
 * per-bill posting transactions, reversal/replacement corrections
 * (Task 10), and anchor-based reconciliation 补差 (Task 11).
 *
 * BillingFinancePort is exported so CustomerModule can bind the shared
 * FinancePort token to it — the module-level import direction
 * (customer → billing) is the deliberate DI wiring compromise for MVP;
 * T13 consolidates all module ports under src/modules/integration.
 * TenantPrismaService / IdempotencyService come from the global
 * CommonModule.
 */
@Module({
  imports: [PrepaymentModule],
  controllers: [
    FeeItemController,
    TariffPlanController,
    BillingRunController,
    BillController,
    ReconciliationController,
  ],
  providers: [
    FeeItemService,
    TariffPlanService,
    BillingRunService,
    BillService,
    ReconciliationService,
    BillingFinancePort,
  ],
  exports: [BillingFinancePort],
})
export class BillingModule {}
