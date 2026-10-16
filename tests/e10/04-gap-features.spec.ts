import { expect, test, type Page } from '@playwright/test';
import { loadCredentials, loginAsAdmin } from './helpers/auth';

/**
 * 缺口补齐功能（G1 违约金 / G3 渠道对账 / G4 催缴通知单 / G5 票据台账 /
 * S1 报装）线上自查。写入均为可保留的演示数据：报装单走完整归档会
 * 真实立户（客户名带 PW- 前缀便于识别），对账只上传 mock 对账单。
 */

async function api(page: Page, method: 'get' | 'post' | 'put', path: string, data?: unknown) {
  const base = new URL(page.url()).origin;
  const token = await page.evaluate(() => localStorage.getItem('water-saas.accessToken'));
  const res = await page.request.fetch(`${base}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data,
  });
  return res;
}

test.beforeEach(async ({ page }) => {
  await loginAsAdmin(page);
});

test.describe('S1 报装管理（独立域）', () => {
  test('申请→勘察→审批→装表→归档立户→回写户号', async ({ page }) => {
    await page.goto('/install/applications');
    await expect(page.getByRole('button', { name: '新建申请' })).toBeVisible();

    await page.getByRole('button', { name: '新建申请' }).click();
    const modal = page.locator('.ant-modal');
    // custType=个人 / usageCategory=居民生活 均有默认值，无需点开下拉
    await modal.getByLabel('申请人名称').fill(`PW-报装户${Date.now() % 100000}`);
    await modal.getByLabel('联系电话').fill('13900001111');
    await modal.getByLabel('安装地址').fill('PW 测试路 88 号');
    await modal.getByRole('button', { name: /确\s*定|OK/ }).click();
    await page.waitForResponse((r) => r.url().includes('/install/applications') && r.request().method() === 'POST');

    const row = page.locator('.ant-table-row', { hasText: 'PW 测试路 88 号' }).first();
    await expect(row).toContainText('已提交');

    // SUBMITTED → SURVEYED → APPROVED → INSTALLING
    for (const label of ['勘察完成', '审批通过', '开始装表']) {
      await row.getByRole('button', { name: label }).click();
      await page.locator('.ant-modal').getByRole('button', { name: /确\s*定|OK/ }).click();
      await page.waitForResponse((r) => r.url().includes('/transition'));
    }
    await expect(row).toContainText('装表中');

    // 归档立户：只填起始读数，客户缺省 → 服务端按申请单建客
    await row.getByRole('button', { name: '归档立户' }).click();
    const arch = page.locator('.ant-modal');
    await arch.getByLabel(/起始读数/).fill('0');
    await arch.getByRole('button', { name: /确\s*定|OK/ }).click();
    await page.waitForResponse((r) => r.url().includes('/archive'));
    await expect(row).toContainText('已归档');

    // 详情抽屉回写户号（展示 accountNo 而非裸 UUID）
    await row.getByRole('button', { name: /详\s*情/ }).click();
    await expect(page.locator('.ant-drawer')).toContainText('已归档户号');
    await expect(page.locator('.ant-drawer')).toContainText(/A\d{12}/);
  });
});

test.describe('G3 渠道对账（mock）', () => {
  test('生成模拟对账单→粘贴核账→批次差异计数', async ({ page }) => {
    await page.goto('/payment/recon');
    // 选有流水的渠道（CASH）再生成模拟对账单——BANK_DEDUCT 在 pilot 无收款会得到空表
    await page.locator('.ant-form .ant-select').first().click();
    await page.locator('.ant-select-item', { hasText: '现金' }).click();
    await page.getByRole('button', { name: '生成模拟对账单' }).click();
    const res = await page.waitForResponse((r) => r.url().includes('mock-statement'));
    const { content, rows } = await res.json();
    expect(rows).toBeGreaterThan(0);

    await page.locator('textarea').fill(content);
    const [postRes] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/payments/recon') && r.request().method() === 'POST'),
      page.getByRole('button', { name: /核\s*账/ }).click(),
    ]);
    expect(postRes.status(), JSON.stringify(await postRes.json().catch(() => null))).toBe(201);
    await expect(page.locator('.ant-table')).toContainText(/\d+/);
    // 打开首个批次明细
    await page.locator('.ant-table-row').first().getByRole('button', { name: /明\s*细/ }).click();
    await expect(page.locator('.ant-drawer, .ant-modal')).toBeVisible();
  });
});

test.describe('G5 票据台账', () => {
  test('登记号段→领用→状态流转；发票登记→作废', async ({ page }) => {
    await page.goto('/payment/receipt-docs');
    const no = `PW-${Date.now() % 100000}`;
    await page.getByRole('button', { name: /登记号段|新建号段/ }).click();
    const modal = page.locator('.ant-modal');
    await modal.getByLabel('票据本号').fill(no);
    await modal.getByLabel('票号前缀').fill('PW');
    await modal.getByLabel('起始号').fill('1');
    await modal.getByLabel('截止号').fill('20');
    await modal.getByRole('button', { name: /确\s*定|OK/ }).click();
    await page.waitForResponse((r) => r.url().includes('receipt-books') && r.request().method() === 'POST');

    const row = page.locator('.ant-table-row', { hasText: no }).first();
    await expect(row).toContainText('在库');
    await row.getByRole('button', { name: /领\s*用/ }).click();
    await page.locator('.ant-modal').getByRole('button', { name: /确\s*定|OK/ }).click();
    await expect(row).toContainText('已领用');

    // 发票登记→作废
    await page.getByRole('tab', { name: /发票/ }).click();
    await page.getByRole('button', { name: /登记发票/ }).click();
    const inv = page.locator('.ant-modal');
    await inv.getByLabel('发票号').fill(`INV-${no}`);
    await inv.getByLabel(/金额/).fill('100');
    await inv.getByRole('button', { name: /确\s*定|OK/ }).click();
    const invRow = page.locator('.ant-table-row', { hasText: `INV-${no}` });
    await invRow.getByRole('button', { name: /作\s*废/ }).click();
    await page.locator('.ant-popconfirm').getByRole('button', { name: /确\s*定|OK/ }).click();
    await expect(invRow).toContainText('已作废');
  });
});

test.describe('G4 催缴通知单 + G1 违约金', () => {
  test('通知单生成（API 找欠费户）→ 打印留痕；违约金弹窗口径展示', async ({ page }) => {
    // API 找一个欠费户生成通知单（界面 WaterAccountSelect 不便盲选）
    const accts = await (await api(page, 'get', '/water-accounts?take=50')).json();
    let noticeNo = '';
    for (const a of accts.items ?? accts) {
      const res = await api(page, 'post', '/payments/collection-notices', { waterAccountId: a.id });
      if (res.ok()) {
        noticeNo = (await res.json()).noticeNo;
        break;
      }
    }
    test.skip(!noticeNo, '无欠费户可生成通知单');

    await page.goto('/payment/collection-notices');
    const row = page.locator('.ant-table-row', { hasText: noticeNo });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: /打印/ }).click();
    await expect(page.locator('.ant-modal')).toContainText(/催缴|欠费/);
    await page.locator('.ant-modal .ant-modal-close').click();

    // 违约金计提弹窗：口径文案展示（未启用也给提示）
    await page.goto('/billing/bills');
    await page.getByRole('button', { name: '违约金计提' }).click();
    await expect(page.locator('.ant-modal')).toContainText(/当前口径/);
  });
});
