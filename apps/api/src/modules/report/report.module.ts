import { Module } from '@nestjs/common';
import { OpsReportService } from './ops-report.service.js';
import { AnalysisService } from './analysis.service.js';
import { QueryController } from './query.controller.js';
import { QueryService } from './query.service.js';
import { ReportService } from './report.service.js';
import { ReportsController } from './reports.controller.js';
import { UnifiedQueryService } from './unified.service.js';

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
  controllers: [ReportsController, QueryController],
  providers: [ReportService, QueryService, AnalysisService, UnifiedQueryService, OpsReportService],
})
export class ReportModule {}
