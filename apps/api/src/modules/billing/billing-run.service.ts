import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DomainError } from '@ws/billing-core';
import type { Request } from 'express';
import { isUniqueViolation } from '../../common/prisma-errors.js';
import type { TenantCtx } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { BILL_SELECT, type BillRow } from './bill.service.js';
import {
  billDueDays,
  computeBill,
  feeItemIdMap,
  insertBillItems,
  loadFeeItems,
  lockPlanForUpdate,
  periodLastDay,
  pickPlan,
  ytdBeforeQty,
} from './pricing.js';

export const BILLING_RUN_SELECT = {
  id: true,
  tenantId: true,
  period: true,
  runType: true,
  status: true,
  postedAt: true,
  totalCount: true,
  successCount: true,
  failedCount: true,
  failedSettlementIds: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.BillingRunSelect;

type RunStatus = 'DRAFT' | 'PROCESSING' | 'PARTIAL' | 'POSTED' | 'FAILED';

/**
 * One failure record inside billing_run.failed_settlement_ids (jsonb).
 * `stage` tells generation failures (no bill exists for the settlement)
 * from post failures (a DRAFT bill exists but couldn't flip). A record is
 * dropped as soon as the settlement/bill succeeds — the array always
 * reflects the CURRENT unresolved failures, so retry rewrites it.
 */
export interface RunFailure {
  settlementId: string;
  /** Present on post-stage records — the DRAFT bill that failed to flip. */
  billId?: string;
  stage: 'generate' | 'post';
  code: string;
  message?: string;
}

/** Non-DB failure recorded into failed_settlement_ids instead of thrown. */
class RecordedFailure extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

const invalidTransition = (from: string, to: string) =>
  new ConflictException({ code: 'INVALID_RUN_STATUS_TRANSITION', from, to });

/** JSON column → typed failure list; tolerates legacy/garbage shapes. */
const parseFailures = (v: Prisma.JsonValue | null): RunFailure[] =>
  Array.isArray(v)
    ? (v.filter((e) => e && typeof e === 'object') as unknown as RunFailure[])
    : [];

interface SettlementRow {
  id: string;
  waterAccountId: string;
  totalUsageQty: Prisma.Decimal;
  isEstimated: boolean;
}

interface AccountFacts {
  usageCategory: string;
  settleAccountId: string;
}

/**
 * BillingRun （开账批次） — a period batch that turns FINAL consumption
 * settlements into bills (spec §2.5).
 *
 * Lifecycle: `DRAFT → PROCESSING → POSTED | PARTIAL | FAILED`.
 *
 *  - POST /billing-runs {period} creates the DRAFT run AND synchronously
 *    generates one DRAFT NORMAL bill per FINAL settlement of the period
 *    (试算 preview — nothing is issued yet). Settlements that can't be
 *    priced (no ACTIVE tariff covering the period for the account's
 *    usage_category, or a compute failure) produce NO bill and are
 *    recorded in failed_settlement_ids (stage 'generate'). A settlement
 *    that already has a NORMAL bill — from any run — is skipped as
 *    already-billed and counts toward success at post; the
 *    UNIQUE(tenant_id, source_type, source_id, bill_kind) index is the
 *    idempotency backstop for the race.
 *  - POST /billing-runs/:id/post claims DRAFT|PARTIAL → PROCESSING and
 *    executes the run SYNCHRONOUSLY in-request: stage A re-attempts
 *    generation for every recorded failure (a tariff fix between post and
 *    retry is how a PARTIAL run reaches POSTED — "重跑失败户"); stage B
 *    posts every remaining DRAFT bill of the run, EACH IN ITS OWN
 *    TRANSACTION: `SELECT … FOR UPDATE` on the bill's tariff_plan row
 *    FIRST (mandatory T8 freeze contract — it serializes against the
 *    tariff freeze probe + guarded PATCH writes), then the guarded
 *    DRAFT→POSTED updateMany. A per-bill failure is recorded and never
 *    blocks the batch.
 *  - POST /:id/retry is the same execution path, allowed from
 *    PARTIAL|FAILED|PROCESSING — PROCESSING can only be observed after a
 *    crash mid-execution, and every write inside is guarded, so
 *    re-entering is the designed rescue path.
 *  - POST /:id/discard removes a DRAFT run + its DRAFT bills in one tx.
 *    POSTED-side state is never deleted (spec §1.3); a wrong POSTED bill
 *    is corrected by reversal/replacement, not deletion.
 *
 * Counts: total_count = FINAL settlements found at generation;
 * failed_count = unresolved failures; success_count = total − failed
 * (posted this run + already-billed). Final status: failed=0 → POSTED,
 * success=0 → FAILED, otherwise PARTIAL.
 *
 * MVP execution note (deliberate deviation from the worker plan): there
 * is NO BullMQ/worker — `post` runs the whole pipeline in-request. The
 * state machine is fully preserved; a future async worker calls the same
 * execute() path unchanged, which is also what keeps e2e deterministic.
 * Accepted edge: two DRAFT runs over the same period each see the other's
 * bills as "already billed" — if one is then discarded, the other can
 * post to POSTED while its bills are gone. Reruns are operator-serial in
 * practice; flagged here rather than silently handled.
 */
@Injectable()
export class BillingRunService {
  constructor(private readonly prisma: TenantPrismaService) {}

  list(
    ctx: TenantCtx,
    q: { take: number; skip: number; period?: string; status?: RunStatus },
  ) {
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.billingRun.findMany({
        where: { tenantId: ctx.tenantId, period: q.period, status: q.status },
        select: BILLING_RUN_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: q.take,
        skip: q.skip,
      }),
    );
  }

  async getById(ctx: TenantCtx, id: string) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const run = await tx.billingRun.findFirst({
        where: { tenantId: ctx.tenantId, id },
        select: BILLING_RUN_SELECT,
      });
      if (!run) throw new NotFoundException({ code: 'BILLING_RUN_NOT_FOUND' });
      return this.withBills(tx, ctx, run);
    });
  }

  /**
   * POST /billing-runs — create the DRAFT run + generate DRAFT bills in
   * ONE transaction. A bill that can't be priced is a per-settlement
   * failure record, never an abort; unexpected (DB) errors still abort
   * the whole generation loudly — a bug must not masquerade as an
   * unbillable account.
   */
  async createTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    body: { period: string },
  ) {
    const run = await tx.billingRun.create({
      data: {
        tenantId: ctx.tenantId,
        period: body.period,
        runType: 'MANUAL',
        status: 'DRAFT',
        createdBy: ctx.staffId,
        updatedBy: ctx.staffId,
      },
      select: BILLING_RUN_SELECT,
    });

    const settlements = await tx.consumptionSettlement.findMany({
      where: { tenantId: ctx.tenantId, period: body.period, status: 'FINAL' },
      select: {
        id: true,
        waterAccountId: true,
        totalUsageQty: true,
        isEstimated: true,
      },
      orderBy: [{ waterAccountId: 'asc' }, { id: 'asc' }],
    });
    const accounts = await this.loadAccountFacts(
      tx,
      ctx,
      settlements.map((s) => s.waterAccountId),
    );
    const dueDays = await billDueDays(tx, ctx);

    const failures: RunFailure[] = [];
    for (const s of settlements) {
      const acc = accounts.get(s.waterAccountId);
      if (!acc) {
        failures.push({
          settlementId: s.id,
          stage: 'generate',
          code: 'WATER_ACCOUNT_NOT_FOUND',
        });
        continue;
      }
      // Already billed — a NORMAL bill for this settlement exists (any
      // status, any run): no duplicate, counts toward success at post.
      const existing = await tx.bill.findFirst({
        where: {
          tenantId: ctx.tenantId,
          sourceType: 'SETTLEMENT',
          sourceId: s.id,
          billKind: 'NORMAL',
        },
        select: { id: true },
      });
      if (existing) continue;

      try {
        await this.generateBillForSettlement(tx, ctx, run.id, body.period, s, acc, dueDays);
      } catch (err) {
        if (err instanceof RecordedFailure || err instanceof DomainError) {
          failures.push({
            settlementId: s.id,
            stage: 'generate',
            code: err.code,
            message: err.message,
          });
          continue;
        }
        throw err; // unexpected — abort generation loudly
      }
    }

    const drafted = await tx.bill.count({
      where: { tenantId: ctx.tenantId, billingRunId: run.id },
    });
    // billing_run has no (tenant,id) unique — the tenant-scoped findFirst
    // above + RLS are the ownership check; the update keys on the PK.
    const updated = await tx.billingRun.update({
      where: { id: run.id },
      data: {
        totalCount: settlements.length,
        // Already-billed settlements are successes even before posting —
        // their bills exist and will stand posted by their own run.
        successCount: settlements.length - failures.length - drafted,
        failedCount: failures.length,
        failedSettlementIds: failures as unknown as Prisma.InputJsonValue,
        updatedBy: ctx.staffId,
      },
      select: BILLING_RUN_SELECT,
    });
    return this.withBills(tx, ctx, updated);
  }

  /**
   * POST /billing-runs/:id/post — claim + execute (see class docblock).
   * Multi-transaction by design: the claim is one tx, each bill post is
   * its own tx, the finalize is one tx. NOT wrapped in Idempotency-Key —
   * the path is self-idempotent (a replayed post after POSTED simply
   * 409s on the claim guard; a mid-execution crash is resumed by retry).
   */
  async execute(ctx: TenantCtx, id: string, allowedFrom: RunStatus[], req: Request) {
    const claim = await this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const run = await tx.billingRun.findFirst({
        where: { tenantId: ctx.tenantId, id },
      });
      if (!run) throw new NotFoundException({ code: 'BILLING_RUN_NOT_FOUND' });
      if (!allowedFrom.includes(run.status as RunStatus)) {
        throw invalidTransition(run.status, 'PROCESSING');
      }
      req.auditBefore = run;
      const flip = await tx.billingRun.updateMany({
        where: { tenantId: ctx.tenantId, id, status: { in: allowedFrom } },
        data: { status: 'PROCESSING', updatedBy: ctx.staffId },
      });
      // Lost the race to a concurrent execution — report the transition,
      // not a phantom success.
      if (flip.count === 0) throw invalidTransition(run.status, 'PROCESSING');
      return { run };
    });

    // Stage A — re-attempt generation for every recorded generate-stage
    // failure, each in its own tx (a fixed tariff is the whole point of
    // retry). A settlement billed meanwhile drops out via the same
    // already-billed probe as generation.
    const genFailures = parseFailures(
      claim.run.failedSettlementIds as Prisma.JsonValue | null,
    ).filter((f) => f.stage === 'generate');
    const unresolved: RunFailure[] = [];
    for (const f of genFailures) {
      try {
        await this.prisma.runAsTenant(ctx.tenantId, (tx) =>
          this.retryGenerate(tx, ctx, id, claim.run.period, f.settlementId),
        );
      } catch (err) {
        // A unique violation here means a concurrent generator inserted
        // the settlement's bill first — billed is billed, the failure is
        // resolved rather than recorded.
        if (isUniqueViolation(err)) continue;
        unresolved.push(this.toFailure(f.settlementId, 'generate', err));
      }
    }

    // Stage B — post every DRAFT bill of the run, each in its own tx.
    const draftBills = await this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.bill.findMany({
        where: { tenantId: ctx.tenantId, billingRunId: id, status: 'DRAFT' },
        select: { id: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );
    const postErrors = new Map<string, { code: string; message?: string }>();
    for (const b of draftBills) {
      try {
        await this.prisma.runAsTenant(ctx.tenantId, (tx) =>
          this.postOneBill(tx, ctx, b.id),
        );
      } catch (err) {
        postErrors.set(b.id, {
          code:
            err instanceof RecordedFailure || err instanceof DomainError
              ? err.code
              : 'BILL_POST_FAILED',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Finalize — rebuild the failure list from committed truth: unresolved
    // generate records + every still-DRAFT bill (each gets the error its
    // post attempt produced). A bill posted on a previous execution has
    // no entry; a bill that failed earlier but posts now loses its entry.
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const bills = await tx.bill.findMany({
        where: { tenantId: ctx.tenantId, billingRunId: id },
        select: { id: true, sourceId: true, status: true },
      });
      const postRecords: RunFailure[] = bills
        .filter((b) => b.status === 'DRAFT')
        .map((b) => ({
          settlementId: b.sourceId,
          billId: b.id,
          stage: 'post',
          ...(postErrors.get(b.id) ?? { code: 'BILL_POST_FAILED' }),
        }));
      const all = [...unresolved, ...postRecords];
      const failedCount = all.length;
      const successCount = claim.run.totalCount - failedCount;
      const status: RunStatus =
        failedCount === 0 ? 'POSTED' : successCount === 0 ? 'FAILED' : 'PARTIAL';
      const updated = await tx.billingRun.update({
        where: { id },
        data: {
          status,
          successCount,
          failedCount,
          failedSettlementIds: all as unknown as Prisma.InputJsonValue,
          postedAt: status === 'POSTED' ? new Date() : null,
          updatedBy: ctx.staffId,
        },
        select: BILLING_RUN_SELECT,
      });
      return this.withBills(tx, ctx, updated);
    });
  }

  /**
   * POST /billing-runs/:id/discard — DRAFT-only teardown. The run row is
   * deleted FIRST behind a status guard: a concurrent post flipping the
   * run to PROCESSING between our read and this statement makes the
   * delete count=0 (row lock serialization), not a deleted live run.
   * Bills are deleted DRAFT-only — a POSTED bill can never exist in a
   * DRAFT run, and the predicate keeps it that way by construction.
   */
  async discardTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    id: string,
    req: Request,
  ) {
    const existing = await tx.billingRun.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!existing) throw new NotFoundException({ code: 'BILLING_RUN_NOT_FOUND' });
    if (existing.status !== 'DRAFT') {
      throw invalidTransition(existing.status, 'DISCARD');
    }
    req.auditBefore = existing;

    const removed = await tx.billingRun.deleteMany({
      where: { tenantId: ctx.tenantId, id, status: 'DRAFT' },
    });
    if (removed.count === 0) throw invalidTransition(existing.status, 'DISCARD');
    const bills = await tx.bill.findMany({
      where: { tenantId: ctx.tenantId, billingRunId: id },
      select: { id: true },
    });
    await tx.billItem.deleteMany({
      where: { tenantId: ctx.tenantId, billId: { in: bills.map((b) => b.id) } },
    });
    await tx.bill.deleteMany({
      where: { tenantId: ctx.tenantId, billingRunId: id, status: 'DRAFT' },
    });
    return { ...existing, deletedBillCount: bills.length };
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private async withBills<T extends { id: string }>(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    run: T,
  ) {
    const bills = await tx.bill.findMany({
      where: { tenantId: ctx.tenantId, billingRunId: run.id },
      select: BILL_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return { ...run, bills };
  }

  private async loadAccountFacts(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    waterAccountIds: string[],
  ): Promise<Map<string, AccountFacts>> {
    if (waterAccountIds.length === 0) return new Map();
    const rows = await tx.waterAccount.findMany({
      where: { tenantId: ctx.tenantId, id: { in: [...new Set(waterAccountIds)] } },
      select: { id: true, usageCategory: true, settleAccountId: true },
    });
    return new Map(
      rows.map((r) => [
        r.id,
        { usageCategory: r.usageCategory, settleAccountId: r.settleAccountId },
      ]),
    );
  }

  /**
   * Price one FINAL settlement into a DRAFT NORMAL bill: tariff pick →
   * fee items → ytd ladder cursor → computeBill → plan FOR UPDATE lock →
   * bill + item inserts. Throws RecordedFailure('TARIFF_NOT_FOUND') when
   * no ACTIVE plan covers the period; engine DomainErrors propagate.
   */
  private async generateBillForSettlement(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    runId: string,
    period: string,
    s: SettlementRow,
    acc: AccountFacts,
    dueDays: number,
  ): Promise<BillRow> {
    const plan = await pickPlan(tx, ctx, acc.usageCategory, period);
    if (!plan) {
      throw new RecordedFailure(
        'TARIFF_NOT_FOUND',
        `no ACTIVE tariff for usageCategory ${acc.usageCategory} covering ${period}`,
      );
    }
    const feeItems = await loadFeeItems(tx, ctx, plan.id);
    const ytd = await ytdBeforeQty(tx, ctx, s.waterAccountId, period);
    const result = computeBill({
      usageQty: s.totalUsageQty,
      ytdBeforeQty: ytd,
      feeItems,
    });
    const dueDate = new Date(
      periodLastDay(period).getTime() + dueDays * 86_400_000,
    );
    // T8 freeze contract: lock the plan row before the bill row exists.
    await lockPlanForUpdate(tx, ctx, plan.id);
    const bill = await tx.bill.create({
      data: {
        tenantId: ctx.tenantId,
        billingRunId: runId,
        settleAccountId: acc.settleAccountId,
        waterAccountId: s.waterAccountId,
        period,
        billKind: 'NORMAL',
        sourceType: 'SETTLEMENT',
        sourceId: s.id,
        tariffPlanId: plan.id,
        status: 'DRAFT',
        isEstimated: s.isEstimated,
        totalAmount: result.totalAmountCent,
        dueDate,
        createdBy: ctx.staffId,
        updatedBy: ctx.staffId,
      },
      select: BILL_SELECT,
    });
    const idMap = await feeItemIdMap(
      tx,
      ctx,
      result.items.map((i) => i.feeItemCode),
    );
    await insertBillItems(tx, ctx, bill.id, result.items, idMap);
    return bill;
  }

  /**
   * Stage-A re-attempt for one failed settlement inside its own tx:
   * already-billed → no-op (failure resolved); still unbillable → throws
   * the code that keeps it in failed_settlement_ids.
   */
  private async retryGenerate(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    runId: string,
    period: string,
    settlementId: string,
  ) {
    const s = await tx.consumptionSettlement.findFirst({
      where: { tenantId: ctx.tenantId, id: settlementId, status: 'FINAL' },
      select: {
        id: true,
        waterAccountId: true,
        totalUsageQty: true,
        isEstimated: true,
      },
    });
    if (!s) throw new RecordedFailure('SETTLEMENT_NOT_FINAL');
    const acc = (
      await this.loadAccountFacts(tx, ctx, [s.waterAccountId])
    ).get(s.waterAccountId);
    if (!acc) throw new RecordedFailure('WATER_ACCOUNT_NOT_FOUND');
    const existing = await tx.bill.findFirst({
      where: {
        tenantId: ctx.tenantId,
        sourceType: 'SETTLEMENT',
        sourceId: s.id,
        billKind: 'NORMAL',
      },
      select: { id: true },
    });
    if (existing) return; // billed by another run meanwhile
    const dueDays = await billDueDays(tx, ctx);
    try {
      await this.generateBillForSettlement(tx, ctx, runId, period, s, acc, dueDays);
    } catch (err) {
      // Keep P2002 raw: stage A maps a lost unique race to "resolved",
      // not to a failure record.
      if (isUniqueViolation(err)) throw err;
      if (err instanceof RecordedFailure || err instanceof DomainError) throw err;
      throw new RecordedFailure('BILL_GENERATE_FAILED', String(err));
    }
  }

  /**
   * Stage-B post of ONE bill inside its own tx: tariff_plan FOR UPDATE
   * FIRST (the T8 freeze contract applies here because the flip is what
   * creates the non-DRAFT reference), then the guarded DRAFT→POSTED
   * updateMany — a concurrent flip loses with count=0 and is re-read:
   * already POSTED means the bill got posted by another run's pass over
   * the same settlement (billed = success, not a failure).
   */
  private async postOneBill(tx: Prisma.TransactionClient, ctx: TenantCtx, billId: string) {
    const bill = await tx.bill.findFirst({
      where: { tenantId: ctx.tenantId, id: billId },
      select: { id: true, status: true, tariffPlanId: true },
    });
    if (!bill) throw new RecordedFailure('BILL_NOT_FOUND');
    if (bill.tariffPlanId) await lockPlanForUpdate(tx, ctx, bill.tariffPlanId);
    const flip = await tx.bill.updateMany({
      where: { tenantId: ctx.tenantId, id: billId, status: 'DRAFT' },
      data: { status: 'POSTED', issuedAt: new Date(), updatedBy: ctx.staffId },
    });
    if (flip.count === 0) {
      const cur = await tx.bill.findFirst({
        where: { tenantId: ctx.tenantId, id: billId },
        select: { status: true },
      });
      if (cur?.status === 'POSTED') return;
      throw new RecordedFailure(
        'BILL_POST_GUARD',
        `bill is ${cur?.status ?? 'gone'}, expected DRAFT`,
      );
    }
  }

  private toFailure(
    settlementId: string,
    stage: RunFailure['stage'],
    err: unknown,
  ): RunFailure {
    if (err instanceof RecordedFailure || err instanceof DomainError) {
      return { settlementId, stage, code: err.code, message: err.message };
    }
    return {
      settlementId,
      stage,
      code: 'BILL_GENERATE_FAILED',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
