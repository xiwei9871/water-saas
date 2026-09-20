import { test, expect, measure } from './helpers/test';
import { load, save } from './helpers/state';
import { db } from './helpers/db';
import { button, choose, date, evidence, login, main, month, ready, response, row } from './helpers/ui';
import { cents, channelLabels, channels, money, transactions } from './helpers/payment';

// Monthly finance reports are tenant-wide in v0.1.2. Their UI has no account
// filter. Reconcile pilot categories/accounts and assert no foreign finance
// before comparing tenant totals; never quietly count pre-existing customers.
test('Pilot reports: five UI reports reconcile actual dates and billing periods', async ({ page }, info) => {
  test.setTimeout(480_000);
  const s = load();
  // Completed reports are queried and reconciled again: all report actions are read-only.
  test.skip(!s.stages.billing || !s.stages.payment, 'BLOCKED: billing and payments must finish before report reconciliation');
  const allPayments = transactions(s);
  const accountIds = s.people.map(p => p.waterAccount.id);
  const settleIds = [...new Set(s.people.map(p => p.settleAccount.id))];
  const sources: any = await db(async p => {
    const tenant = await p.tenant.findFirstOrThrow({ where: { code: 'cd-water' } });
    const plans = await p.readingPlan.findMany({ where: { bookId: { in: s.books.map(b => b.id) } }, include: { items: true } });
    const readings = await p.meterReading.findMany({ where: { planItem: { plan: { bookId: { in: s.books.map(b => b.id) } } } }, select: { id: true, planItemId: true, readDate: true, supersedesReadingId: true } });
    const foreignBills = await p.bill.count({ where: { tenantId: tenant.id, waterAccountId: { notIn: accountIds }, status: { in: ['POSTED', 'PARTIAL_PAID', 'PAID'] }, billKind: { not: 'REVERSAL' } } });
    const foreignPayments = await p.payment.count({ where: { tenantId: tenant.id, settleAccountId: { notIn: settleIds }, status: { in: ['RECEIVED', 'DAY_CLOSED'] } } });
    const pilotPaymentIds = await p.payment.findMany({ where: { tenantId: tenant.id, settleAccountId: { in: settleIds } }, select: { id: true } });
    const pilotBillIds = await p.bill.findMany({ where: { tenantId: tenant.id, waterAccountId: { in: accountIds }, status: { in: ['POSTED', 'PARTIAL_PAID', 'PAID'] }, billKind: { not: 'REVERSAL' } }, select: { id: true } });
    return { plans, readings, foreignBills, foreignPayments, pilotPaymentIds, pilotBillIds };
  });
  expect(sources.foreignBills, 'Tenant aggregate cannot be compared to Pilot-only state when foreign bills exist').toBe(0);
  expect(sources.foreignPayments, 'Tenant aggregate cannot be compared to Pilot-only state when foreign payments exist').toBe(0);
  expect(sources.pilotPaymentIds.map((p: any) => p.id).sort()).toEqual(allPayments.map(p => p.id).sort());
  expect(sources.pilotBillIds.map((b: any) => b.id).sort()).toEqual(s.bills.map(b => b.id).sort());
  const sum = (rows: any[], field = 'amount') => rows.reduce((n, p) => n + cents(p[field]), 0);
  const receivedMonth = (p: any) => new Date(p.receivedAt).toISOString().slice(0, 7).replace('-', '');
  const receivedDate = (p: any) => new Date(p.receivedAt).toISOString().slice(0, 10);
  const monthly = [...new Set([...s.periods.slice(0, 2), ...allPayments.map(receivedMonth)])].sort();
  await login(page);
  s.reportChecks ||= [];
  async function query(kind: string, key: string, configure: () => Promise<void>, assert: (result: any) => Promise<void>) {
    await test.step(`${kind} ${key}`, async () => measure(page, `report-${kind}-${key}`, async () => {
      await page.goto('/report/' + kind); await ready(page);
      await configure();
      // page initialization has settled; this response is from the real Query click.
      const result = await response(page, '/reports/' + kind, () => button(main(page), '查询').click(), 'GET');
      await assert(result);
      const record = { kind, key, result, checkedAt: new Date().toISOString() };
      s.reportChecks = s.reportChecks.filter((x: any) => !(x.kind === kind && x.key === key)); s.reportChecks.push(record); save(s);
      await evidence(page, info, `report-${kind}-${key}`, record);
    }));
  }
  try {
    const superseded = new Set(sources.readings.map((r: any) => r.supersedesReadingId).filter(Boolean));
    const validReadings = sources.readings.filter((r: any) => !superseded.has(r.id));
    const readingDates = [...new Set<string>(validReadings.map((r: any) => new Date(r.readDate).toISOString().slice(0, 10)))].sort();
    expect(readingDates.length).toBeGreaterThan(0);
    for (const day of readingDates) for (const book of s.books) {
      const bookPlans = sources.plans.filter((p: any) => p.bookId === book.id);
      const periodPlans = bookPlans.filter((p: any) => p.period === day.slice(0, 7).replace('-', ''));
      const items = periodPlans.flatMap((p: any) => p.items);
      const bookItems = new Set(bookPlans.flatMap((p: any) => p.items.map((i: any) => i.id)));
      const readingsTaken = validReadings.filter((r: any) => bookItems.has(r.planItemId) && new Date(r.readDate).toISOString().startsWith(day)).length;
      await query('meter-daily', `${day}-${book.bookNo}`, async () => {
        await date(main(page).locator('.ant-picker-input input').first(), day);
        await choose(page, main(page).getByText('按抄表册过滤（可空）', { exact: true }), `${book.name}（${book.bookNo}）`, book.name);
      }, async result => {
        if (!periodPlans.length && !readingsTaken) { expect(result).toEqual([]); await expect(main(page)).toContainText('当日无抄表工作记录'); return; }
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ bookId: book.id, plans: periodPlans.length, total: items.length, read: items.filter((i: any) => i.status === 'READ').length, noRead: items.filter((i: any) => i.status === 'NO_READ').length, pending: items.filter((i: any) => i.status === 'PENDING').length, skipped: items.filter((i: any) => i.status === 'SKIPPED').length, readingsTaken });
        const display = row(page, book.bookNo); await expect(display).toContainText(book.name);
        await expect(display.getByRole('cell').last()).toHaveText(String(readingsTaken));
      });
    }
    for (const day of [...new Set(allPayments.map(receivedDate))].sort()) {
      await query('cashier-daily', day, async () => date(main(page).locator('.ant-picker-input input').first(), day), async result => {
        const daily = allPayments.filter(p => receivedDate(p) === day);
        expect(result).toHaveLength(new Set(daily.map(p => p.cashierId)).size);
        for (const role of [s.roles.cashier1, s.roles.cashier2]) {
          const own = daily.filter(p => p.cashierId === role.id); if (!own.length) continue;
          const record = result.find((r: any) => r.cashierId === role.id);
          const closed = s.dayCloses.some((c: any) => c.cashierId === role.id && String(c.closeDate).startsWith(day));
          expect(record).toMatchObject({ total: { count: own.length, amount: String(sum(own)) }, closed });
          for (const channel of channels) { const payments = own.filter(p => p.channel === channel); expect(record.byChannel[channel]).toMatchObject({ count: payments.length, amount: String(sum(payments)) }); }
          await expect(row(page, role.name)).toContainText(`${own.length} 笔 ${money(sum(own))}`);
          await expect(row(page, role.name)).toContainText(closed ? '已日结' : '未日结');
        }
      });
    }
    for (const period of monthly) {
      const periodBills = s.bills.filter(b => b.period === period);
      const paid = allPayments.filter(p => receivedMonth(p) === period);
      await query('ar-monthly', period, async () => date(main(page).getByPlaceholder('请选择月份', { exact: true }), month(period)), async result => {
        expect(result.period).toBe(period); expect(cents(result.billed)).toBe(sum(periodBills, 'totalAmount'));
        for (const category of [...new Set(s.people.map(p => p.category))]) {
          const categoryAccounts = new Set(s.people.filter(p => p.category === category).map(p => p.waterAccount.id));
          const bills = periodBills.filter(b => categoryAccounts.has(b.waterAccountId));
          if (!bills.length) { expect(result.byCategory[category]).toBeUndefined(); continue; }
          expect(result.byCategory[category]).toMatchObject({ count: bills.length, amount: String(sum(bills, 'totalAmount')) });
          await expect(row(page, category)).toContainText(money(sum(bills, 'totalAmount')));
        }
        await expect(main(page).locator('.ant-descriptions')).toContainText(money(sum(periodBills, 'totalAmount')));
      });
      await query('collected-monthly', period, async () => date(main(page).getByPlaceholder('请选择月份', { exact: true }), month(period)), async result => {
        expect(result.period).toBe(period); expect(cents(result.collected)).toBe(sum(paid));
        expect(cents(result.allocated)).toBe(sum(paid.flatMap(p => p.allocs)));
        expect(result.allocated).toBe(result.collected);
        for (const channel of channels) { const byChannel = paid.filter(p => p.channel === channel); expect(result.byChannel[channel]).toMatchObject({ count: byChannel.length, amount: String(sum(byChannel)) }); await expect(row(page, channelLabels[channel])).toContainText(money(sum(byChannel))); }
        await expect(main(page).locator('.ant-descriptions')).toContainText(`实收合计${money(sum(paid))}`);
        await expect(main(page).locator('.ant-descriptions')).toContainText(`销账合计（对数）${money(sum(paid))}`);
      });
      await query('recovery-rate', period, async () => date(main(page).getByPlaceholder('请选择月份', { exact: true }), month(period)), async result => {
        const billed = sum(periodBills, 'totalAmount'); const collected = sum(paid);
        expect(cents(result.billed)).toBe(billed); expect(cents(result.collected)).toBe(collected);
        if (billed === 0) { expect(result.rate).toBeNull(); await expect(main(page)).toContainText('应收为 0，回收率无意义'); }
        else { expect(Number(result.rate)).toBeCloseTo(collected / billed, 4); if(billed<0){await expect(main(page)).toContainText('净应收为负，本期回收率不适用');}else{await expect(main(page)).toContainText(`${(Number(result.rate) * 100).toFixed(2)}%`);} }
        await expect(main(page).locator('.ant-descriptions')).toContainText(money(billed));
        await expect(main(page).locator('.ant-descriptions')).toContainText(money(collected));
      });
    }
    const through = monthly[monthly.length - 1];
    await query('recovery-rate', `cumulative-${through}`, async () => {
      await date(main(page).getByPlaceholder('请选择月份', { exact: true }), month(s.periods[0]));
      await date(main(page).getByPlaceholder('截止月（累计口径，可空）', { exact: true }), month(through));
    }, async result => {
      const billed = sum(s.bills.filter(b => b.period <= through), 'totalAmount'); const collected = sum(allPayments.filter(p => receivedMonth(p) <= through));
      expect(result.through).toBe(through); expect(cents(result.billed)).toBe(billed); expect(cents(result.collected)).toBe(collected);
      expect(Number(result.rate)).toBeCloseTo(collected / billed, 4); await expect(main(page)).toContainText(`${(Number(result.rate) * 100).toFixed(2)}%`);
    });
    s.stages.reports = true; save(s);
  } finally { await info.attach('report-business-results', { body: JSON.stringify({ sourceCounts: { foreignBills: sources.foreignBills, foreignPayments: sources.foreignPayments }, reportChecks: s.reportChecks, unverified: s.unverified }, null, 2), contentType: 'application/json' }); }
});
