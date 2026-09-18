import { Module } from '@nestjs/common';
import { CustomerController } from './customer.controller.js';
import { CustomerService } from './customer.service.js';
import { MeterController } from './meter.controller.js';
import { MeterInstallationController } from './meter-installation.controller.js';
import { MeterInstallationService } from './meter-installation.service.js';
import { MeterService } from './meter.service.js';
import { FinancePort, StubFinancePort } from './ports/finance.port.js';
import { SequenceService } from './sequence.service.js';
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
 * Dependency discipline: this module never imports billing. The close
 * orchestration reaches finance through FinancePort — bound to the zero
 * stub until billing lands (T10), consolidated under integration in T13.
 * TenantPrismaService/IdempotencyService come from the global CommonModule.
 */
@Module({
  controllers: [
    CustomerController,
    SettleAccountController,
    WaterAccountController,
    MeterController,
    MeterInstallationController,
  ],
  providers: [
    SequenceService,
    CustomerService,
    SettleAccountService,
    WaterAccountService,
    MeterService,
    MeterInstallationService,
    CloseAccountUseCase,
    { provide: FinancePort, useClass: StubFinancePort },
  ],
  // metering (downstream in the iam←customer←metering direction) reuses the
  // tenant-scoped document numbering for reading_book.book_no.
  exports: [SequenceService],
})
export class CustomerModule {}
