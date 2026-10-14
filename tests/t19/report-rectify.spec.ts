import { expect, test } from '@playwright/test';
import { loginUi, shot } from './helpers';

/**
 * 2026-10-14 整改建议报告验收巡检（打 .185 部署版）。
 * 覆盖：P1 菜单归集 / P2 指标补齐 / P3 异常下钻角标 / P4 可读性。
 */
const TENANT = 'cd-water';

test.describe('整改验收 P1 菜单归集', () => {
  test('报表菜单仅剩日报/月报/年报三项，无旧五报表', async ({ page }) => {
    await loginUi(page, TENANT, 'admin');
    const sider = page.locator('.ant-layout-sider, aside');
    await sider.getByText('报表', { exact: true }).first().click();
    await page.waitForTimeout(500);
    const sub = page.locator('.ant-menu-sub:visible');
    const labels = (await sub.locator('.ant-menu-item').allTextContents()).map((s) =>
      s.trim(),
    );
    expect(labels).toHaveLength(3);
    for (const want of ['日报', '月报', '年报']) {
      expect(labels.some((l) => l === want)).toBe(true);
    }
    for (const old of ['抄表日报', '收费日报', '应收月报', '实收月报']) {
      await expect(sider.getByText(old, { exact: true })).toHaveCount(0);
    }
    await shot(page, 'r01-report-menu-3items');
  });

  test('数据查询为独立顶级菜单含五个查询页', async ({ page }) => {
    await loginUi(page, TENANT, 'admin');
    const sider = page.locator('.ant-layout-sider, aside');
    await sider.getByText('数据查询', { exact: true }).first().click();
    await page.waitForTimeout(500);
    const sub = page.locator('.ant-menu-sub:visible').last();
    const labels = (await sub.locator('.ant-menu-item').allTextContents()).map((s) =>
      s.trim(),
    );
    for (const want of [
      '用户档案查询',
      '水量明细查询',
      '账单明细查询',
      '收款流水查询',
      '欠费明细查询',
    ]) {
      expect(labels.some((l) => l.includes(want))).toBe(true);
    }
    await shot(page, 'r02-data-query-menu');
  });

  test('指标字典在系统管理菜单下', async ({ page }) => {
    await loginUi(page, TENANT, 'admin');
    const sider = page.locator('.ant-layout-sider, aside');
    await sider.getByText('报表', { exact: true }).first().click();
    await page.waitForTimeout(400);
    const reportSub = page.locator('.ant-menu-sub:visible').first();
    await expect(reportSub.getByText('指标字典')).toHaveCount(0);
    await sider.getByText('系统管理', { exact: true }).first().click();
    await page.waitForTimeout(400);
    const sysSub = page.locator('.ant-menu-sub:visible').last();
    await expect(sysSub.getByText('指标字典')).toBeVisible();
    await sysSub.getByText('指标字典').click();
    await expect(page).toHaveURL(/\/report\/metric-dict/);
    await shot(page, 'r03-metric-dict-under-system');
  });
});

test.describe('整改验收 P2 指标字典', () => {
  test('经营月报渲染新增指标（催缴成功率等）', async ({ page }) => {
    await loginUi(page, TENANT, 'admin');
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
    await loginUi(page, TENANT, 'admin');
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
    await loginUi(page, TENANT, 'admin');
    await page.goto('/exceptions');
    await page.waitForResponse((r) => r.url().includes('/exceptions'));
    const rows = page.locator('.ant-table-tbody tr.ant-table-row');
    const rowCount = await rows.count();
    test.skip(rowCount === 0, '当前无活跃异常行');
    const drillCount = await rows
      .getByRole('button', { name: /去\s*处\s*理/ })
      .count();
    expect(drillCount).toBe(rowCount);
    await shot(page, 'r06-exceptions-drill');
    await rows
      .first()
      .getByRole('button', { name: /详\s*情/ })
      .click();
    const drawer = page.locator('.ant-drawer-open');
    await expect(drawer.getByText('业务标识')).toBeVisible();
    await expect(drawer.locator('text=/reading:[0-9a-f]{8}-/')).toHaveCount(0);
    await shot(page, 'r07-exception-detail-readable');
  });

  test('任务详情业务上下文为中文描述而非 JSON', async ({ page }) => {
    await loginUi(page, TENANT, 'admin');
    await page.goto('/tasks');
    await page.waitForResponse((r) => r.url().includes('/tasks'));
    const firstRow = page.locator('.ant-table-tbody tr.ant-table-row').first();
    if ((await firstRow.count()) === 0) test.skip();
    await firstRow.click();
    const drawer = page.locator('.ant-drawer-open');
    await expect(drawer.getByText('业务上下文')).toBeVisible({ timeout: 5_000 });
    const ctxCell = drawer
      .locator('.ant-descriptions-item')
      .filter({ hasText: '业务上下文' });
    await expect(ctxCell.locator('.ant-descriptions-item-content')).not.toContainText(
      '{',
    );
    await shot(page, 'r08-task-context-readable');
  });

  test('账单明细「费用构成」列显示 ¥ 元格式', async ({ page }) => {
    await loginUi(page, TENANT, 'admin');
    await page.goto('/report/query/bill-details');
    await page.waitForResponse((r) => r.url().includes('/reports/query'));
    await expect(
      page.getByText('费用构成', { exact: true }).first(),
    ).toBeVisible();
    const cell = page
      .locator('.ant-table-tbody td')
      .filter({ hasText: '¥' })
      .first();
    if (await cell.count()) {
      await expect(cell).toContainText('¥');
      await expect(cell).not.toContainText(/[一-龥]\s\d{4,}(\s|$)/);
    }
    await shot(page, 'r09-bill-fee-composition');
  });
});
