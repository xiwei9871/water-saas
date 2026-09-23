import { Module } from '@nestjs/common';
import { ExceptionController } from './exception.controller.js';
import { ExceptionService } from './exception.service.js';
import { ExceptionReconciler } from './reconciler.js';

/**
 * Exception module （异常中心） — E9 operational work queue.
 * Detector (pure facts) / Reconciler (episode writes) / Query (read-only)
 * are kept as separate classes per the Rev4 domain design; the module
 * imports no feature module — detectors query tenant tables directly
 * through TenantPrismaService, same convention as report.
 */
@Module({
  controllers: [ExceptionController],
  providers: [ExceptionService, ExceptionReconciler],
})
export class ExceptionModule {}
