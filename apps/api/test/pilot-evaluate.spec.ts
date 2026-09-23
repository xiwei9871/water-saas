/**
 * G5 evaluation unit tests — pure metric math, attribution, artifact
 * cross-checks. No DB.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attributeFP,
  computeDetection,
  detectorGate,
  EvalError,
  type DetectedFact,
  type ExpectedAnomaly,
  type GroundTruthContext,
} from '../../scripts/pilot/lib/evaluate/metrics.ts';
import { concurrentCreateResult } from '../../scripts/pilot/lib/evaluate/episodes.ts';
import { loadRun } from '../../scripts/pilot/lib/evaluate/artifacts.ts';

const exp = (
  key: string, type: string, scenarioKey = 'NO_BOOK:000000',
  anchor = 'ACCOUNT', orgOwnership: string[] = ['org1'],
): ExpectedAnomaly => ({
  key, type, anchor, orgOwnership, scenarioKey,
});

const ctx = (
  scenarioKey: string, entityIds: Record<string, string> = {},
): GroundTruthContext => ({ scenarioKey, entityIds });

const det = (
  key: string, type: string, anchor = 'ACCOUNT',
  coveringOrgs: string[] | null = ['org1'], waterAccountId?: string,
): DetectedFact => ({
  key, type, anchor, coveringOrgs, waterAccountId,
});

describe('detector metric math', () => {
  it('exact (key,type) matching → TP', () => {
    const r = computeDetection(
      [exp('k1', 'NO_BOOK'), exp('k2', 'MULTI_BOOK')],
      [det('k1', 'NO_BOOK'), det('k2', 'MULTI_BOOK')],
      [],
    );
    expect(r.overall).toMatchObject({ expected: 2, detected: 2, tp: 2, fp: 0, fn: 0 });
    expect(r.overall.precision).toBe(1);
    expect(r.overall.recall).toBe(1);
  });

  it('same key + wrong type is FN+FP, not TP', () => {
    const r = computeDetection(
      [exp('k1', 'NO_BOOK')],
      [det('k1', 'MULTI_BOOK')],
      [],
    );
    expect(r.overall.tp).toBe(0);
    expect(r.overall.fp).toBe(1);
    expect(r.overall.fn).toBe(1);
  });

  it('zero denominators → null, not 1', () => {
    const r = computeDetection([], [det('x', 'NO_BOOK')], []);
    expect(r.overall.recall).toBeNull(); // no expected → no recall
    expect(r.overall.precision).toBe(0); // 1 fp, 0 tp → 0/1
    const r2 = computeDetection([exp('k', 'NO_BOOK')], [], []);
    expect(r2.overall.precision).toBeNull(); // nothing detected
    expect(r2.overall.recall).toBe(0);
  });

  it('by-type rows carry their own denominators', () => {
    const r = computeDetection(
      [exp('a', 'NO_BOOK'), exp('b', 'NO_BOOK'), exp('c', 'MULTI_BOOK')],
      [det('a', 'NO_BOOK'), det('c', 'MULTI_BOOK')],
      [],
    );
    const nb = r.byType.find((t) => t.type === 'NO_BOOK')!;
    expect(nb).toMatchObject({ expected: 2, detected: 1, tp: 1, fp: 0, fn: 1 });
    expect(nb.recall).toBe(0.5);
  });

  it('duplicate expected pair → reject', () => {
    expect(() =>
      computeDetection([exp('k', 'NO_BOOK'), exp('k', 'NO_BOOK')], [], []),
    ).toThrow(EvalError);
  });
  it('duplicate detected pair → reject', () => {
    expect(() =>
      computeDetection([], [det('k', 'NO_BOOK'), det('k', 'NO_BOOK')], []),
    ).toThrow(EvalError);
  });
});

describe('FP attribution', () => {
  // real GT shape: clean entries carry entityIds but expected.anomalies
  // is EMPTY — attribution must use the context list, not expected.
  const contexts = [
    ctx('CLEAN_BACKGROUND:000001', { waterAccountId: 'wa-clean1' }),
    ctx('NO_BOOK:000000', { waterAccountId: 'wa-nbk' }),
  ];
  it('clean entry with anomalies=[] still attributes cleanBackgroundFP', () => {
    const r = computeDetection(
      [], // GT: one clean entry, zero expected anomalies
      [det('z', 'NO_BOOK', 'ACCOUNT', ['o'], 'wa-clean1')],
      contexts,
    );
    expect(r.overall.fp).toBe(1);
    expect(r.cleanBackgroundFP).toBe(1);
    expect(r.faultScenarioUnexpectedFP).toBe(0);
    expect(r.unattributedFP).toBe(0);
  });
  it('fault context attribution', () => {
    expect(
      attributeFP(det('z', 'MULTI_BOOK', 'ACCOUNT', ['o'], 'wa-nbk'), contexts),
    ).toMatchObject({ kind: 'FAULT', scenarioKey: 'NO_BOOK:000000' });
  });
  it('unattributed FP', () => {
    expect(attributeFP(det('z', 'NO_BOOK'), contexts).kind).toBe('UNATTRIBUTED');
  });
  it('anchorRef.id / remoteSourceId also match context entityIds', () => {
    const c = [ctx('REMOTE_EVENT_UNBOUND:000000', { remoteSourceId: 'rs-1' })];
    const fact: DetectedFact = {
      key: 'e', type: 'X', anchor: 'REMOTE_SOURCE', coveringOrgs: null,
      remoteSourceId: 'rs-1',
    };
    expect(attributeFP(fact, c).kind).toBe('FAULT');
  });
});

describe('anchor/ownership comparison', () => {
  it('anchor mismatch is reported', () => {
    const r = computeDetection(
      [exp('k', 'NO_BOOK', 'NO_BOOK:000000', 'TENANT', [])],
      [det('k', 'NO_BOOK', 'ACCOUNT', ['org1'])],
      [],
    );
    expect(r.anchorMismatches).toHaveLength(1);
  });
  it('ACCOUNT coveringOrgs set-equality', () => {
    const r = computeDetection(
      [exp('k', 'MULTI_BOOK', 'MULTI_BOOK:000000', 'ACCOUNT', ['o1', 'o2'])],
      [det('k', 'MULTI_BOOK', 'ACCOUNT', ['o2', 'o1'])],
      [],
    );
    expect(r.ownershipMismatches).toHaveLength(0);
    const r2 = computeDetection(
      [exp('k', 'MULTI_BOOK', 'MULTI_BOOK:000000', 'ACCOUNT', ['o1', 'o2'])],
      [det('k', 'MULTI_BOOK', 'ACCOUNT', ['o1'])],
      [],
    );
    expect(r2.ownershipMismatches).toHaveLength(1);
  });
  it('TENANT/REMOTE_SOURCE never fabricate ACCOUNT ownership', () => {
    const r = computeDetection(
      [exp('k', 'NO_BOOK', 'NO_BOOK:000000', 'TENANT', [])],
      [det('k', 'NO_BOOK', 'TENANT', null)],
      [],
    );
    expect(r.ownershipMismatches).toHaveLength(0);
    expect(r.anchorMismatches).toHaveLength(0);
  });
});

describe('detector gate (fail closed)', () => {
  const clean = computeDetection([exp('k', 'NO_BOOK')], [det('k', 'NO_BOOK')], []);
  it('exact match + gateEligible → PASS', () => {
    expect(detectorGate(clean, true)).toEqual({ pass: true, outcome: 'PASS' });
  });
  it('FP → HOLD, not PASS', () => {
    const r = computeDetection([], [det('z', 'NO_BOOK')], []);
    expect(detectorGate(r, true)).toEqual({ pass: false, outcome: 'HOLD' });
  });
  it('FN → HOLD', () => {
    const r = computeDetection([exp('k', 'NO_BOOK')], [], []);
    expect(detectorGate(r, true).outcome).toBe('HOLD');
  });
  it('anchor mismatch → HOLD', () => {
    const r = computeDetection(
      [exp('k', 'NO_BOOK', 'NO_BOOK:000000', 'TENANT', [])],
      [det('k', 'NO_BOOK', 'ACCOUNT', ['o'])],
      [],
    );
    expect(detectorGate(r, true).outcome).toBe('HOLD');
  });
  it('clockDrift (gateEligible=false) → HARDENING-ONLY even when exact', () => {
    expect(detectorGate(clean, false)).toEqual({ pass: false, outcome: 'HARDENING-ONLY' });
  });
});

describe('concurrent-create race assertions', () => {
  const base = {
    oldEpisodeId: 'old-1',
    factActive: true,
    activeBefore: 0,
    rejectedCalls: 0,
    activeIds: ['new-9'],
  };
  it('one new active episode distinct from old → pass', () => {
    const r = concurrentCreateResult(base);
    expect(r.pass).toBe(true);
    expect(r.newEpisodeId).toBe('new-9');
  });
  it('rejects: fact not active / pre-existing active / rejection / dup / reopened old id', () => {
    expect(concurrentCreateResult({ ...base, factActive: false }).pass).toBe(false);
    expect(concurrentCreateResult({ ...base, activeBefore: 1 }).pass).toBe(false);
    expect(concurrentCreateResult({ ...base, rejectedCalls: 1 }).pass).toBe(false);
    expect(concurrentCreateResult({ ...base, activeIds: ['a', 'b'] }).pass).toBe(false);
    // old episode reopened instead of a new row → fail
    expect(concurrentCreateResult({ ...base, activeIds: ['old-1'] }).pass).toBe(false);
    expect(concurrentCreateResult({ ...base, activeIds: [] }).pass).toBe(false);
  });
});

describe('artifact cross-checks', () => {
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
  const write = (gt: object, sum: object) => {
    dir = mkdtempSync(join(tmpdir(), 'eval-'));
    writeFileSync(join(dir, 'ground-truth.json'), JSON.stringify(gt));
    writeFileSync(join(dir, 'generation-summary.json'), JSON.stringify(sum));
    return dir;
  };
  const baseGt = { runId: 'r1', seed: 42, entries: [] };
  const baseSum = {
    runId: 'r1', seed: 42, clockDrift: false, errors: [] as string[],
    tenant: { id: 't-1', code: 'PILOT-0042' },
  };
  it('runId mismatch → reject', async () => {
    write({ ...baseGt, runId: 'r2' }, baseSum);
    await expect(loadRun(dir)).rejects.toThrow(EvalError);
  });
  it('seed mismatch → reject', async () => {
    write(baseGt, { ...baseSum, seed: 43 });
    await expect(loadRun(dir)).rejects.toThrow(EvalError);
  });
  it('clockDrift → gateEligible=false', async () => {
    write(baseGt, { ...baseSum, clockDrift: true });
    const r = await loadRun(dir);
    expect(r.gateEligible).toBe(false);
  });
  it('summary.errors non-empty → reject (fail closed)', async () => {
    write(baseGt, { ...baseSum, errors: ['phase X failed'] });
    await expect(loadRun(dir)).rejects.toThrow(EvalError);
  });
  it('warnings do not block loading', async () => {
    write(baseGt, { ...baseSum, warnings: ['soft note'] });
    await expect(loadRun(dir)).resolves.toMatchObject({ runId: 'r1' });
  });
});
