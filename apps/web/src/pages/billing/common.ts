import type {
  BillItemType,
  BillKind,
  BillSourceType,
  BillStatus,
  CalcType,
  RunStatus,
  RunType,
  TariffStatus,
} from '../../api/types';

/** 计费域共享的枚举中文标签 / 颜色（收费台/报表页同样复用）。 */

export const TARIFF_STATUS_LABELS: Record<TariffStatus, string> = {
  DRAFT: '草稿',
  ACTIVE: '生效中',
  RETIRED: '已停用',
};

export const TARIFF_STATUS_COLORS: Record<TariffStatus, string> = {
  DRAFT: 'blue',
  ACTIVE: 'green',
  RETIRED: 'default',
};

export const CALC_TYPE_LABELS: Record<CalcType, string> = {
  PER_QTY: '按量计价',
  FIXED: '定额',
  PERCENT: '比例',
};

export const RUN_TYPE_LABELS: Record<RunType, string> = {
  MANUAL: '手工',
  AUTO: '自动',
};

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  DRAFT: '草稿（试算）',
  PROCESSING: '执行中',
  PARTIAL: '部分成功',
  POSTED: '已过账',
  FAILED: '失败',
};

export const RUN_STATUS_COLORS: Record<RunStatus, string> = {
  DRAFT: 'blue',
  PROCESSING: 'processing',
  PARTIAL: 'orange',
  POSTED: 'green',
  FAILED: 'red',
};

export const BILL_KIND_LABELS: Record<BillKind, string> = {
  NORMAL: '正常账单',
  ADJUSTMENT: '调账单',
  REVERSAL: '红冲单',
  REPLACEMENT: '换票单',
};

export const BILL_KIND_COLORS: Record<BillKind, string> = {
  NORMAL: 'blue',
  ADJUSTMENT: 'orange',
  REVERSAL: 'red',
  REPLACEMENT: 'purple',
};

export const BILL_STATUS_LABELS: Record<BillStatus, string> = {
  DRAFT: '草稿',
  POSTED: '已出账',
  PARTIAL_PAID: '部分缴费',
  PAID: '已缴清',
  REVERSED: '已红冲',
};

export const BILL_STATUS_COLORS: Record<BillStatus, string> = {
  DRAFT: 'blue',
  POSTED: 'gold',
  PARTIAL_PAID: 'orange',
  PAID: 'green',
  REVERSED: 'default',
};

export const BILL_ITEM_TYPE_LABELS: Record<BillItemType, string> = {
  NORMAL: '正常',
  ADJUSTMENT: '调整',
  PENALTY: '违约金',
};

export const BILL_SOURCE_TYPE_LABELS: Record<BillSourceType, string> = {
  SETTLEMENT: '结算水量',
  RECONCILIATION: '补差',
  MANUAL: '手工',
  ORIGINAL_BILL: '原账单',
};

/**
 * bill_item.description 由计价引擎写成紧凑机读格式（`reconcile YYYYMM`
 * 会被年阶梯游标解析回去，存储格式不能动）——在展示层翻译成中文。
 */
export function describeBillItem(desc: string | null | undefined): string {
  if (!desc) return '—';
  let m = /^.+ tier (\d+): ([\d.]+) m³ @ ([\d.]+)$/.exec(desc);
  if (m) return `第 ${m[1]} 阶梯：${m[2]} m³ × ${m[3]} 元/m³`;
  m = /^.+ fixed @ ([\d.]+)$/.exec(desc);
  if (m) return `固定收费 ${m[1]} 元/期`;
  m = /^.+ ([\d.]+) × ([\d.]+)$/.exec(desc);
  if (m) return `按比例 ${m[1]} × 计费基数 ${m[2]} 元`;
  m = /^reconcile (\d{6})$/.exec(desc);
  if (m) return `补差调整（源账期 ${m[1].slice(0, 4)}-${m[1].slice(4)}）`;
  m = /^reversal of [^:]+: (.*)$/.exec(desc);
  if (m) return `红冲原单 —— ${describeBillItem(m[1])}`;
  return desc;
}
