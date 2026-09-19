import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/uat',
  fullyParallel: false,
  workers: 1,
  retries: 1,
  timeout: 60_000,
  expect: { timeout: 8_000 },
  outputDir: 'artifacts/uat/test-results',
  reporter: [
    ['list'],
    ['html', { outputFolder: 'artifacts/uat/html-report', open: 'never' }],
    ['json', { outputFile: 'artifacts/uat/results.json' }],
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
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
