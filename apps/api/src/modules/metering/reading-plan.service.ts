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
import {
  calendarOverrides,
  isRemoteZone,
  monthEndReserveOf,
  segmentCalendar,
  workdayIndex,
  collectModeOf,
} from '../../common/metering-model.js';
import { orgInScope, type TenantCtx } from '../../common/tenant-context.js';
import {
  embedOrgNames,
  embedStaffNames,
} from '../../common/account-identity.js';
import { assertAccountScopeTx } from '../../common/account-scope.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { TaskService } from '../task/task.service.js';

export const READING_PLAN_SELECT = {
  id: true,
  tenantId: true,
  bookId: true,
  period: true,
  planDate: true,
  readerId: true,
  status: true,
  planType: true,
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
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly tasks: TaskService,
  ) {}

  list(
    ctx: TenantCtx,
    q: {
      take: number;
      skip: number;
      bookId?: string;
      period?: string;
      status?: PlanStatus;
      waterAccountId?: string;
      planType?: string;
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
          planType: q.planType,
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
        status: string;
      }[]
    >`
      SELECT id, org_unit_id, reader_id, cadence, anchor_period, status FROM reading_book
      WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${body.bookId}::uuid
      FOR UPDATE`;
    if (locked.length === 0) {
      throw new BadRequestException({ code: 'BOOK_NOT_FOUND' });
    }
    const book = locked[0];
    if (book.status === 'DISABLED') {
      throw new ConflictException({ code: 'BOOK_DISABLED' });
    }
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
    // 1102 R13/R4/R15：计划归集改按用户级频次判断「本月是否该抄」，
    // 远传区号户不派人工计划，顺序按用户级路线键 routeKey。
    const liveAccounts = await tx.waterAccount.findMany({
      where: {
        tenantId: ctx.tenantId,
        id: { in: members.map((m) => m.waterAccountId) },
        status: { notIn: ['CLOSED', 'RETURNED'] },
      },
      select: {
        id: true,
        cadence: true,
        anchorPeriod: true,
        zoneNo: true,
        routeKey: true,
        addr: true,
        archiveNo: true,
        accountNo: true,
      },
    });
    const acctById = new Map(liveAccounts.map((a) => [a.id, a]));
    const dueMembers = members.filter((m) => {
      const a = acctById.get(m.waterAccountId);
      if (!a || isRemoteZone(a.zoneNo)) return false;
      return isBookDue(
        a.cadence as BookCadence,
        a.anchorPeriod,
        body.period!,
      );
    });
    if (dueMembers.length === 0) {
      throw new BadRequestException({ code: 'EMPTY_BOOK' });
    }
    // R15 冷启动：无 routeKey 的户按「地址 → 档案号/户号」初始赋键，
    // 从当前最大键续排；已有键不动（跨频次稳定）。
    const keyed = dueMembers
      .map((m) => acctById.get(m.waterAccountId)!)
      .filter((a) => a.routeKey !== null);
    const maxKey = keyed.reduce(
      (mx, a) => Math.max(mx, Number(a.routeKey)),
      0,
    );
    const unkeyed = dueMembers
      .map((m) => acctById.get(m.waterAccountId)!)
      .filter((a) => a.routeKey === null)
      .sort((x, y) =>
        `${x.addr ?? ''}|${x.archiveNo ?? x.accountNo}`.localeCompare(
          `${y.addr ?? ''}|${y.archiveNo ?? y.accountNo}`,
        ),
      );
    for (let i = 0; i < unkeyed.length; i++) {
      const k = maxKey + 1000 * (i + 1);
      await tx.waterAccount.update({
        where: { id: unkeyed[i].id },
        data: { routeKey: k, updatedBy: ctx.staffId },
      });
      unkeyed[i].routeKey = new Prisma.Decimal(k);
    }
    // 计划顺序 = routeKey 升序（键相同/空缺按册内序号兜底）。
    const liveMembers = [...dueMembers].sort((a, b) => {
      const ka = Number(acctById.get(a.waterAccountId)!.routeKey ?? 9e18);
      const kb = Number(acctById.get(b.waterAccountId)!.routeKey ?? 9e18);
      return ka - kb || a.seqNo - b.seqNo;
    });

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
    // 1102：频次已归属用户——计划项只含本月该抄的户；book.cadence 为
    // 历史兼容列不再参与归集。跳过成员数透传给前端提示。
    const skipped = members.length - liveMembers.length;
    const cadenceWarning = skipped > 0 ? 'SOME_MEMBERS_NOT_DUE' : null;
    return { ...plan, items, cadenceWarning, skippedNotDue: skipped };
  }

  /**
   * 20261026 追加抄表独立功能：POST /reading-plans/supplement ——
   * 计划/任务层主动发起（未抄先派单），与读数层「更正→追加」并存。
   *
   * 一单事务内：账户范围校验 → 反查所属册（无册→系统册兜底）→
   * 业务键幂等（同户同期在途 SUPPLEMENT 计划复用）→ 建单户计划
   * （planType=SUPPLEMENT、1 个 planItem）→ 建 SUPPLEMENT_READING
   * 任务直接指派给抄表员（ASSIGNED 进其待办，走任务闭环）。
   */
  async supplementTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    body: {
      waterAccountId: string;
      period: string;
      planDate?: Date;
      readerId: string;
      remark?: string;
    },
  ) {
    if (!body.waterAccountId || !body.period || !body.readerId) {
      throw new BadRequestException({ code: 'SUPPLEMENT_FIELDS_REQUIRED' });
    }
    await assertAccountScopeTx(tx, ctx, body.waterAccountId);
    const wa = await tx.waterAccount.findFirst({
      where: { tenantId: ctx.tenantId, id: body.waterAccountId },
      select: { id: true, accountNo: true, status: true },
    });
    if (!wa) throw new NotFoundException({ code: 'WATER_ACCOUNT_NOT_FOUND' });
    if (wa.status === 'CLOSED') {
      throw new BadRequestException({ code: 'ACCOUNT_CLOSED' });
    }
    // V6：抄表员必填且必须是本租户在职员工（未入册户前端强制手选，
    // 服务端同检，不靠 UI 把关）。
    const reader = await tx.staff.findFirst({
      where: { tenantId: ctx.tenantId, id: body.readerId, status: 'ACTIVE' },
      select: { id: true, name: true },
    });
    if (!reader) throw new BadRequestException({ code: 'READER_NOT_FOUND' });

    const bookId = await this.resolveSupplementBookId(tx, ctx, body.waterAccountId);

    // 业务键幂等：同户同期已有在途追加计划 → 复用（重试/双击不多建）。
    const existing = await tx.readingPlan.findFirst({
      where: {
        tenantId: ctx.tenantId,
        planType: 'SUPPLEMENT',
        period: body.period,
        status: { not: 'CLOSED' },
        items: { some: { waterAccountId: body.waterAccountId } },
      },
      select: READING_PLAN_SELECT,
    });
    if (existing) {
      const [items, task] = await Promise.all([
        tx.readingPlanItem.findMany({
          where: { tenantId: ctx.tenantId, planId: existing.id },
          select: PLAN_ITEM_SELECT,
          orderBy: { seqNo: 'asc' },
        }),
        tx.task.findFirst({
          where: {
            tenantId: ctx.tenantId,
            type: 'SUPPLEMENT_READING',
            bizType: 'readingPlan',
            bizId: existing.id,
            status: { in: ['PENDING', 'CLAIMED', 'ASSIGNED'] },
          },
          select: { id: true },
        }),
      ]);
      return { ...existing, items, taskId: task?.id ?? null, deduped: true };
    }

    const inst = await tx.meterInstallation.findFirst({
      where: {
        tenantId: ctx.tenantId,
        waterAccountId: body.waterAccountId,
        status: 'ACTIVE',
      },
      select: { id: true },
      orderBy: { installedAt: 'desc' },
    });
    const plan = await tx.readingPlan.create({
      data: {
        tenantId: ctx.tenantId,
        bookId,
        period: body.period,
        planDate: body.planDate ?? new Date(),
        readerId: body.readerId,
        status: 'OPEN',
        planType: 'SUPPLEMENT',
        createdBy: ctx.staffId,
        updatedBy: ctx.staffId,
      },
      select: READING_PLAN_SELECT,
    });
    const item = await tx.readingPlanItem.create({
      data: {
        tenantId: ctx.tenantId,
        planId: plan.id,
        waterAccountId: body.waterAccountId,
        seqNo: 1,
        plannedInstallationId: inst?.id ?? null,
        status: 'PENDING',
        createdBy: ctx.staffId,
        updatedBy: ctx.staffId,
      },
      select: PLAN_ITEM_SELECT,
    });
    const task = await this.tasks.createTask(tx, ctx, {
      type: 'SUPPLEMENT_READING',
      title: `追加抄表：户 ${wa.accountNo} 账期 ${body.period}`,
      bizType: 'readingPlan',
      bizId: plan.id,
      bizLabel: `${wa.accountNo}·${body.period} 追加抄表`,
      reason: body.remark ? `追加抄表下达：${body.remark}` : '追加抄表下达',
      context: {
        waterAccountId: body.waterAccountId,
        waterAccountNo: wa.accountNo,
        period: body.period,
        planId: plan.id,
        planItemId: item.id,
        readerName: reader.name,
        remark: body.remark ?? null,
      } as Prisma.InputJsonValue,
      assigneeId: body.readerId,
    });
    return { ...plan, items: [item], taskId: task.id, deduped: false };
  }

  /**
   * 追加计划的册归属：账户在册 → 挂该册（计划随册组织可见）；未入册 →
   * 租户级系统册「追加抄表册」（book_no=SYS-SUP，自动建立，锚定下达人
   * 所在组织，scoped 操作员在自己的子树内可见）。
   */
  private async resolveSupplementBookId(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    waterAccountId: string,
  ): Promise<string> {
    const membership = await tx.bookMeter.findFirst({
      where: { tenantId: ctx.tenantId, waterAccountId },
      select: { bookId: true },
    });
    if (membership) return membership.bookId;

    const sysBookNo = 'SYS-SUP';
    const found = await tx.readingBook.findFirst({
      where: { tenantId: ctx.tenantId, bookNo: sysBookNo },
      select: { id: true },
    });
    if (found) return found.id;

    const issuer = await tx.staff.findFirst({
      where: { tenantId: ctx.tenantId, id: ctx.staffId },
      select: { orgUnitId: true },
    });
    const fallbackOrg = issuer?.orgUnitId
      ?? ctx.orgScope[0]
      ?? (
          await tx.orgUnit.findFirst({
            where: { tenantId: ctx.tenantId, parentId: null },
            select: { id: true },
          })
        )?.id
      ?? (
          await tx.orgUnit.findFirst({
            where: { tenantId: ctx.tenantId },
            select: { id: true },
          })
        )?.id;
    if (!fallbackOrg) {
      throw new BadRequestException({ code: 'ORG_UNIT_MISSING' });
    }
    try {
      const created = await tx.readingBook.create({
        data: {
          tenantId: ctx.tenantId,
          bookNo: sysBookNo,
          name: '追加抄表册（系统）',
          orgUnitId: fallbackOrg,
          cadence: 'MONTHLY',
          meterChannel: 'MECHANICAL',
          createdBy: ctx.staffId,
          updatedBy: ctx.staffId,
        },
        select: { id: true },
      });
      return created.id;
    } catch (e) {
      // 并发首建：唯一键 (tenant_id, book_no) 冲突 → 直接取已建行。
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const retry = await tx.readingBook.findFirst({
          where: { tenantId: ctx.tenantId, bookNo: sysBookNo },
          select: { id: true },
        });
        if (retry) return retry.id;
      }
      throw e;
    }
  }

  /**
   * R5 自动生成次日计划：baseDate 的下一个工作日若是当月第 N 个抄表段，
   * 为段号=N 的在用区段册生成次日计划（planDate=次日，幂等跳过已生成）。
   * 「抄表员直管」区号册（segNo 空）在第 1 个工作日随段号 01 一并生成。
   */
  async autoGenerateForDate(ctx: TenantCtx, baseDate: Date) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const y = baseDate.getFullYear();
      const m = baseDate.getMonth();
      const overrides = await calendarOverrides(
        tx, ctx.tenantId, new Date(y, m - 1, 1), new Date(y, m + 2, 0),
      );
      const next = new Date(y, m, baseDate.getDate() + 1);
      const idx = workdayIndex(next, overrides);
      if (idx === null) return { segNo: null, planDate: null, generated: [] as string[] };
      const period = `${next.getFullYear()}${String(next.getMonth() + 1).padStart(2, '0')}`;
      const reserve = await monthEndReserveOf(tx, ctx.tenantId);
      const segs = segmentCalendar(period, overrides, reserve);
      if (idx > segs.length) {
        return { segNo: null, planDate: next, generated: [] as string[] };
      }
      const segNo = segs[idx - 1].segNo;
      // 段号册（segNo=N）+ 直管区号册（N=1 时 segNo 为空的一并生成）。
      const books = await tx.readingBook.findMany({
        where: {
          tenantId: ctx.tenantId,
          status: 'ACTIVE',
          OR: idx === 1 ? [{ segNo }, { segNo: null }] : [{ segNo }],
        },
        select: { id: true, zoneNo: true, segNo: true },
      });
      const generated: string[] = [];
      for (const b of books) {
        if (isRemoteZone(b.zoneNo)) continue; // R4-2 远传不派人工计划
        const exists = await tx.readingPlan.findFirst({
          where: {
            tenantId: ctx.tenantId,
            bookId: b.id,
            period,
            status: { not: 'CLOSED' },
          },
          select: { id: true },
        });
        if (exists) continue; // 幂等：同册同期已生成跳过
        try {
          await this.generateTx(tx, ctx, {
            bookId: b.id,
            period,
            planDate: next,
          });
          generated.push(b.id);
        } catch (e) {
          // 空册/无到期户跳过（EMPTY_BOOK），其余错误上抛。
          const code = (e as { response?: { code?: string } }).response?.code;
          if (code !== 'EMPTY_BOOK') throw e;
        }
      }
      return { segNo, planDate: next, generated };
    });
  }

  /**
   * R6 超段均分：任选 N 段（sourceSegs），其本月未抄任务均分到
   * ≤ 总段数−N 的目标段（targetSegs）。计划项级迁移（本月临时调整，
   * 户段号归属不变），目标段无计划则先按常规生成再承接。
   */
  async redistributeTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    body: { zoneNo: string; period: string; sourceSegs: string[]; targetSegs: string[] },
  ) {
    const { zoneNo, period, sourceSegs, targetSegs } = body;
    if (!zoneNo || !period || !sourceSegs?.length || !targetSegs?.length) {
      throw new BadRequestException({ code: 'REDISTRIBUTE_FIELDS_REQUIRED' });
    }
    const segCount = (await tx.readingBook.findMany({
      where: { tenantId: ctx.tenantId, zoneNo, segNo: { not: null } },
      select: { segNo: true },
    })).length;
    if (targetSegs.length > Math.max(0, segCount - sourceSegs.length)) {
      throw new BadRequestException({
        code: 'REDISTRIBUTE_TARGET_OVERFLOW',
        max: segCount - sourceSegs.length,
      });
    }
    const planOf = async (segNo: string) => {
      const book = await tx.readingBook.findFirst({
        where: { tenantId: ctx.tenantId, zoneNo, segNo },
        select: { id: true },
      });
      if (!book) return null;
      return tx.readingPlan.findFirst({
        where: {
          tenantId: ctx.tenantId,
          bookId: book.id,
          period,
          status: { in: ['OPEN', 'IN_PROGRESS'] },
        },
        select: { id: true },
      });
    };
    const srcPlans = (await Promise.all(sourceSegs.map(planOf))).filter(
      (p): p is { id: string } => !!p,
    );
    if (!srcPlans.length) {
      throw new BadRequestException({ code: 'REDISTRIBUTE_NO_SOURCE_PLANS' });
    }
    const pendingItems = await tx.readingPlanItem.findMany({
      where: {
        tenantId: ctx.tenantId,
        planId: { in: srcPlans.map((p) => p.id) },
        status: 'PENDING',
      },
      orderBy: [{ planId: 'asc' }, { seqNo: 'asc' }],
      select: { id: true, waterAccountId: true, plannedInstallationId: true },
    });
    if (!pendingItems.length) return { moved: 0 };
    // 目标计划：无则按 book+period 生成（无到期户时建空计划承接）。
    const targetPlanIds: string[] = [];
    for (const seg of targetSegs) {
      let p = await planOf(seg);
      if (!p) {
        const book = await tx.readingBook.findFirst({
          where: { tenantId: ctx.tenantId, zoneNo, segNo: seg },
          select: { id: true },
        });
        if (!book) continue;
        const created = await tx.readingPlan.create({
          data: {
            tenantId: ctx.tenantId,
            bookId: book.id,
            period,
            planDate: new Date(),
            status: 'OPEN',
            createdBy: ctx.staffId,
            updatedBy: ctx.staffId,
          },
          select: { id: true },
        });
        p = created;
      }
      targetPlanIds.push(p.id);
    }
    if (!targetPlanIds.length) {
      throw new BadRequestException({ code: 'REDISTRIBUTE_NO_TARGET_BOOKS' });
    }
    // 均摊：按目标段数轮询分配（取每计划当前最大 seq 续排）。
    const seqOf = new Map<string, number>();
    for (const pid of targetPlanIds) {
      const agg = await tx.readingPlanItem.aggregate({
        where: { tenantId: ctx.tenantId, planId: pid },
        _max: { seqNo: true },
      });
      seqOf.set(pid, agg._max.seqNo ?? 0);
    }
    let moved = 0;
    for (let i = 0; i < pendingItems.length; i++) {
      const target = targetPlanIds[i % targetPlanIds.length];
      const item = pendingItems[i];
      // 同户已在目标计划 → 直接删源项（不重复抄）。
      const dup = await tx.readingPlanItem.findFirst({
        where: {
          tenantId: ctx.tenantId,
          planId: target,
          waterAccountId: item.waterAccountId,
        },
        select: { id: true },
      });
      await tx.readingPlanItem.delete({ where: { id: item.id } });
      if (!dup) {
        seqOf.set(target, (seqOf.get(target) ?? 0) + 1);
        await tx.readingPlanItem.create({
          data: {
            tenantId: ctx.tenantId,
            planId: target,
            waterAccountId: item.waterAccountId,
            seqNo: seqOf.get(target)!,
            plannedInstallationId: item.plannedInstallationId,
            status: 'PENDING',
            createdBy: ctx.staffId,
            updatedBy: ctx.staffId,
          },
        });
      }
      moved += 1;
    }
    return { moved, targets: targetPlanIds };
  }

  /**
   * R15 人工调序：orderedItemIds 给全量计划项的新顺序——计划项 seqNo
   * 重排，同时把顺序写回用户级 routeKey（同一区号下跨频次稳定）。
   */
  async reorderTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    planId: string,
    orderedItemIds: string[],
    req: Request,
  ) {
    const plan = await tx.readingPlan.findFirst({
      where: { tenantId: ctx.tenantId, id: planId },
      select: { id: true, bookId: true, status: true },
    });
    if (!plan) throw new NotFoundException({ code: 'PLAN_NOT_FOUND' });
    await this.assertPlanBookInScope(tx, ctx, plan.bookId);
    const items = await tx.readingPlanItem.findMany({
      where: { tenantId: ctx.tenantId, planId },
      select: { id: true, waterAccountId: true },
    });
    if (items.length !== orderedItemIds.length) {
      throw new BadRequestException({ code: 'REORDER_ITEMS_MISMATCH' });
    }
    const itemById = new Map(items.map((i) => [i.id, i]));
    for (const iid of orderedItemIds) {
      if (!itemById.has(iid)) {
        throw new BadRequestException({ code: 'REORDER_ITEM_NOT_IN_PLAN', itemId: iid });
      }
    }
    req.auditBefore = items;
    for (let i = 0; i < orderedItemIds.length; i++) {
      const item = itemById.get(orderedItemIds[i])!;
      await tx.readingPlanItem.update({
        where: { id: item.id },
        data: { seqNo: i + 1 },
      });
      // routeKey 用稀疏键（步长 1000）便于后续插入取中点。
      await tx.waterAccount.update({
        where: { id: item.waterAccountId },
        data: { routeKey: (i + 1) * 1000, updatedBy: ctx.staffId },
      });
    }
    return tx.readingPlanItem.findMany({
      where: { tenantId: ctx.tenantId, planId },
      select: PLAN_ITEM_SELECT,
      orderBy: { seqNo: 'asc' },
    });
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
