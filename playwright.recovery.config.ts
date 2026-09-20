import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/recovery', workers: 1, retries: 0, timeout: 90_000,
  outputDir: 'artifacts/pilot/recovery/test-results',
  reporter: [['list'], ['html', { outputFolder: 'artifacts/pilot/recovery/html-report', open: 'never' }],
    ['json', { outputFile: 'artifacts/pilot/recovery/results.json' }]],
  use: { baseURL: 'http://127.0.0.1:4173', channel: 'chrome', locale: 'zh-CN',
    viewport: { width: 1440, height: 900 }, screenshot: 'only-on-failure',
    trace: 'retain-on-failure', video: 'retain-on-failure' },
});
