import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { estimateAvg3 } from '@ws/billing-core';
import { orgInScope, type TenantCtx } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';

export const SETTLEMENT_SELECT = {
  id: true,
  tenantId: true,
  waterAccountId: true,
  period: true,
  totalUsageQty: true,
  isEstimated: true,
  estimateMethod: true,
  estimateBasis: true,
  estimateReason: true,
  householdSizeSnapshot: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ConsumptionSettlementSelect;

export const COMPONENT_SELECT = {
  id: true,
  tenantId: true,
  settlementId: true,
  installationId: true,
  prevReadingValue: true,
  endReadingValue: true,
  usageQty: true,
  sourceType: true,
  sourceReadingId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ConsumptionComponentSelect;

type SettlementStatus = 'DRAFT' | 'FINAL';
type ComponentSourceType = 'READING' | 'ESTIMATE' | 'MANUAL';
type EstimateMethod = 'AUTO_AVG3' | 'MANUAL';

/** Operator usage override for one to-be-estimated component. */
export interface UsageOverride {
  installationId: string;
  usageQty: Prisma.Decimal;
}

export interface SettlementCreateBody {
  waterAccountId: string;
  period: string;
  /** Required whenever any component lands on the ESTIMATE path. */
  estimateReason?: string | null;
  /** Shorthand override — valid only when exactly one component estimates. */
  usageQty?: Prisma.Decimal;
  /** Per-installation overrides for multi-component settlements. */
  overrides?: UsageOverride[];
}

export interface EstimatePreviewBody {
  waterAccountId: string;
  period: string;
}

const outOfScope = () => new ForbiddenException({ code: 'ORG_OUT_OF_SCOPE' });

const invalidTransition = (from: string, to: string) =>
  new ConflictException({ code: 'INVALID_SETTLEMENT_STATUS_TRANSITION', from, to });

/** char(6) YYYYMM → [first day of month, first day of next month) UTC. */
const periodBounds = (period: string): { start: Date; end: Date } => {
  const y = parseInt(period.slice(0, 4), 10);
  const m = parseInt(period.slice(4), 10);
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
};

interface InstallationRow {
  id: string;
  meterId: string;
  installedAt: Date;
  removedAt: Date | null;
  initialReading: Prisma.Decimal;
  finalReading: Prisma.Decimal | null;
  status: 'ACTIVE' | 'REMOVED';
  meter: { maxDial: Prisma.Decimal | null };
}

interface ComponentDraft {
  installationId: string;
  prevReadingValue: Prisma.Decimal;
  endReadingValue: Prisma.Decimal;
  usageQty: Prisma.Decimal;
  sourceType: ComponentSourceType;
  sourceReadingId: string | null;
  /** AUTO_AVG3 | MANUAL — only for ESTIMATE components. */
  method?: EstimateMethod;
  /** The AVG3 suggestion shown to the operator (null = no history). */
  suggestedUsageQty?: Prisma.Decimal | null;
}

interface DialCheckpoint {
  value: Prisma.Decimal;
  sourceType: ComponentSourceType;
  period: string;
  sourceReadingId: string | null;
}

/**
 * ConsumptionSettlement （结算水量） — one header per water_account × period
 * with one component per contributing meter_installation (spec §2.3).
 *
 * Generation (POST /consumption-settlements) derives components from facts:
 *  - every installation whose lifetime intersects the period
 *    (installedAt < periodEnd AND (still active OR removedAt >= periodStart))
 *    gets exactly one component — a mid-period swap yields two.
 *  - prev chain: the installation's own previous component end_reading_value
 *    (latest settlement with period < current, NULL ends skipped); the
 *    installation's initial_reading when it was never settled before.
 *  - READING source: a REMOVED-in-period installation ends at its recorded
 *    final_reading (the拆表 dial fact); an ACTIVE installation ends at its
 *    VALID reading — PASSED + ACTUAL|REMOTE + not superseded (a row with a
 *    child is history even when its own supersedes_reading_id is NULL —
 *    the child check below is what T6 review flagged). Rollover: end < prev
 *    with meter.max_dial defined → usage = (maxDial − prev) + end; without
 *    maxDial a negative usage 400s (fix the reading chain instead — the
 *    over-estimate case is T11 reconciliation's job).
 *  - ESTIMATE source: no valid reading (NO_READ entry, QC
 *    PENDING/REJECTED/MANUAL_REVIEW, or no reading at all) → usage =
 *    estimateAvg3(last ≤3 READING-derived component usages of the account);
 *    the operator may override per installation (estimate_method=MANUAL);
 *    end = prev + usage (synthetic dial that keeps the prev chain going).
 *    estimate_reason is mandatory for any estimated settlement.
 *
 * FINAL is immutable (DRAFT→FINAL guarded updateMany); a wrong FINAL is
 * corrected by T11 reconciliation, never by rewriting this row.
 */
@Injectable()
export class SettlementService {
  constructor(private readonly prisma: TenantPrismaService) {}

  async list(
    ctx: TenantCtx,
    q: {
      take: number;
      skip: number;
      waterAccountId?: string;
      period?: string;
      status?: SettlementStatus;
      isEstimated?: boolean;
    },
  ) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.consumptionSettlement.findMany({
        where: {
          tenantId: ctx.tenantId,
          waterAccountId: q.waterAccountId,
          period: q.period,
          status: q.status,
          isEstimated: q.isEstimated,
        },
        select: SETTLEMENT_SELECT,
        orderBy: [{ period: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
        take: q.take,
        skip: q.skip,
      });
      return this.attachDetails(tx, ctx, rows);
    });
  }

  async getById(ctx: TenantCtx, id: string) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const row = await tx.consumptionSettlement.findFirst({
        where: { tenantId: ctx.tenantId, id },
        select: SETTLEMENT_SELECT,
      });
      if (!row) throw new NotFoundException({ code: 'SETTLEMENT_NOT_FOUND' });
      return (await this.attachDetails(tx, ctx, [row]))[0];
    });
  }

  /**
   * POST /estimate/preview — the AUTO_AVG3 suggestion over the account's
   * last ≤3 READING-derived component usages (period < requested). Pure
   * read: no writes, no guards beyond tenant/account existence — a preview
   * must also work before any plan exists.
   */
  async previewTx(tx: Prisma.TransactionClient, ctx: TenantCtx, body: EstimatePreviewBody) {
    const account = await tx.waterAccount.findFirst({
      where: { tenantId: ctx.tenantId, id: body.waterAccountId },
      select: { id: true },
    });
    if (!account) {
      throw new BadRequestException({ code: 'WATER_ACCOUNT_NOT_FOUND' });
    }
    const history = await this.historyUsages(tx, ctx, body.waterAccountId, body.period);
    const suggested = estimateAvg3(history);
    return {
      // Re-wrap in Prisma.Decimal: decimal.js instances from another module
      // copy would slip past toJsonSafe's instanceof check and serialize
      // their internals instead of the numeric string.
      suggestedUsage: suggested === null ? null : new Prisma.Decimal(suggested.toString()),
      method: 'AUTO_AVG3' as EstimateMethod,
      basis: {
        window: 3,
        historyUsageQtys: history.map((d) => d.toString()),
      },
    };
  }

  /**
   * POST /consumption-settlements — generate the DRAFT settlement +
   * components for (waterAccountId, period) in ONE transaction. The
   * (tenant,account,period) unique key makes the write single-shot: a
   * duplicate → 409 (a wrong DRAFT is fixed by regeneration rules — for
   * MVP there is no regenerate, so the guard is absolute).
   */
  async generateTx(tx: Prisma.TransactionClient, ctx: TenantCtx, body: SettlementCreateBody) {
    const account = await tx.waterAccount.findFirst({
      where: { tenantId: ctx.tenantId, id: body.waterAccountId },
      select: { id: true, status: true },
    });
    if (!account) {
      throw new BadRequestException({ code: 'WATER_ACCOUNT_NOT_FOUND' });
    }
    // RC audit M-1: a CLOSED account must not gain new settlement activity —
    // otherwise a FINAL settlement + unpostable DRAFT bill is left dangling
    // (postOneBill's own CLOSED guard can never clean it up).
    if (account.status === 'CLOSED') {
      throw new ConflictException({
        code: 'WATER_ACCOUNT_CLOSED',
        waterAccountId: account.id,
      });
    }

    // Scope first: a 409-before-403 order would leak whether
    // (account, period) is already settled to an out-of-scope writer.
    await this.assertAccountScope(tx, ctx, body.waterAccountId, body.period);

    // Friendly pre-check; the unique index still guards the race below.
    const dup = await tx.consumptionSettlement.findFirst({
      where: {
        tenantId: ctx.tenantId,
        waterAccountId: body.waterAccountId,
        period: body.period,
      },
      select: { id: true, status: true },
    });
    if (dup) {
      throw new ConflictException({
        code: 'SETTLEMENT_ALREADY_EXISTS',
        settlementId: dup.id,
        status: dup.status,
      });
    }

    const { start, end } = periodBounds(body.period);
    // Installations contributing to the period: lifetime intersects
    // [start,end) — still ACTIVE, or REMOVED during/after the period (an
    // install removed in a LATER period was active throughout this one).
    const installations = await tx.meterInstallation.findMany({
      where: {
        tenantId: ctx.tenantId,
        waterAccountId: body.waterAccountId,
        installedAt: { lt: end },
        OR: [{ removedAt: null }, { removedAt: { gte: start } }],
      },
      select: {
        id: true,
        meterId: true,
        installedAt: true,
        removedAt: true,
        initialReading: true,
        finalReading: true,
        status: true,
        meter: { select: { maxDial: true } },
      },
      orderBy: [{ installedAt: 'asc' }, { id: 'asc' }],
    });
    if (installations.length === 0) {
      throw new BadRequestException({
        code: 'NO_INSTALLATION_IN_PERIOD',
        waterAccountId: body.waterAccountId,
        period: body.period,
      });
    }

    const instIds = installations.map((i) => i.id);
    const prevChain = await this.prevChain(tx, ctx, body.waterAccountId, instIds, body.period);
    const readings = await this.validReadings(tx, ctx, instIds, body.period);
    const readerEstimates = await this.readerEstimates(tx, ctx, instIds, body.period);
    const history = await this.historyUsages(tx, ctx, body.waterAccountId, body.period);
    const suggested = estimateAvg3(history);
    const suggestedPrisma =
      suggested === null ? null : new Prisma.Decimal(suggested.toString());

    // Merge operator overrides into one map; the top-level usageQty is a
    // shorthand resolved once the estimated-component count is known.
    const overrideMap = new Map<string, Prisma.Decimal>();
    for (const o of body.overrides ?? []) {
      if (overrideMap.has(o.installationId)) {
        throw new BadRequestException({
          code: 'DUPLICATE_OVERRIDE',
          installationId: o.installationId,
        });
      }
      overrideMap.set(o.installationId, o.usageQty);
    }

    // Pass 1: split installations into READING-sourced vs needs-estimate.
    const drafts: ComponentDraft[] = [];
    const estimatedInsts: InstallationRow[] = [];
    for (const inst of installations) {
      const checkpoint = prevChain.get(inst.id);
      const prev = checkpoint?.value ?? inst.initialReading;
      const removedInPeriod =
        inst.status === 'REMOVED' && inst.removedAt !== null && inst.removedAt < end;
      const valid = readings.get(inst.id);
      const actualEnd = removedInPeriod && inst.finalReading !== null
        ? inst.finalReading : valid?.readingValue;
      // An estimated end is not a physical dial: maxDial cannot turn an
      // over-estimate into a rollover. Correct billed estimates first.
      if (checkpoint?.sourceType === 'ESTIMATE' && actualEnd?.lt(prev)) {
        throw new ConflictException({
          code: 'ESTIMATE_RECOVERY_REQUIRES_RECONCILIATION',
          waterAccountId: body.waterAccountId,
          installationId: inst.id,
          period: body.period,
          estimatedReadingValue: prev.toString(),
          actualReadingValue: actualEnd.toString(),
        });
      }
      if (removedInPeriod && inst.finalReading !== null) {
        // 拆表 final_reading is the end-of-life dial fact — it wins over any
        // earlier in-period reading on this installation.
        drafts.push({
          installationId: inst.id,
          prevReadingValue: prev,
          endReadingValue: inst.finalReading,
          usageQty: this.usageFromDial(prev, inst.finalReading, inst),
          sourceType: 'READING',
          sourceReadingId: null,
        });
      } else if (valid) {
        drafts.push({
          installationId: inst.id,
          prevReadingValue: prev,
          endReadingValue: valid.readingValue,
          usageQty: this.usageFromDial(prev, valid.readingValue, inst),
          sourceType: 'READING',
          sourceReadingId: valid.id,
        });
      } else {
        estimatedInsts.push(inst);
        drafts.push({
          installationId: inst.id,
          prevReadingValue: prev,
          // filled in pass 2
          endReadingValue: prev,
          usageQty: new Prisma.Decimal(0),
          sourceType: 'ESTIMATE',
          sourceReadingId: null,
          suggestedUsageQty: suggestedPrisma,
        });
      }
    }

    // The flat usageQty shorthand only makes sense when exactly one
    // component needs an estimate — anything else is an operator error.
    if (body.usageQty !== undefined) {
      if (estimatedInsts.length === 0) {
        throw new BadRequestException({
          code: 'OVERRIDE_TARGET_INVALID',
          error: 'no component requires an estimate',
        });
      }
      if (estimatedInsts.length > 1) {
        throw new BadRequestException({
          code: 'USAGE_QTY_AMBIGUOUS',
          estimatedInstallations: estimatedInsts.map((i) => i.id),
        });
      }
      if (overrideMap.has(estimatedInsts[0].id)) {
        throw new BadRequestException({
          code: 'USAGE_QTY_AMBIGUOUS',
          installationId: estimatedInsts[0].id,
        });
      }
      overrideMap.set(estimatedInsts[0].id, body.usageQty);
    }

    // Overrides may only target installations on the ESTIMATE path — a
    // component with a real dial fact is corrected via QC/supersede,
    // never by keying over it.
    for (const installationId of overrideMap.keys()) {
      if (!estimatedInsts.some((i) => i.id === installationId)) {
        throw new BadRequestException({
          code: 'OVERRIDE_TARGET_INVALID',
          installationId,
        });
      }
    }

    // Pass 2: resolve the estimated components.
    // Priority (v0.2): explicit settlement override > reader-entered
    // estimate (NO_READ.estimate_qty) > AUTO_AVG3. Audit markers:
    //   MANUAL + sourceReadingId = null  → settle-time operator override
    //   MANUAL + sourceReadingId = row   → reader's entry estimate
    //   AUTO_AVG3                        → system suggestion
    let manualApplied = false;
    for (const draft of drafts) {
      if (draft.sourceType !== 'ESTIMATE') continue;
      const override = overrideMap.get(draft.installationId);
      const readerEstimate = readerEstimates.get(draft.installationId);
      let usage: Prisma.Decimal;
      if (override !== undefined) {
        usage = override;
        draft.method = 'MANUAL';
        draft.sourceReadingId = null;
        manualApplied = true;
      } else if (readerEstimate !== undefined) {
        usage = readerEstimate.qty;
        draft.method = 'MANUAL';
        draft.sourceReadingId = readerEstimate.readingId;
        manualApplied = true;
      } else if (suggestedPrisma !== null) {
        usage = suggestedPrisma;
        draft.method = 'AUTO_AVG3';
      } else {
        // No history and no operator value — billing zero silently is
        // worse than forcing the decision back on the operator.
        throw new BadRequestException({
          code: 'ESTIMATE_USAGE_REQUIRED',
          installationId: draft.installationId,
        });
      }
      draft.usageQty = usage;
      draft.endReadingValue = draft.prevReadingValue.plus(usage);
    }

    const isEstimated = drafts.some((d) => d.sourceType === 'ESTIMATE');
    if (isEstimated && !body.estimateReason) {
      throw new BadRequestException({ code: 'ESTIMATE_REASON_REQUIRED' });
    }

    const totalUsageQty = drafts.reduce(
      (acc, d) => acc.plus(d.usageQty),
      new Prisma.Decimal(0),
    );
    const estimateMethod: EstimateMethod = manualApplied ? 'MANUAL' : 'AUTO_AVG3';
    const estimateBasis = isEstimated
      ? ({
          historyUsageQtys: history.map((d) => d.toString()),
          componentBreakdown: drafts.map((d) => ({
            installationId: d.installationId,
            sourceType: d.sourceType,
            sourceReadingId: d.sourceReadingId,
            prevReadingValue: d.prevReadingValue.toString(),
            endReadingValue: d.endReadingValue.toString(),
            usageQty: d.usageQty.toString(),
            ...(d.method !== undefined ? { method: d.method } : {}),
            ...(d.suggestedUsageQty !== undefined
              ? {
                  suggestedUsageQty:
                    d.suggestedUsageQty === null ? null : d.suggestedUsageQty.toString(),
                }
              : {}),
          })),
        } satisfies Prisma.InputJsonValue)
      : Prisma.DbNull;

    // Freeze the household declaration effective for this period — billing
    // must never read the account's current value (later declarations must
    // not reprice history).
    const householdProfile = await tx.waterAccountHouseholdProfile.findFirst({
      where: {
        tenantId: ctx.tenantId,
        waterAccountId: body.waterAccountId,
        effectiveFromPeriod: { lte: body.period },
      },
      orderBy: { effectiveFromPeriod: 'desc' },
      select: { householdSize: true },
    });

    let settlement;
    try {
      settlement = await tx.consumptionSettlement.create({
        data: {
          tenantId: ctx.tenantId,
          waterAccountId: body.waterAccountId,
          period: body.period,
          totalUsageQty,
          isEstimated,
          estimateMethod: isEstimated ? estimateMethod : null,
          estimateBasis,
          estimateReason: isEstimated ? body.estimateReason : null,
          householdSizeSnapshot: householdProfile?.householdSize ?? null,
          status: 'DRAFT',
          createdBy: ctx.staffId,
          updatedBy: ctx.staffId,
        },
        select: SETTLEMENT_SELECT,
      });
    } catch (err) {
      // The unique index is the real guard — a concurrent generate for the
      // same account+period lands here (the pre-check above only makes the
      // common path's error nicer).
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        // Same response shape as the friendly pre-check — the winner's row
        // is committed by now, so its id/status are safe to read.
        const winner = await tx.consumptionSettlement.findFirst({
          where: {
            tenantId: ctx.tenantId,
            waterAccountId: body.waterAccountId,
            period: body.period,
          },
          select: { id: true, status: true },
        });
        throw new ConflictException({
          code: 'SETTLEMENT_ALREADY_EXISTS',
          settlementId: winner?.id ?? null,
          status: winner?.status ?? null,
        });
      }
      throw err;
    }

    await tx.consumptionComponent.createMany({
      data: drafts.map((d) => ({
        tenantId: ctx.tenantId,
        settlementId: settlement.id,
        installationId: d.installationId,
        prevReadingValue: d.prevReadingValue,
        endReadingValue: d.endReadingValue,
        usageQty: d.usageQty,
        sourceType: d.sourceType,
        sourceReadingId: d.sourceReadingId,
        createdBy: ctx.staffId,
        updatedBy: ctx.staffId,
      })),
    });

    return (await this.attachDetails(tx, ctx, [settlement]))[0];
  }

  /**
   * POST /consumption-settlements/:id/finalize — DRAFT → FINAL guarded
   * transition. FINAL is immutable: the correct-a-FINAL path is T11
   * reconciliation, not a status flip back.
   */
  async finalizeTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    id: string,
    req: Request,
  ) {
    const existing = await tx.consumptionSettlement.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!existing) throw new NotFoundException({ code: 'SETTLEMENT_NOT_FOUND' });
    await this.assertAccountScope(tx, ctx, existing.waterAccountId, existing.period);
    if (existing.status !== 'DRAFT') {
      throw invalidTransition(existing.status, 'FINAL');
    }
    // RC audit M-1: a DRAFT orphaned by an account close can never become
    // FINAL — closing with outstanding=0 is still allowed, but the leftover
    // DRAFT stays DRAFT forever instead of entering the billing pipeline.
    const acc = await tx.waterAccount.findFirst({
      where: { tenantId: ctx.tenantId, id: existing.waterAccountId },
      select: { status: true },
    });
    if (acc?.status === 'CLOSED') {
      throw new ConflictException({
        code: 'WATER_ACCOUNT_CLOSED',
        waterAccountId: existing.waterAccountId,
      });
    }
    req.auditBefore = existing;
    const flipped = await tx.consumptionSettlement.updateMany({
      where: { tenantId: ctx.tenantId, id, status: 'DRAFT' },
      data: { status: 'FINAL', updatedBy: ctx.staffId },
    });
    if (flipped.count === 0) throw invalidTransition(existing.status, 'FINAL');
    const row = await tx.consumptionSettlement.findFirst({
      where: { tenantId: ctx.tenantId, id },
      select: SETTLEMENT_SELECT,
    });
    return (await this.attachDetails(tx, ctx, [row!]))[0];
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /** Attach components + consecutiveEstimates to a page of settlements. */
  private async attachDetails<T extends { id: string; waterAccountId: string }>(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    rows: T[],
  ) {
    if (rows.length === 0) return [];
    const components = await tx.consumptionComponent.findMany({
      where: { tenantId: ctx.tenantId, settlementId: { in: rows.map((r) => r.id) } },
      select: COMPONENT_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const bySettlement = new Map<string, typeof components>();
    for (const c of components) {
      const list = bySettlement.get(c.settlementId) ?? [];
      list.push(c);
      bySettlement.set(c.settlementId, list);
    }
    const streaks = await this.estimateStreaks(
      tx,
      ctx,
      [...new Set(rows.map((r) => r.waterAccountId))],
    );
    return rows.map((r) => ({
      ...r,
      components: bySettlement.get(r.id) ?? [],
      consecutiveEstimates: streaks.get(r.id) ?? 0,
    }));
  }

  /**
   * Per-settlement trailing count of consecutive estimated settlements —
   * the 补抄台账 counter (spec §2.3, tenant param
   * `max_consecutive_estimates` is evaluated by the report, not here).
   * Measured over the account's settlement rows ordered by period; a
   * missing (unsettled) month does not reset the streak — the meter still
   * wasn't actually read.
   */
  private async estimateStreaks(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    waterAccountIds: string[],
  ) {
    const rows = await tx.consumptionSettlement.findMany({
      where: { tenantId: ctx.tenantId, waterAccountId: { in: waterAccountIds } },
      select: { id: true, waterAccountId: true, period: true, isEstimated: true },
      orderBy: [{ waterAccountId: 'asc' }, { period: 'asc' }],
    });
    const streak = new Map<string, number>();
    const run = new Map<string, number>();
    for (const r of rows) {
      const cur = r.isEstimated ? (run.get(r.waterAccountId) ?? 0) + 1 : 0;
      run.set(r.waterAccountId, cur);
      streak.set(r.id, cur);
    }
    return streak;
  }

  /**
   * prev chain: each installation's latest component end_reading_value
   * from a settlement with period < current (NULL synthetic/manual ends
   * skipped). Rows arrive latest-first, so the first hit per installation
   * wins. A completed adjustment also establishes a trusted actual dial
   * checkpoint: its usage has already been repriced, even if the actual
   * period did not have a settlement yet. Never mutate frozen components.
   */
  private async prevChain(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    waterAccountId: string,
    installationIds: string[],
    period: string,
  ) {
    const prior = await tx.consumptionComponent.findMany({
      where: {
        tenantId: ctx.tenantId,
        installationId: { in: installationIds },
        endReadingValue: { not: null },
        settlement: {
          tenantId: ctx.tenantId,
          waterAccountId,
          period: { lt: period },
        },
      },
      select: {
        installationId: true,
        endReadingValue: true,
        sourceType: true,
        sourceReadingId: true,
        createdAt: true,
        settlement: { select: { period: true } },
      },
      orderBy: [{ settlement: { period: 'desc' } }, { createdAt: 'desc' }],
    });
    const prev = new Map<string, DialCheckpoint>();
    for (const c of prior) {
      if (!prev.has(c.installationId) && c.endReadingValue !== null) {
        prev.set(c.installationId, {
          value: c.endReadingValue,
          sourceType: c.sourceType,
          period: c.settlement.period,
          sourceReadingId: c.sourceReadingId,
        });
      }
    }

    const applied = await tx.reconciliation.findMany({
      where: { tenantId: ctx.tenantId, waterAccountId, status: 'APPLIED', toPeriod: { lte: period } },
      select: { actualReadingId: true },
    });
    if (applied.length === 0) return prev;
    const actuals = await tx.meterReading.findMany({
      where: {
        tenantId: ctx.tenantId,
        id: { in: applied.map((r) => r.actualReadingId) },
        installationId: { in: installationIds },
        period: { lte: period },
        resultType: { in: ['ACTUAL', 'REMOTE'] },
        qcStatus: 'PASSED',
        readingValue: { not: null },
      },
      select: { id: true, installationId: true, period: true, readingValue: true, readDate: true, createdAt: true },
      orderBy: [{ period: 'desc' }, { readDate: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
    });
    if (actuals.length === 0) return prev;
    const priorReadingIds = [...prev.values()].flatMap((p) => p.sourceReadingId ? [p.sourceReadingId] : []);
    const priorReadings = priorReadingIds.length ? await tx.meterReading.findMany({
      where: { tenantId: ctx.tenantId, id: { in: priorReadingIds } },
      select: { id: true, readDate: true, createdAt: true },
    }) : [];
    const priorById = new Map(priorReadings.map((r) => [r.id, r]));
    const children = await tx.meterReading.findMany({
      where: { tenantId: ctx.tenantId, supersedesReadingId: { in: [...actuals.map((r) => r.id), ...priorReadingIds] } },
      select: { supersedesReadingId: true },
    });
    const superseded = new Set(children.map((r) => r.supersedesReadingId));
    const seen = new Set<string>();
    for (const actual of actuals) {
      if (superseded.has(actual.id) || actual.readingValue === null || seen.has(actual.installationId)) continue;
      seen.add(actual.installationId);
      const prior = prev.get(actual.installationId);
      if (prior && actual.period === prior.period && prior.sourceType !== 'ESTIMATE') {
        // A same-month component may already consume usage AFTER this
        // checkpoint. Keep that newer physical dial. Correcting a superseded
        // source reading, however, must replace the stale frozen dial.
        const source = prior.sourceReadingId ? priorById.get(prior.sourceReadingId) : undefined;
        if (!source || (prior.sourceReadingId && !superseded.has(prior.sourceReadingId) &&
          (source.readDate > actual.readDate ||
            (+source.readDate === +actual.readDate && source.createdAt >= actual.createdAt)))) continue;
      }
      if (!prior || actual.period >= prior.period) {
        prev.set(actual.installationId, {
          value: actual.readingValue, sourceType: 'READING', period: actual.period, sourceReadingId: actual.id,
        });
      }
    }
    return prev;
  }

  /**
   * The VALID reading per installation for the period: PASSED +
   * ACTUAL|REMOTE + not superseded. The superseded check is a child-row
   * probe, NOT `supersedes_reading_id IS NULL` — a superseded parent keeps
   * that field NULL while its correcting child carries the verdict (T6
   * review). Latest readDate wins when several valid rows exist.
   */
  private async validReadings(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    installationIds: string[],
    period: string,
  ) {
    const candidates = await tx.meterReading.findMany({
      where: {
        tenantId: ctx.tenantId,
        installationId: { in: installationIds },
        period,
        resultType: { in: ['ACTUAL', 'REMOTE'] },
        qcStatus: 'PASSED',
      },
      select: {
        id: true,
        installationId: true,
        readingValue: true,
        readDate: true,
        createdAt: true,
      },
      orderBy: [{ readDate: 'desc' }, { createdAt: 'desc' }],
    });
    if (candidates.length === 0) return new Map<string, { id: string; readingValue: Prisma.Decimal }>();
    const children = await tx.meterReading.findMany({
      where: {
        tenantId: ctx.tenantId,
        supersedesReadingId: { in: candidates.map((c) => c.id) },
      },
      select: { supersedesReadingId: true },
    });
    const superseded = new Set(children.map((c) => c.supersedesReadingId));
    const valid = new Map<string, { id: string; readingValue: Prisma.Decimal }>();
    for (const r of candidates) {
      if (superseded.has(r.id) || r.readingValue === null) continue;
      if (!valid.has(r.installationId)) {
        valid.set(r.installationId, { id: r.id, readingValue: r.readingValue });
      }
    }
    return valid;
  }

  /**
   * Operator-entered NO_READ estimates for this period, latest per
   * installation. A REJECTED NO_READ row's estimate is untrusted (QC said
   * the visit record is wrong) — only PENDING/PASSED/MANUAL_REVIEW count.
   * estimate_qty is a quantity, never a dial — used as the ESTIMATE
   * component's usage ahead of AVG3, with sourceReadingId linking back.
   */
  private async readerEstimates(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    installationIds: string[],
    period: string,
  ) {
    const rows = await tx.meterReading.findMany({
      where: {
        tenantId: ctx.tenantId,
        installationId: { in: installationIds },
        period,
        resultType: 'NO_READ',
        estimateQty: { not: null },
        qcStatus: { not: 'REJECTED' },
      },
      select: { id: true, installationId: true, estimateQty: true },
      orderBy: [{ readDate: 'desc' }, { createdAt: 'desc' }],
    });
    const map = new Map<string, { readingId: string; qty: Prisma.Decimal }>();
    for (const r of rows) {
      if (!map.has(r.installationId) && r.estimateQty !== null) {
        map.set(r.installationId, { readingId: r.id, qty: r.estimateQty });
      }
    }
    return map;
  }

  /**
   * The account's last ≤3 READING-derived component usages (settlements
   * with period < current), chronological order — the AVG3 basis. Any
   * settlement status counts: a DRAFT's READING component is still a real
   * dial delta, and settlement generation runs period-sequential anyway.
   * History is account-level, not per-installation: a swapped-in meter
   * inherits the account's usage pattern, which is exactly what the spec's
   * mid-swap example needs. MVP caveat: on a true multi-meter account the
   * same suggestion lands on every estimated component — the one-meter-
   * per-account reality makes this moot today.
   */
  private async historyUsages(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    waterAccountId: string,
    period: string,
  ) {
    const rows = await tx.consumptionComponent.findMany({
      where: {
        tenantId: ctx.tenantId,
        sourceType: 'READING',
        settlement: {
          tenantId: ctx.tenantId,
          waterAccountId,
          period: { lt: period },
        },
      },
      select: {
        usageQty: true,
        createdAt: true,
        settlement: { select: { period: true } },
      },
      orderBy: [
        { settlement: { period: 'desc' } },
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
      take: 3,
    });
    return rows.map((r) => r.usageQty).reverse();
  }

  /**
   * Dial delta with rollover: end < prev only makes sense when the meter
   * rolled past max_dial — usage = (maxDial − prev) + end. Without
   * maxDial (or a still-negative result) the facts are inconsistent → 400;
   * the fix is a supersede/QC, not a silently-clamped bill.
   */
  private usageFromDial(
    prev: Prisma.Decimal,
    end: Prisma.Decimal,
    inst: InstallationRow,
  ): Prisma.Decimal {
    let usage = end.minus(prev);
    if (usage.isNegative()) {
      if (inst.meter.maxDial !== null) {
        if (prev.gt(inst.meter.maxDial)) {
          // prev above the dial ceiling is corrupt data — a rollover
          // formula would return a positive-but-wrong usage. Fail loud.
          throw new BadRequestException({
            code: 'PREV_EXCEEDS_MAX_DIAL',
            installationId: inst.id,
            prevReadingValue: prev.toString(),
            maxDial: inst.meter.maxDial.toString(),
          });
        }
        usage = inst.meter.maxDial.minus(prev).plus(end);
      }
      if (usage.isNegative()) {
        throw new BadRequestException({
          code: 'NEGATIVE_USAGE',
          installationId: inst.id,
          prevReadingValue: prev.toString(),
          endReadingValue: end.toString(),
          maxDial: inst.meter.maxDial?.toString() ?? null,
        });
      }
    }
    return usage;
  }

  /**
   * Org guard for settlement writes: resolved through the period's plan
   * items → plans → books (same chain as meter-reading). EVERY covering
   * book's org must be in scope — settling consumes facts from all of
   * them. An account+period with no plan item has no org anchor (same
   * carve-out as assertReadingScope: MVP only produces org-less state
   * via off-book accounts; noted for the reviewer).
   */
  private async assertAccountScope(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    waterAccountId: string,
    period: string,
  ) {
    const items = await tx.readingPlanItem.findMany({
      where: {
        tenantId: ctx.tenantId,
        waterAccountId,
        plan: { tenantId: ctx.tenantId, period },
      },
      select: { planId: true },
    });
    if (items.length === 0) return;
    const plans = await tx.readingPlan.findMany({
      where: { tenantId: ctx.tenantId, id: { in: items.map((i) => i.planId) } },
      select: { bookId: true },
    });
    const books = await tx.readingBook.findMany({
      where: { tenantId: ctx.tenantId, id: { in: plans.map((p) => p.bookId) } },
      select: { orgUnitId: true },
    });
    for (const b of books) {
      if (!orgInScope(ctx, b.orgUnitId)) throw outOfScope();
    }
  }
}
