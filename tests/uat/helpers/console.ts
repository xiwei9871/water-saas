import { test as base, expect, type Page } from '@playwright/test';
type Rule = { path: string; method: string; status: number };
type Event = { kind: string; [key: string]: unknown };
export class BrowserAudit {
  events: Event[] = [];
  expected: Rule[] = [];
  pending: Promise<void>[] = [];
  constructor(page: Page) {
    page.on('console', m => {
      if (m.type() === 'error') this.events.push({ kind: 'CONSOLE_ERROR', text: m.text(), url: m.location().url });
    });
    page.on('pageerror', e => this.events.push({ kind: 'PAGE_ERROR', text: e.message }));
    page.on('requestfailed', r => this.events.push({ kind: 'FAILED_REQUEST', url: r.url(), error: r.failure()?.errorText }));
    page.on('request', r => {
      if (r.resourceType() === 'fetch' || r.resourceType() === 'xhr') {
        const u = new URL(r.url());
        if (u.origin !== 'http://127.0.0.1:4173' || !u.pathname.startsWith('/api/'))
          this.events.push({ kind: 'PROXY_BYPASS', url: r.url() });
      }
    });
    page.on('response', r => {
      if (!r.url().includes('/api/')) return;
      const task = (async () => {
        const path = new URL(r.url()).pathname;
        const method = r.request().method();
        const expected = this.expected.some(x => path === x.path && method === x.method && r.status() === x.status);
        const event: Event = { kind: r.status() < 400 ? 'HTTP_OK' : expected ? 'EXPECTED_HTTP_ERROR' : 'UNEXPECTED_HTTP_ERROR', url: r.url(), method, status: r.status() };
        // Never persist login credentials, tokens or auth responses in our JSON evidence.
        if (!path.startsWith('/api/auth/') && (r.status() >= 400 || method !== 'GET')) {
          try { event.response = await r.json(); } catch { /* body unavailable after navigation */ }
        }
        this.events.push(event);
      })();
      this.pending.push(task);
    });
  }
  allow(path: string, status: number, method = 'POST') { this.expected.push({ path, status, method }); }
  unexpected() {
    return this.events.filter(e => {
      if (e.kind === 'CONSOLE_ERROR' && /Failed to load resource.*(?:400|401|403|409)/.test(String(e.text))) {
        return !this.events.some(h => h.kind === 'EXPECTED_HTTP_ERROR' && h.url === e.url && String(e.text).includes(String(h.status)));
      }
      return ['CONSOLE_ERROR', 'PAGE_ERROR', 'FAILED_REQUEST', 'PROXY_BYPASS', 'UNEXPECTED_HTTP_ERROR'].includes(e.kind);
    });
  }
}
export const test = base.extend<{ audit: BrowserAudit }>({
  audit: [async ({ page }, use, info) => {
    const audit = new BrowserAudit(page);
    await use(audit);
    await Promise.allSettled(audit.pending);
    await info.attach('browser-network', { body: JSON.stringify(audit.events, null, 2), contentType: 'application/json' });
    await info.attach('attempt', { body: JSON.stringify({ retry: info.retry, status: info.status, title: info.title, browser: page.context().browser()?.version() }), contentType: 'application/json' });
    if (!page.isClosed()) await info.attach('visible-ui', { body: await page.locator('body').innerText(), contentType: 'text/plain' });
    expect.soft(audit.unexpected(), 'Unexpected console/page/network error; see browser-network attachment').toEqual([]);
  }, { auto: true }],
});
export { expect };
