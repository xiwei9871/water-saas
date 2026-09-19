import { test, expect } from './helpers/console';
import { login, ready } from './helpers/auth';
import { routes } from './helpers/routes';
import { dimensions } from './helpers/ui';
for (const [id, path, title] of routes) test(`${id} K01 smoke ${path}`, async ({ page }, info) => {
  await login(page); await page.goto(path); await ready(page);
  await expect.soft(page.getByRole('main').getByText(title, { exact: true }).first()).toBeVisible();
  const size = await dimensions(page);
  await info.attach('layout', { body: JSON.stringify(size), contentType: 'application/json' });
  expect(size.scrollWidth, 'No body horizontal overflow at 1440').toBeLessThanOrEqual(size.width + 2);
});
test('K07 explicit empty list state', async ({ page }) => {
  await login(page); await page.goto('/customer/customers'); await ready(page);
  await page.getByPlaceholder('按名称搜索').fill('UAT-NONEXISTENT-EMPTY');
  await page.getByPlaceholder('按名称搜索').press('Enter');
  await expect(page.getByRole('cell').filter({ hasText: /暂无数据|No data/ })).toBeVisible();
});
