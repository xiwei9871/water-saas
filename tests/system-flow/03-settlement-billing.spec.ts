import { test, expect, evidence } from './helpers/test';
import { load, save } from './helpers/state';
import { db } from './helpers/db';
import { login } from './helpers/ui';
import { button, response, selectPerson, inputByLabel } from './helpers/ui';

/**
 * J3 — 结算生成 → 终审 → BillingRun create(新 production path) → 执行开账。
 * All writes through the rendered UI; DB used only for reconcile/verify.
 * Period 202607. 19 billable book-member accounts (SF-M-001 monitoring is
 * non-billable, SF-X-001 bookless has no readings — neither gets a settlement).
 */
const P1 = '202607';
const PERIOD_LABEL = '2026-07';

test.describe.configure({ mode: 'serial' });

test('J3 settlement + billing run (period 202607)', async ({ page }, info) => {
  const s = load();
  expect(s.stages.j2).toBeTruthy();
  const billable = s.books.flatMap((b) => b.memberKeys)
    .map((key) => s.people.find((p) => p.key === key)!)
    .filter(Boolean);

  const existingFor = async (accountId: string) =>
    db((p) => p.consumptionSettlement.findFirst({
      where: { tenantId: s.tenantId, waterAccountId: accountId, period: P1 },
    }));

  await login(page);
  await page.goto('/settlement/list');
  await expect(page.getByText('结算水量').first()).toBeVisible();

  // ---- generate + finalize each settlement through the UI ----
  for (const m of billable) {
    const acctId = m.waterAccount.id;
    let st = await existingFor(acctId);
    if (!st) {
      await button(page, '生成结算').click();
      const modal = page.getByRole('dialog', { name: '生成结算（草稿）' });
      await selectPerson(page, modal, m);
      await inputByLabel(modal, '账期').fill(PERIOD_LABEL);
      await inputByLabel(modal, '账期').press('Enter');
      // dismiss the month-panel without closing the modal (Esc hits both)
      await modal.getByText('生成结算（草稿）').click();
      if (m.key === 'SF-A-008') {
        // NO_READ → estimated settlement requires operator qty + reason
        await inputByLabel(modal, '预估用量（可空）').fill('15');
        await inputByLabel(modal, '预估原因').fill('锁闭无法入户，人工预估');
      }
      await response(page, '/consumption-settlements', () => button(modal, '生成').click());
      await expect(modal).toBeHidden();
      st = await existingFor(acctId);
      expect(st, `settlement ${m.key}`).toBeTruthy();
    }
    if (st!.status === 'DRAFT') {
      // pageSize=20 fits all 19 rows; accountNo makes the row unambiguous
      const row = page.getByRole('row').filter({ hasText: m.key });
      await row.getByRole('button', { name: '终审' }).click();
      const pop = page.locator('.ant-popover:visible');
      await response(page, /\/consumption-settlements\/[0-9a-f-]+\/finalize/, () =>
        button(pop, '终审').click());
    }
    const final = await existingFor(acctId);
    expect(final!.status, `settlement status ${m.key}`).toBe('FINAL');
  }
  await evidence(page, info, 'j3-settlements-final', { count: billable.length });

  // ---- DB verify usage / estimate semantics ----
  await db(async (p) => {
    for (const m of billable) {
      const st = await p.consumptionSettlement.findFirstOrThrow({
        where: { tenantId: s.tenantId, waterAccountId: m.waterAccount.id, period: P1 },
      });
      expect(st.status).toBe('FINAL');
      if (m.key === 'SF-A-008') {
        expect(st.isEstimated).toBe(true);
        expect(Number(st.totalUsageQty)).toBe(15);
      } else {
        expect(st.isEstimated).toBe(false);
        const initial = Number(m.installation.initialReading ?? 0);
        const n = Number(m.key.slice(-3));
        const usage = m.key === 'SF-A-003' ? 10 + (n % 7) + 1 : 10 + (n % 7);
        expect(Number(st.totalUsageQty), `usage ${m.key}`).toBe(usage);
      }
    }
  });

  // ---- BillingRun via UI (production BillingRunService.create path) ----
  await page.goto('/billing/runs');
  await expect(page.getByText('开账批次').first()).toBeVisible();
  let run = await db((p) => p.billingRun.findFirst({
    where: { tenantId: s.tenantId, period: P1 },
  }));
  if (!run) {
    await button(page, '新建开账批次').click();
    const modal = page.getByRole('dialog', { name: '新建开账批次' });
    await inputByLabel(modal, '账期').fill(PERIOD_LABEL);
    await inputByLabel(modal, '账期').press('Enter');
    await modal.getByText('新建开账批次').click();
    await response(page, '/billing-runs', () => button(modal, '生成').click());
    await expect(modal).toBeHidden({ timeout: 60_000 });
    run = await db((p) => p.billingRun.findFirstOrThrow({
      where: { tenantId: s.tenantId, period: P1 },
    }));
  }
  s.billingRun = { id: run.id, period: P1 };
  save(s);
  expect(run.generationStatus).toBe('READY');
  expect(run.totalCount).toBe(billable.length);
  // drafted bills aren't "success" until post — 0 pre-post is correct
  expect(run.failedCount).toBe(0);

  if (run.status === 'DRAFT' || run.status === 'PARTIAL') {
    const row = page.getByRole('row').filter({ hasText: '2026-07' });
    await row.getByRole('button', { name: '执行开账' }).click();
    const pop = page.locator('.ant-popover:visible');
    await response(page, /\/billing-runs\/[0-9a-f-]+\/post/, () =>
      button(pop, '执行').click());
    run = await db((p) => p.billingRun.findFirstOrThrow({
      where: { tenantId: s.tenantId, id: run!.id } }));
  }
  expect(run!.status).toBe('POSTED');
  expect(run!.successCount).toBe(billable.length);
  expect(run!.failedCount).toBe(0);
  await evidence(page, info, 'j3-run-posted', {
    runId: run!.id, total: run!.totalCount, success: run!.successCount, failed: run!.failedCount,
  });

  // ---- bills: exact cent-level truth recomputed from fixtures ----
  // Independent due-date rule: last calendar day of the period + bill_due_days
  // (tenant param, service default 15). 202607 + 15 → 2026-08-15.
  const dueDays = await db(async (p) => {
    const row = await p.tenantParam.findUnique({
      where: { tenantId_key: { tenantId: s.tenantId, key: 'bill_due_days' } },
      select: { value: true },
    });
    const v = row?.value;
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 15;
  });
  const expectedDue = new Date(
    Date.UTC(Number(P1.slice(0, 4)), Number(P1.slice(4)), 0) + dueDays * 86_400_000,
  ).toISOString().slice(0, 10);
  expect(expectedDue).toBe('2026-08-15'); // pins the formula for this period
  await db(async (p) => {
    const bills = await p.bill.findMany({
      where: { tenantId: s.tenantId, period: P1 },
      include: { items: true },
    });
    expect(bills.length).toBe(billable.length);
    for (const b of bills) {
      const m = billable.find((x) => x.waterAccount.id === b.waterAccountId);
      expect(m, `bill ${b.id} maps to a billable account`).toBeTruthy();
      const st = await p.consumptionSettlement.findFirstOrThrow({
        where: {
          tenantId: s.tenantId, waterAccountId: b.waterAccountId,
          period: P1, status: 'FINAL',
        },
      });
      const t = s.tariffs[m!.waterAccount.usageCategory];
      const expectedCents = BigInt(
        Math.round(Number(st.totalUsageQty) * Number(t.unitPrice) * 100),
      );
      expect(b.totalAmount, `${m!.key} totalAmount`).toBe(expectedCents);
      const itemSum = b.items.reduce((a: bigint, i: any) => a + BigInt(i.amount), 0n);
      expect(itemSum, `${m!.key} Σ items`).toBe(b.totalAmount);
      expect(b.tariffPlanId, `${m!.key} tariffPlanId`).toBe(t.id);
      expect(b.dueDate!.toISOString().slice(0, 10), `${m!.key} dueDate`).toBe(expectedDue);
      // rerun-safe: J4/J5 may have moved some bills to PARTIAL_PAID/PAID
      expect(['POSTED', 'PARTIAL_PAID', 'PAID']).toContain(b.status);
    }
    // SF-A-008: NO_READ → FINAL estimated settlement, 15 m³ × ¥3 = 4500 cents.
    const estimated = bills.filter((b: any) => b.isEstimated);
    expect(estimated.length).toBe(1);
    expect(estimated[0].waterAccountId)
      .toBe(billable.find((x) => x.key === 'SF-A-008')!.waterAccount.id);
    expect(estimated[0].totalAmount).toBe(4500n);
  });
  s.stages.j3 = true;
  save(s);
});
