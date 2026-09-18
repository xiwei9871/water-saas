import { Module } from '@nestjs/common';
import { CustomerModule } from '../customer/customer.module.js';
import { ReadingBookController } from './reading-book.controller.js';
import { ReadingBookService } from './reading-book.service.js';
import { ReadingPlanController } from './reading-plan.controller.js';
import { ReadingPlanService } from './reading-plan.service.js';

/**
 * Metering module （抄表） — reading_book / book_meter / reading_plan /
 * reading_plan_item (Task 5). Readings/QC/settlement/reconciliation land in
 * T6/T7/T11 on top of the plan-item snapshot produced here.
 *
 * Imports CustomerModule for SequenceService (book_no numbering) — the
 * dependency direction iam ← customer ← metering is respected; metering
 * never imports billing. TenantPrismaService/IdempotencyService come from
 * the global CommonModule.
 */
@Module({
  imports: [CustomerModule],
  controllers: [ReadingBookController, ReadingPlanController],
  providers: [ReadingBookService, ReadingPlanService],
})
export class MeteringModule {}
