import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test, expect } from '../uat/helpers/console';
import { ready, main, button, date, response, row, selectPerson, evidence } from '../pilot/helpers/ui';

const requireApi = createRequire(resolve('apps/api/package.json'));
const { PrismaClient } = requireApi('@prisma/client');
let tenantCode: string;
let person: any;
let actualId: string;

// Historical fixture is produced by estimated-recovery.e2e-spec.ts. No mocks.
test.beforeAll(async () => {
  const db = new PrismaClient({ datasourceUrl: 'postgresql://postgres:postgres@localhost:5432/water_recovery_fix_20260920' });
  try {
    const [identity] = await db.$queryRawUnsafe('SELECT current_database() AS name');
    expect(identity.name).toBe('water_recovery_fix_20260920');
    const tenant = await db.tenant.findFirstOrThrow({ where: { code: { startsWith: 'recovery-' } }, orderBy: { createdAt: 'desc' } });
    tenantCode = tenant.code;
    const accounts = await db.waterAccount.findMany({ where: { tenantId: tenant.id },
      include: { customer: true, settleAccount: true, meterInstallations: { include: { meter: true } } } });
    for (const a of accounts) {
      const installation = a.meterInstallations.find((i: any) => String(i.meter.maxDial) === '10000');
      if (!installation) continue;
      if (await db.reconciliation.count({ where: { tenantId: tenant.id, waterAccountId: a.id } })) continue;
      const actual = await db.meterReading.findFirst({ where: { tenantId: tenant.id, installationId: installation.id, period: '202701', readingValue: 265 } });
      if (!actual) continue;
      person = { customer: a.customer, settleAccount: a.settleAccount, waterAccount: a,
        category: a.usageCategory, addr: a.addr };
      actualId = actual.id;
      // Future reading fixture is explicit; reconciliation below selects January.
      await db.meterReading.create({ data: { tenantId: tenant.id, installationId: installation.id,
        meterId: installation.meter.id, period: '202702', readDate: new Date('2027-02-28'),
        resultType: 'ACTUAL', readingValue: 280, qcStatus: 'PASSED', source: 'WEB', operatorId: actual.operatorId } });
      break;
    }
    expect(person, 'Run the API regression first to prepare an unused paid-estimate account').toBeTruthy();
  } finally { await db.$disconnect(); }
});

test('Chrome: paid over-estimate → Chinese guidance → adjustment → zero current bill → next real usage', async ({ page, audit }, info) => {
  await page.goto('/login');
  await page.getByLabel('租户代码').fill(tenantCode);
  await page.getByLabel('账号', { exact: true }).fill('admin');
  await page.getByLabel('密码', { exact: true }).fill('recovery-pass');
  await button(page, '登录').click();
  await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible();

  async function openGenerate(period: string) {
    await page.goto('/settlement/list'); await ready(page);
    await button(main(page), '生成结算').click();
    const dialog = page.getByRole('dialog', { name: '生成结算（草稿）' });
    await selectPerson(page, dialog, person);
    await date(dialog.getByLabel('账期', { exact: true }), period);
    return dialog;
  }
  let dialog = await openGenerate('2027-01');
  audit.allow('/api/consumption-settlements', 409);
  const denied = page.waitForResponse(r => new URL(r.url()).pathname === '/api/consumption-settlements' && r.request().method() === 'POST');
  await button(dialog, '生成').click();
  expect((await denied).status()).toBe(409);
  await expect(page.getByText(/实抄止度低于此前估计止度/)).toBeVisible();
  await evidence(page, info, 'estimate-recovery-guidance');

  await page.goto('/settlement/reconciliations'); await ready(page);
  await button(main(page), '发起补差').click();
  dialog = page.getByRole('dialog', { name: '发起补差' });
  await selectPerson(page, dialog, person);
  await dialog.getByLabel('实抄读数 ID（可空）', { exact: true }).fill(actualId);
  const correction = await response(page, '/reconciliations', () => button(dialog, '发起').click());
  expect(correction).toMatchObject({ actualTotalUsage: '15', previouslySettledUsage: '25', remainderUsage: '-10', adjustmentAmountCent: '-5000' });
  await page.reload(); await ready(page);
  await expect(row(page, person.waterAccount.accountNo)).toContainText('-50.00');
  await evidence(page, info, 'recovery-credit', correction);

  dialog = await openGenerate('2027-01');
  const current = await response(page, '/consumption-settlements', () => button(dialog, '生成').click());
  expect(current.totalUsageQty).toBe('0');
  await button(row(page, person.waterAccount.accountNo).filter({ has: page.getByRole('cell', { name: '2027-01', exact: true }) }), '终审').click();
  await response(page, `/consumption-settlements/${current.id}/finalize`, () => button(page.getByRole('tooltip'), '终审').click());

  await page.goto('/billing/runs'); await ready(page);
  await button(main(page), '新建开账批次').click();
  dialog = page.getByRole('dialog', { name: '新建开账批次' });
  await date(dialog.getByLabel('账期', { exact: true }), '2027-01');
  const run = await response(page, '/billing-runs', () => button(dialog, '生成').click());
  expect(run.bills).toHaveLength(1); expect(run.bills[0].totalAmount).toBe('0');
  await button(main(page).locator(`tr[data-row-key="${run.id}"]`), '执行开账').click();
  const posted = await response(page, `/billing-runs/${run.id}/post`, () => button(page.getByRole('tooltip'), '执行').click());
  expect(posted.failedCount).toBe(0);

  dialog = await openGenerate('2027-02');
  const next = await response(page, '/consumption-settlements', () => button(dialog, '生成').click());
  expect(next.components[0]).toMatchObject({ prevReadingValue: '265', endReadingValue: '280', usageQty: '15' });
  await page.reload(); await ready(page);
  await evidence(page, info, 'next-period-real-dial', next);

  await page.goto('/payment/counter'); await ready(page);
  await selectPerson(page, main(page), person, '先选客户', '再选水表户');
  const pickers = main(page).locator('.cashier-picker > .ant-select');
  const customerBox = await pickers.nth(0).boundingBox();
  const accountBox = await pickers.nth(1).boundingBox();
  expect(customerBox).not.toBeNull(); expect(accountBox).not.toBeNull();
  expect(customerBox!.x + customerBox!.width).toBeLessThanOrEqual(accountBox!.x);
  await expect(main(page)).toContainText('-50.00');
  await evidence(page, info, 'credit-after-paid-estimate');
});
