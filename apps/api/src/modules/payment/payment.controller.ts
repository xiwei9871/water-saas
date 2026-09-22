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
import {
  AnyPermissions,
  Permissions,
} from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { assertUuid } from '../../common/uuid.js';
import { PaymentService, type CreatePaymentBody } from './payment.service.js';

const PAY_CHANNELS = new Set(['CASH', 'POS', 'TRANSFER']);
const PAYMENT_STATUSES = new Set(['RECEIVED', 'DAY_CLOSED', 'REVERSED']);

/** ?take default 50, hard-capped at 200; ?skip default 0. */
const pageArgs = (take?: string, skip?: string) => ({
  take: Math.min(Math.max(parseInt(take ?? '50', 10) || 50, 1), 200),
  skip: Math.max(parseInt(skip ?? '0', 10) || 0, 0),
});

/**
 * Money on the wire is integer cents — a number or digit string that
 * must fit bigint exactly. Decimal input would either crash BigInt or
 * silently store a fractional cent, so it gets a clean 400.
 */
const assertCents = (
  v: unknown,
  field: string,
  opts: { min?: bigint } = {},
): bigint => {
  if (typeof v !== 'number' && typeof v !== 'string') {
    throw new BadRequestException({ code: 'INVALID_AMOUNT', field });
  }
  if (typeof v === 'number' && !Number.isSafeInteger(v)) {
    // isInteger admits values above 2^53 whose cents silently drift.
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

interface PaymentAllocWire {
  billId?: string;
  amount?: unknown;
}

interface PaymentWireBody {
  settleAccountId?: string;
  channel?: string;
  amount?: unknown;
  allocs?: PaymentAllocWire[];
}

/**
 * /payments — counter collection with multi-bill allocation (spec §2.6).
 * POST is idempotency-wrapped: payment + allocs + receipt + the
 * idempotency record commit in ONE tx, so a retry can never double-take
 * money. Reverse is append-only — the original row is never flipped.
 */
@Controller('payments')
export class PaymentController {
  constructor(
    private readonly svc: PaymentService,
    private readonly prisma: TenantPrismaService,
    private readonly idem: IdempotencyService,
  ) {}

  /** GET /payments — ?settleAccountId / ?cashierId / ?status / ?channel / paging. */
  @Get()
  @Permissions('payment:read')
  list(
    @Query('settleAccountId') settleAccountId?: string,
    @Query('cashierId') cashierId?: string,
    @Query('status') status?: string,
    @Query('channel') channel?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    if (settleAccountId !== undefined) assertUuid(settleAccountId, 'settleAccountId');
    if (cashierId !== undefined) assertUuid(cashierId, 'cashierId');
    if (status !== undefined && !PAYMENT_STATUSES.has(status)) {
      throw new BadRequestException({ code: 'PAYMENT_STATUS_INVALID' });
    }
    if (channel !== undefined && !PAY_CHANNELS.has(channel)) {
      throw new BadRequestException({ code: 'PAY_CHANNEL_INVALID' });
    }
    return this.svc.list(currentTenant(), {
      ...pageArgs(take, skip),
      settleAccountId,
      cashierId,
      status: status as 'RECEIVED' | 'DAY_CLOSED' | 'REVERSED' | undefined,
      channel: channel as 'CASH' | 'POS' | 'TRANSFER' | undefined,
    });
  }

  /** GET /payments/:id — payment + allocs + receipt inline. */
  @Get(':id')
  @Permissions('payment:read')
  get(@Param('id') id: string) {
    return this.svc.getById(currentTenant(), assertUuid(id, 'id'));
  }

  /**
   * POST /payments — {settleAccountId, channel, amount, allocs[]}: the
   * amount is integer cents and must equal Σ allocs exactly (no
   * unallocated residue — over-pay/credit is out of MVP scope). Each
   * alloc must fit the bill's remaining outstanding.
   */
  @Post()
  @Permissions('payment:write')
  create(
    @Body() body: PaymentWireBody,
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!body?.settleAccountId || !body.channel || body.amount === undefined) {
      throw new BadRequestException({ code: 'PAYMENT_FIELDS_REQUIRED' });
    }
    if (!PAY_CHANNELS.has(body.channel)) {
      throw new BadRequestException({ code: 'PAY_CHANNEL_INVALID' });
    }
    if (!Array.isArray(body.allocs) || body.allocs.length === 0) {
      throw new BadRequestException({ code: 'PAYMENT_ALLOCS_REQUIRED' });
    }
    const parsed: CreatePaymentBody = {
      settleAccountId: assertUuid(body.settleAccountId, 'settleAccountId'),
      channel: body.channel as CreatePaymentBody['channel'],
      amount: assertCents(body.amount, 'amount', { min: 1n }),
      allocs: body.allocs.map((a) => {
        if (!a?.billId || a.amount === undefined) {
          throw new BadRequestException({ code: 'PAYMENT_ALLOC_FIELDS_REQUIRED' });
        }
        return {
          billId: assertUuid(a.billId, 'allocs[].billId'),
          amount: assertCents(a.amount, 'allocs[].amount', { min: 1n }),
        };
      }),
    };
    const seen = new Set<string>();
    for (const a of parsed.allocs) {
      if (seen.has(a.billId)) {
        throw new BadRequestException({ code: 'PAYMENT_ALLOC_DUPLICATE', billId: a.billId });
      }
      seen.add(a.billId);
    }
    const allocSum = parsed.allocs.reduce((s, a) => s + a.amount, 0n);
    if (allocSum !== parsed.amount) {
      throw new BadRequestException({
        code: 'PAYMENT_ALLOC_MISMATCH',
        amount: parsed.amount.toString(),
        allocSum: allocSum.toString(),
      });
    }

    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body, responseStatus: 201 },
      (tx) => this.svc.createTx(tx, ctx, parsed),
    );
  }

  /**
   * POST /payments/:id/reverse — append-only 红冲: the original is
   * NEVER flipped (RECEIVED stays RECEIVED so the pair nets to zero in
   * its close; DAY_CLOSED stays DAY_CLOSED — a signed close is
   * immutable). Creates a RECEIVED reversal payment with negated amount
   * + negated mirror allocs; the original's receipt is voided.
   */
  @Post(':id/reverse')
  // E6 (domain §13): either permission passes the guard — the service
  // decides the precise requirement from the payment's facts (a
  // TOP_UP-containing reversal needs prepayment:reverse unless it's
  // the cashier's own same-day unclosed slip; a cash-only reversal
  // still needs payment:write).
  @AnyPermissions('payment:write', 'prepayment:reverse')
  reverse(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    assertUuid(id, 'id');
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      // The real body participates in the key hash (parity with create):
      // same key + different body must 409, not silently replay.
      { key, method: 'POST', route: req.path, body: body ?? {}, responseStatus: 201 },
      (tx) => this.svc.reverseTx(tx, ctx, id, req),
    );
  }
}
