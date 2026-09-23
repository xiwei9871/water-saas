/**
 * G6 operator-pilot sampler — draws N active episodes per anomaly type
 * from work_item (populated by evaluate.ts --episodes refresh) and
 * writes the operator-observations.json skeleton the human operator
 * fills in while working the Exception Center UI.
 *
 * This script does NOT drive the UI — the pilot is a human exercise.
 *
 *   cd apps/api && node ../../scripts/pilot/operator-sample.ts \
 *     --run artifacts/pilot/<run-id> [--per-type 5]
 */

import { join } from 'node:path';
import { assertPilotEnvironment, DbGuardError } from './lib/db-guard.ts';
import { connect } from './lib/pg.ts';
import { requireMarkedTenant } from './lib/pilot-tenant.ts';
import { loadRun } from './lib/evaluate/artifacts.ts';
import { EvalError } from './lib/evaluate/metrics.ts';
import { writeJsonAtomic } from './lib/manifest.ts';

const fatal = (e: unknown): never => {
  console.error(
    `ABORT: ${e instanceof EvalError || e instanceof DbGuardError ? e.message : e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
  );
  process.exit(1);
};

const args = process.argv.slice(2);
const get = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const runDir = get('--run');
const perType = parseInt(get('--per-type') ?? '5', 10);
if (!runDir) fatal(new EvalError('--run <dir> is required'));
if (!Number.isInteger(perType) || perType < 1)
  fatal(new EvalError('--per-type must be a positive int'));

interface EpisodeRow {
  id: string;
  anomaly_key: string;
  anomaly_type: string;
  status: string;
}

async function main(): Promise<void> {
  assertPilotEnvironment(process.env);
  const run = await loadRun(runDir!);
  const owner = await connect({
    connectionString:
      process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL,
  });
  try {
    const tenant = await requireMarkedTenant(owner, run.tenantId);
    if (tenant.id !== run.summary.tenant.id)
      throw new EvalError(`tenant mismatch: ${tenant.id} != ${run.summary.tenant.id}`);

    const episodes = await owner.query<EpisodeRow>(
      `SELECT id::text, anomaly_key, anomaly_type, status
         FROM work_item
        WHERE tenant_id=$1 AND cleared_at IS NULL AND status='OPEN'
        ORDER BY anomaly_type, anomaly_key`,
      [tenant.id],
    );

    // deterministic sample: first N per type (ordered by anomaly_key)
    const byType = new Map<string, EpisodeRow[]>();
    for (const e of episodes.rows) {
      const arr = byType.get(e.anomaly_type) ?? [];
      arr.push(e);
      byType.set(e.anomaly_type, arr);
    }
    const sampled: EpisodeRow[] = [];
    for (const [, rows] of [...byType.entries()].sort()) {
      sampled.push(...rows.slice(0, perType));
    }
    if (!sampled.length)
      throw new EvalError(
        'no OPEN episodes — run evaluate.ts --episodes first so refresh() populates work_item',
      );

    const artifact = {
      runId: run.runId,
      tenantId: run.tenantId,
      sampledAt: new Date().toISOString(),
      perType,
      instructions:
        'Human operator works each episode in the Exception Center UI. ' +
        'Fill operatorLabel (anonymous), startedAt/finishedAt (ISO), the ' +
        'boolean fields, actions[] (ACK/ASSIGN/IGNORE/REPAIR/RESOLVE…), ' +
        'outcome, and free-text notes. Do NOT edit anomalyKey/episodeId.',
      episodes: sampled.map((e) => ({
        episodeId: e.id,
        anomalyKey: e.anomaly_key,
        anomalyType: e.anomaly_type,
        operatorLabel: '',
        startedAt: '',
        finishedAt: '',
        understoodWithoutHelp: null,
        correctObjectIdentified: null,
        correctOrgIdentified: null,
        actions: [] as string[],
        outcome: '',
        neededExtraNavigation: null,
        neededExternalVerification: null,
        operatorNote: '',
        reviewerNote: '',
      })),
    };
    const file = join(runDir!, 'operator-observations.json');
    await writeJsonAtomic(file, artifact);

    // worksheet for the operator
    console.log(`sampled ${sampled.length} episodes across ${byType.size} types → ${file}`);
    for (const [type, rows] of [...byType.entries()].sort()) {
      const n = Math.min(perType, rows.length);
      console.log(`  ${type}: ${n}/${rows.length} sampled`);
    }
    console.log('\nworksheet:');
    for (const e of sampled) console.log(`  ${e.anomaly_type}  ${e.anomaly_key}  ep=${e.id}`);
  } finally {
    await owner.end();
  }
}

main().catch(fatal);
