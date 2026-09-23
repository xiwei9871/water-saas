/**
 * G5 artifact loading + cross-checks. GT and summary must agree and
 * must bind to the marked pilot tenant in the pilot DB.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GroundTruthFile, GenerationSummary } from '../manifest.ts';
import { EvalError } from './metrics.ts';

export interface LoadedRun {
  runId: string;
  seed: number;
  tenantId: string;
  gt: GroundTruthFile;
  summary: GenerationSummary;
  /** false → HARDENING-ONLY, no PASS allowed. */
  gateEligible: boolean;
}

export async function loadRun(runDir: string): Promise<LoadedRun> {
  const gt = JSON.parse(
    await readFile(join(runDir, 'ground-truth.json'), 'utf8'),
  ) as GroundTruthFile;
  const summary = JSON.parse(
    await readFile(join(runDir, 'generation-summary.json'), 'utf8'),
  ) as GenerationSummary;

  if (gt.runId !== summary.runId)
    throw new EvalError(`runId mismatch: gt=${gt.runId} summary=${summary.runId}`);
  if (gt.seed !== summary.seed)
    throw new EvalError(`seed mismatch: gt=${gt.seed} summary=${summary.seed}`);
  // fail closed — a run the generator itself flagged with errors is
  // never G5 gate evidence. warnings do not block; clockDrift keeps its
  // own gateEligible=false path.
  if (summary.errors.length > 0)
    throw new EvalError(
      `summary.errors non-empty (${summary.errors.length}): ${summary.errors[0]}`,
    );
  return {
    runId: gt.runId,
    seed: gt.seed,
    tenantId: summary.tenant.id,
    gt,
    summary,
    gateEligible: !summary.clockDrift,
  };
}
