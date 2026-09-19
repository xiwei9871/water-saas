import {
  Controller,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { assertUuid } from '../../common/uuid.js';
import { PaymentService } from './payment.service.js';

/**
 * /receipts — the payment receipt document (spec §2.6). A receipt is
 * issued with every non-reversal payment; voided when the payment is
 * reversed. print sets printed_at — gated on payment:write like every
 * other mutating POST (a reprint updates the timestamp, so it is not a
 * read-level op even though it creates no financial fact).
 */
@Controller('receipts')
export class ReceiptController {
  constructor(
    private readonly svc: PaymentService,
    private readonly prisma: TenantPrismaService,
  ) {}

  /** POST /receipts/:id/print — printed_at := now(); void → 409. */
  @Post(':id/print')
  @Permissions('payment:write')
  print(@Param('id') id: string, @Req() req: Request) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.printTx(tx, ctx, assertUuid(id, 'id'), req),
    );
  }
}
