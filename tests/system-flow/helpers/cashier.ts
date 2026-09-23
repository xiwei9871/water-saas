import { expect, type Page } from '@playwright/test';
import { button, response, choose, personLabel, accountLabel } from './ui';

/** Select customer+account on 收费台 and wait for the outstanding panel.
 *  Uses the .cashier-picker spans (placeholders disappear once a value is
 *  selected, so placeholder-text lookup only works on first use). */
export async function loadAccount(page: Page, p: any) {
  const pickers = page.locator('.cashier-picker');
  await choose(page, pickers.nth(0).locator('.ant-select'), personLabel(p), p.customer.name);
  await choose(page, pickers.nth(1).locator('.ant-select'), accountLabel(p));
  await expect(page.getByText('合计欠费（净额）')).toBeVisible();
}

/** Outstanding row's 本次分摊 input by bill period label, e.g. '2026-07'. */
export function allocInput(page: Page, periodLabel: string, index = 0) {
  return page.getByRole('row').filter({ hasText: periodLabel }).nth(index)
    .locator('input');
}

/** Click the dynamic 收款 button and capture POST /payments. */
export async function submitPay(page: Page) {
  return response(page, '/payments', () =>
    page.getByRole('button', { name: /收款\s*¥/ }).click());
}

/** TOP_UP via the 预存充值 modal; returns POST /prepayments/top-ups body. */
export async function topUp(page: Page, yuan: string, channelLabel = '现金') {
  await button(page, '预存充值').click();
  const modal = page.getByRole('dialog', { name: '预存充值' });
  await modal.locator('input').first().fill(yuan);
  const res = await response(page, '/prepayments/top-ups', () =>
    button(modal, '确认收款').click());
  await expect(modal).toBeHidden();
  return res;
}
