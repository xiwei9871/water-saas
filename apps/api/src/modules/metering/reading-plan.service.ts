import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { isBookDue, type BookCadence } from '../../common/reading-cadence.js';
import { orgInScope, type TenantCtx } from '../../common/tenant-context.js';
import {
  embedOrgNames,
  embedStaffNames,
} from '../../common/account-identity.js';
import { assertAccountScopeTx } from '../../common/account-scope.js';
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
    q: {
      take: number;
      skip: number;
      bookId?: string;
      period?: string;
      status?: PlanStatus;
      waterAccountId?: string;
    },
  ) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      // E8: scoped callers see only plans whose book's org is in their
      // subtree. Explicit waterAccountId (360 currentPlanItems) asserts
      // account scope, then matches plans containing that account's item —
      // the item comes back embedded as `myItem`.
      if (q.waterAccountId) {
        await assertAccountScopeTx(tx, ctx, q.waterAccountId);
      }
      // reading_plan→reading_book has no ORM relation either — scope via
      // an explicit in-scope bookId list.
      const scopedBookIds =
        ctx.scope === 'ALL'
          ? undefined
          : (
              await tx.readingBook.findMany({
                where: { tenantId: ctx.tenantId, orgUnitId: { in: ctx.orgScope } },
                select: { id: true },
              })
            ).map((b) => b.id);
      const rows = await tx.readingPlan.findMany({
        where: {
          tenantId: ctx.tenantId,
          bookId: q.bookId ?? (scopedBookIds ? { in: scopedBookIds } : undefined),
          period: q.period,
          status: q.status,
          ...(q.waterAccountId
            ? { items: { some: { waterAccountId: q.waterAccountId } } }
            : {}),
        },
        select: {
          ...READING_PLAN_SELECT,
          ...(q.waterAccountId
            ? {
                items: {
                  where: { waterAccountId: q.waterAccountId },
                  select: PLAN_ITEM_SELECT,
                },
              }
            : {}),
        },
        orderBy: [{ period: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
        take: q.take,
        skip: q.skip,
      });
      const plans = rows.map((r) => {
        const { items, ...plan } = r as typeof r & { items?: unknown[] };
        return { ...plan, ...(items ? { myItem: items[0] ?? null } : {}) };
      });
      return this.embedBookAndReader(tx, ctx, plans);
    });
  }

  /**
   * 10/8 报告 §3：计划行内嵌 册号/册名/所属组织名/抄表员姓名 ——
   * book_id 是裸列无 ORM 关系，批量二次查询后统一水合；无 iam:read
   * 的角色不再看到截断 uuid。
   */
  private async embedBookAndReader<
    T extends { bookId: string; readerId?: string | null },
  >(tx: Prisma.TransactionClient, ctx: TenantCtx, rows: T[]) {
    const bookIds = [...new Set(rows.map((r) => r.bookId))];
    const books = bookIds.length
      ? await tx.readingBook.findMany({
          where: { tenantId: ctx.tenantId, id: { in: bookIds } },
          select: { id: true, bookNo: true, name: true, orgUnitId: true },
        })
      : [];
    const byBook = new Map(books.map((b) => [b.id, b]));
    const withBook = rows.map((r) => {
      const b = byBook.get(r.bookId);
      return {
        ...r,
        bookNo: b?.bookNo ?? null,
        bookName: b?.name ?? null,
        orgUnitId: b?.orgUnitId ?? null,
      };
    });
    return embedOrgNames(
      tx,
      ctx.tenantId,
      await embedStaffNames(tx, ctx.tenantId, withBook, {
        readerId: 'readerName',
      }),
      { orgUnitId: 'orgUnitName' },
    );
  }

  async getById(ctx: TenantCtx, id: string) {
    const row = await this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const plan = await tx.readingPlan.findFirst({
        where: { tenantId: ctx.tenantId, id },
        select: {
          ...READING_PLAN_SELECT,
          items: { select: PLAN_ITEM_SELECT, orderBy: { seqNo: 'asc' } },
        },
      });
      if (!plan) return null;
      await this.assertPlanBookInScope(tx, ctx, plan.bookId);
      const items = await this.embedItemReadings(tx, ctx.tenantId, plan.items, plan.period);
      const [enriched] = await this.embedBookAndReader(tx, ctx, [plan]);
      return { ...enriched, items };
    });
    if (!row) throw new NotFoundException({ code: 'PLAN_NOT_FOUND' });
    return row;
  }

  /**
   * 10/12 报告 §3：计划明细人读化 —— 完成读数显示读数值而非读数 id；
   * 并补"上一期抄表止度"（该计划表计在本期之前最后一条未被更正的
   * 表度读数），供抄表员对照突增突减。
   */
  private async embedItemReadings<
    T extends {
      completedReadingId: string | null;
      plannedInstallationId: string | null;
      waterAccountId: string;
    },
  >(
    tx: Prisma.TransactionClient,
    tenantId: string,
    items: T[],
    planPeriod: string,
  ) {
    const acctIds = [...new Set(items.map((i) => i.waterAccountId))];
    const accounts = acctIds.length
      ? await tx.waterAccount.findMany({
          where: { tenantId, id: { in: acctIds } },
          select: {
            id: true,
            accountNo: true,
            addr: true,
            usageCategory: true,
            customer: { select: { name: true, phone: true } },
          },
        })
      : [];
    const acctMap = new Map(accounts.map((a) => [a.id, a]));
    const completedIds = [
      ...new Set(
        items.map((i) => i.completedReadingId).filter((v): v is string => !!v),
      ),
    ];
    const completed = completedIds.length
      ? await tx.meterReading.findMany({
          where: { tenantId, id: { in: completedIds } },
          select: { id: true, readingValue: true },
        })
      : [];
    const cvMap = new Map(completed.map((r) => [r.id, r.readingValue?.toString() ?? null]));
    const instIds = [
      ...new Set(
        items
          .map((i) => i.plannedInstallationId)
          .filter((v): v is string => !!v),
      ),
    ];
    const prevRows = instIds.length
      ? await tx.$queryRaw<{ installation_id: string; reading_value: string | null }[]>`
          SELECT DISTINCT ON (r.installation_id)
                 r.installation_id, r.reading_value::text AS reading_value
            FROM meter_reading r
           WHERE r.tenant_id = ${tenantId}::uuid
             AND r.installation_id IN (${Prisma.join(instIds.map((i) => Prisma.sql`${i}::uuid`))})
             AND r.period < ${planPeriod}
             AND r.reading_value IS NOT NULL
             AND NOT EXISTS (
                   SELECT 1 FROM meter_reading c
                    WHERE c.tenant_id = r.tenant_id
                      AND c.supersedes_reading_id = r.id)
           ORDER BY r.installation_id, r.period DESC, r.created_at DESC`
      : [];
    const pvMap = new Map(prevRows.map((r) => [r.installation_id, r.reading_value]));
    const insts = instIds.length
      ? await tx.meterInstallation.findMany({
          where: { tenantId, id: { in: instIds } },
          select: {
            id: true,
            locationRemark: true,
            meter: { select: { meterNo: true, caliber: true } },
          },
        })
      : [];
    const instMap = new Map(insts.map((r) => [r.id, r]));
    return items.map((i) => {
      const acct = acctMap.get(i.waterAccountId);
      return {
        ...i,
        accountNo: acct?.accountNo ?? null,
        customerName: acct?.customer.name ?? null,
        addr: acct?.addr ?? null,
        usageCategory: acct?.usageCategory ?? null,
        phone: acct?.customer.phone ?? null,
        meterNo: i.plannedInstallationId
          ? (instMap.get(i.plannedInstallationId)?.meter.meterNo ?? null)
          : null,
        caliber: i.plannedInstallationId
          ? (instMap.get(i.plannedInstallationId)?.meter.caliber ?? null)
          : null,
        locationRemark: i.plannedInstallationId
          ? (instMap.get(i.plannedInstallationId)?.locationRemark ?? null)
          : null,
        completedReadingValue: i.completedReadingId
          ? (cvMap.get(i.completedReadingId) ?? null)
          : null,
        prevReadingValue: i.plannedInstallationId
          ? (pvMap.get(i.plannedInstallationId) ?? null)
          : null,
      };
    });
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
        select: { id: true, bookId: true, period: true },
      });
      if (!plan) throw new NotFoundException({ code: 'PLAN_NOT_FOUND' });
      await this.assertPlanBookInScope(tx, ctx, plan.bookId);
      const items = await tx.readingPlanItem.findMany({
        where: { tenantId: ctx.tenantId, planId, status: q.status },
        select: PLAN_ITEM_SELECT,
        orderBy: { seqNo: 'asc' },
        take: q.take,
        skip: q.skip,
      });
      return this.embedItemReadings(tx, ctx.tenantId, items, plan.period);
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
        select: { id: true, status: true, bookId: true },
      });
      if (!plan) throw new NotFoundException({ code: 'PLAN_NOT_FOUND' });
      await this.assertPlanBookInScope(tx, ctx, plan.bookId);
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
      {
        id: string;
        org_unit_id: string;
        reader_id: string | null;
        cadence: string;
        anchor_period: string | null;
      }[]
    >`
      SELECT id, org_unit_id, reader_id, cadence, anchor_period FROM reading_book
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
    // Non-due periods (e.g. an off-cycle catch-up on a BIMONTHLY book) are
    // legal operational cases — warn, never block. The backend owns the
    // due math; the UI only surfaces this flag.
    const cadenceWarning = isBookDue(
      book.cadence as BookCadence,
      book.anchor_period,
      body.period,
    )
      ? null
      : 'BOOK_NOT_DUE_THIS_PERIOD';
    return { ...plan, items, cadenceWarning };
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
