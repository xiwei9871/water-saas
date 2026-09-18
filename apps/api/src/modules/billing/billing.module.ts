import { Module } from '@nestjs/common';
import { FeeItemController } from './fee-item.controller.js';
import { FeeItemService } from './fee-item.service.js';
import { TariffPlanController } from './tariff-plan.controller.js';
import { TariffPlanService } from './tariff-plan.service.js';

/**
 * Billing module （计费） — fee_item + tariff_plan/tariff_tier versioned
 * price configuration (Task 8). billing_run/bill land in T9–T10 on top of
 * these; the tariff freeze + activate overlap rules here are what make a
 * deterministic, auditable tariff pick possible.
 *
 * No module imports: billing sits above iam ← customer ← metering in the
 * dependency direction and needs nothing from them (tariffs are
 * tenant-level config, not org-scoped). TenantPrismaService /
 * IdempotencyService come from the global CommonModule.
 */
@Module({
  controllers: [FeeItemController, TariffPlanController],
  providers: [FeeItemService, TariffPlanService],
})
export class BillingModule {}
