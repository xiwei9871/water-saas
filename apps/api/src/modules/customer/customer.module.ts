import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { BillingFinancePort } from '../billing/billing-finance.port.js';
import { CustomerController } from './customer.controller.js';
import { CustomerService } from './customer.service.js';
import { MeterController } from './meter.controller.js';
import { MeterInstallationController } from './meter-installation.controller.js';
import { MeterInstallationService } from './meter-installation.service.js';
import { MeterService } from './meter.service.js';
import { FinancePort } from './ports/finance.port.js';
import { SettleAccountController } from './settle-account.controller.js';
import { SettleAccountService } from './settle-account.service.js';
import { CloseAccountUseCase } from './use-cases/close-account.use-case.js';
import { WaterAccountController } from './water-account.controller.js';
import { WaterAccountService } from './water-account.service.js';

/**
 * Customer module （三户 + 水表 + 安装 + 立户向导）:
 *   customer / settle_account / water_account / meter / meter_installation /
 *   account_event + the POST /water-accounts/onboard wizard.
 *
 * Dependency discipline: customer DOMAIN code never imports billing — the
 * close orchestration reaches finance through the FinancePort interface
 * only. The module-level `imports: [BillingModule]` exists solely to bind
 * the shared token to BillingFinancePort (T10): a DI wiring compromise,
 * not a domain dependency. T13's stub ports live in
 * src/modules/integration, but the live FinancePort stays here — the
 * inversion is documented, not removed.
 * TenantPrismaService/IdempotencyService/SequenceService come from the
 * global CommonModule (T12 moved document numbering there so payment can
 * consume it without importing customer).
 */
@Module({
  imports: [BillingModule],
  controllers: [
    CustomerController,
    SettleAccountController,
    WaterAccountController,
    MeterController,
    MeterInstallationController,
  ],
  providers: [
    CustomerService,
    SettleAccountService,
    WaterAccountService,
    MeterService,
    MeterInstallationService,
    CloseAccountUseCase,
    { provide: FinancePort, useExisting: BillingFinancePort },
  ],
})
export class CustomerModule {}
