import { test, expect } from '@playwright/test';
import { apiJson, collectRuntimeErrors, loginApi, loginUi } from './helpers';

test.describe('UAT core business happy path', () => {
  test('C→D→E→G→H→I: UI completes 12m³ × 3.00 = ¥36.00 chain', async ({ page, request }) => {
    const runtime = collectRuntimeErrors(page);
    const auth = await loginApi(request);
    const stamp = Date.now().toString(36);
    const usageCategory = `UAT-${stamp}`;
    const customerName = `UAT客户-${stamp}`;
    const period = '202609';

    // Fixture: one active ¥3.00/m³ tariff for the unique UAT usage category.
    const feeItems = await apiJson<any[]>(request, 'get', '/fee-items', auth);
    const waterItem = feeItems.find((x) => x.code === 'WATER') ?? feeItems[0];
    expect(waterItem?.id).toBeTruthy();
    const tariff = await apiJson<any>(request, 'post', '/tariff-plans', auth, {
      code: `UAT-TARIFF-${stamp}`,
      name: `UAT 3元水价 ${stamp}`,
      usageCategory,
      effectiveFrom: '2026-01-01',
      tiers: [
        {
          feeItemId: waterItem.id,
          tierNo: 1,
          fromQty: 0,
          toQty: null,
          unitPrice: '3.000000',
        },
      ],
    });
    await apiJson(request, 'post', `/tariff-plans/${tariff.id}/activate`, auth, {});

    // C01/C02: create the household through the actual UI.
    await loginUi(page);
    await page.goto('/customer/onboard');
    await page.getByLabel('客户名称').fill(customerName);
    await page.getByRole('button', { name: '下一步' }).click();
    await expect(page.getByText('系统将按客户的姓名与联系电话自动开立同名结算户。')).toBeVisible();
    await page.getByRole('button', { name: '下一步' }).click();
    await page.getByLabel('用水类别').fill(usageCategory);
    await page.getByLabel('用水地址').fill('UAT 测试路 1 号');
    await page.getByRole('button', { name: '下一步' }).click();
    await page.getByLabel('装表初始读数').fill('0');

    const onboardRespP = page.waitForResponse(
      (r) => r.url().includes('/api/water-accounts/onboard') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '提交立户' }).click();
    const onboardResp = await onboardRespP;
    expect(onboardResp.ok(), await onboardResp.text()).toBeTruthy();
    const onboard = await onboardResp.json();
    await expect(page.getByText('立户完成')).toBeVisible();

    // D01-D03 fixture via API; the UI then drives start/read/QC.
    const orgs = await apiJson<any[]>(request, 'get', '/iam/orgs', auth);
    expect(orgs.length).toBeGreaterThan(0);
    const book = await apiJson<any>(request, 'post', '/reading-books', auth, {
      name: `UAT抄表册-${stamp}`,
      orgUnitId: orgs[0].id,
      scheduleDay: 19,
    });
    await apiJson(request, 'post', `/reading-books/${book.id}/meters`, auth, {
      waterAccountId: onboard.waterAccount.id,
    });
    const plan = await apiJson<any>(request, 'post', '/reading-plans/generate', auth, {
      bookId: book.id,
      period,
      planDate: '2026-09-19',
    });

    // D04/D05: start plan and enter a real reading from the UI.
    await page.goto('/metering/plans');
    await expect(page.locator('.ant-table-row')).toHaveCount(1);
    await page.getByRole('button', { name: '开始' }).click();
    await expect(page.getByText('计划已开始')).toBeVisible();
    await page.getByRole('button', { name: '明细' }).click();
    await expect(page.getByText(/计划明细/)).toBeVisible();
    await page.getByRole('button', { name: '录入' }).click();
    await page.getByLabel('表码读数').fill('12');
    await page.getByRole('button', { name: '提交' }).click();
    await expect(page.getByText('抄表记录已录入')).toBeVisible();

    // D08: QC from the dedicated QC page.
    const planItemId = plan.items[0].id;
    await page.goto('/metering/readings');
    await page.getByPlaceholder('计划明细 ID').fill(planItemId);
    await page.getByPlaceholder('计划明细 ID').press('Enter');
    await expect(page.locator('.ant-table-row')).toHaveCount(1);
    await page.getByRole('button', { name: '通过' }).click();
    await expect(page.getByText('质检已通过')).toBeVisible();

    // E01: generate settlement from the now-PASSED reading; E02 finalize from UI.
    const settlement = await apiJson<any>(request, 'post', '/consumption-settlements', auth, {
      waterAccountId: onboard.waterAccount.id,
      period,
    });
    expect(Number(settlement.totalUsageQty)).toBe(12);
    await page.goto('/settlement/list');
    await page.getByRole('button', { name: '终审' }).click();
    await page.getByRole('button', { name: '终审', exact: true }).last().click();
    await expect(page.getByText(/结算已终审/)).toBeVisible();

    // G02: make the run via API so UI verifies/executes the posting action.
    const run = await apiJson<any>(request, 'post', '/billing-runs', auth, { period });
    expect(run.bills).toHaveLength(1);
    expect(String(run.bills[0].totalAmount)).toBe('3600');

    await page.goto('/billing/runs');
    await page.getByRole('button', { name: '执行开账' }).click();
    await page.getByRole('button', { name: '执行', exact: true }).last().click();
    await expect(page.getByText(/开账完成/)).toBeVisible();

    const beforePay = await apiJson<any>(
      request,
      'get',
      `/water-accounts/${onboard.waterAccount.id}/outstanding`,
      auth,
    );
    expect(String(beforePay.totalOutstanding)).toBe('3600');

    // H01-H03/H07: query the debt and take payment entirely through the UI.
    await page.goto('/payment/counter');
    await page.getByPlaceholder('先选客户').click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: customerName }).click();
    await page.getByPlaceholder('再选水表户').click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').first().click();
    await expect(page.getByText('合计欠费（净额）')).toBeVisible();
    await expect(page.getByText('36.00', { exact: false })).toBeVisible();

    const amountInput = page.locator('.ant-input-number-input').first();
    await amountInput.fill('36');
    await page.getByRole('button', { name: '自动分摊' }).click();
    await expect(page.getByText('¥36.00', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: /收款.*36\.00/ }).click();
    await expect(page.getByText(/收款完成/)).toBeVisible();
    await page.getByRole('button', { name: '打印票据' }).click();
    await expect(page.getByText('已打印')).toBeVisible();

    const afterPay = await apiJson<any>(
      request,
      'get',
      `/water-accounts/${onboard.waterAccount.id}/outstanding`,
      auth,
    );
    expect(String(afterPay.totalOutstanding)).toBe('0');

    // H08: cashier day close from UI.
    await page.goto('/payment/day-close');
    await page.getByRole('button', { name: '执行日结' }).click();
    await page.getByRole('button', { name: '日结', exact: true }).click();
    await expect(page.getByText(/日结完成/)).toBeVisible();

    // I02-I05 smoke + visible collection amount.
    await page.goto('/report/collected-monthly');
    await page.getByRole('button', { name: '查询' }).click();
    await expect(page.getByText('实收合计')).toBeVisible();
    await expect(page.getByText('¥36.00', { exact: false })).toBeVisible();

    for (const path of [
      '/report/meter-daily',
      '/report/cashier-daily',
      '/report/ar-monthly',
      '/report/recovery-rate',
    ]) {
      await page.goto(path);
      await page.getByRole('button', { name: '查询' }).click();
      await expect(page.locator('.ant-card')).toBeVisible();
    }

    expect(runtime.filter((e) => e.startsWith('pageerror'))).toEqual([]);
  });
});
