import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { isUniqueViolation } from '../../common/prisma-errors.js';
import type { TenantCtx } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';

export const TARIFF_PLAN_SELECT = {
  id: true,
  tenantId: true,
  code: true,
  name: true,
  usageCategory: true,
  effectiveFrom: true,
  effectiveTo: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.TariffPlanSelect;

export const TARIFF_TIER_SELECT = {
  id: true,
  tenantId: true,
  tariffPlanId: true,
  feeItemId: true,
  tierNo: true,
  fromQty: true,
  toQty: true,
  unitPrice: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.TariffTierSelect;

type TariffStatus = 'DRAFT' | 'ACTIVE' | 'RETIRED';

/** One validated tier row — wire parsing happens in the controller. */
export interface TierInput {
  feeItemId: string;
  tierNo: number;
  fromQty: Prisma.Decimal;
  toQty: Prisma.Decimal | null;
  unitPrice: Prisma.Decimal;
}

export interface TariffPlanCreateBody {
  code: string;
  name: string;
  usageCategory: string;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  tiers: TierInput[];
}

export interface TariffPlanPatchBody {
  name?: string;
  effectiveFrom?: Date;
  /** undefined = untouched; null = clear (open-ended); Date = set. */
  effectiveTo?: Date | null;
  /** undefined = untouched; [] = clear all; [...] = replace all. */
  tiers?: TierInput[];
  /** Immutable wire keys the caller sent (code/usageCategory). */
  immutables: string[];
}

export interface NewVersionBody {
  effectiveFrom: Date;
  /** undefined = copy the source's effective_to. */
  effectiveTo?: Date | null;
  /** undefined = copy the source's name. */
  name?: string;
  /** undefined = copy source tiers verbatim; otherwise validated as create. */
  tiers?: TierInput[];
}

const versionExists = () =>
  new ConflictException({ code: 'TARIFF_PLAN_VERSION_EXISTS' });

const frozen = (reason: string) =>
  new ConflictException({ code: 'TARIFF_FROZEN', reason });

const invalidTransition = (from: string, to: string) =>
  new ConflictException({ code: 'INVALID_TARIFF_STATUS_TRANSITION', from, to });

/**
 * TariffPlan （水价方案） + TariffTier — the versioned price book bills
 * quote (spec §2.5). `code + effective_from` identifies a version of the
 * same logical plan; `usage_category` matches water_account.usage_category
 * at bill time; `status` drives the lifecycle DRAFT → ACTIVE → RETIRED.
 *
 * Version freeze (P0): once any bill row references the plan with
 * bill.status != 'DRAFT', the version's calculation facts are sealed —
 * tier boundaries, unit prices and the effective window can no longer be
 * edited in place (PATCH → 409 TARIFF_FROZEN, including effectiveTo). The
 * repricing path is POST /:id/new-version: copy + new effective_from,
 * leaving bill.tariff_plan_id a truthful pointer at what was priced.
 * Status transitions (activate/retire) are NOT "calculation facts" and
 * stay legal on a bill-referenced version — retiring a published version
 * does not rewrite history.
 *
 * Edit rules while unfrozen:
 *  - DRAFT: name / effectiveFrom / effectiveTo / full tier replace.
 *    code + usageCategory are identity — rejected outright (400).
 *  - ACTIVE: only effectiveTo, and only to shrink/close the window
 *    (must be ≥ effectiveFrom, ≤ the current effectiveTo, never null —
 *    a published window may end early but may not reopen or stretch;
 *    stretching would risk overlapping a successor without the activate
 *    overlap check running). Every other field → 409 TARIFF_FROZEN.
 *  - RETIRED: terminal — all edits → 409 TARIFF_FROZEN.
 *
 * Activation runs an overlap check: another ACTIVE plan of the same
 * usage_category whose [effectiveFrom, effectiveTo) window intersects →
 * 409 TARIFF_WINDOW_OVERLAP, so billing's tariff pick stays deterministic.
 * The check is serialized by a (tenant, usage_category) advisory lock —
 * two concurrent activates would otherwise both pass read-then-write.
 * A tierless plan refuses activation (409 TARIFF_TIERS_EMPTY).
 *
 * Scope note: tariff plans are tenant-level configuration — they carry no
 * org_unit anchor, so writes are gated by `billing:write` alone and there
 * is no orgInScope check (books/installations are org-scoped; tariffs are
 * not, same as fee_item).
 */
@Injectable()
export class TariffPlanService {
  constructor(private readonly prisma: TenantPrismaService) {}

  list(
    ctx: TenantCtx,
    q: { take: number; skip: number; usageCategory?: string; status?: TariffStatus },
  ) {
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.tariffPlan.findMany({
        where: {
          tenantId: ctx.tenantId,
          usageCategory: q.usageCategory,
          status: q.status,
        },
        select: TARIFF_PLAN_SELECT,
        orderBy: [{ code: 'asc' }, { effectiveFrom: 'desc' }, { id: 'asc' }],
        take: q.take,
        skip: q.skip,
      }),
    );
  }

  async getById(ctx: TenantCtx, id: string) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const row = await tx.tariffPlan.findFirst({
        where: { tenantId: ctx.tenantId, id },
        select: TARIFF_PLAN_SELECT,
      });
      if (!row) throw new NotFoundException({ code: 'TARIFF_PLAN_NOT_FOUND' });
      return this.withTiers(tx, ctx, row);
    });
  }

  /**
   * POST /tariff-plans — creates the DRAFT plan + its tiers atomically.
   * (tenant, code, effective_from) is the version key: a duplicate lands a
   * friendly 409, with the unique index still guarding the race.
   */
  async createTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    body: TariffPlanCreateBody,
  ) {
    this.assertWindow(body.effectiveFrom, body.effectiveTo ?? null);
    await this.assertTiersValid(tx, ctx, body.tiers);
    const dup = await tx.tariffPlan.findFirst({
      where: {
        tenantId: ctx.tenantId,
        code: body.code,
        effectiveFrom: body.effectiveFrom,
      },
      select: { id: true },
    });
    if (dup) throw versionExists();

    const plan = await this.insertPlan(tx, ctx, {
      code: body.code,
      name: body.name,
      usageCategory: body.usageCategory,
      effectiveFrom: body.effectiveFrom,
      effectiveTo: body.effectiveTo ?? null,
      tiers: body.tiers,
    });
    return this.withTiers(tx, ctx, plan);
  }

  /**
   * PATCH /tariff-plans/:id — status-gated edit rules (see class docblock):
   * freeze check first (bill-referenced ⇒ nothing edits), then RETIRED,
   * then the ACTIVE effectiveTo-only concession, then full DRAFT edit.
   */
  async updateTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    id: string,
    body: TariffPlanPatchBody,
    req: Request,
  ) {
    const existing = await tx.tariffPlan.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!existing) throw new NotFoundException({ code: 'TARIFF_PLAN_NOT_FOUND' });

    // The P0 freeze: a POSTED-side bill already quoted this version —
    // every in-place edit would falsify the pricing audit trail.
    if (await this.isBillReferenced(tx, ctx, id)) {
      throw frozen('referenced by a non-DRAFT bill');
    }
    if (existing.status === 'RETIRED') {
      throw frozen('plan is RETIRED');
    }

    if (existing.status === 'ACTIVE') {
      // The single concession on a published version: closing the window
      // earlier. Anything else changes what computeBill would have done.
      if (
        body.name !== undefined ||
        body.effectiveFrom !== undefined ||
        body.tiers !== undefined ||
        body.immutables.length > 0
      ) {
        throw frozen('ACTIVE plans only allow effectiveTo edits');
      }
      if (body.effectiveTo === undefined) {
        return this.withTiers(tx, ctx, existing); // no-op PATCH
      }
      const newTo = body.effectiveTo;
      if (
        newTo === null ||
        newTo < existing.effectiveFrom ||
        (existing.effectiveTo !== null && newTo > existing.effectiveTo)
      ) {
        throw new BadRequestException({
          code: 'TARIFF_WINDOW_INVALID',
          effectiveFrom: existing.effectiveFrom,
          effectiveTo: newTo,
        });
      }
      req.auditBefore = existing;
      const updated = await tx.tariffPlan.update({
        where: { tenantId_id: { tenantId: ctx.tenantId, id } },
        data: { effectiveTo: newTo, updatedBy: ctx.staffId },
        select: TARIFF_PLAN_SELECT,
      });
      return this.withTiers(tx, ctx, updated);
    }

    // DRAFT — full edit. code/usageCategory are identity, never rewritten.
    if (body.immutables.length > 0) {
      throw new BadRequestException({
        code: 'TARIFF_IMMUTABLE_FIELD',
        fields: body.immutables,
      });
    }
    const mergedFrom = body.effectiveFrom ?? existing.effectiveFrom;
    const mergedTo =
      body.effectiveTo === undefined ? existing.effectiveTo : body.effectiveTo;
    this.assertWindow(mergedFrom, mergedTo);
    if (body.tiers !== undefined) {
      await this.assertTiersValid(tx, ctx, body.tiers);
    }

    req.auditBefore = await this.withTiers(tx, ctx, existing);
    try {
      const updated = await tx.tariffPlan.update({
        where: { tenantId_id: { tenantId: ctx.tenantId, id } },
        data: {
          name: body.name,
          effectiveFrom: body.effectiveFrom,
          effectiveTo: body.effectiveTo === undefined ? undefined : body.effectiveTo,
          updatedBy: ctx.staffId,
        },
        select: TARIFF_PLAN_SELECT,
      });
      if (body.tiers !== undefined) {
        await tx.tariffTier.deleteMany({
          where: { tenantId: ctx.tenantId, tariffPlanId: id },
        });
        await this.insertTiers(tx, ctx, id, body.tiers);
      }
      return this.withTiers(tx, ctx, updated);
    } catch (err) {
      // Moving effectiveFrom can collide with a sibling version of the
      // same code — same conflict as on create.
      if (isUniqueViolation(err)) throw versionExists();
      throw err;
    }
  }

  /**
   * POST /tariff-plans/:id/activate — DRAFT → ACTIVE guarded transition.
   * Refuses a tierless plan and any overlapping ACTIVE window of the same
   * usage_category (deterministic tariff pick for billing runs).
   */
  async activateTx(tx: Prisma.TransactionClient, ctx: TenantCtx, id: string, req: Request) {
    const existing = await tx.tariffPlan.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!existing) throw new NotFoundException({ code: 'TARIFF_PLAN_NOT_FOUND' });
    if (existing.status !== 'DRAFT') {
      throw invalidTransition(existing.status, 'ACTIVE');
    }

    const tierCount = await tx.tariffTier.count({
      where: { tenantId: ctx.tenantId, tariffPlanId: id },
    });
    if (tierCount === 0) {
      throw new ConflictException({ code: 'TARIFF_TIERS_EMPTY' });
    }

    // Serialize activates per (tenant, usage_category): the overlap check
    // is read-then-write, so under READ COMMITTED the lock waiter re-reads
    // after the winner commits and correctly 409s instead of double-active.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ctx.tenantId + ':' + existing.usageCategory})::bigint)`;

    // [from, to) intersection: other.from < this.to AND
    // (other.to is open OR other.to > this.from). NULL to = open-ended.
    const clash = await tx.tariffPlan.findFirst({
      where: {
        tenantId: ctx.tenantId,
        usageCategory: existing.usageCategory,
        status: 'ACTIVE',
        id: { not: id },
        ...(existing.effectiveTo !== null
          ? { effectiveFrom: { lt: existing.effectiveTo } }
          : {}),
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: existing.effectiveFrom } }],
      },
      select: { id: true, code: true, effectiveFrom: true, effectiveTo: true },
    });
    if (clash) {
      throw new ConflictException({
        code: 'TARIFF_WINDOW_OVERLAP',
        withPlanId: clash.id,
        withCode: clash.code,
      });
    }

    req.auditBefore = existing;
    const flipped = await tx.tariffPlan.updateMany({
      where: { tenantId: ctx.tenantId, id, status: 'DRAFT' },
      data: { status: 'ACTIVE', updatedBy: ctx.staffId },
    });
    if (flipped.count === 0) throw invalidTransition(existing.status, 'ACTIVE');
    const row = await tx.tariffPlan.findFirst({
      where: { tenantId: ctx.tenantId, id },
      select: TARIFF_PLAN_SELECT,
    });
    return this.withTiers(tx, ctx, row!);
  }

  /** POST /tariff-plans/:id/retire — ACTIVE → RETIRED guarded transition. */
  async retireTx(tx: Prisma.TransactionClient, ctx: TenantCtx, id: string, req: Request) {
    const existing = await tx.tariffPlan.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!existing) throw new NotFoundException({ code: 'TARIFF_PLAN_NOT_FOUND' });
    if (existing.status !== 'ACTIVE') {
      throw invalidTransition(existing.status, 'RETIRED');
    }
    req.auditBefore = existing;
    const flipped = await tx.tariffPlan.updateMany({
      where: { tenantId: ctx.tenantId, id, status: 'ACTIVE' },
      data: { status: 'RETIRED', updatedBy: ctx.staffId },
    });
    if (flipped.count === 0) throw invalidTransition(existing.status, 'RETIRED');
    const row = await tx.tariffPlan.findFirst({
      where: { tenantId: ctx.tenantId, id },
      select: TARIFF_PLAN_SELECT,
    });
    return this.withTiers(tx, ctx, row!);
  }

  /**
   * POST /tariff-plans/:id/new-version — THE repricing path: copies the
   * plan into a new DRAFT row (same code, new effective_from). Legal from
   * any source status — a RETIRED or bill-frozen version still spawns its
   * successor; the copy is what gets edited, never the sealed original.
   * tiers copied verbatim unless the body supplies a replacement set
   * (validated exactly like create).
   */
  async newVersionTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    id: string,
    body: NewVersionBody,
  ) {
    const src = await tx.tariffPlan.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!src) throw new NotFoundException({ code: 'TARIFF_PLAN_NOT_FOUND' });

    const effectiveTo = body.effectiveTo === undefined ? src.effectiveTo : body.effectiveTo;
    this.assertWindow(body.effectiveFrom, effectiveTo);

    let tiers: TierInput[];
    if (body.tiers !== undefined) {
      await this.assertTiersValid(tx, ctx, body.tiers);
      tiers = body.tiers;
    } else {
      const srcTiers = await tx.tariffTier.findMany({
        where: { tenantId: ctx.tenantId, tariffPlanId: id },
        orderBy: [{ feeItemId: 'asc' }, { tierNo: 'asc' }],
      });
      tiers = srcTiers.map((t) => ({
        feeItemId: t.feeItemId,
        tierNo: t.tierNo,
        fromQty: t.fromQty,
        toQty: t.toQty,
        unitPrice: t.unitPrice,
      }));
    }

    const dup = await tx.tariffPlan.findFirst({
      where: {
        tenantId: ctx.tenantId,
        code: src.code,
        effectiveFrom: body.effectiveFrom,
      },
      select: { id: true },
    });
    if (dup) throw versionExists();

    const plan = await this.insertPlan(tx, ctx, {
      code: src.code,
      name: body.name ?? src.name,
      usageCategory: src.usageCategory,
      effectiveFrom: body.effectiveFrom,
      effectiveTo,
      tiers,
    });
    return this.withTiers(tx, ctx, plan);
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /** A plan row hydrated with its tiers, grouped (feeItemId, tierNo). */
  private async withTiers<T extends { id: string }>(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    plan: T,
  ) {
    const tiers = await tx.tariffTier.findMany({
      where: { tenantId: ctx.tenantId, tariffPlanId: plan.id },
      select: TARIFF_TIER_SELECT,
      orderBy: [{ feeItemId: 'asc' }, { tierNo: 'asc' }],
    });
    return { ...plan, tiers };
  }

  /**
   * The P0 freeze probe: TRUE once any bill references the plan with a
   * status other than DRAFT — DRAFT bills are still scratch, anything past
   * them has priced real money against this version.
   */
  private async isBillReferenced(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    planId: string,
  ) {
    const bill = await tx.bill.findFirst({
      where: {
        tenantId: ctx.tenantId,
        tariffPlanId: planId,
        status: { not: 'DRAFT' },
      },
      select: { id: true },
    });
    return bill !== null;
  }

  /** effective_to, when present, must not precede effective_from. */
  private assertWindow(effectiveFrom: Date, effectiveTo: Date | null) {
    if (effectiveTo !== null && effectiveTo < effectiveFrom) {
      throw new BadRequestException({
        code: 'TARIFF_WINDOW_INVALID',
        effectiveFrom,
        effectiveTo,
      });
    }
  }

  /**
   * Tier-set structural validation, per fee item (spec §2.5 ladder):
   * sorted by tier_no, the first tier starts at 0, each boundary is shared
   * (tier[i].to_qty === tier[i+1].from_qty), the last tier is open-ended
   * (to_qty NULL = ∞), from < to everywhere, unit_price ≥ 0 (enforced at
   * the wire by assertDecimal). Every referenced fee item must exist in
   * the tenant. An empty set is legal on a DRAFT — activation refuses it.
   */
  private async assertTiersValid(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    tiers: TierInput[],
  ) {
    if (tiers.length === 0) return;

    const feeItemIds = [...new Set(tiers.map((t) => t.feeItemId))];
    const found = await tx.feeItem.findMany({
      where: { tenantId: ctx.tenantId, id: { in: feeItemIds } },
      select: { id: true },
    });
    const foundIds = new Set(found.map((f) => f.id));
    for (const feeItemId of feeItemIds) {
      if (!foundIds.has(feeItemId)) {
        throw new BadRequestException({ code: 'FEE_ITEM_NOT_FOUND', feeItemId });
      }
    }

    const byItem = new Map<string, TierInput[]>();
    for (const t of tiers) {
      const list = byItem.get(t.feeItemId) ?? [];
      list.push(t);
      byItem.set(t.feeItemId, list);
    }

    for (const [feeItemId, group] of byItem) {
      const seenNo = new Set<number>();
      for (const t of group) {
        if (seenNo.has(t.tierNo)) {
          throw new BadRequestException({
            code: 'TIER_DUPLICATE_NO',
            feeItemId,
            tierNo: t.tierNo,
          });
        }
        seenNo.add(t.tierNo);
      }

      const sorted = [...group].sort((a, b) => a.tierNo - b.tierNo);
      if (!sorted[0].fromQty.isZero()) {
        throw new BadRequestException({
          code: 'TIER_FROM_NOT_ZERO',
          feeItemId,
          tierNo: sorted[0].tierNo,
        });
      }
      for (let i = 0; i < sorted.length; i++) {
        const t = sorted[i];
        const isLast = i === sorted.length - 1;
        if (isLast) {
          if (t.toQty !== null) {
            throw new BadRequestException({
              code: 'TIER_OPEN_ENDED_REQUIRED',
              feeItemId,
              tierNo: t.tierNo,
            });
          }
        } else {
          if (t.toQty === null || !t.toQty.gt(t.fromQty)) {
            throw new BadRequestException({
              code: 'TIER_RANGE_INVALID',
              feeItemId,
              tierNo: t.tierNo,
            });
          }
          const next = sorted[i + 1];
          if (!t.toQty.equals(next.fromQty)) {
            throw new BadRequestException({
              code: 'TIER_NOT_CONTIGUOUS',
              feeItemId,
              tierNo: t.tierNo,
              nextTierNo: next.tierNo,
            });
          }
        }
      }
    }
  }

  /** INSERT the plan row + tier rows; the (code,from) unique → 409. */
  private async insertPlan(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    data: {
      code: string;
      name: string;
      usageCategory: string;
      effectiveFrom: Date;
      effectiveTo: Date | null;
      tiers: TierInput[];
    },
  ) {
    try {
      const plan = await tx.tariffPlan.create({
        data: {
          tenantId: ctx.tenantId,
          code: data.code,
          name: data.name,
          usageCategory: data.usageCategory,
          effectiveFrom: data.effectiveFrom,
          effectiveTo: data.effectiveTo,
          status: 'DRAFT',
          createdBy: ctx.staffId,
          updatedBy: ctx.staffId,
        },
        select: TARIFF_PLAN_SELECT,
      });
      await this.insertTiers(tx, ctx, plan.id, data.tiers);
      return plan;
    } catch (err) {
      if (isUniqueViolation(err)) throw versionExists();
      throw err;
    }
  }

  private async insertTiers(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    planId: string,
    tiers: TierInput[],
  ) {
    if (tiers.length === 0) return;
    await tx.tariffTier.createMany({
      data: tiers.map((t) => ({
        tenantId: ctx.tenantId,
        tariffPlanId: planId,
        feeItemId: t.feeItemId,
        tierNo: t.tierNo,
        fromQty: t.fromQty,
        toQty: t.toQty,
        unitPrice: t.unitPrice,
        createdBy: ctx.staffId,
        updatedBy: ctx.staffId,
      })),
    });
  }
}
