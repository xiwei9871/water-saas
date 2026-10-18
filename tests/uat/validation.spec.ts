import { test, expect } from './helpers/console';
import { login, ready } from './helpers/auth';
import { button, select, evidence } from './helpers/ui';

test('C02 empty customer, usage/address and invalid initial reading are blocked in Chinese', async ({ page }, info) => {
  await login(page); await page.goto('/customer/onboard');
  let writes = 0;
  const countWrites = (r: any) => { if (r.method() === 'POST' && r.url().includes('/water-accounts/onboard')) writes++; };
  page.on('request', countWrites);
  // 用水类别是向导顶层字段（决定监控表分支），先选类别再逐步校验
  await select(page, page.getByLabel('用水类别', { exact: true }), '居民户表');
  await page.getByRole('button', { name: '下一步' }).click();
  await expect(page.getByText('请输入客户名称', { exact: true })).toBeVisible();
  await page.getByLabel('客户名称', { exact: true }).fill('UAT必填校验不提交');
  await page.getByRole('button', { name: '下一步' }).click();
  await page.getByRole('button', { name: '下一步' }).click();
  await page.getByRole('button', { name: '下一步' }).click();
  await expect(page.getByText('请输入用水地址', { exact: true })).toBeVisible();
  await page.getByLabel('用水地址', { exact: true }).fill('UAT测试地址');
  await page.getByRole('button', { name: '下一步' }).click();
  await page.getByRole('button', { name: '提交立户' }).click();
  await expect(page.getByText('请输入初始读数', { exact: true })).toBeVisible();
  await page.getByLabel('装表初始读数').fill('abc');
  await page.getByRole('button', { name: '提交立户' }).click();
  await expect(page.getByText('请输入非负数值（最多 4 位小数）', { exact: true })).toBeVisible();
  expect(writes).toBe(0);
  await evidence(page, info, 'required-validation');
});

test('D06 NO_READ reason required; LOCKED saves as 未抄见', async ({ page }, info) => {
  await login(page);
  // Only this independent negative case uses browser API fixtures. Happy path never uses API creation.
  const fixture = await page.evaluate(async () => {
    const headers = { Authorization: 'Bearer ' + localStorage.getItem('water-saas.accessToken'), 'Content-Type': 'application/json' };
    async function api(path: string, data?: unknown) {
      const r = await fetch('/api' + path, { headers, method: data === undefined ? 'GET' : 'POST', ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      if (!r.ok) throw new Error('fixture ' + path + ' ' + r.status + ' ' + await r.text());
      return r.json();
    }
    const name = 'UAT未抄见-' + Date.now();
    const onboard = await api('/water-accounts/onboard', { customer: { name, custType: 'PERSONAL' }, account: { usageCategory: 'RES_METERED', addr: 'UAT测试地址' }, meter: {}, installation: { initialReading: '0', reason: 'NEW' } });
    const orgs = await api('/iam/orgs');
    const book = await api('/reading-books', { name, orgUnitId: orgs.find((x: any) => x.type === 'COMPANY').id });
    await api(`/reading-books/${book.id}/meters`, { waterAccountId: onboard.waterAccount.id });
    const now = new Date();
    const period = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const plan = await api('/reading-plans/generate', { bookId: book.id, period });
    await api(`/reading-plans/${plan.id}/start`, {});
    return { name, plan, onboard };
  });
  await page.goto('/metering/plans'); await ready(page);
  await button(page.getByRole('row').filter({ hasText: fixture.name }), '明细').click();
  await button(page.getByRole('dialog'), '录入').click();
  const dialog = page.getByRole('dialog', { name: /抄表录入/ });
  await dialog.getByText('未抄见', { exact: true }).click();
  await expect(dialog.getByRole('radio', { name: '未抄见', exact: true })).toBeChecked();
  let writes = 0;
  page.on('request', r => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/meter-readings') writes++; });
  await button(dialog, '提交').click();
  await expect(dialog.getByText('请选择未抄见原因', { exact: true })).toBeVisible();
  expect(writes).toBe(0);
  await expect(dialog.getByLabel('表码读数')).toHaveCount(0);
  await select(page, dialog.getByLabel('未抄见原因'), '锁闭无法入户');
  await button(dialog, '提交').click();
  await expect(page.getByRole('dialog').getByRole('row').filter({ hasText: fixture.onboard.waterAccount.accountNo })).toContainText('未抄见');
  expect(writes).toBe(1);
  await evidence(page, info, 'no-read', fixture);
});
