import { expect, type Page } from '@playwright/test';
export async function login(page: Page, account = 'admin', password = 'admin123') {
  await page.goto('/login');
  await page.getByLabel('租户代码').fill('cd-water');
  await page.getByLabel('账号', { exact: true }).fill(account);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登 录' }).click();
  await expect(page.getByRole('banner')).toContainText('cd-water');
}
export async function ready(page: Page) {
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('main')).toBeVisible();
}
