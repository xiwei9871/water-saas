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
  constructor(private readonly prisma: TenantPrismaService) {}

  list(
    ctx: TenantCtx,
    q: {
      take: number;
      skip: number;
      planItemId?: string;
      installationId?: string;
      period?: string;
      resultType?: ReadResultType;
      qcStatus?: QcStatus;
      q?: string;
    },
  ) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.meterReading.findMany({
        where: {
          tenantId: ctx.tenantId,
          planItemId: q.planItemId,
          installationId: q.installationId,
          period: q.period,
          resultType: q.resultType,
          qcStatus: q.qcStatus,
          ...(q.q
            ? {
                installation: {
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
        select: READING_DISPLAY_SELECT,
      });
      if (!found) throw new NotFoundException({ code: 'READING_NOT_FOUND' });
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
  private async attachSupersededBy<T extends { id: string }>(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    rows: T[],
  ): Promise<(T & { supersededById: string | null })[]> {
    if (rows.length === 0) return [];
    const children = await tx.meterReading.findMany({
      where: {
        tenantId: ctx.tenantId,
        supersedesReadingId: { in: rows.map((r) => r.id) },
      },
      select: { id: true, supersedesReadingId: true },
    });
    const byParent = new Map(children.map((c) => [c.supersedesReadingId, c.id]));
    return rows.map((r) => ({ ...r, supersededById: byParent.get(r.id) ?? null }));
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

    const readings = await this.writeReadings(tx, ctx, resolved);
    await this.advancePlans(tx, ctx, [...new Set(resolved.map((r) => r.plan.id))]);
    return readings;
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

    const readings = await this.writeReadings(tx, ctx, resolved);
    await this.advancePlans(tx, ctx, [...new Set(resolved.map((r) => r.plan.id))]);
    return readings;
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
    return tx.meterReading.findUniqueOrThrow({
      where: { id },
      select: METER_READING_SELECT,
    });
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
    }
    return readings;
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
