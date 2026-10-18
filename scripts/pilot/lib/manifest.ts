/**
 * Ground-truth + generation-summary writers. Atomic: write .tmp then
 * rename — a mid-write crash never leaves a half manifest.
 * Ground truth never enters the product schema.
 */

import { mkdir, rename, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// frozen shapes (PILOT_CYCLE_1.md §3)
// ---------------------------------------------------------------------------

export type Anchor = 'TENANT' | 'ACCOUNT' | 'REMOTE_SOURCE';
export type InjectionMethod = 'DOMAIN_FLOW' | 'CONTROLLED_DB_MUTATION';

export interface AnomalyExpectation {
  type: string;
  /** full anomaly key e.g. wa:<uuid>:NO_BOOK — same-run entity id. */
  key: string;
  anchor: Anchor;
  lifecycle: ('active' | 'cleared')[];
}

export interface GroundTruthEntry {
  scenarioKey: string;
  injectionMethod: InjectionMethod;
  reachableInNormalOperation: boolean;
  businessKeys: Record<string, string>;
  entityIds: Record<string, string>;
  expected: {
    anomalies: AnomalyExpectation[];
    orgOwnership: string[];
    financialEffect: unknown;
  };
}

export interface GroundTruthFile {
  runId: string;
  seed: number;
  entries: GroundTruthEntry[];
}

export interface PhaseRecord {
  name: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  rowsCreated: number;
}

export interface GenerationSummary {
  runId: string;
  gitSha: string;
  seed: number;
  profile: string;
  requestedAccounts: number;
  periodFrom: string;
  periodTo: string;
  concurrency: number;
  asOf: string;
  databaseCurrentDate: string;
  generatedAt: string;
  clockDrift: boolean;
  /** G6 perf evidence — wall time tenant-guard → manifest write. */
  totalDurationMs?: number;
  database: { host: string; name: string };
  tenant: { id: string; code: string };
  phases: PhaseRecord[];
  warnings: string[];
  errors: string[];
}

// ---------------------------------------------------------------------------
// atomic write
// ---------------------------------------------------------------------------

export async function writeJsonAtomic(
  filePath: string,
  data: unknown,
): Promise<void> {
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await rename(tmp, filePath);
}

export class ManifestWriter {
  readonly runDir: string;
  constructor(runDir: string) {
    this.runDir = runDir;
  }

  async init(): Promise<void> {
    await mkdir(this.runDir, { recursive: true });
  }

  async writeGroundTruth(gt: GroundTruthFile): Promise<string> {
    const p = join(this.runDir, 'ground-truth.json');
    await writeJsonAtomic(p, gt);
    return p;
  }

  async writeSummary(s: GenerationSummary): Promise<string> {
    const p = join(this.runDir, 'generation-summary.json');
    await writeJsonAtomic(p, s);
    return p;
  }
}

export const gitSha = (): string => {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
};

export const newRunId = (seed: number): string =>
  `run-s${seed}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
