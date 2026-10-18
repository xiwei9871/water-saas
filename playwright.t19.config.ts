import { defineConfig } from '@playwright/test';

/**
 * T19 任务驱动机制部署验收 —— 针对 192.168.3.185:5185 上线版本的
 * 待办中心 UI 巡检与截图取证。演示数据由 task_demo 编排脚本预置。
 *
 * 运行：
 *   WATER_LOGIN_FILE=/tmp/t19-creds/credentials.json \
 *   T19_BASE_URL=http://192.168.3.185:5185 \
 *   pnpm exec playwright test --config playwright.t19.config.ts
 */
export default defineConfig({
  testDir: './tests/t19',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  outputDir: 'artifacts/t19/test-results',
  reporter: [['list'], ['html', { outputFolder: 'artifacts/t19/html-report', open: 'never' }]],
  use: {
    baseURL: process.env.T19_BASE_URL ?? 'http://192.168.3.185:5185',
    channel: 'chrome',
    launchOptions: { args: ['--no-proxy-server'] },
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    video: 'off',
    ignoreHTTPSErrors: true,
  },
});
