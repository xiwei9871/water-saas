/**
 * Pilot Cycle 1A — synthetic generator. G2 infrastructure + G3
 * clean-background baseline domain flows. Fault injection (G4) and
 * evaluation (G5) are NOT implemented here.
 *
 * Usage — runs under plain `node` (type-stripping) against the COMPILED
 * api (apps/api/dist): tsx/esbuild does not emit design:paramtypes, so
 * Nest DI only works on the tsc build. Run `pnpm --filter api build`
 * first; cwd must be apps/api so node_modules resolves:
 *   cd apps/api && node ../../scripts/pilot/generate.ts \
 *     --create-tenant --seed 42 --period-from 202607 [--reset --yes]
 */

import { join } from 'node:path';
import { CliError, isResetDryRun, parseArgs, USAGE } from './lib/cli.ts';
import { assertPilotEnvironment, DbGuardError } from './lib/db-guard.ts';
import { connect } from './lib/pg.ts';
import {
  createPilotTenant,
  executeReset,
  planReset,
  requireMarkedTenant,
  TenantGuardError,
} from './lib/pilot-tenant.ts';
import { loadPilotClock } from './lib/clock.ts';
import { bootHarness, pilotCtx } from './lib/harness.ts';
import { runBaseline, type BaselineResult } from './lib/baseline/index.ts';
import {
  gitSha,
  ManifestWriter,
  newRunId,
  type GenerationSummary,
  type PhaseRecord,
} from './lib/manifest.ts';

const fatal = (e: unknown): never => {
  const msg =
    e instanceof CliError || e instanceof DbGuardError || e instanceof TenantGuardError
      ? e.message
      : e instanceof Error
        ? (e.stack ?? e.message)
        : String(e);
  console.error(`ABORT: ${msg}`);
  process.exit(1);
};

const phase = async <T>(
  phases: PhaseRecord[],
  name: string,
  fn: () => Promise<T> | T,
): Promise<T> => {
  const startedAt = new Date();
  const out = await fn();
  const finishedAt = new Date();
  phases.push({
    name,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    rowsCreated: 0,
  });
  return out;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }

  // P0 — DB guard BEFORE any connection or write. --yes cannot bypass.
  const db = assertPilotEnvironment(process.env);

  const phases: PhaseRecord[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const runId = newRunId(args.seed);

  // owner conn for guard/reset/clock (RLS bypass; pilot DB only)
  const owner = await connect({
    connectionString:
      process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL,
  });
  let tenant: Awaited<ReturnType<typeof requireMarkedTenant>>;
  let clock: Awaited<ReturnType<typeof loadPilotClock>>;
  let baseline: BaselineResult | undefined;
  try {
    tenant = await phase(phases, 'tenant-guard', () =>
      args.createTenant
        ? createPilotTenant(owner, args.seed)
        : requireMarkedTenant(owner, args.tenantId!),
    );
    console.log(`tenant: ${tenant.code} (${tenant.id})`);

    clock = await phase(phases, 'clock', () =>
      loadPilotClock(owner, args.asOf),
    );
    if (clock.clockDrift) {
      warnings.push(
        `clockDrift: asOf=${clock.asOf} != databaseCurrentDate=${clock.databaseCurrentDate} — NOT ELIGIBLE FOR PILOT GATE EVIDENCE`,
      );
      console.warn(`WARN: ${warnings[warnings.length - 1]}`);
    }

    if (args.reset) {
      const plan = await phase(phases, 'reset-plan', () =>
        planReset(owner, tenant.id),
      );
      console.log(
        `reset plan: db=${db.migration.host}/${db.migration.name} tenant=${tenant.code} — ` +
          `${plan.tableCounts.length} tables, ${plan.totalRows} rows` +
          (plan.tableCounts.length
            ? ` (${plan.tableCounts.map((t) => `${t.table}=${t.rows}`).join(', ')})`
            : ''),
      );
      if (isResetDryRun(args)) {
        // P1-2: unconfirmed reset → print plan, exit successfully.
        // Invariant for G3+: no generation after an unconfirmed reset.
        // Owner conn still closes via `finally`; nothing else runs.
        console.log(
          'reset: --yes not given — plan printed, nothing deleted. EXITING.',
        );
        return;
      }
      const r = await phase(phases, 'reset-exec', () =>
        executeReset(owner, tenant.id),
      );
      console.log(
        `reset: deleted ${r.deletedRows} rows, residual scan = 0 rows`,
      );
    }

    // Nest harness → G3 baseline domain flows → close. No HTTP listener.
    const h = await phase(phases, 'harness', () => bootHarness());
    try {
      baseline = await runBaseline(h, pilotCtx(tenant.id, ''), args, {
        asOf: clock.asOf,
      });
      phases.push(...baseline.phases);
    } finally {
      await h.close();
    }
    const v = baseline.verify;
    console.log(
      `baseline: ${baseline.stats.accountsGenerated} accts, ` +
        `${baseline.stats.actualReadings} actual + ${baseline.stats.remoteConverted} remote readings, ` +
        `${baseline.stats.settlements} settlements, ${baseline.stats.billsPosted} bills, ` +
        `${baseline.stats.payments} payments + ${baseline.stats.topUps} top-ups`,
    );
    console.log(
      `verify: checks ${v.checks.filter((c) => c.pass).length}/${v.checks.length} pass, ` +
        `financial=${v.financial.pass ? 'PASS' : 'FAIL'} ` +
        `(bill=${v.financial.billTotal} pay=${v.financial.paymentAllocTotal} ` +
        `prepay=${v.financial.prepaymentAllocTotal} topUp=${v.financial.topUpLedgerTotal} ` +
        `apply=${v.financial.applyLedgerTotal} net=${v.financial.ledgerNet} ` +
        `open=${v.financial.openBills}) ` +
        `unexpected anomalies=${v.unexpectedAnomalies.length} → ${v.pass ? 'PASS' : 'HOLD'}`,
    );
    if (!v.pass) {
      errors.push(
        `baseline-verify failed: ${v.checks
          .filter((c) => !c.pass)
          .map((c) => `${c.name} ${c.actual}!=${c.expected}`)
          .join('; ')} | anomalies=${v.unexpectedAnomalies.length}`,
      );
    }
  } finally {
    await owner.end();
  }

  const writer = new ManifestWriter(join(args.outputDir, runId));
  await writer.init();
  await writer.writeGroundTruth({
    runId,
    seed: args.seed,
    entries: baseline?.groundTruth ?? [],
  });
  const summary: GenerationSummary = {
    runId,
    gitSha: gitSha(),
    seed: args.seed,
    profile: args.profile,
    requestedAccounts: args.accounts,
    periodFrom: args.periodFrom,
    periodTo: args.periodTo,
    concurrency: args.concurrency,
    asOf: clock.asOf,
    databaseCurrentDate: clock.databaseCurrentDate,
    generatedAt: clock.generatedAt,
    clockDrift: clock.clockDrift,
    database: { host: db.runtime.host, name: db.runtime.name },
    tenant: { id: tenant.id, code: tenant.code },
    phases,
    warnings,
    errors,
  };
  await writer.writeSummary(summary);
  if (baseline) {
    console.log(
      `unexpected E9 anomalies: ${baseline.verify.unexpectedAnomalies.length} — ` +
        `G3 ${baseline.verify.pass ? 'PASS' : 'HOLD'}`,
    );
  }
  console.log(`manifest dir: ${writer.runDir}`);
}

main().catch(fatal);
