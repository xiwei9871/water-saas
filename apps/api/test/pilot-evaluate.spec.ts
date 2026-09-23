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
  EvalError,
  type DetectedFact,
  type ExpectedAnomaly,
} from '../../scripts/pilot/lib/evaluate/metrics.ts';
import { loadRun } from '../../scripts/pilot/lib/evaluate/artifacts.ts';

const exp = (
  key: string, type: string, scenarioKey = 'NO_BOOK:000000',
  anchor = 'ACCOUNT', orgOwnership: string[] = ['org1'],
): ExpectedAnomaly => ({
  key, type, anchor, orgOwnership, scenarioKey,
  entityIds: { waterAccountId: `wa-${key}` },
});

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
    );
    expect(r.overall).toMatchObject({ expected: 2, detected: 2, tp: 2, fp: 0, fn: 0 });
    expect(r.overall.precision).toBe(1);
    expect(r.overall.recall).toBe(1);
  });

  it('same key + wrong type is FN+FP, not TP', () => {
    const r = computeDetection(
      [exp('k1', 'NO_BOOK')],
      [det('k1', 'MULTI_BOOK')],
    );
    expect(r.overall.tp).toBe(0);
    expect(r.overall.fp).toBe(1);
    expect(r.overall.fn).toBe(1);
  });

  it('zero denominators → null, not 1', () => {
    const r = computeDetection([], [det('x', 'NO_BOOK')]);
    expect(r.overall.recall).toBeNull(); // no expected → no recall
    expect(r.overall.precision).toBe(0); // 1 fp, 0 tp → 0/1
    const r2 = computeDetection([exp('k', 'NO_BOOK')], []);
    expect(r2.overall.precision).toBeNull(); // nothing detected
    expect(r2.overall.recall).toBe(0);
  });

  it('by-type rows carry their own denominators', () => {
    const r = computeDetection(
      [exp('a', 'NO_BOOK'), exp('b', 'NO_BOOK'), exp('c', 'MULTI_BOOK')],
      [det('a', 'NO_BOOK'), det('c', 'MULTI_BOOK')],
    );
    const nb = r.byType.find((t) => t.type === 'NO_BOOK')!;
    expect(nb).toMatchObject({ expected: 2, detected: 1, tp: 1, fp: 0, fn: 1 });
    expect(nb.recall).toBe(0.5);
  });

  it('duplicate expected pair → reject', () => {
    expect(() =>
      computeDetection([exp('k', 'NO_BOOK'), exp('k', 'NO_BOOK')], []),
    ).toThrow(EvalError);
  });
  it('duplicate detected pair → reject', () => {
    expect(() =>
      computeDetection([], [det('k', 'NO_BOOK'), det('k', 'NO_BOOK')]),
    ).toThrow(EvalError);
  });
});

describe('FP attribution', () => {
  const expected = [
    exp('cleanK', 'X', 'CLEAN_BACKGROUND:000001'),
    exp('faultK', 'Y', 'NO_BOOK:000000'),
  ];
  it('clean-background hit', () => {
    expect(attributeFP(det('z', 'NO_BOOK', 'ACCOUNT', ['o'], 'wa-cleanK'), expected).kind)
      .toBe('CLEAN_BACKGROUND');
  });
  it('fault-scenario hit', () => {
    expect(attributeFP(det('z', 'NO_BOOK', 'ACCOUNT', ['o'], 'wa-faultK'), expected).kind)
      .toBe('FAULT');
  });
  it('unattributed', () => {
    expect(attributeFP(det('z', 'NO_BOOK'), expected).kind).toBe('UNATTRIBUTED');
  });
});

describe('anchor/ownership comparison', () => {
  it('anchor mismatch is reported', () => {
    const r = computeDetection(
      [exp('k', 'NO_BOOK', 'NO_BOOK:000000', 'TENANT', [])],
      [det('k', 'NO_BOOK', 'ACCOUNT', ['org1'])],
    );
    expect(r.anchorMismatches).toHaveLength(1);
  });
  it('ACCOUNT coveringOrgs set-equality', () => {
    const r = computeDetection(
      [exp('k', 'MULTI_BOOK', 'MULTI_BOOK:000000', 'ACCOUNT', ['o1', 'o2'])],
      [det('k', 'MULTI_BOOK', 'ACCOUNT', ['o2', 'o1'])],
    );
    expect(r.ownershipMismatches).toHaveLength(0);
    const r2 = computeDetection(
      [exp('k', 'MULTI_BOOK', 'MULTI_BOOK:000000', 'ACCOUNT', ['o1', 'o2'])],
      [det('k', 'MULTI_BOOK', 'ACCOUNT', ['o1'])],
    );
    expect(r2.ownershipMismatches).toHaveLength(1);
  });
  it('TENANT/REMOTE_SOURCE never fabricate ACCOUNT ownership', () => {
    const r = computeDetection(
      [exp('k', 'NO_BOOK', 'NO_BOOK:000000', 'TENANT', [])],
      [det('k', 'NO_BOOK', 'TENANT', null)],
    );
    expect(r.ownershipMismatches).toHaveLength(0);
    expect(r.anchorMismatches).toHaveLength(0);
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
    runId: 'r1', seed: 42, clockDrift: false,
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
});
