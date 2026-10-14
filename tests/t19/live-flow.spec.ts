import { expect, test } from '@playwright/test';
import { loginUi, shot } from './helpers';

/**
 * T19 · §4.3 图文自检取证 —— .185 实演完整补差链路：
 * 预置：演示户 A202610000002 估抄 202612=400 已出账；锚点 202611=380 PASSED；
 *      待质检读数 202703=390（低于估抄止度）。
 * 覆盖：QC 三段式弹窗 → 补差任务(候选含 admin) → biz 直达上下文横幅 →
 *      结算 409 阻断 → chaobiaohecha1 候选视角 → 核销级联 → 解锁结算。
 */
test.describe.serial('T19 §4.3 实演取证', () => {
  test('07 QC 弹窗生成补差任务（有权限三段式）', async ({ page, request }) => {
    await loginUi(page, 'cd-water', 'cd-water');
    const token = await page.evaluate(() => localStorage.getItem('water-saas.accessToken'));
    const base = process.env.T19_BASE_URL ?? 'http://192.168.3.185:5185';
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    // 自备待质检读数：找一个可用新账期实抄 393 < 估抄止度 400
    const wa2 = '84a43afa-c3e7-4f30-9732-87c3b46cc616';
    const book2 = 'dc5c45e2-301c-4441-ab4b-22557f989fae';
    let period = '';
    for (const p of ['202706','202707','202708','202709','202710','202711','202712','202801','202802','202803','202804','202805','202806','202807','202808','202809','202810','202811','202812']) {
      const gen = await request.post(`${base}/api/reading-plans/generate`, {
        headers,
        data: { bookId: book2, period: p, planDate: `${p.slice(0, 4)}-${p.slice(4)}-01` },
      });
      const pl = await gen.json();
      const planId = pl.id ?? pl.planId;
      if (!planId) continue;
      const items = await (
        await request.get(`${base}/api/reading-plans/${planId}/items`, { headers })
      ).json();
      const item = items.find((i: { waterAccountId: string; status: string }) => i.waterAccountId === wa2 && i.status !== 'READ');
      if (!item) continue;
      const wr = await request.post(`${base}/api/meter-readings`, {
        headers,
        data: {
          planItemId: item.id,
          resultType: 'ACTUAL',
          readingValue: '393',
          readDate: `${p.slice(0, 4)}-${p.slice(4)}-10`,
        },
      });
      if (wr.status() === 201) {
        period = `${p.slice(0, 4)}-${p.slice(4)}`;
        break;
      }
    }
    expect(period, '未能在演示册上补录待质检读数').toBeTruthy();
    await page.goto('/metering/readings');
    const row = page.locator('tr', { hasText: 'A202610000002' }).filter({ hasText: period }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByRole('button', { name: '通过' }).click();
    // 三段式弹窗（admin 持 billing:write → 「请从待办领取」变体）
    const modal = page.locator('.ant-modal-confirm');
    await expect(modal.locator('.ant-modal-confirm-title', { hasText: '已生成【补差任务】' })).toBeVisible();
    await expect(modal.getByText(/待办中心可领取处理/)).toBeVisible();
    await shot(page, '07-qc-modal');
    await modal.getByRole('button', { name: /确\s*定|知道了/ }).click();
    await expect(row.getByText('质检通过')).toBeVisible({ timeout: 10_000 });
  });

  test('08 补差任务详情：候选人含 admin', async ({ page }) => {
    await loginUi(page, 'cd-water', 'cd-water');
    await page.goto('/tasks');
    const row = page.locator('tr', { hasText: '补差任务' }).filter({ hasText: 'A202610000002' }).first();
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: '详情' }).click();
    const drawer = page.locator('.ant-drawer-open');
    await expect(drawer.getByText('候选责任人')).toBeVisible();
    await expect(drawer.getByText(/管理员/)).toBeVisible();
    await expect(drawer.getByText(/估计止度|实抄止度/)).toBeVisible();
    await shot(page, '08-supplement-detail');
    // biz 直达 → 页顶任务上下文横幅（T8）
    await drawer.getByRole('button', { name: '前往业务页处理' }).click();
    await expect(page).toHaveURL(/\/settlement\/reconciliations/);
    await expect(page.getByText('来自待办任务')).toBeVisible({ timeout: 10_000 });
    await shot(page, '08b-biz-context-banner');
  });

  test('09 结算被未完成任务阻断（409）', async ({ page }) => {
    await loginUi(page, 'cd-water', 'cd-water');
    await page.goto('/settlement/list');
    await page.getByRole('button', { name: /生成结算/ }).first().click();
    const modal = page.locator('.ant-modal', { hasText: '生成结算（草稿）' });
    await expect(modal).toBeVisible();
    // 先选客户，再选用水户
    await modal.locator('.ant-select').nth(0).click();
    await modal.locator('.ant-select input').nth(0).fill('任务演示户-催缴');
    await page.waitForTimeout(800);
    await page.locator('.ant-select-item-option', { hasText: '任务演示户-催缴' }).first().click();
    await page.waitForTimeout(500);
    await modal.locator('.ant-select').nth(1).click();
    await modal.locator('.ant-select input').nth(1).fill('A202610000002');
    await page.waitForTimeout(800);
    await page.locator('.ant-select-item-option', { hasText: 'A202610000002' }).first().click();
    // 账期 2027-05
    await modal.locator('.ant-picker input').click();
    await modal.locator('.ant-picker input').fill('2027-06');
    await page.keyboard.press('Enter');
    await page.locator('.ant-modal-title', { hasText: '生成结算' }).click();
    await page.waitForTimeout(300);
    await shot(page, '09-settle-form');
    await modal.locator('button.ant-btn-primary', { hasText: /生\s*成/ }).click();
    // 409 阻断文案：含任务类型 + 候选责任人 + 自动解锁说明
    await expect(page.getByText(/未完成的【补差任务】/)).toBeVisible({ timeout: 10_000 });
    await shot(page, '09b-settle-blocked');
  });

  test('10 chaobiaohecha1 候选视角待办可见', async ({ page }) => {
    await loginUi(page, 'cd-water', 'cd-water-cbhc');
    await page.goto('/tasks');
    const row = page.locator('tr', { hasText: '补差任务' }).filter({ hasText: 'A202610000002' }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByRole('button', { name: '领取' })).toBeVisible();
    await shot(page, '10-cbhc-todo');
  });

  test('11 核销应用 → 任务级联完成 → 结算解锁', async ({ page, request }) => {
    await loginUi(page, 'cd-water', 'cd-water');
    const token = await page.evaluate(() => localStorage.getItem('water-saas.accessToken'));
    const base = process.env.T19_BASE_URL ?? 'http://192.168.3.185:5185';
    // 核销：span (202611 锚点, 202703 实读] 覆盖已出账估抄 202612
    const res = await request.post(`${base}/api/reconciliations`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: {
        waterAccountId: '84a43afa-c3e7-4f30-9732-87c3b46cc616',
        actualReadingId: 'e3681fda-5bcb-476e-af23-4d4a20b8069b',
      },
    });
    expect(res.status()).toBe(201);
    // 已办箱出现该补差任务（级联完成）
    await page.goto('/tasks?box=done');
    await page.getByRole('tab', { name: '已办' }).click();
    const row = page.locator('tr', { hasText: '补差任务' }).filter({ hasText: 'A202610000002' }).first();
    await expect(row).toBeVisible();
    await expect(row.getByText('已完成')).toBeVisible();
    await shot(page, '11-supplement-done');
    // 解锁：重试同路径结算 → 成功
    await page.goto('/settlement/list');
    await page.getByRole('button', { name: /生成结算/ }).first().click();
    const modal = page.locator('.ant-modal', { hasText: '生成结算（草稿）' });
    await modal.locator('.ant-select').nth(0).click();
    await modal.locator('.ant-select input').nth(0).fill('任务演示户-催缴');
    await page.waitForTimeout(800);
    await page.locator('.ant-select-item-option', { hasText: '任务演示户-催缴' }).first().click();
    await page.waitForTimeout(500);
    await modal.locator('.ant-select').nth(1).click();
    await modal.locator('.ant-select input').nth(1).fill('A202610000002');
    await page.waitForTimeout(800);
    await page.locator('.ant-select-item-option', { hasText: 'A202610000002' }).first().click();
    await modal.locator('.ant-picker input').click();
    await modal.locator('.ant-picker input').fill('2027-06');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    // 202705 无实读 → 预估路径，需填用量与原因
    await modal.getByPlaceholder('如 12.5').fill('10');
    await modal.getByPlaceholder(/连续两月未抄见/).fill('表井积水');
    await modal.getByRole('button', { name: '生成', exact: true }).click();
    await expect(page.getByText('结算已生成（草稿）')).toBeVisible({ timeout: 10_000 });
    await shot(page, '11b-settle-unlocked');
  });
});
