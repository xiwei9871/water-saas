import { test, expect } from './helpers/console';
import { login, ready } from './helpers/auth';
import { main, select, button } from './helpers/ui';
import type { Page } from '@playwright/test';

const RUN = Date.now().toString(36);

async function api(page: Page, method: 'GET' | 'POST', path: string, data?: unknown) {
  const token = await page.evaluate(() => localStorage.getItem('water-saas.accessToken'));
  const res = await page.request.fetch(`/api${path}`, {
    method,
    data,
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.ok(), `${method} ${path} -> ${res.status()}`).toBeTruthy();
  return res.json();
}

test.describe('RC1 usability fixes', () => {
  test('F1 客户新建后出现在第一页并高亮', async ({ page }) => {
    await login(page);
    await page.goto('/customer/customers');
    await ready(page);
    await main(page).getByRole('button', { name: '新增客户' }).click();
    const name = `RC1客户-${RUN}`;
    await page.getByLabel('客户名称').fill(name);
    await select(page, page.getByLabel('客户类型'), '个人');
    await button(page.getByRole('dialog'), '保存').click();
    await expect(main(page).locator('tr', { hasText: name }).first()).toBeVisible({ timeout: 15_000 });
    await expect(main(page).locator('tr.ws-row-highlight', { hasText: name })).toBeVisible();
  });

  test('F3/F4 用水户统一搜索 + 当前表号 + 枚举中文', async ({ page }) => {
    await login(page);
    const cust = `RC1户主-${RUN}`;
    const acc = await api(page, 'POST', '/water-accounts/onboard', {
      customer: { name: cust, custType: 'PERSONAL' },
      account: { usageCategory: 'RES_METERED', addr: `RC1测试路${RUN}号` },
      meter: { brand: 'rc1-brand', caliber: 'DN15' },
      installation: { initialReading: 0 },
    });
    const meterNo = acc.meter.meterNo;
    const accountNo = acc.waterAccount.accountNo;

    await page.goto('/customer/water-accounts');
    await ready(page);
    // 统一搜索框按客户名命中
    await main(page).getByPlaceholder(/搜/).fill(cust);
    await main(page).getByPlaceholder(/搜/).press('Enter');
    const row = main(page).locator('tr', { hasText: accountNo });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText('居民户表');
    await expect(row).toContainText(meterNo);
    await expect(row).not.toContainText('RES_METERED');
    // 按表号也能搜到同一户
    await main(page).getByPlaceholder(/搜/).fill(meterNo);
    await main(page).getByPlaceholder(/搜/).press('Enter');
    await expect(main(page).locator('tr', { hasText: accountNo })).toBeVisible({ timeout: 15_000 });
  });

  test('F12 收费台选中唯一用水户客户后自动选户', async ({ page }) => {
    await login(page);
    const cust = `RC1单户-${RUN}`;
    const acc = await api(page, 'POST', '/water-accounts/onboard', {
      customer: { name: cust, custType: 'PERSONAL' },
      account: { usageCategory: 'RES_METERED', addr: `RC1单户路${RUN}` },
      meter: { brand: 'rc1', caliber: 'DN15' },
      installation: { initialReading: 0 },
    });
    await page.goto('/payment/counter');
    await ready(page);
    await select(
      page,
      main(page).getByText('先选客户', { exact: true }),
      `${cust}（${acc.customer.customerNo}）`,
    );
    // 客户只有一个用水户 → 自动选择，无需第二次点击
    const accountBox = main(page).locator('.ant-select', { hasText: acc.waterAccount.accountNo });
    await expect(accountBox.first()).toBeVisible({ timeout: 15_000 });
  });

  test('F7 预存管理导航与页面', async ({ page }) => {
    await login(page);
    await page.goto('/');
    await ready(page);
    await page.locator('.ant-menu-submenu-title', { hasText: '收费管理' }).click();
    await expect(page.getByRole('menuitem', { name: '预存管理' })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('menuitem', { name: '预存管理' }).click();
    await ready(page);
    await expect(main(page).locator('.ant-card-head-title', { hasText: '预存管理' })).toBeVisible();
  });

  test('F2 申报人口弹窗语义（当前值/变更/生效账期）', async ({ page }) => {
    await login(page);
    const cust = `RC1人口-${RUN}`;
    const acc = await api(page, 'POST', '/water-accounts/onboard', {
      customer: { name: cust, custType: 'PERSONAL' },
      account: { usageCategory: 'RES_METERED', addr: `RC1人口路${RUN}`, householdSize: 3 },
      meter: { brand: 'rc1', caliber: 'DN15' },
      installation: { initialReading: 0 },
    });
    await page.goto('/customer/water-accounts');
    await ready(page);
    await main(page).getByPlaceholder(/搜/).fill(acc.waterAccount.accountNo);
    await main(page).getByPlaceholder(/搜/).press('Enter');
    const row = main(page).locator('tr', { hasText: acc.waterAccount.accountNo });
    await button(row, '人数').click();
    const decl = page.locator('.ant-modal', { hasText: '用水人数申报' });
    await expect(decl).toBeVisible();
    // 立户时的人口=3 作为当前申报值展示
    await expect(decl).toContainText('当前申报人数：3');
    await expect(decl.getByText('变更申报人口')).toBeVisible();
    // 生效账期默认 = 下个账期
    const next = new Date();
    next.setMonth(next.getMonth() + 1);
    const expected = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`;
    await expect(decl.locator('.ant-picker-input input')).toHaveValue(expected);
  });
});
