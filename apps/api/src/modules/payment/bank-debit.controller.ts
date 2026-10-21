import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { IdempotencyService } from '../../common/idempotency.service.js';
import { withOptionalIdem } from '../../common/idempotent.js';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { assertUuid } from '../../common/uuid.js';
import { BankDebitService } from './bank-debit.service.js';

/** 20261021 整改 任务F：银行代扣（协议→批次→执行→PKMX/PKJG/DZMX）。 */
@Controller('bank-debit')
export class BankDebitController {
  constructor(
    private readonly svc: BankDebitService,
    private readonly prisma: TenantPrismaService,
    private readonly idem: IdempotencyService,
  ) {}

  @Get('agreements')
  @Permissions('payment:read', 'payment:write')
  agreements(@Query('status') status?: string) {
    return this.svc.listAgreements(currentTenant(), { status });
  }

  @Post('agreements')
  @Permissions('payment:write')
  createAgreement(
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body, responseStatus: 201 },
      (tx) => this.svc.createAgreementTx(tx, ctx, body, req),
    );
  }

  @Post('agreements/:id/cancel')
  @Permissions('payment:write')
  cancelAgreement(@Param('id') id: string, @Req() req: Request) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.cancelAgreementTx(tx, ctx, assertUuid(id, 'id'), req),
    );
  }

  @Get('batches')
  @Permissions('payment:read', 'payment:write')
  batches() {
    return this.svc.listBatches(currentTenant());
  }

  /** 生成批次（防重复②跳过+③DB偏唯一兜底）。 */
  @Post('batches')
  @Permissions('payment:write')
  createBatch(
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body, responseStatus: 201 },
      (tx) => this.svc.createBatchTx(tx, ctx, body, req),
    );
  }

  /** 执行批次（幂等：只处理 PENDING 明细，重跑不重复扣）。 */
  @Post('batches/:id/execute')
  @Permissions('payment:write')
  execute(@Param('id') id: string, @Req() req: Request) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.executeBatchTx(tx, ctx, assertUuid(id, 'id'), req),
    );
  }

  @Get('batches/:id/items')
  @Permissions('payment:read', 'payment:write')
  items(@Param('id') id: string) {
    return this.svc.items(currentTenant(), assertUuid(id, 'id'));
  }

  /** PKMX 扣款明细（送银行前）。 */
  @Get('batches/:id/pkmx')
  @Permissions('payment:read', 'payment:write')
  pkmx(@Param('id') id: string) {
    return this.svc.pkmx(currentTenant(), assertUuid(id, 'id'));
  }

  /** PKJG 扣款结果（回盘后）。 */
  @Get('batches/:id/pkjg')
  @Permissions('payment:read', 'payment:write')
  pkjg(@Param('id') id: string) {
    return this.svc.pkjg(currentTenant(), assertUuid(id, 'id'));
  }

  /** DZMX 对账明细（扣款 vs 销账核对）。 */
  @Get('batches/:id/dzmx')
  @Permissions('payment:read', 'payment:write')
  dzmx(@Param('id') id: string) {
    return this.svc.dzmx(currentTenant(), assertUuid(id, 'id'));
  }
}
