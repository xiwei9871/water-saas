import {
  BadRequestException,
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
import { PrepaymentService } from './prepayment.service.js';

const PAY_CHANNELS = new Set(['CASH', 'POS', 'TRANSFER']);
const ENTRY_TYPES = new Set(['TOP_UP', 'APPLY', 'REFUND', 'REVERSAL']);

const pageArgs = (take?: string, skip?: string) => ({
  take: Math.min(Math.max(parseInt(take ?? '50', 10) || 50, 1), 200),
  skip: Math.max(parseInt(skip ?? '0', 10) || 0, 0),
});

const assertCents = (v: unknown, field: string, opts: { min?: bigint } = {}): bigint => {
  if (typeof v !== 'number' && typeof v !== 'string') {
    throw new BadRequestException({ code: 'INVALID_AMOUNT', field });
  }
  if (typeof v === 'number' && !Number.isSafeInteger(v)) {
    throw new BadRequestException({ code: 'INVALID_AMOUNT', field });
  }
  if (typeof v === 'string' && !/^-?\d+$/.test(v.trim())) {
    throw new BadRequestException({ code: 'INVALID_AMOUNT', field });
  }
  const n = BigInt(v);
  if (opts.min !== undefined && n < opts.min) {
    throw new BadRequestException({ code: 'INVALID_AMOUNT', field });
  }
  return n;
};

interface MoneyWireBody {
  settleAccountId?: string;
  channel?: string;
  amount?: unknown;
  reason?: string;
}

const assertMoneyBody = (body: MoneyWireBody | undefined) => {
  if (!body?.settleAccountId || !body.channel || body.amount === undefined) {
    throw new BadRequestException({ code: 'PREPAYMENT_FIELDS_REQUIRED' });
  }
  if (!PAY_CHANNELS.has(body.channel)) {
    throw new BadRequestException({ code: 'PAY_CHANNEL_INVALID' });
  }
  return {
    settleAccountId: assertUuid(body.settleAccountId, 'settleAccountId'),
    channel: body.channel,
    amount: assertCents(body.amount, 'amount', { min: 1n }),
    reason: body.reason,
  };
};

/**
 * /prepayments — E6 预存: TOP_UP is a real counter payment that clears
 * existing debt first and parks the remainder; REFUND is a real negative
 * payment. Both are idempotency-wrapped so a retry can never double-move
 * money. Reads expose the append-only ledger and FIFO lot state.
 */
@Controller('prepayments')
export class PrepaymentController {
  constructor(
    private readonly svc: PrepaymentService,
    private readonly prisma: TenantPrismaService,
    private readonly idem: IdempotencyService,
  ) {}

  /** GET /prepayments/balance?settleAccountId — balance + FIFO lots. */
  @Get('balance')
  @Permissions('payment:read')
  balance(@Query('settleAccountId') settleAccountId?: string) {
    return this.svc.balance(
      currentTenant(),
      assertUuid(settleAccountId, 'settleAccountId'),
    );
  }

  /** GET /prepayments/entries — append-only ledger, newest first. */
  @Get('entries')
  @Permissions('payment:read')
  entries(
    @Query('settleAccountId') settleAccountId?: string,
    @Query('type') type?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    if (settleAccountId !== undefined) {
      assertUuid(settleAccountId, 'settleAccountId');
    }
    if (type !== undefined && !ENTRY_TYPES.has(type)) {
      throw new BadRequestException({ code: 'PREPAYMENT_ENTRY_TYPE_INVALID' });
    }
    return this.svc.entries(currentTenant(), {
      settleAccountId,
      type,
      ...pageArgs(take, skip),
    });
  }

  /**
   * POST /prepayments/top-ups — {settleAccountId, channel, amount}:
   * one Payment(+amount) that clears payable debt first, remainder
   * becomes a TOP_UP lot; one Receipt; one cash event.
   */
  @Post('top-ups')
  @Permissions('payment:write')
  topUp(
    @Body() body: MoneyWireBody,
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    const parsed = assertMoneyBody(body);
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body, responseStatus: 201 },
      (tx) =>
        this.svc.topUpTx(tx, ctx, {
          settleAccountId: parsed.settleAccountId,
          channel: parsed.channel,
          amount: parsed.amount,
        }),
    );
  }

  /**
   * POST /prepayments/refunds — {settleAccountId, channel, amount,
   * reason}: real money out — a negative Payment in the refunding
   * cashier's drawer + per-lot REFUND entries (FIFO split). Requires
   * prepayment:reverse; never exceeds the current balance.
   */
  @Post('refunds')
  @Permissions('prepayment:reverse')
  refund(
    @Body() body: MoneyWireBody,
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    const parsed = assertMoneyBody(body);
    const reason = parsed.reason;
    if (typeof reason !== 'string' || !reason.trim()) {
      throw new BadRequestException({ code: 'REFUND_REASON_REQUIRED' });
    }
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body, responseStatus: 201 },
      (tx) =>
        this.svc.refundTx(tx, ctx, {
          settleAccountId: parsed.settleAccountId,
          channel: parsed.channel,
          amount: parsed.amount,
          reason,
        }),
    );
  }
}
