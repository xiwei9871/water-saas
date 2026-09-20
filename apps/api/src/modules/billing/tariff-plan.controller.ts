import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Prisma } from '@prisma/client';
import { assertDecimal, assertOptionalDate } from '../../common/decimal.js';
import { IdempotencyService } from '../../common/idempotency.service.js';
import { withOptionalIdem } from '../../common/idempotent.js';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { assertUsageCategory } from '../../common/usage-categories.js';
import { assertUuid } from '../../common/uuid.js';
import {
  TariffPlanService,
  type NewVersionBody,
  type TariffPlanCreateBody,
  type TariffPlanPatchBody,
  type TierInput,
} from './tariff-plan.service.js';

const TARIFF_STATUSES = new Set(['DRAFT', 'ACTIVE', 'RETIRED']);
/** Wire keys that are plan identity — immutable on every PATCH. */
const IMMUTABLE_KEYS = ['code', 'usageCategory'] as const;

/** ?take default 50, hard-capped at 200; ?skip default 0. */
const pageArgs = (take?: string, skip?: string) => ({
  take: Math.min(Math.max(parseInt(take ?? '50', 10) || 50, 1), 200),
  skip: Math.max(parseInt(skip ?? '0', 10) || 0, 0),
});

/**
 * Effective windows are day-granular (DATE columns): any parseable date
 * input is normalized to its UTC calendar day so a trailing time component
 * can't smuggle in a sub-day boundary. Required-field callers pass
 * `required: true`.
 */
const asDay = (v: unknown, field: string): Date => {
  const d = assertOptionalDate(v, field);
  if (d === undefined) {
    throw new BadRequestException({ code: 'TARIFF_FIELDS_REQUIRED', field });
  }
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

const asOptionalDay = (v: unknown, field: string): Date | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return asDay(v, field);
};

interface TierWireBody {
  feeItemId?: string;
  tierNo?: number;
  fromQty?: unknown;
  toQty?: unknown;
  unitPrice?: unknown;
}

interface TariffPlanWireBody {
  code?: string;
  name?: string;
  usageCategory?: string;
  effectiveFrom?: unknown;
  effectiveTo?: unknown;
  tiers?: TierWireBody[];
  baseHousehold?: unknown;
  perPersonQty?: unknown;
}

interface NewVersionWireBody {
  effectiveFrom?: unknown;
  effectiveTo?: unknown;
  name?: string;
  tiers?: TierWireBody[];
  baseHousehold?: unknown;
  perPersonQty?: unknown;
}

/** undefined → undefined; null → null; else positive-int or 400. */
const asOptionalInt = (
  v: unknown,
  field: string,
): number | null | undefined => {
  if (v === undefined || v === null) return v as undefined | null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) {
    throw new BadRequestException({ code: 'TARIFF_HOUSEHOLD_SCALE_INVALID', field });
  }
  return n;
};

const asOptionalDecimal = (
  v: unknown,
  field: string,
): Prisma.Decimal | null | undefined => {
  if (v === undefined || v === null) return v as undefined | null;
  return assertDecimal(v, field, { min: 0 });
};

/** Wire → TierInput; structural ladder rules live in the service. */
const parseTier = (raw: TierWireBody, i: number): TierInput => {
  if (!raw?.feeItemId || raw.tierNo === undefined || raw.fromQty === undefined ||
      raw.fromQty === null || raw.unitPrice === undefined || raw.unitPrice === null) {
    throw new BadRequestException({ code: 'TIER_FIELDS_REQUIRED', index: i });
  }
  if (!Number.isInteger(raw.tierNo) || (raw.tierNo as number) < 1) {
    throw new BadRequestException({ code: 'TIER_NO_INVALID', index: i });
  }
  return {
    feeItemId: assertUuid(raw.feeItemId, `tiers[${i}].feeItemId`),
    tierNo: raw.tierNo,
    fromQty: assertDecimal(raw.fromQty, `tiers[${i}].fromQty`, { min: 0 }),
    toQty:
      raw.toQty === undefined || raw.toQty === null
        ? null
        : assertDecimal(raw.toQty, `tiers[${i}].toQty`, { min: 0 }),
    unitPrice: assertDecimal(raw.unitPrice, `tiers[${i}].unitPrice`, { min: 0 }),
  };
};

const parseTiers = (raw: TierWireBody[] | undefined): TierInput[] | undefined => {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new BadRequestException({ code: 'TIERS_INVALID' });
  }
  return raw.map((t, i) => parseTier(t, i));
};

/**
 * /tariff-plans — versioned price books (spec §2.5). DRAFT → ACTIVE →
 * RETIRED; edits on a published/bill-referenced version are refused so
 * bill.tariff_plan_id always points at the truth — repricing is
 * /:id/new-version, never an in-place rewrite.
 */
@Controller('tariff-plans')
export class TariffPlanController {
  constructor(
    private readonly svc: TariffPlanService,
    private readonly prisma: TenantPrismaService,
    private readonly idem: IdempotencyService,
  ) {}

  /** GET /tariff-plans — ?usageCategory= / ?status= / paging. */
  @Get()
  @Permissions('billing:read')
  list(
    @Query('usageCategory') usageCategory?: string,
    @Query('status') status?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    if (status !== undefined && !TARIFF_STATUSES.has(status)) {
      throw new BadRequestException({ code: 'TARIFF_STATUS_INVALID' });
    }
    if (usageCategory !== undefined) assertUsageCategory(usageCategory);
    return this.svc.list(currentTenant(), {
      ...pageArgs(take, skip),
      usageCategory,
      status: status as 'DRAFT' | 'ACTIVE' | 'RETIRED' | undefined,
    });
  }

  /** GET /tariff-plans/:id — plan + tiers inline. */
  @Get(':id')
  @Permissions('billing:read')
  get(@Param('id') id: string) {
    return this.svc.getById(currentTenant(), assertUuid(id, 'id'));
  }

  /**
   * POST /tariff-plans — {code, name, usageCategory, effectiveFrom,
   * effectiveTo?, tiers[]}: creates the DRAFT + tiers atomically. Each fee
   * item's tiers must form one ladder: sorted by tierNo, first fromQty=0,
   * contiguous boundaries, last toQty null, from<to, unitPrice≥0.
   */
  @Post()
  @Permissions('billing:write')
  create(
    @Body() body: TariffPlanWireBody,
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    // Same strictness as PATCH: reject non-strings and blank/whitespace
    // values at the wire instead of storing them.
    for (const f of ['code', 'name', 'usageCategory'] as const) {
      if (typeof body?.[f] !== 'string' || !body[f].trim()) {
        throw new BadRequestException({ code: 'TARIFF_FIELDS_REQUIRED', field: f });
      }
    }
    if (body.effectiveFrom === undefined) {
      throw new BadRequestException({ code: 'TARIFF_FIELDS_REQUIRED' });
    }
    const parsed: TariffPlanCreateBody = {
      code: body.code!.trim(),
      name: body.name!.trim(),
      usageCategory: body.usageCategory!.trim(),
      effectiveFrom: asDay(body.effectiveFrom, 'effectiveFrom'),
      effectiveTo: asOptionalDay(body.effectiveTo, 'effectiveTo'),
      tiers: parseTiers(body.tiers) ?? [],
      baseHousehold: asOptionalInt(body.baseHousehold, 'baseHousehold'),
      perPersonQty: asOptionalDecimal(body.perPersonQty, 'perPersonQty'),
    };
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body, responseStatus: 201 },
      (tx) => this.svc.createTx(tx, ctx, parsed),
    );
  }

  /**
   * PATCH /tariff-plans/:id — DRAFT: name/effectiveFrom/effectiveTo/tier
   * replace. ACTIVE: effectiveTo only (shrink/close). RETIRED or
   * bill-referenced: 409 TARIFF_FROZEN.
   */
  @Patch(':id')
  @Permissions('billing:write')
  update(
    @Param('id') id: string,
    @Body()
    body: {
      name?: string;
      effectiveFrom?: unknown;
      effectiveTo?: unknown;
      tiers?: TierWireBody[];
      code?: string;
      usageCategory?: string;
      baseHousehold?: unknown;
      perPersonQty?: unknown;
    },
    @Req() req: Request,
  ) {
    assertUuid(id, 'id');
    if (body?.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) {
      throw new BadRequestException({ code: 'TARIFF_NAME_INVALID' });
    }
    // An unknown category is malformed input (422) — checked before the
    // immutability verdict so garbage never masquerades as a legal edit.
    if (body?.usageCategory !== undefined) assertUsageCategory(body.usageCategory);
    const parsed: TariffPlanPatchBody = {
      name: body?.name?.trim(),
      effectiveFrom:
        body?.effectiveFrom === undefined
          ? undefined
          : asDay(body.effectiveFrom, 'effectiveFrom'),
      effectiveTo: asOptionalDay(body?.effectiveTo, 'effectiveTo'),
      tiers: parseTiers(body?.tiers),
      immutables: IMMUTABLE_KEYS.filter((k) => body?.[k] !== undefined),
      baseHousehold: asOptionalInt(body?.baseHousehold, 'baseHousehold'),
      perPersonQty: asOptionalDecimal(body?.perPersonQty, 'perPersonQty'),
    };
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.updateTx(tx, ctx, id, parsed, req),
    );
  }

  /**
   * POST /tariff-plans/:id/activate — DRAFT → ACTIVE guarded transition;
   * 409 on overlap with another ACTIVE window of the same usage_category
   * or on a tierless plan.
   */
  @Post(':id/activate')
  @Permissions('billing:write')
  activate(
    @Param('id') id: string,
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    assertUuid(id, 'id');
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body: {}, responseStatus: 201 },
      (tx) => this.svc.activateTx(tx, ctx, id, req),
    );
  }

  /** POST /tariff-plans/:id/retire — ACTIVE → RETIRED guarded transition. */
  @Post(':id/retire')
  @Permissions('billing:write')
  retire(
    @Param('id') id: string,
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    assertUuid(id, 'id');
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body: {}, responseStatus: 201 },
      (tx) => this.svc.retireTx(tx, ctx, id, req),
    );
  }

  /**
   * POST /tariff-plans/:id/new-version — {effectiveFrom, effectiveTo?,
   * name?, tiers?}: copies the plan into a new DRAFT row (same code).
   * tiers copied verbatim unless supplied; name/effectiveTo default to
   * the source's. This is THE repricing path — the source row is never
   * touched, so bill-referenced versions stay auditable forever.
   */
  @Post(':id/new-version')
  @Permissions('billing:write')
  newVersion(
    @Param('id') id: string,
    @Body() body: NewVersionWireBody,
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    assertUuid(id, 'id');
    if (body?.effectiveFrom === undefined || body?.effectiveFrom === null) {
      throw new BadRequestException({ code: 'TARIFF_FIELDS_REQUIRED', field: 'effectiveFrom' });
    }
    if (body?.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) {
      throw new BadRequestException({ code: 'TARIFF_NAME_INVALID' });
    }
    const parsed: NewVersionBody = {
      effectiveFrom: asDay(body.effectiveFrom, 'effectiveFrom'),
      effectiveTo: asOptionalDay(body.effectiveTo, 'effectiveTo'),
      name: body.name?.trim(),
      tiers: parseTiers(body.tiers),
      baseHousehold: asOptionalInt(body.baseHousehold, 'baseHousehold'),
      perPersonQty: asOptionalDecimal(body.perPersonQty, 'perPersonQty'),
    };
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body, responseStatus: 201 },
      (tx) => this.svc.newVersionTx(tx, ctx, id, parsed),
    );
  }
}
