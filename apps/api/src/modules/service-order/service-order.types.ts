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

/** 执行阶段需要联动域动作的类型。其余类型只回填 resultNote。 */
export const LINKAGE_TYPES = new Set<ServiceType>([
  'PERIODIC_CHECK',
  'DISPUTE_CHECK',
  'FAULT',
  'SUSPEND',
  'STOP',
  'RESUME',
  'CLOSE',
]);

/** FAULT（故障换表）执行载荷 — 对应 replaceTx 三要素。 */
export interface FaultPayload {
  newMeterId: string;
  oldFinalReading: number | string;
  newInitialReading: number | string;
  replacedAt?: string;
}

/** 检定/校验类执行载荷 — 写入 AccountEvent(METER_CHECK)。 */
export interface CheckPayload {
  checkResult?: string;
  effectiveDate?: string;
}

/** 停复水/销户类执行载荷。 */
export interface StatusPayload {
  effectiveDate?: string;
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

export function parseFaultPayload(v: unknown): FaultPayload {
  const p = (v ?? {}) as Partial<FaultPayload>;
  if (typeof p.newMeterId !== 'string' || !p.newMeterId) {
    throw bad('FAULT_NEW_METER_REQUIRED');
  }
  if (!isNum(p.oldFinalReading) || !isNum(p.newInitialReading)) {
    throw bad('REPLACE_FIELDS_REQUIRED');
  }
  return {
    newMeterId: p.newMeterId,
    oldFinalReading: p.oldFinalReading as number | string,
    newInitialReading: p.newInitialReading as number | string,
    replacedAt: typeof p.replacedAt === 'string' ? p.replacedAt : undefined,
  };
}

export function parseCheckPayload(v: unknown): CheckPayload {
  const p = (v ?? {}) as Partial<CheckPayload>;
  return {
    checkResult: typeof p.checkResult === 'string' ? p.checkResult : undefined,
    effectiveDate: typeof p.effectiveDate === 'string' ? p.effectiveDate : undefined,
  };
}

export function parseStatusPayload(v: unknown): StatusPayload {
  const p = (v ?? {}) as Partial<StatusPayload>;
  return {
    effectiveDate: typeof p.effectiveDate === 'string' ? p.effectiveDate : undefined,
    remark: typeof p.remark === 'string' ? p.remark : undefined,
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
