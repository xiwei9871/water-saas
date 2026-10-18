import { test, expect } from '@playwright/test';
import { ADMIN, collectRuntimeErrors, loginUi } from './helpers';

test.describe('UAT auth + navigation', () => {
  test('A01/A04: protected deep-link redirects to login and returns after login', async ({ page }) => {
    await page.goto('/billing/bills');
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel('租户代码').fill(ADMIN.tenantCode);
    await page.getByLabel('账号').fill(ADMIN.login);
    await page.getByLabel('密码').fill(ADMIN.password);
    await page.getByRole('button', { name: '登 录' }).click();
    await expect(page).toHaveURL(/\/billing\/bills$/);
    await expect(page.locator('.ant-card-head-title').getByText('账单', { exact: true })).toBeVisible();
  });

  test('A02: login required-field validation is Chinese and actionable', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: '登 录' }).click();
    await expect(page.getByText('请输入租户代码')).toBeVisible();
    await expect(page.getByText('请输入账号')).toBeVisible();
    await expect(page.getByText('请输入密码')).toBeVisible();
  });

  test('A03: wrong password shows handled error without page crash', async ({ page }) => {
    const runtime = collectRuntimeErrors(page);
    await page.goto('/login');
    await page.getByLabel('租户代码').fill(ADMIN.tenantCode);
    await page.getByLabel('账号').fill(ADMIN.login);
    await page.getByLabel('密码').fill('definitely-wrong');
    await page.getByRole('button', { name: '登 录' }).click();
    await expect(page.locator('.ant-alert-error')).toBeVisible();
    expect(runtime.filter((e) => e.startsWith('pageerror'))).toEqual([]);
  });

  test('A05/A06: session survives refresh and logout clears it', async ({ page }) => {
    await loginUi(page);
    await page.reload();
    await expect(page.getByText('供水营收管理系统')).toBeVisible();
    await page.getByRole('button', { name: '退出' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/payment/counter');
    await expect(page).toHaveURL(/\/login$/);
  });
});

const routes: Array<[string, string]> = [
  ['/customer/onboard', '立户向导'],
  ['/customer/customers', '客户列表'],
  ['/customer/water-accounts', '用水户'],
  ['/customer/settle-accounts', '结算户'],
  ['/customer/meters', '水表管理'],
  ['/metering/books', '抄表册'],
  ['/metering/plans', '抄表计划'],
  ['/metering/readings', '抄表记录 / 质检'],
  ['/settlement/list', '结算水量'],
  ['/settlement/reconciliations', '补差管理'],
  ['/billing/tariffs', '资费计划'],
  ['/billing/fee-items', '费用项'],
  ['/billing/runs', '开账批次'],
  ['/billing/bills', '账单'],
  ['/payment/counter', '收费台'],
  ['/payment/payments', '收款记录'],
  ['/payment/day-close', '收费员日结'],
  ['/report/meter-daily', '抄表日报'],
  ['/report/cashier-daily', '收费日报'],
  ['/report/ar-monthly', '应收月报'],
  ['/report/collected-monthly', '实收月报'],
  ['/report/recovery-rate', '回收率'],
  ['/system/orgs', '组织管理'],
  ['/system/staff', '用户管理'],
  ['/system/roles', '角色权限'],
  ['/system/params', '租户参数'],
  ['/system/audit-logs', '操作日志'],
];

test.describe('UAT route smoke', () => {
  test.beforeEach(async ({ page }) => loginUi(page));

  for (const [path, title] of routes) {
    test(`B route ${path} renders ${title} without JS crash`, async ({ page }) => {
      const runtime = collectRuntimeErrors(page);
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(path.replaceAll('/', '\\/') + '$'));
      await expect(page.locator('.ant-card-head-title').getByText(title, { exact: true })).toBeVisible();
      expect(runtime.filter((e) => e.startsWith('pageerror'))).toEqual([]);
    });
  }

  for (const width of [1280, 1024]) {
    test(`B10 viewport ${width}px has no body-level horizontal overflow on key pages`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      for (const path of ['/customer/onboard', '/metering/plans', '/billing/runs', '/payment/counter', '/report/recovery-rate']) {
        await page.goto(path);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `${path} body overflow at ${width}px`).toBeLessThanOrEqual(2);
      }
    });
  }
});

test.describe('UAT workbench acceptance', () => {
  test('workbench exposes operational todo entry points required by MVP spec', async ({ page }) => {
    await loginUi(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible();
    // v1.1 spec: 工作台待办应覆盖待复核读数 / MANUAL_REVIEW / 超限估抄 / 待应用补差。
    await expect(page.getByText('待复核读数', { exact: false })).toBeVisible();
    await expect(page.getByText('待应用', { exact: false })).toBeVisible();
  });
});
