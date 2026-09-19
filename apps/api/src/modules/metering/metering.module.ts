import { Module } from '@nestjs/common';
import { CustomerModule } from '../customer/customer.module.js';
import { EstimateController } from './estimate.controller.js';
import { MeterReadingController } from './meter-reading.controller.js';
import { MeterReadingService } from './meter-reading.service.js';
import { ReadingBookController } from './reading-book.controller.js';
import { ReadingBookService } from './reading-book.service.js';
import { ReadingPlanController } from './reading-plan.controller.js';
import { ReadingPlanService } from './reading-plan.service.js';
import { SettlementController } from './settlement.controller.js';
import { SettlementService } from './settlement.service.js';

/**
 * Metering module （抄表） — reading_book / book_meter / reading_plan /
 * reading_plan_item (Task 5) + meter_reading entry/QC/supersede (Task 6)
 * + consumption_settlement generation/finalize and the AVG3 estimate
 * preview (Task 7). Reconciliation lands in T11 on top of these.
 *
 * Imports CustomerModule along the declared iam ← customer ← metering
 * direction (metering never imports billing). SequenceService moved to the
 * global CommonModule in T12 — book_no numbering no longer needs the
 * module import, but the import stays as the declared direction.
 * TenantPrismaService/IdempotencyService/SequenceService are global.
 */
@Module({
  imports: [CustomerModule],
  controllers: [
    ReadingBookController,
    ReadingPlanController,
    MeterReadingController,
    SettlementController,
    EstimateController,
  ],
  providers: [
    ReadingBookService,
    ReadingPlanService,
    MeterReadingService,
    SettlementService,
  ],
})
export class MeteringModule {}
