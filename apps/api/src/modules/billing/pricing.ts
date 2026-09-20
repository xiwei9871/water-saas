import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { computeBill, type FeeItemInput } from '@ws/billing-core';
import type { TenantCtx } from '../../common/tenant-context.js';

/**
 * Shared pricing facts for bill generation and replacement (spec §2.5).
 * Both BillingRunService (batch generation) and BillService (replace)
 * price against the same tariff pick / ladder cursor / row materialization
 * rules — kept in one place so the two paths can never drift.
 */

/** char(6) YYYYMM → [first day of month, first day of next month) UTC. */
export const periodBounds = (period: string): { start: Date; end: Date } => {
  const y = parseInt(period.slice(0, 4), 10);
  const m = parseInt(period.slice(4), 10);
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
};

/** Last calendar day of the period's month (due-date anchor). */
export const periodLastDay = (period: string): Date => {
  const y = parseInt(period.slice(0, 4), 10);
  const m = parseInt(period.slice(4), 10);
  return new Date(Date.UTC(y, m, 0));
};

/**
 * The tariff pick (spec §2.5: usage_category → ACTIVE version covering the
 * period): effectiveFrom < periodEnd AND (effectiveTo IS NULL OR
 * effectiveTo > periodStart) — the same half-open window the activate
 * overlap check enforces, so at most one ACTIVE version can match. The
 * orderBy is only a belt for pre-T8 legacy data that could overlap.
 */
export const pickPlan = async (
  tx: Prisma.TransactionClient,
  ctx: TenantCtx,
  usageCategory: string,
  period: string,
) => {
  const { start, end } = periodBounds(period);
  return tx.tariffPlan.findFirst({
    where: {
      tenantId: ctx.tenantId,
      usageCategory,
      status: 'ACTIVE',
      effectiveFrom: { lt: end },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: start } }],
    },
    orderBy: [{ effectiveFrom: 'desc' }, { id: 'asc' }],
  });
};

/**
 * The T8 freeze contract (tariff-plan.service isBillReferenced): ANY
 * transaction that persists a bill referencing a tariff plan must first
 * `SELECT … FOR UPDATE` the plan row. The lock serializes against the
 * freeze probe + guarded PATCH writes so a bill can never land on a plan
 * version whose calculation facts are being rewritten. Applies to DRAFT
 * bill inserts too — uniform rule, no exceptions to reason about.
 */
export const lockPlanForUpdate = async (
  tx: Prisma.TransactionClient,
  ctx: TenantCtx,
  planId: string,
) => {
  await tx.$queryRaw`
    SELECT id FROM tariff_plan
    WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${planId}::uuid
    FOR UPDATE`;
};

/**
 * Close-account ↔ bill-post serialization (I2 review): both paths take
 * this row lock, so whichever commits first wins — a POSTED bill either
 * lands before close reads outstanding (blocking it) or finds the
 * account already CLOSED and refuses. Lock order is always
 * water_account → tariff_plan; nothing locks in the reverse order, so
 * no deadlock cycle exists.
 */
export const lockAccountForUpdate = async (
  tx: Prisma.TransactionClient,
  ctx: TenantCtx,
  waterAccountId: string,
) => {
  await tx.$queryRaw`
    SELECT id FROM water_account
    WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${waterAccountId}::uuid
    FOR UPDATE`;
};

/**
 * A plan's tiers grouped into computeBill's FeeItemInput shape: one entry
 * per fee item carrying code/calcType plus its tiers sorted by tier_no.
 * Fee items are resolved in bulk; a tier referencing a missing fee item is
 * a config bug and surfaces as a DomainError downstream (never silently
 * skipped).
 */
export const loadFeeItems = async (
  tx: Prisma.TransactionClient,
  ctx: TenantCtx,
  tariffPlanId: string,
): Promise<FeeItemInput[]> => {
  const tiers = await tx.tariffTier.findMany({
    where: { tenantId: ctx.tenantId, tariffPlanId },
    orderBy: [{ feeItemId: 'asc' }, { tierNo: 'asc' }],
  });
  if (tiers.length === 0) return [];
  const feeItems = await tx.feeItem.findMany({
    where: {
      tenantId: ctx.tenantId,
      id: { in: [...new Set(tiers.map((t) => t.feeItemId))] },
    },
    select: { id: true, code: true, calcType: true },
  });
  const byId = new Map(feeItems.map((f) => [f.id, f]));
  const grouped = new Map<string, FeeItemInput>();
  for (const t of tiers) {
    const item = byId.get(t.feeItemId);
    if (!item) {
      // Tier rows carry a composite FK to fee_item — a missing row means
      // the data was corrupted behind the API's back. Fail loud.
      throw new BadRequestException({ code: 'FEE_ITEM_NOT_FOUND', feeItemId: t.feeItemId });
    }
    const entry = grouped.get(t.feeItemId) ?? {
      code: item.code,
      calcType: item.calcType,
      tiers: [],
    };
    entry.tiers.push({
      tierNo: t.tierNo,
      fromQty: t.fromQty,
      toQty: t.toQty,
      unitPrice: t.unitPrice,
    });
    grouped.set(t.feeItemId, entry);
  }
  return [...grouped.values()];
};

/**
 * ytdBeforeQty — the annual-tier ladder cursor (spec §2.5 自然年累计分档,
 * MVP definition): Σ consumption_settlement.total_usage_qty for the same
 * water_account over settlements whose linked NORMAL bill is POSTED /
 * PARTIAL_PAID / PAID, restricted to earlier periods of the same calendar
 * year (period >= YYYY01 AND period < current).
 *
 * Only billKind=NORMAL settlement usage counts on the settlement side:
 * REVERSAL and ORIGINAL_BILL-sourced ADJUSTMENT bills are not
 * new consumption, and a REVERSED original drops out (reversed usage
 * leaves the ladder). REPLACEMENT bills carry no settlement link, so
 * their corrected usage is recovered from the bill items themselves —
 * only PER_QTY items carry a qty (FIXED/PERCENT never do), so summing
 * non-null item qty on POSTED-side replacements is exactly the corrected
 * consumption. Without it, a mid-year replace() would silently drop the
 * corrected usage out of every later bill's ladder. RECONCILIATION-sourced
 * adjustments replace effective source-period usage with the latest correction.
 */
export const ytdBeforeQty = async (
  tx: Prisma.TransactionClient,
  ctx: TenantCtx,
  waterAccountId: string,
  period: string,
): Promise<Prisma.Decimal> => {
  const yearStart = `${period.slice(0, 4)}01`;
  const posted = ['POSTED', 'PARTIAL_PAID', 'PAID'] as const;
  const bills = await tx.bill.findMany({
    where: {
      tenantId: ctx.tenantId,
      waterAccountId,
      billKind: 'NORMAL',
      sourceType: 'SETTLEMENT',
      status: { in: [...posted] },
      period: { gte: yearStart, lt: period },
    },
    select: { sourceId: true },
  });
  const settlements = bills.length
    ? await tx.consumptionSettlement.findMany({
        where: { tenantId: ctx.tenantId, id: { in: bills.map((b) => b.sourceId) } },
        select: { period: true, totalUsageQty: true },
      })
    : [];
  const usageByPeriod = new Map(settlements.map((s) => [s.period, s.totalUsageQty]));
  const replacements = await tx.bill.findMany({
    where: {
      tenantId: ctx.tenantId,
      waterAccountId,
      billKind: 'REPLACEMENT',
      status: { in: [...posted] },
      period: { gte: yearStart, lt: period },
    },
    select: { id: true, period: true },
  });
  const items = replacements.length ? await tx.billItem.findMany({
    where: {
      tenantId: ctx.tenantId,
      billId: { in: replacements.map((b) => b.id) },
      qty: { not: null },
    },
    select: { billId: true, qty: true },
  }) : [];
  const replacementPeriods = new Map(replacements.map((b) => [b.id, b.period]));
  for (const item of items) {
    const p = replacementPeriods.get(item.billId)!;
    usageByPeriod.set(p, (usageByPeriod.get(p) ?? new Prisma.Decimal(0)).plus(item.qty ?? 0));
  }

  // Reconciliation items persist a quantity delta relative to the frozen
  // settlement, not relative to a previous adjustment. The LATEST correction
  // for each source period therefore replaces its effective usage; summing
  // successive deltas would reduce the annual cursor twice. Attribute to the
  // source period, never the adjustment bill's issue period (cross-year fix).
  const adjustments = await tx.bill.findMany({
    where: { tenantId: ctx.tenantId, waterAccountId, billKind: 'ADJUSTMENT',
      sourceType: 'RECONCILIATION', status: { in: [...posted] }, period: { lte: period } },
    select: { id: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  if (adjustments.length) {
    const corrections = await tx.billItem.findMany({
      where: { tenantId: ctx.tenantId, billId: { in: adjustments.map((b) => b.id) }, itemType: 'ADJUSTMENT' },
      select: { billId: true, description: true, qty: true },
    });
    const frozen = await tx.consumptionSettlement.findMany({
      where: { tenantId: ctx.tenantId, waterAccountId, period: { gte: yearStart, lt: period } },
      select: { period: true, totalUsageQty: true },
    });
    const frozenByPeriod = new Map(frozen.map((s) => [s.period, s.totalUsageQty]));
    const corrected = new Set<string>();
    for (const bill of adjustments) {
      for (const item of corrections.filter((i) => i.billId === bill.id)) {
        // This is the existing immutable, service-written per-period format
        // from ReconciliationService, including pre-fix adjustment documents.
        const sourcePeriod = /^reconcile (\d{6})$/.exec(item.description ?? '')?.[1];
        if (!sourcePeriod || sourcePeriod < yearStart || sourcePeriod >= period || corrected.has(sourcePeriod)) continue;
        const original = frozenByPeriod.get(sourcePeriod);
        if (original === undefined || item.qty === null || !usageByPeriod.has(sourcePeriod)) continue;
        usageByPeriod.set(sourcePeriod, original.plus(item.qty));
        corrected.add(sourcePeriod);
      }
    }
  }
  return [...usageByPeriod.values()].reduce((sum, qty) => sum.plus(qty), new Prisma.Decimal(0));
};

/**
 * Tenant-param `bill_due_days` (jsonb int, default 15): the due date is
 * the period's last calendar day + the configured offset. A non-integer /
 * missing value falls back to the default rather than billing without a
 * due date.
 */
export const billDueDays = async (
  tx: Prisma.TransactionClient,
  ctx: TenantCtx,
): Promise<number> => {
  const row = await tx.tenantParam.findUnique({
    where: { tenantId_key: { tenantId: ctx.tenantId, key: 'bill_due_days' } },
    select: { value: true },
  });
  const v = row?.value;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 15;
};

/** bill_item row materialization from a computeBill draft. feeItemId is
 * resolved from the code map (the column is nullable for future manual
 * rows, but every engine row here resolves). Values are re-wrapped in
 * Prisma.Decimal so a foreign decimal.js copy can't slip past toJsonSafe
 * at the wire (same rule as settlement.service). */
export const insertBillItems = async (
  tx: Prisma.TransactionClient,
  ctx: TenantCtx,
  billId: string,
  drafts: { feeItemCode: string; qty?: Prisma.Decimal; unitPrice?: Prisma.Decimal; amountCent: bigint; description: string }[],
  feeItemIdByCode: Map<string, string>,
  itemType: 'NORMAL' | 'ADJUSTMENT' = 'NORMAL',
) => {
  if (drafts.length === 0) return;
  await tx.billItem.createMany({
    data: drafts.map((d) => ({
      tenantId: ctx.tenantId,
      billId,
      feeItemId: feeItemIdByCode.get(d.feeItemCode) ?? null,
      itemType,
      description: d.description,
      qty: d.qty === undefined ? null : new Prisma.Decimal(d.qty.toString()),
      unitPrice:
        d.unitPrice === undefined ? null : new Prisma.Decimal(d.unitPrice.toString()),
      amount: d.amountCent,
      createdBy: ctx.staffId,
      updatedBy: ctx.staffId,
    })),
  });
};

/** fee_item code → id map for a plan's fee items (bill_item.fee_item_id). */
export const feeItemIdMap = async (
  tx: Prisma.TransactionClient,
  ctx: TenantCtx,
  codes: string[],
): Promise<Map<string, string>> => {
  if (codes.length === 0) return new Map();
  const rows = await tx.feeItem.findMany({
    where: { tenantId: ctx.tenantId, code: { in: codes } },
    select: { id: true, code: true },
  });
  return new Map(rows.map((r) => [r.code, r.id]));
};

/** computeBill wrapper kept here so the DomainError import surface stays
 * in one module — callers get the engine's typed result verbatim. */
export { computeBill };
export type { FeeItemInput };
