/**
 * G3 orchestrator — clean-background generation through approved
 * domain flows only. Emits the frozen phase metrics, ground-truth
 * entries (expected.anomalies = []) and a read-only verification pass.
 */

import type { Harness, TenantCtx } from '../harness.ts';
import type { CliArgs } from '../cli.ts';
import type { GroundTruthEntry, PhaseRecord } from '../manifest.ts';
import {
  allocateAccounts,
  DEFAULT_ALLOCATION,
  listPeriods,
  periodStart,
  shiftPeriod,
} from './allocate.ts';
import { bootstrapTenant, type BootstrapResult } from './bootstrap.ts';
import {
  addMemberships,
  cleanEntry,
  closeDay,
  generateAccounts,
  generateBooks,
  generatePlans,
  ingestRemotePeriod,
  createBillingRun,
  executeBillingRun,
  preFundCAccounts,
  settleAccounts,
  setupRemoteInfra,
  submitManualReadings,
  applyPayments,
} from './flow.ts';
import { verifyBaseline, type ExpectedFact, type VerifyResult } from './verify.ts';
import { injectFaults } from '../fault/inject.ts';
import type { FaultProfile } from '../fault/plan.ts';
import { allocateFaults } from '../fault/plan.ts';

export interface BaselineResult {
  phases: PhaseRecord[];
  groundTruth: GroundTruthEntry[];
  verify: VerifyResult;
  bootstrap: BootstrapResult;
  stats: Record<string, number>;
  faultStats?: Record<string, number>;
}



/** accumulate per-period work into the frozen phase names. */
class PhaseSink {
  private acc = new Map<string, { startedAt: string; durationMs: number; rows: number }>();
  private order: string[] = [];

  async run<T>(name: string, fn: () => Promise<{ rows?: number; value: T } | T>): Promise<T> {
    const t0 = Date.now();
    const r = await fn();
    const { rows, value } =
      r !== null &&
      typeof r === 'object' &&
      ('value' in (r as object) || 'rows' in (r as object))
        ? (r as { rows?: number; value: T })
        : { rows: undefined, value: r as T };
    const cur = this.acc.get(name) ?? {
      startedAt: new Date(t0).toISOString(),
      durationMs: 0,
      rows: 0,
    };
    cur.durationMs += Date.now() - t0;
    cur.rows += rows ?? 0;
    if (!this.acc.has(name)) {
      this.acc.set(name, cur);
      this.order.push(name);
    }
    return value;
  }

  records(): PhaseRecord[] {
    return this.order.map((name) => {
      const a = this.acc.get(name)!;
      return {
        name,
        startedAt: a.startedAt,
        finishedAt: new Date(
          Date.parse(a.startedAt) + a.durationMs,
        ).toISOString(),
        durationMs: a.durationMs,
        rowsCreated: a.rows,
      };
    });
  }
}

export async function runBaseline(
  h: Harness,
  tenantCtx: TenantCtx,
  args: CliArgs,
  opts?: { periods?: string[]; asOf?: string; faultProfile?: FaultProfile },
): Promise<BaselineResult> {
  const sink = new PhaseSink();
  const seed = args.seed;
  // full profiles own the account budget: clean = total - scenario accounts
  const fp = opts?.faultProfile;
  const alloc = {
    ...DEFAULT_ALLOCATION,
    accounts: fp
      ? allocateFaults(fp, fp.branches).cleanAccounts ?? args.accounts
      : args.accounts,
    branches: fp?.branches ?? DEFAULT_ALLOCATION.branches,
    booksPerBranch: fp?.booksPerBranch ?? DEFAULT_ALLOCATION.booksPerBranch,
    remotePct: fp?.remoteRatio ?? DEFAULT_ALLOCATION.remotePct,
  };
  const periods = opts?.periods ?? listPeriods(args.periodFrom, args.periodTo);
  const plans = allocateAccounts(alloc);

  // --- bootstrap (INFRA_BOOTSTRAP + tariff domain flow) ---
  const boot = await sink.run('bootstrap', async () => {
    const b = await bootstrapTenant(h, tenantCtx, seed, alloc.branches);
    return { rows: b.entities.length, value: b };
  });
  const ctx: TenantCtx = { ...tenantCtx, staffId: boot.staffId };

  // --- accounts ---
  const installedAt = new Date(periodStart(periods[0]).getTime() - 7 * 86400e3);
  const accounts = await sink.run('accounts', async () => {
    const a = await generateAccounts(
      h, ctx, seed, plans, args.concurrency, installedAt,
    );
    return { rows: a.length, value: a };
  });

  // --- books + membership ---
  const books = await sink.run('book-membership', async () => {
    const bs = await generateBooks(
      h, ctx, seed, boot.branchIds, alloc.booksPerBranch,
    );
    const members = await addMemberships(
      h, ctx, bs, accounts, args.concurrency,
    );
    // carry branch/book identity onto accounts for GT orgOwnership
    for (const a of accounts) {
      const bk = bs[a.plan.bookIdx];
      a.bookId = bk.id;
      a.bookNo = bk.bookNo;
      a.branchId = bk.orgUnitId;
    }
    return { rows: bs.length + members, value: bs };
  });

  // remote infra once (source/device/binding) — counted in 'remote' phase
  const remoteInfra = await sink.run('remote', async () => {
    const r = await setupRemoteInfra(h, ctx, seed, accounts);
    return { rows: r ? 1 + r.accounts.length * 2 : 0, value: r };
  });

  // --- per-period loop: plans → readings (+remote) → settlement → billing → payment ---
  let actualReadings = 0;
  let remoteEvents = 0;
  let remoteConverted = 0;
  let remoteQc = 0;
  let payments = 0;
  let topUps = 0;
  let billsPosted = 0;

  for (let pi = 0; pi < periods.length; pi++) {
    const period = periods[pi];
    const bundles = await sink.run(`reading-period-${pi + 1}`, async () => {
      const b = await generatePlans(h, ctx, books, period);
      const manual = await submitManualReadings(h, ctx, b, accounts, period, pi);
      actualReadings += manual;
      const remote = remoteInfra
        ? await ingestRemotePeriod(h, ctx, seed, remoteInfra, period, pi)
        : { events: 0, converted: 0, readingsQc: 0 };
      remoteEvents += remote.events;
      remoteConverted += remote.converted;
      remoteQc += remote.readingsQc;
      return { rows: manual + remote.converted, value: b };
    });
    void bundles;

    await sink.run('settlement', async () => ({
      rows: await settleAccounts(h, ctx, accounts, period, args.concurrency),
    }));

    await sink.run('billing', async () => {
      const runId = await createBillingRun(h, ctx, period);
      // C: TOP_UP lot while bills are still DRAFT (not payable debt),
      // then execute posts + applyForPostedDebtTx writes APPLY rows
      const cTopUps = await preFundCAccounts(
        h, ctx, accounts, period, args.concurrency,
      );
      topUps += cTopUps;
      const status = await executeBillingRun(h, ctx, runId);
      if (status !== 'POSTED')
        throw new Error(`billing run ${runId} ended ${status}`);
      billsPosted += accounts.length;
      return { rows: accounts.length + cTopUps };
    });

    const pay = await sink.run('payment', async () => {
      const r = await applyPayments(h, ctx, accounts, args.concurrency);
      payments += r.payments;
      topUps += r.topUps;
      return { rows: r.payments + r.topUps };
    });
    void pay;
  }

  await sink.run('payment', async () => {
    await closeDay(h, ctx);
    return { rows: 1 };
  });

  // --- fault injection — AFTER clean baseline, BEFORE verify ---
  // --faults → legacy 15-scenario matrix; non-default profile → its
  // profile-driven scenario matrix (G6 full profile implies faults).
  let faultGt: GroundTruthEntry[] = [];
  let faultStats: Record<string, number> | undefined;
  let expectedAnomalies: ExpectedFact[] | undefined;
  let extraRemoteConverted = 0;
  if (args.faults || fp) {
    const fr = await sink.run('fault-inject', async () => {
      // faultPeriod: 3 months before asOf → its bill due date is already
      // past (periodEnd+45d < asOf) → real UNPAID_BILL_OVERDUE.
      const asOfMonth = (opts?.asOf ?? args.periodFrom).slice(0, 7).replace('-', '');
      const faultPeriod = shiftPeriod(asOfMonth, -3);
      const r = await injectFaults(
        h, ctx, seed, boot.branchIds, faultPeriod, periods[0],
        { concurrency: args.concurrency, profile: fp },
      );
      return { rows: r.stats.groundTruthEntries, value: r };
    });
    faultGt = fr.groundTruth;
    faultStats = fr.stats;
    expectedAnomalies = fr.expectedAnomalies;
    extraRemoteConverted = fr.stats.convertedRemote ?? 0;
  }

  // --- verification (read-only): baseline + expected-anomaly smoke ---
  const verify = await sink.run('baseline-verify', async () => ({
    value: await verifyBaseline(h, ctx, accounts, periods, {
      expectedAnomalies,
      extraRemoteConverted,
    }),
  }));

  const groundTruth = [
    ...accounts.map((a) => cleanEntry(a, seed)),
    ...faultGt,
  ];

  return {
    phases: sink.records(),
    groundTruth,
    verify,
    bootstrap: boot,
    stats: {
      accountsGenerated: accounts.length,
      periods: periods.length,
      branches: boot.branchIds.length,
      books: books.length,
      actualReadings,
      remoteEvents,
      remoteConverted,
      remoteQc,
      settlements: accounts.length * periods.length,
      billsPosted,
      payments,
      topUps,
    },
    faultStats,
  };
}
