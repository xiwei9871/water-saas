import { Module } from '@nestjs/common';
import { PrepaymentController } from './prepayment.controller.js';
import { PrepaymentService } from './prepayment.service.js';

/**
 * PrepaymentModule (E6): standalone domain core — Billing and Payment
 * both import it (billing → prepayment ← payment), so it must never
 * import either back (no circular dependency). Everything it needs —
 * tenant prisma, sequence, idempotency — comes from the global
 * CommonModule.
 */
@Module({
  controllers: [PrepaymentController],
  providers: [PrepaymentService],
  exports: [PrepaymentService],
})
export class PrepaymentModule {}
