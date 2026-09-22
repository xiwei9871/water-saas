/**
 * E7 Meter Lifecycle UAT — water_uat_e7 (real UI + real API, no mocks).
 * Serial suite; account/meter fixtures go through the API, every lifecycle
 * interaction is driven through the UI.
 *
 * Slices:
 *  1. 水表户抽屉：当前表卡片 + 安装史（onboarded ACTIVE installation）
 *  2. 户内换表：旧表止码 + 新表始码独立填写 → REMOVED+ACTIVE 两行，当前表更新
 *  3. 水表档案：详情抽屉（档案字段 + scope 内安装历史）
 *  4. 装拆记录行「更换」→ replace modal → 成功
 *  5. 销户拦截：ACTIVE 表未拆 → 销户报错 → 拆表 → 销户成功
 *  6. 一户多表警示：>1 ACTIVE → 抽屉警示条如实展示
 */
import { test, expect } from '../uat/helpers/console';
import { login, ready } from '../uat/helpers/auth';
import { button, evidence, main } from '../uat/helpers/ui';
import type { Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const stamp = Date.now().toString(36);
let token = '';

async function api(
  page: Page,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
  bearer = token,
) {
  const res = await page.request.fetch(`/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${bearer}` },
    ...(body === undefined ? {} : { data: body }),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status(), body: json };
}

async function apiOk(page: Page, method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) {
  const r = await api(page, method, path, body);
  expect(r.status, `${method} ${path}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
  return r.body;
}

async function apiToken(page: Page, account: string, password: string) {
  const r = await api(page, 'POST', '/auth/login', {
    tenantCode: 'cd-water',
    login: account,
    password,
  });
  expect(r.status, `login ${account}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
  return r.body.accessToken as string;
}

async function onboard(page: Page, tag: string) {
  const body = await apiOk(page, 'POST', '/water-accounts/onboard', {
    customer: { name: `E7 ${tag} ${stamp}`, custType: 'PERSONAL', phone: '138' },
    account: { usageCategory: 'RES_METERED', addr: `E7 ${tag} 街` },
    meter: { brand: 'e7-brand', caliber: 'DN15' },
    installation: { initialReading: 0 },
  });
  return body as {
    waterAccount: { id: string; accountNo: string };
    meter: { id: string; meterNo: string };
    installation: { id: string };
  };
}

const newMeter = (page: Page) =>
  apiOk(page, 'POST', '/meters', { brand: 'e7-spare', caliber: 'DN15' });

/** 抽屉里的 antd 弹窗（Drawer 内 Modal 也挂在 body）。 */
const modal = (page: Page) => page.locator('.ant-modal:visible').last();
const drawer = (page: Page) => page.locator('.ant-drawer:visible').last();

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  token = await apiToken(page, 'admin', 'admin123');
  await page.close();
});

test('S1: 水表户抽屉显示当前表与安装史', async ({ page }, info) => {
  const a = await onboard(page, 's1');
  await login(page);
  await page.goto('/customer/water-accounts');
  await ready(page);
  await page.getByPlaceholder('按户号精确查询').fill(a.waterAccount.accountNo);
  await page.getByPlaceholder('按户号精确查询').press('Enter');
  await expect(main(page)).toContainText(a.waterAccount.accountNo);

  await button(main(page).getByRole('row').filter({ hasText: a.waterAccount.accountNo }), '水表').click();
  await expect(drawer(page)).toContainText('当前表');
  await expect(drawer(page)).toContainText(a.meter.meterNo);
  await expect(drawer(page)).toContainText('装表时间');
  await expect(drawer(page)).toContainText('在用');
  await evidence(page, info, 's1-meter-section', { accountNo: a.waterAccount.accountNo });
});

test('S2: 户内换表 — 独立旧止码/新始码 → 当前表更新 + 双记录', async ({ page }, info) => {
  const a = await onboard(page, 's2');
  const spare = await newMeter(page);
  await login(page);
  await page.goto('/customer/water-accounts');
  await ready(page);
  await page.getByPlaceholder('按户号精确查询').fill(a.waterAccount.accountNo);
  await page.getByPlaceholder('按户号精确查询').press('Enter');

  await button(main(page).getByRole('row').filter({ hasText: a.waterAccount.accountNo }), '水表').click();
  await button(drawer(page), '换表').click();

  const m = modal(page);
  // MeterSelect 是远程搜索 —— 输入表号让后端过滤，再点选项。
  const combo = m.locator('.ant-form-item').filter({ hasText: '新表' }).getByRole('combobox');
  await combo.click();
  await combo.fill(spare.meterNo);
  await page.locator('.ant-select-dropdown:visible').getByText(spare.meterNo).click();
  await m.getByLabel('旧表止码').fill('88');
  await m.getByLabel('新表始码').fill('3');
  await button(m, '确认换表').click();
  await expect(page.locator('.ant-message')).toContainText('换表完成');

  await expect(drawer(page)).toContainText(spare.meterNo);
  await expect(drawer(page)).toContainText('已拆除');
  await expect(drawer(page)).toContainText('88');
  await evidence(page, info, 's2-replaced', { newMeter: spare.meterNo });
});

test('S3: 水表档案详情抽屉 — 档案字段 + 安装历史', async ({ page }, info) => {
  const a = await onboard(page, 's3');
  await login(page);
  await page.goto('/customer/meters');
  await ready(page);
  // 台账按表号升序分页 —— 累积运行后新表可能不在第一页，放大 pageSize。
  await page.locator('.ant-pagination-options .ant-select').first().click();
  await page.locator('.ant-select-dropdown:visible').getByText('100 条/页', { exact: true }).click();
  const row = main(page).getByRole('row').filter({ hasText: a.meter.meterNo });
  await button(row, '详情').click();
  await expect(drawer(page)).toContainText('水表详情');
  await expect(drawer(page)).toContainText(a.meter.meterNo);
  await expect(drawer(page)).toContainText('安装历史');
  await expect(drawer(page)).toContainText(a.waterAccount.accountNo);
  await expect(drawer(page)).toContainText('在用');
  await evidence(page, info, 's3-meter-detail', { meterNo: a.meter.meterNo });
});

test('S4: 装拆记录行「更换」→ replace modal 完成换表', async ({ page }, info) => {
  const a = await onboard(page, 's4');
  const spare = await newMeter(page);
  await login(page);
  await page.goto('/customer/meters');
  await ready(page);

  // 装拆记录卡 — 用水表户过滤到该 installation 行
  const instCard = page.locator('.ant-card').filter({ hasText: '拆表时间' });
  const row = instCard.getByRole('row').filter({ hasText: a.meter.meterNo });
  await button(row, '更换').click();

  const m = modal(page);
  // MeterSelect 是远程搜索 —— 输入表号让后端过滤，再点选项。
  const combo = m.locator('.ant-form-item').filter({ hasText: '新表' }).getByRole('combobox');
  await combo.click();
  await combo.fill(spare.meterNo);
  await page.locator('.ant-select-dropdown:visible').getByText(spare.meterNo).click();
  await m.getByLabel('旧表止码').fill('50');
  await m.getByLabel('新表始码').fill('0');
  await button(m, '确认换表').click();
  await expect(page.locator('.ant-message')).toContainText('换表完成');
  await expect(instCard).toContainText('已拆除');
  await evidence(page, info, 's4-replace-row', {});
});

test('S5: 销户被 ACTIVE 表拦截 → 拆表 → 销户成功', async ({ page, audit }, info) => {
  const a = await onboard(page, 's5');
  // 预期内的 409 —— 销户拦截是本切片要验证的行为，不是缺陷。
  audit.allow(`/api/water-accounts/${a.waterAccount.id}/close`, 409, 'POST');
  await login(page);
  await page.goto('/customer/water-accounts');
  await ready(page);
  await page.getByPlaceholder('按户号精确查询').fill(a.waterAccount.accountNo);
  await page.getByPlaceholder('按户号精确查询').press('Enter');
  const row = main(page).getByRole('row').filter({ hasText: a.waterAccount.accountNo });

  await button(row, '销户').click();
  await button(modal(page), '确认销户').click();
  // ACCOUNT_HAS_ACTIVE_INSTALLATION → 服务端错误透出
  await expect(page.locator('.ant-message')).toContainText('在册水表');
  await button(modal(page), '取消').click();

  // 先拆表
  await button(row, '水表').click();
  await button(drawer(page), '拆表').click();
  await modal(page).getByLabel('拆除读数').fill('10');
  await button(modal(page), '确认拆除').click();
  await expect(page.locator('.ant-message')).toContainText('拆表完成');
  await drawer(page).locator('.ant-drawer-close').click();
  await expect(page.locator('.ant-drawer-open')).toHaveCount(0);

  // 再销户 —— 成功
  await button(row, '销户').click();
  await button(modal(page), '确认销户').click();
  await expect(page.locator('.ant-message')).toContainText('已销户');
  await evidence(page, info, 's5-close-guard', {});
});

test('S6: 一户多 ACTIVE 表 — 警示条 + 全部如实展示', async ({ page }, info) => {
  const a = await onboard(page, 's6');
  const spare = await newMeter(page);
  // domain permissive：API 直接再挂一块 ACTIVE
  await apiOk(page, 'POST', '/meter-installations', {
    waterAccountId: a.waterAccount.id,
    meterId: spare.id,
    initialReading: 0,
  });

  await login(page);
  await page.goto('/customer/water-accounts');
  await ready(page);
  await page.getByPlaceholder('按户号精确查询').fill(a.waterAccount.accountNo);
  await page.getByPlaceholder('按户号精确查询').press('Enter');
  await button(main(page).getByRole('row').filter({ hasText: a.waterAccount.accountNo }), '水表').click();

  await expect(drawer(page)).toContainText('2 只在册水表');
  await expect(drawer(page)).toContainText(a.meter.meterNo);
  await expect(drawer(page)).toContainText(spare.meterNo);
  await evidence(page, info, 's6-multi-active', {});
});
