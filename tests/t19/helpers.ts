import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

export function creds() {
  const p = process.env.WATER_LOGIN_FILE;
  if (!p) throw new Error('WATER_LOGIN_FILE required');
  return JSON.parse(readFileSync(p, 'utf8')) as {
    admin: Record<string, { login: string; password: string }>;
  };
}

export async function loginUi(page: Page, tenant: string, who: string) {
  const c = creds().admin[who];
  await page.goto('/login');
  await page.getByLabel('租户代码').fill(tenant);
  await page.getByLabel('账号', { exact: true }).fill(c.login);
  await page.getByLabel('密码', { exact: true }).fill(c.password);
  await page.getByRole('button', { name: /登\s*录/ }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
}

export async function shot(page: Page, name: string) {
  await page.screenshot({ path: `artifacts/t19/${name}.png`, fullPage: false });
}
