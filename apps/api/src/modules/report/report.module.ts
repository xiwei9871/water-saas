import { Module } from '@nestjs/common';
import { ReportService } from './report.service.js';
import { ReportsController } from './reports.controller.js';

/**
 * Report module （报表） — read-only aggregate projections (Task 13,
 * spec §4): /reports/meter-daily, /reports/cashier-daily,
 * /reports/ar-monthly, /reports/collected-monthly, /reports/recovery-rate.
 *
 * Dependency discipline: report is the TOP of the module chain
 * (iam ← customer ← metering ← billing ← payment ← report) and imports
 * NO feature module — the projections are direct tenant-scoped queries
 * through TenantPrismaService (global CommonModule), the same
 * module-local read convention payment uses for bill reads. Nothing in
 * this module ever writes.
 */
@Module({
  controllers: [ReportsController],
  providers: [ReportService],
})
export class ReportModule {}
