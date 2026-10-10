import { defineConfig } from '@playwright/test';

/**
 * E10 批次部署验证 —— 针对已部署 Pilot（vite preview :5185 → api :3000 →
 * water_pilot_v012）的 UI 级功能巡检。区别于 tests/pilot（v0.1.2 冻结
 * 业务流），本套件只验证第 1–5 批新功能页面与关键交互，可重复执行，
 * 产生的写入均为可撤销的测试记录（核销登记会撤销、字典项会停用）。
 *
 * 运行：
 *   WATER_LOGIN_FILE=~/.config/water-saas/credentials.json \
 *     pnpm exec playwright test --config playwright.e10.config.ts
 */
export default defineConfig({
  testDir: './tests/e10',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  outputDir: 'artifacts/e10/test-results',
  reporter: [
    ['list'],
    ['html', { outputFolder: 'artifacts/e10/html-report', open: 'never' }],
    ['json', { outputFile: 'artifacts/e10/results.json' }],
  ],
  use: {
    baseURL: process.env.E10_BASE_URL ?? 'http://127.0.0.1:5185',
    channel: 'chrome',
    launchOptions: { args: ['--no-proxy-server'] },
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    actionTimeout: 15_000,
    navigationTimeout: 25_000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
