import { defineConfig } from '@playwright/test';
import { runId, runDir } from './tests/system-flow/helpers/state';

/**
 * Cycle 1A Operational Flow Gate — real-browser J1–J8 journeys against
 * the dedicated watersaas_system_flow database. The historical pilot
 * suite (tests/pilot, playwright.pilot.config.ts) is FROZEN v0.1.2
 * evidence and must not be repurposed; this config is independent.
 *
 * Environment: production web build on :4173 → /api proxy → API :3000
 * started with DATABASE_URL=postgresql://ws_app:ws_app_pw@localhost:5432/watersaas_system_flow
 *
 * Reset between runs: tests/system-flow/scripts/reset-db.sh
 */
export default defineConfig({
  testDir: './tests/system-flow',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 1_800_000,
  expect: { timeout: 10_000 },
  outputDir: `${runDir}/test-results`,
  reporter: [
    ['list'],
    ['html', { outputFolder: `${runDir}/html-report`, open: 'never' }],
    ['json', { outputFile: `${runDir}/results.json` }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    channel: 'chrome',
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    actionTimeout: 15_000,
    navigationTimeout: 25_000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  metadata: {
    runId,
    gate: 'cycle-1a-operational-flow',
    database: 'watersaas_system_flow',
  },
});
