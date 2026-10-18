#!/usr/bin/env node
/**
 * Cycle 1A — journey-summary.json generator.
 * Reads Playwright results.json + network.json audit record from
 * artifacts/system-flow/<runId>/ and emits the gate summary.
 * Usage: SF_RUN_ID=sfA node tests/system-flow/scripts/journey-summary.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const runId = process.env.SF_RUN_ID || 'sf-local';
const runDir = resolve('artifacts/system-flow', runId);
const results = JSON.parse(readFileSync(resolve(runDir, 'results.json'), 'utf8'));

const JOURNEYS = {
  '00-setup.spec.ts': 'S0',
  '01-onboarding.spec.ts': 'J1',
  '02-readings.spec.ts': 'J2',
  '03-settlement-billing.spec.ts': 'J3',
  '04-payment.spec.ts': 'J4',
  '05-reversal-dayclose.spec.ts': 'J5',
  '06-meter-lifecycle.spec.ts': 'J6',
  '07-exceptions.spec.ts': 'J7',
  '08-360-scope-reports.spec.ts': 'J8',
};

const summary = {
  runId,
  generatedAt: new Date().toISOString(),
  journeys: {},
  unexpected5xx: 0,
  consoleErrors: 0,
  pageErrors: 0,
  unexpectedHttpErrors: 0,
  p0: [], p1: [], p2: [],
  verdict: 'PASS',
};

const walk = (suites, file) => {
  for (const suite of suites ?? []) {
    const f = (suite.file ?? file)?.split('/').pop();
    for (const spec of suite.specs ?? []) {
      const j = JOURNEYS[f];
      if (!j) continue;
      const ok = spec.ok ?? spec.tests.every((t) =>
        t.results.some((r) => r.status === 'passed'));
      summary.journeys[j] = ok ? 'PASS' : 'FAIL';
      if (!ok) summary.p0.push(`${j}: ${spec.title} failed`);
    }
    walk(suite.suites, f);
  }
};
walk(results.suites, undefined);

if (existsSync(resolve(runDir, 'network.json'))) {
  const net = JSON.parse(readFileSync(resolve(runDir, 'network.json'), 'utf8'));
  for (const run of net) {
    for (const ev of run.unexpected ?? []) {
      if (ev.kind === 'CONSOLE_ERROR') summary.consoleErrors++;
      else if (ev.kind === 'PAGE_ERROR') summary.pageErrors++;
      else if (ev.status >= 500) summary.unexpected5xx++;
      else summary.unexpectedHttpErrors++;
    }
  }
}
if (summary.consoleErrors || summary.pageErrors || summary.unexpected5xx) {
  summary.p1.push('unexpected browser events — see network.json');
}
const all = Object.values(summary.journeys);
if (all.length < 9 || all.some((v) => v !== 'PASS') ||
    summary.unexpected5xx || summary.pageErrors || summary.consoleErrors ||
    summary.unexpectedHttpErrors) {
  summary.verdict = 'HOLD';
}
writeFileSync(resolve(runDir, 'journey-summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary.journeys));
console.log(`verdict=${summary.verdict} 5xx=${summary.unexpected5xx} console=${summary.consoleErrors} page=${summary.pageErrors} http=${summary.unexpectedHttpErrors}`);
