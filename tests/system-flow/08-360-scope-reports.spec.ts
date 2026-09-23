import { test, expect, evidence } from './helpers/test';
import { load, save } from './helpers/state';
import { db } from './helpers/db';
import { login, button, date } from './helpers/ui';
import { apiAs } from './helpers/api';

/**
 * J8 — 360° aggregation, org scope / RBAC, reports, persistence.
 *  - 360 drawer: every permission-gated tab lazy-loads real domain data.
 *  - Persistence: reload / navigate-away-back / logout-login keep state.
 *  - Scope: branchop (城东 subtree) sees book-A accounts, NOT book-B;
 *    out-of-scope /360 is a hard 403 ORG_OUT_OF_SCOPE.
 *  - Reports: ar-monthly billed, collected-monthly, cashier-daily totals
 *    reconcile with the same predicates the API documents.
 *  - Financial invariant: PAID bills fully allocated (PAYMENT+PREPAYMENT).
 */
const P1 = '202607';
const cent = (v: bigint | number | string) => `¥${(Number(v) / 100).toFixed(2)}`;

const person = (s: any, key: string) => s.people.find((p: any) => p.key === key);

/** List → 按户号精确查询 → 360° drawer. */
async function open360(page: any, accountNo: string) {
  await page.goto('/customer/water-accounts');
  const search = page.getByPlaceholder('按户号精确查询');
  await search.fill(accountNo);
  await search.press('Enter');
  const row = page.getByRole('row').filter({ hasText: accountNo });
  await expect(row).toBeVisible();
  await button(row, '360°').click();
  const drawer = page.locator('.ant-drawer-open');
  await expect(drawer).toBeVisible();
  return drawer;
}

async function tab(page: any, name: string) {
  const t = page.locator('.ant-drawer-open').getByRole('tab', { name });
  await t.click();
  await page.waitForLoadState('networkidle').catch(() => {});
}

test('J8 360 / scope / reports', async ({ page, audit }, info) => {
  const s = load();
  expect(s.stages.j7).toBeTruthy();
  const A1 = person(s, 'SF-A-001');
  const B1 = person(s, 'SF-B-001');

  // ---------- 360°: every domain tab on SF-A-001 ----------
  await login(page);
  let drawer = await open360(page, 'SF-A-001');
  await expect(drawer.getByText('户号')).toBeVisible();
  await expect(drawer.getByText('SF-A-001').first()).toBeVisible();

  await tab(page, '水表');
  await expect(drawer.getByText(/M-SF-A-001/).first()).toBeVisible();

  await tab(page, '抄表');
  await expect(drawer.getByRole('row').filter({ hasText: '2026-07' }).first()).toBeVisible();

  await tab(page, '结算');
  await expect(drawer.getByRole('row').filter({ hasText: '已核定' }).first()).toBeVisible();

  await tab(page, '账单');
  await expect(drawer.getByRole('row').filter({ hasText: '已缴清' }).first()).toBeVisible();

  await tab(page, '缴费');
  await expect(drawer.getByText('欠费合计')).toBeVisible();

  await tab(page, '预存');
  await expect(drawer.getByRole('tabpanel', { name: '预存' }).getByText('预存余额')).toBeVisible();

  await tab(page, '事件');
  await expect(drawer.getByRole('tabpanel', { name: '事件' }).locator('.ant-table')).toBeVisible();
  await evidence(page, info, 'j8-360-tabs', null);
  await page.locator('.ant-drawer-open .ant-drawer-close').click();

  // ---------- persistence: reload → reopen; away/back; logout/login ----------
  await page.reload();
  drawer = await open360(page, 'SF-A-001');
  await expect(drawer.getByText('SF-A-001').first()).toBeVisible();
  await page.locator('.ant-drawer-open .ant-drawer-close').click();

  await page.goto('/exceptions');
  await expect(page.getByText('异常队列').first()).toBeVisible();
  drawer = await open360(page, 'SF-A-001');
  await expect(drawer.getByText('SF-A-001').first()).toBeVisible();
  await page.locator('.ant-drawer-open .ant-drawer-close').click();

  await login(page); // logout + login again
  drawer = await open360(page, 'SF-A-001');
  await expect(drawer.getByText('SF-A-001').first()).toBeVisible();
  await page.locator('.ant-drawer-open .ant-drawer-close').click();

  // ---------- 缴费 tab: outstanding reconciles with /outstanding ----------
  const partial = await db((p) => p.bill.findFirstOrThrow({
    where: { tenantId: s.tenantId, status: 'PARTIAL_PAID' },
    select: { waterAccountId: true },
  }));
  const partialAcct = await db((p) => p.waterAccount.findUniqueOrThrow({
    where: { id: partial.waterAccountId }, select: { accountNo: true } }));
  const admin = await apiAs('admin');
  const out = await admin.get(`/water-accounts/${partial.waterAccountId}/outstanding`);
  expect(out.status).toBe(200);
  expect(Number(out.body.totalOutstanding)).toBeGreaterThan(0);
  drawer = await open360(page, partialAcct.accountNo);
  await tab(page, '缴费');
  await expect(drawer.getByRole('tabpanel', { name: '缴费' }).getByText(cent(out.body.totalOutstanding)).first()).toBeVisible();
  await page.locator('.ant-drawer-open .ant-drawer-close').click();

  // ---------- 预存 tab: balance + ledger rows reconcile ----------
  const prepay = await db(async (p) => {
    const entries = await p.prepaymentLedgerEntry.findMany({
      where: { tenantId: s.tenantId }, select: { settleAccountId: true, amount: true } });
    const sums = new Map<string, bigint>();
    for (const e of entries) sums.set(e.settleAccountId, (sums.get(e.settleAccountId) ?? 0n) + e.amount);
    const [settleId, balance] = [...sums.entries()].find(([, v]) => v > 0n)!;
    const acct = await p.waterAccount.findFirstOrThrow({
      where: { tenantId: s.tenantId, settleAccountId: settleId }, select: { accountNo: true } });
    return { settleId, balance, accountNo: acct.accountNo };
  });
  const bal = await admin.get(`/prepayments/balance?settleAccountId=${prepay.settleId}`);
  expect(bal.status).toBe(200);
  expect(String(bal.body.balance)).toBe(String(prepay.balance));
  drawer = await open360(page, prepay.accountNo);
  await tab(page, '预存');
  await expect(drawer.getByRole('tabpanel', { name: '预存' }).getByText(cent(prepay.balance)).first()).toBeVisible();
  await page.locator('.ant-drawer-open .ant-drawer-close').click();
  await evidence(page, info, 'j8-360-outstanding-prepay',
    { outstanding: out.body, prepayBalance: bal.body });

  // ---------- scope: branchop （城东） vs SF-B-001 （城西 book) ----------
  const branch = await apiAs('sf-branchop');
  const list = await branch.get('/water-accounts?take=200');
  expect(list.status).toBe(200);
  const nos = (list.body as any[]).map((a: any) => a.accountNo);
  expect(nos).toContain('SF-A-001');
  expect(nos).not.toContain('SF-B-001');
  const b360 = await branch.get(`/water-accounts/${B1.waterAccount.id}/360`);
  expect(b360.status).toBe(403);
  expect(b360.body?.code ?? b360.body?.error?.code).toBe('ORG_OUT_OF_SCOPE');
  const a360 = await branch.get(`/water-accounts/${A1.waterAccount.id}/360`);
  expect(a360.status).toBe(200);
  await branch.dispose();

  // UI mirror: branchop list hides out-of-scope account
  await login(page, 'sf-branchop');
  await page.goto('/customer/water-accounts');
  const search = page.getByPlaceholder('按户号精确查询');
  await search.fill('SF-B-001');
  await search.press('Enter');
  await expect(page.getByRole('row').filter({ hasText: 'SF-B-001' })).toHaveCount(0);
  await search.fill('SF-A-001');
  await search.press('Enter');
  await expect(page.getByRole('row').filter({ hasText: 'SF-A-001' })).toBeVisible();
  await evidence(page, info, 'j8-scope', { listHidden: 'SF-B-001', forbidden: b360.body });

  // ---------- reports reconcile (admin) ----------
  await login(page);

  // 应收月报 202607：Σ bill.total_amount (non-REVERSAL, posted+)
  const billed = await db(async (p) => {
    const rows = await p.bill.findMany({
      where: { tenantId: s.tenantId, period: P1, billKind: { not: 'REVERSAL' },
        status: { in: ['POSTED', 'PARTIAL_PAID', 'PAID'] } },
      select: { totalAmount: true } });
    return rows.reduce((a: bigint, r: any) => a + r.totalAmount, 0n);
  });
  await page.goto('/report/ar-monthly');
  await page.locator('.ant-picker input').first().fill('2026-07');
  await page.locator('.ant-picker input').first().press('Enter');
  const arRes = page.waitForResponse((r) =>
    new URL(r.url()).pathname === '/api/reports/ar-monthly' && r.request().method() === 'GET');
  await button(page, '查 询').or(button(page, '查询')).click();
  const ar = await (await arRes).json();
  expect(String(ar.billed)).toBe(String(billed));
  await expect(page.getByText(cent(billed)).first()).toBeVisible();

  // 实收月报（当前月）：Σ payment.amount RECEIVED|DAY_CLOSED
  const now = new Date();
  const cm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const collected = await db(async (p) => {
    const rows = await p.payment.findMany({
      where: { tenantId: s.tenantId, status: { in: ['RECEIVED', 'DAY_CLOSED'] },
        receivedAt: { gte: monthStart, lt: nextMonth } },
      select: { amount: true } });
    return rows.reduce((a: bigint, r: any) => a + r.amount, 0n);
  });
  await page.goto('/report/collected-monthly');
  const cmRes = page.waitForResponse((r) =>
    new URL(r.url()).pathname === '/api/reports/collected-monthly' && r.request().method() === 'GET');
  await button(page, '刷 新').or(button(page, '刷新')).click();
  const cmBody = await (await cmRes).json();
  expect(String(cmBody.collected)).toBe(String(collected));
  await expect(page.getByText(cent(collected)).first()).toBeVisible();

  // 收费日报（今日）：cashier1 row total == DB same-day sum.
  // The report keys on received_at::date in the DB session TZ — derive the
  // operating date from the DB itself so the check is stable when local and
  // DB dates straddle a boundary (00:00–08:00 CST runs).
  const dbToday = await db(async (p) =>
    (await p.$queryRaw<{ d: string }[]>`SELECT current_date::text AS d`)[0].d);
  const cashier1 = await db(async (p) => {
    const rows = await p.$queryRaw<{ cnt: number; amount: bigint }[]>`
      SELECT count(*)::int AS cnt, coalesce(sum(amount), 0)::bigint AS amount
      FROM payment
      WHERE tenant_id = ${s.tenantId}::uuid
        AND cashier_id = ${s.roles['sf-cashier1'].id}::uuid
        AND status IN ('RECEIVED', 'DAY_CLOSED')
        AND received_at::date = current_date`;
    return { count: rows[0].cnt, amount: rows[0].amount };
  });
  await page.goto('/report/cashier-daily');
  await date(page.locator('.ant-picker').first().locator('input'), dbToday);
  const cdRes = page.waitForResponse((r) =>
    new URL(r.url()).pathname === '/api/reports/cashier-daily' && r.request().method() === 'GET');
  await button(page, '刷 新').or(button(page, '刷新')).click();
  const cd = await (await cdRes).json();
  const row1 = cd.find((r: any) => r.cashierId === s.roles['sf-cashier1'].id);
  expect(row1).toBeTruthy();
  expect(row1.total.count).toBe(cashier1.count);
  expect(String(row1.total.amount)).toBe(String(cashier1.amount));
  await expect(page.getByRole('row').filter({ hasText: '收费员小孙' })).toBeVisible();
  await evidence(page, info, 'j8-reports',
    { arBilled: String(billed), collected: String(collected), cashier1: row1 });

  // ---------- financial invariant: PAID bills fully allocated ----------
  const bad = await db(async (p) => {
    const bills = await p.bill.findMany({
      where: { tenantId: s.tenantId, status: 'PAID' }, select: { id: true, totalAmount: true } });
    const allocs = await p.paymentAlloc.groupBy({
      by: ['billId'], where: { tenantId: s.tenantId }, _sum: { amount: true } });
    const map = new Map(allocs.map((a: any) => [a.billId, a._sum.amount ?? 0n]));
    return bills.filter((b: any) => (map.get(b.id) ?? 0n) !== b.totalAmount).map((b: any) => b.id);
  });
  expect(bad).toEqual([]);

  s.stages.j8 = true;
  save(s);
  await evidence(page, info, 'j8-done', { cashierDaily: cd });
});
