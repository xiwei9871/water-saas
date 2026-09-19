import dayjs from 'dayjs';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type {
  AccountStatus,
  CustType,
  InstallReason,
  InstallationStatus,
  MeterStatus,
  WaterAccount,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';

/** 跨页面共享的枚举中文标签 / 颜色 / 小工具。 */

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

/** char(6) 账期 'YYYYMM' → 显示 'YYYY-MM'。 */
export const fmtPeriod = (p?: string | null) =>
  p && /^\d{6}$/.test(p) ? `${p.slice(0, 4)}-${p.slice(4)}` : (p ?? '—');

/** 金额分 → 元 显示（BigInt 列序列化为字符串）。 */
export const fmtCent = (v?: string | number | null) =>
  v === null || v === undefined ? '—' : `¥${(Number(v) / 100).toFixed(2)}`;

/** 水表读数等非负 Decimal 输入的表单校验（最多 4 位小数）。 */
export const DECIMAL_RULE = {
  pattern: /^\d+(\.\d{1,4})?$/,
  message: '请输入非负数值（最多 4 位小数）',
};

/**
 * Idempotency-Key for POST mutations — one uuid per form-open / wizard-mount.
 * Retried submits reuse the same key so a double-click can't double-apply;
 * the server rolls the key row back on failure so edit-then-retry still works.
 * crypto.randomUUID is missing in non-secure (plain-http) contexts — fall
 * back to a random-shaped uuid rather than crashing every form-open.
 */
export const newIdemKey = (): string =>
  crypto.randomUUID?.() ??
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) =>
    ((Math.random() * 16) | (c === 'x' ? 0 : 8 + Math.random() * 4)).toString(16),
  );

/** Strip empty-string/undefined fields so POST bodies stay clean. */
export const cleanBody = <T extends Record<string, unknown>>(body: T): T => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || (typeof v === 'string' && v.trim() === '')) continue;
    out[k] = typeof v === 'string' ? v.trim() : v;
  }
  return out as T;
};

/**
 * PATCH semantics differ from POST: undefined = leave unchanged, but an
 * emptied optional field must reach the server as `null` — the explicit
 * clear — or the old value silently persists.
 */
export const cleanPatch = <T extends Record<string, unknown>>(
  body: T,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    out[k] = typeof v === 'string' ? v.trim() || null : v;
  }
  return out;
};

/**
 * 水表户 id → 户号 的批量水合 hook：结算/补差等列表只带
 * waterAccountId，逐条 GET /water-accounts/:id 解析成户号展示。
 * 需 customer:read —— 没有权限（或单条失败）时退化为短 uuid 显示。
 */
export const useWaterAccountLabels = (ids: (string | null | undefined)[]) => {
  const { hasPerm } = useAuth();
  const canRead = hasPerm('customer:read');
  const [labels, setLabels] = useState(() => new Map<string, string | null>());
  const key = ids
    .filter((i): i is string => !!i)
    .sort()
    .join(',');

  useEffect(() => {
    if (!canRead) return;
    const missing = key.split(',').filter((id) => id && !labels.has(id));
    if (missing.length === 0) return;
    let cancelled = false;
    void Promise.all(
      missing.map((id) =>
        api
          .get<WaterAccount>(`/water-accounts/${id}`)
          .then((r) => r.data)
          .catch(() => null),
      ),
    ).then((res) => {
      if (cancelled) return;
      setLabels((prev) => {
        const next = new Map(prev);
        res.forEach((a, i) => next.set(missing[i], a ? a.accountNo : null));
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [key, canRead, labels]);

  return useCallback(
    (id: string | null | undefined) => {
      if (!id) return '—';
      return labels.get(id) ?? `${id.slice(0, 8)}…`;
    },
    [labels],
  );
};
