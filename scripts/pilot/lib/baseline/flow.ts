/**
 * G3 baseline domain flows — every write goes through the real service
 * method under its registered D4 ownership. No SQL inserts for domain
 * entities. Deterministic: all values derive from seq/period.
 */

import { apiImport } from '../api-import.ts';
import { apiRequire } from '../pg.ts';
import { keys } from '../keys.ts';
import {
  withTenantTx,
  withTenantTxTimeout,
  type Harness,
  type TenantCtx,
} from '../harness.ts';
import type { AccountPlan } from './allocate.ts';
import { periodDay } from './allocate.ts';
import type { GroundTruthEntry } from '../manifest.ts';

const Pr = apiRequire('@prisma/client') as typeof import('@prisma/client');
const Dec = Pr.Prisma.Decimal;

/** Fake req — services only use req.auditBefore / req.user.perms. */
const REQ = { user: { perms: ['*'] } };

/** concurrency-limited map for independent-entity phases only. */
export const mapLimit = async <T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> => {
  const out: R[] = Array.from({ length: items.length }) as R[];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const cur = i++;
      out[cur] = await fn(items[cur], cur);
    }
  });
  await Promise.all(workers);
  return out;
};

// ---------------------------------------------------------------------------
// lazy service resolution (class tokens via dynamic import)
// ---------------------------------------------------------------------------

const svc = async (h: Harness, path: string, name: string) => {
  const m = await apiImport(`modules/${path}`);
  const svc = h.get(m[name]);
  if (!svc) throw new Error(`service not found in container: ${name}`);
  return svc as Record<string, (...a: unknown[]) => unknown>;
};

export const services = {
  waterAccount: (h: Harness) =>
    svc(h, 'customer/water-account.service', 'WaterAccountService'),
  book: (h: Harness) =>
    svc(h, 'metering/reading-book.service', 'ReadingBookService'),
  plan: (h: Harness) =>
    svc(h, 'metering/reading-plan.service', 'ReadingPlanService'),
  reading: (h: Harness) =>
    svc(h, 'metering/meter-reading.service', 'MeterReadingService'),
  settlement: (h: Harness) =>
    svc(h, 'metering/settlement.service', 'SettlementService'),
  billingRun: (h: Harness) =>
    svc(h, 'billing/billing-run.service', 'BillingRunService'),
  payment: (h: Harness) =>
    svc(h, 'payment/payment.service', 'PaymentService'),
  dayClose: (h: Harness) =>
    svc(h, 'payment/day-close.service', 'DayCloseService'),
  prepayment: (h: Harness) =>
    svc(h, 'prepayment/prepayment.service', 'PrepaymentService'),
  remoteSource: (h: Harness) =>
    svc(h, 'remote/remote-source.service', 'RemoteSourceService'),
  remoteDevice: (h: Harness) =>
    svc(h, 'remote/remote-device.service', 'RemoteDeviceService'),
  remoteEvent: (h: Harness) =>
    svc(h, 'remote/remote-event.service', 'RemoteEventService'),
};

// ---------------------------------------------------------------------------
// accounts — onboardTx = customer + settle + water + meter + ACTIVE install
// ---------------------------------------------------------------------------

export interface GeneratedAccount {
  plan: AccountPlan;
  accountNo: string;
  customerId: string;
  settleAccountId: string;
  waterAccountId: string;
  meterId: string;
  installationId: string;
  installedAt: Date;
  /** filled after books exist — drives GT book key + orgOwnership */
  branchId?: string;
  bookId?: string;
  bookNo?: string;
}

export async function generateAccounts(
  h: Harness,
  ctx: TenantCtx,
  seed: number,
  plans: AccountPlan[],
  concurrency: number,
  installedAt: Date,
): Promise<GeneratedAccount[]> {
  const wa = await services.waterAccount(h);
  return mapLimit(plans, concurrency, async (p) => {
    const accountNo = keys.accountNo(seed, p.tag, p.seq);
    const r = (await withTenantTx(
      h,
      'WaterAccountService.onboardTx',
      ctx.tenantId,
      (tx) =>
        wa.onboardTx(tx, ctx, {
          customer: {
            customerNo: keys.customerNo(seed, p.tag, p.seq),
            name: `Pilot 客户 ${accountNo}`,
            custType: 'PERSONAL',
          },
          settleAccount: {
            settleNo: keys.settleNo(seed, p.tag, p.seq),
            name: `Pilot 结算 ${accountNo}`,
          },
          account: {
            accountNo,
            usageCategory: 'RES_METERED',
            addr: `Pilot 地址 ${accountNo}`,
            openedAt: installedAt,
          },
          meter: { meterNo: keys.meterNo(seed, p.seq), caliber: 'DN15' },
          installation: {
            initialReading: new Dec(0),
            installedAt,
            reason: 'NEW',
          },
        } as never),
    )) as {
      customer: { id: string };
      settleAccount: { id: string };
      waterAccount: { id: string };
      meter: { id: string };
      installation: { id: string };
    };
    return {
      plan: p,
      accountNo,
      customerId: r.customer.id,
      settleAccountId: r.settleAccount.id,
      waterAccountId: r.waterAccount.id,
      meterId: r.meter.id,
      installationId: r.installation.id,
      installedAt,
    };
  });
}

// ---------------------------------------------------------------------------
// books + membership — exactly one book per clean account
// ---------------------------------------------------------------------------

export interface GeneratedBook {
  id: string;
  branchIdx: number;
  seq: number;
  bookNo: string;
  orgUnitId: string;
}

export async function generateBooks(
  h: Harness,
  ctx: TenantCtx,
  seed: number,
  branchIds: string[],
  booksPerBranch: number,
): Promise<GeneratedBook[]> {
  const book = await services.book(h);
  const out: GeneratedBook[] = [];
  for (let b = 0; b < branchIds.length; b++) {
    for (let i = 0; i < booksPerBranch; i++) {
      const seq = b * booksPerBranch + i;
      const r = (await withTenantTx(
        h,
        'ReadingBookService.createTx',
        ctx.tenantId,
        (tx) =>
          book.createTx(tx, ctx, {
            bookNo: keys.bookCode(seed, seq),
            name: keys.bookName(seed, seq),
            orgUnitId: branchIds[b],
            cadence: 'MONTHLY',
            meterChannel: 'MECHANICAL',
          } as never),
      )) as { id: string };
      out.push({
        id: r.id,
        branchIdx: b,
        seq,
        bookNo: keys.bookCode(seed, seq),
        orgUnitId: branchIds[b],
      });
    }
  }
  return out;
}

export async function addMemberships(
  h: Harness,
  ctx: TenantCtx,
  books: GeneratedBook[],
  accounts: GeneratedAccount[],
  concurrency: number,
): Promise<number> {
  const book = await services.book(h);
  let n = 0;
  await mapLimit(accounts, concurrency, async (a) => {
    await withTenantTx(h, 'ReadingBookService.addMemberTx', ctx.tenantId, (tx) =>
      book.addMemberTx(tx, ctx, books[a.plan.bookIdx].id, {
        waterAccountId: a.waterAccountId,
        seqNo: a.plan.seq + 1,
      } as never),
    );
    n++;
  });
  return n;
}

// ---------------------------------------------------------------------------
// plans + readings per period
// ---------------------------------------------------------------------------

export interface PlanBundle {
  planId: string;
  bookIdx: number;
  /** waterAccountId → planItemId */
  itemByAccount: Map<string, string>;
}

export async function generatePlans(
  h: Harness,
  ctx: TenantCtx,
  books: GeneratedBook[],
  period: string,
): Promise<PlanBundle[]> {
  const plan = await services.plan(h);
  const out: PlanBundle[] = [];
  for (const b of books) {
    const r = (await withTenantTx(
      h,
      'ReadingPlanService.generateTx',
      ctx.tenantId,
      (tx) =>
        plan.generateTx(tx, ctx, {
          bookId: b.id,
          period,
          planDate: periodDay(period, 5),
        } as never),
    )) as { id: string; items: { id: string; waterAccountId: string }[] };
    out.push({
      planId: r.id,
      bookIdx: b.seq,
      itemByAccount: new Map(r.items.map((i) => [i.waterAccountId, i.id])),
    });
  }
  return out;
}

/** Manual ACTUAL readings for non-remote accounts + QC pass each. */
export async function submitManualReadings(
  h: Harness,
  ctx: TenantCtx,
  bundles: PlanBundle[],
  accounts: GeneratedAccount[],
  period: string,
  periodIdx: number,
): Promise<number> {
  const reading = await services.reading(h);
  const readDate = periodDay(period, 15);
  let count = 0;
  for (const bundle of bundles) {
    const inputs = accounts
      .filter(
        (a) =>
          !a.plan.remote &&
          a.plan.bookIdx === bundle.bookIdx &&
          bundle.itemByAccount.has(a.waterAccountId),
      )
      .map((a) => ({
        planItemId: bundle.itemByAccount.get(a.waterAccountId)!,
        resultType: 'ACTUAL',
        readingValue: new Dec(a.plan.usage[periodIdx]),
        readDate,
        source: 'WEB',
      }));
    if (!inputs.length) continue;
    const rows = (await withTenantTx(
      h,
      'MeterReadingService.createBatchTx',
      ctx.tenantId,
      (tx) => reading.createBatchTx(tx, ctx, inputs as never),
    )) as { id: string }[];
    for (const r of rows) {
      await withTenantTx(h, 'MeterReadingService.qcTx', ctx.tenantId, (tx) =>
        reading.qcTx(tx, ctx, r.id, 'pass', REQ),
      );
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// settlements (DRAFT → FINAL)
// ---------------------------------------------------------------------------

export async function settleAccounts(
  h: Harness,
  ctx: TenantCtx,
  accounts: GeneratedAccount[],
  period: string,
  concurrency: number,
): Promise<number> {
  const settle = await services.settlement(h);
  let n = 0;
  await mapLimit(accounts, concurrency, async (a) => {
    await withTenantTx(
      h,
      'SettlementService.generateTx',
      ctx.tenantId,
      async (tx) => {
        const s = (await settle.generateTx(tx, ctx, {
          waterAccountId: a.waterAccountId,
          period,
        } as never)) as { id: string };
        await settle.finalizeTx(tx, ctx, s.id, REQ);
      },
    );
    n++;
  });
  return n;
}

// ---------------------------------------------------------------------------
// billing — createTx (CALLER) + execute (SELF-MANAGED, never wrapped)
// ---------------------------------------------------------------------------

export async function createBillingRun(
  h: Harness,
  ctx: TenantCtx,
  period: string,
): Promise<string> {
  const billing = await services.billingRun(h);
  // G6 scale: createTx does all DRAFT-bill generation in ONE interactive
  // tx; Prisma's 5s default expires beyond ~800 settlements. The pilot
  // harness widens the budget (identical set_config semantics) — the
  // production timeout ceiling is recorded as a hardening finding.
  const run = (await withTenantTxTimeout(
    h,
    'BillingRunService.createTx',
    ctx.tenantId,
    10 * 60 * 1000,
    (tx) => billing.createTx(tx, ctx, { period } as never),
  )) as { id: string };
  return run.id;
}

/**
 * P1-1 — real TOP_UP→APPLY evidence. After createTx produced DRAFT
 * bills but BEFORE execute posts them, C-profile accounts top up
 * exactly their period bill total. DRAFT bills are not payable debt,
 * so topUpTx records a pure TOP_UP ledger lot; execute() then posts
 * and applyForPostedDebtTx writes APPLY + PREPAYMENT payment_alloc.
 */
export async function preFundCAccounts(
  h: Harness,
  ctx: TenantCtx,
  accounts: GeneratedAccount[],
  period: string,
  concurrency: number,
): Promise<number> {
  const cAccounts = accounts.filter((a) => a.plan.payProfile === 'C');
  if (!cAccounts.length) return 0;
  const prepay = await services.prepayment(h);
  // this period's DRAFT bill totals per C account
  const rows = await h.tenantPrisma.runAsTenant(ctx.tenantId, async (tx) => {
    const t = tx as { $queryRaw<T>(q: unknown, ...a: unknown[]): Promise<T> };
    return t.$queryRaw<{ water_account_id: string; total: unknown }[]>(
      Pr.Prisma.sql`SELECT water_account_id, sum(total_amount) total
        FROM bill
        WHERE tenant_id=${ctx.tenantId}::uuid AND period=${period}
          AND status='DRAFT'
          AND water_account_id=ANY(${cAccounts.map((a) => a.waterAccountId)}::uuid[])
        GROUP BY water_account_id`,
    );
  });
  const totalByAccount = new Map(
    rows.map((r) => [r.water_account_id, BigInt(String(r.total ?? 0))]),
  );
  let n = 0;
  await mapLimit(cAccounts, concurrency, async (a) => {
    const amount = totalByAccount.get(a.waterAccountId) ?? 0n;
    if (amount <= 0n) return;
    await withTenantTx(h, 'PrepaymentService.topUpTx', ctx.tenantId, (tx) =>
      prepay.topUpTx(tx, ctx, {
        settleAccountId: a.settleAccountId,
        channel: 'CASH',
        amount,
      } as never),
    );
    n++;
  });
  return n;
}

export async function executeBillingRun(
  h: Harness,
  ctx: TenantCtx,
  runId: string,
): Promise<string> {
  const billing = await services.billingRun(h);
  // TX_SELF_MANAGED — direct call, per D4
  const done = (await billing.execute(
    ctx,
    runId,
    ['DRAFT', 'PARTIAL'],
    REQ,
  )) as { status: string };
  return done.status;
}

// ---------------------------------------------------------------------------
// payments — A: full cash · B: partial cash + TOP_UP · C: TOP_UP→APPLY
// ---------------------------------------------------------------------------

const queryBills = async (
  h: Harness,
  ctx: TenantCtx,
  accountIds: string[],
): Promise<
  { id: string; water_account_id: string; total_amount: bigint; outstanding: bigint }[]
> =>
  h.tenantPrisma.runAsTenant(ctx.tenantId, async (tx) => {
    const t = tx as {
      $queryRaw<T>(q: unknown, ...a: unknown[]): Promise<T>;
    };
    const rows = await t.$queryRaw<
      {
        id: string;
        water_account_id: string;
        total_amount: string;
        outstanding: string;
      }[]
    >(
      Pr.Prisma.sql`SELECT b.id, b.water_account_id, b.total_amount,
            b.total_amount - COALESCE((
              SELECT sum(pa.amount) FROM payment_alloc pa
               WHERE pa.tenant_id = b.tenant_id AND pa.bill_id = b.id), 0)
              AS outstanding
            FROM bill b
            WHERE b.tenant_id = ${ctx.tenantId}::uuid
              AND b.water_account_id = ANY(${accountIds}::uuid[])
              AND b.status IN ('POSTED','PARTIAL_PAID')`,
    );
    // pg returns int8 as string — normalize to bigint for the services
    return rows.map((r) => ({
      id: r.id,
      water_account_id: r.water_account_id,
      total_amount: BigInt(r.total_amount),
      outstanding: BigInt(r.outstanding),
    }));
  });

export async function applyPayments(
  h: Harness,
  ctx: TenantCtx,
  accounts: GeneratedAccount[],
  concurrency: number,
): Promise<{ payments: number; topUps: number }> {
  const payment = await services.payment(h);
  const prepay = await services.prepayment(h);
  const byId = new Map(accounts.map((a) => [a.waterAccountId, a]));
  const bills = await queryBills(
    h,
    ctx,
    accounts.map((a) => a.waterAccountId),
  );
  const billsByAccount = new Map<string, typeof bills>();
  for (const b of bills) {
    const arr = billsByAccount.get(b.water_account_id) ?? [];
    arr.push(b);
    billsByAccount.set(b.water_account_id, arr);
  }
  let payments = 0;
  let topUps = 0;
  await mapLimit(accounts, concurrency, async (a) => {
    const owed = (billsByAccount.get(a.waterAccountId) ?? []).filter(
      (b) => b.outstanding > 0n,
    );
    if (!owed.length) return;
    // C: funded pre-post via TOP_UP lot — APPLY at bill post already
    // settled its debt; nothing further here (RC1 P1-1).
    if (a.plan.payProfile === 'C') return;
    if (a.plan.payProfile === 'B') {
      // partial cash on the oldest bill…
      const first = owed[0];
      const cashPart = first.outstanding > 1000n ? first.outstanding - 500n : first.outstanding;
      await withTenantTx(
        h,
        'PaymentService.createTx',
        ctx.tenantId,
        (tx) =>
          payment.createTx(tx, ctx, {
            settleAccountId: a.settleAccountId,
            channel: 'CASH',
            amount: cashPart,
            allocs: [{ billId: first.id, amount: cashPart }],
          } as never),
      );
      payments++;
      // …then TOP_UP covers the rest via debt-first split
      const rest = owed.reduce((s, b) => s + b.outstanding, 0n) - cashPart;
      if (rest > 0n) {
        await withTenantTx(
          h,
          'PrepaymentService.topUpTx',
          ctx.tenantId,
          (tx) =>
            prepay.topUpTx(tx, ctx, {
              settleAccountId: a.settleAccountId,
              channel: 'CASH',
              amount: rest,
            } as never),
        );
        topUps++;
      }
      return;
    }
    // A: one cash payment covering all outstanding bills
    const total = owed.reduce((s, b) => s + b.outstanding, 0n);
    await withTenantTx(h, 'PaymentService.createTx', ctx.tenantId, (tx) =>
      payment.createTx(tx, ctx, {
        settleAccountId: a.settleAccountId,
        channel: 'CASH',
        amount: total,
        allocs: owed.map((b) => ({ billId: b.id, amount: b.outstanding })),
      } as never),
    );
    payments++;
  });
  void byId;
  return { payments, topUps };
}

export async function closeDay(
  h: Harness,
  ctx: TenantCtx,
): Promise<void> {
  const dc = await services.dayClose(h);
  await withTenantTx(h, 'DayCloseService.closeTx', ctx.tenantId, (tx) =>
    dc.closeTx(tx, ctx, {} as never),
  );
}

// ---------------------------------------------------------------------------
// remote normal flow — source/device/binding + canonical ingest → CONVERTED
// ---------------------------------------------------------------------------

export interface RemoteInfra {
  sourceId: string;
  deviceByAccount: Map<string, { deviceId: string; vkey: string }>;
  accounts: GeneratedAccount[];
}

/** One-time remote infra — source + device + binding per remote account. */
export async function setupRemoteInfra(
  h: Harness,
  ctx: TenantCtx,
  seed: number,
  accounts: GeneratedAccount[],
): Promise<RemoteInfra | null> {
  const remoteAccounts = accounts.filter((a) => a.plan.remote);
  if (!remoteAccounts.length) return null;

  const src = await services.remoteSource(h);
  const dev = await services.remoteDevice(h);

  // one tenant-wide source (orgUnitId null requires ALL scope — pilot ctx is ALL)
  const source = (await withTenantTx(
    h,
    'RemoteSourceService.createTx',
    ctx.tenantId,
    (tx) =>
      src.createTx(tx, ctx, {
        code: `SRC-S${seed}`,
        name: 'Pilot 远传源',
        type: 'API_PULL',
        adapterKey: 'pilot-api',
        timezone: 'Asia/Shanghai',
        orgUnitId: null,
      } as never),
  )) as { id: string };

  const deviceByAccount = new Map<string, { deviceId: string; vkey: string }>();
  for (const a of remoteAccounts) {
    const vkey = keys.deviceNo(seed, a.plan.seq);
    const d = (await withTenantTx(
      h,
      'RemoteDeviceService.createDeviceTx',
      ctx.tenantId,
      (tx) =>
        dev.createDeviceTx(tx, ctx, {
          remoteSourceId: source.id,
          vendorDeviceKey: vkey,
        } as never),
    )) as { id: string };
    await withTenantTx(
      h,
      'RemoteDeviceService.createBindingTx',
      ctx.tenantId,
      (tx) =>
        dev.createBindingTx(tx, ctx, d.id, {
          installationId: a.installationId,
          effectiveFrom: a.installedAt.toISOString(),
          effectiveTo: null,
        } as never),
    );
    deviceByAccount.set(a.waterAccountId, { deviceId: d.id, vkey });
  }
  return { sourceId: source.id, deviceByAccount, accounts: remoteAccounts };
}

/** Per-period canonical event ingest → CONVERTED → QC pass. */
export async function ingestRemotePeriod(
  h: Harness,
  ctx: TenantCtx,
  seed: number,
  infra: RemoteInfra,
  period: string,
  periodIdx: number,
): Promise<{ events: number; converted: number; readingsQc: number }> {
  const evt = await services.remoteEvent(h);
  const reading = await services.reading(h);
  const canonical = await apiImport<{
    buildCanonicalPayload(e: {
      vendorDeviceKey: string;
      businessPeriod: string;
      collectedAt: Date;
      readingValue: string;
      vendorQuality?: string | null;
    }): { canonicalPayload: Record<string, unknown>; payloadHash: string };
  }>('modules/remote/canonical');

  const collectedAt = new Date(
    Date.UTC(+period.slice(0, 4), +period.slice(4) - 1, 15, 1, 0, 0),
  );
  const events = infra.accounts.map((a) => {
    const readingValue = a.plan.usage[periodIdx].toFixed(4);
    const base = {
      vendorDeviceKey: infra.deviceByAccount.get(a.waterAccountId)!.vkey,
      businessPeriod: period,
      collectedAt,
      readingValue,
    };
    const { canonicalPayload, payloadHash } =
      canonical.buildCanonicalPayload(base);
    return {
      externalEventKey: keys.externalEventKey(seed, a.plan.seq * 10 + periodIdx),
      ...base,
      vendorQuality: null,
      rawPayload: { ...base, collectedAt: collectedAt.toISOString() },
      canonicalPayload,
      payloadHash,
    };
  });
  // TX_SELF_MANAGED — direct call, never wrapped (D4)
  const outcomes = (await evt.ingestBatch(
    ctx,
    infra.sourceId,
    events as never,
  )) as { outcome: string; readingId?: string }[];
  const converted = outcomes.filter((o) => o.outcome === 'CONVERTED').length;

  // remote readings land qcStatus PENDING → pass them for settlement
  let readingsQc = 0;
  for (const o of outcomes) {
    if (o.outcome === 'CONVERTED' && o.readingId) {
      await withTenantTx(h, 'MeterReadingService.qcTx', ctx.tenantId, (tx) =>
        reading.qcTx(tx, ctx, o.readingId as string, 'pass', REQ),
      );
      readingsQc++;
    }
  }
  return { events: events.length, converted, readingsQc };
}

// ---------------------------------------------------------------------------
// ground truth — CLEAN_BACKGROUND entries
// ---------------------------------------------------------------------------

export const cleanEntry = (
  a: GeneratedAccount,
  seed: number,
): GroundTruthEntry => ({
  scenarioKey: `CLEAN_BACKGROUND:${String(a.plan.seq).padStart(6, '0')}`,
  injectionMethod: 'DOMAIN_FLOW',
  reachableInNormalOperation: true,
  businessKeys: {
    accountNo: a.accountNo,
    customerNo: keys.customerNo(seed, a.plan.tag, a.plan.seq),
    settleNo: keys.settleNo(seed, a.plan.tag, a.plan.seq),
    meterNo: keys.meterNo(seed, a.plan.seq),
    // real reading_book.book_no — joins GT to the DB row
    bookNo: a.bookNo ?? '',
    remote: String(a.plan.remote),
    payProfile: a.plan.payProfile,
  },
  entityIds: {
    customerId: a.customerId,
    settleAccountId: a.settleAccountId,
    waterAccountId: a.waterAccountId,
    meterId: a.meterId,
    installationId: a.installationId,
    ...(a.branchId ? { branchId: a.branchId } : {}),
    ...(a.bookId ? { bookId: a.bookId } : {}),
  },
  expected: {
    anomalies: [],
    orgOwnership: a.branchId ? [a.branchId] : [],
    financialEffect: null,
  },
});
