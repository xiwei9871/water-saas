import { defineConfig } from '@playwright/test';

// Fixture helpers read UAT_DATABASE_NAME at module load — pin the dedicated
// E5 UAT database here so workers inherit it.
process.env.UAT_DATABASE_NAME = 'water_uat_e5';

/** E5 Remote Reading V1 UAT — dedicated water_uat_e5 database, vertical
 * slices against the real UI (no mocks). Chromium → 127.0.0.1:4173 → /api
 * proxy → :3000. */
export default defineConfig({
  testDir: './tests/uat-e5',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 8_000 },
  outputDir: 'artifacts/uat-e5/test-results',
  reporter: [
    ['list'],
    ['html', { outputFolder: 'artifacts/uat-e5/html-report', open: 'never' }],
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
