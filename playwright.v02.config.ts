import { defineConfig } from '@playwright/test';

// Fixture helpers read UAT_DATABASE_NAME at module load — pin the dedicated
// v0.2 database here so workers inherit it.
process.env.UAT_DATABASE_NAME = 'water_uat_v02';

/** v0.2 UAT — dedicated water_uat_v02 database, five vertical slices against
 * the real UI (no mocks). Chromium → 127.0.0.1:4173 → /api proxy → :3000. */
export default defineConfig({
  testDir: './tests/uat-v02',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 8_000 },
  outputDir: 'artifacts/uat-v02/test-results',
  reporter: [
    ['list'],
    ['html', { outputFolder: 'artifacts/uat-v02/html-report', open: 'never' }],
  ],
  use: {
    actionTimeout: 12_000,
    navigationTimeout: 20_000,
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1440, height: 900 },
    timezoneId: 'Asia/Shanghai',
    locale: 'zh-CN',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium', channel: 'chrome' } }],
});
