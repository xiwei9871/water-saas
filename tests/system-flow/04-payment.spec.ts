import { test, expect, evidence } from './helpers/test';
import { load, save } from './helpers/state';
import { db } from './helpers/db';
import { login } from './helpers/ui';
import { loadAccount, allocInput, submitPay, topUp } from './helpers/cashier';
import { generatePlan, startPlan, enterSingle, qcReading } from './helpers/reading';
import { response, button, inputByLabel, selectPerson } from './helpers/ui';

/**
 * J4 — 收费台: full / partial / multi-bill cash payment + TOP_UP,
 * then a period-2 bill for the topped-up account auto-APPLYs the balance.
 * Accounting invariant checked in DB:
 *   bill.total = PAYMENT allocs + PREPAYMENT allocs + remaining outstanding.
 */
const P1 = '202607';
const P2 = '202608';

test.describe.configure({ mode: 'serial' });

const person = (s: any, key: string) => s.people.find((p: any) => p.key === key);

async function billInvariant(s: any, settleAccountId: string, period: string) {
  return db(async (p) => {
    const bills = await p.bill.findMany({
      where: { tenantId: s.tenantId, settleAccountId, period },
      include: { allocs: true },
    });
    for (const b of bills) {
      const pay = b.allocs.filter((a: any) => a.source === 'PAYMENT').reduce((x: bigint, a: any) => x + a.amount, 0n);
      const pre = b.allocs.filter((a: any) => a.source === 'PREPAYMENT').reduce((x: bigint, a: any) => x + a.amount, 0n);
      const allocated = pay + pre;
      expect(allocated <= b.totalAmount, `bill ${b.id} over-allocated`).toBeTruthy();
    }
    return bills;
  });
}

test('J4 payments + prepayment apply', async ({ page }, info) => {
  const s = load();
  expect(s.stages.j3).toBeTruthy();
  const A1 = person(s, 'SF-A-001');
  const A2 = person(s, 'SF-A-002');
  const S1 = person(s, 'SF-S-001');
  const S2 = person(s, 'SF-S-002');
  const C2 = person(s, 'SF-C-002');
  const cashier1 = s.roles['sf-cashier1'];
  const cashier2 = s.roles['sf-cashier2'];

  await login(page, 'sf-cashier1');
  await page.goto('/payment/counter');
  await expect(page.getByText('收费台')).toBeVisible();

  // ---- case 1: full cash payment on SF-A-001 ----
  if (!s.payments.find((x: any) => x.tag === 'A1-full')) {
    await loadAccount(page, A1);
    const res = await submitPay(page);
    s.payments.push({ tag: 'A1-full', id: res.id, paymentNo: res.paymentNo, amount: res.amount, cashier: cashier1.id });
    save(s);
    await expect(page.getByText('收款完成')).toBeVisible();
    await evidence(page, info, 'j4-pay-full', res);
  }

  // ---- case 2: partial payment on SF-A-002 (¥1.00 of a larger bill) ----
  if (!s.payments.find((x: any) => x.tag === 'A2-partial')) {
    await loadAccount(page, A2);
    await allocInput(page, '2026-07').fill('1');
    const res = await submitPay(page);
    expect(Number(res.amount)).toBe(100);
    s.payments.push({ tag: 'A2-partial', id: res.id, amount: res.amount, cashier: cashier1.id });
    save(s);
    await evidence(page, info, 'j4-pay-partial', res);
  }

  // ---- case 3: multi-bill — SF-S-001/SF-S-002 share one settle account ----
  if (!s.payments.find((x: any) => x.tag === 'S-multi')) {
    await loadAccount(page, S1);
    // both shared-account bills are prefilled at full outstanding
    const rows = page.getByRole('row').filter({ hasText: '2026-07' });
    await expect(rows).toHaveCount(2);
    const res = await submitPay(page);
    expect(res.allocs.length).toBe(2);
    s.payments.push({ tag: 'S-multi', id: res.id, amount: res.amount, cashier: cashier1.id });
    save(s);
    await evidence(page, info, 'j4-pay-multi', res);
  }

  // ---- DB verify: P1 invariants on the touched settle accounts ----
  for (const [p, tag] of [[A1, 'A1-full'], [A2, 'A2-partial'], [S1, 'S-multi']] as const) {
    const bills = await billInvariant(s, p.settleAccount.id, P1);
    if (tag === 'A1-full') {
      expect(bills[0].status).toBe('PAID');
    } else if (tag === 'A2-partial') {
      expect(bills[0].status).toBe('PARTIAL_PAID');
    } else {
      expect(bills.map((b: any) => b.status).sort()).toEqual(['PAID', 'PAID']);
      expect(bills.length).toBe(2);
    }
  }

  // ---- prepayment: cashier2 TOP_UP on SF-C-002 (clears debt + balance) ----
  if (!s.payments.find((x: any) => x.tag === 'C2-topup')) {
    await login(page, 'sf-cashier2');
    await page.goto('/payment/counter');
    await loadAccount(page, C2);
    const debt = await db(async (p) => {
      const b = await p.bill.findFirstOrThrow({
        where: { tenantId: s.tenantId, waterAccountId: C2.waterAccount.id, period: P1 } });
      const allocs = await p.paymentAlloc.findMany({ where: { tenantId: s.tenantId, billId: b.id } });
      return Number(b.totalAmount) - allocs.reduce((x: number, a: any) => x + Number(a.amount), 0);
    });
    const topUpYuan = ((debt + 5000) / 100).toFixed(2); // debt + ¥50 buffer
    const res = await topUp(page, topUpYuan);
    s.payments.push({ tag: 'C2-topup', id: res.payment.id, amount: res.payment.amount, cashier: cashier2.id });
    s.prepaid = { settleAccountId: C2.settleAccount.id, balanceAfter: res.balance };
    save(s);
    await evidence(page, info, 'j4-topup', res);
  }

  // ---- later bill auto-APPLY: P2 slice for SF-C-002 only ----
  // book C gets a 202608 plan; only C-002 is read/finalized so the P2 run
  // bills exactly one account and the prepayment balance must cover it.
  const bookC = s.books.find((b: any) => b.bookNo === 'SF-BOOK-C');
  if (!s.plans[`${P2}-C`]) {
    await login(page, 'admin');
    const existing = await db((p) => p.readingPlan.findFirst({
      where: { tenantId: s.tenantId, bookId: bookC.id, period: P2 } }));
    if (!existing) await generatePlan(page, '城南一册', P2, 'SF-BOOK-C');
    const plan = existing ?? await db((p) => p.readingPlan.findFirstOrThrow({
      where: { tenantId: s.tenantId, bookId: bookC.id, period: P2 } }));
    await startPlan(page, '城南一册', plan.id, '2026-08');
    s.plans[`${P2}-C`] = { id: plan.id, bookKey: 'C', period: P2 };
    save(s);
  }
  const c2Usage = 12;
  const c2Read = await db(async (p) => p.meterReading.findMany({
    where: { tenantId: s.tenantId, installation: { waterAccountId: C2.waterAccount.id }, period: P2 },
  }));
  if (c2Read.length === 0) {
    const prev = Number((await db((p) => p.meterReading.findFirstOrThrow({
      where: { tenantId: s.tenantId, installation: { waterAccountId: C2.waterAccount.id }, period: P1 },
      orderBy: { createdAt: 'desc' },
    }))).readingValue);
    await enterSingle(page, s.plans[`${P2}-C`].id, '城南一册', 'SF-C-002', String(prev + c2Usage), '2026-08');
  }
  const c2Live = await db(async (p) => {
    const all = await p.meterReading.findMany({
      where: { tenantId: s.tenantId, installation: { waterAccountId: C2.waterAccount.id }, period: P2 },
      select: { id: true, qcStatus: true, supersedesReadingId: true } });
    const sup = new Set(all.map((r: any) => r.supersedesReadingId).filter(Boolean));
    return all.filter((r: any) => !sup.has(r.id))[0];
  });
  if (c2Live?.qcStatus === 'PENDING') {
    await login(page, 'sf-reviewer');
    await qcReading(page, 'SF-C-002', '通过');
  }

  // settlement + FINAL for SF-C-002 @ 202608 via UI
  let st = await db((p) => p.consumptionSettlement.findFirst({
    where: { tenantId: s.tenantId, waterAccountId: C2.waterAccount.id, period: P2 } }));
  if (!st || st.status === 'DRAFT') {
    await login(page);
    await page.goto('/settlement/list');
    if (!st) {
      await button(page, '生成结算').click();
      const modal = page.getByRole('dialog', { name: '生成结算（草稿）' });
      await selectPerson(page, modal, C2);
      await inputByLabel(modal, '账期').fill('2026-08');
      await inputByLabel(modal, '账期').press('Enter');
      await modal.getByText('生成结算（草稿）').click();
      await response(page, '/consumption-settlements', () => button(modal, '生成').click());
      await expect(modal).toBeHidden();
      st = await db((p) => p.consumptionSettlement.findFirstOrThrow({
        where: { tenantId: s.tenantId, waterAccountId: C2.waterAccount.id, period: P2 } }));
    }
    if (st.status === 'DRAFT') {
      const row = page.getByRole('row').filter({ hasText: 'SF-C-002' }).filter({ hasText: '2026-08' });
      await row.getByRole('button', { name: '终审' }).click();
      const pop = page.locator('.ant-popover:visible');
      await response(page, /\/consumption-settlements\/[0-9a-f-]+\/finalize/, () =>
        button(pop, '终审').click());
    }
  }

  // P2 billing run (auto-APPLY happens at post time)
  await page.goto('/billing/runs');
  let run2 = await db((p) => p.billingRun.findFirst({
    where: { tenantId: s.tenantId, period: P2 } }));
  if (!run2) {
    await button(page, '新建开账批次').click();
    const modal = page.getByRole('dialog', { name: '新建开账批次' });
    await inputByLabel(modal, '账期').fill('2026-08');
    await inputByLabel(modal, '账期').press('Enter');
    await modal.getByText('新建开账批次').click();
    await response(page, '/billing-runs', () => button(modal, '生成').click());
    await expect(modal).toBeHidden({ timeout: 60_000 });
    run2 = await db((p) => p.billingRun.findFirstOrThrow({
      where: { tenantId: s.tenantId, period: P2 } }));
  }
  if (run2.status === 'DRAFT') {
    const row = page.getByRole('row').filter({ hasText: '2026-08' });
    await row.getByRole('button', { name: '执行开账' }).click();
    const pop = page.locator('.ant-popover:visible');
    await response(page, /\/billing-runs\/[0-9a-f-]+\/post/, () =>
      button(pop, '执行').click());
    run2 = await db((p) => p.billingRun.findFirstOrThrow({
      where: { tenantId: s.tenantId, id: run2!.id } }));
  }
  expect(run2!.status).toBe('POSTED');
  expect(run2!.totalCount).toBe(1);

  // ---- APPLY verification ----
  await db(async (p) => {
    const bill = await p.bill.findFirstOrThrow({
      where: { tenantId: s.tenantId, waterAccountId: C2.waterAccount.id, period: P2 },
      include: { allocs: true },
    });
    const pre = bill.allocs.filter((a: any) => a.source === 'PREPAYMENT');
    expect(pre.length).toBeGreaterThan(0);
    expect(pre.reduce((x: bigint, a: any) => x + a.amount, 0n)).toBe(bill.totalAmount);
    expect(bill.status).toBe('PAID');
    const apply = await p.prepaymentLedgerEntry.findMany({
      where: { tenantId: s.tenantId, settleAccountId: C2.settleAccount.id, type: 'APPLY' } });
    expect(apply.length).toBeGreaterThan(0);
  });
  await evidence(page, info, 'j4-apply', { run2: run2!.id });
  s.stages.j4 = true;
  save(s);
});
