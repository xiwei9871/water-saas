import type {
  ExceptionCode,
  PlanItemStatus,
  PlanStatus,
  QcStatus,
  ReadResultType,
  ReadSource,
} from '../../api/types';

/** 抄表域共享的枚举中文标签 / 颜色。 */

export const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
  OPEN: '待开始',
  IN_PROGRESS: '进行中',
  DONE: '已完成',
  CLOSED: '已关闭',
};

export const PLAN_STATUS_COLORS: Record<PlanStatus, string> = {
  OPEN: 'blue',
  IN_PROGRESS: 'processing',
  DONE: 'green',
  CLOSED: 'default',
};

export const PLAN_ITEM_STATUS_LABELS: Record<PlanItemStatus, string> = {
  PENDING: '待抄',
  READ: '已抄',
  NO_READ: '未抄见',
  SKIPPED: '已跳过',
};

export const PLAN_ITEM_STATUS_COLORS: Record<PlanItemStatus, string> = {
  PENDING: 'blue',
  READ: 'green',
  NO_READ: 'orange',
  SKIPPED: 'default',
};

export const RESULT_TYPE_LABELS: Record<ReadResultType, string> = {
  ACTUAL: '实抄',
  REMOTE: '远传',
  NO_READ: '未抄见',
};

export const RESULT_TYPE_COLORS: Record<ReadResultType, string> = {
  ACTUAL: 'green',
  REMOTE: 'blue',
  NO_READ: 'orange',
};

export const EXCEPTION_CODE_LABELS: Record<ExceptionCode, string> = {
  LOCKED: '锁闭无法入户',
  DIAL_DIRTY: '表盘污损',
  FLOODED: '表井积水',
  OCCUPIED: '占压无法查看',
  STOPPED: '表停',
  BROKEN: '表坏',
  SUSPECTED_THEFT: '疑似窃水',
  OTHER: '其他',
};

export const QC_STATUS_LABELS: Record<QcStatus, string> = {
  PENDING: '待质检',
  PASSED: '质检通过',
  REJECTED: '质检驳回',
  MANUAL_REVIEW: '人工复核',
};

export const QC_STATUS_COLORS: Record<QcStatus, string> = {
  PENDING: 'blue',
  PASSED: 'green',
  REJECTED: 'red',
  MANUAL_REVIEW: 'orange',
};

export const READ_SOURCE_LABELS: Record<ReadSource, string> = {
  WEB: '网页录入',
  IMPORT: '批量导入',
  APP: '移动App',
  REMOTE: '远传',
};
