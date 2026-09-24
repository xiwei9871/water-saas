import { expect, type Page, type Locator } from '@playwright/test';
export { button, date, main, row } from '../../uat/helpers/ui';
import { button, date, main } from '../../uat/helpers/ui';
export { ready } from '../../uat/helpers/auth';
import { ready } from '../../uat/helpers/auth';

/** Like uat helpers' response() but accepts string path or RegExp. */
export async function response(page: Page, path: string | RegExp, action: () => Promise<unknown>, method = 'POST') {
  const match = typeof path === 'string'
    ? (r: import('@playwright/test').Response) => new URL(r.url()).pathname === '/api' + path
    : (r: import('@playwright/test').Response) => path.test(new URL(r.url()).pathname);
  const result = page.waitForResponse((r) => match(r) && r.request().method() === method);
  await action();
  const res = await result;
  expect(res.ok(), `${method} ${path}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return res.json();
}

export const TENANT = 'sf-water';
export const STAFF_PASSWORD = 'Sf123456';

export async function login(page: Page, account = 'admin', password = STAFF_PASSWORD) {
  await page.goto('/login');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByLabel('租户代码').fill(TENANT);
  await page.getByLabel('账号', { exact: true }).fill(account);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: /登\s*录/ }).click();
  await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible();
}

/** antd Select: click the wrapping .ant-select, optionally search, pick the
 *  exact visible option text (or a RegExp matched against it). */
export async function choose(page: Page, control: Locator, label: string | RegExp, search?: string) {
  const container = control.locator('xpath=ancestor-or-self::*[contains(concat(" ", normalize-space(@class), " "), " ant-select ")][1]');
  const dropdown = page.locator('.ant-select-dropdown:visible');
  await container.click();
  // a leftover dropdown animating closed can swallow the first click
  if (!(await dropdown.isVisible().catch(() => false))) {
    await page.waitForTimeout(300);
    await container.click();
  }
  await expect(dropdown).toBeVisible();
  if (search) await container.getByRole('combobox').fill(search);
  const option =
    typeof label === 'string'
      ? dropdown.getByText(label, { exact: true })
      : dropdown.getByText(label);
  await expect(option).toBeVisible();
  // dispatch the DOM click directly: a real click scrolls the option into
  // view first, and antd closes the dropdown on that scroll — the element
  // detaches mid-action inside modals. dispatchEvent never scrolls.
  await option.dispatchEvent('click');
  await expect(dropdown).toBeHidden();
}

/** Locate an antd Form.Item by its visible label text (labels aren't wired
 *  into the a11y tree for Select/TreeSelect/DatePicker). */
export function formItem(scope: Locator, label: string) {
  return scope.locator('.ant-form-item').filter({
    has: scope.page().locator(`.ant-form-item-label label:text-is("${label}")`),
  }).first();
}

/** antd Select inside a labelled Form.Item — search + pick exact option. */
export async function selectByLabel(page: Page, scope: Locator, label: string, option: string, search?: string) {
  await choose(page, formItem(scope, label).locator('.ant-select'), option, search);
}

/** Input/TextArea/DatePicker inside a labelled Form.Item. */
export function inputByLabel(scope: Locator, label: string) {
  return formItem(scope, label).locator('input, textarea').first();
}

export const month = (p: string) => `${p.slice(0, 4)}-${p.slice(4)}`;
export const personLabel = (p: any) => `${p.customer.name}（${p.customer.customerNo}）`;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** RC1-4/6/7 选项格式为 `户号 · 地址 · 表 表号 · 中文类别` —— 表号/类别在
 *  fixture 外无法预知，按 户号+地址 前缀匹配即可（户号唯一）。 */
export const accountLabel = (p: any) =>
  new RegExp(`^${esc(p.waterAccount.accountNo)} · ${esc(p.waterAccount.addr)}`);

/** cashier/settlement pickers: customer select then water-account select. */
export async function selectPerson(page: Page, scope: Locator, p: any, customerPlaceholder = '搜索客户名称', accountPlaceholder = '选择用水户') {
  await choose(page, scope.getByText(customerPlaceholder, { exact: true }), personLabel(p), p.customer.name);
  await choose(page, scope.getByText(accountPlaceholder, { exact: true }), accountLabel(p));
}
