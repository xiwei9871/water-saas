/**
 * Pilot Cycle 1A — synthetic generator. G2 SKELETON ONLY:
 * CLI + DB/tenant guards + reset + Nest harness + key factory +
 * PilotClock + manifest writers. Baseline flows (G3), fault injection
 * (G4) and evaluation (G5) are NOT implemented here.
 *
 * Usage (must run from apps/api so tsconfig + node_modules resolve):
 *   pnpm --filter api exec tsx ../../scripts/pilot/generate.ts \
 *     --create-tenant --seed 42 --period-from 202607 [--reset --yes]
 */

import { join } from 'node:path';
import { CliError, parseArgs, USAGE } from './lib/cli.js';
import { assertPilotEnvironment, DbGuardError } from './lib/db-guard.js';
import { connect } from './lib/pg.js';
import {
  createPilotTenant,
  executeReset,
  planReset,
  requireMarkedTenant,
  TenantGuardError,
} from './lib/pilot-tenant.js';
import { loadPilotClock } from './lib/clock.js';
import { bootHarness } from './lib/harness.js';
import {
  gitSha,
  ManifestWriter,
  newRunId,
  type GenerationSummary,
  type PhaseRecord,
} from './lib/manifest.js';

const fatal = (e: unknown): never => {
  const msg =
    e instanceof CliError || e instanceof DbGuardError || e instanceof TenantGuardError
      ? e.message
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
      if (!args.yes) {
        console.log('reset: --yes not given — plan printed, nothing deleted');
      } else {
        const r = await phase(phases, 'reset-exec', () =>
          executeReset(owner, tenant.id),
        );
        console.log(
          `reset: deleted ${r.deletedRows} rows, residual scan = 0 rows`,
        );
      }
    }

    // Nest harness smoke — boots without HTTP listener, always closes.
    await phase(phases, 'harness', async () => {
      const h = await bootHarness();
      await h.close();
    });
    console.log('harness: application context booted and closed');
  } finally {
    await owner.end();
  }

  const writer = new ManifestWriter(join(args.outputDir, runId));
  await writer.init();
  await writer.writeGroundTruth({
    runId,
    seed: args.seed,
    entries: [], // G2 skeleton — scenarios land in G4
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
  console.log('NOTE: G2 skeleton — no baseline/fault data generated');
  console.log(`manifest dir: ${writer.runDir}`);
}

main().catch(fatal);
