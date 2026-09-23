/**
 * Pilot G5 — detector + episode evaluation against a generated run's
 * artifacts. Detector truth is the Ground Truth file, NEVER WorkItems.
 *
 *   cd apps/api && node ../../scripts/pilot/evaluate.ts \
 *     --run artifacts/pilot/<run-id> [--episodes]
 *
 * Order is frozen: detector snapshot → detector-evaluation.json →
 * episode mutations → episode-evaluation.json. Episode writes never
 * feed back into detector metrics.
 */

import { join } from 'node:path';
import { assertPilotEnvironment, DbGuardError } from './lib/db-guard.ts';
import { apiRequire, connect } from './lib/pg.ts';
import { requireMarkedTenant } from './lib/pilot-tenant.ts';
import { bootHarness, pilotCtx } from './lib/harness.ts';
import { apiImport } from './lib/api-import.ts';
import { loadRun } from './lib/evaluate/artifacts.ts';
import {
  computeDetection,
  EvalError,
  type DetectedFact,
  type ExpectedAnomaly,
} from './lib/evaluate/metrics.ts';
import { evaluateEpisodes } from './lib/evaluate/episodes.ts';
import { writeJsonAtomic } from './lib/manifest.ts';

const fatal = (e: unknown): never => {
  console.error(
    `ABORT: ${e instanceof EvalError || e instanceof DbGuardError ? e.message : e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
  );
  process.exit(1);
};

interface EvalArgs {
  runDir: string;
  episodes: boolean;
  help: boolean;
}

const parseArgs = (argv: string[]): EvalArgs => {
  const a: EvalArgs = { runDir: '', episodes: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--run') a.runDir = argv[++i];
    else if (argv[i] === '--episodes') a.episodes = true;
    else if (argv[i] === '--help' || argv[i] === '-h') a.help = true;
    else throw new EvalError(`unknown flag: ${argv[i]}`);
  }
  if (!a.help && !a.runDir) throw new EvalError('--run <dir> is required');
  return a;
};

type Tx = { $queryRaw<T>(q: unknown, ...a: unknown[]): Promise<T> };

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('evaluate.ts --run <artifacts/pilot/<run-id>> [--episodes]');
    return;
  }

  // G2 guard — same safety envelope as generation.
  assertPilotEnvironment(process.env);
  const run = await loadRun(args.runDir);

  const owner = await connect({
    connectionString:
      process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL,
  });
  try {
    const tenant = await requireMarkedTenant(owner, run.tenantId);
    if (tenant.id !== run.summary.tenant.id)
      throw new EvalError(
        `tenant mismatch: artifact=${run.summary.tenant.id} db=${tenant.id}`,
      );

    const h = await bootHarness();
    try {
      // pilot admin staff for ctx (episode writes record created_by)
      const Pr = apiRequire('@prisma/client') as typeof import('@prisma/client');
      const staff = await h.tenantPrisma.runAsTenant(run.tenantId, (tx) =>
        (tx as Tx).$queryRaw<{ id: string }[]>(
          Pr.Prisma.sql`SELECT id::text FROM staff WHERE tenant_id=${run.tenantId}::uuid LIMIT 1`,
        ),
      );
      const ctx = pilotCtx(run.tenantId, staff[0]?.id ?? '');

      // ---- A. detector snapshot (read-only) ----
      const det = await apiImport<{
        detectAll(tx: Tx, tenantId: string): Promise<DetectedFact[]>;
      }>('modules/exception/detectors');
      const scope = await apiImport<{
        resolveAnchors(
          tx: Tx, tenantId: string, facts: DetectedFact[],
        ): Promise<DetectedFact[]>;
      }>('modules/exception/scope');
      const anchored = await h.tenantPrisma.runAsTenant(run.tenantId, async (tx) =>
        scope.resolveAnchors(
          tx as Tx,
          run.tenantId,
          await det.detectAll(tx as Tx, run.tenantId),
        ),
      );

      const expected: ExpectedAnomaly[] = run.gt.entries.flatMap((e) =>
        e.expected.anomalies.map((a) => ({
          key: a.key,
          type: a.type,
          anchor: a.anchor,
          orgOwnership: e.expected.orgOwnership,
          scenarioKey: e.scenarioKey,
          entityIds: e.entityIds,
        })),
      );

      const report = computeDetection(expected, anchored);
      const detectorArtifact = {
        runId: run.runId,
        tenantId: run.tenantId,
        seed: run.seed,
        evaluatedAt: new Date().toISOString(),
        overall: report.overall,
        byType: report.byType,
        anchorMismatch: report.anchorMismatches,
        ownershipMismatch: report.ownershipMismatches,
        falsePositives: report.falsePositives,
        falseNegatives: report.falseNegatives,
        cleanBackgroundFP: report.cleanBackgroundFP,
        faultScenarioUnexpectedFP: report.faultScenarioUnexpectedFP,
        unattributedFP: report.unattributedFP,
        gateEligible: run.gateEligible,
        pass:
          run.gateEligible &&
          report.overall.fp === 0 &&
          report.overall.fn === 0 &&
          report.anchorMismatches.length === 0 &&
          report.ownershipMismatches.length === 0,
      };
      await writeJsonAtomic(
        join(args.runDir, 'detector-evaluation.json'),
        detectorArtifact,
      );
      const o = report.overall;
      console.log(
        `detector: expected=${o.expected} detected=${o.detected} ` +
          `TP=${o.tp} FP=${o.fp} FN=${o.fn} ` +
          `precision=${o.precision ?? 'N/A'} recall=${o.recall ?? 'N/A'} ` +
          `anchorMM=${report.anchorMismatches.length} ownMM=${report.ownershipMismatches.length} ` +
          `→ ${detectorArtifact.pass ? 'PASS' : run.gateEligible ? 'HOLD' : 'HARDENING-ONLY (clockDrift)'}`,
      );

      // ---- B. episode lifecycle (mutates facts — detector metrics
      //    are already frozen in the artifact above) ----
      if (args.episodes) {
        const ep = await evaluateEpisodes(h, ctx, run.seed, run.gt.entries);
        await writeJsonAtomic(
          join(args.runDir, 'episode-evaluation.json'),
          {
            runId: run.runId,
            tenantId: run.tenantId,
            evaluatedAt: new Date().toISOString(),
            ...ep,
          },
        );
        console.log(
          `episodes: initial=${ep.initialOpen} idem=${ep.idempotentRefresh.created}/${ep.idempotentRefresh.resolved}/${ep.idempotentRefresh.cleared} ` +
            `dup=${ep.duplicateActiveKeys} guard=${ep.activeResolveRejected} ` +
            `→ ${ep.pass ? 'PASS' : 'FAIL'}`,
        );
        for (const n of ep.notes) console.log(`  ${n}`);
      }
    } finally {
      await h.close();
    }
  } finally {
    await owner.end();
  }
}

main().catch(fatal);
