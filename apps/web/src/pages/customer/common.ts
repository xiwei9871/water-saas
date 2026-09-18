import dayjs from 'dayjs';
import type {
  AccountStatus,
  CustType,
  InstallReason,
  InstallationStatus,
  MeterStatus,
} from '../../api/types';

/** 客户域共享的枚举中文标签 / 颜色 / 小工具。 */

export const CUST_TYPE_LABELS: Record<CustType, string> = {
  PERSONAL: '个人',
  ORG: '单位',
};

export const ACCOUNT_STATUS_LABELS: Record<AccountStatus, string> = {
  NORMAL: '正常',
  SUSPENDED: '暂停',
  CLOSED: '销户',
};

export const ACCOUNT_STATUS_COLORS: Record<AccountStatus, string> = {
  NORMAL: 'green',
  SUSPENDED: 'orange',
  CLOSED: 'default',
};

export const METER_STATUS_LABELS: Record<MeterStatus, string> = {
  AVAILABLE: '可用',
  INSTALLED: '已安装',
  MAINTENANCE: '维修中',
  RETIRED: '已报废',
};

export const METER_STATUS_COLORS: Record<MeterStatus, string> = {
  AVAILABLE: 'green',
  INSTALLED: 'blue',
  MAINTENANCE: 'orange',
  RETIRED: 'default',
};

export const INSTALLATION_STATUS_LABELS: Record<InstallationStatus, string> = {
  ACTIVE: '在用',
  REMOVED: '已拆除',
};

export const INSTALLATION_STATUS_COLORS: Record<InstallationStatus, string> = {
  ACTIVE: 'green',
  REMOVED: 'default',
};

export const INSTALL_REASON_LABELS: Record<InstallReason, string> = {
  NEW: '新装',
  REPLACE: '换表',
  FAULT: '故障',
  PERIODIC_CHECK: '周期检定',
};

export const fmtTime = (iso: string) => dayjs(iso).format('YYYY-MM-DD HH:mm:ss');

export const fmtDate = (iso?: string | null) =>
  iso ? dayjs(iso).format('YYYY-MM-DD') : '—';

/** 水表读数等非负 Decimal 输入的表单校验（最多 4 位小数）。 */
export const DECIMAL_RULE = {
  pattern: /^\d+(\.\d{1,4})?$/,
  message: '请输入非负数值（最多 4 位小数）',
};

/**
 * Idempotency-Key for POST mutations — one uuid per form-open / wizard-mount.
 * Retried submits reuse the same key so a double-click can't double-apply;
 * the server rolls the key row back on failure so edit-then-retry still works.
 */
export const newIdemKey = (): string => crypto.randomUUID();

/** Strip empty-string/undefined fields so POST bodies stay clean. */
export const cleanBody = <T extends Record<string, unknown>>(body: T): T => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || (typeof v === 'string' && v.trim() === '')) continue;
    out[k] = typeof v === 'string' ? v.trim() : v;
  }
  return out as T;
};
