import { request, expect } from '@playwright/test';
import { TENANT, STAFF_PASSWORD } from './ui';

const BASE = process.env.SF_API ?? 'http://localhost:3000';

/**
 * Read/fixture API client — for external-provider inputs (remote ingest)
 * and read-only checks only. Never used to replace a UI operator action.
 */
export async function apiAs(login: string, password = STAFF_PASSWORD) {
  const ctx = await request.newContext({ baseURL: BASE });
  const res = await ctx.post('/auth/login', {
    data: { tenantCode: TENANT, login, password },
  });
  expect(res.ok(), `login ${login}: ${res.status()}`).toBeTruthy();
  const { accessToken } = await res.json();
  const call = async (method: string, path: string, data?: unknown) => {
    const r = await ctx.fetch(path, {
      method,
      data,
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return { status: r.status(), body: await r.json().catch(() => null) };
  };
  return {
    get: (p: string) => call('GET', p),
    post: (p: string, d?: unknown) => call('POST', p, d),
    dispose: () => ctx.dispose(),
  };
}
