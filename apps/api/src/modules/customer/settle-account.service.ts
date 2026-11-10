import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { conflictOnUnique } from '../../common/prisma-errors.js';
import type { TenantCtx } from '../../common/tenant-context.js';
import {
  assertSettleScopeTx,
  outOfScopeSettleAccountIds,
} from '../../common/account-scope.js';
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
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      // E6 strict rule, extended to reads by E8: ANY linked account
      // out-of-scope hides the whole settle account.
      const hidden =
        ctx.scope === 'ALL' ? [] : await outOfScopeSettleAccountIds(tx, ctx);
      const rows = await tx.settleAccount.findMany({
        where: {
          tenantId: ctx.tenantId,
          name: q.name ? { contains: q.name } : undefined,
          status: q.status,
          ...(hidden.length ? { id: { notIn: hidden } } : {}),
        },
        select: {
          ...SETTLE_ACCOUNT_SELECT,
          _count: { select: { waterAccounts: true } },
        },
        orderBy: { settleNo: 'asc' },
        take: q.take,
        skip: q.skip,
      });
      // M4：三口径余额——prepayBalance=预存 lot 剩余合计；
      // arrearsBalance=未清账单（total-已分摊）合计；balance=预存-欠费净额。
      const ids = rows.map((r) => r.id);
      const prepayRows = ids.length
        ? await tx.$queryRaw<{ settle_account_id: string; bal: bigint | null }[]>`
            SELECT e.settle_account_id, SUM(e.amount + COALESCE(c.used,0))::bigint AS bal
            FROM prepayment_ledger_entry e
            LEFT JOIN LATERAL (
              SELECT SUM(c2.amount) AS used FROM prepayment_ledger_entry c2
              WHERE c2.tenant_id = e.tenant_id AND c2.origin_top_up_id = e.id
            ) c ON true
            WHERE e.tenant_id = ${ctx.tenantId}::uuid
              AND e.settle_account_id = ANY(${ids}::uuid[])
              AND e.type = 'TOP_UP' AND e.reversal_of_entry_id IS NULL
            GROUP BY e.settle_account_id`
        : [];
      const arrearsRows = ids.length
        ? await tx.$queryRaw<{ settle_account_id: string; bal: bigint | null }[]>`
            SELECT b.settle_account_id,
                   SUM(b.total_amount - COALESCE(a.paid,0))::bigint AS bal
            FROM bill b
            LEFT JOIN LATERAL (
              SELECT SUM(amount) AS paid FROM payment_alloc pa
              WHERE pa.tenant_id = b.tenant_id AND pa.bill_id = b.id
            ) a ON true
            WHERE b.tenant_id = ${ctx.tenantId}::uuid
              AND b.settle_account_id = ANY(${ids}::uuid[])
              AND b.status IN ('POSTED','PARTIAL_PAID')
            GROUP BY b.settle_account_id`
        : [];
      const prepay = new Map(prepayRows.map((r) => [r.settle_account_id, r.bal ?? 0n]));
      const arrears = new Map(arrearsRows.map((r) => [r.settle_account_id, r.bal ?? 0n]));
      return rows.map((r) => {
        const pb = prepay.get(r.id) ?? 0n;
        const ab = arrears.get(r.id) ?? 0n;
        return {
          ...r,
          waterAccountCount: (r as { _count?: { waterAccounts: number } })._count?.waterAccounts ?? 0,
          prepayBalance: pb.toString(),
          arrearsBalance: ab.toString(),
          balance: (pb - ab).toString(),
        };
      });
    });
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
    // E6 strict rule on reads — a hidden settle account 403s, not 404s,
    // so the caller can't distinguish "exists out-of-scope" probing.
    await this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      assertSettleScopeTx(tx, ctx, id),
    );
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
    await assertSettleScopeTx(tx, ctx, id);
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
