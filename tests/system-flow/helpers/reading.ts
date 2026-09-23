import { expect, type Page } from '@playwright/test';
import { choose, date, accountLabel, personLabel, response } from './ui';
import { button } from '../../uat/helpers/ui';

/** 抄表册 modal — admin only (org picker needs iam:read). */
/** A plan list row: book name + optional period label ('2026-07') to
 *  disambiguate when a book has plans in multiple periods. */
const planRowOf = (page: Page, bookName: string, periodLabel?: string) => {
  let row = page.getByRole('row').filter({ hasText: bookName });
  if (periodLabel) row = row.filter({ hasText: periodLabel });
  return row;
};

export async function createBook(
  page: Page,
  opts: { bookNo: string; name: string; orgName: string; readerName?: string; scheduleDay?: number },
) {
  await page.goto('/metering/books');
  await expect(page.getByText('抄表册').first()).toBeVisible();
  await page.getByRole('button', { name: /新建抄表册/ }).click();
  const modal = page.getByRole('dialog', { name: '新建抄表册' });
  await modal.getByLabel('册号').fill(opts.bookNo);
  await modal.getByLabel('册名').fill(opts.name);
  const orgItem = modal.locator('.ant-form-item').filter({ has: page.getByText('所属组织', { exact: true }) });
  await orgItem.locator('.ant-select').click();
  await page.locator('.ant-select-dropdown:visible .ant-select-tree-title, .ant-select-dropdown:visible')
    .getByText(opts.orgName, { exact: true }).first().click();
  if (opts.readerName) {
    await choose(page, modal.getByText('选择抄表员（可空）', { exact: true }), opts.readerName, opts.readerName);
  }
  if (opts.scheduleDay) {
    await modal.getByLabel('计划抄表日').fill(String(opts.scheduleDay));
  }
  return response(page, '/reading-books', () => button(modal, '保存').click());
}

/** 册成员抽屉：customer cascade → water account. */
export async function addBookMembers(page: Page, bookName: string, members: any[]) {
  await page.goto('/metering/books');
  const bookRow = page.getByRole('row').filter({ hasText: bookName });
  await button(bookRow, '成员').click();
  const drawer = page.locator('.ant-drawer-open');
  await expect(drawer.getByText('册成员', { exact: false }).first()).toBeVisible();
  for (const m of members) {
    await choose(page, drawer.getByText('先选客户', { exact: true }), personLabel(m), m.customer.name);
    await choose(page, drawer.getByText('选择水表户', { exact: true }), accountLabel(m));
    await response(page, /\/reading-books\/[0-9a-f-]+\/meters/, () =>
      button(drawer, '加入').click());
    await expect(drawer.getByRole('row').filter({ hasText: m.waterAccount.accountNo })).toBeVisible();
  }
  await page.locator('.ant-drawer-open .ant-drawer-close').click();
  await expect(page.locator('.ant-drawer-open')).toHaveCount(0);
}

/** 生成计划（UI only）。 */
export async function generatePlan(page: Page, bookName: string, period: string, bookNo?: string) {
  const bookOption = bookNo ? `${bookName}（${bookNo}）` : bookName;
  await page.goto('/metering/plans');
  await page.getByRole('button', { name: /生成计划/ }).click();
  const modal = page.getByRole('dialog', { name: '生成抄表计划' });
  await choose(page, modal.getByText('搜索抄表册名称', { exact: true }), bookOption, bookName.slice(0, 4));
  await date(modal.getByLabel('账期'), `${period.slice(0, 4)}-${period.slice(4)}`);
  await response(page, '/reading-plans/generate', () => button(modal, '生成').click());
}

/** 计划行 → 明细抽屉（GET detail 响应，含 items）。用完即关抽屉。 */
export async function openPlanDetail(page: Page, bookName: string, periodLabel?: string) {
  await page.goto('/metering/plans');
  const planRow = planRowOf(page, bookName, periodLabel);
  await expect(planRow).toBeVisible();
  const detail = await response(
    page, /\/reading-plans\/[0-9a-f-]+$/, () => button(planRow, '明细').click(), 'GET');
  await page.locator('.ant-drawer-open .ant-drawer-close').click();
  await expect(page.locator('.ant-drawer-open')).toHaveCount(0);
  return detail;
}

/** 若计划仍 OPEN 则点开始。 */
export async function startPlan(page: Page, bookName: string, planId: string, periodLabel?: string) {
  await page.goto('/metering/plans');
  const planRow = planRowOf(page, bookName, periodLabel);
  await expect(planRow).toBeVisible();
  const startBtn = button(planRow, '开始');
  if (await startBtn.isVisible().catch(() => false)) {
    await response(page, `/reading-plans/${planId}/start`, () => startBtn.click());
  }
}

export interface EntrySpec {
  accountNo: string;
  resultType?: 'ACTUAL' | 'NO_READ';
  value?: string;
  exceptionCode?: string; // label e.g. '锁闭无法入户'
  estimateQty?: string;
}

/** 计划明细抽屉 → 批量录入：ACTUAL 填表码，NO_READ 选原因(+估水)。 */
export async function batchEnter(page: Page, planId: string, bookName: string, entries: EntrySpec[], periodLabel?: string) {
  await page.goto('/metering/plans');
  const planRow = planRowOf(page, bookName, periodLabel);
  await button(planRow, '明细').click();
  const drawer = page.locator('.ant-drawer-open');
  await expect(drawer.getByText('计划明细').first()).toBeVisible();
  await drawer.getByRole('button', { name: /批量录入/ }).click();
  const modal = page.getByRole('dialog', { name: /批量抄表录入/ });
  for (const e of entries) {
    const rowEl = modal.getByRole('row').filter({ hasText: e.accountNo });
    await expect(rowEl).toBeVisible();
    if (e.resultType === 'NO_READ') {
      await choose(page, rowEl.locator('.ant-select').first(), '未抄见');
      await choose(page, rowEl.getByText('未抄见原因', { exact: true }), e.exceptionCode!);
      if (e.estimateQty) await rowEl.getByPlaceholder('估水 m³（可空）').fill(e.estimateQty);
    } else {
      await rowEl.getByPlaceholder('表码读数（留空跳过该行）').fill(e.value!);
    }
  }
  const res = await response(page, '/meter-readings', () =>
    modal.getByRole('button', { name: /提\s*交（/ }).click());
  await expect(page.getByText(/已批量录入 \d+ 条抄表记录/).first()).toBeVisible();
  await page.locator('.ant-drawer-open .ant-drawer-close').click();
  await expect(page.locator('.ant-drawer-open')).toHaveCount(0);
  return res;
}

/** 单条录入（计划明细行 → 录入）。 */
export async function enterSingle(page: Page, planId: string, bookName: string, accountNo: string, value: string, periodLabel?: string) {
  await page.goto('/metering/plans');
  const planRow = planRowOf(page, bookName, periodLabel);
  await button(planRow, '明细').click();
  const drawer = page.locator('.ant-drawer-open');
  const itemRow = drawer.getByRole('row').filter({ hasText: accountNo });
  await button(itemRow, '录入').click();
  const modal = page.getByRole('dialog', { name: /抄表录入/ });
  await modal.getByLabel('表码读数').fill(value);
  const res = await response(page, '/meter-readings', () =>
    button(modal, '提交').click());
  await expect(page.getByText('抄表记录已录入').first()).toBeVisible();
  await page.locator('.ant-drawer-open .ant-drawer-close').click();
  await expect(page.locator('.ant-drawer-open')).toHaveCount(0);
  return res;
}

/** 抄表记录页按户号搜索 → QC 动作。返回 qc 响应。 */
export async function qcReading(page: Page, accountNo: string, action: '通过' | '驳回' | '复核') {
  await page.goto('/metering/readings');
  const search = page.getByPlaceholder('搜索户号、客户或地址');
  await search.fill(accountNo);
  await search.press('Enter');
  // multiple periods may match — pick the row that actually offers the action
  const r = page.getByRole('row').filter({ hasText: accountNo })
    .filter({ has: page.getByRole('button', { name: action }) }).first();
  await expect(r).toBeVisible();
  return response(page, /\/meter-readings\/[0-9a-f-]+\/qc/, () =>
    r.getByRole('button', { name: action }).click());
}
