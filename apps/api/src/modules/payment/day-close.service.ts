import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PayChannel, Prisma } from '@prisma/client';
import { type TenantCtx } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';

export const DAY_CLOSE_SELECT = {
  id: true,
  tenantId: true,
  cashierId: true,
  orgUnitId: true,
  closeDate: true,
  totalCount: true,
  totalAmount: true,
  byChannel: true,
  status: true,
  closedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CashierDayCloseSelect;

/** Payment columns returned inside a close detail. */
const PAYMENT_MEMBER_SELECT = {
  id: true,
  paymentNo: true,
  channel: true,
  amount: true,
  status: true,
  receivedAt: true,
  reversalOfId: true,
  dayCloseId: true,
} satisfies Prisma.PaymentSelect;

/** One flipped payment row as the claim SELECT returns it. */
export interface ClaimedPayment {
  id: string;
  payment_no: string;
  channel: 'CASH' | 'POS' | 'TRANSFER';
  amount: bigint;
  received_at: Date;
  reversal_of_id: string | null;
}

/** Wire shape for a payment inside a close — camelCase like /payments. */
const memberWire = (p: {
  id: string;
  paymentNo: string;
  channel: string;
  amount: bigint;
  status: string;
  receivedAt: Date;
  reversalOfId: string | null;
  dayCloseId: string | null;
}) => ({
  id: p.id,
  paymentNo: p.paymentNo,
  channel: p.channel,
  amount: p.amount,
  status: p.status,
  receivedAt: p.receivedAt,
  reversalOfId: p.reversalOfId,
  dayCloseId: p.dayCloseId,
});

/**
 * CashierDayClose （收费员日结） — spec §2.6: a cashier signs off one
 * operating date; the close row is a POSTED summary document
 * (total_count / total_amount / by_channel jsonb) that is never
 * re-issued.
 *
 * Collection semantics — `received_at::date <= closeDate`, NOT `=`:
 * the close sweeps every RECEIVED payment received on-or-before the
 * operating date. Strict `=` would permanently strand any payment
 * created AFTER its own date's close (a post-close same-day reversal
 * could never enter any later close — its received date is already
 * sealed), so stragglers roll forward into the next close instead.
 * The patch example is preserved: reverse on 9/19 → −amount line in
 * 9/19's close; reverse on 9/18 after 9/18's close → −amount in the
 * next close (9/18's signed document is untouched either way).
 * closeDate is the OPERATING date keyed on `received_at` (server-date
 * basis — `received_at` is a `timestamp` written by `now()`).
 *
 * Concurrency: the cashier's staff row is taken FOR UPDATE first, so
 * two closes for one cashier can never be in flight together — the
 * (cashier, closeDate) existence check is race-free without a unique
 * index. The RECEIVED→DAY_CLOSED flip is a guarded updateMany re-checked
 * on the claimed id set; any count mismatch aborts loudly (nothing else
 * writes payment.status, so it cannot happen today — defensive only).
 * byChannel buckets always carry all three channels; reversal payments
 * contribute negative amounts to their channel, netting the drawer.
 */
@Injectable()
export class DayCloseService {
  constructor(private readonly prisma: TenantPrismaService) {}

  list(
    ctx: TenantCtx,
    q: { take: number; skip: number; cashierId?: string; closeDate?: string },
  ) {
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.cashierDayClose.findMany({
        where: {
          tenantId: ctx.tenantId,
          cashierId: q.cashierId,
          ...(q.closeDate !== undefined
            ? { closeDate: new Date(`${q.closeDate}T00:00:00.000Z`) }
            : {}),
        },
        select: DAY_CLOSE_SELECT,
        orderBy: [{ closeDate: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
        take: q.take,
        skip: q.skip,
      }),
    );
  }

  /**
   * GET /cashier-day-close/:id — the close plus the payments it swept.
   * Membership is a stored fact: the RECEIVED→DAY_CLOSED flip stamps
   * payment.day_close_id, so members are read back exactly — no
   * boundary math (a received_at/closed_at reconstruction misattributes
   * payments whose commits straddle a queued close, because closed_at =
   * transaction_timestamp() marks the tx START, not the sweep).
   */
  async getById(ctx: TenantCtx, id: string) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const close = await tx.cashierDayClose.findFirst({
        where: { tenantId: ctx.tenantId, id },
        select: DAY_CLOSE_SELECT,
      });
      if (!close) {
        throw new NotFoundException({ code: 'DAY_CLOSE_NOT_FOUND' });
      }
      const members = await tx.payment.findMany({
        where: { tenantId: ctx.tenantId, dayCloseId: close.id },
        orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
        select: PAYMENT_MEMBER_SELECT,
      });
      return { ...close, payments: members.map(memberWire) };
    });
  }

  /**
   * POST /cashier-day-close/close {closeDate?} — one tx: staff row FOR
   * UPDATE → (cashier, closeDate) exists check → sweep RECEIVED
   * payments ≤ closeDate → guarded flip → insert the POSTED close.
   * closeDate defaults to the DB server's CURRENT_DATE (the same clock
   * that stamps received_at).
   */
  async closeTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    body: { closeDate?: string },
  ) {
    // The staff row lock serializes closes for this cashier: a second
    // concurrent close blocks here, then sees the winner's committed
    // row → DAY_CLOSE_EXISTS. It also yields the cashier's org_unit.
    const staffRows = await tx.$queryRaw<{ id: string; org_unit_id: string }[]>`
      SELECT id::text AS id, org_unit_id::text AS org_unit_id
      FROM staff
      WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${ctx.staffId}::uuid
      FOR UPDATE`;
    const staff = staffRows[0];
    if (!staff) throw new NotFoundException({ code: 'STAFF_NOT_FOUND' });

    const closeDate =
      body.closeDate ??
      (await tx.$queryRaw<{ d: string }[]>`SELECT CURRENT_DATE::text AS d`)[0].d;
    const closeDateValue = new Date(`${closeDate}T00:00:00.000Z`);

    // A signed document is never re-issued — under the staff lock this
    // check is race-free.
    const existing = await tx.cashierDayClose.findFirst({
      where: {
        tenantId: ctx.tenantId,
        cashierId: ctx.staffId,
        closeDate: closeDateValue,
      },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException({
        code: 'DAY_CLOSE_EXISTS',
        cashierDayCloseId: existing.id,
      });
    }

    const pending = await tx.$queryRaw<ClaimedPayment[]>`
      SELECT id::text AS id, payment_no, channel::text AS channel, amount,
             received_at, reversal_of_id::text AS reversal_of_id
      FROM payment
      WHERE tenant_id = ${ctx.tenantId}::uuid
        AND cashier_id = ${ctx.staffId}::uuid
        AND status = 'RECEIVED'
        AND received_at::date <= ${closeDate}::date
      ORDER BY received_at, id`;
    if (pending.length === 0) {
      throw new ConflictException({ code: 'DAY_CLOSE_EMPTY' });
    }

    const ids = pending.map((p) => p.id);
    // Buckets are derived from the PayChannel enum itself — a future
    // channel can never crash on an undefined bucket or silently
    // aggregate into a hardcoded set.
    const byChannel = Object.fromEntries(
      Object.values(PayChannel).map((c) => [c, { count: 0, amount: 0n }]),
    ) as Record<PayChannel, { count: number; amount: bigint }>;
    let totalAmount = 0n;
    for (const p of pending) {
      const bucket = byChannel[p.channel];
      bucket.count += 1;
      bucket.amount += p.amount;
      totalAmount += p.amount;
    }
    // Money convention is BigInt→string on the wire — the jsonb summary
    // stores amounts as strings for the same exactness (T13 reports
    // read this document verbatim).
    const byChannelJson = Object.fromEntries(
      Object.entries(byChannel).map(([k, v]) => [
        k,
        { count: v.count, amount: v.amount.toString() },
      ]),
    ) as unknown as Prisma.InputJsonValue;

    // The close row lands FIRST — its id is what the flip stamps onto
    // every swept payment, making membership a stored fact.
    const close = await tx.cashierDayClose.create({
      data: {
        tenantId: ctx.tenantId,
        cashierId: ctx.staffId,
        orgUnitId: staff.org_unit_id,
        closeDate: closeDateValue,
        totalCount: pending.length,
        totalAmount,
        byChannel: byChannelJson,
        status: 'POSTED',
        createdBy: ctx.staffId,
        updatedBy: ctx.staffId,
      },
      select: DAY_CLOSE_SELECT,
    });

    const flip = await tx.payment.updateMany({
      where: { tenantId: ctx.tenantId, id: { in: ids }, status: 'RECEIVED' },
      data: {
        status: 'DAY_CLOSED',
        dayCloseId: close.id,
        updatedBy: ctx.staffId,
      },
    });
    if (flip.count !== ids.length) {
      // Only another writer could have moved a claimed row off
      // RECEIVED — nothing else writes payment.status, so this is a
      // defensive abort, not an expected race.
      throw new ConflictException({ code: 'DAY_CLOSE_LOST_RACE' });
    }

    return {
      ...close,
      payments: pending.map((p) =>
        memberWire({
          id: p.id,
          paymentNo: p.payment_no,
          channel: p.channel,
          amount: p.amount,
          status: 'DAY_CLOSED',
          receivedAt: p.received_at,
          reversalOfId: p.reversal_of_id,
          dayCloseId: close.id,
        }),
      ),
    };
  }
}
