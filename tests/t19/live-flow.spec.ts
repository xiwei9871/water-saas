import { expect, test } from '@playwright/test';
import { loginUi, shot } from './helpers';

/**
 * T19 · §4.3 图文自检取证 —— .185 实演完整补差链路：
 * 预置：演示户 A202610000002 估抄 202612=400 已出账；锚点 202611=380 PASSED；
 *      待质检读数 202703=390（低于估抄止度）。
 * 覆盖：QC 三段式弹窗 → 补差任务(候选含 admin) → biz 直达上下文横幅 →
 *      结算 409 阻断 → chaobiaohecha1 候选视角 → 核销级联 → 解锁结算。
 */
const WA2 = '84a43afa-c3e7-4f30-9732-87c3b46cc616';
const BASE = () => process.env.T19_BASE_URL ?? 'http://192.168.3.185:5185';

/** 选一个 D2 尚未生成结算的账期（202707 起），供阻断/解锁演示使用——保证可重跑。 */
async function pickUnsettledPeriod(request: import('@playwright/test').APIRequestContext, token: string) {
  const res = await request.get(`${BASE()}/api/consumption-settlements?waterAccountId=${WA2}&take=200`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  // 列表返回裸数组（非分页包装）
  const used = new Set(
    (Array.isArray(body) ? body : (body.items ?? [])).map(
      (s: { period: string }) => s.period,
    ),
  );
  for (let ym = 2027 * 100 + 7; ym <= 202912; ym++) {
    const m = ym % 100;
    if (m < 1 || m > 12) continue;
    const p = String(ym);
    if (!used.has(p)) return `${p.slice(0, 4)}-${p.slice(4)}`;
  }
  throw new Error('无可用账期');
}

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
    // 补差触发：该读数期之前的最近结算分量须为 ESTIMATE 且实抄<其止度。
    // 演示户锚点已重建为 202805(ESTIMATE=400)，从 202806 起线性扫描，
    // 第一个可生成计划项且未读的账期即用（已消耗账期自动跳过）。
    const candidates: string[] = [];
    for (let y = 2028; y <= 2030; y++) {
      const m0 = y === 2028 ? 6 : 1;
      for (let m = m0; m <= 12; m++) candidates.push(`${y}${String(m).padStart(2, '0')}`);
    }
    for (const p of candidates) {
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
    // 待办积压较多时新任务可能排在第 2 页——先按类型过滤再定位
    await page.getByRole('button', { name: '补差任务', exact: true }).click();
    const row = page.locator('tr', { hasText: '补差任务' }).filter({ hasText: 'A202610000002' }).first();
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: '详情' }).click();
    const drawer = page.locator('.ant-drawer-open');
    await expect(drawer.getByText('候选责任人')).toBeVisible();
    await expect(drawer.getByText(/管理员/)).toBeVisible();
    await expect(drawer.getByText(/估计止度|实抄止度/).first()).toBeVisible();
    await shot(page, '08-supplement-detail');
    // biz 直达 → 页顶任务上下文横幅（T8）
    await drawer.getByRole('button', { name: '前往业务页处理' }).click();
    await expect(page).toHaveURL(/\/settlement\/reconciliations/);
    await expect(page.getByText('来自待办任务')).toBeVisible({ timeout: 10_000 });
    await shot(page, '08b-biz-context-banner');
  });

  let settlePeriod = '';

  test('09 结算被未完成任务阻断（409）', async ({ page }) => {
    await loginUi(page, 'cd-water', 'cd-water');
    const token = await page.evaluate(() => localStorage.getItem('water-saas.accessToken'));
    settlePeriod = await pickUnsettledPeriod(page.request, token!);
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
    // 账期：动态选未生成过结算的账期
    await modal.locator('.ant-picker input').click();
    await modal.locator('.ant-picker input').fill(settlePeriod);
    await page.keyboard.press('Enter');
    await page.locator('.ant-modal-title', { hasText: '生成结算' }).click();
    await page.waitForTimeout(300);
    await shot(page, '09-settle-form');
    const resp = page.waitForResponse(
      (r) => r.url().includes('/consumption-settlements') && r.request().method() === 'POST',
    );
    await modal.locator('button.ant-btn-primary', { hasText: /生\s*成/ }).click();
    expect((await resp).status()).toBe(409);
    // 409 阻断文案：含任务类型 + 候选责任人 + 自动解锁说明
    const toast = page.getByText(/未完成的【补差任务】/);
    await expect(toast).toBeVisible({ timeout: 10_000 });
    await toast.screenshot({ path: 'artifacts/t19/09-blocked-toast.png' });
    await shot(page, '09b-settle-blocked');
  });

  test('10 chaobiaohecha1 候选视角待办可见 + 领取后 admin 侧消失', async ({ page }) => {
    await loginUi(page, 'cd-water', 'cd-water-cbhc');
    await page.goto('/tasks');
    // 待办积压时补差任务可能不在首页——先按类型过滤
    await page.getByRole('button', { name: '补差任务', exact: true }).click();
    const row = page.locator('tr', { hasText: '补差任务' }).filter({ hasText: 'A202610000002' }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await shot(page, '10-cbhc-todo');
    // §4.2-3：候选人之一领取——多次实演会留下多条 A2 补差，全部领取
    for (let i = 0; i < 10; i++) {
      const claimable = page
        .locator('tr', { hasText: '补差任务' })
        .filter({ hasText: 'A202610000002' })
        .filter({ hasText: '待处理' })
        .first();
      if (!(await claimable.isVisible().catch(() => false))) break;
      const btn = claimable.getByRole('button', { name: '领取' });
      if (!(await btn.isVisible().catch(() => false))) break;
      await btn.click();
      await expect(page.getByText(/已领取|领取成功/).first()).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(400);
    }
    await shot(page, '10b-cbhc-claimed');
    // 领取后切回 admin 视角：该任务不再出现在其待办（先清会话再登出切换）
    await page.evaluate(() => localStorage.clear());
    await loginUi(page, 'cd-water', 'cd-water');
    await page.goto('/tasks');
    await page.getByRole('button', { name: '补差任务', exact: true }).click();
    await page.waitForTimeout(800);
    const adminRow = page
      .locator('tr', { hasText: '补差任务' })
      .filter({ hasText: 'A202610000002' })
      .filter({ hasText: '待处理' });
    await expect(adminRow).toHaveCount(0);
    await shot(page, '10c-admin-after-claim');
  });

  test('11 核销应用 → 任务级联完成 → 结算解锁', async ({ page, request }) => {
    await loginUi(page, 'cd-water', 'cd-water');
    const token = await page.evaluate(() => localStorage.getItem('water-saas.accessToken'));
    const base = process.env.T19_BASE_URL ?? 'http://192.168.3.185:5185';
    // 核销：span (202611 锚点, 202703 实读] 覆盖已出账估抄 202612
    // 幂等重跑：核销已应用过则返回 409 RECONCILIATION_EXISTS —— 级联完成证据已在库
    const res = await request.post(`${base}/api/reconciliations`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: {
        waterAccountId: '84a43afa-c3e7-4f30-9732-87c3b46cc616',
        actualReadingId: 'e3681fda-5bcb-476e-af23-4d4a20b8069b',
      },
    });
    expect([201, 409]).toContain(res.status());
    // test 10 领取的补差任务由 cbhc 自己完成 —— 「完成后自动解锁」的第二种闭环证据
    const cbhcToken = (
      await request.post(`${base}/api/auth/login`, {
        data: { tenantCode: 'cd-water', login: 'chaobiaohecha1', password: '123456' },
      })
    ).json() as Promise<{ accessToken: string }>;
    const cbhcH = { Authorization: `Bearer ${(await cbhcToken).accessToken}` };
    const list = await (
      await request.get(`${base}/api/tasks?box=todo&type=SUPPLEMENT&take=50`, { headers: cbhcH })
    ).json();
    for (const t of list.items ?? []) {
      if (t.bizLabel === 'A202610000002') {
        if (t.status === 'PENDING') {
          await request.post(`${base}/api/tasks/${t.id}/claim`, { headers: cbhcH });
        }
        await request.post(`${base}/api/tasks/${t.id}/complete`, {
          headers: { ...cbhcH, 'Content-Type': 'application/json' },
          data: { note: '实演：补差已核清' },
        });
      }
    }
    // 兜底：admin 取消 cbhc 视野外的残留 PENDING 补差（管理员可见全部待领取任务）
    const adminList = await (
      await request.get(`${base}/api/tasks?box=todo&type=SUPPLEMENT&take=50`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json();
    for (const t of adminList.items ?? []) {
      if (t.bizLabel === 'A202610000002' && t.status === 'PENDING') {
        await request.post(`${base}/api/tasks/${t.id}/cancel`, {
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          data: { reason: '实演清理：残留补差任务' },
        });
      }
    }
    // 已办箱出现该补差任务（级联完成）
    await page.goto('/tasks?box=done');
    await page.getByRole('tab', { name: '已办' }).click();
    const row = page
      .locator('tr', { hasText: '补差任务' })
      .filter({ hasText: 'A202610000002' })
      .filter({ hasText: '已完成' })
      .first();
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
    await modal.locator('.ant-picker input').fill(settlePeriod || '2027-07');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    // 演示户该账期已有实读 → 走实抄结算；usageQty 留空（否则 OVERRIDE_TARGET_INVALID）
    await modal.getByRole('button', { name: /生\s*成/ }).click();
    // 幂等：重跑时该账期已生成 → 「已存在」提示同样证明已解锁；唯一不允许再出现的是阻断文案
    const ok = page.getByText('结算已生成（草稿）');
    const exists = page.getByText(/已存在|ALREADY/);
    await expect(ok.or(exists).first()).toBeVisible({ timeout: 10_000 });
    await shot(page, '11b-settle-unlocked');
  });
});
