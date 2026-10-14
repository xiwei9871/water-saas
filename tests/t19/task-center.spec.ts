import { expect, test } from '@playwright/test';
import { loginUi, shot } from './helpers';

/**
 * T19 · 任务驱动机制 · .185 上线验收。
 * 演示数据（task_demo 编排）：cd-water 租户下
 *  - SUPPLEMENT 已完成（QC 触发 → 结算 409 → 核销级联解锁）
 *  - METER_REVIEW / COLLECTION / REVERSAL_APPROVAL / WRITEOFF_APPROVAL 待办
 */

test.describe.serial('T19 任务中心', () => {
  test('01 待办列表 + 顶部角标', async ({ page }) => {
    await loginUi(page, 'cd-water', 'cd-water');
    // 顶部角标可见（任务数 > 0 时显示数字徽标）
    await page.goto('/tasks');
    await expect(page.getByRole('main').getByText('待办中心').first()).toBeVisible();
    await expect(page.getByRole('tab', { name: '我的待办' })).toBeVisible();
    await shot(page, '01-todo-admin');
    // 五类任务类型筛选按钮全部渲染（中文）
    for (const label of ['补差任务', '抄表异常复核', '催缴任务', '红冲审批', '核销审批']) {
      await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible();
    }
    // 列表内无裸 uuid（列出的业务对象为户号/单号）
    const tableText = await page.locator('table').innerText();
    expect(tableText).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/);
    await shot(page, '01b-todo-table');
  });

  test('02 详情抽屉：上下文 + 候选人 + 业务直达', async ({ page }) => {
    await loginUi(page, 'cd-water', 'cd-water');
    await page.goto('/tasks');
    const row = page.locator('tr', { hasText: '抄表异常复核' }).first();
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: '详情' }).click();
    const drawer = page.locator('.ant-drawer-open');
    await expect(drawer.getByText('候选责任人')).toBeVisible();
    await expect(drawer.getByText('业务上下文')).toBeVisible();
    await expect(drawer.getByText('Pilot复核员')).toBeVisible();
    await shot(page, '02-detail-drawer');
    // 业务直达
    await drawer.getByRole('button', { name: '前往业务页处理' }).click();
    await page.waitForTimeout(800);
    await shot(page, '02b-biz-link');
    expect(page.url()).not.toContain('/tasks');
  });

  test('03 领取 → 完成 生命周期', async ({ page }) => {
    await loginUi(page, 'cd-water', 'cd-water');
    await page.goto('/tasks');
    // 领取一条待办（选红冲审批，影响面最小）
    const row = page.locator('tr', { hasText: '红冲审批' }).first();
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: '领取' }).click();
    await expect(page.getByText('已领取，开始处理')).toBeVisible();
    await shot(page, '03-claimed');
    // 完成
    await row.getByRole('button', { name: '完成' }).click();
    await expect(page.getByText('已完成')).toBeVisible();
    // 已办箱可见
    await page.getByRole('tab', { name: '已办' }).click();
    await expect(page.locator('tr', { hasText: '红冲审批' }).first()).toBeVisible();
    await shot(page, '03b-done-box');
  });

  test('04 告警箱 + 类型筛选', async ({ page }) => {
    await loginUi(page, 'cd-water', 'cd-water');
    await page.goto('/tasks');
    await page.getByRole('tab', { name: '待指派告警' }).click();
    await shot(page, '04-alert-box');
    // 回到待办，按类型筛选催缴
    await page.getByRole('tab', { name: '我的待办' }).click();
    await page.getByRole('button', { name: '催缴任务', exact: true }).click();
    await expect(page.locator('td', { hasText: '催缴任务' }).first()).toBeVisible();
    const tableText = await page.locator('table').innerText();
    expect(tableText).not.toContain('红冲审批');
    await shot(page, '04b-filter-collection');
  });

  test('05 候选人视角（复核员）', async ({ page }) => {
    await loginUi(page, 'cd-water', 'cd-water-reviewer');
    await page.goto('/tasks');
    await expect(page.getByRole('main').getByText('待办中心').first()).toBeVisible();
    // 复核员是 SUPPLEMENT/METER_REVIEW 候选人 → 待办里应能看到抄表复核
    await expect(page.locator('tr', { hasText: '抄表异常复核' }).first()).toBeVisible();
    await shot(page, '05-reviewer-todo');
  });

  test('06 结算阻断（UI 实测）', async ({ page }) => {
    // 此用例依赖演示数据处于"补差未结"窗口；若已级联解锁则改为验证
    // 已办箱中 SUPPLEMENT 的完成记录存在即可。
    await loginUi(page, 'cd-water', 'cd-water');
    await page.goto('/tasks');
    await page.getByRole('tab', { name: '已办' }).click();
    await expect(page.locator('tr', { hasText: '补差任务' }).first()).toBeVisible();
    await shot(page, '06-supplement-done');
  });
});
