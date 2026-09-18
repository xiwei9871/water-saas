import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { conflictOnUnique } from '../../common/prisma-errors.js';
import type { TenantCtx } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { SequenceService } from './sequence.service.js';

export const CUSTOMER_SELECT = {
  id: true,
  tenantId: true,
  customerNo: true,
  name: true,
  custType: true,
  idType: true,
  idNo: true,
  phone: true,
  addr: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CustomerSelect;

export interface CustomerBody {
  /** Explicit customer_no (data migration); absent → sys_sequence allocates. */
  customerNo?: string;
  name?: string;
  custType?: 'PERSONAL' | 'ORG';
  idType?: string;
  idNo?: string;
  phone?: string;
  addr?: string;
}

export interface CustomerPatchBody {
  name?: string;
  custType?: 'PERSONAL' | 'ORG';
  idType?: string | null;
  idNo?: string | null;
  phone?: string | null;
  addr?: string | null;
}

export interface ListQuery {
  take: number;
  skip: number;
  name?: string;
  customerNo?: string;
}

/**
 * Customer （客户） — the natural person/org behind water accounts. Carries no
 * org_unit_id (schema has none), so tenant isolation is the only boundary.
 */
@Injectable()
export class CustomerService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly seq: SequenceService,
  ) {}

  list(ctx: TenantCtx, q: ListQuery) {
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.customer.findMany({
        where: {
          tenantId: ctx.tenantId,
          name: q.name ? { contains: q.name } : undefined,
          customerNo: q.customerNo,
        },
        select: CUSTOMER_SELECT,
        orderBy: { customerNo: 'asc' },
        take: q.take,
        skip: q.skip,
      }),
    );
  }

  async getById(ctx: TenantCtx, id: string) {
    const row = await this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.customer.findFirst({
        where: { tenantId: ctx.tenantId, id },
        select: {
          ...CUSTOMER_SELECT,
          waterAccounts: {
            select: { id: true, accountNo: true, status: true, usageCategory: true },
          },
        },
      }),
    );
    if (!row) throw new NotFoundException({ code: 'CUSTOMER_NOT_FOUND' });
    return row;
  }

  /** Inside the caller's tenant tx — allocates customer_no when absent. */
  async createTx(tx: Prisma.TransactionClient, ctx: TenantCtx, body: CustomerBody) {
    const customerNo =
      body.customerNo?.trim() ||
      (await this.seq.nextFormatted(tx, ctx.tenantId, 'customer_no', 'C', ctx.staffId));
    return conflictOnUnique(
      tx.customer.create({
        data: {
          tenantId: ctx.tenantId,
          customerNo,
          name: body.name!,
          custType: body.custType!,
          idType: body.idType,
          idNo: body.idNo,
          phone: body.phone,
          addr: body.addr,
          createdBy: ctx.staffId,
          updatedBy: ctx.staffId,
        },
        select: CUSTOMER_SELECT,
      }),
    );
  }

  async updateTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    id: string,
    body: CustomerPatchBody,
    req: Request,
  ) {
    const existing = await tx.customer.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!existing) throw new NotFoundException({ code: 'CUSTOMER_NOT_FOUND' });
    req.auditBefore = existing;
    return tx.customer.update({
      where: { tenantId_id: { tenantId: ctx.tenantId, id } },
      data: {
        name: body.name,
        custType: body.custType,
        idType: body.idType,
        idNo: body.idNo,
        phone: body.phone,
        addr: body.addr,
        updatedBy: ctx.staffId,
      },
      select: CUSTOMER_SELECT,
    });
  }
}
