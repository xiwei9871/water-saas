import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { conflictOnUnique } from '../../common/prisma-errors.js';
import type { TenantCtx } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { SequenceService } from '../../common/sequence.service.js';

export const SETTLE_ACCOUNT_SELECT = {
  id: true,
  tenantId: true,
  settleNo: true,
  name: true,
  phone: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SettleAccountSelect;

export interface SettleAccountBody {
  /** Explicit settle_no; absent → sys_sequence allocates (prefix 'S'). */
  settleNo?: string;
  name?: string;
  phone?: string;
}

export interface SettleAccountPatchBody {
  name?: string;
  phone?: string | null;
  status?: 'NORMAL' | 'SUSPENDED';
}

/**
 * SettleAccount （结算户） — the billing/payment counterparty a water account
 * settles through (spec §2.1: water_account >── settle_account).
 */
@Injectable()
export class SettleAccountService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly seq: SequenceService,
  ) {}

  list(
    ctx: TenantCtx,
    q: { take: number; skip: number; name?: string; status?: 'NORMAL' | 'SUSPENDED' | 'CLOSED' },
  ) {
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.settleAccount.findMany({
        where: {
          tenantId: ctx.tenantId,
          name: q.name ? { contains: q.name } : undefined,
          status: q.status,
        },
        select: SETTLE_ACCOUNT_SELECT,
        orderBy: { settleNo: 'asc' },
        take: q.take,
        skip: q.skip,
      }),
    );
  }

  async getById(ctx: TenantCtx, id: string) {
    const row = await this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.settleAccount.findFirst({
        where: { tenantId: ctx.tenantId, id },
        select: {
          ...SETTLE_ACCOUNT_SELECT,
          waterAccounts: {
            select: { id: true, accountNo: true, status: true, usageCategory: true },
          },
        },
      }),
    );
    if (!row) throw new NotFoundException({ code: 'SETTLE_ACCOUNT_NOT_FOUND' });
    return row;
  }

  async createTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    body: SettleAccountBody,
  ) {
    const settleNo =
      body.settleNo?.trim() ||
      (await this.seq.nextFormatted(tx, ctx.tenantId, 'settle_no', 'S', ctx.staffId));
    return conflictOnUnique(
      tx.settleAccount.create({
        data: {
          tenantId: ctx.tenantId,
          settleNo,
          name: body.name!,
          phone: body.phone,
          status: 'NORMAL',
          createdBy: ctx.staffId,
          updatedBy: ctx.staffId,
        },
        select: SETTLE_ACCOUNT_SELECT,
      }),
    );
  }

  async updateTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    id: string,
    body: SettleAccountPatchBody,
    req: Request,
  ) {
    const existing = await tx.settleAccount.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!existing) throw new NotFoundException({ code: 'SETTLE_ACCOUNT_NOT_FOUND' });
    // A CLOSED settle account stays closed — reopening goes through a future
    // business flow, not a profile PATCH that could resurrect it silently.
    if (existing.status === 'CLOSED') {
      throw new ConflictException({ code: 'SETTLE_ACCOUNT_CLOSED' });
    }
    req.auditBefore = existing;
    return tx.settleAccount.update({
      where: { tenantId_id: { tenantId: ctx.tenantId, id } },
      data: {
        name: body.name,
        phone: body.phone,
        status: body.status,
        updatedBy: ctx.staffId,
      },
      select: SETTLE_ACCOUNT_SELECT,
    });
  }
}
