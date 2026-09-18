import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { conflictOnUnique } from '../../common/prisma-errors.js';
import type { TenantCtx } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { CustomerService, type CustomerBody } from './customer.service.js';
import { MeterService, type MeterBody } from './meter.service.js';
import { MeterInstallationService } from './meter-installation.service.js';
import { SequenceService } from './sequence.service.js';
import {
  SettleAccountService,
  type SettleAccountBody,
} from './settle-account.service.js';

export const WATER_ACCOUNT_SELECT = {
  id: true,
  tenantId: true,
  accountNo: true,
  customerId: true,
  settleAccountId: true,
  usageCategory: true,
  addr: true,
  status: true,
  openedAt: true,
  closedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.WaterAccountSelect;

const ACCOUNT_INCLUDE = {
  customer: { select: { id: true, customerNo: true, name: true, custType: true } },
  settleAccount: { select: { id: true, settleNo: true, name: true, status: true } },
} satisfies Prisma.WaterAccountInclude;

const INSTALLATION_TIMELINE = {
  meterInstallations: {
    select: {
      id: true,
      meterId: true,
      installedAt: true,
      removedAt: true,
      initialReading: true,
      finalReading: true,
      reason: true,
      status: true,
      meter: { select: { meterNo: true, brand: true, model: true, caliber: true } },
    },
    orderBy: { installedAt: 'desc' as const },
  },
};

type AccountStatus = 'NORMAL' | 'SUSPENDED' | 'CLOSED';
type EventType = 'TRANSFER' | 'SUSPEND' | 'RESUME' | 'CLOSE';

export interface WaterAccountBody {
  accountNo?: string;
  customerId?: string;
  settleAccountId?: string;
  usageCategory?: string;
  addr?: string;
  openedAt?: Date;
}

export interface WaterAccountPatchBody {
  usageCategory?: string;
  addr?: string;
}

export interface EventBody {
  effectiveDate?: Date;
  remark?: string;
}

export interface TransferBody extends EventBody {
  customerId?: string;
  settleAccountId?: string;
}

export interface OnboardBody {
  customer?: CustomerBody;
  customerId?: string;
  settleAccount?: SettleAccountBody;
  settleAccountId?: string;
  account: { accountNo?: string; usageCategory: string; addr: string; openedAt?: Date };
  meter?: MeterBody;
  meterId?: string;
  installation: {
    initialReading: Prisma.Decimal;
    installedAt?: Date;
    reason?: 'NEW' | 'REPLACE' | 'FAULT' | 'PERIODIC_CHECK';
  };
}

const invalidTransition = (from: string, to: string) =>
  new ConflictException({ code: 'INVALID_ACCOUNT_STATUS_TRANSITION', from, to });

/**
 * WaterAccount （用水户） — a billable water point belonging to a customer and
 * settling through a settle_account (spec §2.1 三户模型）. Status machine:
 * NORMAL ↔ SUSPENDED → CLOSED; transitions write account_event rows
 * (TRANSFER/SUSPEND/RESUME/CLOSE) with old/new state in payload.
 */
@Injectable()
export class WaterAccountService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly seq: SequenceService,
    private readonly customers: CustomerService,
    private readonly settles: SettleAccountService,
    private readonly meters: MeterService,
    private readonly installs: MeterInstallationService,
  ) {}

  list(
    ctx: TenantCtx,
    q: {
      take: number;
      skip: number;
      customerId?: string;
      settleAccountId?: string;
      status?: AccountStatus;
      accountNo?: string;
    },
  ) {
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.waterAccount.findMany({
        where: {
          tenantId: ctx.tenantId,
          customerId: q.customerId,
          settleAccountId: q.settleAccountId,
          status: q.status,
          accountNo: q.accountNo,
        },
        select: { ...WATER_ACCOUNT_SELECT, ...ACCOUNT_INCLUDE },
        orderBy: { accountNo: 'asc' },
        take: q.take,
        skip: q.skip,
      }),
    );
  }

  async getById(ctx: TenantCtx, id: string) {
    const row = await this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.waterAccount.findFirst({
        where: { tenantId: ctx.tenantId, id },
        select: {
          ...WATER_ACCOUNT_SELECT,
          ...ACCOUNT_INCLUDE,
          ...INSTALLATION_TIMELINE,
        },
      }),
    );
    if (!row) throw new NotFoundException({ code: 'WATER_ACCOUNT_NOT_FOUND' });
    return row;
  }

  private async writeEvent(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    waterAccountId: string,
    type: EventType,
    payload: Prisma.InputJsonValue,
    effectiveDate?: Date,
  ) {
    await tx.accountEvent.create({
      data: {
        tenantId: ctx.tenantId,
        waterAccountId,
        type,
        payload,
        effectiveDate: effectiveDate ?? new Date(),
        createdBy: ctx.staffId,
        updatedBy: ctx.staffId,
      },
    });
  }

  private async loadAccount(tx: Prisma.TransactionClient, ctx: TenantCtx, id: string) {
    const account = await tx.waterAccount.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!account) throw new NotFoundException({ code: 'WATER_ACCOUNT_NOT_FOUND' });
    return account;
  }

  /** Standalone account opening against existing customer + settle_account. */
  async createTx(tx: Prisma.TransactionClient, ctx: TenantCtx, body: WaterAccountBody) {
    // Prisma silently drops `undefined` filters — without this a missing FK
    // would bind the account to an arbitrary tenant row instead of failing.
    if (!body.customerId || !body.settleAccountId) {
      throw new BadRequestException({ code: 'WATER_ACCOUNT_FIELDS_REQUIRED' });
    }
    const customer = await tx.customer.findFirst({
      where: { tenantId: ctx.tenantId, id: body.customerId },
    });
    if (!customer) throw new BadRequestException({ code: 'CUSTOMER_NOT_FOUND' });
    const settle = await tx.settleAccount.findFirst({
      where: { tenantId: ctx.tenantId, id: body.settleAccountId },
    });
    if (!settle) throw new BadRequestException({ code: 'SETTLE_ACCOUNT_NOT_FOUND' });
    const accountNo =
      body.accountNo?.trim() ||
      (await this.seq.nextFormatted(tx, ctx.tenantId, 'account_no', 'A', ctx.staffId));
    return conflictOnUnique(
      tx.waterAccount.create({
        data: {
          tenantId: ctx.tenantId,
          accountNo,
          customerId: body.customerId!,
          settleAccountId: body.settleAccountId!,
          usageCategory: body.usageCategory!,
          addr: body.addr!,
          status: 'NORMAL',
          openedAt: body.openedAt ?? new Date(),
          createdBy: ctx.staffId,
          updatedBy: ctx.staffId,
        },
        select: { ...WATER_ACCOUNT_SELECT, ...ACCOUNT_INCLUDE },
      }),
    );
  }

  /**
   * 立户向导 — one transaction creates/links customer + settle_account +
   * water_account + meter + ACTIVE installation (spec §2.1 / §4 onboard).
   * Every document number draws from sys_sequence inside this tx: a rollback
   * returns the numbers too, so a retry can't leak sequence gaps into a
   * half-written account.
   */
  async onboardTx(tx: Prisma.TransactionClient, ctx: TenantCtx, body: OnboardBody) {
    // 1. customer — link existing or create new
    let customer;
    if (body.customerId) {
      customer = await tx.customer.findFirst({
        where: { tenantId: ctx.tenantId, id: body.customerId },
      });
      if (!customer) throw new BadRequestException({ code: 'CUSTOMER_NOT_FOUND' });
    } else {
      customer = await this.customers.createTx(tx, ctx, body.customer!);
    }

    // 2. settle_account — link existing, create from payload, or default to
    //    the customer's own name/phone (common 一户一结 case).
    let settleAccount;
    if (body.settleAccountId) {
      settleAccount = await tx.settleAccount.findFirst({
        where: { tenantId: ctx.tenantId, id: body.settleAccountId },
      });
      if (!settleAccount) {
        throw new BadRequestException({ code: 'SETTLE_ACCOUNT_NOT_FOUND' });
      }
    } else {
      const settleBody: SettleAccountBody = body.settleAccount ?? {
        name: customer.name,
        phone: customer.phone ?? undefined,
      };
      settleAccount = await this.settles.createTx(tx, ctx, settleBody);
    }

    // 3. water_account
    const waterAccount = await this.createTx(tx, ctx, {
      accountNo: body.account.accountNo,
      customerId: customer.id,
      settleAccountId: settleAccount.id,
      usageCategory: body.account.usageCategory,
      addr: body.account.addr,
      openedAt: body.account.openedAt,
    });

    // 4. meter — register new or reuse an existing AVAILABLE device
    let meter;
    if (body.meterId) {
      meter = await tx.meter.findFirst({
        where: { tenantId: ctx.tenantId, id: body.meterId },
      });
      if (!meter) throw new BadRequestException({ code: 'METER_NOT_FOUND' });
    } else {
      meter = await this.meters.createTx(tx, ctx, body.meter ?? {});
    }

    // 5. installation — installTx enforces AVAILABLE→INSTALLED itself, so an
    //    already-mounted meterId or a just-created meter both land correctly.
    const installation = await this.installs.installTx(tx, ctx, {
      waterAccountId: waterAccount.id,
      meterId: meter.id,
      initialReading: body.installation.initialReading,
      installedAt: body.installation.installedAt,
      reason: body.installation.reason,
    });

    return {
      customer,
      settleAccount,
      waterAccount,
      meter: installation.meter,
      installation,
    };
  }

  /** PATCH — profile fields only; status moves exclusively through events. */
  async updateTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    id: string,
    body: WaterAccountPatchBody,
    req: Request,
  ) {
    const existing = await this.loadAccount(tx, ctx, id);
    if (existing.status === 'CLOSED') throw invalidTransition('CLOSED', 'PATCH');
    req.auditBefore = existing;
    return tx.waterAccount.update({
      where: { tenantId_id: { tenantId: ctx.tenantId, id } },
      data: {
        usageCategory: body.usageCategory,
        addr: body.addr,
        updatedBy: ctx.staffId,
      },
      select: { ...WATER_ACCOUNT_SELECT, ...ACCOUNT_INCLUDE },
    });
  }

  /**
   * 过户 — re-point the account at a different customer and/or settle_account.
   * Status unchanged; CLOSED accounts can't transfer.
   */
  async transferTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    id: string,
    body: TransferBody,
    req: Request,
  ) {
    const existing = await this.loadAccount(tx, ctx, id);
    if (existing.status === 'CLOSED') throw invalidTransition('CLOSED', 'TRANSFER');
    if (body.customerId !== undefined) {
      const c = await tx.customer.findFirst({
        where: { tenantId: ctx.tenantId, id: body.customerId },
      });
      if (!c) throw new BadRequestException({ code: 'CUSTOMER_NOT_FOUND' });
    }
    if (body.settleAccountId !== undefined) {
      const s = await tx.settleAccount.findFirst({
        where: { tenantId: ctx.tenantId, id: body.settleAccountId },
      });
      if (!s) throw new BadRequestException({ code: 'SETTLE_ACCOUNT_NOT_FOUND' });
    }
    req.auditBefore = existing;

    const oldValue = {
      customerId: existing.customerId,
      settleAccountId: existing.settleAccountId,
    };
    const updated = await tx.waterAccount.update({
      where: { tenantId_id: { tenantId: ctx.tenantId, id } },
      data: {
        customerId: body.customerId,
        settleAccountId: body.settleAccountId,
        updatedBy: ctx.staffId,
      },
      select: { ...WATER_ACCOUNT_SELECT, ...ACCOUNT_INCLUDE },
    });
    await this.writeEvent(
      tx,
      ctx,
      id,
      'TRANSFER',
      {
        oldValue,
        newValue: {
          customerId: updated.customerId,
          settleAccountId: updated.settleAccountId,
        },
        remark: body.remark ?? null,
      },
      body.effectiveDate,
    );
    return updated;
  }

  /** Status transition shared by suspend/resume/close. */
  private async transitionTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    id: string,
    to: 'SUSPENDED' | 'NORMAL' | 'CLOSED',
    type: EventType,
    body: EventBody,
    req: Request,
  ) {
    const existing = await this.loadAccount(tx, ctx, id);
    const allowed: Record<string, AccountStatus[]> = {
      SUSPENDED: ['NORMAL'], // suspend: NORMAL → SUSPENDED
      NORMAL: ['SUSPENDED'], // resume:  SUSPENDED → NORMAL
      CLOSED: ['NORMAL', 'SUSPENDED'], // close: NORMAL|SUSPENDED → CLOSED
    };
    if (!allowed[to].includes(existing.status as AccountStatus)) {
      throw invalidTransition(existing.status, to);
    }
    req.auditBefore = existing;

    // Guarded transition: the allowed-from predicate is part of the UPDATE so
    // a concurrent transition loses the race (count=0) instead of double-
    // writing events (e.g. two SUSPEND records).
    const flipped = await tx.waterAccount.updateMany({
      where: { tenantId: ctx.tenantId, id, status: { in: allowed[to] } },
      data: {
        status: to,
        closedAt: to === 'CLOSED' ? (body.effectiveDate ?? new Date()) : undefined,
        updatedBy: ctx.staffId,
      },
    });
    if (flipped.count === 0) {
      throw invalidTransition(existing.status, to);
    }
    const updated = await tx.waterAccount.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: ctx.tenantId, id } },
      select: { ...WATER_ACCOUNT_SELECT, ...ACCOUNT_INCLUDE },
    });
    await this.writeEvent(
      tx,
      ctx,
      id,
      type,
      {
        oldValue: { status: existing.status },
        newValue: { status: to },
        remark: body.remark ?? null,
      },
      body.effectiveDate,
    );
    return updated;
  }

  suspendTx(tx: Prisma.TransactionClient, ctx: TenantCtx, id: string, body: EventBody, req: Request) {
    return this.transitionTx(tx, ctx, id, 'SUSPENDED', 'SUSPEND', body, req);
  }

  resumeTx(tx: Prisma.TransactionClient, ctx: TenantCtx, id: string, body: EventBody, req: Request) {
    return this.transitionTx(tx, ctx, id, 'NORMAL', 'RESUME', body, req);
  }

  /**
   * 销户 — execution half of the close orchestration: the use case already
   * verified outstanding == 0, so here it's a plain guarded transition.
   */
  closeTx(tx: Prisma.TransactionClient, ctx: TenantCtx, id: string, body: EventBody, req: Request) {
    return this.transitionTx(tx, ctx, id, 'CLOSED', 'CLOSE', body, req);
  }
}
