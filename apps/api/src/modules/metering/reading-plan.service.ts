import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { orgInScope, type TenantCtx } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';

export const READING_PLAN_SELECT = {
  id: true,
  tenantId: true,
  bookId: true,
  period: true,
  planDate: true,
  readerId: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ReadingPlanSelect;

export const PLAN_ITEM_SELECT = {
  id: true,
  tenantId: true,
  planId: true,
  waterAccountId: true,
  seqNo: true,
  plannedInstallationId: true,
  status: true,
  completedReadingId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ReadingPlanItemSelect;

export interface GenerateBody {
  bookId?: string;
  period?: string;
  planDate?: Date;
  readerId?: string;
}

type PlanStatus = 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'CLOSED';
type PlanItemStatus = 'PENDING' | 'READ' | 'NO_READ' | 'SKIPPED';

const invalidTransition = (from: string, to: string) =>
  new ConflictException({ code: 'INVALID_PLAN_STATUS_TRANSITION', from, to });

const outOfScope = () => new ForbiddenException({ code: 'ORG_OUT_OF_SCOPE' });

/**
 * ReadingPlan （抄表计划） + ReadingPlanItem （生成时刻的册成员快照） —
 * spec §2.2/§6.5: a plan freezes the book's membership at generation time;
 * later book_meter changes never retro-edit plan items, and progress/
 * completion statistics read items, not the live book.
 *
 * Status machine (schema enum): OPEN → IN_PROGRESS → DONE → CLOSED.
 * There is NO CANCELLED status — "cancel" lands on CLOSED (the enum's only
 * terminal-inactive state), so the generate dedupe below treats CLOSED as
 * "not live": a cancelled plan frees the book+period slot. (A DONE→CLOSED
 * archive frees it too — same row state, same MVP semantics.)
 */
@Injectable()
export class ReadingPlanService {
  constructor(private readonly prisma: TenantPrismaService) {}

  list(
    ctx: TenantCtx,
    q: { take: number; skip: number; bookId?: string; period?: string; status?: PlanStatus },
  ) {
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.readingPlan.findMany({
        where: {
          tenantId: ctx.tenantId,
          bookId: q.bookId,
          period: q.period,
          status: q.status,
        },
        select: READING_PLAN_SELECT,
        orderBy: [{ period: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
        take: q.take,
        skip: q.skip,
      }),
    );
  }

  async getById(ctx: TenantCtx, id: string) {
    const row = await this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.readingPlan.findFirst({
        where: { tenantId: ctx.tenantId, id },
        select: { ...READING_PLAN_SELECT, items: { select: PLAN_ITEM_SELECT, orderBy: { seqNo: 'asc' } } },
      }),
    );
    if (!row) throw new NotFoundException({ code: 'PLAN_NOT_FOUND' });
    return row;
  }

  /** Paginated plan items (?status= filter); ordered by the snapshot seq_no. */
  async items(
    ctx: TenantCtx,
    planId: string,
    q: { take: number; skip: number; status?: PlanItemStatus },
  ) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const plan = await tx.readingPlan.findFirst({
        where: { tenantId: ctx.tenantId, id: planId },
        select: { id: true },
      });
      if (!plan) throw new NotFoundException({ code: 'PLAN_NOT_FOUND' });
      return tx.readingPlanItem.findMany({
        where: { tenantId: ctx.tenantId, planId, status: q.status },
        select: PLAN_ITEM_SELECT,
        orderBy: { seqNo: 'asc' },
        take: q.take,
        skip: q.skip,
      });
    });
  }

  /**
   * Progress counters over the snapshot — {PENDING,READ,NO_READ,SKIPPED,total}.
   * All four statuses are always present (0-filled) so clients never
   * special-case a missing key.
   */
  async progress(ctx: TenantCtx, planId: string) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const plan = await tx.readingPlan.findFirst({
        where: { tenantId: ctx.tenantId, id: planId },
        select: { id: true, status: true },
      });
      if (!plan) throw new NotFoundException({ code: 'PLAN_NOT_FOUND' });
      const rows = await tx.readingPlanItem.groupBy({
        by: ['status'],
        where: { tenantId: ctx.tenantId, planId },
        _count: { _all: true },
      });
      const counts: Record<PlanItemStatus, number> = {
        PENDING: 0,
        READ: 0,
        NO_READ: 0,
        SKIPPED: 0,
      };
      let total = 0;
      for (const r of rows) {
        counts[r.status] = r._count._all;
        total += r._count._all;
      }
      return { planId, planStatus: plan.status, ...counts, total };
    });
  }

  /**
   * POST /reading-plans/generate — one transaction:
   *   1. lock the book row FOR UPDATE (serializes concurrent generates for
   *      the same book — the (book,period) dedupe below is check-then-act)
   *   2. refuse when a non-CLOSED plan already exists for (book, period)
   *   3. snapshot book_meter → reading_plan_item (dense seq_no ordered by the
   *      book's seq_no; planned_installation_id = the account's ACTIVE
   *      installation AT SNAPSHOT TIME, nullable — an account may have none)
   *
   * An empty book is rejected (EMPTY_BOOK): a plan with zero items carries
   * no work and would only confuse progress accounting — re-add members and
   * regenerate instead.
   */
  async generateTx(tx: Prisma.TransactionClient, ctx: TenantCtx, body: GenerateBody) {
    // Service-level guard: an undefined bookId/period would otherwise land in
    // the raw ::uuid cast below as the literal 'undefined' → 500.
    if (!body.bookId || !body.period) {
      throw new BadRequestException({ code: 'GENERATE_FIELDS_REQUIRED' });
    }
    const locked = await tx.$queryRaw<
      { id: string; org_unit_id: string; reader_id: string | null }[]
    >`
      SELECT id, org_unit_id, reader_id FROM reading_book
      WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${body.bookId}::uuid
      FOR UPDATE`;
    if (locked.length === 0) {
      throw new BadRequestException({ code: 'BOOK_NOT_FOUND' });
    }
    const book = locked[0];
    // Same write-path orgInScope guard as the book endpoints — a scoped
    // caller must not mint plans for a book outside their subtree.
    if (!orgInScope(ctx, book.org_unit_id)) throw outOfScope();

    const existing = await tx.readingPlan.findFirst({
      where: {
        tenantId: ctx.tenantId,
        bookId: body.bookId,
        period: body.period,
        status: { not: 'CLOSED' },
      },
      select: { id: true, status: true },
    });
    if (existing) {
      throw new ConflictException({
        code: 'PLAN_ALREADY_EXISTS',
        planId: existing.id,
        status: existing.status,
      });
    }

    const members = await tx.bookMeter.findMany({
      where: { tenantId: ctx.tenantId, bookId: body.bookId },
      orderBy: [{ seqNo: 'asc' }, { waterAccountId: 'asc' }],
    });
    // Members whose account has since been CLOSED are skipped — a closed
    // point has nothing to read and would only produce dead plan items.
    const liveAccounts = await tx.waterAccount.findMany({
      where: {
        tenantId: ctx.tenantId,
        id: { in: members.map((m) => m.waterAccountId) },
        status: { not: 'CLOSED' },
      },
      select: { id: true },
    });
    const liveIds = new Set(liveAccounts.map((a) => a.id));
    const liveMembers = members.filter((m) => liveIds.has(m.waterAccountId));
    if (liveMembers.length === 0) {
      throw new BadRequestException({ code: 'EMPTY_BOOK' });
    }

    // Snapshot-time ACTIVE installation per account. The schema deliberately
    // allows several ACTIVE installations per water_account （一户多表 phase-2);
    // MVP picks the latest installed_at — reading time (T6) re-resolves the
    // then-current ACTIVE installation anyway, this column is only the plan's
    // snapshot of what we expected to read.
    const actives = await tx.meterInstallation.findMany({
      where: {
        tenantId: ctx.tenantId,
        waterAccountId: { in: liveMembers.map((m) => m.waterAccountId) },
        status: 'ACTIVE',
      },
      select: { id: true, waterAccountId: true, installedAt: true },
      orderBy: { installedAt: 'desc' },
    });
    const plannedByAccount = new Map<string, string>();
    for (const inst of actives) {
      if (!plannedByAccount.has(inst.waterAccountId)) {
        plannedByAccount.set(inst.waterAccountId, inst.id);
      }
    }

    const readerId = body.readerId ?? book.reader_id ?? null;
    if (readerId) {
      const reader = await tx.staff.findFirst({
        where: { tenantId: ctx.tenantId, id: readerId },
      });
      if (!reader) throw new BadRequestException({ code: 'READER_NOT_FOUND' });
    }

    const plan = await tx.readingPlan.create({
      data: {
        tenantId: ctx.tenantId,
        bookId: body.bookId!,
        period: body.period!,
        planDate: body.planDate ?? new Date(),
        readerId,
        status: 'OPEN',
        createdBy: ctx.staffId,
        updatedBy: ctx.staffId,
      },
      select: READING_PLAN_SELECT,
    });

    // Dense 1..n seq_no in book order — book_meter.seq_no may carry gaps or
    // caller-supplied duplicates, while reading_plan_item enforces
    // UNIQUE(plan_id, seq_no); only the *ordering* is snapshotted.
    await tx.readingPlanItem.createMany({
      data: liveMembers.map((m, i) => ({
        tenantId: ctx.tenantId,
        planId: plan.id,
        waterAccountId: m.waterAccountId,
        seqNo: i + 1,
        plannedInstallationId: plannedByAccount.get(m.waterAccountId) ?? null,
        status: 'PENDING' as const,
        createdBy: ctx.staffId,
        updatedBy: ctx.staffId,
      })),
    });

    const items = await tx.readingPlanItem.findMany({
      where: { tenantId: ctx.tenantId, planId: plan.id },
      select: PLAN_ITEM_SELECT,
      orderBy: { seqNo: 'asc' },
    });
    return { ...plan, items };
  }

  /**
   * Plans act on books — a plan write is only allowed when the parent book's
   * org_unit sits inside the caller's data scope (same guard as the book
   * endpoints; bookId is a plain column so the org lookup is a second query).
   */
  private async assertPlanBookInScope(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    bookId: string,
  ) {
    const book = await tx.readingBook.findFirst({
      where: { tenantId: ctx.tenantId, id: bookId },
      select: { orgUnitId: true },
    });
    if (!book) throw new NotFoundException({ code: 'BOOK_NOT_FOUND' });
    if (!orgInScope(ctx, book.orgUnitId)) throw outOfScope();
  }

  /** OPEN → IN_PROGRESS （抄表开始）. Guarded write, same pattern as T4. */
  async startTx(tx: Prisma.TransactionClient, ctx: TenantCtx, id: string, req: Request) {
    const existing = await tx.readingPlan.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!existing) throw new NotFoundException({ code: 'PLAN_NOT_FOUND' });
    await this.assertPlanBookInScope(tx, ctx, existing.bookId);
    if (existing.status !== 'OPEN') throw invalidTransition(existing.status, 'IN_PROGRESS');
    req.auditBefore = existing;
    const flipped = await tx.readingPlan.updateMany({
      where: { tenantId: ctx.tenantId, id, status: 'OPEN' },
      data: { status: 'IN_PROGRESS', updatedBy: ctx.staffId },
    });
    if (flipped.count === 0) throw invalidTransition(existing.status, 'IN_PROGRESS');
    return tx.readingPlan.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: ctx.tenantId, id } },
      select: READING_PLAN_SELECT,
    });
  }

  /**
   * OPEN|IN_PROGRESS → CLOSED （取消）. Already-READ items keep their status —
   * the snapshot is history, cancel only stops the remaining work; DONE and
   * already-CLOSED plans refuse.
   */
  async cancelTx(tx: Prisma.TransactionClient, ctx: TenantCtx, id: string, req: Request) {
    const existing = await tx.readingPlan.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!existing) throw new NotFoundException({ code: 'PLAN_NOT_FOUND' });
    await this.assertPlanBookInScope(tx, ctx, existing.bookId);
    const cancellable: PlanStatus[] = ['OPEN', 'IN_PROGRESS'];
    if (!cancellable.includes(existing.status)) {
      throw invalidTransition(existing.status, 'CLOSED');
    }
    req.auditBefore = existing;
    const flipped = await tx.readingPlan.updateMany({
      where: { tenantId: ctx.tenantId, id, status: { in: cancellable } },
      data: { status: 'CLOSED', updatedBy: ctx.staffId },
    });
    if (flipped.count === 0) throw invalidTransition(existing.status, 'CLOSED');
    return tx.readingPlan.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: ctx.tenantId, id } },
      select: READING_PLAN_SELECT,
    });
  }
}
