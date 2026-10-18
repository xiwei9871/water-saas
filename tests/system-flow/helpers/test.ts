import { test as base, expect, type Page, type TestInfo } from '@playwright/test';
import { BrowserAudit } from '../../uat/helpers/console';
import { record } from './state';

/**
 * Auto BrowserAudit: every spec fails on unexpected console.error,
 * pageerror, failed request, proxy bypass or unexpected HTTP status.
 * Declare expected business errors via `audit.allow(path, status)` —
 * no broad suppression.
 */
export const test = base.extend<{ audit: BrowserAudit }>({
  audit: [async ({ page, browser }, use, info) => {
    const audit = new BrowserAudit(page);
    record('environment', { test: info.title, browser: browser.version(), channel: 'chrome', date: new Date().toISOString() });
    await use(audit);
    await Promise.allSettled(audit.pending);
    await info.attach('browser-network', { body: JSON.stringify(audit.events, null, 2), contentType: 'application/json' });
    record('network', { test: info.title, events: audit.events, unexpected: audit.unexpected() });
    expect.soft(audit.unexpected(), 'Unexpected browser/network events').toEqual([]);
  }, { auto: true }],
});
export { expect };

/** Journey evidence: screenshot + visible UI + optional API payload. */
export async function evidence(page: Page, info: TestInfo, name: string, data?: unknown) {
  await info.attach(name + '-ui', { body: await page.locator('body').innerText(), contentType: 'text/plain' });
  await info.attach(name + '-screenshot', { body: await page.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png' });
  if (data) await info.attach(name + '-response', { body: JSON.stringify(data, null, 2), contentType: 'application/json' });
}
