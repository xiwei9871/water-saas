import { test, expect } from './helpers/console';
import { login, ready } from './helpers/auth';
import { cleanPeriod, db } from './helpers/fixture';
import { button, date, evidence, main, response, row, select } from './helpers/ui';

test.describe.configure({ mode: 'serial' });
test('C D E G H I K03 K04 K06 K08 K09 complete UI 12m³ × 3.00 = ¥36.00', async ({ page }, info) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const category = `UAT_RES_${stamp}`;
  const customerName = `UAT客户-${stamp}`;
  const bookName = `UAT抄表册-${stamp}`;
  const period = await cleanPeriod();
  const month = period.slice(0, 4) + '-' + period.slice(4);
  const data: Record<string, any> = { stamp, category, customerName, bookName, period };
  const completed: string[] = [];
  async function step(name: string, fn: () => Promise<void>) {
    await test.step(name, async () => {
      console.log('UAT STEP ' + name);
      await fn(); completed.push(name);
      await evidence(page, info, name, data[name]);
    });
  }
  await login(page);
  try {
    await step('Tariff', async () => {
      await page.goto('/billing/tariffs'); await ready(page);
      await page.getByRole('button', { name: '新建资费方案' }).click();
      const dialog = page.getByRole('dialog', { name: '新建资费方案' });
      await dialog.getByLabel('编码', { exact: true }).fill(category);
      await dialog.getByLabel('名称', { exact: true }).fill('UAT居民单价');
      await dialog.getByLabel('用水类别', { exact: true }).fill(category);
      await date(dialog.getByLabel('生效日期', { exact: true }), '2026-01-01');
      await select(page, dialog.getByText('选择费用项（每组一套阶梯）', { exact: true }), '水费（WATER · 按量计价）');
      await dialog.getByPlaceholder('起始量', { exact: true }).fill('0');
      await dialog.getByPlaceholder('单价(元/m³)').fill('3.000000');
      data.Tariff = await response(page, '/tariff-plans', () => button(dialog, '保存').click());
      expect(data.Tariff.status).toBe('DRAFT');
      const tariffRow = row(page, category);
      await expect(tariffRow).toContainText('草稿');
      await button(tariffRow, '激活').click();
      await response(page, `/tariff-plans/${data.Tariff.id}/activate`, () => button(page.getByRole('tooltip'), '激活').click());
      await expect(tariffRow).toContainText('生效中');
    });
    await step('Onboard', async () => {
      await page.goto('/customer/onboard');
      await page.getByLabel('客户名称', { exact: true }).fill(customerName);
      await expect(main(page)).toContainText('个人');
      await page.getByRole('button', { name: '下一步' }).click();
      await expect(page.getByText('系统将按客户的姓名与联系电话自动开立同名结算户。')).toBeVisible();
      await page.getByRole('button', { name: '下一步' }).click();
      await page.getByLabel('用水类别', { exact: true }).fill(category);
      await page.getByLabel('用水地址', { exact: true }).fill('UAT测试地址');
      await page.getByRole('button', { name: '下一步' }).click();
      await page.getByLabel('装表初始读数').fill('0');
      await expect(main(page)).toContainText('新装');
      data.Onboard = await response(page, '/water-accounts/onboard', () => page.getByRole('button', { name: '提交立户' }).click());
      const d = data.Onboard;
      for (const value of [d.customer.customerNo, d.settleAccount.settleNo, d.waterAccount.accountNo, d.meter.meterNo])
        await expect(main(page)).toContainText(value);
      expect(d.meter.status).toBe('INSTALLED'); expect(d.installation.status).toBe('ACTIVE');
      await expect(main(page).getByText('立户完成', { exact: true })).toBeVisible();
    });
    await step('Book', async () => {
      await page.goto('/metering/books'); await ready(page);
      await page.getByRole('button', { name: '新建抄表册' }).click();
      const dialog = page.getByRole('dialog', { name: '新建抄表册' });
      await dialog.getByLabel('册名').fill(bookName);
      await select(page, dialog.locator('.ant-form-item').filter({ hasText: '所属组织' }).getByRole('combobox'), '成都水务公司');
      data.Book = await response(page, '/reading-books', () => button(dialog, '保存').click());
      await button(row(page, bookName), '成员').click();
      const drawer = page.getByRole('dialog');
      await select(page, drawer.getByText('先选客户', { exact: true }), `${customerName}（${data.Onboard.customer.customerNo}）`);
      await select(page, drawer.getByText('选择水表户', { exact: true }), `${data.Onboard.waterAccount.accountNo} · ${category} · UAT测试地址`);
      await response(page, `/reading-books/${data.Book.id}/meters`, () => button(drawer, '加入').click());
      await expect(drawer).toContainText('共 1 户');
      await expect(drawer.getByRole('row').filter({ hasText: data.Onboard.waterAccount.accountNo })).toHaveCount(1);
    });
    await step('Plan', async () => {
      await page.goto('/metering/plans'); await ready(page);
      await page.getByRole('button', { name: '生成计划' }).click();
      const dialog = page.getByRole('dialog', { name: '生成抄表计划' });
      await select(page, dialog.getByText('搜索抄表册名称', { exact: true }), `${bookName}（${data.Book.bookNo}）`);
      await date(dialog.getByLabel('账期', { exact: true }), month);
      // Real rapid double click, no mocked/intercepted response. Confirm one server document afterwards.
      data.Plan = await response(page, '/reading-plans/generate', () => button(dialog, '生成').dblclick());
      const planRow = row(page, bookName);
      await expect(planRow).toContainText('待开始');
      await button(planRow, '明细').click();
      let drawer = page.getByRole('dialog');
      await expect(drawer).toContainText('待抄 1'); await expect(drawer).toContainText('共 1');
      await drawer.getByRole('button', { name: 'Close', exact: true }).click();
      await button(planRow, '开始').click(); await expect(planRow).toContainText('进行中');
      await page.reload(); await ready(page); await expect(row(page, bookName)).toContainText('进行中');
      const count = await db(p => p.readingPlan.count({ where: { bookId: data.Book.id, period } }));
      expect(count).toBe(1);
      await button(row(page, bookName), '明细').click();
    });
    await step('Reading', async () => {
      await button(page.getByRole('dialog'), '录入').click();
      const dialog = page.getByRole('dialog', { name: /抄表录入/ });
      await expect(dialog.getByRole('radio', { name: '实抄', exact: true })).toBeChecked();
      await dialog.getByLabel('表码读数').fill('12');
      data.Reading = await response(page, '/meter-readings', () => button(dialog, '提交').click());
      await expect(page.getByRole('dialog').getByRole('row').filter({ hasText: data.Onboard.waterAccount.accountNo })).toContainText('已抄');
    });
    await step('QC', async () => {
      await page.goto('/metering/readings'); await ready(page);
      const readingRow = page.getByRole('row').filter({ hasText: '待质检' });
      await expect(readingRow).toHaveCount(1);
      await expect(readingRow).toContainText('实抄'); await expect(readingRow).toContainText('12');
      await button(readingRow, '通过').click();
      await expect(page.getByRole('row').filter({ hasText: '质检通过' })).toHaveCount(1);
    });
    await step('Settlement', async () => {
      await page.goto('/settlement/list'); await ready(page);
      await page.getByRole('button', { name: '生成结算' }).click();
      const dialog = page.getByRole('dialog', { name: '生成结算（草稿）' });
      await select(page, dialog.getByText('搜索客户名称', { exact: true }), `${customerName}（${data.Onboard.customer.customerNo}）`);
      await select(page, dialog.getByText('选择水表户', { exact: true }), `${data.Onboard.waterAccount.accountNo} · ${category} · UAT测试地址`);
      await date(dialog.getByLabel('账期', { exact: true }), month);
      data.Settlement = await response(page, '/consumption-settlements', () => button(dialog, '生成').click());
      expect(Number(data.Settlement.totalUsageQty)).toBe(12); expect(data.Settlement.status).toBe('DRAFT');
      const settlementRow = row(page, data.Onboard.waterAccount.accountNo);
      await expect(settlementRow).toContainText('草稿'); await expect(settlementRow).toContainText('实读'); await expect(settlementRow).toContainText('12');
      await button(settlementRow, '详情').click();
      const drawer = page.getByRole('dialog');
      await expect(drawer.getByRole('row').filter({ hasText: '实读' })).not.toHaveCount(0);
      expect(data.Settlement.components.some((c: any) => c.sourceType === 'READING')).toBeTruthy();
      await drawer.getByRole('button', { name: 'Close', exact: true }).click();
      await button(settlementRow, '终审').click();
      await expect(page.getByText('终审后不可修改；错误终审通过补差处理。')).toBeVisible();
      await button(page.getByRole('tooltip'), '终审').click();
      await expect(settlementRow).toContainText('已终审');
      await page.reload(); await ready(page); await expect(row(page, data.Onboard.waterAccount.accountNo)).toContainText('已终审');
    });
    await step('Billing', async () => {
      await page.goto('/billing/runs'); await ready(page);
      await page.getByRole('button', { name: '新建开账批次' }).click();
      const dialog = page.getByRole('dialog', { name: '新建开账批次' });
      await date(dialog.getByLabel('账期', { exact: true }), month);
      data.Billing = await response(page, '/billing-runs', () => button(dialog, '生成').click());
      expect(data.Billing.bills).toHaveLength(1); expect(data.Billing.bills[0].status).toBe('DRAFT');
      expect(String(data.Billing.bills[0].totalAmount)).toBe('3600');
      const runRow = row(page, month);
      await page.getByRole('button', { name: '执行开账' }).click();
      await button(page.getByRole('tooltip'), '执行').click();
      await expect(runRow).toContainText('已过账');
      await expect(runRow.getByRole('cell').nth(3)).toHaveText('101');
      await button(runRow, '详情').click();
      await expect(page.getByRole('dialog')).toContainText('¥36.00');
      await expect(page.getByRole('dialog').getByRole('row').filter({ hasText: '¥36.00' })).toContainText('已出账');
    });
    await step('Payment', async () => {
      await page.goto('/payment/counter'); await ready(page);
      await select(page, main(page).getByText('先选客户', { exact: true }), `${customerName}（${data.Onboard.customer.customerNo}）`);
      await select(page, main(page).getByText('再选水表户', { exact: true }), `${data.Onboard.waterAccount.accountNo} · ${category} · UAT测试地址`);
      await expect(main(page).locator('.ant-statistic').filter({ hasText: '合计欠费（净额）' })).toContainText('36.00');
      // Form label is visually present but not bound to an input; semantic visible-label container fallback.
      await main(page).locator('.ant-form-item').filter({ hasText: '自动分摊总额（元）' }).getByRole('spinbutton').fill('36.00');
      await page.getByRole('button', { name: '自动分摊' }).click();
      await expect(main(page).locator('.ant-form-item').filter({ hasText: '分摊合计' })).toContainText('¥36.00');
      await expect(main(page).locator('.ant-form-item').filter({ hasText: '收款渠道' })).toContainText('现金');
      data.Payment = await response(page, '/payments', () => page.getByRole('button', { name: /收款.*36\.00/ }).dblclick());
      expect(String(data.Payment.amount)).toBe('3600'); expect(data.Payment.channel).toBe('CASH');
      await expect(main(page)).toContainText(`收款完成：${data.Payment.paymentNo} · ¥36.00`);
      await expect(main(page)).toContainText(data.Payment.receipt.receiptNo);
      const count = await db(p => p.payment.count({ where: { settleAccountId: data.Onboard.settleAccount.id } }));
      expect(count).toBe(1);
    });
    await step('Receipt', async () => {
      data.Receipt = await response(page, `/receipts/${data.Payment.receipt.id}/print`, () => page.getByRole('button', { name: '打印票据' }).click());
      expect(data.Receipt.printedAt).toBeTruthy();
      await expect(main(page).getByText('已打印', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: '刷新欠费' }).click();
      await expect(page.getByText('该户无欠费账单', { exact: true })).toBeVisible();
      await page.reload(); await ready(page);
      await select(page, main(page).getByText('先选客户', { exact: true }), `${customerName}（${data.Onboard.customer.customerNo}）`);
      await select(page, main(page).getByText('再选水表户', { exact: true }), `${data.Onboard.waterAccount.accountNo} · ${category} · UAT测试地址`);
      await expect(page.getByText('该户无欠费账单', { exact: true })).toBeVisible();
      await expect(main(page).locator('.ant-statistic').filter({ hasText: '合计欠费（净额）' })).toContainText('0.00');
    });
    await step('Day close', async () => {
      await page.goto('/payment/day-close'); await ready(page);
      await page.getByRole('button', { name: '执行日结' }).click();
      const dialog = page.getByRole('dialog', { name: '执行日结' });
      await expect(dialog).toContainText('日结日期');
      data['Day close'] = await response(page, '/cashier-day-close/close', () => button(dialog, '日结').click());
      expect(data['Day close'].totalCount).toBeGreaterThanOrEqual(1);
      expect(Number(data['Day close'].totalAmount)).toBeGreaterThanOrEqual(3600);
      await expect(main(page)).toContainText('¥36.00');
      await button(main(page), '详情').click();
      const drawer = page.getByRole('dialog');
      await expect(drawer).toContainText(data.Payment.paymentNo);
      await expect(drawer).toContainText('现金 1笔 ¥36.00');
    });
    await step('Reports', async () => {
      for (const kind of ['meter-daily', 'cashier-daily', 'ar-monthly', 'collected-monthly', 'recovery-rate']) {
        await test.step(kind, async () => {
          await page.goto('/report/' + kind); await ready(page);
          if (kind === 'ar-monthly' || kind === 'recovery-rate') await date(main(page).getByPlaceholder('Select month', { exact: true }), month);
          const result = await response(page, '/reports/' + kind, () => button(main(page), '查询').click(), 'GET');
          data[kind] = result;
          if (kind === 'meter-daily') {
            const record = result.find((x: any) => x.bookId === data.Book.id);
            expect(record).toMatchObject({ total: 1, read: 1, readingsTaken: 1 });
            await expect(row(page, bookName)).toContainText(data.Book.bookNo);
          } else if (kind === 'cashier-daily') {
            await expect(row(page, '管理员')).toContainText('1 笔 ¥36.00');
            await expect(row(page, '管理员')).toContainText('已日结');
            expect(result[0].byChannel.CASH).toMatchObject({ count: 1, amount: '3600' });
          } else if (kind === 'ar-monthly') {
            expect(String(result.billed)).toBe('3600'); await expect(row(page, category)).toContainText('¥36.00');
          } else if (kind === 'collected-monthly') {
            expect(String(result.collected)).toBe('3600'); expect(String(result.allocated)).toBe('3600');
            await expect(main(page).locator('.ant-descriptions')).toContainText('实收合计¥36.00');
            await expect(main(page).locator('.ant-descriptions')).toContainText('销账合计（对数）¥36.00');
            await expect(row(page, '现金')).toContainText('¥36.00');
          } else {
            expect(String(result.billed)).toBe('3600'); expect(String(result.collected)).toBe('3600');
            await expect(main(page)).toContainText('100.00%');
          }
          await evidence(page, info, kind, result);
        });
      }
    });
  } finally {
    await info.attach('happy-path-state', { body: JSON.stringify({ ...data, completed }, null, 2), contentType: 'application/json' });
  }
});
