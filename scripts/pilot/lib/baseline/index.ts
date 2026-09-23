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
  runBilling,
  settleAccounts,
  setupRemoteInfra,
  submitManualReadings,
  applyPayments,
} from './flow.ts';
import { verifyBaseline, type VerifyResult } from './verify.ts';

export interface BaselineResult {
  phases: PhaseRecord[];
  groundTruth: GroundTruthEntry[];
  verify: VerifyResult;
  bootstrap: BootstrapResult;
  stats: Record<string, number>;
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
  periodsArg?: string[],
): Promise<BaselineResult> {
  const sink = new PhaseSink();
  const seed = args.seed;
  const alloc = { ...DEFAULT_ALLOCATION, accounts: args.accounts };
  const periods = periodsArg ?? listPeriods(args.periodFrom, args.periodTo);
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
      const run = await runBilling(h, ctx, period);
      // run lifecycle ends at POSTED (all billed) — PARTIAL/FAILED abort
      if (run.status !== 'POSTED')
        throw new Error(`billing run ${run.runId} ended ${run.status}`);
      billsPosted += accounts.length;
      return { rows: accounts.length };
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

  // --- baseline verification (read-only) ---
  const verify = await sink.run('baseline-verify', async () => ({
    value: await verifyBaseline(h, ctx, accounts, periods),
  }));

  const groundTruth = accounts.map((a) =>
    cleanEntry(a, seed, `BK-${String(a.plan.bookIdx).padStart(3, '0')}`),
  );

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
  };
}
