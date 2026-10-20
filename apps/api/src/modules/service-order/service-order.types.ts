import { BadRequestException } from '@nestjs/common';

/**
 * 表务工单服务类型（20261019 整合需求 T1）。
 * Catalogue mirrors the SERVICE_TYPE sys_dict rows seeded by migration
 * 20261019130000 — dict rows are the runtime source (tenant can rename),
 * this constant is the static fallback + type union.
 */
export const SERVICE_TYPES = [
  'PERIODIC_CHECK',
  'DISPUTE_CHECK',
  'FAULT',
  'SUSPEND',
  'STOP',
  'RESUME',
  'FLOW_LIMIT',
  'FACILITY_MAINTENANCE',
  'SITE_RECTIFICATION',
  'METER_GROUP_CLEANING',
  'CLOSE',
] as const;

export type ServiceType = (typeof SERVICE_TYPES)[number];

/** 执行阶段需要联动域动作的类型。 */
export const LINKAGE_TYPES = new Set<ServiceType>([
  'PERIODIC_CHECK',
  'DISPUTE_CHECK',
  'FAULT',
  'SUSPEND',
  'STOP',
  'RESUME',
  'CLOSE',
]);

// ---- 20261020 核查 T6：各处置类型执行回填载荷 ----

/** 换表（故障）执行载荷 — replaceTx 三要素 + 新表唯一标识。 */
export interface FaultPayload {
  /** 工单未关联表位时，执行环节可补传安装记录 id。 */
  meterInstallationId?: string;
  newMeterId: string;
  oldFinalReading: number | string;
  newInitialReading: number | string;
  replacedAt?: string;
}

/** 周期校验/争议检定载荷 → AccountEvent(METER_CHECK) + 回写 meter.lastCheckDate。 */
export interface CheckPayload {
  checkOrg?: string;
  checkDate?: string;
  checkResult?: 'PASS' | 'FAIL' | 'ADJUSTED';
  /** 示值误差 %（文字存留，避免精度歧义）。 */
  checkError?: string;
  certNo?: string;
  /** 检定机构给出的下次检定日期；缺省由 checkDate + 年限推算。 */
  nextCheckDate?: string;
  effectiveDate?: string;
}

/** 停水/复水/限流载荷。 */
export interface StatusPayload {
  effectiveDate?: string;
  /** 限流方式/限流值/恢复日期（FLOW_LIMIT 用）。 */
  limitMethod?: string;
  limitValue?: string;
  restoreDate?: string;
  remark?: string;
}

/** 表位维护/整改/表组清洁载荷 — 文字记录 + 现场照片引用。 */
export interface SitePayload {
  content?: string;
  photoRefs?: string[];
}

/** 销户拆表载荷 — 拆除读数 + 关联表位（先拆表后销户）。 */
export interface ClosePayload {
  meterInstallationId?: string;
  finalReading: number | string;
  removedAt?: string;
  remark?: string;
}

const bad = (code: string, extra?: Record<string, unknown>) =>
  new BadRequestException({ code, ...extra });

export function assertServiceType(v: unknown): asserts v is ServiceType {
  if (typeof v !== 'string' || !(SERVICE_TYPES as readonly string[]).includes(v)) {
    throw bad('SERVICE_TYPE_INVALID', { serviceType: v });
  }
}

const isNum = (v: unknown) =>
  (typeof v === 'number' && Number.isFinite(v)) ||
  (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const strArr = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : undefined;

export function parseFaultPayload(v: unknown): FaultPayload {
  const p = (v ?? {}) as Partial<FaultPayload>;
  if (typeof p.newMeterId !== 'string' || !p.newMeterId) {
    throw bad('FAULT_NEW_METER_REQUIRED');
  }
  if (!isNum(p.oldFinalReading) || !isNum(p.newInitialReading)) {
    throw bad('REPLACE_FIELDS_REQUIRED');
  }
  return {
    meterInstallationId: str(p.meterInstallationId),
    newMeterId: p.newMeterId,
    oldFinalReading: p.oldFinalReading as number | string,
    newInitialReading: p.newInitialReading as number | string,
    replacedAt: str(p.replacedAt),
  };
}

export function parseCheckPayload(v: unknown): CheckPayload {
  const p = (v ?? {}) as Partial<CheckPayload>;
  const checkResult =
    p.checkResult === undefined ? undefined : p.checkResult;
  if (checkResult !== undefined && !['PASS', 'FAIL', 'ADJUSTED'].includes(checkResult)) {
    throw bad('CHECK_RESULT_INVALID');
  }
  return {
    checkOrg: str(p.checkOrg),
    checkDate: str(p.checkDate),
    checkResult,
    checkError: str(p.checkError),
    certNo: str(p.certNo),
    nextCheckDate: str(p.nextCheckDate),
    effectiveDate: str(p.effectiveDate),
  };
}

export function parseStatusPayload(v: unknown): StatusPayload {
  const p = (v ?? {}) as Partial<StatusPayload>;
  return {
    effectiveDate: str(p.effectiveDate),
    limitMethod: str(p.limitMethod),
    limitValue: str(p.limitValue),
    restoreDate: str(p.restoreDate),
    remark: str(p.remark),
  };
}

export function parseSitePayload(v: unknown): SitePayload {
  const p = (v ?? {}) as Partial<SitePayload>;
  return { content: str(p.content), photoRefs: strArr(p.photoRefs) };
}

export function parseClosePayload(v: unknown): ClosePayload {
  const p = (v ?? {}) as Partial<ClosePayload>;
  if (!isNum(p.finalReading)) throw bad('CLOSE_FINAL_READING_REQUIRED');
  return {
    meterInstallationId: str(p.meterInstallationId),
    finalReading: p.finalReading as number | string,
    removedAt: str(p.removedAt),
    remark: str(p.remark),
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function parseDate(v: string | undefined, code = 'EFFECTIVE_DATE_INVALID'): Date | undefined {
  if (v === undefined) return undefined;
  if (!DATE_RE.test(v)) throw bad(code);
  const d = new Date(`${v}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw bad(code);
  return d;
}
