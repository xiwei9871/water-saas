import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { conflictOnUnique } from '../../common/prisma-errors.js';
import {
  isValidPeriod,
  BOOK_CADENCES,
  METER_CHANNELS,
  type BookCadence,
  type MeterChannel,
} from '../../common/reading-cadence.js';
import { orgInScope, type TenantCtx } from '../../common/tenant-context.js';
import { assertAccountScopeTx } from '../../common/account-scope.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { SequenceService } from '../../common/sequence.service.js';

export const READING_BOOK_SELECT = {
  id: true,
  tenantId: true,
  bookNo: true,
  name: true,
  orgUnitId: true,
  readerId: true,
  scheduleDay: true,
  cadence: true,
  anchorPeriod: true,
  meterChannel: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ReadingBookSelect;

const ACCOUNT_SUMMARY = {
  id: true,
  accountNo: true,
  addr: true,
  status: true,
} satisfies Prisma.WaterAccountSelect;

export interface ReadingBookBody {
  bookNo?: string;
  name?: string;
  orgUnitId?: string;
  readerId?: string | null;
  scheduleDay?: number | null;
  cadence?: BookCadence;
  anchorPeriod?: string | null;
  meterChannel?: MeterChannel;
}

export interface ReadingBookPatchBody {
  name?: string;
  orgUnitId?: string;
  readerId?: string | null;
  scheduleDay?: number | null;
  cadence?: BookCadence;
  anchorPeriod?: string | null;
  meterChannel?: MeterChannel;
}

export interface BookMemberBody {
  waterAccountId?: string;
  seqNo?: number;
}

const outOfScope = () => new ForbiddenException({ code: 'ORG_OUT_OF_SCOPE' });

/**
 * ReadingBook （抄表册） — a named route of water accounts one reader walks
 * (spec §2.2). `book_meter` holds the CURRENT membership keyed by
 * water_account (never by installation — mid-period meter swaps don't touch
 * the book); plan generation snapshots it into reading_plan_item.
 *
 * Schema note: `book_meter` declares no Prisma relations and `reading_book`
 * has no (tenant_id,id) unique — book references are plain columns guarded by
 * tenant filters + RLS, and member hydration is a manual second query.
 *
 * reading_book carries org_unit_id (NOT NULL) so the write path applies the
 * orgInScope guard like iam/orgs: a scoped caller may only create/mutate
 * books inside their subtree. Book rows have no status column — lifecycle is
 * just membership + generated plans.
 */
@Injectable()
export class ReadingBookService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly seq: SequenceService,
  ) {}

  list(
    ctx: TenantCtx,
    q: {
      take: number;
      skip: number;
      name?: string;
      bookNo?: string;
      orgUnitId?: string;
      waterAccountId?: string;
    },
  ) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      // E8: a scoped caller sees only books anchored to their org subtree —
      // the book IS the org anchor. Explicit waterAccountId (360 books
      // card) asserts account scope first, then matches membership.
      if (q.waterAccountId) {
        await assertAccountScopeTx(tx, ctx, q.waterAccountId);
      }
      if (q.orgUnitId && ctx.scope !== 'ALL' && !orgInScope(ctx, q.orgUnitId)) {
        throw outOfScope();
      }
      // book_meter has no ORM relation (composite-FK managed manually) —
      // resolve membership bookIds in a second query.
      const memberBookIds = q.waterAccountId
        ? (
            await tx.bookMeter.findMany({
              where: { tenantId: ctx.tenantId, waterAccountId: q.waterAccountId },
              select: { bookId: true },
            })
          ).map((m) => m.bookId)
        : undefined;
      return tx.readingBook.findMany({
        where: {
          tenantId: ctx.tenantId,
          bookNo: q.bookNo,
          orgUnitId:
            ctx.scope === 'ALL' ? q.orgUnitId : { in: ctx.orgScope },
          name: q.name ? { contains: q.name } : undefined,
          ...(memberBookIds ? { id: { in: memberBookIds } } : {}),
        },
        select: READING_BOOK_SELECT,
        orderBy: { bookNo: 'asc' },
        take: q.take,
        skip: q.skip,
      });
    });
  }

  /** Members of a book ordered by seq_no, hydrated with the account summary. */
  private async membersOf(tx: Prisma.TransactionClient, ctx: TenantCtx, bookId: string) {
    const members = await tx.bookMeter.findMany({
      where: { tenantId: ctx.tenantId, bookId },
      orderBy: [{ seqNo: 'asc' }, { waterAccountId: 'asc' }],
    });
    if (members.length === 0) return [];
    const accounts = await tx.waterAccount.findMany({
      where: {
        tenantId: ctx.tenantId,
        id: { in: members.map((m) => m.waterAccountId) },
      },
      select: ACCOUNT_SUMMARY,
    });
    const byId = new Map(accounts.map((a) => [a.id, a]));
    return members.map((m) => ({
      waterAccountId: m.waterAccountId,
      seqNo: m.seqNo,
      waterAccount: byId.get(m.waterAccountId) ?? null,
    }));
  }

  async getById(ctx: TenantCtx, id: string) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const book = await tx.readingBook.findFirst({
        where: { tenantId: ctx.tenantId, id },
        select: READING_BOOK_SELECT,
      });
      if (!book) throw new NotFoundException({ code: 'BOOK_NOT_FOUND' });
      // E8: book detail is org-anchored — out-of-scope org → 403. The
      // member list is customer data but the book itself already gates.
      if (!orgInScope(ctx, book.orgUnitId)) throw outOfScope();
      const members = await this.membersOf(tx, ctx, id);
      return { ...book, members };
    });
  }

  /** A book's org_unit must sit inside the caller's data scope (I1 guard). */
  private async assertBookInScope(tx: Prisma.TransactionClient, ctx: TenantCtx, id: string) {
    const book = await tx.readingBook.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!book) throw new NotFoundException({ code: 'BOOK_NOT_FOUND' });
    if (!orgInScope(ctx, book.orgUnitId)) throw outOfScope();
    return book;
  }

  private async assertRefs(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    body: { orgUnitId?: string; readerId?: string | null },
  ) {
    if (body.orgUnitId !== undefined) {
      const org = await tx.orgUnit.findFirst({
        where: { tenantId: ctx.tenantId, id: body.orgUnitId },
      });
      if (!org) throw new BadRequestException({ code: 'ORG_UNIT_NOT_FOUND' });
      if (!orgInScope(ctx, body.orgUnitId)) throw outOfScope();
    }
    if (body.readerId !== undefined && body.readerId !== null) {
      const reader = await tx.staff.findFirst({
        where: { tenantId: ctx.tenantId, id: body.readerId },
      });
      if (!reader) throw new BadRequestException({ code: 'READER_NOT_FOUND' });
    }
  }

  /**
   * Cadence/meterChannel/anchorPeriod wire validation — mirrors the DB
   * CHECKs so bad input is a 422 here, never a 500 from the constraint.
   * For PATCH the caller passes the MERGED cadence/anchor (patch value
   * falling back to the stored row) so switching MONTHLY→BIMONTHLY
   * without an anchor is refused too.
   */
  private validateCadence(
    cadence: BookCadence | undefined,
    anchorPeriod: string | null | undefined,
    meterChannel: MeterChannel | undefined,
  ) {
    if (cadence !== undefined && !BOOK_CADENCES.includes(cadence)) {
      throw new UnprocessableEntityException({ code: 'INVALID_CADENCE' });
    }
    if (meterChannel !== undefined && !METER_CHANNELS.includes(meterChannel)) {
      throw new UnprocessableEntityException({ code: 'INVALID_METER_CHANNEL' });
    }
    if (
      anchorPeriod !== undefined &&
      anchorPeriod !== null &&
      !isValidPeriod(anchorPeriod)
    ) {
      throw new UnprocessableEntityException({ code: 'INVALID_ANCHOR_PERIOD' });
    }
    if (cadence === 'BIMONTHLY' && (anchorPeriod ?? null) === null) {
      throw new UnprocessableEntityException({ code: 'BIMONTHLY_ANCHOR_REQUIRED' });
    }
  }

  /** POST — book_no from sys_sequence ('B' prefix) unless explicitly supplied. */
  async createTx(tx: Prisma.TransactionClient, ctx: TenantCtx, body: ReadingBookBody) {
    if (!body.name || !body.orgUnitId) {
      throw new BadRequestException({ code: 'BOOK_FIELDS_REQUIRED' });
    }
    this.validateCadence(body.cadence, body.anchorPeriod, body.meterChannel);
    await this.assertRefs(tx, ctx, body);
    const bookNo =
      body.bookNo?.trim() ||
      (await this.seq.nextFormatted(tx, ctx.tenantId, 'book_no', 'B', ctx.staffId));
    return conflictOnUnique(
      tx.readingBook.create({
        data: {
          tenantId: ctx.tenantId,
          bookNo,
          name: body.name,
          orgUnitId: body.orgUnitId,
          readerId: body.readerId ?? null,
          scheduleDay: body.scheduleDay ?? null,
          cadence: body.cadence ?? 'MONTHLY',
          anchorPeriod: body.anchorPeriod ?? null,
          meterChannel: body.meterChannel ?? 'MECHANICAL',
          createdBy: ctx.staffId,
          updatedBy: ctx.staffId,
        },
        select: READING_BOOK_SELECT,
      }),
    );
  }

  /** PATCH — profile fields (name/orgUnitId/readerId/scheduleDay); book_no immutable. */
  async updateTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    id: string,
    body: ReadingBookPatchBody,
    req: Request,
  ) {
    const existing = await this.assertBookInScope(tx, ctx, id);
    this.validateCadence(
      body.cadence ?? (existing.cadence as BookCadence),
      body.anchorPeriod === undefined ? existing.anchorPeriod : body.anchorPeriod,
      body.meterChannel,
    );
    await this.assertRefs(tx, ctx, body);
    req.auditBefore = existing;
    return tx.readingBook.update({
      where: { id },
      data: {
        name: body.name,
        orgUnitId: body.orgUnitId,
        readerId: body.readerId === undefined ? undefined : body.readerId,
        scheduleDay: body.scheduleDay === undefined ? undefined : body.scheduleDay,
        cadence: body.cadence,
        anchorPeriod: body.anchorPeriod === undefined ? undefined : body.anchorPeriod,
        meterChannel: body.meterChannel,
        updatedBy: ctx.staffId,
      },
      select: READING_BOOK_SELECT,
    });
  }

  /**
   * DELETE — refuses while the book has generated plans: reading_plan.book_id
   * is a plain column (no FK by design — the plan must outlive membership and
   * even the book itself as an audit artifact), so the guard is in code.
   */
  async deleteTx(tx: Prisma.TransactionClient, ctx: TenantCtx, id: string, req: Request) {
    const existing = await this.assertBookInScope(tx, ctx, id);
    // Serialize with generateTx (which takes the same FOR UPDATE lock):
    // without it a concurrent generate could commit a plan between the count
    // below and the delete, leaving a plan dangling on a deleted book_id.
    await tx.$queryRaw`
      SELECT id FROM reading_book
      WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${id}::uuid
      FOR UPDATE`;
    const plans = await tx.readingPlan.count({
      where: { tenantId: ctx.tenantId, bookId: id },
    });
    if (plans > 0) {
      throw new BadRequestException({ code: 'BOOK_HAS_PLANS' });
    }
    req.auditBefore = existing;
    await tx.bookMeter.deleteMany({ where: { tenantId: ctx.tenantId, bookId: id } });
    await tx.readingBook.delete({ where: { id } });
    return { id, deleted: true };
  }

  /**
   * Add a water account to the book (book_meter). The account must exist and
   * not be CLOSED — a closed point has nothing to read. seq_no defaults to
   * max+1 (append at the end of the route); the (book_id, water_account_id)
   * PK dedupes a double-add → 409.
   */
  async addMemberTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    bookId: string,
    body: BookMemberBody,
  ) {
    await this.assertBookInScope(tx, ctx, bookId);
    if (!body.waterAccountId) {
      throw new BadRequestException({ code: 'BOOK_MEMBER_FIELDS_REQUIRED' });
    }
    const account = await tx.waterAccount.findFirst({
      where: { tenantId: ctx.tenantId, id: body.waterAccountId },
    });
    if (!account) throw new BadRequestException({ code: 'WATER_ACCOUNT_NOT_FOUND' });
    if (account.status === 'CLOSED') {
      throw new BadRequestException({ code: 'ACCOUNT_CLOSED' });
    }
    let seqNo = body.seqNo;
    if (seqNo === undefined) {
      const agg = await tx.bookMeter.aggregate({
        where: { tenantId: ctx.tenantId, bookId },
        _max: { seqNo: true },
      });
      seqNo = (agg._max.seqNo ?? 0) + 1;
    }
    return conflictOnUnique(
      tx.bookMeter.create({
        data: {
          tenantId: ctx.tenantId,
          bookId,
          waterAccountId: body.waterAccountId,
          seqNo,
          createdBy: ctx.staffId,
          updatedBy: ctx.staffId,
        },
      }),
    );
  }

  /** Remove an account from the book; already-generated plans are unaffected. */
  async removeMemberTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    bookId: string,
    waterAccountId: string,
    req: Request,
  ) {
    await this.assertBookInScope(tx, ctx, bookId);
    const member = await tx.bookMeter.findFirst({
      where: { tenantId: ctx.tenantId, bookId, waterAccountId },
    });
    if (!member) {
      throw new NotFoundException({ code: 'BOOK_MEMBER_NOT_FOUND' });
    }
    req.auditBefore = member;
    await tx.bookMeter.deleteMany({
      where: { tenantId: ctx.tenantId, bookId, waterAccountId },
    });
    return { bookId, waterAccountId, removed: true };
  }
}
