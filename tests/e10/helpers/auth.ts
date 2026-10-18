import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

export interface PilotCredentials {
  url: string;
  lanUrl: string;
  release: string;
  database: string;
  admin: Record<string, { login: string; password: string }>;
}

export function loadCredentials(): PilotCredentials {
  const p = process.env.WATER_LOGIN_FILE;
  if (!p) throw new Error('WATER_LOGIN_FILE must point at the pilot credentials JSON');
  return JSON.parse(readFileSync(p, 'utf8')) as PilotCredentials;
}

/** UI 登录（走真实表单），成功后落在工作台。返回所用租户代码。 */
export async function loginAsAdmin(page: Page, tenant?: string): Promise<string> {
  const creds = loadCredentials();
  const code = tenant ?? Object.keys(creds.admin)[0];
  await page.goto('/login');
  await page.getByLabel('租户代码').fill(code);
  await page.getByLabel('账号', { exact: true }).fill(creds.admin[code].login);
  await page.getByLabel('密码', { exact: true }).fill(creds.admin[code].password);
  await page.getByRole('button', { name: /登\s*录/ }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
  return code;
}

/**
 * 收集页面运行期错误的监听器 —— console error / pageerror / 4xx+ 响应。
 * 返回收集数组（调用方在页操作后断言为空，白名单可先过滤）。
 */
export function watchErrors(page: Page): { errors: string[] } {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 500) errors.push(`http ${r.status()}: ${r.url()}`);
  });
  return { errors };
}
