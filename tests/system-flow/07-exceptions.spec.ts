import { test, expect, evidence } from './helpers/test';
import { load, save } from './helpers/state';
import { db } from './helpers/db';
import { login } from './helpers/ui';
import { apiAs } from './helpers/api';
import { button, response, choose, inputByLabel, selectPerson, formItem } from './helpers/ui';
import { enterSingle, qcReading } from './helpers/reading';
import { BrowserAudit } from '../uat/helpers/console';

/**
 * J7 — Exception Center lifecycle.
 * Fixture facts (deterministic, UI where it exists):
 *   NO_BOOK              SF-X-001 — never added to a book
 *   NO_ACTIVE_METER      SF-X-001 — installation removed via UI below
 *   READING_QC_REJECTED  SF-C-001 — P2 reading entered then rejected
 *   REMOTE_EVENT_UNBOUND source SF-REMOTE, unknown vendorDeviceKey (API ingest)
 *   UNPAID_BILL_OVERDUE  unpaid 202607 bills (due 2026-08-15 < today)
 * Lifecycle: ACK → ASSIGN → resolve-while-active 409 →
 * repair-then-resolve MANUAL (READING_QC_REJECTED) → IGNORE →
 * repair + refresh AUTO RESOLVED / IGNORED-stays → recurrence → NEW OPEN.
 */
const P2 = '202608';

test.describe.configure({ mode: 'serial' });

const person = (s: any, key: string) => s.people.find((p: any) => p.key === key);

async function refreshQueue(page: any) {
  return response(page, '/exceptions/refresh', () =>
    button(page, '刷新队列').click());
}

async function openDetailBySummary(page: any, typeLabel: string, summaryText?: string) {
  // the 类型 column already renders the label — no need to drive the filter
  let row = page.getByRole('row').filter({ hasText: typeLabel });
  if (summaryText) row = row.filter({ hasText: summaryText });
  row = row.first();
  // the queue paginates; walk pages until the row appears
  for (let i = 0; i < 8; i++) {
    if (await row.count()) break;
    const next = page.locator('.ant-pagination-next:not(.ant-pagination-disabled)');
    if (!(await next.count())) break;
    await next.click();
    await page.waitForLoadState('networkidle').catch(() => {});
  }
  await expect(row).toBeVisible();
  const detailRes = page.waitForResponse((r: any) =>
    /\/exceptions\/.+/.test(new URL(r.url()).pathname) && r.request().method() === 'GET');
  await row.getByRole('button', { name: /详\s*情/ }).click();
  const res = await detailRes;
  const key = decodeURIComponent(new URL(res.url()).pathname.split('/exceptions/')[1]);
  const drawer = page.locator('.ant-drawer-open');
  await expect(drawer).toBeVisible();
  return { drawer, key };
}

test('J7 exception center', async ({ page, audit }, info) => {
  const s = load();
  expect(s.stages.j6).toBeTruthy();
  const X1 = person(s, 'SF-X-001');
  const C1 = person(s, 'SF-C-001');

  // ---------- fixture: remote source (UI) + unbound event (API ingest) ----------
  await login(page);
  let source = await db((p) => p.remoteSource.findFirst({
    where: { tenantId: s.tenantId, code: 'SF-REMOTE' } }));
  if (!source) {
    await page.goto('/metering/remote-sources');
    await button(page, '新建数据源').click();
    const modal = page.getByRole('dialog', { name: '新建数据源' });
    await inputByLabel(modal, '编码').fill('SF-REMOTE');
    await inputByLabel(modal, '名称').fill('系统流远传源');
    await choose(page, formItem(modal, '类型').locator('.ant-select'), 'API 拉取');
    await inputByLabel(modal, 'Adapter Key').fill('sf-adapter');
    await inputByLabel(modal, '时区（IANA）').fill('Asia/Shanghai');
    await response(page, '/remote-sources', () => button(modal, '确 定').or(button(modal, '确定')).click());
    source = await db((p) => p.remoteSource.findFirstOrThrow({
      where: { tenantId: s.tenantId, code: 'SF-REMOTE' } }));
  }
  let unbound = await db((p) => p.rawRemoteEvent.findFirst({
    where: { tenantId: s.tenantId, remoteSourceId: source!.id, externalEventKey: 'SF-EVT-UNBOUND-1' } }));
  if (!unbound) {
    const api = await apiAs('admin');
    const res = await api.post(`/remote-sources/${source!.id}/events`, {
      vendorDeviceKey: 'SF-UNKNOWN-1',
      businessPeriod: P2,
      collectedAt: '2026-08-20T08:00:00+08:00',
      readingValue: '100',
      externalEventKey: 'SF-EVT-UNBOUND-1',
    });
    await api.dispose();
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    unbound = await db((p) => p.rawRemoteEvent.findFirstOrThrow({
      where: { tenantId: s.tenantId, remoteSourceId: source!.id, externalEventKey: 'SF-EVT-UNBOUND-1' } }));
  }

  // ---------- fixture: SF-X-001 installation removal → NO_ACTIVE_METER ----------
  const x1Active = await db((p) => p.meterInstallation.findFirst({
    where: { tenantId: s.tenantId, waterAccountId: X1.waterAccount.id, status: 'ACTIVE' } }));
  if (x1Active) {
    await page.goto('/customer/meters');
    await selectPerson(page, page.locator('.ant-card').nth(1), X1, '先选客户', '按水表户过滤');
    const instRow = page.getByRole('row').filter({ hasText: 'M-SF-X-001' }).filter({ hasText: '在用' });
    await button(instRow, '拆除').click();
    const rmModal = page.getByRole('dialog', { name: /拆表/ });
    await inputByLabel(rmModal, '拆除读数').fill('0');
    await response(page, /\/meter-installations\/[0-9a-f-]+\/remove/, () =>
      button(rmModal, '确认拆除').click());
    await expect(rmModal).toBeHidden();
  }

  // ---------- fixture: SF-C-001 P2 reading → QC reject → READING_QC_REJECTED ----------
  const c1Readings = await db(async (p) => {
    const all = await p.meterReading.findMany({
      where: { tenantId: s.tenantId, installation: { waterAccountId: C1.waterAccount.id }, period: P2 },
      select: { id: true, qcStatus: true, supersedesReadingId: true } });
    const sup = new Set(all.map((r: any) => r.supersedesReadingId).filter(Boolean));
    return all.filter((r: any) => !sup.has(r.id));
  });
  if (c1Readings.length === 0) {
    const prev = await db((p) => p.meterReading.findFirstOrThrow({
      where: { tenantId: s.tenantId, installation: { waterAccountId: C1.waterAccount.id }, period: '202607' },
      orderBy: { createdAt: 'desc' } }));
    await enterSingle(page, s.plans[`${P2}-C`].id, '城南一册', 'SF-C-001',
      String(Number(prev.readingValue) + 9), '2026-08');
  }
  const c1Live = await db(async (p) => {
    const all = await p.meterReading.findMany({
      where: { tenantId: s.tenantId, installation: { waterAccountId: C1.waterAccount.id }, period: P2 },
      select: { id: true, qcStatus: true, supersedesReadingId: true } });
    const sup = new Set(all.map((r: any) => r.supersedesReadingId).filter(Boolean));
    return all.filter((r: any) => !sup.has(r.id))[0];
  });
  if (c1Live?.qcStatus === 'PENDING') {
    await login(page, 'sf-reviewer');
    await qcReading(page, 'SF-C-001', '驳回');
  }

  // ---------- journey: refresh queue ----------
  await login(page);
  await page.goto('/exceptions');
  await expect(page.getByText('异常队列').first()).toBeVisible();
  const refresh = await refreshQueue(page);
  expect(refresh.detected).toBeGreaterThan(0);
  await evidence(page, info, 'j7-queue', refresh);


  // ---------- NO_BOOK (SF-X-001): detail → drill → ACK → ASSIGN ----------
  const noBookKey = `wa:${X1.waterAccount.id}:NO_BOOK`;
  const noBookActive = await db((p) => p.workItem.findFirst({
    where: { tenantId: s.tenantId, anomalyKey: noBookKey, clearedAt: null } }));
  if (noBookActive) {
    const { drawer } = await openDetailBySummary(page, '未入册', 'SF-X-001');
    await expect(drawer.getByText('SF-X-001').first()).toBeVisible();
    // drilldown opens the business object (360 drawer or domain page)
    const drillBtn = drawer.getByRole('button', { name: '查看业务对象' });
    if (await drillBtn.isVisible().catch(() => false)) await drillBtn.click();
    await page.waitForTimeout(800);
    // close any 360 drawer opened by drill (keep exception drawer usable)
    const drawers = page.locator('.ant-drawer-open');
    if (await drawers.count() > 1) {
      await drawers.last().locator('.ant-drawer-close').click();
    }
    // ACK (reconcile-first: button only exists while episode is OPEN)
    const ep0 = await db((p) => p.workItem.findFirst({
      where: { tenantId: s.tenantId, anomalyKey: noBookKey, clearedAt: null } }));
    if (ep0?.status === 'OPEN') {
      await response(page, `/exceptions/${encodeURIComponent(noBookKey)}/ack`, () =>
        button(drawer, '确认').click());
    }
    // ASSIGN → admin. NO_BOOK has empty coveringOrgs (no book) so only
    // ALL-scope staff can see the fact — org-scoped assignees 403.
    const epForAssign = await db((p) => p.workItem.findFirst({
      where: { tenantId: s.tenantId, anomalyKey: noBookKey, clearedAt: null } }));
    if (epForAssign?.assigneeId !== s.roles['admin'].id) {
      await button(drawer, '指派').click();
      const assignModal = page.getByRole('dialog', { name: '指派处理人' });
      await choose(page, assignModal.locator('.ant-select'), s.roles['admin'].name, s.roles['admin'].name);
      await response(page, `/exceptions/${encodeURIComponent(noBookKey)}/assign`, () =>
        button(assignModal, '确 定').or(button(assignModal, '确定')).click());
    }
    await expect(drawer.getByText('已确认').first()).toBeVisible();
    await evidence(page, info, 'j7-ack-assign');
    await page.locator('.ant-drawer-open .ant-drawer-close').click();
  }

  // ---------- UNPAID_BILL_OVERDUE: resolve while active → 409 ----------
  // (only while the episode is still actionable — a rerun with it already
  //  terminal would have no resolve button)
  const overdueBill = await db((p) => p.bill.findFirstOrThrow({
    where: { tenantId: s.tenantId, period: '202607', status: 'POSTED' } }));
  const overdueKey = `bill:${overdueBill.id}:OVERDUE`;
  const overdueEp = await db((p) => p.workItem.findFirst({
    where: { tenantId: s.tenantId, anomalyKey: overdueKey, clearedAt: null } }));
  if (overdueEp && overdueEp.status !== 'RESOLVED') {
    const { drawer, key: openKey } = await openDetailBySummary(page, '账单逾期');
    audit.allow(`/api/exceptions/${encodeURIComponent(openKey)}/resolve`, 409);
    await button(drawer, '标记已解决').click();
    const modal = page.getByRole('dialog', { name: '标记已解决' });
    const blocked = page.waitForResponse((r) =>
      r.url().includes('/resolve') && r.request().method() === 'POST');
    await button(modal, '确 定').or(button(modal, '确定')).click();
    const res = await blocked;
    expect(res.status()).toBe(409);
    const body = await res.json().catch(() => ({}));
    expect(body.code ?? body?.error?.code).toBe('ANOMALY_STILL_ACTIVE');
    await button(modal, '取消').click().catch(() => {});
    await page.locator('.ant-drawer-open .ant-drawer-close').click();
  }

  // ---------- READING_QC_REJECTED (SF-C-001): repair → MANUAL resolve ----------
  // The product gate: episode detail GETs require the fact to still exist, so
  // operator A must already have the drawer open while operator B repairs the
  // reading in a separate session. NO exceptions refresh here — the fact
  // clears via supersede, the episode stays open, and the queued resolve POST
  // then succeeds as MANUAL (the same path a real operator hits).
  const c1All = await db((p) => p.meterReading.findMany({
    where: {
      tenantId: s.tenantId, period: P2,
      installation: { waterAccountId: C1.waterAccount.id },
    },
    select: { id: true, qcStatus: true, readingValue: true, supersedesReadingId: true },
  }));
  const c1Sup = new Set(c1All.map((r: any) => r.supersedesReadingId).filter(Boolean));
  const c1LiveReading = c1All.find((r: any) => !c1Sup.has(r.id));
  const c1Rejected = c1All.find((r: any) => r.qcStatus === 'REJECTED');
  const qcKey = c1Rejected ? `reading:${c1Rejected.id}:QC_REJECTED` : null;
  const qcEp = qcKey && await db((p) => p.workItem.findFirst({
    where: { tenantId: s.tenantId, anomalyKey: qcKey, clearedAt: null } }));
  if (qcEp && qcEp.status !== 'RESOLVED') {
    // operator A opens the episode while the fact is still live
    const { drawer, key: openKey } = await openDetailBySummary(page, '抄表驳回', 'SF-C-001');
    expect(openKey).toBe(qcKey);
    if (c1LiveReading?.qcStatus === 'REJECTED') {
      // operator B repairs through the normal UI in its own session:
      // supersede the rejected reading, then QC PASS — fact clears
      const ctx2 = await page.context().browser()!.newContext();
      const page2 = await ctx2.newPage();
      const audit2 = new BrowserAudit(page2);
      try {
        // admin (ALL scope) — sf-reader is 城东-scoped and can't see 城南
        await login(page2, 'admin');
        await page2.goto('/metering/readings');
        const s2 = page2.getByPlaceholder('搜索户号、客户或地址');
        await s2.fill('SF-C-001');
        await s2.press('Enter');
        const rejRow = page2.getByRole('row').filter({ hasText: 'SF-C-001' })
          .filter({ hasText: '质检驳回' });
        await rejRow.getByRole('button', { name: '更正' }).click();
        const supModal = page2.getByRole('dialog', { name: /更正读数/ });
        await supModal.getByLabel('更正后表码读数')
          .fill(String(Number(c1Rejected!.readingValue) + 1));
        await response(page2, /\/meter-readings\/[0-9a-f-]+\/supersede/, () =>
          button(supModal, '更正').click());
        await login(page2, 'sf-reviewer');
        await qcReading(page2, 'SF-C-001', '通过');
      } finally {
        await Promise.allSettled(audit2.pending);
        audit.events.push(...audit2.events); // operator-B traffic is evidence too
        await ctx2.close();
      }
    }
    // fact gone, episode still open → UI resolve is MANUAL, not 409
    audit.allow(`/api/exceptions/${encodeURIComponent(qcKey!)}`, 404, 'GET');
    const resolved = page.waitForResponse((r) =>
      r.url().includes('/resolve') && r.request().method() === 'POST');
    await button(drawer, '标记已解决').click();
    const modal = page.getByRole('dialog', { name: '标记已解决' });
    await button(modal, '确 定').or(button(modal, '确定')).click();
    const res = await resolved;
    // NestJS POST default is 201 — assert 2xx success, not the 409 guard
    expect([200, 201]).toContain(res.status());
    const epAfter = await db((p) => p.workItem.findFirstOrThrow({
      where: { tenantId: s.tenantId, anomalyKey: qcKey }, orderBy: { createdAt: 'desc' } }));
    expect(epAfter.status).toBe('RESOLVED');
    expect(epAfter.resolutionSource).toBe('MANUAL');
    expect(epAfter.clearedAt).not.toBeNull();
    await evidence(page, info, 'j7-manual-resolve', { key: qcKey, episode: epAfter.id });
    await page.locator('.ant-drawer-open .ant-drawer-close').click();
    await expect(page.locator('.ant-drawer-open')).toHaveCount(0);
  }

  // ---------- IGNORE NO_ACTIVE_METER (SF-X-001) ----------
  const noMeterKey = `wa:${X1.waterAccount.id}:NO_ACTIVE_METER`;
  const noMeterEp = await db((p) => p.workItem.findFirst({
    where: { tenantId: s.tenantId, anomalyKey: noMeterKey, clearedAt: null } }));
  if (noMeterEp && noMeterEp.status !== 'IGNORED') {
    const { drawer } = await openDetailBySummary(page, '无在装表', 'SF-X-001');
    await button(drawer, '忽略').click();
    const modal = page.getByRole('dialog', { name: '忽略异常' });
    await modal.locator('textarea').fill('换表流程中，暂不处理');
    await response(page, `/exceptions/${encodeURIComponent(noMeterKey)}/ignore`, () =>
      button(modal, '确 定').or(button(modal, '确定')).click());
    await expect(drawer.getByText('已忽略').first()).toBeVisible();
    await page.locator('.ant-drawer-open .ant-drawer-close').click();
  }

  // ---------- repair: add SF-X-001 to book A → NO_BOOK AUTO RESOLVED ----------
  const bookA = s.books.find((b: any) => b.bookNo === 'SF-BOOK-A');
  const x1InBook = await db((p) => p.bookMeter.findFirst({
    where: { tenantId: s.tenantId, bookId: bookA.id, waterAccountId: X1.waterAccount.id } }));
  if (!x1InBook) {
    const { addBookMembers } = await import('./helpers/reading');
    await addBookMembers(page, '城东一册', [X1]);
  }
  await page.goto('/exceptions');
  await refreshQueue(page);
  let ep = await db((p) => p.workItem.findMany({
    where: { tenantId: s.tenantId, anomalyKey: noBookKey }, orderBy: { createdAt: 'asc' } }));
  const lastEp = ep[ep.length - 1];
  expect(lastEp.status).toBe('RESOLVED');
  expect(lastEp.resolutionSource).toBe('AUTO');
  expect(lastEp.clearedAt).toBeTruthy();
  const resolvedCount = ep.length;
  await evidence(page, info, 'j7-auto-resolved', ep);

  // ---------- reinstall meter → IGNORED fact cleared, episode stays IGNORED ----------
  const x1NoActive = await db((p) => p.meterInstallation.count({
    where: { tenantId: s.tenantId, waterAccountId: X1.waterAccount.id, status: 'ACTIVE' } }));
  if (x1NoActive === 0) {
    await page.goto('/customer/meters');
    const instCard = page.locator('.ant-card').nth(1);
    await button(instCard, '装表').click();
    const modal = page.getByRole('dialog', { name: '装表' });
    await selectPerson(page, modal, X1);
    await choose(page, formItem(modal, '水表（仅可用表可安装）').locator('.ant-select'), 'M-SF-X-001 · DN15', 'M-SF-X-001');
    await inputByLabel(modal, '初始读数').fill('0');
    await response(page, '/meter-installations', () => button(modal, '确认装表').click());
    await expect(modal).toBeHidden();
  }
  await page.goto('/exceptions');
  await refreshQueue(page);
  ep = await db((p) => p.workItem.findMany({
    where: { tenantId: s.tenantId, anomalyKey: noMeterKey } }));
  expect(ep[0].status).toBe('IGNORED');   // cleared but never reopened
  expect(ep[0].clearedAt).toBeTruthy();   // fact gone

  // ---------- recurrence: remove X-001 from book → NEW OPEN episode ----------
  const member = await db((p) => p.bookMeter.findFirst({
    where: { tenantId: s.tenantId, bookId: bookA.id, waterAccountId: X1.waterAccount.id } }));
  if (member) {
    await page.goto('/metering/books');
    const bookRow = page.getByRole('row').filter({ hasText: '城东一册' });
    await button(bookRow, '成员').click();
    const drawer = page.locator('.ant-drawer-open');
    const mRow = drawer.getByRole('row').filter({ hasText: 'SF-X-001' });
    await button(mRow, '移出').click();
    const pop = page.locator('.ant-popover:visible');
    await response(page, new RegExp(`/reading-books/${bookA.id}/meters/${X1.waterAccount.id}`), () =>
      button(pop, '移出').click(), 'DELETE');
    await page.locator('.ant-drawer-open .ant-drawer-close').click();
  }
  await page.goto('/exceptions');
  await refreshQueue(page);
  ep = await db((p) => p.workItem.findMany({
    where: { tenantId: s.tenantId, anomalyKey: noBookKey }, orderBy: { createdAt: 'asc' } }));
  expect(ep.length).toBe(resolvedCount + 1);
  for (const old of ep.slice(0, -1)) {
    expect(['RESOLVED', 'IGNORED']).toContain(old.status); // old episodes never reopen
    expect(old.clearedAt).toBeTruthy();
  }
  const newEp = ep[ep.length - 1];
  expect(newEp.status).toBe('OPEN');       // fresh episode for recurrence
  expect(newEp.clearedAt).toBeNull();
  await evidence(page, info, 'j7-recurrence', ep);

  // ---------- leftover facts sanity (derived via live queue read) ----------
  const api2 = await apiAs('admin');
  const list = await api2.get('/exceptions?take=200');
  await api2.dispose();
  const types = (list.body?.items ?? list.body ?? []).map((f: any) => f.type);
  // repaired + MANUAL-resolved — the fact no longer exists in the live queue
  expect(types).not.toContain('READING_QC_REJECTED');
  expect(types).toContain('REMOTE_EVENT_UNBOUND');
  expect(types).toContain('UNPAID_BILL_OVERDUE');
  expect(types).toContain('NO_BOOK');

  s.exceptions = { noBookKey, noMeterKey, overdueKey };
  s.stages.j7 = true;
  save(s);
  await evidence(page, info, 'j7-done', { activeTypes: types });
});
