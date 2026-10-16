import { expect, test } from '@playwright/test';
import { loginAsAdmin, loadCredentials } from './helpers/auth';

/**
 * 交互流验证：在已部署 Pilot 上真实点通各功能闭环。
 * 写入均为可撤销测试记录：字典项创建后停用、核销登记后撤销、
 * xlsx 导出只产生 audit_log（本身就是要验证的行为）。
 */

/** 从 localStorage 取登录态，直接打 API（审计/数据校验用）。 */
async function apiGet(page: import('@playwright/test').Page, path: string) {
  const base = new URL(page.url()).origin;
  const token = await page.evaluate(() => localStorage.getItem('water-saas.accessToken'));
  const res = await page.request.get(`${base}/api${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res;
}

test.beforeEach(async ({ page }) => {
  await loginAsAdmin(page);
});

test.describe('统一数据查询 + F1 导出', () => {
  /** 勾选字段工具：按 checkbox label 文本勾选。 */
  const checkField = async (page: import('@playwright/test').Page, label: string) => {
    await page.locator('.ant-checkbox-wrapper', { hasText: label }).first().click();
  };

  test('档案字段：查询出数 + 导出 xlsx + 审计留痕', async ({ page }) => {
    await page.goto('/report/query/unified');
    await page.waitForResponse((r) => r.url().includes('unified/fields'));
    await checkField(page, '地址');
    await checkField(page, '用水类别');
    await page.getByRole('button', { name: /查\s*询/ }).click();
    await page.waitForResponse((r) => r.url().includes('/reports/query/unified') && !r.url().includes('fields'));
    // 表格渲染（户号/户名为固定身份列）
    await expect(page.locator('.ant-table')).toBeVisible();
    const headers = await page.locator('.ant-table thead').innerText();
    expect(headers).toMatch(/户号|户名|地址|类别/);

    // F1: 导出触发真实 xlsx 下载
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 20_000 }),
      page.getByRole('button', { name: /导出/ }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.xlsx$/);

    // 审计留痕：audit_log 新增导出记录
    const audit = await apiGet(page, '/iam/audit-logs?take=20');
    expect(audit.status()).toBe(200);
    const logs = (await audit.json()) as { action?: string; path?: string; summary?: string }[];
    const hit = logs.some((l) => JSON.stringify(l).includes('export') || JSON.stringify(l).includes('xlsx') || JSON.stringify(l).includes('unified'));
    expect(hit, '导出未写入 audit_log').toBeTruthy();
  });

  test('收费字段：多期横展出渠道/金额列', async ({ page }) => {
    await page.goto('/report/query/unified');
    await page.waitForResponse((r) => r.url().includes('unified/fields'));
    await checkField(page, '实收金额');
    await checkField(page, '缴费渠道');
    await page.getByRole('button', { name: /查\s*询/ }).click();
    await page.waitForResponse((r) => r.url().includes('/reports/query/unified') && !r.url().includes('fields'));
    await expect(page.locator('.ant-table')).toBeVisible();
    const headers = await page.locator('.ant-table thead').innerText();
    expect(headers).toMatch(/实收金额|缴费渠道/);
  });

  test('阶段三：模板存取应用 + 字段排序 + 页内筛选', async ({ page }) => {
    await page.goto('/report/query/unified');
    await page.waitForResponse((r) => r.url().includes('unified/fields'));
    await checkField(page, '地址');
    // 存为模板
    await page.getByRole('button', { name: '存为模板' }).click();
    await page.locator('.ant-modal input').fill('E10冒烟模板');
    await page.locator('.ant-modal').getByRole('button', { name: /保\s*存/ }).click();
    await expect(page.getByText(/已保存/)).toBeVisible();
    // 打乱勾选后再应用模板还原
    await checkField(page, '用水类别');
    await page.locator('.ant-select', { hasText: '我的模板' }).click();
    await page.locator('.ant-select-item-option', { hasText: 'E10冒烟模板' }).click();
    await expect(page.getByText(/已应用模板/)).toBeVisible();
    // 已选字段 Tag 列存在（含排序按钮）
    await expect(page.getByText(/已选 \d+ 项/)).toBeVisible();
    const tagCount = await page.locator('.ant-tag').count();
    expect(tagCount).toBeGreaterThan(0);
    // 排序按钮：首项上移禁用、下移可用
    const firstTag = page.locator('.ant-tag:has(button)').first();
    await expect(firstTag.locator('button').nth(0)).toBeDisabled();
    await expect(firstTag.locator('button').nth(1)).toBeEnabled();
    // 页内筛选
    await page.getByRole('button', { name: /查\s*询/ }).click();
    await page.waitForResponse((r) => r.url().includes('/reports/query/unified') && !r.url().includes('fields'));
    await page.getByPlaceholder('页内筛选（当前页）').fill('不可能命中的词');
    await page.waitForTimeout(400);
    await expect(page.getByText(/页内筛选命中 0/)).toBeVisible();
    // 清理模板
    await page.locator('.ant-select', { hasText: '删除模板' }).click();
    await page.locator('.ant-select-item-option', { hasText: 'E10冒烟模板' }).click();
    await expect(page.getByText(/已删除/)).toBeVisible();
  });
});

test.describe('B1–B3 分析报表', () => {
  test('B2 经营月报：选账期出指标', async ({ page }) => {
    await page.goto('/report/analysis-monthly');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.ant-statistic, .ant-table').first()).toBeVisible({ timeout: 15_000 });
    const body = await page.locator('body').innerText();
    expect(body).toMatch(/应收|实收|售水|回收率|SOLD_QTY|AR_AMOUNT/);
    // 指标版本标识
    expect(body).toMatch(/2026-10\.v\d+/);
  });

  test('B3 年报：选年份出趋势', async ({ page }) => {
    await page.goto('/report/analysis-yearly');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.ant-statistic, .ant-table').first()).toBeVisible({ timeout: 15_000 });
    const body = await page.locator('body').innerText();
    expect(body).toMatch(/应收|实收|趋势|BAD_DEBT|核销/);
  });
});

test.describe('G4 字典管理', () => {
  const TEST_CODE = `E2E_${Date.now() % 100000}`;

  test('新增→停用→启用 闭环', async ({ page }) => {
    await page.goto('/system/dicts');
    await page.waitForLoadState('networkidle');
    // 类别下拉必须含 WRITEOFF_REASON 等类别
    const body = await page.locator('body').innerText();
    expect(body).toMatch(/核销|红冲|账龄|WRITEOFF|REVERSAL|AGING/);

    // 新增一条测试字典（类别取页面当前类别 WRITEOFF_REASON；弹窗只有编码/名称/排序）
    const addBtn = page.getByRole('button', { name: /新增字典项|新增|添加|新建/ }).first();
    await addBtn.click();
    const modal = page.locator('.ant-modal:visible');
    await modal.locator('input[placeholder*="UNREACHABLE"]').fill(TEST_CODE);
    await modal.locator('input[placeholder*="无法联系客户"]').fill('E2E测试项');
    await modal.getByRole('button', { name: /确\s*定|保\s*存|OK/ }).click();
    await page.waitForLoadState('networkidle');
    const row = page.locator('tr', { hasText: TEST_CODE }).first();
    await expect(row).toBeVisible({ timeout: 10_000 });

    // 停用 → 该默认列表只显示 ACTIVE，行会从表格消失；
    // 开「显示已停用」后可见状态=停用（antd 双字按钮自动插空格：「停 用」）
    await row.getByRole('button', { name: /停\s*用/ }).click();
    await page.waitForLoadState('networkidle');
    await page.locator('.ant-switch').first().click();
    await page.waitForLoadState('networkidle');
    const disabledRow = page.locator('tr', { hasText: TEST_CODE }).first();
    await expect(disabledRow.getByText(/^停用$/).first()).toBeVisible();

    // 再启用，恢复 ACTIVE（不留停用垃圾数据）
    await disabledRow.getByRole('button', { name: /启\s*用/ }).click();
    await page.waitForLoadState('networkidle');
    await expect(
      page.locator('tr', { hasText: TEST_CODE }).first().getByText(/^启用$/).first(),
    ).toBeVisible();
  });
});

test.describe('G2 坏账核销', () => {
  test('登记→列表出现→撤销（不动应收）', async ({ page }) => {
    await page.goto('/payment/writeoffs');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('button', { name: /登记核销/ })).toBeVisible();

    await page.getByRole('button', { name: /登记核销/ }).click();
    const modal = page.locator('.ant-modal:visible');
    await expect(modal.getByText('登记坏账核销')).toBeVisible();

    // 结算户搜索选择器（弹窗内第 1 个 select）：输入关键字，等远端结果后回车选中
    await modal.locator('.ant-select').nth(0).click();
    await page.keyboard.type('a');
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').first().waitFor({ timeout: 10_000 });
    await page.keyboard.press('Enter');

    await modal.locator('.ant-input-number input').first().fill('1');
    // 原因下拉：弹窗内第 3 个 select（结算户/用水户/原因）。
    // 上个下拉的退场动画可能造成 :visible 匹配到旧面板——回车选高亮项最稳。
    await modal.locator('.ant-select').nth(2).click();
    await page
      .locator('.ant-select-dropdown:visible .ant-select-item-option')
      .first()
      .waitFor({ timeout: 10_000 });
    await page.keyboard.press('Enter');
    await modal.getByRole('button', { name: /确\s*定|OK/ }).click();
    await page.waitForLoadState('networkidle');

    // 列表出现 ACTIVE 核销行
    const row = page.locator('tr', { hasText: /已核销/ }).first();
    await expect(row).toBeVisible({ timeout: 10_000 });

    // 撤销
    await row.getByRole('button', { name: /撤\s*销/ }).click();
    await page.getByRole('button', { name: /确\s*定|OK|是/ }).first().click();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('tr', { hasText: /已撤销/ }).first()).toBeVisible();
  });

  test('欠费字段：累计列含欠费金额/核销', async ({ page }) => {
    await page.goto('/report/query/unified');
    await page.waitForResponse((r) => r.url().includes('unified/fields'));
    await page.locator('.ant-checkbox-wrapper', { hasText: '欠费金额' }).first().click();
    await page.locator('.ant-checkbox-wrapper', { hasText: '已核销' }).first().click();
    await page.getByRole('button', { name: /查\s*询/ }).click();
    await page.waitForResponse((r) => r.url().includes('/reports/query/unified') && !r.url().includes('fields'));
    const headers = await page.locator('.ant-table thead').innerText();
    expect(headers).toMatch(/欠费金额|已核销/);
  });
});

test.describe('T 工单/异常', () => {
  test('badge 端点返回结构化计数', async ({ page }) => {
    const res = await apiGet(page, '/exceptions/badge');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toBeTruthy();
  });

  test('异常中心可筛选并跳处理页面', async ({ page }) => {
    await page.goto('/exceptions');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.ant-table, .ant-list, .ant-card').first()).toBeVisible();
    // 有「去处理」链接的行则点开验证跳转
    const goBtn = page.getByRole('button', { name: /去处理/ }).or(page.getByRole('link', { name: /去处理/ })).first();
    if (await goBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await goBtn.click();
      await page.waitForLoadState('networkidle');
      expect(page.url()).not.toMatch(/\/exceptions$/);
    }
  });
});

test.describe('10/12 报告回归', () => {
  test('抄表计划明细含上期止度 + 完成读数列（值为读数非 id）', async ({ page }) => {
    await page.goto('/metering/plans');
    await page.waitForLoadState('networkidle');
    const detailBtn = page.getByRole('button', { name: /明\s*细/ }).first();
    await expect(detailBtn).toBeVisible();
    await detailBtn.click();
    await page.waitForLoadState('networkidle');
    const drawer = page.locator('.ant-drawer-open, .ant-modal-open');
    await expect(drawer).toBeVisible();
    const headers = await drawer.locator('.ant-table thead').innerText();
    expect(headers).toContain('上期止度');
    expect(headers).toContain('完成读数');
    // 单元格不得出现 uuid 形态
    const cells = await drawer.locator('.ant-table tbody').innerText();
    expect(cells).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  test('收款详情分摊账单显示人读引用（户号·账期）', async ({ page }) => {
    await page.goto('/payment/payments');
    await page.waitForLoadState('networkidle');
    const detailBtn = page.locator('.ant-table tbody tr').first().getByRole('button');
    await expect(detailBtn).toBeVisible();
    await detailBtn.click();
    await page.waitForLoadState('networkidle');
    const drawer = page.locator('.ant-drawer-open');
    await expect(drawer).toBeVisible();
    const body = await drawer.innerText();
    // 分摊明细的"账单"列应出现 户号 · 账期 形态或空态
    const allocTable = drawer.locator('.ant-table').last();
    if (await allocTable.locator('tbody tr.ant-table-row').count()) {
      const txt = await allocTable.locator('tbody').innerText();
      expect(txt).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}/);
    }
    expect(body).not.toMatch(/账单 ID/);
  });

  test('回收率页：响应含 anomaly 字段且历史清收单列', async ({ page }) => {
    const res = await apiGet(page, '/reports/recovery-rate?period=202609');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('anomaly');
    expect(body).toHaveProperty('priorPeriodCollected');
    // billed<0 或 anomaly 时 rate 必须为 null，不得渲染 >100%
    if (Number(body.billed) <= 0 || body.anomaly) expect(body.rate).toBeNull();
  });
});
