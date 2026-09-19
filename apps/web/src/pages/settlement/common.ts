import type {
  ComponentSourceType,
  EstimateMethod,
  ReconStatus,
  SettlementStatus,
} from '../../api/types';

/** 结算/补差域共享的枚举中文标签 / 颜色。 */

export const SETTLEMENT_STATUS_LABELS: Record<SettlementStatus, string> = {
  DRAFT: '草稿',
  FINAL: '已终审',
};

export const SETTLEMENT_STATUS_COLORS: Record<SettlementStatus, string> = {
  DRAFT: 'blue',
  FINAL: 'green',
};

export const COMPONENT_SOURCE_LABELS: Record<ComponentSourceType, string> = {
  READING: '实读',
  ESTIMATE: '预估',
  MANUAL: '人工',
};

export const COMPONENT_SOURCE_COLORS: Record<ComponentSourceType, string> = {
  READING: 'green',
  ESTIMATE: 'orange',
  MANUAL: 'blue',
};

export const ESTIMATE_METHOD_LABELS: Record<EstimateMethod, string> = {
  AUTO_AVG3: '近三月均量',
  MANUAL: '人工指定',
};

export const RECON_STATUS_LABELS: Record<ReconStatus, string> = {
  DRAFT: '草稿',
  ABSORBED: '已吸收',
  APPLIED: '已调账',
  MANUAL_REVIEW: '待人工',
};

export const RECON_STATUS_COLORS: Record<ReconStatus, string> = {
  DRAFT: 'blue',
  ABSORBED: 'cyan',
  APPLIED: 'green',
  MANUAL_REVIEW: 'orange',
};
