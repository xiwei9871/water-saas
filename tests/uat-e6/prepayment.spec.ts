/**
 * E6 Prepayment V1 UAT — water_uat_e6 (real UI + real API, no mocks).
 * Serial suite; account onboarding and POSTED-debt fixtures go through
 * the API / owner DB helpers, every money path is driven through the UI.
 *
 * Slices:
 *  1. 收费台：无欠费 → 全额预存充值 → 余额/流水抽屉
 *  2. 有欠费 80 → 收 200 → 清欠 80 + 预存 120（一笔收款一张收据）
 *  3. 预存退款（负收款）→ 收款记录页可见
 *  4. 日结：prepaymentBreakdown 四项拆分 + 守恒
 *  5. 结算户详情：预存余额 + 批次 + 最近流水
 *  6. 水表户过户：预存余额不迁移警告
 */
import { test, expect } from '../uat/helpers/console';
import { login, ready } from '../uat/helpers/auth';
import { db } from '../uat/helpers/fixture';
import { button, evidence, main, response, row, select } from '../uat/helpers/ui';
import type { Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const requireApi = createRequire(resolve('apps/api/package.json'));
const bcrypt = requireApi('bcrypt');

test.describe.configure({ mode: 'serial' });

const stamp = Date.now().toString(36);
const S: Record<string, any> = { stamp };
let token = '';

async function api(
  page: Page,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
  bearer = token,
) {
  const res = await page.request.fetch(`/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${bearer}` },
    ...(body === undefined ? {} : { data: body }),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status(), body: json };
}

async function apiOk(page: Page, method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) {
  const r = await api(page, method, path, body);
  expect(r.status, `${method} ${path}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
  return r.body;
}

const unwrap = (r: any) => (r && typeof r === 'object' && 'replayed' in r ? r.body : r);

/** 每轮 UAT 一个独立柜员：cashier + 动态角色绑 prepayment:reverse —
 *  抽屉与当日日结天然隔离，重跑不撞 DAY_CLOSE_EXISTS。 */
const CASHIER_LOGIN = `e6-${stamp}`;
const CASHIER_PW = 'uat12345';
async function ensureE6Staff() {
  await db(async (p) => {
    const tenant = await p.tenant.findUniqueOrThrow({ where: { code: 'cd-water' } });
    const org = await p.orgUnit.findFirstOrThrow({
      where: { tenantId: tenant.id, type: 'COMPANY' },
    });
    const passwordHash = await bcrypt.hash(CASHIER_PW, 10);
    const staff = await p.staff.upsert({
      where: { tenantId_login: { tenantId: tenant.id, login: CASHIER_LOGIN } },
      create: {
        tenantId: tenant.id,
        orgUnitId: org.id,
        login: CASHIER_LOGIN,
        name: `E6柜员-${stamp}`,
        passwordHash,
        status: 'ACTIVE',
      },
      update: { passwordHash, status: 'ACTIVE' },
    });
    const cashier = await p.role.findUniqueOrThrow({
      where: { tenantId_code: { tenantId: tenant.id, code: 'cashier' } },
    });
    await p.staffRole.upsert({
      where: { staffId_roleId: { staffId: staff.id, roleId: cashier.id } },
      create: { tenantId: tenant.id, staffId: staff.id, roleId: cashier.id },
      update: {},
    });
    const perm = await p.permission.findUniqueOrThrow({
      where: { tenantId_code: { tenantId: tenant.id, code: 'prepayment:reverse' } },
    });
    const sup = await p.role.upsert({
      where: { tenantId_code: { tenantId: tenant.id, code: `e6sup-${stamp}` } },
      create: {
        tenantId: tenant.id,
        code: `e6sup-${stamp}`,
        name: 'E6预存主管',
        dataScope: 'ALL',
      },
      update: {},
    });
    await p.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: sup.id, permissionId: perm.id } },
      create: { tenantId: tenant.id, roleId: sup.id, permissionId: perm.id },
      update: {},
    });
    await p.staffRole.upsert({
      where: { staffId_roleId: { staffId: staff.id, roleId: sup.id } },
      create: { tenantId: tenant.id, staffId: staff.id, roleId: sup.id },
      update: {},
    });
  });
}
const loginCashier = (page: Page) => login(page, CASHIER_LOGIN, CASHIER_PW);

/** API 直连登录 —— fixture 层（立户等）不需要走 UI 登录页。 */
async function apiToken(page: Page, account: string, password: string) {
  const r = await api(page, 'POST', '/auth/login', {
    tenantCode: 'cd-water',
    login: account,
    password,
  });
  expect(r.status, `login ${account}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
  return r.body.accessToken as string;
}

/** POSTED debt fixture — mirrors the e2e seedBill (settlement + bill rows). */
async function seedDebtBill(waterAccountId: string, settleAccountId: string, totalCent: number) {
  return db(async (p) => {
    const tenant = await p.tenant.findUniqueOrThrow({ where: { code: 'cd-water' } });
    const settlement = await p.consumptionSettlement.create({
      data: {
        tenantId: tenant.id,
        waterAccountId,
        period: '202709',
        totalUsageQty: 1,
        isEstimated: false,
        status: 'FINAL',
      },
    });
    const bill = await p.bill.create({
      data: {
        tenantId: tenant.id,
        settleAccountId,
        waterAccountId,
        period: '202709',
        billKind: 'NORMAL',
        sourceType: 'SETTLEMENT',
        sourceId: settlement.id,
        status: 'POSTED',
        isEstimated: false,
        totalAmount: totalCent,
        issuedAt: new Date(),
        dueDate: new Date('2027-10-15'),
      },
    });
    return bill.id;
  });
}

const pickAccount = async (page: Page) => {
  await select(
    page,
    main(page).getByText('先选客户', { exact: true }),
    `${S.customerName}（${S.acct.customer.customerNo}）`,
  );
  await select(
    page,
    main(page).getByText('再选水表户', { exact: true }),
    `${S.acct.waterAccount.accountNo} · RES_METERED · ${S.addr}`,
  );
};

test('S1 收费台预存充值 — 无欠费全额入预存 + 流水抽屉', async ({ page }, info) => {
  await ensureE6Staff();
  // 立户走 admin token（cashier 角色无 customer:write），柜台资金动作全走 E6 柜员。
  token = await apiToken(page, 'admin', 'admin123');
  S.customerName = `E6UAT客户-${stamp}`;
  S.addr = `E6预存路-${stamp}`;
  S.acct = await apiOk(page, 'POST', '/water-accounts/onboard', {
    customer: { name: S.customerName, custType: 'PERSONAL' },
    account: { usageCategory: 'RES_METERED', addr: S.addr },
    meter: { brand: 'e6-brand', caliber: 'DN15' },
    installation: { initialReading: 0 },
  });
  S.settleAccountId = S.acct.settleAccount.id;

  await loginCashier(page);
  token = await page.evaluate(() => localStorage.getItem('water-saas.accessToken')!);
  await page.goto('/payment/counter');
  await ready(page);
  await pickAccount(page);
  const balStat = main(page).locator('.ant-statistic').filter({ hasText: '预存余额' });
  await expect(balStat).toContainText('0.00');

  // UI 充值 200 元 → 一笔 Payment + 一张收据 + TOP_UP。
  await button(main(page), '预存充值').click();
  const modal = page.getByRole('dialog', { name: '预存充值' });
  await expect(modal).toContainText('收款先清欠费');
  await modal.getByRole('spinbutton').fill('200');
  const res = await response(page, '/prepayments/top-ups', () =>
    button(modal, '确认收款').click(),
  );
  const body = unwrap(res);
  expect(body.topUp).toBe('20000');
  expect(body.billAllocs).toEqual([]);
  S.payment1 = body.payment;
  await expect(balStat).toContainText('200.00');

  // 流水抽屉：TOP_UP +200.00。
  await button(main(page), '预存流水').click();
  const drawer = page.getByRole('dialog', { name: '预存流水' });
  await expect(drawer).toContainText('预存充值');
  await expect(drawer).toContainText('¥200.00');
  await evidence(page, info, 's1-topup', body);
});

test('S2 欠费 80 收 200 — 先清欠后预存，账单 PAID', async ({ page }, info) => {
  await loginCashier(page);
  token = await page.evaluate(() => localStorage.getItem('water-saas.accessToken')!);
  S.billId = await seedDebtBill(S.acct.waterAccount.id, S.settleAccountId, 8000);

  await page.goto('/payment/counter');
  await ready(page);
  await pickAccount(page);
  await expect(main(page).locator('.ant-statistic').filter({ hasText: '合计欠费' })).toContainText('80.00');

  await button(main(page), '预存充值').click();
  const modal = page.getByRole('dialog', { name: '预存充值' });
  await modal.getByRole('spinbutton').fill('200');
  const res = await response(page, '/prepayments/top-ups', () =>
    button(modal, '确认收款').click(),
  );
  const body = unwrap(res);
  expect(body.topUp).toBe('12000');
  expect(body.billAllocs).toHaveLength(1);
  expect(body.billAllocs[0].amount).toBe('8000');
  S.payment2 = body.payment;

  // 服务端事实：账单 PAID、余额 120、流水两条腿。
  const bill = await apiOk(page, 'GET', `/bills/${S.billId}`);
  expect(bill.status).toBe('PAID');
  const bal = await apiOk(
    page,
    'GET',
    `/prepayments/balance?settleAccountId=${S.settleAccountId}`,
  );
  expect(bal.balance).toBe('32000'); // 20000 + 12000
  const detail = await apiOk(page, 'GET', `/payments/${S.payment2.id}`);
  expect((detail.prepaymentEntries ?? []).length).toBe(1);
  await evidence(page, info, 's2-debt-first', { body, bill });
});

test('S3 预存退款 — 负收款 + 收款记录可见', async ({ page }, info) => {
  await loginCashier(page);
  token = await page.evaluate(() => localStorage.getItem('water-saas.accessToken')!);
  await page.goto('/payment/counter');
  await ready(page);
  await pickAccount(page);

  await button(main(page), '预存退款').click();
  const modal = page.getByRole('dialog', { name: '预存退款' });
  await expect(modal).toContainText('预存余额');
  await modal.getByRole('spinbutton').fill('50');
  await modal.getByPlaceholder(/必填/).fill('UAT 退预存');
  const res = await response(page, '/prepayments/refunds', () =>
    button(modal, '确认退款').click(),
  );
  const body = unwrap(res);
  expect(body.payment.amount).toBe('-5000');
  expect(body.balance).toBe('27000');
  S.refundPayment = body.payment;

  // 收款记录页：负收款行 + 金额。
  await page.goto('/payment/payments');
  await ready(page);
  await expect(row(page, S.refundPayment.paymentNo)).toContainText('¥-50.00');
  await evidence(page, info, 's3-refund', body);
});

test('S4 日结 — prepaymentBreakdown 四项拆分且守恒', async ({ page }, info) => {
  await loginCashier(page);
  token = await page.evaluate(() => localStorage.getItem('water-saas.accessToken')!);
  await page.goto('/payment/day-close');
  await ready(page);
  await page.getByRole('button', { name: '执行日结' }).click();
  const dialog = page.getByRole('dialog', { name: '执行日结' });
  await expect(dialog).toContainText('日结日期');
  const close = await response(page, '/cashier-day-close/close', () =>
    button(dialog, '日结').click(),
  );
  S.dayClose = unwrap(close);
  expect(S.dayClose.prepaymentBreakdown).toBeTruthy();
  const bd = S.dayClose.prepaymentBreakdown;
  // 独立柜员抽屉 = 本轮三笔：200(全预存) + 200(80清欠+120预存) + (-50)(退款)
  expect(bd.topUp).toBe('32000');
  expect(bd.debtCollection).toBe('8000');
  expect(bd.refundAmount).toBe('-5000');
  expect(bd.reversalAmount).toBe('0');
  expect(
    BigInt(bd.debtCollection) +
      BigInt(bd.topUp) +
      BigInt(bd.refundAmount) +
      BigInt(bd.reversalAmount),
  ).toBe(BigInt(S.dayClose.totalAmount));

  await row(page, S.dayClose.closeDate?.slice(0, 10) ?? '').first();
  await button(main(page), '详情').first().click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toContainText('资金用途拆分');
  await expect(drawer).toContainText('清欠收款');
  await expect(drawer).toContainText('预存充值');
  await expect(drawer).toContainText('预存退款');
  await evidence(page, info, 's4-day-close', S.dayClose);
});

test('S5 结算户详情 — 预存余额 + 批次 + 流水', async ({ page }, info) => {
  await login(page);
  token = await page.evaluate(() => localStorage.getItem('water-saas.accessToken')!);
  await page.goto('/customer/settle-accounts');
  await ready(page);
  const target = row(page, S.customerName);
  await expect(target).toBeVisible();
  await button(target, '详情').click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toContainText('预存余额');
  await expect(drawer).toContainText('270.00');
  await expect(drawer).toContainText('未耗批次');
  await expect(drawer).toContainText('最近预存流水');
  await expect(drawer).toContainText('预存退款');
  await evidence(page, info, 's5-settle-360');
});

test('S6 水表户过户 — 预存余额不迁移警告', async ({ page }, info) => {
  await login(page);
  token = await page.evaluate(() => localStorage.getItem('water-saas.accessToken')!);
  await page.goto(`/customer/water-accounts?accountNo=${S.acct.waterAccount.accountNo}`);
  await ready(page);
  const target = row(page, S.acct.waterAccount.accountNo);
  await expect(target).toBeVisible();
  await button(target, '过户').click();
  const modal = page.getByRole('dialog', { name: /过户/ });
  await expect(modal).toContainText('不会随改挂迁移');
  await expect(modal).toContainText('270.00');
  await expect(modal).toContainText('余额归属结算户而非水表户');
  await button(modal, '取消').click();
  await evidence(page, info, 's6-transfer-warning');
});
