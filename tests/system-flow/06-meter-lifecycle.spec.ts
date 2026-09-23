import { test, expect, evidence } from './helpers/test';
import { load, save } from './helpers/state';
import { db } from './helpers/db';
import { login } from './helpers/ui';
import { button, response, choose, inputByLabel, selectPerson, formItem } from './helpers/ui';
import { onboard } from './helpers/onboard';

/**
 * J6 — meter lifecycle: register meter → 换表 (atomic replace) → history
 * preserved; then a fresh account: 销户 blocked by ACTIVE installation →
 * 拆除 → 销户 allowed → CLOSED.
 */
test.describe.configure({ mode: 'serial' });

const person = (s: any, key: string) => s.people.find((p: any) => p.key === key);

test('J6 meter lifecycle + account close', async ({ page, audit }, info) => {
  const s = load();
  expect(s.stages.j5).toBeTruthy();
  const A5 = person(s, 'SF-A-005');

  await login(page);
  await page.goto('/customer/meters');
  await expect(page.getByText('水表档案').first()).toBeVisible();

  // ---- register replacement meter ----
  let newMeter = await db((p) => p.meter.findFirst({
    where: { tenantId: s.tenantId, meterNo: 'M-SF-A-005-R' } }));
  if (!newMeter) {
    await button(page, '登记水表').click();
    const modal = page.getByRole('dialog', { name: '登记水表' });
    await inputByLabel(modal, '表号').fill('M-SF-A-005-R');
    await inputByLabel(modal, '口径').fill('DN15');
    await inputByLabel(modal, '最大读数（表位）').fill('99999');
    await response(page, '/meters', () => button(modal, '保存').click());
    await expect(modal).toBeHidden();
    newMeter = await db((p) => p.meter.findFirstOrThrow({
      where: { tenantId: s.tenantId, meterNo: 'M-SF-A-005-R' } }));
  }

  // ---- atomic replace on SF-A-005's ACTIVE installation ----
  // On rerun the replace already landed — resolve the original installation
  // from the checkpoint instead of the (now-new) ACTIVE row.
  const oldInst = s.meterReplaced
    ? await db((p) => p.meterInstallation.findFirstOrThrow({
        where: { tenantId: s.tenantId, id: s.meterReplaced.oldInstallationId } }))
    : await db((p) => p.meterInstallation.findFirstOrThrow({
        where: { tenantId: s.tenantId, waterAccountId: A5.waterAccount.id, status: 'ACTIVE' } }));
  const lastReading = await db((p) => p.meterReading.findFirstOrThrow({
    where: { tenantId: s.tenantId, installationId: oldInst.id },
    orderBy: { createdAt: 'desc' },
  }));
  if (!s.meterReplaced) {
    // filter 装拆记录 to SF-A-005 so the ACTIVE row is unambiguous
    await selectPerson(page, page.locator('.ant-card').nth(1), A5, '先选客户', '按水表户过滤');
    const row = page.getByRole('row').filter({ hasText: 'M-SF-A-005' }).filter({ hasText: '在用' });
    await button(row, '更换').click();
    const modal = page.getByRole('dialog', { name: /换表/ });
    await choose(page, formItem(modal, '新表（仅可用表）').locator('.ant-select'), 'M-SF-A-005-R · DN15', 'M-SF-A-005-R');
    await inputByLabel(modal, '旧表止码').fill(String(Number(lastReading.readingValue)));
    await inputByLabel(modal, '新表始码').fill('0');
    await response(page, /\/meter-installations\/[0-9a-f-]+\/replace/, () =>
      button(modal, '确认换表').click());
    await expect(modal).toBeHidden();
    s.meterReplaced = { accountNo: 'SF-A-005', oldInstallationId: oldInst.id, newMeterId: newMeter!.id };
    save(s);
    await evidence(page, info, 'j6-replaced');
  }

  // ---- verify: old REMOVED + final reading, new ACTIVE, history intact ----
  await db(async (p) => {
    const insts = await p.meterInstallation.findMany({
      where: { tenantId: s.tenantId, waterAccountId: A5.waterAccount.id },
      orderBy: { installedAt: 'asc' },
    });
    expect(insts.length).toBe(2);
    const [oldI, newI] = insts;
    expect(oldI.status).toBe('REMOVED');
    expect(Number(oldI.finalReading)).toBe(Number(lastReading.readingValue));
    expect(newI.status).toBe('ACTIVE');
    expect(newI.meterId).toBe(newMeter!.id);
    expect(Number(newI.initialReading)).toBe(0);
    // historical reading still links the OLD installation; settlement untouched
    const rd = await p.meterReading.findFirstOrThrow({
      where: { tenantId: s.tenantId, installationId: oldI.id, period: '202607' } });
    expect(rd.id).toBe(lastReading.id);
    const st = await p.consumptionSettlement.findFirstOrThrow({
      where: { tenantId: s.tenantId, waterAccountId: A5.waterAccount.id, period: '202607' } });
    expect(st.status).toBe('FINAL');
  });

  // 360 shows lifecycle (drawer from the water-accounts list)
  await page.goto('/customer/water-accounts?accountNo=SF-A-005');
  await page.getByRole('row').filter({ hasText: 'SF-A-005' })
    .getByRole('button', { name: '360°' }).click();
  await expect(page.getByRole('tab', { name: '概览' })).toBeVisible();
  const drawer = page.locator('.ant-drawer-open');
  await drawer.getByRole('tab', { name: /水表/ }).click();
  await expect(drawer.getByText('M-SF-A-005-R').first()).toBeVisible();
  await evidence(page, info, 'j6-360');
  await page.locator('.ant-drawer-open .ant-drawer-close').click();

  // ---- close blocked while ACTIVE installation exists ----
  const d1 = s.people.find((p: any) => p.key === 'SF-D-001')
    ?? await onboard(page, { key: 'SF-D-001', category: 'RES_METERED', addr: '城东街道D1', initialReading: '0' }, s.people);
  if (!s.people.find((p: any) => p.key === 'SF-D-001')) { s.people.push(d1); save(s); }

  const d1State = await db((p) => p.waterAccount.findFirstOrThrow({
    where: { tenantId: s.tenantId, accountNo: 'SF-D-001' } }));
  if (d1State.status !== 'CLOSED') {
    await page.goto('/customer/water-accounts?accountNo=SF-D-001');
    const row = page.getByRole('row').filter({ hasText: 'SF-D-001' });
    await button(row, '销户').click();
    const closeModal = page.getByRole('dialog', { name: /销户/ });
    audit.allow(`/api/water-accounts/${d1.waterAccount.id}/close`, 409); // ACCOUNT_HAS_ACTIVE_INSTALLATION
    const blocked = page.waitForResponse((r) =>
      /\/water-accounts\/[0-9a-f-]+\/close/.test(new URL(r.url()).pathname));
    await button(closeModal, '确认销户').click();
    expect((await blocked).status()).toBe(409);
    await expect(page.getByText('该户仍有在册水表，请先拆表/换表后再销户')).toBeVisible({ timeout: 8000 });
    await button(closeModal, '取消').click().catch(() => {});
    // confirm still ACTIVE in DB (blocked = no state change)
    const stillActive = await db((p) => p.waterAccount.findFirstOrThrow({
      where: { tenantId: s.tenantId, accountNo: 'SF-D-001' } }));
    expect(stillActive.status).toBe('NORMAL'); // close blocked → no state change

    // ---- remove the installation → close allowed ----
    await page.goto('/customer/meters');
    await selectPerson(page, page.locator('.ant-card').nth(1), d1, '先选客户', '按水表户过滤');
    const instRow = page.getByRole('row').filter({ hasText: 'M-SF-D-001' }).filter({ hasText: '在用' });
    await button(instRow, '拆除').click();
    const rmModal = page.getByRole('dialog', { name: /拆表/ });
    await inputByLabel(rmModal, '拆除读数').fill('0');
    await response(page, /\/meter-installations\/[0-9a-f-]+\/remove/, () =>
      button(rmModal, '确认拆除').click());
    await expect(rmModal).toBeHidden();

    await page.goto('/customer/water-accounts?accountNo=SF-D-001');
    const row2 = page.getByRole('row').filter({ hasText: 'SF-D-001' });
    await button(row2, '销户').click();
    const closeModal2 = page.getByRole('dialog', { name: /销户/ });
    await response(page, /\/water-accounts\/[0-9a-f-]+\/close/, () =>
      button(closeModal2, '确认销户').click());
    const closed = await db((p) => p.waterAccount.findFirstOrThrow({
      where: { tenantId: s.tenantId, accountNo: 'SF-D-001' } }));
    expect(closed.status).toBe('CLOSED');
  }
  const d1Final = await db((p) => p.waterAccount.findFirstOrThrow({
    where: { tenantId: s.tenantId, accountNo: 'SF-D-001' } }));
  expect(d1Final.status).toBe('CLOSED');
  await evidence(page, info, 'j6-closed', { closed: d1Final.id });
  s.stages.j6 = true;
  save(s);
});
