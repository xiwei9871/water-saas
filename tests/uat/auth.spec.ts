import { test, expect } from './helpers/console';
import { login, ready } from './helpers/auth';
test('A01 protected deep link retains destination after UI login', async ({ page }) => {
  await page.goto('/customer/onboard');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('租户代码').fill('cd-water');
  await page.getByLabel('账号', { exact: true }).fill('admin');
  await page.getByLabel('密码', { exact: true }).fill('admin123');
  await page.getByRole('button', { name: '登 录' }).click();
  await expect(page).toHaveURL(/\/customer\/onboard$/);
});
for (const [label, message] of [['租户代码', '请输入租户代码'], ['账号', '请输入账号'], ['密码', '请输入密码']]) {
  test(`A02 missing ${label} gives Chinese validation`, async ({ page }) => {
    await page.goto('/login');
    for (const [field, value] of [['租户代码', 'cd-water'], ['账号', 'admin'], ['密码', 'admin123']])
      if (field !== label) await page.getByLabel(field, { exact: true }).fill(value);
    await page.getByRole('button', { name: '登 录' }).click();
    await expect(page.getByText(message, { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });
}
test('A03 K02 incorrect password gives Chinese error without stack', async ({ page, audit }) => {
  audit.allow('/api/auth/login', 401);
  await page.goto('/login');
  await page.getByLabel('租户代码').fill('cd-water');
  await page.getByLabel('账号', { exact: true }).fill('admin');
  await page.getByLabel('密码', { exact: true }).fill('incorrect');
  await page.getByRole('button', { name: '登 录' }).click();
  await expect(page.getByRole('alert')).toContainText(/账号|密码|登录|认证/);
  await expect(page.getByRole('alert')).not.toContainText(/Error:| at |prisma|SELECT/i);
});
test('A04 A05 A06 login header, restore and logout', async ({ page }) => {
  await login(page);
  await expect(page).toHaveURL('http://127.0.0.1:4173/');
  await expect(page.getByRole('banner')).toContainText('管理员');
  await page.reload(); await ready(page);
  await expect(page.getByRole('banner')).toContainText('管理员');
  await page.getByRole('button', { name: '退出' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/system/staff');
  await expect(page).toHaveURL(/\/login$/);
});
