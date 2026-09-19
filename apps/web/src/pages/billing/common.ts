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
