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

export const FEE_ITEM_SELECT = {
  id: true,
  tenantId: true,
  code: true,
  name: true,
  calcType: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.FeeItemSelect;

type CalcType = 'PER_QTY' | 'FIXED' | 'PERCENT';

export interface FeeItemBody {
  code?: string;
  name?: string;
  calcType?: string;
}

export interface FeeItemPatchBody {
  name?: string;
}

/**
 * FeeItem （费用项） — a priced line kind (水费/污水费/违约金…) with a
 * calc_type the billing engine interprets (spec §2.5). `code` is the
 * tenant-unique business key; `code`/`calcType` are immutable once created
 * because tariff tiers and bill_item snapshots reference the item by
 * meaning, not just by id.
 *
 * Fee items are tenant-level configuration: they carry no org_unit anchor,
 * so writes are gated by the `billing:write` permission alone — there is
 * no org subtree to scope against (unlike books/installations).
 */
@Injectable()
export class FeeItemService {
  constructor(private readonly prisma: TenantPrismaService) {}

  list(
    ctx: TenantCtx,
    q: { take: number; skip: number; code?: string; calcType?: CalcType },
  ) {
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.feeItem.findMany({
        where: {
          tenantId: ctx.tenantId,
          code: q.code,
          calcType: q.calcType,
        },
        select: FEE_ITEM_SELECT,
        orderBy: [{ code: 'asc' }, { id: 'asc' }],
        take: q.take,
        skip: q.skip,
      }),
    );
  }

  async getById(ctx: TenantCtx, id: string) {
    const row = await this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.feeItem.findFirst({
        where: { tenantId: ctx.tenantId, id },
        select: FEE_ITEM_SELECT,
      }),
    );
    if (!row) throw new NotFoundException({ code: 'FEE_ITEM_NOT_FOUND' });
    return row;
  }

  /**
   * POST /fee-items — (tenant_id, code) is the business key; a duplicate
   * lands a friendly 409 (the unique index remains the real guard for the
   * concurrent race, same pattern as settlement generation).
   */
  async createTx(tx: Prisma.TransactionClient, ctx: TenantCtx, body: FeeItemBody) {
    if (!body.code || !body.name || !body.calcType) {
      throw new BadRequestException({ code: 'FEE_ITEM_FIELDS_REQUIRED' });
    }
    const dup = await tx.feeItem.findFirst({
      where: { tenantId: ctx.tenantId, code: body.code },
      select: { id: true },
    });
    if (dup) {
      throw new ConflictException({ code: 'FEE_ITEM_CODE_TAKEN', feeItemId: dup.id });
    }
    try {
      return await tx.feeItem.create({
        data: {
          tenantId: ctx.tenantId,
          code: body.code,
          name: body.name,
          calcType: body.calcType as CalcType,
          createdBy: ctx.staffId,
          updatedBy: ctx.staffId,
        },
        select: FEE_ITEM_SELECT,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException({ code: 'FEE_ITEM_CODE_TAKEN' });
      }
      throw err;
    }
  }

  /** PATCH /fee-items/:id — name only; code/calcType immutable. */
  async updateTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    id: string,
    body: FeeItemPatchBody,
    req: Request,
  ) {
    const existing = await tx.feeItem.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!existing) throw new NotFoundException({ code: 'FEE_ITEM_NOT_FOUND' });
    req.auditBefore = existing;
    // fee_item has no (tenant_id,id) unique — the tenant-scoped findFirst
    // above is the ownership check (RLS would hide a cross-tenant row
    // anyway); the update itself keys on the PK like reading-book does.
    return tx.feeItem.update({
      where: { id },
      data: { name: body.name, updatedBy: ctx.staffId },
      select: FEE_ITEM_SELECT,
    });
  }
}
