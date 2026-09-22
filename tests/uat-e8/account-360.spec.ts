/**
 * E8 WaterAccount 360° UAT — water_uat_e8 (real UI + real API, no mocks).
 * Serial suite; account fixtures go through the API, domain facts (books,
 * readings, bills, allocs, prepay ledger) are seeded via the UAT prisma
 * fixture, every assertion reads the real drawer UI.
 *
 * Slices:
 *  S1 概览：户头/客户/结算户/在册水表/warnings
 *  S2 抄表+结算：册/计划/读数 + 结算行展开 component
 *  S3 缴费：欠费合计 + 柜台支付/预存抵扣 discriminated badges
 *  S4 CLOSED：全 Tab 可读、写操作隐藏
 *  S5 scope：Branch 用户对跨所户 /360 → 403，UI 列表不显示
 *  S6 warnings：>1 ACTIVE 表 → 概览警示
 *  S7 分页：账单历史跨页翻页
 */
import { test, expect } from '../uat/helpers/console';
import { login, ready } from '../uat/helpers/auth';
import { button, evidence, main } from '../uat/helpers/ui';
import { db } from '../uat/helpers/fixture';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';

const requireApi = createRequire(resolve('apps/api/package.json'));
const bcrypt = requireApi('bcrypt');

test.describe.configure({ mode: 'serial' });

const stamp = Date.now().toString(36);
let token = '';
let tenantId = '';
let companyOrgId = '';
let adminStaffId = '';

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

async function apiToken(page: Page, account: string, password: string) {
  const r = await api(page, 'POST', '/auth/login', {
    tenantCode: 'cd-water',
    login: account,
    password,
  });
  expect(r.status, `login ${account}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
  return r.body.accessToken as string;
}

async function onboard(page: Page, tag: string) {
  const body = await apiOk(page, 'POST', '/water-accounts/onboard', {
    customer: { name: `E8 ${tag} ${stamp}`, custType: 'PERSONAL', phone: '138' },
    account: { usageCategory: 'RES_METERED', addr: `E8 ${tag} 街` },
    meter: { brand: 'e8-brand', caliber: 'DN15' },
    installation: { initialReading: 0 },
  });
  return body as {
    waterAccount: { id: string; accountNo: string; settleAccountId: string };
    meter: { id: string; meterNo: string };
    installation: { id: string };
  };
}

const drawer = (page: Page) => page.locator('.ant-drawer:visible').last();
const tab = (page: Page, label: string) =>
  drawer(page).locator('.ant-tabs-tab').filter({ hasText: label });

/** 打开某户的 360° 抽屉（按户号搜索定位行）。 */
async function open360(page: Page, accountNo: string) {
  await page.goto('/customer/water-accounts');
  await ready(page);
  const q = page.getByPlaceholder('按户号精确查询');
  await q.fill(accountNo);
  await q.press('Enter');
  const row = main(page).getByRole('row').filter({ hasText: accountNo });
  await button(row, '360°').click();
  await expect(drawer(page)).toBeVisible();
}

// ---------- db() fixture helpers (domain facts, API-free) ----------

const seedBookCoverage = (accountId: string, orgId: string, tag: string) =>
  db(async (p) => {
    const book = await p.readingBook.create({
      data: {
        tenantId,
        bookNo: `e8-${tag}-${stamp}`,
        name: `E8 册 ${tag}`,
        orgUnitId: orgId,
        cadence: 'MONTHLY',
        meterChannel: 'MECHANICAL',
      },
    });
    await p.bookMeter.create({
      data: { tenantId, bookId: book.id, waterAccountId: accountId, seqNo: 1 },
    });
    const plan = await p.readingPlan.create({
      data: {
        tenantId,
        bookId: book.id,
        period: '202602',
        planDate: new Date('2026-02-05'),
        status: 'OPEN',
      },
    });
    await p.readingPlanItem.create({
      data: {
        tenantId,
        planId: plan.id,
        waterAccountId: accountId,
        seqNo: 1,
        status: 'PENDING',
      },
    });
    return { bookId: book.id, bookName: book.name, planId: plan.id };
  });

const seedReading = (installationId: string, meterId: string) =>
  db(async (p) => {
    const staff = adminStaffId;
    await p.meterReading.create({
      data: {
        tenantId,
        installationId,
        meterId,
        period: '202602',
        readDate: new Date('2026-02-20'),
        resultType: 'ACTUAL',
        readingValue: 25,
        qcStatus: 'PASSED',
        source: 'WEB',
        operatorId: staff,
      },
    });
  });

const seedSettlement = (accountId: string, installationId: string) =>
  db(async (p) => {
    const s = await p.consumptionSettlement.create({
      data: {
        tenantId,
        waterAccountId: accountId,
        period: '202602',
        totalUsageQty: 25,
        isEstimated: false,
        status: 'FINAL',
      },
    });
    await p.consumptionComponent.create({
      data: {
        tenantId,
        settlementId: s.id,
        installationId,
        prevReadingValue: 0,
        endReadingValue: 25,
        usageQty: 25,
        sourceType: 'READING',
      },
    });
  });

const seedBillPaymentAlloc = async (
  accountId: string,
  settleAccountId: string,
  tag: string,
) => {
  const billId = await db(async (p) => {
    const bill = await p.bill.create({
      data: {
        tenantId,
        settleAccountId,
        waterAccountId: accountId,
        period: '202602',
        billKind: 'NORMAL',
        sourceType: 'MANUAL',
        sourceId: crypto.randomUUID(),
        status: 'POSTED',
        totalAmount: 5000n,
      },
    });
    const pay = await p.payment.create({
      data: {
        tenantId,
        paymentNo: `e8-pay-${tag}-${stamp}`,
        settleAccountId,
        cashierId: adminStaffId,
        orgUnitId: companyOrgId,
        channel: 'CASH',
        amount: 3000n,
        status: 'RECEIVED',
        receivedAt: new Date(),
      },
    });
    await p.paymentAlloc.create({
      data: {
        tenantId,
        source: 'PAYMENT',
        paymentId: pay.id,
        billId: bill.id,
        amount: 3000n,
      },
    });
    // 预存抵扣一笔：TOP_UP lot → APPLY(-1200) → alloc PREPAYMENT
    const topUpPay = await p.payment.create({
      data: {
        tenantId,
        paymentNo: `e8-topup-${tag}-${stamp}`,
        settleAccountId,
        cashierId: adminStaffId,
        orgUnitId: companyOrgId,
        channel: 'CASH',
        amount: 99000n,
        status: 'RECEIVED',
        receivedAt: new Date(),
      },
    });
    const lot = await p.prepaymentLedgerEntry.create({
      data: {
        tenantId,
        settleAccountId,
        type: 'TOP_UP',
        amount: 99000n,
        paymentId: topUpPay.id,
        idempotencyKey: `e8-lot-${tag}-${stamp}`,
        operatorId: adminStaffId,
      },
    });
    const apply = await p.prepaymentLedgerEntry.create({
      data: {
        tenantId,
        settleAccountId,
        type: 'APPLY',
        amount: -1200n,
        billId: bill.id,
        originTopUpId: lot.id,
        idempotencyKey: `e8-apply-${tag}-${stamp}`,
      },
    });
    await p.paymentAlloc.create({
      data: {
        tenantId,
        source: 'PREPAYMENT',
        prepaymentEntryId: apply.id,
        billId: bill.id,
        amount: 1200n,
      },
    });
    return bill.id;
  });
  return billId;
};

// --------------------------------------------------------------------

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  token = await apiToken(page, 'admin', 'admin123');
  await page.close();
  await db(async (p) => {
    const tenant = await p.tenant.findUniqueOrThrow({ where: { code: 'cd-water' } });
    tenantId = tenant.id;
    const org = await p.orgUnit.findFirstOrThrow({
      where: { tenantId, type: 'COMPANY' },
    });
    companyOrgId = org.id;
    const admin = await p.staff.findUniqueOrThrow({
      where: { tenantId_login: { tenantId, login: 'admin' } },
    });
    adminStaffId = admin.id;
  });
});

test('S1: 概览 Tab — 户头/客户/结算户/在册水表 + 无警示', async ({ page }, info) => {
  const a = await onboard(page, 's1');
  await login(page);
  await open360(page, a.waterAccount.accountNo);

  await expect(drawer(page)).toContainText('360°');
  await expect(drawer(page)).toContainText(a.waterAccount.accountNo);
  await expect(drawer(page)).toContainText(`E8 s1 ${stamp}`);
  await expect(drawer(page)).toContainText('在册水表');
  await expect(drawer(page)).toContainText('1 块');
  await expect(drawer(page).locator('.ant-alert-warning')).toHaveCount(0);
  await evidence(page, info, 's1-overview', {});
});

test('S2: 抄表/结算 Tab — 册/计划/读数 + component 展开', async ({ page }, info) => {
  const a = await onboard(page, 's2');
  const cov = await seedBookCoverage(a.waterAccount.id, companyOrgId, 's2');
  await seedReading(a.installation.id, a.meter.id);
  await seedSettlement(a.waterAccount.id, a.installation.id);

  await login(page);
  await open360(page, a.waterAccount.accountNo);

  await tab(page, '抄表').click();
  await expect(drawer(page)).toContainText(cov.bookName);
  await expect(drawer(page)).toContainText('2026-02');
  await expect(drawer(page)).toContainText('25');
  await expect(drawer(page)).toContainText('实抄');

  await tab(page, '结算').click();
  await expect(drawer(page)).toContainText('已核定');
  // component 展开：期中换表/多段结算可见
  await drawer(page).locator('.ant-table-row-expand-icon').first().click();
  await expect(drawer(page)).toContainText('READING');
  await evidence(page, info, 's2-metering', {});
});

test('S3: 缴费 Tab — 欠费合计 + 柜台支付/预存抵扣 badges', async ({ page }, info) => {
  const a = await onboard(page, 's3');
  await seedBillPaymentAlloc(a.waterAccount.id, a.waterAccount.settleAccountId, 's3');

  await login(page);
  await open360(page, a.waterAccount.accountNo);
  await tab(page, '缴费').click();

  // 5000 − 3000(PAYMENT) − 1200(PREPAYMENT) = ¥8.00
  await expect(drawer(page)).toContainText('¥8.00');
  await expect(drawer(page)).toContainText('柜台支付');
  await expect(drawer(page)).toContainText('预存抵扣');
  await expect(drawer(page)).toContainText('¥30.00');
  await expect(drawer(page)).toContainText('¥12.00');
  await evidence(page, info, 's3-payment-activity', {});
});

test('S4: CLOSED 户 — 全 Tab 可读、写操作隐藏', async ({ page }, info) => {
  const a = await onboard(page, 's4');
  // 先拆表再销户（E7 守卫），该户无欠费
  await apiOk(page, 'POST', `/meter-installations/${a.installation.id}/remove`, {
    finalReading: 10,
  });
  await apiOk(page, 'POST', `/water-accounts/${a.waterAccount.id}/close`, {});

  await login(page);
  await open360(page, a.waterAccount.accountNo);
  await expect(drawer(page)).toContainText('销户');
  await expect(drawer(page)).toContainText('销户日期');

  await tab(page, '水表').click();
  await expect(drawer(page)).toContainText('没有在册水表');
  await expect(drawer(page).getByRole('button', { name: /水表操作/ })).toHaveCount(0);

  await tab(page, '事件').click();
  await expect(drawer(page)).toContainText('销户');
  await evidence(page, info, 's4-closed', {});
});

test('S5: 跨营业所 scope — /360 403 + 列表隐藏', async ({ page }, info) => {
  const a = await onboard(page, 's5');
  // 户挂在总公司册下；branch 员工 scope=[branch] → 出界
  await seedBookCoverage(a.waterAccount.id, companyOrgId, 's5');
  await db(async (p) => {
    const branch = await p.orgUnit.create({
      data: {
        tenantId,
        parentId: companyOrgId,
        name: `E8 营业所 ${stamp}`,
        type: 'BRANCH',
      },
    });
    const reader = await p.role.findUniqueOrThrow({
      where: { tenantId_code: { tenantId, code: 'reader' } },
    });
    const passwordHash = await bcrypt.hash('uat12345', 10);
    const staff = await p.staff.create({
      data: {
        tenantId,
        orgUnitId: branch.id,
        login: `e8-branch-${stamp}`,
        name: 'E8 营业所员',
        passwordHash,
        status: 'ACTIVE',
      },
    });
    await p.staffRole.create({
      data: { tenantId, staffId: staff.id, roleId: reader.id },
    });
  });
  const branchToken = await apiToken(page, `e8-branch-${stamp}`, 'uat12345');

  const r = await api(page, 'GET', `/water-accounts/${a.waterAccount.id}/360`, undefined, branchToken);
  expect(r.status).toBe(403);
  const list = await api(page, 'GET', '/water-accounts?take=200', undefined, branchToken);
  expect(list.status).toBe(200);
  expect((list.body as { id: string }[]).map((x) => x.id)).not.toContain(
    a.waterAccount.id,
  );

  // UI 层复核：branch 员工登录后按户号精确搜索 → 空表
  await login(page, `e8-branch-${stamp}`, 'uat12345');
  await page.goto('/customer/water-accounts');
  await ready(page);
  const q = page.getByPlaceholder('按户号精确查询');
  await q.fill(a.waterAccount.accountNo);
  await q.press('Enter');
  await expect(main(page)).toContainText('暂无数据');
  await evidence(page, info, 's5-scope', {});
});

test('S6: 多 ACTIVE 表 — 概览警示如实展示', async ({ page }, info) => {
  const a = await onboard(page, 's6');
  const spare = await apiOk(page, 'POST', '/meters', { brand: 'e8-spare', caliber: 'DN15' });
  await apiOk(page, 'POST', '/meter-installations', {
    waterAccountId: a.waterAccount.id,
    meterId: spare.id,
    initialReading: 0,
  });

  await login(page);
  await open360(page, a.waterAccount.accountNo);
  await expect(drawer(page).locator('.ant-alert-warning')).toContainText('多块在册水表');
  await expect(drawer(page)).toContainText('2 块');
  await evidence(page, info, 's6-multi-active-warning', {});
});

test('S7: 账单历史分页 — 第 2 页可达', async ({ page }, info) => {
  const a = await onboard(page, 's7');
  // 11 张历史账单 → 账单 Tab 第 2 页 1 行
  await db(async (p) => {
    for (let i = 0; i < 11; i++) {
      await p.bill.create({
        data: {
          tenantId,
          settleAccountId: a.waterAccount.settleAccountId,
          waterAccountId: a.waterAccount.id,
          period: `2025${String(1 + i).padStart(2, '0')}`,
          billKind: 'NORMAL',
          sourceType: 'MANUAL',
          sourceId: crypto.randomUUID(),
          status: 'PAID',
          totalAmount: BigInt(1000 + i),
        },
      });
    }
  });

  await login(page);
  await open360(page, a.waterAccount.accountNo);
  await tab(page, '账单').click();
  await expect(drawer(page).locator('.ant-pagination-item-2')).toBeVisible();
  await drawer(page).locator('.ant-pagination-item-2').click();
  // 账期倒序：第 2 页只剩最旧一期（202501）
  await expect(drawer(page)).toContainText('2025-01');
  await evidence(page, info, 's7-bills-paged', {});
});
