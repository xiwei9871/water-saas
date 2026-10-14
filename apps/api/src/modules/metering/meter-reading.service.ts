import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { noReadStreaksTx } from '../../common/no-read-streak.js';
import { orgInScope, type TenantCtx } from '../../common/tenant-context.js';
import {
  assertAccountScopeTx,
  outOfScopeAccountIds,
} from '../../common/account-scope.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { TaskService } from '../task/task.service.js';

export const METER_READING_SELECT = {
  id: true,
  tenantId: true,
  planItemId: true,
  installationId: true,
  meterId: true,
  period: true,
  readDate: true,
  resultType: true,
  readingValue: true,
  estimateQty: true,
  exceptionCode: true,
  supersedesReadingId: true,
  qcStatus: true,
  qcBy: true,
  qcAt: true,
  source: true,
  operatorId: true,
  sourceEventId: true,
  photoRef: true,
  remark: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.MeterReadingSelect;

const READING_DISPLAY_SELECT = {
  ...METER_READING_SELECT,
  installation: {
    select: {
      waterAccountId: true,
      waterAccount: {
        select: {
          accountNo: true,
          addr: true,
          customer: { select: { name: true } },
        },
      },
      meter: { select: { meterNo: true } },
    },
  },
} satisfies Prisma.MeterReadingSelect;
type DisplayReading = Prisma.MeterReadingGetPayload<{
  select: typeof READING_DISPLAY_SELECT;
}>;

type ReadResultType = 'ACTUAL' | 'REMOTE' | 'NO_READ';
type QcStatus = 'PENDING' | 'PASSED' | 'REJECTED' | 'MANUAL_REVIEW';
type ReadSource = 'WEB' | 'IMPORT' | 'APP' | 'REMOTE';
type PlanStatus = 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'CLOSED';
type ExceptionCode =
  | 'LOCKED'
  | 'DIAL_DIRTY'
  | 'FLOODED'
  | 'OCCUPIED'
  | 'STOPPED'
  | 'BROKEN'
  | 'SUSPECTED_THEFT'
  | 'OTHER';

/**
 * One validated row of reading input — wire parsing (enum/decimal/uuid
 * checks) happens in the controller, this is what the service consumes.
 */
export interface ReadingInput {
  planItemId: string;
  resultType: ReadResultType;
  /** ACTUAL/REMOTE: required Decimal. NO_READ: undefined. */
  readingValue?: Prisma.Decimal;
  /** NO_READ: required ExceptionCode. Others: undefined. */
  exceptionCode?: ExceptionCode;
  /** NO_READ only: operator-entered estimated usage (m³, not a dial). */
  estimateQty?: Prisma.Decimal;
  readDate?: Date;
  source: ReadSource;
  photoRef?: string | null;
  remark?: string | null;
}

/** A ReadingInput tagged with its 1-based position in the import file. */
export interface NumberedReadingInput {
  row: number;
  input: ReadingInput;
}

export interface SupersedeBody {
  readingValue: Prisma.Decimal;
  readDate?: Date;
}

export type QcAction = 'pass' | 'reject' | 'review';

const QC_TARGET: Record<QcAction, QcStatus> = {
  pass: 'PASSED',
  reject: 'REJECTED',
  review: 'MANUAL_REVIEW',
};

/**
 * spec §2.7: PENDING → PASSED | REJECTED | MANUAL_REVIEW → PASSED | REJECTED.
 * PASSED/REJECTED are terminal — a wrong QC verdict is corrected by
 * superseding the reading, never by re-flipping qc_status.
 */
const QC_ALLOWED_FROM: Record<QcStatus, QcStatus[]> = {
  PASSED: ['PENDING', 'MANUAL_REVIEW'],
  REJECTED: ['PENDING', 'MANUAL_REVIEW'],
  MANUAL_REVIEW: ['PENDING'],
  PENDING: [],
};

const outOfScope = () => new ForbiddenException({ code: 'ORG_OUT_OF_SCOPE' });

const itemAlreadyDone = (status: string) =>
  new ConflictException({ code: 'ITEM_ALREADY_DONE', status });

const planNotOpen = (status: string) =>
  new ConflictException({ code: 'PLAN_NOT_OPEN', status });

/** Per-plan context resolved once per batch: plan row + book org. */
interface PlanCtx {
  id: string;
  bookId: string;
  period: string;
  status: PlanStatus;
  bookOrgUnitId: string | null;
}

interface ItemCtx {
  id: string;
  planId: string;
  waterAccountId: string;
  status: string;
}

/** One failing row in an import report (1-based line number). */
export interface RowError {
  row: number;
  code: string;
  error: string;
}

/**
 * MeterReading （抄表记录） — append-only 采集事实 (spec §2.2):
 * ACTUAL/REMOTE carry reading_value, NO_READ carries exception_code, and a
 * correction is a NEW row pointing at the old one via supersedes_reading_id —
 * history rows are never rewritten.
 *
 * Write path (entry/import/supersede share the same transaction skeleton):
 *   validate → create meter_reading → flip plan_item PENDING→READ|NO_READ
 *   (guarded updateMany — a concurrent entry on the same item loses the race
 *   with count=0 → 409) → plan OPEN→IN_PROGRESS on first reading → plan
 *   →DONE in the same transaction when the last PENDING item lands (this is
 *   the T5-deferred "plan→DONE trigger": the write that completes the plan
 *   flips it).
 *
 * Installation resolution: plan_item.planned_installation_id is only the
 * generation-time snapshot — entry re-resolves the account's CURRENT ACTIVE
 * installation (latest installed_at) so a mid-period meter swap reads
 * against the new meter. meter_reading.installation_id is NOT NULL, so a
 * NO_READ on a meterless account is also rejected: "到场抄不了" presumes a
 * meter on the wall, and the schema gives a meterless fact row nowhere to
 * hang — such an item stays PENDING for ops handling instead of storing a
 * half-null fact.
 *
 * QC (质检) mutates ONLY meter_reading.qc_status/qc_by/qc_at — plan_item
 * records "the read happened", not "the read was good", so a REJECTED
 * reading leaves its item READ (a redo is a supersede, not an item reset).
 */
@Injectable()
export class MeterReadingService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly tasks: TaskService,
  ) {}

  list(
    ctx: TenantCtx,
    q: {
      take: number;
      skip: number;
      planItemId?: string;
      installationId?: string;
      waterAccountId?: string;
      period?: string;
      resultType?: ReadResultType;
      qcStatus?: QcStatus;
      q?: string;
    },
  ) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      // E8 D5: explicit waterAccountId → assert + strict equality via the
      // installation join; unfiltered scoped lists must exclude readings
      // on out-of-scope accounts (every reading anchors via installation).
      if (q.waterAccountId) {
        await assertAccountScopeTx(tx, ctx, q.waterAccountId);
      }
      const hidden =
        !q.waterAccountId && ctx.scope !== 'ALL'
          ? await outOfScopeAccountIds(tx, ctx)
          : [];
      const accountFilter = q.waterAccountId
        ? { waterAccountId: q.waterAccountId }
        : hidden.length
          ? { waterAccountId: { notIn: hidden } }
          : {};
      const rows = await tx.meterReading.findMany({
        where: {
          tenantId: ctx.tenantId,
          planItemId: q.planItemId,
          installationId: q.installationId,
          installation: Object.keys(accountFilter).length
            ? accountFilter
            : undefined,
          period: q.period,
          resultType: q.resultType,
          qcStatus: q.qcStatus,
          ...(q.q
            ? {
                installation: {
                  ...accountFilter,
                  waterAccount: {
                    tenantId: ctx.tenantId,
                    OR: [
                      {
                        accountNo: {
                          contains: q.q,
                          mode: 'insensitive' as const,
                        },
                      },
                      { addr: { contains: q.q, mode: 'insensitive' as const } },
                      {
                        customer: {
                          tenantId: ctx.tenantId,
                          name: { contains: q.q, mode: 'insensitive' as const },
                        },
                      },
                    ],
                  },
                },
              }
            : {}),
        },
        select: READING_DISPLAY_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: q.take,
        skip: q.skip,
      });
      return this.attachSupersededBy(tx, ctx, await this.displayRows(tx, ctx, rows));
    });
  }

  async getById(ctx: TenantCtx, id: string) {
    const row = await this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const found = await tx.meterReading.findFirst({
        where: { tenantId: ctx.tenantId, id },
        select: {
          ...READING_DISPLAY_SELECT,
          installation: {
            select: {
              waterAccountId: true,
              waterAccount: {
                select: {
                  accountNo: true,
                  addr: true,
                  customer: { select: { name: true } },
                },
              },
              meter: { select: { meterNo: true } },
            },
          },
        },
      });
      if (!found) throw new NotFoundException({ code: 'READING_NOT_FOUND' });
      // E8: reading detail is customer data via its installation anchor.
      await assertAccountScopeTx(tx, ctx, found.installation.waterAccountId);
      return (await this.attachSupersededBy(tx, ctx, await this.displayRows(tx, ctx, [found])))[0];
    });
    return row;
  }

  /** Display-only names within this tenant; never return full staff records. */
  private async displayRows(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    rows: DisplayReading[],
  ) {
    const ids = [
      ...new Set(
        rows
          .flatMap((r) => [r.operatorId, r.qcBy])
          .filter((id): id is string => !!id),
      ),
    ];
    const staff = ids.length
      ? await tx.staff.findMany({
          where: { tenantId: ctx.tenantId, id: { in: ids } },
          select: { id: true, name: true },
        })
      : [];
    const names = new Map(staff.map((s) => [s.id, s.name]));
    return rows.map(({ installation, ...r }) => ({
      ...r,
      account: {
        id: installation.waterAccountId,
        accountNo: installation.waterAccount.accountNo,
        customerName: installation.waterAccount.customer.name,
        addr: installation.waterAccount.addr,
      },
      meterNo: installation.meter.meterNo,
      operatorName: r.operatorId ? (names.get(r.operatorId) ?? null) : null,
      qcByName: r.qcBy ? (names.get(r.qcBy) ?? null) : null,
    }));
  }

  /**
   * Hydrate `supersededById` per row — a superseded parent keeps its own
   * supersedes_reading_id NULL while the correcting child carries the link,
   * so "was this row corrected?" needs the child-row probe (the same rule
   * validReadings applies). Lets a client mark 已被更正 rows without a
   * second round-trip.
   */
  private async attachSupersededBy<
    T extends { id: string; period: string; account?: { id: string } },
  >(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    rows: T[],
  ): Promise<(T & { supersededById: string | null; consecutiveNoRead: number })[]> {
    if (rows.length === 0) return [];
    const children = await tx.meterReading.findMany({
      where: {
        tenantId: ctx.tenantId,
        supersedesReadingId: { in: rows.map((r) => r.id) },
      },
      select: { id: true, supersedesReadingId: true },
    });
    const byParent = new Map(children.map((c) => [c.supersedesReadingId, c.id]));
    // Round-2 §10: trailing NO_READ run per (account, period) — QC sees
    // "已连续 N 期未抄见" instead of approving blind.
    const streaks = await noReadStreaksTx(
      tx,
      ctx.tenantId,
      rows
        .filter((r) => r.account?.id)
        .map((r) => ({ waterAccountId: r.account!.id, period: r.period })),
    );
    return rows.map((r) => ({
      ...r,
      supersededById: byParent.get(r.id) ?? null,
      consecutiveNoRead:
        streaks.get(`${r.account?.id}:${r.period}`) ?? 0,
    }));
  }

  /**
   * POST /meter-readings — single row or batch ({items:[...]}); the batch is
   * one transaction, so any failing row aborts the whole entry.
   */
  async createBatchTx(tx: Prisma.TransactionClient, ctx: TenantCtx, inputs: ReadingInput[]) {
    const seen = new Set<string>();
    for (const input of inputs) {
      if (seen.has(input.planItemId)) {
        throw new BadRequestException({
          code: 'DUPLICATE_PLAN_ITEM',
          planItemId: input.planItemId,
        });
      }
      seen.add(input.planItemId);
    }

    const { items, plans } = await this.loadBatchContext(tx, ctx, inputs);
    const accountIds = inputs.map(
      (i) => items.get(i.planItemId)?.waterAccountId ?? '',
    );
    const installations = await this.resolveActiveInstallations(tx, ctx, accountIds);

    const resolved: {
      input: ReadingInput;
      item: ItemCtx;
      plan: PlanCtx;
      installation: { id: string; meterId: string };
    }[] = [];
    for (const input of inputs) {
      const item = items.get(input.planItemId);
      if (!item) {
        throw new BadRequestException({ code: 'PLAN_ITEM_NOT_FOUND', planItemId: input.planItemId });
      }
      const plan = plans.get(item.planId);
      if (!plan) throw new NotFoundException({ code: 'PLAN_NOT_FOUND' });
      this.assertPlanScope(ctx, plan);
      if (plan.status !== 'OPEN' && plan.status !== 'IN_PROGRESS') {
        throw planNotOpen(plan.status);
      }
      // PENDING accepts the first observation; NO_READ accepts a retry (a
      // failed visit followed by a successful one — the new row is a fresh
      // observation, not a supersede; the NO_READ row stays as history).
      // READ is terminal for direct entry — value corrections go through
      // POST /:id/supersede.
      if (item.status !== 'PENDING' && item.status !== 'NO_READ') {
        throw itemAlreadyDone(item.status);
      }
      const installation = installations.get(item.waterAccountId);
      if (!installation) {
        throw new BadRequestException({
          code: 'NO_ACTIVE_INSTALLATION',
          waterAccountId: item.waterAccountId,
        });
      }
      resolved.push({ input, item, plan, installation });
    }

    const { readings, reviewTasks } = await this.writeReadings(tx, ctx, resolved);
    await this.advancePlans(tx, ctx, [...new Set(resolved.map((r) => r.plan.id))]);
    return { readings, reviewTasks };
  }

  /**
   * POST /meter-readings/import — all-or-nothing batch entry (deliberate
   * choice over per-row partial success: a partially imported route sheet
   * leaves the reader guessing which rows to re-key; a clean per-row error
   * report + retry is simpler and audit-friendly). Every row is validated
   * first — any failure aborts with {code, failed:[{row,code,error}]} and
   * NOTHING is written.
   */
  async importTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    inputs: NumberedReadingInput[],
    /** Wire-level row failures already collected by the controller — merged
     *  into the same report so the caller fixes the file in one pass. */
    preFailed: RowError[] = [],
  ) {
    const failed: RowError[] = [...preFailed];
    const failedRows = new Set<number>(preFailed.map((f) => f.row));
    const seen = new Map<string, number>();
    for (const { row, input } of inputs) {
      const prev = seen.get(input.planItemId);
      if (prev !== undefined) {
        failed.push({
          row,
          code: 'DUPLICATE_PLAN_ITEM',
          error: `plan_item_id duplicates row ${prev}`,
        });
        failedRows.add(row);
      } else {
        seen.set(input.planItemId, row);
      }
    }

    const { items, plans } = await this.loadBatchContext(
      tx,
      ctx,
      inputs.map((i) => i.input),
    );
    const installations = await this.resolveActiveInstallations(
      tx,
      ctx,
      inputs.map((i) => items.get(i.input.planItemId)?.waterAccountId ?? ''),
    );

    const resolved: {
      input: ReadingInput;
      item: ItemCtx;
      plan: PlanCtx;
      installation: { id: string; meterId: string };
    }[] = [];
    for (const { row, input } of inputs) {
      if (failedRows.has(row)) continue;
      const item = items.get(input.planItemId);
      if (!item) {
        failed.push({ row, code: 'PLAN_ITEM_NOT_FOUND', error: 'plan item not found' });
        continue;
      }
      const plan = plans.get(item.planId);
      if (!plan) {
        failed.push({ row, code: 'PLAN_NOT_FOUND', error: 'plan not found' });
        continue;
      }
      if (!orgInScope(ctx, plan.bookOrgUnitId)) {
        failed.push({ row, code: 'ORG_OUT_OF_SCOPE', error: 'book org outside data scope' });
        continue;
      }
      if (plan.status !== 'OPEN' && plan.status !== 'IN_PROGRESS') {
        failed.push({ row, code: 'PLAN_NOT_OPEN', error: `plan status ${plan.status}` });
        continue;
      }
      if (item.status !== 'PENDING' && item.status !== 'NO_READ') {
        failed.push({ row, code: 'ITEM_ALREADY_DONE', error: `item status ${item.status}` });
        continue;
      }
      const installation = installations.get(item.waterAccountId);
      if (!installation) {
        failed.push({
          row,
          code: 'NO_ACTIVE_INSTALLATION',
          error: 'account has no ACTIVE installation',
        });
        continue;
      }
      resolved.push({ input, item, plan, installation });
    }

    if (failed.length > 0) {
      throw new BadRequestException({
        code: 'IMPORT_VALIDATION_FAILED',
        created: 0,
        failed: failed.sort((a, b) => a.row - b.row),
      });
    }

    const { readings, reviewTasks } = await this.writeReadings(tx, ctx, resolved);
    await this.advancePlans(tx, ctx, [...new Set(resolved.map((r) => r.plan.id))]);
    return { readings, reviewTasks };
  }

  /**
   * POST /meter-readings/:id/qc — guarded qc_status transition. Reads stay
   * append-only: only qc_status/qc_by/qc_at/updated_by are written, and the
   * plan item is deliberately untouched (item.status = "the read happened").
   */
  async qcTx(tx: Prisma.TransactionClient, ctx: TenantCtx, id: string, action: QcAction, req: Request) {
    const existing = await tx.meterReading.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!existing) throw new NotFoundException({ code: 'READING_NOT_FOUND' });
    await this.assertReadingScope(tx, ctx, existing.planItemId);

    // A superseded row is no longer the valid fact — QC'ing it would leave
    // a stale verdict on history. The superseding child carries its own
    // PENDING qc_status; that's the row to verdict.
    const child = await tx.meterReading.findFirst({
      where: { tenantId: ctx.tenantId, supersedesReadingId: id },
      select: { id: true },
    });
    if (child) {
      throw new ConflictException({ code: 'READING_SUPERSEDED', by: child.id });
    }

    const to = QC_TARGET[action];
    const allowedFrom = QC_ALLOWED_FROM[to];
    req.auditBefore = existing;
    const flipped = await tx.meterReading.updateMany({
      where: { tenantId: ctx.tenantId, id, qcStatus: { in: allowedFrom } },
      data: {
        qcStatus: to,
        qcBy: ctx.staffId,
        qcAt: new Date(),
        updatedBy: ctx.staffId,
      },
    });
    if (flipped.count === 0) {
      throw new ConflictException({
        code: 'INVALID_QC_STATUS_TRANSITION',
        from: existing.qcStatus,
        to,
      });
    }
    const row = await tx.meterReading.findUniqueOrThrow({
      where: { id },
      select: METER_READING_SELECT,
    });
    // 任务书 T5/T6：质检确认（PASS）时检测「实抄止度 < 估计止度」→ 自动建补差任务。
    // 幂等由 task_open_dedupe 保证；结算侧还会兜底再查一次。
    const supplementTask =
      to === 'PASSED' && existing.readingValue !== null
        ? await this.detectSupplementOnQc(tx, ctx, existing)
        : null;
    return { ...row, supplementTask };
  }

  /**
   * QC 确认点的估高检测：该表计在本读数账期之前的最近结算 checkpoint 为
   * ESTIMATE 且其止度高于本次实抄 → 建补差任务（billing:write 候选）。
   */
  private async detectSupplementOnQc(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    reading: { installationId: string; period: string; readingValue: Prisma.Decimal | null },
  ) {
    const checkpoint = await tx.$queryRaw<
      { end_reading_value: Prisma.Decimal; source_type: string; water_account_id: string; account_no: string; org: string | null }[]
    >`
      SELECT cc.end_reading_value, cc.source_type, mi.water_account_id, wa.account_no,
             (SELECT rb.org_unit_id FROM book_meter bm
                JOIN reading_book rb ON rb.id = bm.book_id AND rb.tenant_id = bm.tenant_id
               WHERE bm.tenant_id = wa.tenant_id AND bm.water_account_id = wa.id
               ORDER BY bm.created_at ASC LIMIT 1) AS org
      FROM consumption_component cc
      JOIN consumption_settlement cs
        ON cs.id = cc.settlement_id AND cs.tenant_id = cc.tenant_id
      JOIN meter_installation mi ON mi.id = cc.installation_id AND mi.tenant_id = cc.tenant_id
      JOIN water_account wa ON wa.id = mi.water_account_id AND wa.tenant_id = cc.tenant_id
      WHERE cc.tenant_id = ${ctx.tenantId}::uuid
        AND cc.installation_id = ${reading.installationId}::uuid
        AND cc.end_reading_value IS NOT NULL
        AND cs.period < ${reading.period}
      ORDER BY cs.period DESC, cc.created_at DESC
      LIMIT 1`;
    const cp = checkpoint[0];
    if (!cp || cp.source_type !== 'ESTIMATE' || !reading.readingValue) return null;
    if (!reading.readingValue.lt(cp.end_reading_value)) return null;
    const created = await this.tasks.createTask(tx, ctx, {
      type: 'SUPPLEMENT',
      title: `补差：户 ${cp.account_no} 的 ${reading.period} 期估水需校正`,
      bizType: 'waterAccount',
      bizId: cp.water_account_id,
      bizLabel: cp.account_no,
      reason: `实抄止度 ${reading.readingValue.toString()} < 估计止度 ${cp.end_reading_value.toString()}`,
      context: {
        waterAccountId: cp.water_account_id,
        waterAccountNo: cp.account_no,
        period: reading.period,
        installationId: reading.installationId,
        estimatedReadingValue: cp.end_reading_value.toString(),
        actualReadingValue: reading.readingValue.toString(),
        diff: reading.readingValue.minus(cp.end_reading_value).toString(),
      },
      orgUnitId: cp.org,
    });
    return { id: created.id, deduped: created.deduped, candidates: created.candidates };
  }

  /**
   * POST /meter-readings/:id/supersede — 更正读数: inserts a NEW fact row
   * pointing at the corrected one (spec §2.2 append-only chain). The
   * original row is never modified; the plan item's completed_reading_id is
   * re-pointed at the new fact. The new row re-enters QC at PENDING — the
   * supersede chain tracks dial truth, QC is per-fact.
   *
   * Only ACTUAL/REMOTE rows are supersede-able (a NO_READ carries no dial
   * value to correct — its "correction" is a direct re-entry on the item,
   * which the PENDING|NO_READ item guard now allows). The original
   * row is locked FOR UPDATE before the child check so two concurrent
   * supersedes on the same parent can't both win the supersedes_reading_id
   * slot.
   */
  async supersedeTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    id: string,
    body: SupersedeBody,
    req: Request,
  ) {
    const original = await tx.meterReading.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!original) throw new NotFoundException({ code: 'READING_NOT_FOUND' });
    await this.assertReadingScope(tx, ctx, original.planItemId);

    // Serialize concurrent supersedes of this row (see docblock).
    await tx.$queryRaw`
      SELECT id FROM meter_reading
      WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${id}::uuid
      FOR UPDATE`;

    if (original.resultType === 'NO_READ') {
      throw new ConflictException({ code: 'NOT_SUPERSEDABLE', resultType: original.resultType });
    }
    const child = await tx.meterReading.findFirst({
      where: { tenantId: ctx.tenantId, supersedesReadingId: id },
      select: { id: true },
    });
    if (child) {
      throw new ConflictException({ code: 'ALREADY_SUPERSEDED', by: child.id });
    }

    req.auditBefore = original;
    const reading = await tx.meterReading.create({
      data: {
        tenantId: ctx.tenantId,
        planItemId: original.planItemId,
        installationId: original.installationId,
        meterId: original.meterId,
        period: original.period,
        // The correction is a new observation — read_date defaults to now,
        // caller may pin it to the original visit date.
        readDate: body.readDate ?? new Date(),
        // Same fact type as the row it corrects (REMOTE stays REMOTE).
        resultType: original.resultType,
        readingValue: body.readingValue,
        exceptionCode: null,
        supersedesReadingId: id,
        qcStatus: 'PENDING',
        // Provenance channel inherited — the chain link itself records that
        // this row is a correction, not a fresh capture.
        source: original.source,
        operatorId: ctx.staffId,
        createdBy: ctx.staffId,
        updatedBy: ctx.staffId,
      },
      select: METER_READING_SELECT,
    });

    if (original.planItemId) {
      await tx.readingPlanItem.updateMany({
        where: { tenantId: ctx.tenantId, id: original.planItemId },
        data: { completedReadingId: reading.id, updatedBy: ctx.staffId },
      });
    }
    return reading;
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /** Bulk-load the plan items + their plans (+ book org for scope). */
  private async loadBatchContext(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    inputs: ReadingInput[],
  ) {
    const itemRows = await tx.readingPlanItem.findMany({
      where: {
        tenantId: ctx.tenantId,
        id: { in: inputs.map((i) => i.planItemId) },
      },
      select: { id: true, planId: true, waterAccountId: true, status: true },
    });
    const items = new Map<string, ItemCtx>(itemRows.map((i) => [i.id, i]));

    const planIds = [...new Set(itemRows.map((i) => i.planId))];
    const planRows = await tx.readingPlan.findMany({
      where: { tenantId: ctx.tenantId, id: { in: planIds } },
      select: { id: true, bookId: true, period: true, status: true },
    });
    // reading_plan.book_id is a bare column (no FK/relation — see T5), so the
    // book's org_unit needs this second lookup for the orgInScope guard.
    const bookIds = [...new Set(planRows.map((p) => p.bookId))];
    const books = await tx.readingBook.findMany({
      where: { tenantId: ctx.tenantId, id: { in: bookIds } },
      select: { id: true, orgUnitId: true },
    });
    const bookOrg = new Map(books.map((b) => [b.id, b.orgUnitId]));

    const plans = new Map<string, PlanCtx>(
      planRows.map((p) => [
        p.id,
        { ...p, bookOrgUnitId: bookOrg.get(p.bookId) ?? null },
      ]),
    );
    return { items, plans };
  }

  /**
   * Re-resolve each account's CURRENT ACTIVE installation at entry time
   * (planned_installation_id is only the snapshot — spec §2.2 allows a meter
   * swap mid-route). Schema allows several ACTIVE installations per account
   * （一户多表 phase-2); MVP takes the latest installed_at.
   */
  private async resolveActiveInstallations(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    waterAccountIds: string[],
  ) {
    const rows = await tx.meterInstallation.findMany({
      where: {
        tenantId: ctx.tenantId,
        waterAccountId: { in: waterAccountIds.filter(Boolean) },
        status: 'ACTIVE',
      },
      select: { id: true, waterAccountId: true, meterId: true, installedAt: true },
      orderBy: [{ installedAt: 'desc' }, { id: 'asc' }],
    });
    const byAccount = new Map<string, { id: string; meterId: string }>();
    for (const r of rows) {
      if (!byAccount.has(r.waterAccountId)) {
        byAccount.set(r.waterAccountId, { id: r.id, meterId: r.meterId });
      }
    }
    return byAccount;
  }

  /** Create the reading rows and flip each item PENDING→READ|NO_READ. */
  private async writeReadings(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    rows: {
      input: ReadingInput;
      item: ItemCtx;
      plan: PlanCtx;
      installation: { id: string; meterId: string };
    }[],
  ) {
    const readings = [];
    const reviewTasks: { id: string; readingId: string; reason: string }[] = [];
    for (const { input, item, plan, installation } of rows) {
      const reading = await tx.meterReading.create({
        data: {
          tenantId: ctx.tenantId,
          planItemId: input.planItemId,
          installationId: installation.id,
          meterId: installation.meterId,
          period: plan.period,
          readDate: input.readDate ?? new Date(),
          resultType: input.resultType,
          readingValue: input.readingValue ?? null,
          // A quantity estimate, never a dial — carries no readingValue.
          estimateQty: input.estimateQty ?? null,
          exceptionCode: input.exceptionCode ?? null,
          qcStatus: 'PENDING',
          source: input.source,
          operatorId: ctx.staffId,
          photoRef: input.photoRef ?? null,
          remark: input.remark ?? null,
          createdBy: ctx.staffId,
          updatedBy: ctx.staffId,
        },
        select: METER_READING_SELECT,
      });
      // Guarded flip: a concurrent entry on the same item loses the race
      // here (count=0 → 409) instead of silently double-completing it.
      // NO_READ is a retryable outcome — a fresh observation lands a new
      // fact row and repoints completed_reading_id (history preserved).
      const flipped = await tx.readingPlanItem.updateMany({
        where: {
          tenantId: ctx.tenantId,
          id: item.id,
          status: { in: ['PENDING', 'NO_READ'] },
        },
        data: {
          status: input.resultType === 'NO_READ' ? 'NO_READ' : 'READ',
          completedReadingId: reading.id,
          updatedBy: ctx.staffId,
        },
      });
      if (flipped.count === 0) throw itemAlreadyDone(item.status);
      readings.push(reading);
      // 任务书 T12：录入即检测「突增突减/读数倒挂」→ 自动建复核任务（metering:qc）。
      const review = await this.detectEntryAnomaly(tx, ctx, {
        readingId: reading.id,
        installationId: installation.id,
        waterAccountId: item.waterAccountId,
        period: plan.period,
        readingValue: input.readingValue ?? null,
        resultType: input.resultType,
        bookOrgUnitId: plan.bookOrgUnitId,
      });
      if (review) reviewTasks.push(review);
    }
    return { readings, reviewTasks };
  }

  /**
   * 录入异常检测：与上期可信止度比对。倒挂 / 用量>3倍近3期均值 / 用量<均值1/3
   * 任一命中 → 复核任务。无历史参照（首抄/无结算）不触发。
   */
  private async detectEntryAnomaly(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    p: {
      readingId: string;
      installationId: string;
      waterAccountId: string;
      period: string;
      readingValue: Prisma.Decimal | null;
      resultType: string;
      bookOrgUnitId: string | null;
    },
  ) {
    if (p.resultType === 'NO_READ' || p.readingValue === null) return null;
    const refs = await tx.$queryRaw<
      { prev_value: Prisma.Decimal | null; avg_usage: Prisma.Decimal | null; account_no: string }[]
    >`
      SELECT
        (SELECT r2.reading_value FROM meter_reading r2
          WHERE r2.tenant_id = ${ctx.tenantId}::uuid
            AND r2.installation_id = ${p.installationId}::uuid
            AND r2.id <> ${p.readingId}::uuid
            AND r2.result_type IN ('ACTUAL','REMOTE')
            AND r2.reading_value IS NOT NULL
            AND r2.qc_status <> 'REJECTED'
            AND NOT EXISTS (SELECT 1 FROM meter_reading c
              WHERE c.tenant_id = r2.tenant_id AND c.supersedes_reading_id = r2.id)
          ORDER BY r2.period DESC, r2.read_date DESC, r2.created_at DESC
          LIMIT 1) AS prev_value,
        (SELECT avg(cc.usage_qty) FROM (
           SELECT cc.usage_qty FROM consumption_component cc
           JOIN consumption_settlement cs ON cs.id = cc.settlement_id AND cs.tenant_id = cc.tenant_id
           WHERE cc.tenant_id = ${ctx.tenantId}::uuid
             AND cc.installation_id = ${p.installationId}::uuid
             AND cs.period < ${p.period}
           ORDER BY cs.period DESC, cc.created_at DESC LIMIT 3) cc) AS avg_usage,
        (SELECT wa.account_no FROM water_account wa
          WHERE wa.tenant_id = ${ctx.tenantId}::uuid AND wa.id = ${p.waterAccountId}::uuid) AS account_no`;
    const { prev_value: prev, avg_usage: avg3, account_no: accountNo } = refs[0] ?? {};
    const reasons: string[] = [];
    const usage = prev !== null && prev !== undefined ? p.readingValue.minus(prev) : null;
    if (usage?.lt(0)) reasons.push('读数倒挂');
    if (usage && avg3 !== null && avg3 !== undefined && new Prisma.Decimal(avg3).gt(0)) {
      if (usage.gt(new Prisma.Decimal(avg3).mul(3))) reasons.push('用量突增（超近3期均值3倍）');
      else if (usage.lt(new Prisma.Decimal(avg3).div(3))) reasons.push('用量突减（低于近3期均值1/3）');
    }
    if (!reasons.length) return null;
    const label = `${accountNo ?? p.waterAccountId} · ${p.period}`;
    const created = await this.tasks.createTask(tx, ctx, {
      type: 'METER_REVIEW',
      title: `复核：户 ${accountNo ?? ''} ${p.period} 期读数异常`,
      bizType: 'meterReading',
      bizId: p.readingId,
      bizLabel: label,
      reason: reasons.join('、'),
      context: {
        waterAccountId: p.waterAccountId,
        waterAccountNo: accountNo ?? null,
        period: p.period,
        installationId: p.installationId,
        readingValue: p.readingValue.toString(),
        prevReadingValue: prev?.toString() ?? null,
        usageQty: usage?.toString() ?? null,
        avgUsage3: avg3?.toString() ?? null,
      },
      orgUnitId: p.bookOrgUnitId,
    });
    return { id: created.id, readingId: p.readingId, reason: reasons.join('、') };
  }

  /**
   * Plan progress: first reading flips OPEN→IN_PROGRESS; when no PENDING
   * item remains the plan lands DONE — both as guarded updateMany writes so
   * the transitions are idempotent under concurrent entries. This is the
   * T5-deferred plan→DONE trigger: the completing write flips it in-tx.
   */
  private async advancePlans(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    planIds: string[],
  ) {
    // Sorted FOR UPDATE: the guarded writes below only lock the plan row
    // while their status predicate matches — without this lock, two
    // concurrent "last item" completions could each count PENDING=1 (the
    // other's flip is still uncommitted) and neither would land DONE,
    // leaving the plan stuck IN_PROGRESS forever. Sorting also orders lock
    // acquisition across multi-plan batches (deadlock discipline).
    for (const planId of [...planIds].sort()) {
      await tx.$queryRaw`
        SELECT id FROM reading_plan
        WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${planId}::uuid
        FOR UPDATE`;
      await tx.readingPlan.updateMany({
        where: { tenantId: ctx.tenantId, id: planId, status: 'OPEN' },
        data: { status: 'IN_PROGRESS', updatedBy: ctx.staffId },
      });
      const pending = await tx.readingPlanItem.count({
        where: { tenantId: ctx.tenantId, planId, status: 'PENDING' },
      });
      if (pending === 0) {
        await tx.readingPlan.updateMany({
          where: {
            tenantId: ctx.tenantId,
            id: planId,
            status: { in: ['OPEN', 'IN_PROGRESS'] },
          },
          data: { status: 'DONE', updatedBy: ctx.staffId },
        });
      }
    }
  }

  /** Write-path org guard: the plan's book org must be in the caller's scope. */
  private assertPlanScope(ctx: TenantCtx, plan: PlanCtx) {
    if (!orgInScope(ctx, plan.bookOrgUnitId)) throw outOfScope();
  }

  /**
   * Scope for reading-level writes (qc/supersede): resolved through
   * plan_item → plan → book. A reading with plan_item_id NULL has no book to
   * check — MVP only writes plan-bound readings, so the guard is skipped
   * with this note for the reviewer (standalone readings would need an org
   * column of their own).
   */
  private async assertReadingScope(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    planItemId: string | null,
  ) {
    if (!planItemId) return;
    const item = await tx.readingPlanItem.findFirst({
      where: { tenantId: ctx.tenantId, id: planItemId },
      select: { planId: true },
    });
    if (!item) return;
    const plan = await tx.readingPlan.findFirst({
      where: { tenantId: ctx.tenantId, id: item.planId },
      select: { bookId: true },
    });
    if (!plan) return;
    const book = await tx.readingBook.findFirst({
      where: { tenantId: ctx.tenantId, id: plan.bookId },
      select: { orgUnitId: true },
    });
    if (book && !orgInScope(ctx, book.orgUnitId)) throw outOfScope();
  }
}
