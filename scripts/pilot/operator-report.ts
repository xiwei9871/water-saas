/**
 * G6 operator-pilot report — reads a filled operator-observations.json
 * and computes the pilot evidence metrics (NOT frozen KPIs — Cycle 1A
 * evidence only). Writes operator-report.json into the same run dir.
 *
 *   cd apps/api && node ../../scripts/pilot/operator-report.ts \
 *     --run artifacts/pilot/<run-id>
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EvalError } from './lib/evaluate/metrics.ts';
import { writeJsonAtomic } from './lib/manifest.ts';

const fatal = (e: unknown): never => {
  console.error(`ABORT: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
};

const args = process.argv.slice(2);
const i = args.indexOf('--run');
const runDir = i >= 0 ? args[i + 1] : undefined;
if (!runDir) fatal(new EvalError('--run <dir> is required'));

interface Observation {
  episodeId: string;
  anomalyKey: string;
  anomalyType: string;
  operatorLabel: string;
  startedAt: string;
  finishedAt: string;
  understoodWithoutHelp: boolean | null;
  correctObjectIdentified: boolean | null;
  correctOrgIdentified: boolean | null;
  actions: string[];
  outcome: string;
  neededExtraNavigation: boolean | null;
  neededExternalVerification: boolean | null;
  operatorNote: string;
  reviewerNote: string;
}

const pct = (n: number, d: number) => (d === 0 ? null : +(n / d).toFixed(4));

async function main(): Promise<void> {
  const obs = JSON.parse(
    await readFile(join(runDir!, 'operator-observations.json'), 'utf8'),
  ) as { runId: string; tenantId: string; episodes: Observation[] };
  const eps = obs.episodes;

  const done = eps.filter((e) => e.finishedAt);
  const mins = done
    .map((e) => (Date.parse(e.finishedAt) - Date.parse(e.startedAt)) / 60000)
    .filter((x) => Number.isFinite(x) && x >= 0)
    .sort((a, b) => a - b);
  const med = mins.length ? mins[Math.floor(mins.length / 2)] : null;
  const p90 = mins.length ? mins[Math.min(mins.length - 1, Math.ceil(mins.length * 0.9) - 1)] : null;

  const count = (f: (e: Observation) => boolean | null) =>
    done.filter((e) => f(e) === true).length;
  const actions: Record<string, number> = {};
  for (const e of done) for (const a of e.actions) actions[a] = (actions[a] ?? 0) + 1;

  const confusion = done.filter(
    (e) =>
      e.understoodWithoutHelp === false ||
      e.neededExtraNavigation === true ||
      e.neededExternalVerification === true,
  ).length;

  const report = {
    runId: obs.runId,
    tenantId: obs.tenantId,
    generatedAt: new Date().toISOString(),
    note: 'Cycle 1A pilot evidence — NOT frozen product KPIs; no target thresholds set',
    episodesSampled: eps.length,
    episodesCompleted: done.length,
    completionRate: pct(done.length, eps.length),
    correctUnderstandingRate: pct(count((e) => e.understoodWithoutHelp), done.length),
    correctObjectRate: pct(count((e) => e.correctObjectIdentified), done.length),
    correctOwnershipRate: pct(count((e) => e.correctOrgIdentified), done.length),
    actionDistribution: actions,
    medianHandlingMinutes: med === null ? null : +med.toFixed(1),
    p90HandlingMinutes: p90 === null ? null : +p90.toFixed(1),
    neededExternalVerification: count((e) => e.neededExternalVerification),
    operatorConfusionCount: confusion,
    byType: Object.fromEntries(
      [...new Set(eps.map((e) => e.anomalyType))].sort().map((t) => {
        const rows = done.filter((e) => e.anomalyType === t);
        return [
          t,
          {
            sampled: eps.filter((e) => e.anomalyType === t).length,
            completed: rows.length,
            correctUnderstanding: rows.filter((e) => e.understoodWithoutHelp === true).length,
            correctOrg: rows.filter((e) => e.correctOrgIdentified === true).length,
          },
        ];
      }),
    ),
  };
  const file = join(runDir!, 'operator-report.json');
  await writeJsonAtomic(file, report);
  console.log(`operator report → ${file}`);
  console.log(
    `  episodes ${report.episodesCompleted}/${report.episodesSampled} ` +
      `understanding=${report.correctUnderstandingRate} ` +
      `object=${report.correctObjectRate} org=${report.correctOwnershipRate} ` +
      `median=${report.medianHandlingMinutes}m p90=${report.p90HandlingMinutes}m ` +
      `confusion=${report.operatorConfusionCount}`,
  );
}

main().catch(fatal);
