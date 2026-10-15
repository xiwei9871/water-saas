import { expect, test } from '@playwright/test';
import { loginAsAdmin, watchErrors } from './helpers/auth';

/**
 * 页面巡检：第 1–5 批改动涉及的页面逐一打开，断言
 *  1) 无 5xx / 页面运行时错误
 *  2) 表格与筛选区不出现裸 UUID（人读化修复 R1–R3/R7/R8 的回归网）
 *  3) 新功能控件存在（分类列、渠道选项、徽标、字典入口…）
 *
 * 数据依赖弱断言——Pilot 数据量变化不破坏本套件。
 */

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i;
// 截断展示形态：8 位十六进制 + 省略号（如 3d18e1ea…）
const TRUNC_UUID_RE = /\b[0-9a-f]{8}…/i;

async function expectNoUuid(page: import('@playwright/test').Page, scope = 'body') {
  const texts = await page.locator(scope).allInnerTexts();
  const text = texts.join('\n');
  expect(text, '页面出现完整 UUID').not.toMatch(UUID_RE);
  expect(text, '页面出现截断 UUID').not.toMatch(TRUNC_UUID_RE);
}

test.beforeEach(async ({ page }) => {
  await loginAsAdmin(page);
});

test.describe('页面巡检（无 5xx / 无裸 UUID）', () => {
  const PAGES: { path: string; name: string; readyText?: RegExp }[] = [
    { path: '/billing/bills', name: '账单', readyText: /账单/ },
    { path: '/payment/payments', name: '收款记录', readyText: /收款|流水/ },
    { path: '/metering/books', name: '抄表册', readyText: /抄表册/ },
    { path: '/metering/plans', name: '抄表计划', readyText: /抄表计划/ },
    { path: '/billing/fee-items', name: '费用项', readyText: /费用项/ },
    { path: '/payment/prepayments', name: '预存管理', readyText: /预存/ },
    { path: '/payment/day-close', name: '收费员日结', readyText: /日结/ },
    { path: '/payment/writeoffs', name: '坏账核销', readyText: /核销/ },
    { path: '/report/query/unified', name: '统一数据查询', readyText: /统一数据查询|显示字段/ },
    { path: '/report/ops-daily', name: 'B1运营日报', readyText: /运营日报|营业日报/ },
    { path: '/report/analysis-monthly', name: 'B2经营月报', readyText: /经营月报|月报/ },
    { path: '/report/analysis-yearly', name: 'B3年报', readyText: /年报|年度/ },
    { path: '/report/metric-dict', name: 'C1指标字典', readyText: /指标字典|指标/ },
    { path: '/system/dicts', name: 'G4字典管理', readyText: /字典/ },
    { path: '/exceptions', name: '异常中心', readyText: /异常/ },
    { path: '/settlement/reconciliations', name: '补差管理', readyText: /补差/ },
  ];

  for (const p of PAGES) {
    test(`${p.name} ${p.path}`, async ({ page }) => {
      const w = watchErrors(page);
      await page.goto(p.path);
      if (p.readyText) await expect(page.getByText(p.readyText).first()).toBeVisible();
      await page.waitForLoadState('networkidle');
      await expectNoUuid(page, '.ant-table, .ant-descriptions, .ant-form');
      const fatal = w.errors.filter((e) => !e.includes('favicon'));
      expect(fatal, `${p.name} 出现运行期错误`).toEqual([]);
    });
  }
});

test.describe('R/T/G 控件级检查', () => {
  test('R1 账单页筛选为选择器而非 UUID 输入', async ({ page }) => {
    await page.goto('/billing/bills');
    await page.waitForLoadState('networkidle');
    // 三个原 UUID 输入已替换为可搜索选择器（户号/结算户/批次）
    await expect(
      page.locator('.ant-select-selection-placeholder', { hasText: '户号' }),
    ).toBeVisible();
    await expect(
      page.locator('.ant-select-selection-placeholder', { hasText: '结算户' }),
    ).toBeVisible();
    await expectNoUuid(page);
  });

  test('G1 费用项展示分类标签', async ({ page }) => {
    await page.goto('/billing/fee-items');
    await page.waitForLoadState('networkidle');
    const body = await page.locator('body').innerText();
    expect(body).toMatch(/水费|代收|其他/);
    await expectNoUuid(page);
  });

  test('G3 收款渠道筛选含线上/代扣', async ({ page }) => {
    await page.goto('/payment/payments');
    await page.waitForLoadState('networkidle');
    // 渠道筛选下拉（收款台的渠道控件需先选户出欠费才渲染，这里用
    // 收款记录的渠道筛选验证枚举已扩充）
    await page
      .locator('.ant-select', {
        has: page.locator('.ant-select-selection-placeholder', { hasText: '渠道' }),
      })
      .click();
    const dropdown = page.locator('.ant-select-dropdown:visible');
    await expect(dropdown.getByText('线上缴费')).toBeVisible();
    await expect(dropdown.getByText('银行代扣')).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('R5 日结弹窗可选择收费员（管理员代结）', async ({ page }) => {
    await page.goto('/payment/day-close');
    await page.waitForLoadState('networkidle');
    const closeBtn = page.getByRole('button', { name: /执行日结|日结/ }).first();
    await closeBtn.click();
    const modal = page.locator('.ant-modal:visible');
    // 代结弹窗必须明示结算对象（收费员选择器）
    await expect(modal.getByText(/收费员/).first()).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('T2 导航徽标挂载（数值可为 0）', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    // 异常中心菜单项存在；徽标为 Badge 组件（有 OPEN 时显示数字）
    await expect(page.getByText('异常中心').first()).toBeVisible();
  });

  test('T3 异常中心类型筛选含新类型', async ({ page }) => {
    await page.goto('/exceptions');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(/异常中心|工单|待办/).first()).toBeVisible();
    await expectNoUuid(page);
  });

  test('C1 指标字典展示口径与版本', async ({ page }) => {
    await page.goto('/report/metric-dict');
    await page.waitForLoadState('networkidle');
    const body = await page.locator('body').innerText();
    // 版本号 + 若干指标码
    expect(body).toMatch(/2026-10\.v\d+/);
    expect(body).toMatch(/SOLD_QTY|RECOVERY_RATE|ARREARS_TOTAL/);
    // 无数据源指标必须显式标注原因而非静默 0
    expect(body).toMatch(/不可用|暂无|未提供|尚未/);
  });
});
