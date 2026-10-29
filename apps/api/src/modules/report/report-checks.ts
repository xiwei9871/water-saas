import { Prisma } from '@prisma/client';

/**
 * 报表数据准确性自检（20261028《报表数据准确性自检提示方案 v3》）。
 *
 * 13 条规则分五维：勾稽（等式平衡）/ 合理性 / 一致性 / 完整性 / 异常值。
 * 报表接口把结果挂在 `checkResults` 上——每条给出 rule/level/passed/
 * actual/expected/diff/message，前端据此渲染徽章与明细抽屉，管理人员
 * 只看结论，不再自己推公式。
 *
 * level 语义（文档「分级」）：BLOCK=阻断（等式不平、数据缺失、越界），
 * WARN=警告（可能异常需复核）。passed=false 的项即异常项。
 * 金额类容差 ±0.01 元；比率类 ±0.1%；偏离类阈值走租户参数。
 */

export interface CheckResult {
  /** 规则编号 R1..R13 */
  rule: string;
  /** 规则中文名 */
  name: string;
  /** 级别：BLOCK=阻断，WARN=警告（PASS 不单独标级，渲染时归绿） */
  level: 'BLOCK' | 'WARN';
  passed: boolean;
  /** 实际值（已格式化的展示串；明细抽屉原样显示） */
  actual: string | null;
  /** 期望值 */
  expected: string | null;
  /** 差额 Δ */
  diff: string | null;
  /** 提示语（按文档「异常提示语」模板生成） */
  message: string;
  /** 前端定位锚：报表区块 key（可选） */
  target?: string;
}

export interface CheckThresholds {
  /** R4 综合单价偏离阈值 %（默认 20） */
  priceDeviationPct: number;
  /** R6 营收同比/环比阈值 %（默认 30） */
  revenueChangePct: number;
  /** R8 欠费率上限 %（默认 30） */
  arrearsRateMax: number;
  /** R7 估抄率警告线 %（默认 20） */
  estRateMax: number;
  /** R12 单户用量异常倍数（默认 3） */
  usageAnomalyX: number;
  /** R13 单笔大额阈值，元（默认 100000） */
  bigPayment: number;
}

const THRESHOLD_KEYS = {
  'report.check.priceDeviationPct': 'priceDeviationPct',
  'report.check.revenueChangePct': 'revenueChangePct',
  'report.check.arrearsRateMax': 'arrearsRateMax',
  'report.check.estRateMax': 'estRateMax',
  'report.check.usageAnomalyX': 'usageAnomalyX',
  'report.check.bigPayment': 'bigPayment',
} as const;

const DEFAULT_THRESHOLDS: CheckThresholds = {
  priceDeviationPct: 20,
  revenueChangePct: 30,
  arrearsRateMax: 30,
  estRateMax: 20,
  usageAnomalyX: 3,
  bigPayment: 100000,
};

/** 阈值参数 —— 与 tenant_param（iam/tenant-params）打通，未配置取默认。 */
export async function loadCheckThresholds(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<CheckThresholds> {
  const rows = await tx.tenantParam.findMany({
    where: { tenantId, key: { in: Object.keys(THRESHOLD_KEYS) } },
    select: { key: true, value: true },
  });
  const t = { ...DEFAULT_THRESHOLDS };
  for (const r of rows) {
    const field = THRESHOLD_KEYS[r.key as keyof typeof THRESHOLD_KEYS];
    const v = Number(r.value);
    if (field && Number.isFinite(v) && v > 0) t[field] = v;
  }
  return t;
}

const f2 = (v: number) =>
  v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (cents: number | bigint) => f2(Number(cents) / 100);

const mk = (
  rule: string,
  name: string,
  level: 'BLOCK' | 'WARN',
  passed: boolean,
  actual: string | null,
  expected: string | null,
  diff: string | null,
  message: string,
  target?: string,
): CheckResult => ({ rule, name, level, passed, actual, expected, diff, message, target });

/** 金额等式类：actual vs expected，|diff| ≤ 0.01 元。 */
const moneyEq = (
  rule: string,
  name: string,
  level: 'BLOCK' | 'WARN',
  actual: number,
  expected: number,
  msgFail: (d: number) => string,
  target?: string,
): CheckResult => {
  const d = (actual - expected) / 100; // 分→元
  const passed = Math.abs(d) <= 0.01;
  return mk(
    rule, name, level, passed,
    money(actual), money(expected), `${d >= 0 ? '+' : ''}${f2(d)}`,
    passed ? '等式成立' : msgFail(d),
    target,
  );
};

/** 比率区间类：value ∈ [0, max]（null → 跳过通过）。 */
const rateCheck = (
  rule: string,
  name: string,
  level: 'BLOCK' | 'WARN',
  value: number | null,
  max: number,
  msgFail: string,
  target?: string,
): CheckResult => {
  const passed = value === null || (value >= -0.1 && value <= max + 0.1);
  return mk(
    rule, name, level, passed,
    value === null ? '—' : `${f2(value)}%`, `0 ~ ${f2(max)}%`,
    value === null ? null : `${f2(value - max)}%`,
    passed ? '在合理区间' : msgFail,
    target,
  );
};

/** 偏离类：|value| ≤ max（null → 通过）。 */
const devCheck = (
  rule: string,
  name: string,
  value: number | null,
  max: number,
  msgFail: string,
  target?: string,
): CheckResult =>
  mk(
    rule, name, 'WARN',
    value === null || Math.abs(value) <= max + 0.1,
    value === null ? '—' : `${value >= 0 ? '+' : ''}${f2(value)}%`,
    `±${f2(max)}%`,
    value === null ? null : `${f2(Math.abs(value) - max)}%`,
    value === null || Math.abs(value) <= max + 0.1 ? '在合理区间' : msgFail,
    target,
  );

// ------------------------------------------------------------------
// 月报 R1~R13（输入：窗口指标已折算为「分/户数/百分比」的中间件值）
// ------------------------------------------------------------------
export interface MonthlyCheckInput {
  // 本期（元→分）
  arAmount: number; // 本期应收（分）
  collected: number; // 本期实收（分）
  currentCollected: number; // 当期实收（分）
  arrearsCollected: number; // 陈欠收取（分）
  /** 窗口期账单在期末前的全部销账（分，含期前提前收款）——R1 专用 */
  windowPaid: number;
  arrearsTotal: number; // 期末欠费（分）
  arrearsStart: number; // 期初欠费（分）
  recoveryRate: number | null; // %
  compositePrice: number | null; // 元/m³
  compositePricePrev: number | null; // 上年同期综合单价
  arYoy: number | null; // 应收同比 %
  arMom: number | null; // 应收环比 %
  readAcc: number | null;
  readCov: number | null;
  estRate: number | null;
  readTimely: number | null;
  accountCount: number; // 期末在册
  openingAccounts: number; // 期初在册
  openedCount: number;
  closedCount: number;
  planRead: number;
  planTotal: number;
  missingBills: number; // 已结算未出账条数（完整性）
  usageAnomalies: string[]; // R12 异常户号清单（已截断）
  bigPayments: string[]; // R13 大额收款摘要（已截断）
}

export function buildMonthlyChecks(
  i: MonthlyCheckInput,
  t: CheckThresholds,
): CheckResult[] {
  const out: CheckResult[] = [];

  // R1 资金存量滚动（勾稽·阻断）——1029 G1：「本期实收」对窗口期
  // 账单按销账口径计（windowPaid 含期前提前收款，如 9 月末收款付
  // 10 月单），陈欠回收仍按窗口内收款计；未分摊收款（预存入金/
  // 在途款）不减欠费，其组成由 R2 单独校验。
  const applied = i.windowPaid + i.arrearsCollected;
  out.push(moneyEq('R1', '资金存量滚动：期末欠费＝期初欠费＋本期应收−本期实收',
    'BLOCK', i.arrearsTotal, i.arrearsStart + i.arAmount - applied,
    (d) => `期初欠费 ${money(i.arrearsStart)} + 本期应收 ${money(i.arAmount)} − 本期销账 ${money(applied)}（含提前收款 ${money(Math.max(0, i.windowPaid - i.currentCollected))} + 陈欠回收 ${money(i.arrearsCollected)}）= 应期末欠费 ${money(i.arrearsStart + i.arAmount - applied)}，报表为 ${money(i.arrearsTotal)}，差额 ${f2(d)} 元，请核查数据来源（欠费计算/收款分摊/某月遗漏重复）。`,
    'arrears'));

  // R2 实收构成（勾稽·阻断）
  out.push(moneyEq('R2', '实收构成：实收水费＝当期实收＋陈欠回收',
    'BLOCK', i.collected, i.currentCollected + i.arrearsCollected,
    (d) => `当期实收 ${money(i.currentCollected)} + 陈欠回收 ${money(i.arrearsCollected)} = ${money(i.currentCollected + i.arrearsCollected)}，实收列示 ${money(i.collected)}，差额 ${f2(d)} 元，请核查收款分摊口径。`,
    'collected'));

  // R3 回收率区间（合理性·阻断；复用既有 RECOVERY_RATE_ANOMALY 口径）
  out.push(rateCheck('R3', '回收率区间：水费回收率 ∈ [0,100%]',
    'BLOCK', i.recoveryRate, 100,
    `水费回收率 ${i.recoveryRate === null ? '—' : f2(i.recoveryRate) + '%'} 超出 [0,100%]，请关注异常计费、抄表或收费。`,
    'recovery'));

  // R4 综合单价区间（合理性·警告）
  {
    const v = i.compositePrice;
    const p = i.compositePricePrev;
    const dev = v !== null && p !== null && p !== 0 ? ((v - p) / Math.abs(p)) * 100 : null;
    const bad = v !== null && (v < 0 || (dev !== null && Math.abs(dev) > t.priceDeviationPct + 0.1));
    out.push(mk('R4', '综合单价区间：单价≥0 且较去年同期偏离 ≤±20%（可配）',
      'WARN', !bad,
      v === null ? '—' : `${f2(v)} 元/m³`,
      dev === null ? '≥0' : `偏离≤±${f2(t.priceDeviationPct)}%（实偏 ${dev >= 0 ? '+' : ''}${f2(dev)}%）`,
      dev === null ? null : `${f2(Math.abs(dev) - t.priceDeviationPct)}%`,
      bad ? `综合单价 ${v === null ? '—' : f2(v) + ' 元/m³'} 超出常规区间（去年同期 ${p === null ? '—' : f2(p)}），请关注价格调整或数据错误。` : '在合理区间',
      'price'));
  }

  // R6 同比/环比偏离（一致性·警告，应收口径）
  out.push(devCheck('R6a', '营收同比偏离（应收）', i.arYoy, t.revenueChangePct,
    `营收同比 ${i.arYoy === null ? '—' : f2(i.arYoy) + '%'} 超出常规区间，请关注新增/退出大户、价格调整或数据错误。`,
    'ar'));
  out.push(devCheck('R6b', '营收环比偏离（应收）', i.arMom, t.revenueChangePct,
    `营收环比 ${i.arMom === null ? '—' : f2(i.arMom) + '%'} 超出常规区间，请关注新增/退出大户、价格调整或数据错误。`,
    'ar'));

  // R7 抄表质量指标区间（合理性·警告）
  const r7bad: string[] = [];
  for (const [label, v] of [
    ['抄表准确率', i.readAcc],
    ['抄见率', i.readCov],
    ['抄表及时率', i.readTimely],
  ] as const) {
    if (v !== null && (v < -0.1 || v > 100.1)) r7bad.push(`${label} ${f2(v)}%`);
  }
  const estOver = i.estRate !== null && i.estRate > t.estRateMax;
  out.push(mk('R7', '抄表质量区间：四率∈[0,100%] 且估抄率≤警告线',
    'WARN', r7bad.length === 0 && !estOver,
    `估抄率 ${i.estRate === null ? '—' : f2(i.estRate) + '%'}`,
    `≤${f2(t.estRateMax)}%`,
    estOver && i.estRate !== null ? `+${f2(i.estRate - t.estRateMax)}%` : null,
    r7bad.length ? `指标越界：${r7bad.join('、')}，请关注异常抄表数据。`
      : estOver ? `估抄率 ${f2(i.estRate!)}% 超过警告线 ${f2(t.estRateMax)}%，请关注估抄集中区域。`
      : '在合理区间',
    'reading'));

  // R8 欠费率区间（合理性·警告）
  const arRate = i.arAmount > 0 ? (i.arrearsTotal / i.arAmount) * 100 : (i.arrearsTotal > 0 ? 100 : 0);
  out.push(rateCheck('R8', '欠费率区间：期末欠费余额÷本期应收 ∈ 合理区间（可配）',
    'WARN', arRate, t.arrearsRateMax,
    `欠费率 ${f2(arRate)}%（欠费 ${money(i.arrearsTotal)} ÷ 应收 ${money(i.arAmount)}）超出 0~${f2(t.arrearsRateMax)}%，请关注欠费收缴。`,
    'arrears'));

  // R9 完整性（阻断）：已结算未出账 = 遗漏户
  out.push(mk('R9', '各期数据齐全：已结算户应全部出账（无遗漏户）',
    'BLOCK', i.missingBills === 0,
    `${i.missingBills} 户`, '0 户', `${i.missingBills}`,
    i.missingBills === 0 ? '数据完整' : `存在 ${i.missingBills} 户已结算未出账，数据不完整，请补开账单后再报。`,
    'billing'));

  // R10 抄表完成度（完整性·警告）
  {
    const un = i.planTotal - i.planRead;
    out.push(mk('R10', '抄表完成度：已抄户数÷应抄户数＝100%',
      'WARN', i.planTotal === 0 || un <= 0,
      i.planTotal === 0 ? '—' : `${i.planRead}/${i.planTotal}`,
      '100%',
      i.planTotal === 0 ? null : `${un}`,
      i.planTotal === 0 ? '本期无抄表计划' : un > 0 ? `尚有 ${un} 户未抄，请补录后再报。` : '全部抄完',
      'reading'));
  }

  // R11 户数滚动（勾稽·阻断）
  {
    const expected = i.openingAccounts + i.openedCount - i.closedCount;
    const d = i.accountCount - expected;
    out.push(mk('R11', '户数滚动：期末在册＝期初＋新增−销户',
      'BLOCK', d === 0,
      `${i.accountCount} 户`, `${expected} 户`, `${d >= 0 ? '+' : ''}${d}`,
      d === 0 ? '等式成立' : `期初 ${i.openingAccounts} + 新增 ${i.openedCount} − 销户 ${i.closedCount} = ${expected}，报表 ${i.accountCount}，差 ${d} 户，请核查立户/销户登记。`,
      'accounts'));
  }

  // R12 单户用量异常（异常值·警告）
  out.push(mk('R12', `单户用量异常：较近 3 期均值偏离超 ${t.usageAnomalyX} 倍`,
    'WARN', i.usageAnomalies.length === 0,
    `${i.usageAnomalies.length} 户`, '0 户', null,
    i.usageAnomalies.length === 0 ? '无异常户'
      : `识别到 ${i.usageAnomalies.length} 户用量异常（${i.usageAnomalies.slice(0, 10).join('、')}${i.usageAnomalies.length > 10 ? ' 等' : ''}），请逐笔核实。`,
    'usage'));

  // R13 大额异常（异常值·警告）
  out.push(mk('R13', `大额异常：单笔收款超 ${f2(t.bigPayment)} 元`,
    'WARN', i.bigPayments.length === 0,
    `${i.bigPayments.length} 笔`, '0 笔', null,
    i.bigPayments.length === 0 ? '无大额记录'
      : `识别到 ${i.bigPayments.length} 笔大额收款（${i.bigPayments.slice(0, 5).join('、')}${i.bigPayments.length > 5 ? ' 等' : ''}），请逐笔核实。`,
    'payment'));

  return out;
}

// ------------------------------------------------------------------
// 年报 R1~R13（R5 年度=月度合计、R9 缺失月 为年报专属）
// ------------------------------------------------------------------
export interface YearlyCheckInput extends Omit<MonthlyCheckInput, 'arMom' | 'missingBills'> {
  /** R5：年度窗口值 vs Σ各月（分/m³） */
  yearVsMonthSum: { label: string; year: number; months: number; isMoney?: boolean }[];
  /** R9：缺失月清单（无任何业务活动的月份） */
  missingMonths: string[];
}

export function buildYearlyChecks(
  i: YearlyCheckInput,
  t: CheckThresholds,
): CheckResult[] {
  const base = buildMonthlyChecks({ ...i, arMom: null, missingBills: 0 }, t)
    .filter((c) => c.rule !== 'R9' && c.rule !== 'R6b');
  const out = [...base];

  // R5 年度 = 月度合计（勾稽·阻断）
  for (const m of i.yearVsMonthSum) {
    const d = m.isMoney === false ? m.year - m.months : (m.year - m.months) / 100;
    const tol = m.isMoney === false ? 0.01 : 0.01;
    const passed = Math.abs(d) <= tol;
    const fmt = (v: number) => (m.isMoney === false ? f2(v) : money(v));
    out.push(mk('R5', `年度＝月度合计：${m.label}`,
      'BLOCK', passed,
      fmt(m.year), fmt(m.months), `${d >= 0 ? '+' : ''}${f2(d)}`,
      passed ? '等式成立' : `年报 ${m.label} ${fmt(m.year)} ≠ Σ各月 ${fmt(m.months)}，差额 ${f2(d)}，请核查某月遗漏或重复统计。`,
      'yearly'));
  }

  // R9 完整性（阻断）：缺失月
  out.push(mk('R9', '各期数据齐全：12 个月月报无缺失月',
    'BLOCK', i.missingMonths.length === 0,
    i.missingMonths.length === 0 ? '12 月齐全' : `缺失 ${i.missingMonths.length} 月`,
    '12 月齐全', `${i.missingMonths.length}`,
    i.missingMonths.length === 0 ? '数据完整'
      : `存在缺失月（${i.missingMonths.join('、')}），数据不完整，请补录后再报。`,
    'yearly'));

  return out;
}

// ------------------------------------------------------------------
// 日报子集：R2 实收构成 / R10 当日抄表进度 / R13 当日大额
// ------------------------------------------------------------------
export interface DailyCheckInput {
  collected: number; // 当日实收（分）
  currentCollected: number;
  arrearsCollected: number;
  planRead: number;
  planTotal: number;
  bigPayments: string[];
}

export function buildDailyChecks(
  i: DailyCheckInput,
  t: CheckThresholds,
): CheckResult[] {
  const out: CheckResult[] = [];
  out.push(moneyEq('R2', '实收构成：当日实收＝当期实收＋陈欠回收',
    'BLOCK', i.collected, i.currentCollected + i.arrearsCollected,
    (d) => `当期实收 ${money(i.currentCollected)} + 陈欠回收 ${money(i.arrearsCollected)} = ${money(i.currentCollected + i.arrearsCollected)}，实收列示 ${money(i.collected)}，差额 ${f2(d)} 元，请核查收款分摊。`,
    'collected'));
  const un = i.planTotal - i.planRead;
  out.push(mk('R10', '抄表完成度：当日计划已抄÷应抄',
    'WARN', i.planTotal === 0 || un <= 0,
    i.planTotal === 0 ? '—' : `${i.planRead}/${i.planTotal}`,
    '100%', i.planTotal === 0 ? null : `${un}`,
    i.planTotal === 0 ? '当日无抄表计划' : un > 0 ? `尚有 ${un} 户未抄，请跟进。` : '全部抄完',
    'reading'));
  out.push(mk('R13', `大额异常：单笔收款超 ${f2(t.bigPayment)} 元`,
    'WARN', i.bigPayments.length === 0,
    `${i.bigPayments.length} 笔`, '0 笔', null,
    i.bigPayments.length === 0 ? '无大额记录'
      : `识别到 ${i.bigPayments.length} 笔大额收款（${i.bigPayments.slice(0, 5).join('、')}${i.bigPayments.length > 5 ? ' 等' : ''}），请逐笔核实。`,
    'payment'));
  return out;
}

/** 导出附注行（xlsx 表头/尾部）：自检结论 + 异常项清单。 */
export function checkSummaryLines(results: CheckResult[]): string[] {
  const blocks = results.filter((r) => !r.passed && r.level === 'BLOCK');
  const warns = results.filter((r) => !r.passed && r.level === 'WARN');
  const verdict =
    blocks.length > 0 ? `✗ ${blocks.length} 项阻断性异常` :
    warns.length > 0 ? `⚠ ${warns.length} 项警告` : '✓ 自检通过';
  const lines = [`数据自检结论：${verdict}（共 ${results.length} 项规则）`];
  for (const r of [...blocks, ...warns]) {
    lines.push(
      `　${r.level === 'BLOCK' ? '✗' : '⚠'} ${r.rule} ${r.name}：实际 ${r.actual ?? '—'} / 期望 ${r.expected ?? '—'}${r.diff ? ` / 差额 ${r.diff}` : ''}`,
    );
  }
  return lines;
}
