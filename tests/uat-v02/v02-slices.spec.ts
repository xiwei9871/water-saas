/**
 * v0.2 UAT — five vertical slices against water_uat_v02 (real UI + real API,
 * no mocks). Serial suite; heavy non-slice setup goes through the API with the
 * admin token captured after the first UI login.
 *
 * Slices:
 *  1. 受控用水类别 + 监控表立户（系统客户、不计费、不进开账候选）
 *  2. 居民人数申报（effectiveFromPeriod + 历史）+ 资费人数参数 + 账单口径
 *  3. 抄表周期（BIMONTHLY + anchorPeriod）+ 非应抄期 warning 不硬拦
 *  4. NO_READ 预计用水量录入（不伪造表码）+ 结算来源标识
 *  5. 补差结果业务化表达（冲减调账单可读文案）
 */
import { test, expect } from '../uat/helpers/console';
import { login, ready } from '../uat/helpers/auth';
import { db } from '../uat/helpers/fixture';
import { button, date, evidence, main, response, row, select } from '../uat/helpers/ui';
import type { Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const stamp = Date.now().toString(36);
const S: Record<string, any> = { stamp };
let token = '';

/** API call through the vite proxy with the UI session's JWT. */
async function api(
  page: Page,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
) {
  const res = await page.request.fetch(`/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
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

/** API call that must succeed — returns parsed body. */
async function apiOk(
  page: Page,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
) {
  const r = await api(page, method, path, body);
  expect(r.status, `${method} ${path}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
  return r.body;
}

/** Insert a QC-passed ACTUAL reading directly — a trusted historical fact. */
async function trustedReading(a: any, period: string, value: string) {
  await db(async (p) => {
    const tenant = await p.tenant.findUniqueOrThrow({ where: { code: 'cd-water' } });
    const staff = await p.staff.findFirstOrThrow({
      where: { tenantId: tenant.id, login: 'admin' },
    });
    await p.meterReading.create({
      data: {
        tenantId: tenant.id,
        installationId: a.installation.id,
        meterId: a.meter.id,
        period,
        readDate: new Date(
          `${period.slice(0, 4)}-${period.slice(4)}-28`,
        ),
        resultType: 'ACTUAL',
        readingValue: value,
        qcStatus: 'PASSED',
        qcBy: staff.id,
        qcAt: new Date(),
        source: 'WEB',
        operatorId: staff.id,
      },
    });
  });
}

async function finalizeAndBill(page: Page, settlementId: string, period: string) {
  await apiOk(page, 'POST', `/consumption-settlements/${settlementId}/finalize`, {});
  const run = await apiOk(page, 'POST', '/billing-runs', { period });
  await apiOk(page, 'POST', `/billing-runs/${run.id}/post`, {});
  return run;
}

test('S1 受控类别 + 监控表立户：系统客户、不计费、不进开账候选', async ({ page }, info) => {
  await login(page);
  token = await page.evaluate(() => localStorage.getItem('water-saas.accessToken')!);
  await page.goto('/customer/onboard');

  // 用水类别是固定五项 Select —— 不再有自由输入。
  const catSelect = main(page)
    .locator('.ant-form-item')
    .filter({ hasText: '用水类别' })
    .locator('.ant-select');
  await catSelect.click();
  const dd = page.locator('.ant-select-dropdown:visible');
  for (const label of ['居民（户表）', '居民（非户表）', '非居民', '特种', '监控表']) {
    await expect(dd.getByText(label, { exact: true })).toBeVisible();
  }
  await dd.getByText('监控表', { exact: true }).click();

  // 监控表路径：提示文案 + 步骤收敛为「水表户 / 水表安装」两步。
  await expect(main(page)).toContainText('监控表仅用于计量与区域漏损分析');
  await expect(main(page)).toContainText('不开账单、不涉及收费');
  await expect(main(page).locator('.ant-steps-item-title')).toHaveCount(2);

  await main(page).getByLabel('用水地址', { exact: true }).fill(`UAT监控断面-${stamp}`);
  await page.getByRole('button', { name: '下一步' }).click();
  await main(page).getByLabel('装表初始读数', { exact: true }).fill('0');
  S.mon = await response(page, '/water-accounts/onboard', () =>
    page.getByRole('button', { name: '提交立户' }).click(),
  );
  expect(S.mon.waterAccount.usageCategory).toBe('MONITORING');
  await expect(main(page)).toContainText('立户完成');
  await expect(main(page)).toContainText('本公司·监控表'); // 系统客户自动挂靠

  // 水表户列表：监控表 + 不计费标签。
  await page.goto(`/customer/water-accounts?accountNo=${S.mon.waterAccount.accountNo}`);
  await ready(page);
  const monRow = row(page, S.mon.waterAccount.accountNo);
  await expect(monRow).toContainText('监控表');
  await expect(monRow).toContainText('不计费');

  // 开账排除：该期若只有监控户的终审结算，批次人口为 0（不算候选也不算失败）。
  const monSettle = await apiOk(page, 'POST', '/consumption-settlements', {
    waterAccountId: S.mon.waterAccount.id,
    period: '202610',
    usageQty: '9',
    estimateReason: 'UAT 监控表计量',
  });
  await apiOk(page, 'POST', `/consumption-settlements/${monSettle.id}/finalize`, {});
  const run = await apiOk(page, 'POST', '/billing-runs', { period: '202610' });
  expect(run.bills ?? []).toHaveLength(0);
  expect(run.totalCount ?? 0).toBe(0);
  await page.goto('/billing/runs');
  await ready(page);
  // 复跑会在同账期留下多个批次 —— 每行都应是 0/0/0（监控户不进候选）。
  const runRow = row(page, '2026-10').first();
  await button(runRow, '详情').click();
  await expect(page.getByRole('dialog')).toContainText('0 / 0 / 0');
  await evidence(page, info, 'S1-monitoring', {
    accountNo: S.mon.waterAccount.accountNo,
    customer: S.mon.customer.name,
    runTotal: run.totalCount,
  });
});

test('S2 人数申报 + 资费人数参数 + 账单计费口径', async ({ page }, info) => {
  await login(page);
  // 立户走 API（向导已在 S1 覆盖）；不带人数，留给 UI 申报路径。
  S.acct = await apiOk(page, 'POST', '/water-accounts/onboard', {
    customer: { name: `UAT多户-${stamp}`, custType: 'PERSONAL' },
    account: {
      usageCategory: 'RES_METERED',
      addr: `UAT阶梯地址-${stamp}`,
      openedAt: '2026-06-01',
      accountNo: `V02A${stamp}`.slice(0, 20),
    },
    meter: { brand: 'UAT' },
    installation: { initialReading: '0', installedAt: '2026-06-01' },
  });

  // UI：水表户 → 人数申报（5 人自 2026-07 生效）。
  await page.goto(`/customer/water-accounts?accountNo=${S.acct.waterAccount.accountNo}`);
  await ready(page);
  await button(row(page, S.acct.waterAccount.accountNo), '人数').click();
  const hh = page.getByRole('dialog');
  await expect(hh).toContainText('用水人数申报');
  await expect(hh).toContainText('尚未申报');
  await hh.getByRole('spinbutton').fill('5');
  await date(hh.getByLabel('生效账期'), '2026-07');
  await button(hh, '提交申报').click();
  await expect(hh.getByRole('row').filter({ hasText: '2026-07' })).toContainText('5');
  await expect(hh).toContainText('当前生效');
  // 第二条申报（未来账期）——历史列表同时展示两条。
  await hh.getByRole('spinbutton').fill('6');
  await date(hh.getByLabel('生效账期'), '2026-10');
  await button(hh, '提交申报').click();
  await expect(hh.getByRole('row').filter({ hasText: '2026-10' })).toContainText('未生效');
  await expect(hh).toContainText('当前申报人数：5'); // 未来申报不冒充当前值
  // 底部「关 闭」（避开右上角 X 同名单按钮）。
  await hh.locator('.ant-modal-footer').getByRole('button', { name: /关\s*闭/ }).click();

  // 重跑安全：同类别 ACTIVE 计划会与新计划窗口重叠，先全部退订。
  const activePlans = await apiOk(
    page,
    'GET',
    '/tariff-plans?usageCategory=RES_METERED&take=200',
  );
  for (const p of activePlans.filter((x: any) => x.status === 'ACTIVE')) {
    await apiOk(page, 'POST', `/tariff-plans/${p.id}/retire`, {});
  }

  // UI：资费表单含基准人数 + 每人年度扩展量。
  await page.goto('/billing/tariffs');
  await ready(page);
  await page.getByRole('button', { name: '新建资费方案' }).click();
  const tDlg = page.getByRole('dialog', { name: '新建资费方案' });
  const planCode = `UATHH${stamp}`.toUpperCase().slice(0, 20);
  await tDlg.getByLabel('编码', { exact: true }).fill(planCode);
  await tDlg.getByLabel('名称', { exact: true }).fill('UAT居民阶梯·人数扩展');
  await select(
    page,
    tDlg.locator('.ant-form-item').filter({ hasText: '用水类别' }).locator('.ant-select'),
    '居民（户表）',
  );
  await date(tDlg.getByLabel('生效日期', { exact: true }), '2026-01-01');
  await tDlg.getByLabel('基准人数（一户多人口）', { exact: true }).fill('4');
  await tDlg.getByLabel('每人年度扩展量（m³/年）', { exact: true }).fill('51');
  // 表单自带空费用组（groups[0]），直接填；阶梯 0-216 / 216-∞。
  await select(
    page,
    tDlg.locator('#groups_0_feeItemId'),
    '水费（WATER · 按量计价）',
  );
  await tDlg.locator('#groups_0_tiers_0_toQty').fill('216');
  await tDlg.locator('#groups_0_tiers_0_unitPrice').fill('3');
  await button(tDlg.locator('.ant-card').first(), '加一档').click();
  await tDlg.locator('#groups_0_tiers_1_fromQty').fill('216');
  await tDlg.locator('#groups_0_tiers_1_unitPrice').fill('4.5');
  S.tariff = await response(page, '/tariff-plans', () => button(tDlg, '保存').click());
  expect(S.tariff.baseHousehold).toBe(4);
  expect(String(S.tariff.perPersonQty)).toBe('51');
  const tRow = row(page, planCode);
  await button(tRow, '激活').click();
  await response(page, `/tariff-plans/${S.tariff.id}/activate`, () =>
    button(page.getByRole('tooltip'), '激活').click(),
  );

  // 实读 270 → 结算（人数快照 5）→ 终审 → 开账。扩展后边界 267：
  // 267×3 + 3×4.5 = ¥814.50（无扩展则为 216×3 + 54×4.5 = ¥891.00）。
  await trustedReading(S.acct, '202607', '270');
  const s270 = await apiOk(page, 'POST', '/consumption-settlements', {
    waterAccountId: S.acct.waterAccount.id,
    period: '202607',
  });
  expect(Number(s270.totalUsageQty)).toBe(270);
  expect(s270.householdSizeSnapshot).toBe(5);
  await finalizeAndBill(page, s270.id, '202607');
  const bills = await apiOk(
    page,
    'GET',
    `/bills?waterAccountId=${S.acct.waterAccount.id}`,
  );
  S.bill = bills.find((b: any) => b.sourceId === s270.id);
  expect(String(S.bill.totalAmount)).toBe('81450');

  // UI：账单详情 —— 人数快照 / 基准人数 / 阶梯扩展。
  await page.goto('/billing/bills');
  await ready(page);
  await button(row(page, S.acct.waterAccount.accountNo), '详情').click();
  const billDlg = page.getByRole('dialog');
  await expect(billDlg).toContainText('户籍人数（结算快照）');
  await expect(billDlg).toContainText('基准人数');
  await expect(billDlg).toContainText('+51 m³/年');
  await expect(billDlg).toContainText('¥814.50');
  await evidence(page, info, 'S2-household-bill', {
    settlement: s270.id,
    bill: S.bill.id,
    totalAmount: S.bill.totalAmount,
  });
});

test('S3 抄表周期：BIMONTHLY + 锚定账期 + 非应抄期 warning 不硬拦', async ({ page }, info) => {
  await login(page);
  // S4 的抄表对象：独立账号 D —— 不碰 A（已有 FINAL+出账结算）和监控户。
  S.acctD = await apiOk(page, 'POST', '/water-accounts/onboard', {
    customer: { name: `UAT抄表-${stamp}`, custType: 'PERSONAL' },
    account: {
      usageCategory: 'RES_METERED',
      addr: `UAT抄表地址-${stamp}`,
      openedAt: '2026-01-01',
      accountNo: `V02D${stamp}`.slice(0, 20),
    },
    meter: { brand: 'UAT' },
    installation: { initialReading: '0', installedAt: '2026-01-01' },
  });
  await page.goto('/metering/books');
  await ready(page);
  await page.getByRole('button', { name: '新建抄表册' }).click();
  const bDlg = page.getByRole('dialog', { name: '新建抄表册' });
  const bookName = `UAT双月册-${stamp}`;
  S.bookName = bookName;
  await bDlg.getByLabel('册名', { exact: true }).fill(bookName);
  await select(
    page,
    bDlg.locator('.ant-form-item').filter({ hasText: '所属组织' }).getByRole('combobox'),
    '成都水务公司',
  );
  await select(
    page,
    bDlg.locator('.ant-form-item').filter({ hasText: '抄表周期' }).locator('.ant-select'),
    '双月（隔月）',
  );
  // 锚定账期仅在双月时出现。
  await expect(bDlg.getByLabel('锚定账期')).toBeVisible();
  await date(bDlg.getByLabel('锚定账期'), '2026-01');
  await select(
    page,
    bDlg.locator('.ant-form-item').filter({ hasText: '抄表方式' }).locator('.ant-select'),
    '机械表·人工',
  );
  S.book = await response(page, '/reading-books', () => button(bDlg, '保存').click());
  expect(S.book.cadence).toBe('BIMONTHLY');
  expect(S.book.anchorPeriod).toBe('202601');

  // 加入成员：账号 D。
  await apiOk(page, 'POST', `/reading-books/${S.book.id}/meters`, {
    waterAccountId: S.acctD.waterAccount.id,
    seqNo: 1,
  });

  // 非应抄期（锚 202601 → 202602 不在节奏上）：生成仍成功但出现 warning。
  await page.goto('/metering/plans');
  await ready(page);
  await page.getByRole('button', { name: '生成计划' }).click();
  const gDlg = page.getByRole('dialog', { name: '生成抄表计划' });
  await select(
    page,
    gDlg.getByText('搜索抄表册名称', { exact: true }),
    `${bookName}（${S.book.bookNo}）`,
  );
  // 月选择器：fill+Enter 偶发不提交，改为打开面板点单元格（当前年 2026 内）。
  await gDlg.getByPlaceholder('请选择月份').click();
  await page
    .locator('.ant-picker-dropdown:visible td[title="2026-02"]')
    .click();
  S.planOff = await response(page, '/reading-plans/generate', () =>
    button(gDlg, '生成').click(),
  );
  expect(S.planOff.cadenceWarning).toBe('BOOK_NOT_DUE_THIS_PERIOD');
  await expect(page.locator('.ant-message')).toContainText('不是计划抄表期');
  const planRow = row(page, bookName);
  await expect(planRow).toContainText('2026-02');
  await expect(planRow).toContainText('待开始');
  await evidence(page, info, 'S3-cadence-warning', {
    book: S.book.id,
    plan: S.planOff.id,
    warning: S.planOff.cadenceWarning,
  });
});

test('S4 NO_READ 预计用水量：不伪造表码 + 结算来源标识', async ({ page }, info) => {
  await login(page);
  // S3 已生成 202602 计划（成员为账号 D）。先插一条上期实读，
  // 让录入弹窗能算出参考模拟表码（100 + 30 = 130）。
  await trustedReading(S.acctD, '202601', '100');
  await page.goto('/metering/plans');
  await ready(page);
  const planRow = row(page, S.bookName);
  await button(planRow, '明细').click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toContainText('待抄');

  // 明细行 → 录入 → 未抄见 + 锁闭原因 + 预计用水量 30。
  const itemRow = drawer
    .getByRole('row')
    .filter({ hasText: S.acctD.waterAccount.accountNo });
  await button(itemRow, '录入').click();
  const eDlg = page.getByRole('dialog', { name: /抄表录入/ });
  await eDlg.locator('.ant-radio-button-wrapper').filter({ hasText: '未抄见' }).click();
  await select(
    page,
    eDlg.locator('.ant-form-item').filter({ hasText: '未抄见原因' }).locator('.ant-select'),
    '锁闭无法入户',
  );
  await eDlg.getByLabel('预计用水量（估水，可空）', { exact: true }).fill('30');
  // 关键区分：表码是「未抄见」，30 是预计用量；模拟表码仅核对参考。
  await expect(eDlg).toContainText('表码：未抄见（不产生真实表码记录）');
  await expect(eDlg).toContainText('预计用量：30 m³');
  await expect(eDlg).toContainText('参考模拟表码：130'); // 100 + 30
  await expect(eDlg).toContainText('不写入系统');
  S.reading = await response(page, '/meter-readings', () =>
    button(eDlg, '提交').click(),
  );
  expect(S.reading.resultType).toBe('NO_READ');
  expect(S.reading.readingValue).toBeNull();
  expect(String(S.reading.estimateQty)).toBe('30');
  await expect(itemRow).toContainText('未抄见');

  // 结算：不传 usageQty —— 抄表员估数优先于 AVG3。
  const settle = await apiOk(page, 'POST', '/consumption-settlements', {
    waterAccountId: S.acctD.waterAccount.id,
    period: '202602',
    estimateReason: '锁闭未抄见，抄表员现场估计',
  });
  expect(settle.isEstimated).toBe(true);
  expect(settle.estimateMethod).toBe('MANUAL');
  expect(Number(settle.totalUsageQty)).toBe(30);
  const estComponent = settle.components.find((c: any) => c.sourceReadingId);
  expect(estComponent).toBeTruthy();

  // UI：结算详情 —— 预估方式=抄表员预计用量，分量来源=抄表员估水。
  await page.goto('/settlement/list');
  await ready(page);
  // 级联过滤定位本账号 —— 列表按账期排序，重跑累积的数据会把本期挤出首页。
  await main(page).locator('.ant-select').filter({ hasText: '按客户过滤' }).click();
  await page.keyboard.type(`UAT抄表-${stamp}`);
  await page
    .locator('.ant-select-dropdown:visible')
    .getByText(`UAT抄表-${stamp}（`, { exact: false })
    .first()
    .click();
  await main(page).locator('.ant-select').filter({ hasText: '按水表户过滤' }).click();
  await page
    .locator('.ant-select-dropdown:visible')
    .getByText(S.acctD.waterAccount.accountNo, { exact: false })
    .first()
    .click();
  const sRow = row(page, S.acctD.waterAccount.accountNo).filter({ hasText: '2026-02' });
  await button(sRow, '详情').click();
  const sDlg = page.getByRole('dialog');
  await expect(sDlg).toContainText('抄表员预计用量');
  await expect(sDlg.getByRole('row').filter({ hasText: '抄表员估水' })).toHaveCount(1);
  S.settleEst = settle;
  await evidence(page, info, 'S4-no-read-estimate', {
    reading: S.reading.id,
    settlement: settle.id,
  });
});

test('S5 补差业务化表达：冲减调账单可读文案', async ({ page }, info) => {
  await login(page);
  // 场景（API 造数，UI 只验文案）：
  //   202607 实读 100（可信锚点）
  //   202608 估水结算 25 → 终审 → 开账（POSTED）
  //   202609 恢复实读 130 → 区间真实用量 30 > 已结算 25 → 补收 +5
  const C = await apiOk(page, 'POST', '/water-accounts/onboard', {
    customer: { name: `UAT补差-${stamp}`, custType: 'PERSONAL' },
    account: {
      usageCategory: 'RES_METERED',
      addr: `UAT补差地址-${stamp}`,
      openedAt: '2026-06-01',
      accountNo: `V02C${stamp}`.slice(0, 20),
    },
    meter: { brand: 'UAT' },
    installation: { initialReading: '0', installedAt: '2026-06-01' },
  });
  await trustedReading(C, '202607', '100');
  const est = await apiOk(page, 'POST', '/consumption-settlements', {
    waterAccountId: C.waterAccount.id,
    period: '202608',
    usageQty: '25',
    estimateReason: '表污，人工核定25',
  });
  await finalizeAndBill(page, est.id, '202608');
  await trustedReading(C, '202609', '130');
  const recon = await apiOk(page, 'POST', '/reconciliations', {
    waterAccountId: C.waterAccount.id,
  });
  expect(recon.status).toBe('APPLIED');
  expect(String(recon.remainderUsage)).toBe('5');

  // UI：列表业务化状态 + 详情「业务含义」白话解释。
  await page.goto('/settlement/reconciliations');
  await ready(page);
  const rRow = row(page, C.waterAccount.accountNo);
  await expect(rRow).toContainText('已调账');
  await expect(rRow).toContainText('补收 ¥15.00');
  await button(rRow, '详情').click();
  const rDlg = page.getByRole('dialog');
  await expect(rDlg).toContainText('业务含义');
  await expect(rDlg).toContainText('补收');
  await expect(rDlg).toContainText('调账单');
  await expect(rDlg).toContainText('+5 m³');
  await evidence(page, info, 'S5-reconciliation', {
    reconciliation: recon.id,
    status: recon.status,
    remainder: recon.remainderUsage,
    adjustment: recon.adjustmentAmountCent,
  });
});
