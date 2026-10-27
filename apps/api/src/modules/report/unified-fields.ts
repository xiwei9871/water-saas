/**
 * 统一数据查询 —— 字段池注册表（2026-10-15 数据查询模块设计方案 §四）。
 *
 * 粒度三档：
 *  - account    户级固定列，每行一次（基本信息主题）
 *  - period     账期级，按账期横向展开（水量/账单/收费主题）
 *  - cumulative 截至该账期的快照值（欠费主题，随账期列展开）
 *
 * perm：展示该字段所需的功能权限（任一主题字段未授权则从字段池剔除，
 * 不静默返 0）。identity 字段（户号/户名）是行的最小标识，始终附带。
 */
export type FieldGrain = 'account' | 'period' | 'cumulative';
export type FieldTheme =
  | 'basic'
  | 'usage'
  | 'billing'
  | 'collection'
  | 'arrears';

export interface UnifiedFieldDef {
  key: string;
  label: string;
  theme: FieldTheme;
  grain: FieldGrain;
  /** 展示所需权限码；null = 无需额外权限（行标识字段）。 */
  perm: string | null;
}

export const THEME_LABELS: Record<FieldTheme, string> = {
  basic: '基本信息',
  usage: '水量（抄表）',
  billing: '账单（计费）',
  collection: '收费',
  arrears: '欠费',
};

export const UNIFIED_FIELDS: UnifiedFieldDef[] = [
  // ---------- 基本信息（户级） ----------
  { key: 'accountNo', label: '户号', theme: 'basic', grain: 'account', perm: null },
  { key: 'customerName', label: '户名', theme: 'basic', grain: 'account', perm: null },
  { key: 'addr', label: '地址', theme: 'basic', grain: 'account', perm: 'customer:read' },
  { key: 'usageCategory', label: '用水类别', theme: 'basic', grain: 'account', perm: 'customer:read' },
  { key: 'accountStatus', label: '户状态', theme: 'basic', grain: 'account', perm: 'customer:read' },
  { key: 'openedAt', label: '开户日期', theme: 'basic', grain: 'account', perm: 'customer:read' },
  { key: 'closedAt', label: '销户日期', theme: 'basic', grain: 'account', perm: 'customer:read' },
  { key: 'orgName', label: '所属组织', theme: 'basic', grain: 'account', perm: 'customer:read' },
  { key: 'settleNo', label: '结算户号', theme: 'basic', grain: 'account', perm: 'customer:read' },
  { key: 'settleName', label: '结算户名', theme: 'basic', grain: 'account', perm: 'customer:read' },
  { key: 'meterNo', label: '表号', theme: 'basic', grain: 'account', perm: 'metering:read' },
  { key: 'caliber', label: '表口径', theme: 'basic', grain: 'account', perm: 'metering:read' },
  // X2：户所属抄表册册号（一户多册并列展示，顿号分隔；未入册 → null → 「—」）
  { key: 'bookNos', label: '抄表册册号', theme: 'basic', grain: 'account', perm: 'metering:read' },
  // R6/Q5：供用水合同编号（立户时自报装申请带入或手填）
  { key: 'contractNo', label: '合同编号', theme: 'basic', grain: 'account', perm: 'customer:read' },
  // ---------- 水量（账期级） ----------
  { key: 'usageQty', label: '本期水量', theme: 'usage', grain: 'period', perm: 'metering:read' },
  { key: 'isEstimated', label: '是否估抄', theme: 'usage', grain: 'period', perm: 'metering:read' },
  { key: 'readSource', label: '抄表方式', theme: 'usage', grain: 'period', perm: 'metering:read' },
  { key: 'readerName', label: '抄表员', theme: 'usage', grain: 'period', perm: 'metering:read' },
  { key: 'ytdUsage', label: '年累计水量', theme: 'usage', grain: 'period', perm: 'metering:read' },
  // ---------- 账单（账期级） ----------
  { key: 'billKind', label: '账单类型', theme: 'billing', grain: 'period', perm: 'billing:read' },
  { key: 'billStatus', label: '账单状态', theme: 'billing', grain: 'period', perm: 'billing:read' },
  { key: 'priceText', label: '单价构成', theme: 'billing', grain: 'period', perm: 'billing:read' },
  { key: 'totalAmount', label: '应收金额', theme: 'billing', grain: 'period', perm: 'billing:read' },
  { key: 'allocated', label: '已分摊实收', theme: 'billing', grain: 'period', perm: 'billing:read' },
  { key: 'remaining', label: '剩余欠费', theme: 'billing', grain: 'period', perm: 'billing:read' },
  // ---------- 收费（账期级，按账单账期归集） ----------
  { key: 'collectedAmount', label: '实收金额', theme: 'collection', grain: 'period', perm: 'payment:read' },
  { key: 'channels', label: '缴费渠道', theme: 'collection', grain: 'period', perm: 'payment:read' },
  { key: 'lastPaidAt', label: '最近缴费日期', theme: 'collection', grain: 'period', perm: 'payment:read' },
  { key: 'paymentNos', label: '收款单号', theme: 'collection', grain: 'period', perm: 'payment:read' },
  // ---------- 欠费（截至该账期累计） ----------
  { key: 'arrearsAmount', label: '欠费金额', theme: 'arrears', grain: 'cumulative', perm: 'billing:read' },
  { key: 'oldestPeriod', label: '最早欠费账期', theme: 'arrears', grain: 'cumulative', perm: 'billing:read' },
  { key: 'agingMonths', label: '账龄（月）', theme: 'arrears', grain: 'cumulative', perm: 'billing:read' },
  { key: 'arrearsBillCount', label: '欠费账单数', theme: 'arrears', grain: 'cumulative', perm: 'billing:read' },
  { key: 'writtenOff', label: '已核销', theme: 'arrears', grain: 'cumulative', perm: 'billing:read' },
];

export const FIELD_MAP = new Map(UNIFIED_FIELDS.map((f) => [f.key, f]));

/** 行标识字段 —— 无条件附带，不计入勾选。 */
export const IDENTITY_KEYS = ['accountNo', 'customerName'] as const;

/** 账期跨度硬上限（文档 §六：最多 12 期）。 */
export const PERIOD_SPAN_MAX = 12;

/** 账期范围 → 有序账期数组；超 span 上限返回 null。 */
export const expandPeriods = (from: string, to: string): string[] | null => {
  const toNum = (p: string) => parseInt(p, 10);
  let y = parseInt(from.slice(0, 4), 10);
  let m = parseInt(from.slice(4), 10);
  const end = toNum(to);
  const out: string[] = [];
  while (toNum(`${y}${String(m).padStart(2, '0')}`) <= end) {
    out.push(`${y}${String(m).padStart(2, '0')}`);
    if (out.length > PERIOD_SPAN_MAX) return null;
    if (++m === 13) { m = 1; y += 1; }
  }
  return out;
};
