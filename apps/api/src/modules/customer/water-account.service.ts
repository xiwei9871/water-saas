import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { conflictOnUnique } from '../../common/prisma-errors.js';
import { isValidPeriod } from '../../common/reading-cadence.js';
import type { TenantCtx } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import {
  assertAccountScopeTx,
  assertCustomerReadScopeTx,
  assertSettleScopeTx,
  outOfScopeAccountIds,
} from '../../common/account-scope.js';
import {
  assertUsageCategory,
  USAGE_CATEGORIES,
} from '../../common/usage-categories.js';
import { CustomerService, type CustomerBody } from './customer.service.js';
import { MeterService, type MeterBody } from './meter.service.js';
import { MeterInstallationService } from './meter-installation.service.js';
import { SequenceService } from '../../common/sequence.service.js';
import {
  SettleAccountService,
  SETTLE_ACCOUNT_SELECT,
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
  billable: true,
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
  account: {
    accountNo?: string;
    usageCategory: string;
    addr: string;
    openedAt?: Date;
    /** 一户多人口申报 — written as an effective-dated profile row. */
    householdSize?: number;
  };
  meter?: MeterBody;
  meterId?: string;
  installation: {
    initialReading: Prisma.Decimal;
    installedAt?: Date;
    reason?: 'NEW' | 'REPLACE' | 'FAULT' | 'PERIODIC_CHECK';
  };
}

/** Stable system-customer key for monitoring accounts (漏损分析计量点). */
const MONITORING_SYSTEM_KEY = 'MONITORING_INTERNAL';
const MONITORING_SETTLE_NO = 'SYS-MONITORING';

/** 'YYYYMM' → period of a Date (UTC, matching settlement period semantics). */
const periodOf = (d: Date) =>
  `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

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

  /**
   * GET /water-accounts — RC1-4 unified `q`: one box searches account_no,
   * addr, customer name/no/phone AND the CURRENT meter's meter_no (ACTIVE
   * installation). RC1-5: default order is newest-first (createdAt desc,
   * id desc) so a just-created account lands on page one.
   */
  list(
    ctx: TenantCtx,
    q: {
      take: number;
      skip: number;
      customerId?: string;
      settleAccountId?: string;
      status?: AccountStatus;
      accountNo?: string;
      q?: string;
    },
  ) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      // E8 read-scope: coverage exclusion applies to every filter shape —
      // an explicit customerId/settleAccountId/accountNo lookup must not
      // resurrect an out-of-scope account.
      const hidden =
        ctx.scope === 'ALL' ? [] : await outOfScopeAccountIds(tx, ctx);
      const needle = q.q?.trim();
      let meterHitIds: string[] | null = null;
      if (needle) {
        const hits = await tx.meterInstallation.findMany({
          where: {
            tenantId: ctx.tenantId,
            status: 'ACTIVE',
            meter: { meterNo: { contains: needle, mode: 'insensitive' } },
          },
          select: { waterAccountId: true },
        });
        meterHitIds = [...new Set(hits.map((h) => h.waterAccountId))];
      }
      const rows = await tx.waterAccount.findMany({
        where: {
          tenantId: ctx.tenantId,
          customerId: q.customerId,
          settleAccountId: q.settleAccountId,
          status: q.status,
          accountNo: q.accountNo,
          ...(needle
            ? {
                OR: [
                  { accountNo: { contains: needle, mode: 'insensitive' } },
                  { addr: { contains: needle, mode: 'insensitive' } },
                  {
                    customer: {
                      is: {
                        OR: [
                          { name: { contains: needle, mode: 'insensitive' } },
                          { customerNo: { contains: needle, mode: 'insensitive' } },
                          { phone: { contains: needle, mode: 'insensitive' } },
                        ],
                      },
                    },
                  },
                  { id: { in: meterHitIds ?? [] } },
                ],
              }
            : {}),
          ...(hidden.length ? { id: { notIn: hidden } } : {}),
        },
        select: { ...WATER_ACCOUNT_SELECT, ...ACCOUNT_INCLUDE },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.take,
        skip: q.skip,
      });
      // 当前表号 = ACTIVE installation ORDER BY installed_at DESC, id DESC
      // (E7 current-meter rule, shared with the 360 resolver).
      const actives = rows.length
        ? await tx.meterInstallation.findMany({
            where: {
              tenantId: ctx.tenantId,
              waterAccountId: { in: rows.map((r) => r.id) },
              status: 'ACTIVE',
            },
            select: {
              waterAccountId: true,
              meter: { select: { meterNo: true } },
            },
            orderBy: [{ installedAt: 'desc' }, { id: 'desc' }],
          })
        : [];
      const currentMeter = new Map<string, string>();
      for (const a of actives) {
        if (!currentMeter.has(a.waterAccountId)) {
          currentMeter.set(a.waterAccountId, a.meter.meterNo);
        }
      }
      return rows.map((r) => ({
        ...r,
        currentMeterNo: currentMeter.get(r.id) ?? null,
      }));
    });
  }

  usageCategories(_ctx: TenantCtx) {
    // Controlled category set (see common/usage-categories.ts) — the wire
    // shape stays `string[]` for the picker.
    return Promise.resolve([...USAGE_CATEGORIES]);
  }

  async getById(ctx: TenantCtx, id: string) {
    const row = await this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const account = await tx.waterAccount.findFirst({
        where: { tenantId: ctx.tenantId, id },
        select: {
          ...WATER_ACCOUNT_SELECT,
          ...ACCOUNT_INCLUDE,
          ...INSTALLATION_TIMELINE,
        },
      });
      if (!account) return null;
      await assertAccountScopeTx(tx, ctx, id);
      // 当前人数 = 生效账期 ≤ 当前账期的最新申报 —— 未来生效的申报只在
      // 历史列表可见，不冒充当前值。display-only；计费走结算快照。
      const now = new Date();
      const currentPeriod = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
      const profile = await tx.waterAccountHouseholdProfile.findFirst({
        where: {
          tenantId: ctx.tenantId,
          waterAccountId: id,
          effectiveFromPeriod: { lte: currentPeriod },
        },
        orderBy: { effectiveFromPeriod: 'desc' },
        select: { householdSize: true },
      });
      return { ...account, householdSize: profile?.householdSize ?? null };
    });
    if (!row) throw new NotFoundException({ code: 'WATER_ACCOUNT_NOT_FOUND' });
    return row;
  }

  /**
   * GET /water-accounts/:id/360 — E8 D1 frozen: the core summary returns
   * ONLY customer:read-domain data. Cross-domain cards (readings, books,
   * settlement, bills, outstanding, prepayment, payment activity) are
   * fetched by the UI through each domain's own endpoint + permission —
   * this endpoint must never become an RBAC bypass.
   */
  async summary360(ctx: TenantCtx, id: string) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const account = await tx.waterAccount.findFirst({
        where: { tenantId: ctx.tenantId, id },
        select: { ...WATER_ACCOUNT_SELECT, ...ACCOUNT_INCLUDE },
      });
      if (!account) {
        throw new NotFoundException({ code: 'WATER_ACCOUNT_NOT_FOUND' });
      }
      await assertAccountScopeTx(tx, ctx, id);
      const now = new Date();
      const currentPeriod = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
      const profile = await tx.waterAccountHouseholdProfile.findFirst({
        where: {
          tenantId: ctx.tenantId,
          waterAccountId: id,
          effectiveFromPeriod: { lte: currentPeriod },
        },
        orderBy: { effectiveFromPeriod: 'desc' },
        select: { householdSize: true },
      });
      // Current meter resolution = E7 frozen rule (shared with the
      // meter-reading resolver): ACTIVE ORDER BY installed_at DESC, id.
      const actives = await tx.meterInstallation.findMany({
        where: {
          tenantId: ctx.tenantId,
          waterAccountId: id,
          status: 'ACTIVE',
        },
        select: INSTALLATION_TIMELINE.meterInstallations.select,
        orderBy: [{ installedAt: 'desc' }, { id: 'desc' }],
      });
      // Lifecycle-derived warnings only — financial/metering warnings are
      // derived by the UI from each domain's own (permission-gated) data.
      const warnings: string[] = [];
      if (actives.length === 0 && account.status !== 'CLOSED') {
        warnings.push('NO_ACTIVE_METER');
      }
      if (actives.length > 1) warnings.push('MULTI_ACTIVE_METER');
      return {
        account: { ...account, householdSize: profile?.householdSize ?? null },
        currentInstallation: actives[0] ?? null,
        activeInstallationCount: actives.length,
        warnings,
      };
    });
  }

  /**
   * GET /water-accounts/:id/events — account lifecycle timeline
   * (TRANSFER/SUSPEND/RESUME/CLOSE, append-only). Paginated; scope via
   * loadAccount like every other account path.
   */
  listEvents(ctx: TenantCtx, id: string, q: { take: number; skip: number }) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      await this.loadAccount(tx, ctx, id);
      return tx.accountEvent.findMany({
        where: { tenantId: ctx.tenantId, waterAccountId: id },
        orderBy: [{ effectiveDate: 'desc' }, { createdAt: 'desc' }],
        take: q.take,
        skip: q.skip,
      });
    });
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
    // E8: every account write/read path funnels through this loader —
    // out-of-scope callers get 403 before any mutation or read.
    await assertAccountScopeTx(tx, ctx, id);
    return account;
  }

  /** Standalone account opening against existing customer + settle_account. */
  async createTx(tx: Prisma.TransactionClient, ctx: TenantCtx, body: WaterAccountBody) {
    // Prisma silently drops `undefined` filters — without this a missing FK
    // would bind the account to an arbitrary tenant row instead of failing.
    if (!body.customerId || !body.settleAccountId) {
      throw new BadRequestException({ code: 'WATER_ACCOUNT_FIELDS_REQUIRED' });
    }
    assertUsageCategory(body.usageCategory);
    const customer = await tx.customer.findFirst({
      where: { tenantId: ctx.tenantId, id: body.customerId },
    });
    if (!customer) throw new BadRequestException({ code: 'CUSTOMER_NOT_FOUND' });
    const settle = await tx.settleAccount.findFirst({
      where: { tenantId: ctx.tenantId, id: body.settleAccountId },
    });
    if (!settle) throw new BadRequestException({ code: 'SETTLE_ACCOUNT_NOT_FOUND' });
    this.assertSystemPrincipalPair(
      body.usageCategory === 'MONITORING',
      customer.systemKey === MONITORING_SYSTEM_KEY,
      settle.settleNo === MONITORING_SETTLE_NO,
    );
    if (body.usageCategory !== 'MONITORING') {
      // E8 P1: binding an EXISTING customer/settle is a target-reference —
      // the caller must be able to read that customer (D2 rule) and the
      // settle must satisfy the strict E6 scope. The system pair skips
      // this intentionally: it is internal plumbing for MONITORING
      // accounts, never operator data, and must not depend on org scope.
      await assertCustomerReadScopeTx(tx, ctx, body.customerId);
      await assertSettleScopeTx(tx, ctx, body.settleAccountId);
    }
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
          // billable is derived from category (also enforced by DB CHECK).
          billable: body.usageCategory !== 'MONITORING',
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
   * E8 RC2: the monitoring system principal is a CLOSED pair —
   * customer.systemKey=MONITORING_INTERNAL + settle.settleNo=SYS-MONITORING
   * may only appear TOGETHER and only on MONITORING accounts. A normal
   * account bound to either half (or a MONITORING account without the
   * complete pair) is an invalid business binding → 400, not 403: this is
   * not an org-scope judgement.
   */
  private assertSystemPrincipalPair(
    isMonitoringAccount: boolean,
    isSystemCustomer: boolean,
    isSystemSettle: boolean,
  ) {
    const invalid = isMonitoringAccount
      ? !(isSystemCustomer && isSystemSettle)
      : isSystemCustomer || isSystemSettle;
    if (invalid) {
      throw new BadRequestException({ code: 'SYSTEM_PRINCIPAL_NOT_ALLOWED' });
    }
  }

  /**
   * Find-or-create the tenant's system customer for monitoring accounts.
   * Keyed on `system_key` (UNIQUE), never on name — an operator-created
   * customer named the same can't shadow it, and a concurrent first-create
   * race degrades to a unique violation → re-read.
   */
  private async monitoringPrincipal(tx: Prisma.TransactionClient, ctx: TenantCtx) {
    let customer = await tx.customer.findFirst({
      where: { tenantId: ctx.tenantId, systemKey: MONITORING_SYSTEM_KEY },
    });
    if (!customer) {
      try {
        customer = await tx.customer.create({
          data: {
            tenantId: ctx.tenantId,
            customerNo: 'SYS-MONITORING',
            name: '本公司·监控表',
            custType: 'ORG',
            systemKey: MONITORING_SYSTEM_KEY,
            createdBy: ctx.staffId,
            updatedBy: ctx.staffId,
          },
        });
      } catch (e) {
        if (
          !(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
        ) {
          throw e;
        }
        customer = await tx.customer.findFirstOrThrow({
          where: { tenantId: ctx.tenantId, systemKey: MONITORING_SYSTEM_KEY },
        });
      }
    }
    let settle = await tx.settleAccount.findFirst({
      where: { tenantId: ctx.tenantId, settleNo: MONITORING_SETTLE_NO },
      select: SETTLE_ACCOUNT_SELECT,
    });
    if (!settle) {
      try {
        settle = await this.settles.createTx(tx, ctx, {
          settleNo: MONITORING_SETTLE_NO,
          name: '本公司·监控表',
        });
      } catch (e) {
        if (
          !(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
        ) {
          throw e;
        }
        settle = await tx.settleAccount.findFirstOrThrow({
          where: { tenantId: ctx.tenantId, settleNo: MONITORING_SETTLE_NO },
          select: SETTLE_ACCOUNT_SELECT,
        });
      }
    }
    return { customer, settle };
  }

  /**
   * Resolve the household profile effective for `period`: the latest row
   * with effective_from_period <= period. Returns null when undeclared.
   */
  private async effectiveHouseholdSize(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    waterAccountId: string,
    period: string,
  ) {
    const row = await tx.waterAccountHouseholdProfile.findFirst({
      where: {
        tenantId: ctx.tenantId,
        waterAccountId,
        effectiveFromPeriod: { lte: period },
      },
      orderBy: { effectiveFromPeriod: 'desc' },
      select: { householdSize: true },
    });
    return row?.householdSize ?? null;
  }

  /**
   * POST /water-accounts/:id/household-profiles — append an effective-dated
   * declaration. Same-period duplicates → 409 (correct via PATCH instead).
   */
  async createHouseholdProfileTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    waterAccountId: string,
    body: { householdSize?: number; effectiveFromPeriod?: string },
  ) {
    await this.loadAccount(tx, ctx, waterAccountId);
    if (
      body.householdSize === undefined ||
      !Number.isInteger(body.householdSize) ||
      body.householdSize < 0
    ) {
      throw new BadRequestException({ code: 'INVALID_HOUSEHOLD_SIZE' });
    }
    if (!body.effectiveFromPeriod || !isValidPeriod(body.effectiveFromPeriod)) {
      throw new BadRequestException({ code: 'INVALID_PERIOD' });
    }
    return tx.waterAccountHouseholdProfile
      .create({
        data: {
          tenantId: ctx.tenantId,
          waterAccountId,
          householdSize: body.householdSize,
          effectiveFromPeriod: body.effectiveFromPeriod,
          createdBy: ctx.staffId,
          updatedBy: ctx.staffId,
        },
      })
      .catch((e) => {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002'
        ) {
          throw new ConflictException({ code: 'HOUSEHOLD_PROFILE_EXISTS' });
        }
        throw e;
      });
  }

  /**
   * PATCH /water-accounts/household-profiles/:profileId — amend a declared
   * row. Already-generated settlements keep their snapshot (history intact);
   * future settlements for that period pick up the corrected declaration.
   */
  async patchHouseholdProfileTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    waterAccountId: string,
    profileId: string,
    body: { householdSize?: number },
    req: Request,
  ) {
    const existing = await tx.waterAccountHouseholdProfile.findFirst({
      where: { tenantId: ctx.tenantId, id: profileId, waterAccountId },
    });
    if (!existing) {
      throw new NotFoundException({ code: 'HOUSEHOLD_PROFILE_NOT_FOUND' });
    }
    await assertAccountScopeTx(tx, ctx, waterAccountId);
    if (
      body.householdSize === undefined ||
      !Number.isInteger(body.householdSize) ||
      body.householdSize < 0
    ) {
      throw new BadRequestException({ code: 'INVALID_HOUSEHOLD_SIZE' });
    }
    req.auditBefore = existing;
    return tx.waterAccountHouseholdProfile.update({
      where: { id: existing.id },
      data: { householdSize: body.householdSize, updatedBy: ctx.staffId },
    });
  }

  listHouseholdProfiles(ctx: TenantCtx, waterAccountId: string) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      await this.loadAccount(tx, ctx, waterAccountId);
      return tx.waterAccountHouseholdProfile.findMany({
        where: { tenantId: ctx.tenantId, waterAccountId },
        orderBy: { effectiveFromPeriod: 'desc' },
      });
    });
  }

  /**
   * 立户向导 — one transaction creates/links customer + settle_account +
   * water_account + meter + ACTIVE installation (spec §2.1 / §4 onboard).
   * Every document number draws from sys_sequence inside this tx: a rollback
   * returns the numbers too, so a retry can't leak sequence gaps into a
   * half-written account.
   */
  async onboardTx(tx: Prisma.TransactionClient, ctx: TenantCtx, body: OnboardBody) {
    assertUsageCategory(body.account.usageCategory);
    const isMonitoring = body.account.usageCategory === 'MONITORING';

    // 1+2. customer + settle_account — monitoring meters hang off the
    //    tenant's system customer (MONITORING_INTERNAL); everything else
    //    uses the normal link-or-create flow.
    let customer;
    let settleAccount;
    if (isMonitoring) {
      const principal = await this.monitoringPrincipal(tx, ctx);
      customer = principal.customer;
      settleAccount = principal.settle;
    } else {
      if (body.customerId) {
        customer = await tx.customer.findFirst({
          where: { tenantId: ctx.tenantId, id: body.customerId },
        });
        if (!customer) {
          throw new BadRequestException({ code: 'CUSTOMER_NOT_FOUND' });
        }
      } else {
        customer = await this.customers.createTx(tx, ctx, body.customer!);
      }
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

    // 3b. 一户多人口申报 — first declaration effective from the open period.
    if (body.account.householdSize !== undefined) {
      if (
        !Number.isInteger(body.account.householdSize) ||
        body.account.householdSize < 0
      ) {
        throw new BadRequestException({ code: 'INVALID_HOUSEHOLD_SIZE' });
      }
      await tx.waterAccountHouseholdProfile.create({
        data: {
          tenantId: ctx.tenantId,
          waterAccountId: waterAccount.id,
          householdSize: body.account.householdSize,
          effectiveFromPeriod: periodOf(waterAccount.openedAt ?? new Date()),
          createdBy: ctx.staffId,
          updatedBy: ctx.staffId,
        },
      });
    }

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
    if (body.usageCategory !== undefined) {
      assertUsageCategory(body.usageCategory);
      // E8 RC3: category change must not break the closed system-principal
      // pair — the account keeps its customer/settle, so the POST-PATCH
      // category is checked against the CURRENT pair.
      const [customer, settle] = await Promise.all([
        tx.customer.findFirst({
          where: { tenantId: ctx.tenantId, id: existing.customerId },
          select: { systemKey: true },
        }),
        tx.settleAccount.findFirst({
          where: { tenantId: ctx.tenantId, id: existing.settleAccountId },
          select: { settleNo: true },
        }),
      ]);
      this.assertSystemPrincipalPair(
        body.usageCategory === 'MONITORING',
        customer?.systemKey === MONITORING_SYSTEM_KEY,
        settle?.settleNo === MONITORING_SETTLE_NO,
      );
    }
    req.auditBefore = existing;
    return tx.waterAccount.update({
      where: { tenantId_id: { tenantId: ctx.tenantId, id } },
      data: {
        usageCategory: body.usageCategory,
        // Category change re-derives billable (DB CHECK enforces the pair).
        ...(body.usageCategory !== undefined
          ? { billable: body.usageCategory !== 'MONITORING' }
          : {}),
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
    // Resolve the POST-TRANSFER principal flags — the pair rule applies
    // to the resulting (customer, settle) combination, not only to the
    // fields being changed.
    let targetSystemCustomer: boolean;
    if (body.customerId !== undefined) {
      const c = await tx.customer.findFirst({
        where: { tenantId: ctx.tenantId, id: body.customerId },
      });
      if (!c) throw new BadRequestException({ code: 'CUSTOMER_NOT_FOUND' });
      targetSystemCustomer = c.systemKey === MONITORING_SYSTEM_KEY;
    } else {
      const c = await tx.customer.findFirst({
        where: { tenantId: ctx.tenantId, id: existing.customerId },
        select: { systemKey: true },
      });
      targetSystemCustomer = c?.systemKey === MONITORING_SYSTEM_KEY;
    }
    let targetSystemSettle: boolean;
    if (body.settleAccountId !== undefined) {
      const s = await tx.settleAccount.findFirst({
        where: { tenantId: ctx.tenantId, id: body.settleAccountId },
      });
      if (!s) throw new BadRequestException({ code: 'SETTLE_ACCOUNT_NOT_FOUND' });
      targetSystemSettle = s.settleNo === MONITORING_SETTLE_NO;
    } else {
      const s = await tx.settleAccount.findFirst({
        where: { tenantId: ctx.tenantId, id: existing.settleAccountId },
        select: { settleNo: true },
      });
      targetSystemSettle = s?.settleNo === MONITORING_SETTLE_NO;
    }
    this.assertSystemPrincipalPair(
      existing.usageCategory === 'MONITORING',
      targetSystemCustomer,
      targetSystemSettle,
    );
    if (existing.usageCategory !== 'MONITORING') {
      // E8 P1: target reference scope — source-account scope (loadAccount
      // above) does NOT license pointing the account at a customer/settle
      // the caller can't read.
      if (body.customerId !== undefined) {
        await assertCustomerReadScopeTx(tx, ctx, body.customerId);
      }
      if (body.settleAccountId !== undefined) {
        await assertSettleScopeTx(tx, ctx, body.settleAccountId);
      }
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
    // E7 C1: lock the account row FOR UPDATE *before* reading state —
    // install/replace take the same lock and re-check inside it, so close
    // and a concurrent meter-mount are mutually exclusive. All status
    // judgments below run on the locked row, not a pre-lock snapshot
    // (a racing transition must not leak into auditBefore/oldValue).
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM water_account
      WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${id}::uuid
      FOR UPDATE`;
    if (!locked.length) {
      throw new NotFoundException({ code: 'WATER_ACCOUNT_NOT_FOUND' });
    }
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

    if (to === 'CLOSED') {
      const active = await tx.meterInstallation.count({
        where: { tenantId: ctx.tenantId, waterAccountId: id, status: 'ACTIVE' },
      });
      if (active > 0) {
        throw new ConflictException({
          code: 'ACCOUNT_HAS_ACTIVE_INSTALLATION',
          activeInstallations: active,
        });
      }
    }
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
