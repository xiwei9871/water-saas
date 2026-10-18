import { test, expect, measure } from './helpers/test';
import { load, save } from './helpers/state';
import { db } from './helpers/db';
import { button, choose, evidence, login, main, ready, response, row, selectPerson } from './helpers/ui';
import { cents, channelLabels, channels, money, outstanding, paymentPlan, transactions } from './helpers/payment';

// All writes originate from the rendered UI. A saved pending operation stops replay
// after an ambiguous transport failure; it must be reconciled read-only first.
test('Pilot payment: 26 payments, receipts, reversals and two cashier closes', async ({ page }, info) => {
  test.setTimeout(900_000);
  let s = load();
  const completed = s.stages.payment === true;
  test.skip(!s.stages.billing, 'BLOCKED: two billing periods must be POSTED first');
  expect(s.pendingPaymentOperation, 'Unreconciled operation: inspect persistent DB read-only before resuming').toBeFalsy();
  const actions = paymentPlan(s);
  if (!completed) { s.paymentPlan = actions; save(s); }
  let loggedIn = '';
  async function asCashier(key: string) {
    if (loggedIn !== key) { const role = s.roles[key]; await login(page, role.login, role.password || 'Pilot12345'); loggedIn = key; }
  }
  async function write<T>(key: string, path: string, click: () => Promise<unknown>, persist: (value: T) => void): Promise<T> {
    s.pendingPaymentOperation = { key, path, startedAt: new Date().toISOString() }; save(s);
    const value = await response(page, path, click) as T;
    persist(value); delete s.pendingPaymentOperation; save(s);
    return value;
  }
  async function paymentList(payment: any) {
    await page.goto('/payment/payments'); await ready(page);
    const person = s.people.find(p => p.settleAccount.id === payment.settleAccountId);
    await choose(page, main(page).getByText('按结算户过滤', { exact: true }), `${person.settleAccount.name || person.customer.name}（${person.settleAccount.settleNo}）`, person.settleAccount.name || person.customer.name);
    await expect(row(page, payment.paymentNo)).toBeVisible();
  }
  try {
    if (completed) {
      // A suite rerun verifies persisted results without replaying any writes.
      const ids = transactions(s).map(p => p.id);
      const persisted: any[] = await db(async p => {
        const payments = await p.payment.findMany({ where: { id: { in: ids } }, include: { allocs: true } });
        const receipts = await p.receipt.findMany({ where: { paymentId: { in: ids } } });
        return payments.map((payment: any) => ({ ...payment, receipt: receipts.find((r: any) => r.paymentId === payment.id) }));
      });
      expect(persisted).toHaveLength(28);
      for (const saved of transactions(s)) {
        const actual = persisted.find(p => p.id === saved.id);
        expect(actual).toBeTruthy(); expect(String(actual.amount)).toBe(String(saved.amount));
        expect(actual.cashierId).toBe(saved.cashierId); expect(actual.channel).toBe(saved.channel);
        expect(actual.status).toBe('DAY_CLOSED');
        expect(actual.allocs.map((a: any) => `${a.billId}:${a.amount}`).sort()).toEqual(saved.allocs.map((a: any) => `${a.billId}:${a.amount}`).sort());
        if (s.reversals.some((r: any) => r.reversalOfId === saved.id)) expect(actual.receipt.voidFlag).toBe(true);
        if (s.printedReceipts.some((r: any) => r.paymentId === saved.id)) expect(actual.receipt.printedAt).toBeTruthy();
      }
      for (const cashier of ['cashier1', 'cashier2']) {
        await asCashier(cashier); await page.goto('/payment/day-close'); await ready(page);
        const saved = s.dayCloses.find((c: any) => c.cashierId === s.roles[cashier].id);
        const detail = await response(page, `/cashier-day-close/${saved.id}`, () => button(main(page).locator(`tr[data-row-key="${saved.id}"]`), '详情').click(), 'GET');
        const own = transactions(s).filter(p => p.cashierId === s.roles[cashier].id);
        expect(cents(detail.totalAmount)).toBe(own.reduce((n, p) => n + cents(p.amount), 0));
        expect(detail.payments.map((p: any) => p.id).sort()).toEqual(own.map(p => p.id).sort());
        await expect(page.getByRole('dialog')).toContainText(money(detail.totalAmount));
        await evidence(page, info, `persisted-close-${cashier}`, detail);
      }
      return;
    }
    for (const action of actions) {
      if (s.payments.some(p => p.pilotKey === action.key)) continue;
      await test.step(action.key + ' ' + action.mode, async () => measure(page, action.key, async () => {
        const person = s.people[action.personIndex];
        expect(['C', 'F']).not.toContain(person.group);
        await asCashier(action.cashier);
        await page.goto('/payment/counter'); await ready(page);
        const before = await response(page, `/water-accounts/${person.waterAccount.id}/outstanding`, () => selectPerson(page, main(page), person, '先选客户', '再选用水户'), 'GET');
        // The product deliberately shows debt for the entire settlement account.
        const siblingAccounts = new Set(s.people.filter(p => p.settleAccount.id === person.settleAccount.id).map(p => p.waterAccount.id));
        const accountBills = s.bills.filter(b => siblingAccounts.has(b.waterAccountId));
        const expectedBefore = accountBills.reduce((n, b) => n + outstanding(s, b.id), 0);
        expect(cents(before.totalOutstanding)).toBe(expectedBefore);
        await expect(main(page).locator('.ant-statistic').filter({ hasText: '合计欠费（净额）' })).toContainText((expectedBefore / 100).toFixed(2));
        for (const item of before.items) expect(cents(item.outstanding)).toBe(outstanding(s, item.billId));
        await button(main(page), '清空分摊').click();
        for (const allocation of action.allocs) {
          const bill = accountBills.find(b => b.id === allocation.billId);
          expect(cents(allocation.amount)).toBeLessThanOrEqual(outstanding(s, bill.id));
          await main(page).locator(`tr[data-row-key="${bill.id}"]`).getByRole('spinbutton').fill((cents(allocation.amount) / 100).toFixed(2));
        }
        await choose(page, main(page).locator('.ant-form-item').filter({ hasText: '收款渠道' }).getByRole('combobox'), channelLabels[action.channel]);
        const amount = action.allocs.reduce((n, a) => n + cents(a.amount), 0);
        await expect(main(page).locator('.ant-form-item').filter({ hasText: '分摊合计' })).toContainText(money(amount));
        const payment: any = await write(action.key, '/payments', () => main(page).getByRole('button', { name: /收款\s*¥/ }).click(), (value: any) => s.payments.push({ ...value, pilotKey: action.key, pilotMode: action.mode, personIndex: action.personIndex, recordedAt: new Date().toISOString() }));
        expect(payment).toMatchObject({ amount: String(amount), channel: action.channel, cashierId: s.roles[action.cashier].id, settleAccountId: person.settleAccount.id });
        expect(payment.allocs.map((a: any) => ({ billId: a.billId, amount: String(a.amount) })).sort((a: any, b: any) => a.billId.localeCompare(b.billId))).toEqual([...action.allocs].sort((a, b) => a.billId.localeCompare(b.billId)));
        await expect(main(page)).toContainText(`收款完成：${payment.paymentNo}`);
        const after = await response(page, `/water-accounts/${person.waterAccount.id}/outstanding`, () => button(main(page), '刷新欠费').click(), 'GET');
        expect(cents(after.totalOutstanding)).toBe(expectedBefore - amount);
        s.outstandingChecks ||= []; s.outstandingChecks.push({ paymentId: payment.id, before, after, checkedAt: new Date().toISOString() }); save(s);
        await evidence(page, info, action.key, { action, payment, before, after });
      }));
    }
    // Printing is independently checkpointed so a completed payment is never resubmitted.
    for (const mode of ['full-single', 'partial', 'multi-bill']) {
      const payment = s.payments.find(p => p.pilotMode === mode);
      if ((s.printedReceipts || []).some((r: any) => r.paymentId === payment.id)) continue;
      await measure(page, `receipt-${mode}`, async () => {
        const cashier = Object.keys(s.roles).find(k => s.roles[k].id === payment.cashierId)!;
        await asCashier(cashier); await paymentList(payment);
        await button(row(page, payment.paymentNo), '详情').click();
        const drawer = page.getByRole('dialog'); await expect(drawer).toContainText(payment.receipt.receiptNo);
        const receipt: any = await write(`print-${payment.id}`, `/receipts/${payment.receipt.id}/print`, () => button(drawer, '打印票据').click(), (value: any) => { s.printedReceipts ||= []; s.printedReceipts.push({ ...value, paymentId: payment.id }); });
        expect(receipt.printedAt).toBeTruthy(); await expect(drawer).not.toContainText('未打印');
        await evidence(page, info, `receipt-${mode}`, receipt);
      });
    }
    for (const original of s.payments.filter(p => ['payment-1', 'payment-2'].includes(p.pilotKey))) {
      if ((s.reversals || []).some((r: any) => r.reversalOfId === original.id)) continue;
      await measure(page, `reverse-${original.pilotKey}`, async () => {
        const cashier = Object.keys(s.roles).find(k => s.roles[k].id === original.cashierId)!;
        await asCashier(cashier); await paymentList(original);
        await button(row(page, original.paymentNo), '红冲').click();
        const reversal: any = await write(`reverse-${original.id}`, `/payments/${original.id}/reverse`, () => button(page.getByRole('tooltip'), '红冲').click(), (value: any) => { s.reversals ||= []; s.reversals.push({ ...value, recordedAt: new Date().toISOString() }); });
        expect(reversal.reversalOfId).toBe(original.id); expect(cents(reversal.amount)).toBe(-cents(original.amount));
        const detail = await response(page, `/payments/${original.id}`, () => button(row(page, original.paymentNo), '详情').click(), 'GET');
        expect(detail.receipt.voidFlag).toBe(true); await expect(page.getByRole('dialog')).toContainText('已作废');
        const person = s.people[original.personIndex];
        await page.goto('/payment/counter'); await ready(page);
        const after = await response(page, `/water-accounts/${person.waterAccount.id}/outstanding`, () => selectPerson(page, main(page), person, '先选客户', '再选用水户'), 'GET');
        expect(cents(after.totalOutstanding)).toBe(s.bills.filter(b => s.people.some(p => p.waterAccount.id === b.waterAccountId && p.settleAccount.id === person.settleAccount.id)).reduce((n, b) => n + outstanding(s, b.id), 0));
        s.reversalChecks ||= []; s.reversalChecks.push({ originalId: original.id, receipt: detail.receipt, outstanding: after }); save(s);
        await evidence(page, info, `reverse-${original.pilotKey}`, { original, reversal, voidReceipt: detail.receipt, after });
      });
    }
    s.unverified ||= {}; s.unverified.nextDayReversal = 'NOT VERIFIED: two reversals executed before today’s closes; no clock change or backdating used.'; save(s);
    for (const cashier of ['cashier1', 'cashier2']) {
      if ((s.dayCloses || []).some((c: any) => c.cashierId === s.roles[cashier].id)) continue;
      await measure(page, `day-close-${cashier}`, async () => {
        await asCashier(cashier); await page.goto('/payment/day-close'); await ready(page);
        await button(main(page), '执行日结').click();
        const dialog = page.getByRole('dialog', { name: '执行日结' });
        const closeDate = await dialog.getByLabel('日结日期', { exact: true }).inputValue();
        const own = transactions(s).filter(p => p.cashierId === s.roles[cashier].id);
        const expected = own.reduce((n, p) => n + cents(p.amount), 0);
        const close: any = await write(`close-${cashier}-${closeDate}`, '/cashier-day-close/close', () => button(dialog, '日结').click(), (value: any) => { s.dayCloses ||= []; s.dayCloses.push(value); });
        expect(close.cashierId).toBe(s.roles[cashier].id); expect(cents(close.totalAmount)).toBe(expected); expect(close.totalCount).toBe(own.length);
        for (const channel of channels) { const bucket = own.filter(p => p.channel === channel); expect(close.byChannel[channel]).toMatchObject({ count: bucket.length, amount: String(bucket.reduce((n, p) => n + cents(p.amount), 0)) }); }
        const closeRow = main(page).locator(`tr[data-row-key="${close.id}"]`);
        const detail = await response(page, `/cashier-day-close/${close.id}`, () => button(closeRow, '详情').click(), 'GET');
        expect(detail.payments.map((p: any) => p.id).sort()).toEqual(own.map(p => p.id).sort());
        await expect(page.getByRole('dialog')).toContainText(money(expected));
        for (const p of own) await expect(page.getByRole('dialog')).toContainText(p.paymentNo);
        s.dayCloseChecks ||= []; s.dayCloseChecks.push({ cashier, closeDate, detail, checkedAt: new Date().toISOString() }); save(s);
        await evidence(page, info, `close-${cashier}`, detail);
      });
    }
    expect(s.payments).toHaveLength(26);
    expect(s.payments.filter(p => p.pilotMode === 'full-single')).toHaveLength(10);
    expect(s.payments.filter(p => p.pilotMode === 'partial')).toHaveLength(5);
    expect(s.payments.filter(p => p.allocs.length >= 2)).toHaveLength(5);
    for (const i of [15, 16, 17]) expect(s.payments.filter(p => p.personIndex === i)).toHaveLength(3);
    expect(s.payments.filter(p => p.channel === 'POS').length).toBeGreaterThanOrEqual(3);
    expect(s.payments.filter(p => p.channel === 'TRANSFER').length).toBeGreaterThanOrEqual(2);
    expect(s.reversals).toHaveLength(2); expect(s.dayCloses).toHaveLength(2);
    expect(s.outstandingChecks).toHaveLength(26); expect(s.reversalChecks).toHaveLength(2); expect(s.dayCloseChecks).toHaveLength(2);
    for (const p of s.people.filter(p => p.group === 'C')) expect(s.payments.filter(x => x.settleAccountId === p.settleAccount.id)).toHaveLength(0);
    s.stages.payment = true; save(s);
  } finally { await info.attach('payment-business-state', { body: JSON.stringify(load(), null, 2), contentType: 'application/json' }); }
});
