/**
 * E5 Remote Reading V1 UAT — water_uat_e5 (real UI + real API, no mocks).
 * Serial suite; heavy non-UI setup (account onboard, bindings, plans,
 * manual readings) goes through the API with the admin token.
 *
 * Slices:
 *  1. 菜单/路由：抄表管理下出现远传三页
 *  2. 数据源 UI 新建（FILE_IMPORT + 列映射 config）
 *  3. 设备 UI 登记 + 绑定抽屉展示（绑定经 API 建）
 *  4. 文件导入 UI：CSV 部分成功 → 事件页 CONVERTED
 *  5. UNBOUND → 补绑定 → UI 重放 → CONVERTED
 *  6. 人工读数 QC PASSED + 远传 → CONFLICT → UI 裁决 USE_REMOTE
 *  7. 抄表记录页展示 REMOTE 读数
 *  8. 权限：reader 可见页面但无写操作按钮
 *  9. 跨租户：xh-water 看不到 cd-water 的远传数据
 */
import { test, expect } from '../uat/helpers/console';
import { login, ready } from '../uat/helpers/auth';
import { db, roleFixtures } from '../uat/helpers/fixture';
import { button, evidence, main, response, row } from '../uat/helpers/ui';
import type { Page } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test.describe.configure({ mode: 'serial' });

const stamp = Date.now().toString(36);
const S: Record<string, any> = { stamp };
let token = '';

const SRC_CODE = `NB-${stamp}`;
const DEVKEY = `IMEI-${stamp}`;
const PERIOD_IMPORT = '202709';
const PERIOD_REPLAY = '202710';
const PERIOD_CONFLICT = '202711';

async function api(
  page: Page,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
  bearer = token,
) {
  const res = await page.request.fetch(`/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${bearer}` },
    ...(body === undefined ? {} : { data: body }),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status(), body: json };
}

async function apiOk(page: Page, method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) {
  const r = await api(page, method, path, body);
  expect(r.status, `${method} ${path}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
  return r.body;
}

/** book + member + generated plan containing the account. */
async function mkPlan(page: Page, period: string, waterAccountId: string) {
  if (!S.orgId) {
    const orgs = await apiOk(page, 'GET', '/iam/orgs');
    S.orgId = (orgs as any[]).find((o) => o.type === 'COMPANY')?.id ?? orgs[0]?.id;
  }
  const book = await apiOk(page, 'POST', '/reading-books', {
    name: `E5册-${period}-${stamp}`,
    orgUnitId: S.orgId,
  });
  await apiOk(page, 'POST', `/reading-books/${book.id}/meters`, { waterAccountId });
  const plan = await apiOk(page, 'POST', '/reading-plans/generate', {
    bookId: book.id,
    period,
    planDate: `${period.slice(0, 4)}-${period.slice(4)}-05`,
  });
  return plan;
}

const itemFor = (plan: any, waterAccountId: string) =>
  plan.items.find((i: any) => i.waterAccountId === waterAccountId).id as string;

/** Idempotent POSTs (Idempotency-Key header) return {replayed,status,body} — unwrap. */
const unwrap = (r: any) => (r && typeof r === 'object' && 'replayed' in r ? r.body : r);

test('S1 菜单与数据源 UI 新建', async ({ page }, info) => {
  await login(page);
  token = await page.evaluate(() => localStorage.getItem('water-saas.accessToken')!);

  // 抄表管理子菜单包含三个远传页。
  await page.getByRole('menuitem', { name: '抄表管理' }).click();
  for (const label of ['远传数据源', '远传设备', '远传事件']) {
    await expect(page.getByRole('menuitem', { name: label })).toBeVisible();
  }

  // 数据源页 → 新建数据源。
  await page.goto('/metering/remote-sources');
  await ready(page);
  await expect(main(page)).toContainText('远传数据源');
  await button(main(page), '新建数据源').click();

  const modal = page.locator('.ant-modal:visible');
  await modal.getByLabel('编码').fill(SRC_CODE);
  await modal.getByLabel('名称').fill(`E5UAT 远传平台 ${stamp}`);
  await modal.getByLabel('时区（IANA）').fill('Asia/Shanghai');
  await modal
    .locator('.ant-form-item')
    .filter({ hasText: '文件列映射' })
    .locator('textarea')
    .fill(
      JSON.stringify({
        deviceKeyColumn: 'device_key',
        readingColumn: 'reading',
        collectedAtColumn: 'collected_at',
        eventIdColumn: 'event_id',
      }),
    );
  S.source = unwrap(
    await response(page, '/remote-sources', () => button(modal, '确 定').click()),
  );
  await expect(main(page).getByRole('row').filter({ hasText: SRC_CODE })).toBeVisible();
  await evidence(page, info, 's1-source-created', S.source);
});

test('S2 设备登记 + 绑定展示', async ({ page }, info) => {
  await login(page);
  token = await page.evaluate(() => localStorage.getItem('water-saas.accessToken')!);

  // 立户（API 重活）→ 设备走 UI → 绑定走 API → UI 抽屉核对。
  S.acct = await apiOk(page, 'POST', '/water-accounts/onboard', {
    customer: { name: `E5UAT客户-${stamp}`, custType: 'PERSONAL' },
    account: { usageCategory: 'RES_METERED', addr: `E5远传路-${stamp}` },
    meter: { brand: 'e5-brand', caliber: 'DN15' },
    installation: { initialReading: 0 },
  });
  S.installation = S.acct.installation;

  await page.goto(`/metering/remote-devices?sourceId=${S.source.id}`);
  await ready(page);
  await button(main(page), '登记设备').click();
  const modal = page.locator('.ant-modal:visible');
  await modal.getByLabel('厂商设备 Key').fill(DEVKEY);
  await modal.getByLabel('厂商表号（可选）').fill(`VN-${stamp}`);
  S.device = unwrap(
    await response(page, '/remote-devices', () => button(modal, '确 定').click()),
  );
  await expect(main(page).getByRole('row').filter({ hasText: DEVKEY })).toBeVisible();

  // 绑定走 API（DatePicker 区间交给接口层，UI 负责展示）。
  S.binding = unwrap(
    await apiOk(page, 'POST', `/remote-devices/${S.device.id}/bindings`, {
      installationId: S.installation.id,
      effectiveFrom: S.installation.installedAt,
    }),
  );

  // 设备抽屉 → 绑定历史一行（当前 + 表号）。
  await row(main(page), DEVKEY).getByRole('button', { name: /绑\s*定/ }).first().click();
  const drawer = page.locator('.ant-drawer:visible');
  await expect(drawer).toContainText('绑定历史');
  await expect(drawer).toContainText(S.acct.meter.meterNo);
  await expect(drawer.getByText('当前', { exact: true })).toBeVisible();
  await evidence(page, info, 's2-binding', S.binding);
});

test('S3 文件导入 UI → 事件 CONVERTED', async ({ page }, info) => {
  await login(page);
  token = await page.evaluate(() => localStorage.getItem('water-saas.accessToken')!);

  // 计划项先行 —— 事件落地即转抄表。
  await mkPlan(page, PERIOD_IMPORT, S.acct.waterAccount.id);

  // CSV：1 行好数据 + 1 行坏读数 → 部分成功。
  const dir = mkdtempSync(join(tmpdir(), 'e5uat-'));
  const csv = join(dir, 'vendor.csv');
  writeFileSync(
    csv,
    [
      'event_id,device_key,reading,collected_at',
      `EVT-OK-${stamp},${DEVKEY},123.5,${PERIOD_IMPORT.slice(0, 4)}-${PERIOD_IMPORT.slice(4)}-05 08:30`,
      `EVT-BAD-${stamp},${DEVKEY},not-a-number,${PERIOD_IMPORT.slice(0, 4)}-${PERIOD_IMPORT.slice(4)}-05 08:31`,
    ].join('\n'),
  );

  await page.goto('/metering/remote-sources');
  await ready(page);
  await row(main(page), SRC_CODE).getByRole('button', { name: /导\s*入/ }).click();
  const modal = page.locator('.ant-modal:visible');
  await modal.getByLabel('目标账期（YYYYMM）').fill(PERIOD_IMPORT);
  await modal.locator('input[type="file"]').setInputFiles(csv);
  S.importReport = await response(page, `/remote-sources/${S.source.id}/import`, () =>
    button(modal, '开始导入').click(),
  );
  expect(S.importReport.totalRows).toBe(2);
  expect(S.importReport.parsed).toBe(1);
  expect(S.importReport.invalid).toHaveLength(1);
  expect(S.importReport.counts.CONVERTED).toBe(1);
  await evidence(page, info, 's3-import', S.importReport);

  // 事件页 → CONVERTED 行可见。
  await page.goto(`/metering/remote-events?sourceId=${S.source.id}`);
  await ready(page);
  const okRow = main(page).getByRole('row').filter({ hasText: `EVT-OK-${stamp}` });
  await expect(okRow).toBeVisible();
  await expect(okRow).toContainText('已转抄表');
  S.convertedEventId = S.importReport.outcomes.find((o: any) => o.outcome === 'CONVERTED').eventId;
});

test('S4 UNBOUND → 补绑定 → UI 重放 → CONVERTED', async ({ page }, info) => {
  await login(page);
  token = await page.evaluate(() => localStorage.getItem('water-saas.accessToken')!);

  // 幽灵设备走独立立户 —— 同一安装位置同时段只允许一个远传绑定。
  const acct2 = await apiOk(page, 'POST', '/water-accounts/onboard', {
    customer: { name: `E5UAT客户2-${stamp}`, custType: 'PERSONAL' },
    account: { usageCategory: 'RES_METERED', addr: `E5远传二路-${stamp}` },
    meter: { brand: 'e5-brand', caliber: 'DN15' },
    installation: { initialReading: 0 },
  });
  S.acct2 = acct2;
  await mkPlan(page, PERIOD_REPLAY, acct2.waterAccount.id);
  const ghost = `GHOST-${stamp}`;
  const ing = await apiOk(page, 'POST', `/remote-sources/${S.source.id}/events`, {
    externalEventKey: `EVT-GHOST-${stamp}`,
    vendorDeviceKey: ghost,
    businessPeriod: PERIOD_REPLAY,
    collectedAt: `${PERIOD_REPLAY.slice(0, 4)}-${PERIOD_REPLAY.slice(4)}-05T08:30:00Z`,
    readingValue: '200',
  });
  expect(ing[0].outcome).toBe('UNBOUND');
  const eventId = ing[0].eventId;

  // 补登记 + 绑定（API）。
  const dev = await apiOk(page, 'POST', '/remote-devices', {
    remoteSourceId: S.source.id,
    vendorDeviceKey: ghost,
  });
  await apiOk(page, 'POST', `/remote-devices/${dev.id}/bindings`, {
    installationId: acct2.installation.id,
    effectiveFrom: acct2.installation.installedAt,
  });

  // UI：事件页未绑定行 → 重放 → 已转抄表。
  await page.goto(`/metering/remote-events?sourceId=${S.source.id}`);
  await ready(page);
  const rowEl = main(page).getByRole('row').filter({ hasText: `EVT-GHOST-${stamp}` });
  await expect(rowEl).toContainText('未绑定');
  await rowEl.getByRole('button', { name: /重\s*放/ }).click();
  await expect(rowEl).toContainText('已转抄表');
  await evidence(page, info, 's4-replay', { eventId });
});

test('S5 CONFLICT → UI 裁决 USE_REMOTE', async ({ page }, info) => {
  await login(page);
  token = await page.evaluate(() => localStorage.getItem('water-saas.accessToken')!);

  // 人工实际读数 QC PASSED 占位 → 远传同账期 → CONFLICT。
  const plan = await mkPlan(page, PERIOD_CONFLICT, S.acct.waterAccount.id);
  const item = itemFor(plan, S.acct.waterAccount.id);
  const manual = await apiOk(page, 'POST', '/meter-readings', {
    planItemId: item,
    resultType: 'ACTUAL',
    readingValue: 300,
  });
  await apiOk(page, 'POST', `/meter-readings/${manual.id}/qc`, { action: 'pass' });

  const ing = await apiOk(page, 'POST', `/remote-sources/${S.source.id}/events`, {
    externalEventKey: `EVT-CFT-${stamp}`,
    vendorDeviceKey: DEVKEY,
    businessPeriod: PERIOD_CONFLICT,
    collectedAt: `${PERIOD_CONFLICT.slice(0, 4)}-${PERIOD_CONFLICT.slice(4)}-05T08:30:00Z`,
    readingValue: '305',
  });
  expect(ing[0].outcome).toBe('CONFLICT');
  const eventId = ing[0].eventId;

  // UI：详情抽屉 → 裁决冲突 → 采用远传。
  await page.goto(`/metering/remote-events?sourceId=${S.source.id}`);
  await ready(page);
  await main(page)
    .getByRole('row')
    .filter({ hasText: `EVT-CFT-${stamp}` })
    .getByRole('button', { name: /详\s*情/ })
    .click();
  const drawer = page.locator('.ant-drawer:visible');
  await expect(drawer).toContainText('处理日志');
  await button(drawer, '裁决冲突').click();
  const modal = page.locator('.ant-modal:visible');
  await modal.locator('textarea').fill('UAT：远传可信');
  S.resolved = await response(page, `/remote-events/${eventId}/resolve-conflict`, () =>
    button(modal, '确认裁决').click(),
  );
  expect(S.resolved.status).toBe('CONVERTED');
  await expect(drawer).toContainText('已转抄表');
  await evidence(page, info, 's5-conflict', S.resolved);
});

test('S6 抄表记录页展示 REMOTE 读数', async ({ page }, info) => {
  await login(page);
  await page.goto('/metering/readings');
  await ready(page);
  // 远传产生的 REMOTE 行可见（读数 123.5 / 305 等）。
  const remoteRow = main(page).getByRole('row').filter({ hasText: '305' });
  await expect(remoteRow).toBeVisible();
  await expect(remoteRow).toContainText('远传');
  await evidence(page, info, 's6-readings');
});

test('S7 reader 只读：页面可见、写按钮隐藏', async ({ page }) => {
  await roleFixtures();
  await login(page, 'uat-reader', 'uat12345');
  await page.goto('/metering/remote-sources');
  await ready(page);
  await expect(main(page)).toContainText('远传数据源');
  await expect(main(page).getByRole('row').filter({ hasText: SRC_CODE })).toBeVisible();
  await expect(button(main(page), '新建数据源')).toHaveCount(0);
  await expect(main(page).getByRole('button', { name: /导\s*入/ })).toHaveCount(0);

  await page.goto(`/metering/remote-events?sourceId=${S.source.id}`);
  await ready(page);
  await expect(main(page).getByRole('button', { name: /重\s*放/ })).toHaveCount(0);
});

test('S8 跨租户隔离：xh-water 不可见 cd-water 远传数据', async ({ page }) => {
  // xh-water 的 admin 登录（独立租户态）。
  const xh = await page.request.fetch('/api/auth/login', {
    method: 'POST',
    data: { tenantCode: 'xh-water', login: 'admin', password: 'admin123' },
  });
  expect(xh.ok()).toBeTruthy();
  const xhToken = (await xh.json()).accessToken as string;

  const sources = await api(page, 'GET', '/remote-sources', undefined, xhToken);
  expect(sources.status).toBe(200);
  expect((sources.body as any[]).every((s) => s.code !== SRC_CODE)).toBe(true);

  const events = await api(page, 'GET', '/remote-events', undefined, xhToken);
  expect(events.status).toBe(200);
  expect(events.body).toHaveLength(0);

  // 直取 cd-water 的事件 id → 404（RLS 下不可见）。
  const detail = await api(page, 'GET', `/remote-events/${S.convertedEventId}`, undefined, xhToken);
  expect(detail.status).toBe(404);
});
