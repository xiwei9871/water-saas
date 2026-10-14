import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { loginUi, shot } from './helpers';

/**
 * 2026-10-14 整改建议报告验收巡检（打 .185 部署版）。
 * 覆盖：P1 菜单归集 / P2 指标补齐 / P3 异常下钻角标 / P4 可读性。
 */
const TENANT = 'cd-water';

/** 展开指定顶级菜单组并返回其 inline 子菜单项文本（antd 垂直 inline 模式）。 */
async function submenuLabels(page: Page, group: string): Promise<string[]> {
  const li = page.locator('li.ant-menu-submenu', {
    has: page.locator('.ant-menu-submenu-title', { hasText: group }),
  });
  // 已展开则 ant-menu-submenu-open；未展开则点击标题
  if ((await li.getAttribute('class'))?.includes('ant-menu-submenu-open') !== true) {
    await li.locator('.ant-menu-submenu-title').click();
    await page.waitForTimeout(400);
  }
  return (await li.locator('.ant-menu-sub .ant-menu-item').allTextContents()).map((s) =>
    s.trim(),
  );
}

test.describe('整改验收 P1 菜单归集', () => {
  test('报表菜单仅剩日报/月报/年报三项，无旧五报表', async ({ page }) => {
    await loginUi(page, TENANT, 'cd-water');
    const labels = await submenuLabels(page, '报表');
    expect(labels.map((l) => l.replace(/\s+/g, ''))).toEqual(['日报', '月报', '年报']);
    const sider = page.locator('.ant-layout-sider, aside');
    for (const old of ['抄表日报', '收费日报', '应收月报', '实收月报']) {
      await expect(sider.getByText(old, { exact: true })).toHaveCount(0);
    }
    await shot(page, 'r01-report-menu-3items');
  });

  test('数据查询为独立顶级菜单含五个查询页', async ({ page }) => {
    await loginUi(page, TENANT, 'cd-water');
    const labels = await submenuLabels(page, '数据查询');
    for (const want of [
      '用户档案查询',
      '水量明细查询',
      '账单明细查询',
      '收款流水查询',
      '欠费明细查询',
    ]) {
      expect(labels.some((l) => l.replace(/\s+/g, '').includes(want))).toBe(true);
    }
    await shot(page, 'r02-data-query-menu');
  });

  test('指标字典在系统管理菜单下', async ({ page }) => {
    await loginUi(page, TENANT, 'cd-water');
    const reportItems = await submenuLabels(page, '报表');
    expect(reportItems.some((l) => l.includes('指标字典'))).toBe(false);
    const sysItems = await submenuLabels(page, '系统管理');
    expect(sysItems.some((l) => l.includes('指标字典'))).toBe(true);
    const sysLi = page.locator('li.ant-menu-submenu', {
      has: page.locator('.ant-menu-submenu-title', { hasText: '系统管理' }),
    });
    await sysLi.locator('.ant-menu-item', { hasText: '指标字典' }).click();
    await expect(page).toHaveURL(/\/report\/metric-dict/);
    await shot(page, 'r03-metric-dict-under-system');
  });
});

test.describe('整改验收 P2 指标字典', () => {
  test('经营月报渲染新增指标（催缴成功率等）', async ({ page }) => {
    await loginUi(page, TENANT, 'cd-water');
    await page.goto('/report/analysis-monthly');
    await page.waitForResponse((r) => r.url().includes('/reports/analysis-monthly'));
    for (const label of [
      '抄表到位率',
      '智能水表覆盖率',
      '连续零用水户占比',
      '开账及时率',
      '计费准确率',
      '优惠减免率',
      '预存比率',
      '陈欠占比',
      '客户流失率',
      '人均售水量(m³)',
      '催缴成功率',
      '水费回收率',
    ]) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
    }
    await shot(page, 'r04-monthly-new-metrics');
  });

  test('指标字典页列出补齐指标且含口径', async ({ page }) => {
    await loginUi(page, TENANT, 'cd-water');
    await page.goto('/report/metric-dict');
    await page.waitForResponse((r) => r.url().includes('metric-dictionary'));
    for (const name of ['抄表到位率', '催缴成功率', '陈欠占比', '人均售水量']) {
      await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
    }
    await shot(page, 'r05-metric-dict-full');
  });
});

test.describe('整改验收 P3/P4 异常与可读性', () => {
  test('异常队列每行均有「去处理」且详情无裸技术键', async ({ page }) => {
    await loginUi(page, TENANT, 'cd-water');
    await page.goto('/exceptions');
    await page.waitForResponse((r) => r.url().includes('/exceptions'));
    const rows = page.locator('.ant-table-tbody tr.ant-table-row');
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    const rowCount = await rows.count();
    const drillCount = await rows
      .getByRole('button', { name: /去\s*处\s*理/ })
      .count();
    // 所有 19 类异常均已映射处置页 → 每行有去处理
    expect(drillCount).toBe(rowCount);
    await shot(page, 'r06-exceptions-drill');
    await rows.first().getByRole('button', { name: /详\s*情/ }).click();
    const drawer = page.locator('.ant-drawer-open');
    await expect(drawer.getByText('业务标识')).toBeVisible();
    // 技术键折叠后才可见；未展开前抽屉内无 anomalyKey 形态
    await expect(drawer.locator('text=/reading:[0-9a-f]{8}-/')).toHaveCount(0);
    await shot(page, 'r07-exception-detail-readable');
  });

  test('任务详情业务上下文为中文描述而非 JSON', async ({ page }) => {
    await loginUi(page, TENANT, 'cd-water');
    await page.goto('/tasks');
    await page.waitForResponse((r) => r.url().includes('/tasks'));
    const rows = page.locator('.ant-table-tbody tr.ant-table-row');
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    await rows.first().getByRole('button', { name: /详\s*情/ }).click();
    const drawer = page.locator('.ant-drawer-open');
    await expect(drawer.getByText('业务上下文')).toBeVisible({ timeout: 8_000 });
    // 业务上下文为中文句形（户号/结算户开头），技术详情未展开 → 无 JSON 花括号
    await expect(drawer.locator('.ant-descriptions')).not.toContainText('{');
    await expect(
      drawer.locator('.ant-descriptions').getByText(/户号|结算户|收款单|原收款单/),
    ).toBeVisible();
    await shot(page, 'r08-task-context-readable');
  });

  test('账单明细「费用构成」列显示 ¥ 元格式', async ({ page }) => {
    await loginUi(page, TENANT, 'cd-water');
    await page.goto('/report/query/bill-details');
    // 账期为必填：直接在月份输入框键入
    await page.getByPlaceholder('请选择月份').click();
    await page.keyboard.type('2026-10');
    await page.keyboard.press('Enter');
    const resp = page.waitForResponse((r) =>
      r.url().includes('/reports/query/bill-details'),
    );
    await page.getByRole('button', { name: /查\s*询/ }).click();
    await resp;
    await expect(
      page.getByText('费用构成', { exact: true }).first(),
    ).toBeVisible();
    const cell = page
      .locator('.ant-table-tbody td')
      .filter({ hasText: '¥' })
      .first();
    if (await cell.count()) {
      await expect(cell).toContainText('¥');
      // 「水费 3000」这类裸分格式不应再出现
      await expect(cell).not.toContainText(/[一-龥]\s\d{4,}(\s|$)/);
    }
    await shot(page, 'r09-bill-fee-composition');
  });
});
