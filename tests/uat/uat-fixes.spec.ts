import { test, expect } from './helpers/console';
import { login, ready } from './helpers/auth';
import { db, roleFixtures } from './helpers/fixture';
import { dimensions, evidence, main } from './helpers/ui';
import type { Page, TestInfo } from '@playwright/test';

const tariffName = 'UAT居民单价回归方案';
test.beforeAll(async () => {
  await roleFixtures();
  await db(async p => {
    const tenant = await p.tenant.findUniqueOrThrow({ where: { code: 'cd-water' } });
    const key = { tenantId: tenant.id, code: 'UAT_LAYOUT_REGRESSION', effectiveFrom: new Date('2026-01-01') };
    await p.tariffPlan.upsert({ where: { tenantId_code_effectiveFrom: key },
      create: { ...key, name: tariffName, usageCategory: 'RES_METERED' }, update: {} });
  });
});

async function checkHeader(page: Page, info: TestInfo, route: string, title: string, width: number) {
  await page.setViewportSize({ width, height: width === 1024 ? 768 : 900 });
  await page.goto(route); await ready(page);
  const heading = main(page).getByText(title, { exact: true }).first();
  const header = main(page).locator('.ant-card-head').first();
  const measurements = await header.evaluate(el => {
    const title = el.querySelector('.ant-card-head-title') as HTMLElement;
    const extra = el.querySelector('.ant-card-extra') as HTMLElement;
    const candidates = [...extra.querySelectorAll('.ant-select, .ant-picker, .ant-input-group-wrapper, .ant-btn')];
    const controls = candidates.filter(a => !candidates.some(b => b !== a && b.contains(a)))
      .map(a => ({ text: a.textContent, x: a.getBoundingClientRect().x, y: a.getBoundingClientRect().y,
        w: a.getBoundingClientRect().width, h: a.getBoundingClientRect().height }));
    const overlaps: unknown[] = [];
    for (let a = 0; a < controls.length; a++) for (let b = a + 1; b < controls.length; b++) {
      const x = controls[a], y = controls[b];
      if (Math.min(x.x+x.w,y.x+y.w)-Math.max(x.x,y.x)>1 && Math.min(x.y+x.h,y.y+y.h)-Math.max(x.y,y.y)>1) overlaps.push([x,y]);
    }
    return { titleWidth: title.clientWidth, titleScroll: title.scrollWidth,
      titleBottom: title.getBoundingClientRect().bottom, toolbarTop: extra.getBoundingClientRect().top, controls, overlaps };
  });
  await evidence(page, info, route.replaceAll('/', '-') + '-' + width, measurements);
  await expect.soft(heading).toBeVisible();
  expect.soft(measurements.titleWidth).toBeGreaterThan(0);
  expect.soft(measurements.titleScroll, 'Complete title, no ellipsis').toBeLessThanOrEqual(measurements.titleWidth + 1);
  expect.soft(measurements.overlaps, 'Visible filter controls must not overlap').toEqual([]);
  if (width < 1280) expect.soft(measurements.toolbarTop, 'Small viewport puts toolbar below title').toBeGreaterThanOrEqual(measurements.titleBottom);
  const size = await dimensions(page);
  expect(size.scrollWidth).toBeLessThanOrEqual(size.width + 2);
}
for (const width of [1440, 1280, 1024]) test(`UAT-001 bills full title and nonoverlapping filters ${width}`, async ({ page }, info) => {
  await login(page); await checkHeader(page, info, '/billing/bills', '账单', width);
});
for (const [route,title] of [['/settlement/list','结算水量'], ['/metering/plans','抄表计划']]) test(`UAT-002 complete title and wrapped toolbar 1024 ${route}`, async ({ page }, info) => {
  await login(page); await checkHeader(page, info, route, title, 1024);
});
test('UAT-003 tariff name and date widths with internal table scroll 1024', async ({ page }, info) => {
  await login(page); await checkHeader(page, info, '/billing/tariffs', '资费计划', 1024);
  const cell = main(page).getByRole('cell', { name: tariffName, exact: true });
  const metrics = await cell.evaluate(el => {
    const range = document.createRange(); range.selectNodeContents(el);
    return { width: el.clientWidth, textHeight: range.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(el).lineHeight) };
  });
  expect.soft(metrics.width, 'Business name has at least 160px').toBeGreaterThanOrEqual(160);
  expect.soft(metrics.textHeight, 'Name must fit at most two lines').toBeLessThanOrEqual(metrics.lineHeight * 2 + 2);
  const dateHeader = main(page).getByRole('columnheader', { name: '生效区间' });
  expect.soft((await dateHeader.boundingBox())!.width).toBeGreaterThanOrEqual(190);
  const table = main(page).getByRole('table').first();
  expect.soft((await table.boundingBox())!.width).toBeGreaterThan(1024 - 200);
  // Ensure rightmost actions can be reached by scrolling the table itself.
  const scroll = table.locator('..');
  expect.soft(await scroll.evaluate(el => el.scrollWidth > el.clientWidth && ['auto','scroll'].includes(getComputedStyle(el).overflowX))).toBeTruthy();
  await evidence(page, info, 'tariff-column-width', metrics);
});
test('Shared header pattern also fits customer meter book and payment lists', async ({ page }, info) => {
  await login(page);
  for (const [route,title] of [['/customer/customers','客户列表'], ['/customer/meters','水表管理'], ['/metering/books','抄表册'], ['/payment/payments','收款记录']])
    await checkHeader(page, info, route, title, 1024);
});
test('UAT-004 global Chinese empty date month calendar pagination and modal labels', async ({ page }, info) => {
  await login(page); await page.goto('/customer/customers'); await ready(page);
  await page.getByPlaceholder('按名称搜索').fill('UAT-NONEXISTENT-LOCALE');
  await page.getByPlaceholder('按名称搜索').press('Enter');
  await expect.soft(main(page).getByRole('cell').filter({ hasText: '暂无数据' })).toBeVisible();
  await expect.soft(main(page)).not.toContainText('No data');
  await evidence(page, info, 'locale-empty');
  await page.goto('/billing/tariffs'); await ready(page);
  await expect.soft(main(page)).not.toContainText('/ page');
  await expect.soft(main(page)).toContainText('条/页');
  await page.getByRole('button', { name: '新建资费方案' }).click();
  const dialog = page.getByRole('dialog', { name: '新建资费方案' });
  const input = dialog.getByLabel('生效日期', { exact: true });
  await expect.soft(input).toHaveAttribute('placeholder', '请选择日期');
  await input.click();
  const calendar = page.locator('.ant-picker-dropdown:visible');
  await expect.soft(calendar).toContainText('今天');
  await expect.soft(calendar.getByRole('columnheader')).toHaveText(['一', '二', '三', '四', '五', '六', '日']);
  await expect.soft(dialog.getByRole('button', { name: '关闭', exact: true })).toBeVisible();
  await calendar.evaluate(async el => { await Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished)); });
  await evidence(page, info, 'locale-calendar', { calendarText: await calendar.innerText() });
  await page.goto('/report/ar-monthly'); await ready(page);
  await expect.soft(main(page).getByRole('textbox').first()).toHaveAttribute('placeholder', '请选择月份');
  await main(page).getByRole('textbox').first().click();
  await expect.soft(page.locator('.ant-picker-dropdown:visible').getByRole('cell')).toHaveText(
    Array.from({ length: 12 }, (_, i) => `${i + 1}月`),
  );
  await expect.soft(page.locator('input[placeholder="Select date"], input[placeholder="Select month"]')).toHaveCount(0);
  const monthCalendar = page.locator('.ant-picker-dropdown:visible');
  await monthCalendar.evaluate(async el => { await Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished)); });
  await evidence(page, info, 'locale-month', { calendarText: await monthCalendar.innerText() });
});
for (const role of ['cashier','reader','reviewer']) test(`UAT-005 ${role} Chinese Forbidden preserves denied URL and backend 403`, async ({ page, audit }, info) => {
  await login(page, 'uat-' + role, 'uat12345');
  const requests: string[] = [];
  page.on('request', r => { if (r.url().includes('/api/iam/staff')) requests.push(r.url()); });
  await page.goto('/system/staff'); await ready(page);
  await expect.soft(page).toHaveURL('http://127.0.0.1:4173/system/staff');
  await expect.soft(main(page)).toContainText('403');
  await expect.soft(main(page)).toContainText('无权限访问');
  await expect.soft(main(page)).toContainText('你当前账号没有访问此页面的权限。');
  await expect.soft(main(page).getByRole('button', { name: '新增员工' })).toHaveCount(0);
  expect.soft(requests, 'Denied component must not mount or fetch protected staff data').toEqual([]);
  await page.reload(); await ready(page);
  await expect.soft(main(page)).toContainText('无权限访问');
  audit.allow('/api/iam/staff',403,'GET');
  const rejected = await page.evaluate(async () => {
    const r = await fetch('/api/iam/staff', { headers: { Authorization: 'Bearer ' + localStorage.getItem('water-saas.accessToken') } });
    return { status:r.status,body:await r.json() };
  });
  expect(rejected.status).toBe(403);
  await evidence(page, info, 'forbidden-' + role, rejected);
  await page.getByRole('button', { name:'返回工作台' }).click();
  await expect(page).toHaveURL('http://127.0.0.1:4173/');
  await expect(page.getByRole('heading', { name:'工作台' })).toBeVisible();
});
test('UAT-005 unauthenticated denied route still goes to login', async ({ page }) => {
  await page.goto('/system/staff'); await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByLabel('租户代码')).toBeVisible();
  await expect(page.getByText('无权限访问', { exact:true })).toHaveCount(0);
});
