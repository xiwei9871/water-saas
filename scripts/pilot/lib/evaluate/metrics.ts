/**
 * G5 detector evaluation — PURE metric math. Truth = Ground Truth file,
 * never WorkItems. Comparison unit is the frozen (key, type) pair.
 */

export class EvalError extends Error {}

export interface ExpectedAnomaly {
  key: string;
  type: string;
  anchor: string;
  orgOwnership: string[];
  scenarioKey: string;
  /** entity ids of the owning GT entry — used for FP attribution. */
  entityIds: Record<string, string>;
}

export interface DetectedFact {
  key: string;
  type: string;
  anchor: string;
  coveringOrgs: string[] | null;
  waterAccountId?: string;
  remoteSourceId?: string;
  anchorRef?: { kind: string; id: string };
}

export interface TypeMetric {
  type: string;
  expected: number;
  detected: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number | null;
  recall: number | null;
}

export interface Attribution {
  scenarioKey: string | null; // null = UNATTRIBUTED
  kind: 'CLEAN_BACKGROUND' | 'FAULT' | 'UNATTRIBUTED';
}

const assertNoDup = (pairs: { key: string; type: string }[], side: string) => {
  const seen = new Set<string>();
  for (const p of pairs) {
    const id = `${p.key}|${p.type}`;
    if (seen.has(id)) {
      throw new EvalError(`duplicate ${side} pair: ${p.key} (${p.type})`);
    }
    seen.add(id);
  }
};

const ratio = (num: number, den: number): number | null =>
  den === 0 ? null : num / den;

/** FP attribution: match the fact's ids against every GT entry's
 *  entityIds. CLEAN_BACKGROUND hit → generator-noise FP; fault-scenario
 *  hit → unexpected co-anomaly; nothing → unattributed. */
export function attributeFP(
  fact: DetectedFact,
  expected: ExpectedAnomaly[],
): Attribution {
  const ids = new Set(
    [fact.waterAccountId, fact.remoteSourceId, fact.anchorRef?.id].filter(
      (x): x is string => !!x,
    ),
  );
  for (const e of expected) {
    if (Object.values(e.entityIds).some((id) => ids.has(id))) {
      return {
        scenarioKey: e.scenarioKey,
        kind: e.scenarioKey.startsWith('CLEAN_BACKGROUND')
          ? 'CLEAN_BACKGROUND'
          : 'FAULT',
      };
    }
  }
  return { scenarioKey: null, kind: 'UNATTRIBUTED' };
}

export interface DetectionReport {
  overall: {
    expected: number;
    detected: number;
    tp: number;
    fp: number;
    fn: number;
    precision: number | null;
    recall: number | null;
  };
  byType: TypeMetric[];
  falsePositives: { key: string; type: string; attribution: Attribution }[];
  falseNegatives: { key: string; type: string; scenarioKey: string }[];
  anchorMismatches: { key: string; expected: string; actual: string }[];
  ownershipMismatches: { key: string; expected: string[]; actual: string[] }[];
  cleanBackgroundFP: number;
  faultScenarioUnexpectedFP: number;
  unattributedFP: number;
}

export function computeDetection(
  expected: ExpectedAnomaly[],
  detected: DetectedFact[],
): DetectionReport {
  assertNoDup(expected, 'expected');
  assertNoDup(detected, 'detected');

  const expPairs = new Map(expected.map((e) => [`${e.key}|${e.type}`, e]));
  const detPairs = new Map(detected.map((d) => [`${d.key}|${d.type}`, d]));

  const falseNegatives = expected
    .filter((e) => !detPairs.has(`${e.key}|${e.type}`))
    .map((e) => ({ key: e.key, type: e.type, scenarioKey: e.scenarioKey }));
  const falsePositives = detected
    .filter((d) => !expPairs.has(`${d.key}|${d.type}`))
    .map((d) => ({ key: d.key, type: d.type, attribution: attributeFP(d, expected) }));

  const anchorMismatches: DetectionReport['anchorMismatches'] = [];
  const ownershipMismatches: DetectionReport['ownershipMismatches'] = [];
  const sorted = (a: string[]) => [...a].sort();
  for (const e of expected) {
    const d = detPairs.get(`${e.key}|${e.type}`);
    if (!d) continue;
    if (d.anchor !== e.anchor) {
      anchorMismatches.push({ key: e.key, expected: e.anchor, actual: d.anchor });
    }
    // ownership comparison is meaningful only for ACCOUNT anchors —
    // TENANT/REMOTE_SOURCE facts never carry account ownership.
    if (e.anchor === 'ACCOUNT' && d.anchor === 'ACCOUNT') {
      const exp = sorted(e.orgOwnership);
      const act = sorted(d.coveringOrgs ?? []);
      if (exp.join(',') !== act.join(',')) {
        ownershipMismatches.push({ key: e.key, expected: exp, actual: act });
      }
    }
  }

  const tp = expected.length - falseNegatives.length;
  const fp = falsePositives.length;
  const fn = falseNegatives.length;

  const types = [...new Set([...expected.map((e) => e.type), ...detected.map((d) => d.type)])].sort();
  const byType: TypeMetric[] = types.map((type) => {
    const e = expected.filter((x) => x.type === type).length;
    const d = detected.filter((x) => x.type === type).length;
    const t = expected.filter(
      (x) => x.type === type && detPairs.has(`${x.key}|${x.type}`),
    ).length;
    const f = d - t;
    const n = e - t;
    return {
      type, expected: e, detected: d, tp: t, fp: f, fn: n,
      precision: ratio(t, t + f), recall: ratio(t, t + n),
    };
  });

  return {
    overall: {
      expected: expected.length,
      detected: detected.length,
      tp, fp, fn,
      precision: ratio(tp, tp + fp),
      recall: ratio(tp, tp + fn),
    },
    byType,
    falsePositives,
    falseNegatives,
    anchorMismatches,
    ownershipMismatches,
    cleanBackgroundFP: falsePositives.filter((x) => x.attribution.kind === 'CLEAN_BACKGROUND').length,
    faultScenarioUnexpectedFP: falsePositives.filter((x) => x.attribution.kind === 'FAULT').length,
    unattributedFP: falsePositives.filter((x) => x.attribution.kind === 'UNATTRIBUTED').length,
  };
}
