import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const ADMIN = {
  tenantCode: process.env.UAT_TENANT ?? 'cd-water',
  login: process.env.UAT_LOGIN ?? 'admin',
  password: process.env.UAT_PASSWORD ?? 'admin123',
};

export async function loginUi(page: Page) {
  await page.goto('/login');
  await page.getByLabel('租户代码').fill(ADMIN.tenantCode);
  await page.getByLabel('账号').fill(ADMIN.login);
  await page.getByLabel('密码').fill(ADMIN.password);
  await page.getByRole('button', { name: '登 录' }).click();
  await expect(page.getByText('供水营收管理系统')).toBeVisible();
}

export async function loginApi(request: APIRequestContext) {
  const res = await request.post('/api/auth/login', { data: ADMIN });
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = await res.json();
  return { Authorization: `Bearer ${body.accessToken}` };
}

export async function apiJson<T>(
  request: APIRequestContext,
  method: 'get' | 'post' | 'patch',
  path: string,
  headers: Record<string, string>,
  data?: unknown,
): Promise<T> {
  const res = await request.fetch('/api' + path, {
    method: method.toUpperCase(),
    headers,
    data,
  });
  const text = await res.text();
  expect(res.ok(), `${method.toUpperCase()} ${path} -> ${res.status()} ${text}`).toBeTruthy();
  return text ? JSON.parse(text) : (undefined as T);
}

export function collectRuntimeErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  return errors;
}
