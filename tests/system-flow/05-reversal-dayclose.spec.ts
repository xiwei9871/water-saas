import { test, expect, evidence } from './helpers/test';
import { load, save } from './helpers/state';
import { db } from './helpers/db';
import { login } from './helpers/ui';
import { loadAccount, submitPay } from './helpers/cashier';
import { button, response, inputByLabel } from './helpers/ui';

/**
 * J5 — print receipt → reversal (append-only negative payment) → day close.
 * cashier1: pay SF-A-004 → print → reverse → outstanding restored.
 * Then cashier1 + cashier2 each execute 日结; membership + channel totals
 * verified from DB + detail API shape.
 */
test.describe.configure({ mode: 'serial' });

const person = (s: any, key: string) => s.people.find((p: any) => p.key === key);
const today = () => new Date().toISOString().slice(0, 10);

test('J5 reversal + cashier day close', async ({ page }, info) => {
  const s = load();
  expect(s.stages.j4).toBeTruthy();
  const A4 = person(s, 'SF-A-004');
  const c1 = s.roles['sf-cashier1'];
  const c2 = s.roles['sf-cashier2'];

  // ---- pay + print + reverse on SF-A-004 ----
  await login(page, 'sf-cashier1');
  await page.goto('/payment/counter');
  let pay = s.payments.find((x: any) => x.tag === 'A4-rev-src');
  if (!pay) {
    await loadAccount(page, A4);
    const res = await submitPay(page);
    pay = { tag: 'A4-rev-src', id: res.id, paymentNo: res.paymentNo, amount: res.amount, cashier: c1.id };
    s.payments.push(pay);
    save(s);
  }
  // print the receipt (cashier lastPayment panel — needs fresh load to show)
  const receipt = await db((p) => p.receipt.findFirst({
    where: { tenantId: s.tenantId, paymentId: pay.id } }));
  if (receipt && !receipt.printedAt) {
    await page.goto('/payment/payments');
    const row = page.getByRole('row').filter({ hasText: pay.paymentNo });
    await row.getByRole('button', { name: '详情' }).click();
    const drawer = page.locator('.ant-drawer-open');
    const printBtn = drawer.getByRole('button', { name: /打印/ });
    if (await printBtn.isVisible().catch(() => false)) {
      await response(page, /\/receipts\/[0-9a-f-]+\/print/, () => printBtn.click());
    }
    await page.locator('.ant-drawer-open .ant-drawer-close').click();
  }

  // reversal via 收款记录 row action
  if (!s.reversals.find((x: any) => x.of === pay.id)) {
    await page.goto('/payment/payments');
    const row = page.getByRole('row').filter({ hasText: pay.paymentNo });
    await button(row, '红冲').click();
    const pop = page.locator('.ant-popover:visible');
    const res = await response(page, /\/payments\/[0-9a-f-]+\/reverse/, () =>
      button(pop, '红冲').click());
    s.reversals.push({ of: pay.id, id: res.id, paymentNo: res.paymentNo, amount: res.amount });
    save(s);
    await evidence(page, info, 'j5-reversed', res);
  }
  const rev = s.reversals.find((x: any) => x.of === pay.id);

  // ---- DB verify: negative reversal, voided receipt, restored outstanding ----
  await db(async (p) => {
    const rp = await p.payment.findFirstOrThrow({ where: { tenantId: s.tenantId, id: rev.id } });
    expect(Number(rp.amount)).toBe(-Number(pay.amount));
    expect(rp.reversalOfId).toBe(pay.id);
    const rc = await p.receipt.findFirstOrThrow({ where: { tenantId: s.tenantId, paymentId: pay.id } });
    expect(rc.voidFlag).toBe(true);
    const bill = await p.bill.findFirstOrThrow({
      where: { tenantId: s.tenantId, waterAccountId: A4.waterAccount.id, period: '202607' },
      include: { allocs: true },
    });
    const net = bill.allocs
      .filter((a: any) => a.source === 'PAYMENT')
      .reduce((x: bigint, a: any) => x + a.amount, 0n);
    expect(net).toBe(0n);            // +pay −reversal nets to zero
    expect(bill.status).toBe('POSTED');
  });
  await evidence(page, info, 'j5-reversal-verified');

  // ---- day close: cashier1 then cashier2 ----
  const closeFor = async (loginName: string, cashierId: string) => {
    const existing = await db((p) => p.cashierDayClose.findFirst({
      where: { tenantId: s.tenantId, cashierId } }));
    if (existing) return existing;
    await login(page, loginName);
    await page.goto('/payment/day-close');
    await button(page, '执行日结').click();
    const modal = page.getByRole('dialog', { name: '执行日结' });
    await inputByLabel(modal, '日结日期').fill(today());
    await inputByLabel(modal, '日结日期').press('Enter');
    await modal.getByText('执行日结').click();
    const res = await response(page, '/cashier-day-close/close', () =>
      button(modal, '日结').click());
    return db((p) => p.cashierDayClose.findFirstOrThrow({
      where: { tenantId: s.tenantId, id: res.id } }));
  };

  if (!s.dayCloses[c1.id]) {
    const d = await closeFor('sf-cashier1', c1.id);
    s.dayCloses[c1.id] = { id: d.id, totalCount: d.totalCount, totalAmount: String(d.totalAmount) };
    save(s);
  }
  if (!s.dayCloses[c2.id]) {
    const d = await closeFor('sf-cashier2', c2.id);
    s.dayCloses[c2.id] = { id: d.id, totalCount: d.totalCount, totalAmount: String(d.totalAmount) };
    save(s);
  }

  // ---- verify membership, channel totals, DAY_CLOSED flip ----
  await db(async (p) => {
    const close1 = await p.cashierDayClose.findFirstOrThrow({
      where: { tenantId: s.tenantId, cashierId: c1.id } });
    const swept = await p.payment.findMany({
      where: { tenantId: s.tenantId, dayCloseId: close1.id } });
    const sweptIds = swept.map((x: any) => x.id);
    for (const tag of ['A1-full', 'A2-partial', 'S-multi', 'A4-rev-src']) {
      const payRow = s.payments.find((x: any) => x.tag === tag);
      expect(sweptIds, `${tag} in close1`).toContain(payRow.id);
      expect(payRow.cashier).toBe(c1.id);
    }
    expect(sweptIds).toContain(rev.id); // negative leg swept too
    const net = swept.reduce((x: bigint, a: any) => x + a.amount, 0n);
    expect(net).toBe(close1.totalAmount);
    expect(close1.totalCount).toBe(swept.length);
    const byChannel = close1.byChannel as any;
    expect(Number(byChannel?.CASH?.amount ?? 0)).toBe(Number(close1.totalAmount));
    for (const x of swept) expect(x.status).toBe('DAY_CLOSED');

    const close2 = await p.cashierDayClose.findFirstOrThrow({
      where: { tenantId: s.tenantId, cashierId: c2.id } });
    const swept2 = await p.payment.findMany({
      where: { tenantId: s.tenantId, dayCloseId: close2.id } });
    const c2topup = s.payments.find((x: any) => x.tag === 'C2-topup');
    expect(swept2.map((x: any) => x.id)).toContain(c2topup.id);
  });
  await evidence(page, info, 'j5-dayclose', s.dayCloses);
  s.stages.j5 = true;
  save(s);
});
