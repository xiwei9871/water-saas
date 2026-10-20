import dayjs from 'dayjs';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type {
  AccountStatus,
  CustType,
  InstallReason,
  InstallationStatus,
  MeterStatus,
  SettleAccount,
  WaterAccount,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { fmtMoney } from '../utils/numfmt';

/** 跨页面共享的枚举中文标签 / 颜色 / 小工具。 */

export const CUST_TYPE_LABELS: Record<CustType, string> = {
  PERSONAL: '个人',
  ORG: '单位',
};

/** 受控用水类别 —— 与 API 侧 common/usage-categories.ts 的固定集合一致；
 * 服务端 422 INVALID_USAGE_CATEGORY + DB CHECK 双重兜底。 */
export const USAGE_CATEGORY_LABELS: Record<string, string> = {
  // RC1-6 术语冻结：居民户表/居民合表/非居民/特种/监控表
  RES_METERED: '居民户表',
  RES_SHARED: '居民合表',
  NON_RES: '非居民',
  SPECIAL: '特种',
  MONITORING: '监控表',
};

export const USAGE_CATEGORY_OPTIONS = Object.entries(USAGE_CATEGORY_LABELS).map(
  ([value, label]) => ({ value, label }),
);

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

/** 表务工单服务类型（SERVICE_TYPE 字典镜像，20261019 需求 T1）。 */
export const SERVICE_TYPE_LABELS: Record<string, string> = {
  PERIODIC_CHECK: '周期校验',
  DISPUTE_CHECK: '争议检定',
  FAULT: '水表故障(换表)',
  SUSPEND: '暂停供水(报停)',
  STOP: '停水',
  RESUME: '复水',
  FLOW_LIMIT: '限流',
  FACILITY_MAINTENANCE: '表位设施维护',
  SITE_RECTIFICATION: '表位整改',
  METER_GROUP_CLEANING: '表组清洁',
  CLOSE: '销户(拆表销户)',
};

export const SERVICE_ORDER_STATUS_LABELS: Record<string, string> = {
  PENDING_APPROVAL: '待审批',
  APPROVED: '已审批',
  DISPATCHED: '已派单',
  EXECUTED: '已执行',
  ARCHIVED: '已归档',
  REJECTED: '已驳回',
  CANCELLED: '已撤销',
};

export const SERVICE_ORDER_STATUS_COLORS: Record<string, string> = {
  PENDING_APPROVAL: 'gold',
  APPROVED: 'blue',
  DISPATCHED: 'cyan',
  EXECUTED: 'green',
  ARCHIVED: 'default',
  REJECTED: 'red',
  CANCELLED: 'default',
};

/** 工单来源（20261020 核查 T5）。 */
export const ORDER_SOURCE_LABELS: Record<string, string> = {
  MANUAL: '人工发起',
  READING_REPORT: '抄表上报',
  AUTO_CHECK: '到期检定',
};

/** 结算分量分段角色（20261020 核查 T3）：期中途换表的老/新表段。 */
export const SEGMENT_ROLE_LABELS: Record<string, string> = {
  OLD_SEGMENT: '老表段',
  NEW_SEGMENT: '新表段',
};

export const fmtTime = (iso: string) => dayjs(iso).format('YYYY-MM-DD HH:mm:ss');

export const fmtDate = (iso?: string | null) =>
  iso ? dayjs(iso).format('YYYY-MM-DD') : '—';

/** char(6) 账期 'YYYYMM' → 显示 'YYYY-MM'。 */
export const fmtPeriod = (p?: string | null) =>
  p && /^\d{6}$/.test(p) ? `${p.slice(0, 4)}-${p.slice(4)}` : (p ?? '—');

/** 金额分 → 元 显示（BigInt 列序列化为字符串）。¥ + 千分位 + 两位小数。 */
export const fmtCent = (v?: string | number | null) => fmtMoney(v);

/**
 * 枚举码 → 中文标签。缺映射时显示 '—' 并 console.warn（展示层取值
 * 规范：绝不回退渲染裸英文代码，漏映射要能被听见而不是被看见）。
 */
export const enumLabel = (
  map: Record<string, string>,
  v?: string | null,
): string => {
  if (v === null || v === undefined || v === '') return '—';
  const hit = map[v];
  if (hit === undefined) {
    console.warn(`[enumLabel] 未映射的枚举值: ${v}`);
    return '—';
  }
  return hit;
};

/**
 * 任务上下文 → 中文业务描述（整改 P4：UI 不渲染裸 JSON/英文键/UUID）。
 * 按任务类型输出「户号 · 账期 · 数值」句式；未识别类型回退到通用
 * 字段映射；均失败返回 null，由调用方决定是否展示折叠的技术详情。
 */
export const taskContextText = (type: string, ctx: unknown): string | null => {
  if (!ctx || typeof ctx !== 'object') return null;
  const c = ctx as Record<string, unknown>;
  const s = (k: string) => (c[k] == null || c[k] === '' ? null : String(c[k]));
  const yuan = (k: string) => {
    const v = c[k];
    return v == null ? null : fmtCent(String(v));
  };
  const num = (k: string, unit: string, label: string) =>
    s(k) == null ? null : `${label} ${s(k)} ${unit}`;
  const join = (parts: (string | null | false | undefined)[]) =>
    parts.filter((x): x is string => !!x).join(' · ');
  let text = '';
  switch (type) {
    case 'METER_REVIEW':
      text = join([
        s('waterAccountNo') && `户号 ${s('waterAccountNo')}`,
        s('period') && `账期 ${fmtPeriod(s('period'))}`,
        num('usageQty', 'm³', '本期用量'),
        num('avgUsage3', 'm³', '近3期均值'),
        s('prevReadingValue') && `上期表底 ${s('prevReadingValue')}`,
        s('readingValue') && `本期读数 ${s('readingValue')}`,
      ]);
      break;
    case 'SUPPLEMENT':
      text = join([
        s('waterAccountNo') && `户号 ${s('waterAccountNo')}`,
        s('period') && `账期 ${fmtPeriod(s('period'))}`,
        s('estimatedReadingValue') && `估计止度 ${s('estimatedReadingValue')}`,
        s('actualReadingValue') && `实抄止度 ${s('actualReadingValue')}`,
        s('diff') && `差值 ${s('diff')}`,
      ]);
      break;
    case 'COLLECTION':
      text = join([
        s('settleNo') && `结算户 ${s('settleNo')}`,
        yuan('arrearsCent') && `欠费 ${yuan('arrearsCent')}`,
        s('overdueDays') != null && `逾期 ${s('overdueDays')} 天`,
        yuan('thresholdCent') && `超阈值 ${yuan('thresholdCent')}`,
        s('overdueBillCount') && `逾期账单 ${s('overdueBillCount')} 笔`,
      ]);
      break;
    case 'REVERSAL_APPROVAL':
      text = join([
        s('originalPaymentNo') && `原收款单 ${s('originalPaymentNo')}`,
        s('reversalPaymentNo') && `红冲收款单 ${s('reversalPaymentNo')}`,
        s('waterAccountNo') && `户号 ${s('waterAccountNo')}`,
        s('period') && `账期 ${fmtPeriod(s('period'))}`,
        yuan('amountCent') && `金额 ${yuan('amountCent')}`,
        yuan('totalAmountCent') && `金额 ${yuan('totalAmountCent')}`,
        s('reason') && `原因：${s('reason')}`,
      ]);
      break;
    case 'WRITEOFF_APPROVAL':
      text = join([
        s('settleNo') && `结算户 ${s('settleNo')}`,
        yuan('amountCent') && `核销金额 ${yuan('amountCent')}`,
        s('reasonName') && `原因：${s('reasonName')}`,
        s('effectiveDate') && `生效日 ${s('effectiveDate')}`,
      ]);
      break;
    default:
      break;
  }
  if (text) return text;
  // 通用兜底：已知业务字段逐个翻译，纯技术字段（*Id/UUID）不展示
  const FIELD_LABELS: Record<string, string> = {
    waterAccountNo: '户号',
    settleNo: '结算户',
    period: '账期',
    reason: '原因',
    reasonName: '原因',
    paymentNo: '收款单号',
    billNo: '账单号',
    planPeriod: '计划账期',
  };
  const parts = Object.entries(FIELD_LABELS)
    .filter(([k]) => s(k) != null)
    .map(([k, label]) => `${label} ${k === 'period' ? fmtPeriod(s(k)) : s(k)}`);
  return parts.length ? parts.join(' · ') : null;
};

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

/** 用水户水合结果：户号与客户名分开，表格里能拆成两列。 */
export interface WaterAccountBrief {
  accountNo: string;
  customerName: string;
}

/**
 * 用水户 id → {户号, 客户名称} 的批量水合 hook：结算/补差等列表只带
 * waterAccountId，逐条 GET /water-accounts/:id 解析展示。
 * 需 customer:read —— 没有权限（或单条失败）时 info 返回 null，
 * accountLabel 退化为短 uuid。
 *
 * 返回两个 accessor：
 * - accountInfo(id) → WaterAccountBrief | null  —— 表格分列用（户号列 +
 *   客户名称列分开渲染）；
 * - accountLabel(id) → '户号 · 客户名称' 单行文本 —— 详情标题、描述位用。
 */
export const useWaterAccountLabels = (ids: (string | null | undefined)[]) => {
  const { hasPerm } = useAuth();
  const canRead = hasPerm('customer:read');
  const [briefs, setBriefs] = useState(
    () => new Map<string, WaterAccountBrief | null>(),
  );
  const key = ids
    .filter((i): i is string => !!i)
    .sort()
    .join(',');

  useEffect(() => {
    if (!canRead) return;
    const missing = key.split(',').filter((id) => id && !briefs.has(id));
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
      setBriefs((prev) => {
        const next = new Map(prev);
        res.forEach((a, i) =>
          next.set(
            missing[i],
            a ? { accountNo: a.accountNo, customerName: a.customer.name } : null,
          ),
        );
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [key, canRead, briefs]);

  const accountInfo = useCallback(
    (id: string | null | undefined): WaterAccountBrief | null =>
      id ? (briefs.get(id) ?? null) : null,
    [briefs],
  );
  const accountLabel = useCallback(
    (id: string | null | undefined) => {
      if (!id) return '—';
      const b = briefs.get(id);
      // 人读规范：解析不到户号时显示占位符，绝不显示截断 uuid。
      return b ? `${b.accountNo} · ${b.customerName}` : '—';
    },
    [briefs],
  );
  return { accountInfo, accountLabel };
};

/**
 * 结算户 id → '结算户号 · 名称' 的批量水合 hook（账单列表等只带
 * settleAccountId）。与 useWaterAccountLabels 同样的权限语义：
 * 需 customer:read，缺失退化为短 uuid。
 */
export const useSettleAccountLabels = (ids: (string | null | undefined)[]) => {
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
          .get<SettleAccount>(`/settle-accounts/${id}`)
          .then((r) => r.data)
          .catch(() => null),
      ),
    ).then((res) => {
      if (cancelled) return;
      setLabels((prev) => {
        const next = new Map(prev);
        res.forEach((s, i) =>
          next.set(missing[i], s ? `${s.settleNo} · ${s.name}` : null),
        );
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
      return labels.get(id) ?? '—';
    },
    [labels],
  );
};
