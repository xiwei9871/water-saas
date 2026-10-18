/**
 * 全局数值格式化（2026-10-16 界面与数值规范化修订意见 §五）。
 * 全系统唯一的数值展示口径：金额分转元、万/亿中文缩写、千分位兜底、
 * 整组自适应单位。卡片/图表轴/表格/tooltip 一律走这里，禁止各写一套。
 */

/** 完整值：千分位（万/亿缩写场景下用于悬停/tooltip 兜底）。 */
export const fmtFull = (
  v: number | string | null | undefined,
  digits = 2,
): string =>
  v === null || v === undefined || v === ''
    ? '—'
    : Number(v).toLocaleString('zh-CN', {
        minimumFractionDigits: 0,
        maximumFractionDigits: digits,
      });

/**
 * 金额：分 → 元。`¥` + 千分位 + 两位小数。
 * 入参为 bigint 序列化后的 string 或 number（分）。
 */
export const fmtMoney = (
  cents: number | string | null | undefined,
): string =>
  cents === null || cents === undefined || cents === ''
    ? '—'
    : `¥${fmtFull(Number(cents) / 100)}`;

/**
 * 大数值中文四进位缩写（N5）：
 *   < 1 万 → 原值（digits 位小数，默认 0）
 *   ≥ 1 万 → x.xx 万；≥ 1 亿 → x.xx 亿（1–2 位小数）。
 * 输出纯「数值+中文单位」串，如 `1.29万`、`1.29亿`；无 K/M/B。
 */
export const abbrevCN = (
  v: number | null | undefined,
  digits = 0,
): string => {
  if (v === null || v === undefined) return '—';
  const a = Math.abs(v);
  const trim = (n: number) =>
    n.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  if (a >= 1e8) return `${trim(v / 1e8)}亿`;
  if (a >= 1e4) return `${trim(v / 1e4)}万`;
  return v.toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
};

/**
 * 逐值自适应缩写（KPI 卡片等单点速览）——数值 + 单位分离返回，
 * 便于把单位字号缩小的同时把全值挂到 Tooltip。
 */
export const abbrevParts = (
  v: number | null | undefined,
): { text: string; unit: string; full: string } => {
  if (v === null || v === undefined) return { text: '—', unit: '', full: '—' };
  const full = fmtFull(v);
  const a = Math.abs(v);
  if (a >= 1e8) return { text: fmtFull(v / 1e8), unit: '亿', full };
  if (a >= 1e4) return { text: fmtFull(v / 1e4), unit: '万', full };
  return { text: full, unit: '', full };
};

/**
 * 整组自适应（N6）：以组内最大绝对值定统一单位，返回该组共用的
 * 换算系数与单位标签。同一列 / 同一轴 / 同一表必须统一单位。
 */
export const groupScale = (
  values: (number | null | undefined)[],
): { divisor: number; suffix: string } => {
  const max = Math.max(
    0,
    ...values.map((v) => Math.abs(Number(v ?? 0))).filter(Number.isFinite),
  );
  if (max >= 1e8) return { divisor: 1e8, suffix: '亿' };
  if (max >= 1e4) return { divisor: 1e4, suffix: '万' };
  return { divisor: 1, suffix: '' };
};

/**
 * 图表轴格式化：整轴按最大值统一单位。
 * 返回 { tick(v) 轴刻度文案, unitLabel 轴标题单位标注, tooltip(v) 完整值 }。
 */
export const axisFormat = (
  values: (number | null | undefined)[],
  baseUnit = '',
): {
  tick: (v: number) => string;
  unitLabel: string;
  tooltip: (v: number | null | undefined) => string;
} => {
  const { divisor, suffix } = groupScale(values);
  const unitLabel = suffix + baseUnit;
  return {
    tick: (v) => fmtFull(v / divisor, divisor === 1 ? 0 : 1),
    unitLabel,
    tooltip: (v) =>
      v === null || v === undefined ? '—' : `${fmtFull(v)}${baseUnit}`,
  };
};

/**
 * 报表/查询表格整列统一单位（N6）：按列最大值选 元/万元/亿元，
 * 返回 { divisor（对元值）, label 表头单位标注, cell(v) }。
 * 入参为元值数组（已是元的数），金额分场景先自行 /100。
 */
export const columnScale = (
  values: (number | null | undefined)[],
  baseUnit = '元',
): { divisor: number; label: string; cell: (v: number | null | undefined) => string } => {
  const { divisor, suffix } = groupScale(values);
  const label = `${suffix}${baseUnit}`;
  return {
    divisor,
    label,
    cell: (v) =>
      v === null || v === undefined ? '—' : fmtFull(v / divisor),
  };
};

/** 百分比：+/- 号 + 两位小数（驾驶舱环比/同比徽标同口径）。 */
export const fmtPct = (v: number | null | undefined): string =>
  v === null || v === undefined ? '—' : `${v.toFixed(2)}%`;

export const fmtSignedPct = (v: number | null | undefined): string =>
  v === null || v === undefined
    ? '—'
    : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
