import { expect, type Page, type Locator, type TestInfo } from '@playwright/test';
export const main = (page: Page) => page.getByRole('main');
export const row = (page: Page, name: string) => page.getByRole('row').filter({ hasText: name });
export async function select(page: Page, control: Locator, text: string) {
  // The visible Select container handles clicks whether the input or selected label overlays it.
  const container = control.locator('xpath=ancestor-or-self::*[contains(concat(" ", normalize-space(@class), " "), " ant-select ")][1]');
  await container.click();
  // Long option lists virtualize — narrow via the search input when editable. Remote
  // search only matches the leading token (name / 户号), not the decorated label.
  const input = container.locator('input');
  if (await input.isEditable().catch(() => false)) {
    await input.fill(text.split(/（| · /)[0]);
    await page.waitForLoadState('networkidle').catch(() => {});
  }
  // Ant Select virtual options expose matching visible title text; scoped dropdown avoids hidden options.
  await page.locator('.ant-select-dropdown:visible').getByText(text, { exact: true }).click();
}
export async function date(control: Locator, value: string) {
  await control.fill(value);
  await control.press('Enter');
  await control.press('Tab');
}
export async function response(page: Page, path: string, action: () => Promise<unknown>, method = 'POST') {
  const result = page.waitForResponse(r => new URL(r.url()).pathname === '/api' + path && r.request().method() === method);
  await action();
  const res = await result;
  expect(res.ok(), `${method} ${path}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return res.json();
}
export async function evidence(page: Page, info: TestInfo, name: string, data?: unknown) {
  await info.attach(name + '-ui', { body: await main(page).innerText(), contentType: 'text/plain' });
  await info.attach(name + '-screenshot', { body: await page.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png' });
  if (data) await info.attach(name + '-response', { body: JSON.stringify(data, null, 2), contentType: 'application/json' });
}
export async function dimensions(page: Page) {
  return page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth }));
}

export const button = (scope: Page | Locator, text: string) => scope.getByRole('button', { name: new RegExp(text.split('').join('\\s*') + '$') });
