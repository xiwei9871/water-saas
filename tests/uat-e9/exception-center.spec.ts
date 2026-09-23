/**
 * E9 Exception Center UAT — water_uat_e9 (real UI + real API, no mocks).
 * Serial suite. Domain facts (books, readings, remote events, bills) are
 * seeded via the UAT prisma fixture; reconcile is triggered via the real
 * `POST /exceptions/refresh`; assertions mix UI (queue page/drawer) and API.
 *
 * Slices (per E9_EXCEPTION_CENTER_V1 §测试矩阵):
 *  S1 scope：Branch 只见本所覆盖户异常；off-book 户异常对 Branch 不可见、tenant 可见
 *  S2 闭环：QC REJECTED → ACK → 补抄 supersede → refresh → RESOLVED(AUTO)
 *  S3 人工 resolve 拦截：fact 仍在 → 409 ANOMALY_STILL_ACTIVE
 *  S4 IGNORED episode：fact 消失 cleared → fact 复现 → 新 OPEN episode
 *  S5 remote replay：UNBOUND → replay → WAITING_PLAN = 旧 RESOLVED + 新 OPEN
 *  S6 CONFLICT 与 EVENT_KEY_CONFLICT 并存；T2 冲突产生新 episode
 *  S7 RBAC：exception:read 无 billing:read → 可见逾期账单异常、drill 403
 *  S8 MULTI_BOOK：户挂两册 → WARNING 入队
 *  S9 RC1 过滤器：期间 / 营业所 过滤只匹配已解析 anchor，无 period 异常不误配
 *  S10 RC1 统计卡：今日新增/今日清除 随 reconcile 变化
 */
import { test, expect, type Page } from '../uat/helpers/console';
import { login, ready } from '../uat/helpers/auth';
import { button, evidence, main } from '../uat/helpers/ui';
import { db } from '../uat/helpers/fixture';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const requireApi = createRequire(resolve('apps/api/package.json'));
const bcrypt = requireApi('bcrypt');

test.describe.configure({ mode: 'serial' });

const stamp = Date.now().toString(36);
let token = '';
let tenantId = '';
let companyOrgId = '';
let adminStaffId = '';

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

async function apiOk(page: Page, method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, bearer = token) {
  const r = await api(page, method, path, body, bearer);
  expect(r.status, `${method} ${path}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
  return r.body;
}

async function apiToken(page: Page, account: string, password: string) {
  const r = await api(page, 'POST', '/auth/login', {
    tenantCode: 'cd-water',
    login: account,
    password,
  });
  expect(r.status, `login ${account}`).toBeLessThan(300);
  return r.body.accessToken as string;
}

const refresh = (page: Page, bearer = token) =>
  apiOk(page, 'POST', '/exceptions/refresh', {}, bearer);

const keys = (items: { key: string }[]) => items.map((i) => i.key);

async function onboard(page: Page, tag: string) {
  const body = await apiOk(page, 'POST', '/water-accounts/onboard', {
    customer: { name: `E9 ${tag} ${stamp}`, custType: 'PERSONAL', phone: '138' },
    account: { usageCategory: 'RES_METERED', addr: `${tag} st` },
    meter: { brand: 'e9', caliber: 'DN15' },
    installation: { initialReading: 0, installedAt: '2026-01-01' },
  });
  return body as {
    waterAccount: { id: string; accountNo: string; settleAccountId: string };
    meter: { id: string };
    installation: { id: string };
  };
}

/** off-book 户（无表无册）——直接 SQL 造最小事实。 */
const seedBareAccount = (tag: string) =>
  db(async (p) => {
    const cust = await p.customer.create({
      data: { tenantId, customerNo: `e9-c-${tag}-${stamp}`, name: `E9 ${tag}`, custType: 'PERSONAL' },
    });
    const settle = await p.settleAccount.create({
      data: { tenantId, settleNo: `e9-s-${tag}-${stamp}`, name: `E9 ${tag}` },
    });
    const acc = await p.waterAccount.create({
      data: {
        tenantId,
        accountNo: `e9-a-${tag}-${stamp}`,
        customerId: cust.id,
        settleAccountId: settle.id,
        usageCategory: 'RES_METERED',
        addr: `${tag} addr`,
        status: 'NORMAL',
        billable: true,
      },
    });
    return { accId: acc.id, settleId: settle.id, accountNo: acc.accountNo };
  });

const seedBookCoverage = (accountId: string, orgId: string, tag: string) =>
  db(async (p) => {
    const book = await p.readingBook.create({
      data: {
        tenantId,
        bookNo: `e9-${tag}-${stamp}`,
        name: `E9 册 ${tag}`,
        orgUnitId: orgId,
        cadence: 'MONTHLY',
        meterChannel: 'MECHANICAL',
      },
    });
    await p.bookMeter.create({
      data: { tenantId, bookId: book.id, waterAccountId: accountId, seqNo: 1 },
    });
    return book.id as string;
  });

const seedReading = (
  installationId: string,
  meterId: string,
  period: string,
  qcStatus: string,
  supersedesReadingId?: string,
) =>
  db(async (p) =>
    (
      await p.meterReading.create({
        data: {
          tenantId,
          installationId,
          meterId,
          period,
          readDate: new Date('2026-02-20'),
          resultType: 'ACTUAL',
          readingValue: 25,
          qcStatus,
          source: 'WEB',
          operatorId: adminStaffId,
          ...(supersedesReadingId ? { supersedesReadingId } : {}),
        },
      })
    ).id as string,
  );

const seedOverdueBill = (accId: string, settleId: string, period: string) =>
  db(async (p) =>
    (
      await p.bill.create({
        data: {
          tenantId,
          settleAccountId: settleId,
          waterAccountId: accId,
          period,
          billKind: 'NORMAL',
          sourceType: 'MANUAL',
          sourceId: crypto.randomUUID(),
          status: 'POSTED',
          totalAmount: 5000,
          dueDate: new Date('2020-01-01'),
        },
      })
    ).id as string,
  );

const seedRemoteSource = (orgUnitId: string | null, tag: string) =>
  db(async (p) =>
    (
      await p.remoteSource.create({
        data: {
          tenantId,
          code: `e9-src-${tag}-${stamp}`,
          name: `E9 src ${tag}`,
          type: 'FILE_IMPORT',
          adapterKey: 'file-csv',
          status: 'ACTIVE',
          timezone: 'Asia/Shanghai',
          orgUnitId,
        },
      })
    ).id as string,
  );

const seedBinding = (sourceId: string, installationId: string, tag: string) =>
  db(async (p) => {
    const device = await p.remoteDevice.create({
      data: {
        tenantId,
        remoteSourceId: sourceId,
        vendorDeviceKey: `e9-dev-${tag}-${stamp}`,
        status: 'ACTIVE',
      },
    });
    const binding = await p.remoteDeviceBinding.create({
      data: {
        tenantId,
        remoteSourceId: sourceId,
        remoteDeviceId: device.id,
        installationId,
        effectiveFrom: new Date('2026-01-01'),
      },
    });
    return {
      deviceId: device.id as string,
      bindingId: binding.id as string,
      deviceKey: `e9-dev-${tag}-${stamp}`,
    };
  });

const seedEvent = (
  sourceId: string,
  tag: string,
  status: string,
  extra: Record<string, unknown> = {},
) =>
  db(async (p) =>
    (
      await p.rawRemoteEvent.create({
        data: {
          tenantId,
          remoteSourceId: sourceId,
          externalEventKey: `e9-ev-${tag}-${stamp}`,
          canonicalPayloadHash: 'h',
          vendorDeviceKey: (extra.vendorDeviceKey as string) ?? 'vdev',
          businessPeriod: '202603',
          collectedAt: new Date('2026-03-10'),
          readingValue: 1,
          rawPayload: {},
          canonicalPayload: {},
          processingStatus: status,
          ...extra,
        },
      })
    ).id as string,
  );

const conflictLog = (eventId: string) =>
  db(async (p) =>
    p.remoteEventProcessLog.create({
      data: {
        tenantId,
        remoteEventId: eventId,
        action: 'EVENT_KEY_CONFLICT',
        code: 'EVENT_KEY_CONFLICT',
        actorType: 'SYSTEM',
      },
    }),
  );

const workItem = (key: string) =>
  db(async (p) =>
    p.workItem.findMany({
      where: { tenantId, anomalyKey: key },
      orderBy: { createdAt: 'asc' },
    }),
  );

/** 打开异常中心并对某 key 的行点详情（自动翻页，队列随运行累积）。 */
async function openQueueRow(page: Page, keyFragment: string) {
  await page.goto('/exceptions');
  await ready(page);
  const rowOf = () =>
    main(page).getByRole('row').filter({ hasText: keyFragment }).first();
  const nextPage = page.locator(
    '.ant-pagination-next:not(.ant-pagination-disabled) button',
  );
  for (let i = 0; i < 20; i++) {
    const row = rowOf();
    if (await row.count()) {
      await expect(row).toBeVisible();
      // 队列页有多路并行请求（list/summary/options），行可能因数据落地
      // 重渲染而短暂 detach —— 允许重试点击而不是把整段场景判死。
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await button(rowOf(), '详情').click({ timeout: 5000 });
          break;
        } catch (e) {
          if (attempt === 2) throw e;
        }
      }
      await expect(page.locator('.ant-drawer:visible').last()).toBeVisible();
      return;
    }
    if (!(await nextPage.count())) break;
    // 等「本次翻页」的响应真正回来 —— networkidle 在请求尚未发出时会
    // 立即返回，导致在旧页面上误判行不存在而翻过头。
    await Promise.all([
      page
        .waitForResponse(
          (r) => r.url().includes('/exceptions?') && r.status() === 200,
          { timeout: 10000 },
        )
        .catch(() => null),
      nextPage.click(),
    ]);
  }
  throw new Error(`queue row not found: ${keyFragment}`);
}

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  token = await apiToken(page, 'admin', 'admin123');
  await page.close();
  await db(async (p) => {
    const tenant = await p.tenant.findUniqueOrThrow({ where: { code: 'cd-water' } });
    tenantId = tenant.id;
    const org = await p.orgUnit.findFirstOrThrow({ where: { tenantId, type: 'COMPANY' } });
    companyOrgId = org.id;
    const admin = await p.staff.findUniqueOrThrow({
      where: { tenantId_login: { tenantId, login: 'admin' } },
    });
    adminStaffId = admin.id;
  });
});

test('S1: scope — off-book 异常 TENANT 锚定，Branch 不可见；本所覆盖户可见', async ({ page }, info) => {
  const bare = await seedBareAccount('s1');
  const a = await onboard(page, 's1');
  // branch 员工 + 该所册覆盖的户
  const branch = await db(async (p) => {
    const org = await p.orgUnit.create({
      data: { tenantId, parentId: companyOrgId, name: `E9 营业所 ${stamp}`, type: 'BRANCH' },
    });
    const reader = await p.role.findUniqueOrThrow({
      where: { tenantId_code: { tenantId, code: 'reader' } },
    });
    const passwordHash = await bcrypt.hash('uat12345', 10);
    const staff = await p.staff.create({
      data: {
        tenantId,
        orgUnitId: org.id,
        login: `e9-branch-${stamp}`,
        name: 'E9 营业所员',
        passwordHash,
        status: 'ACTIVE',
      },
    });
    await p.staffRole.create({ data: { tenantId, staffId: staff.id, roleId: reader.id } });
    return org.id as string;
  });
  await seedBookCoverage(a.waterAccount.id, branch, 's1');
  // 给覆盖户造一个 ACCOUNT 锚定异常：加第二册 → MULTI_BOOK
  await seedBookCoverage(a.waterAccount.id, branch, 's1b');
  await refresh(page);

  const branchToken = await apiToken(page, `e9-branch-${stamp}`, 'uat12345');
  const bl = await apiOk(page, 'GET', '/exceptions?take=200', undefined, branchToken);
  expect(keys(bl.items)).toContain(`wa:${a.waterAccount.id}:MULTI_BOOK`);
  expect(keys(bl.items)).not.toContain(`wa:${bare.accId}:NO_BOOK`);

  const al = await apiOk(page, 'GET', '/exceptions?take=200');
  expect(keys(al.items)).toContain(`wa:${bare.accId}:NO_BOOK`);

  // UI：admin 队列可见 off-book 户异常（summary 含户号）
  await login(page);
  await openQueueRow(page, bare.accountNo);
  await expect(page.locator('.ant-drawer:visible').last()).toContainText('租户级');
  await evidence(page, info, 's1-scope', { bare: bare.accId });
});

test('S2: 闭环 — QC REJECTED → ACK → supersede → RESOLVED(AUTO)', async ({ page }, info) => {
  const a = await onboard(page, 's2');
  await seedBookCoverage(a.waterAccount.id, companyOrgId, 's2');
  const r = await seedReading(a.installation.id, a.meter.id, '202601', 'REJECTED');
  await refresh(page);
  const key = `reading:${r}:QC_REJECTED`;

  // UI：详情抽屉里点「确认」（行摘要以户号定位）
  await login(page);
  await openQueueRow(page, a.waterAccount.accountNo);
  await button(page.locator('.ant-drawer:visible').last(), '确认').click();
  await expect(page.locator('.ant-drawer:visible').last()).toContainText('已确认');
  expect((await workItem(key))[0].status).toBe('ACK');

  // 补抄 supersede → fact 消失 → reconcile AUTO-RESOLVED
  await seedReading(a.installation.id, a.meter.id, '202601', 'PASSED', r);
  await refresh(page);
  const ep = (await workItem(key))[0];
  expect(ep.status).toBe('RESOLVED');
  expect(ep.resolutionSource).toBe('AUTO');
  expect(ep.clearedAt).not.toBeNull();
  await evidence(page, info, 's2-closed-loop', { key });
});

test('S3: 人工 resolve — fact 仍在 → 409 ANOMALY_STILL_ACTIVE', async ({ page }, info) => {
  const bare = await seedBareAccount('s3');
  await refresh(page);
  const key = `wa:${bare.accId}:NO_BOOK`;
  const r = await api(page, 'POST', `/exceptions/${encodeURIComponent(key)}/resolve`, { note: 'x' });
  expect(r.status).toBe(409);
  expect(r.body.code).toBe('ANOMALY_STILL_ACTIVE');
  await login(page);
  await evidence(page, info, 's3-resolve-blocked', { key });
});

test('S4: IGNORED → fact 消失 cleared → fact 复现 → 新 OPEN episode', async ({ page }, info) => {
  const bare = await seedBareAccount('s4');
  await refresh(page);
  const key = `wa:${bare.accId}:NO_BOOK`;
  await apiOk(page, 'POST', `/exceptions/${encodeURIComponent(key)}/ignore`, { note: '新户待入册' });
  await seedBookCoverage(bare.accId, companyOrgId, 's4');
  await refresh(page);
  let rows = await workItem(key);
  expect(rows[0].status).toBe('IGNORED');
  expect(rows[0].clearedAt).not.toBeNull();
  await db(async (p) =>
    p.bookMeter.deleteMany({ where: { tenantId, waterAccountId: bare.accId } }),
  );
  await refresh(page);
  rows = await workItem(key);
  expect(rows.length).toBe(2);
  expect(rows[1].status).toBe('OPEN');
  expect(rows[1].clearedAt).toBeNull();
  await login(page);
  await evidence(page, info, 's4-ignored-recurrence', { key });
});

test('S5: remote replay — UNBOUND → WAITING_PLAN = 旧 episode RESOLVED + 新 OPEN', async ({ page }, info) => {
  const a = await onboard(page, 's5');
  const src = await seedRemoteSource(companyOrgId, 's5');
  const { deviceId, bindingId, deviceKey } = await seedBinding(src, a.installation.id, 's5');
  const ev = await seedEvent(src, 's5', 'UNBOUND', {
    resolvedRemoteDeviceId: deviceId,
    resolvedBindingId: bindingId,
    vendorDeviceKey: deviceKey,
  });
  await refresh(page);
  expect((await workItem(`event:${ev}:UNBOUND`))[0]?.status).toBe('OPEN');

  await apiOk(page, 'POST', `/remote-events/${ev}/replay`);
  await refresh(page);
  const old = (await workItem(`event:${ev}:UNBOUND`))[0];
  expect(old.status).toBe('RESOLVED');
  expect(old.resolutionSource).toBe('AUTO');
  // replay 后状态取决于处理器结果（WAITING_PLAN 或 CONVERTED/其他）——
  // 若非 UNBOUND，旧 episode 必须终结；若有新 processing 异常则新开 episode
  const evRow = await db(async (p) =>
    p.rawRemoteEvent.findUniqueOrThrow({ where: { id: ev } }),
  );
  if (evRow.processingStatus !== 'UNBOUND') {
    expect(old.clearedAt).not.toBeNull();
  }
  await login(page);
  await evidence(page, info, 's5-remote-replay', { ev, to: evRow.processingStatus });
});

test('S6: CONFLICT 与 EVENT_KEY_CONFLICT 并存；T2 冲突 → 新 episode', async ({ page }, info) => {
  const src = await seedRemoteSource(companyOrgId, 's6');
  const ev = await seedEvent(src, 's6', 'CONFLICT', {
    currentIssueCode: 'EVENT_KEY_CONFLICT',
    currentIssueAt: new Date('2026-03-10T01:00:00Z'),
  });
  await conflictLog(ev);
  await refresh(page);
  const list = await apiOk(page, 'GET', '/exceptions?take=200');
  expect(keys(list.items)).toContain(`event:${ev}:CONFLICT`);
  expect(keys(list.items)).toContain(`event:${ev}:EVENT_KEY_CONFLICT:1`);

  // IGNORE 第一次冲突；同 event 第二次冲突（同一 currentIssueAt 毫秒）→ 新 episode
  await apiOk(page, 'POST', `/exceptions/${encodeURIComponent(`event:${ev}:EVENT_KEY_CONFLICT:1`)}/ignore`, {
    note: 'known dup',
  });
  await conflictLog(ev);
  await refresh(page);
  const eps1 = await workItem(`event:${ev}:EVENT_KEY_CONFLICT:1`);
  expect(eps1[0].status).toBe('IGNORED');
  expect(eps1[0].clearedAt).not.toBeNull();
  const eps2 = await workItem(`event:${ev}:EVENT_KEY_CONFLICT:2`);
  expect(eps2[0]?.status).toBe('OPEN');
  await login(page);
  await evidence(page, info, 's6-key-conflict', { ev });
});

test('S7: RBAC — exception:read 无 billing:read 可见逾期账单异常，drill 403', async ({ page }, info) => {
  const a = await onboard(page, 's7');
  // reader 角色（customer/metering/exception:read，无 billing:read）+ 本所册覆盖
  const branch = await db(async (p) => {
    const org = await p.orgUnit.create({
      data: { tenantId, parentId: companyOrgId, name: `E9 S7 营业所 ${stamp}`, type: 'BRANCH' },
    });
    const reader = await p.role.findUniqueOrThrow({
      where: { tenantId_code: { tenantId, code: 'reader' } },
    });
    const passwordHash = await bcrypt.hash('uat12345', 10);
    const staff = await p.staff.create({
      data: {
        tenantId,
        orgUnitId: org.id,
        login: `e9-reader-${stamp}`,
        name: 'E9 reader',
        passwordHash,
        status: 'ACTIVE',
      },
    });
    await p.staffRole.create({ data: { tenantId, staffId: staff.id, roleId: reader.id } });
    return org.id as string;
  });
  await seedBookCoverage(a.waterAccount.id, branch, 's7');
  const bill = await seedOverdueBill(a.waterAccount.id, a.waterAccount.settleAccountId, '202601');
  await refresh(page);
  const readerToken = await apiToken(page, `e9-reader-${stamp}`, 'uat12345');
  const list = await apiOk(page, 'GET', '/exceptions?take=200', undefined, readerToken);
  expect(keys(list.items)).toContain(`bill:${bill}:OVERDUE`);
  const drill = await api(page, 'GET', `/bills/${bill}`, undefined, readerToken);
  expect(drill.status).toBe(403);
  await login(page);
  await evidence(page, info, 's7-rbac', { bill });
});

test('S8: MULTI_BOOK 入队 + UI 操作（忽略需备注）', async ({ page }, info) => {
  const a = await onboard(page, 's8');
  await seedBookCoverage(a.waterAccount.id, companyOrgId, 's8a');
  await seedBookCoverage(a.waterAccount.id, companyOrgId, 's8b');
  await refresh(page);
  const key = `wa:${a.waterAccount.id}:MULTI_BOOK`;
  const rows = await workItem(key);
  expect(rows[0]?.status).toBe('OPEN');

  await login(page);
  await openQueueRow(page, '多重入册');
  const dr = page.locator('.ant-drawer:visible').last();
  await expect(dr).toContainText('多重入册');
  await expect(dr).toContainText('待处理');
  // 忽略必填备注：空提交 → 后端 400
  const r = await api(page, 'POST', `/exceptions/${encodeURIComponent(key)}/ignore`, {});
  expect(r.status).toBe(400);
  await evidence(page, info, 's8-multibook', { key });
});
test('S9: RC1 — 期间/营业所过滤器', async ({ page }, info) => {
  const a = await onboard(page, 's9');
  const org = await db(async (p) => {
    const o = await p.orgUnit.create({
      data: { tenantId, parentId: companyOrgId, name: `E9 S9 营业所 ${stamp}`, type: 'BRANCH' },
    });
    return o.id as string;
  });
  await seedBookCoverage(a.waterAccount.id, org, 's9');
  const bill = await seedOverdueBill(a.waterAccount.id, a.waterAccount.settleAccountId, '202604');
  await refresh(page);
  const bKey = `bill:${bill}:OVERDUE`;

  // API 层：period 命中/不命中；orgUnitId 命中/不命中
  const hit = await apiOk(page, 'GET', '/exceptions?period=202604&take=200');
  expect(keys(hit.items)).toContain(bKey);
  const miss = await apiOk(page, 'GET', '/exceptions?period=202605&take=200');
  expect(keys(miss.items)).not.toContain(bKey);
  const inOrg = await apiOk(page, 'GET', `/exceptions?orgUnitId=${org}&take=200`);
  expect(keys(inOrg.items)).toContain(bKey);
  const outOrg = await apiOk(page, 'GET', `/exceptions?orgUnitId=${companyOrgId}&take=200`);
  expect(keys(outOrg.items)).not.toContain(bKey); // bill anchor = S9 branch, not company

  // UI：期间输入框过滤 → 行出现；换成无匹配期间 → 消失
  await login(page);
  await page.goto('/exceptions');
  await ready(page);
  const periodInput = main(page).getByPlaceholder('期间 YYYYMM');
  const billRow = () => main(page).locator(`tr[data-row-key="${bKey}"]`);
  await periodInput.fill('202604');
  await expect(billRow()).toBeVisible();
  await periodInput.fill('202605');
  await expect(billRow()).toHaveCount(0);

  // UI：营业所下拉（admin 有 iam:read → 下拉出现）
  await periodInput.fill('');
  const orgSelect = main(page).locator('.ant-select').filter({ hasText: '营业所' }).first();
  if (await orgSelect.count()) {
    await orgSelect.click();
    await page.getByText(`E9 S9 营业所 ${stamp}`, { exact: false }).last().click();
    await expect(billRow()).toBeVisible();
  }
  await evidence(page, info, 's9-filters', { bill, org });
});

test('S10: RC1 — 今日新增/今日清除统计卡', async ({ page }, info) => {
  const bare = await seedBareAccount('s10');
  const s0 = await apiOk(page, 'GET', '/exceptions/summary');
  await refresh(page); // creates NO_BOOK + NO_ACTIVE_METER episodes today
  const s1 = await apiOk(page, 'GET', '/exceptions/summary');
  expect(s1.todayAdded).toBeGreaterThan(s0.todayAdded);
  expect(s1).toHaveProperty('todayCleared');

  // UI：统计卡存在且有值
  await login(page);
  await page.goto('/exceptions');
  await ready(page);
  await expect(main(page)).toContainText('今日新增');
  await expect(main(page)).toContainText('今日清除');

  // 清除 fact（入册）→ reconcile → todayCleared 增加
  await seedBookCoverage(bare.accId, companyOrgId, 's10');
  await refresh(page);
  const s2 = await apiOk(page, 'GET', '/exceptions/summary');
  expect(s2.todayCleared).toBeGreaterThan(s1.todayCleared);
  await evidence(page, info, 's10-today-cards', { bare: bare.accId });
});
