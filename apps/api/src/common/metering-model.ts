/**
 * 1102 抄表业务模型：区号 / 段号 / 频次 / 归集模式 / 工作日历 —— 常量与
 * 纯函数。租户参数键统一在此声明，界面展示一律中文（原则一：英文枚举
 * 只作内部存储值，展示必须映射为中文名）。
 */
import type { Prisma } from '@prisma/client';

// ---------------------------------------------------------------------------
// 归集模式（R2）：租户参数 metering.collectMode
// 存储值：READER_DIRECT 抄表员直管 / ZONE_SEGMENT 区段管理 —— 仅内部存储，
// 展示层必须用中文名，禁止英文落地。
// ---------------------------------------------------------------------------
export const PARAM_COLLECT_MODE = 'metering.collectMode';
/** R3：月末预留不排抄表的工作日数（参数可配 6 或 7）。 */
export const PARAM_MONTH_END_RESERVE = 'metering.monthEndReserveDays';

export type CollectMode = 'READER_DIRECT' | 'ZONE_SEGMENT';
export const COLLECT_MODES: readonly CollectMode[] = [
  'READER_DIRECT',
  'ZONE_SEGMENT',
];
/** 展示层中文名映射（唯一出处）。 */
export const COLLECT_MODE_LABELS: Record<CollectMode, string> = {
  READER_DIRECT: '抄表员直管',
  ZONE_SEGMENT: '区段管理',
};

/** R4 远传水表特殊区号：不派人工抄表任务，单独走远传采集。 */
export const REMOTE_ZONE_NO = '111';
export const isRemoteZone = (zoneNo: string | null | undefined): boolean =>
  zoneNo === REMOTE_ZONE_NO || zoneNo === 'YC';

/** 段号格式：两位数字 01..16（R4 上限 16，按当月实际批次动态生成）。 */
export const SEG_NO_RE = /^(0[1-9]|1[0-6])$/;
export const MAX_SEG_NO = 16;
/** 区号格式：两位数字 01..99（111 为远传保留）或 YC。 */
export const ZONE_NO_RE = /^(\d{2,3}|YC)$/;

export const isValidZoneNo = (v: string): boolean =>
  ZONE_NO_RE.test(v) && (v === 'YC' || (parseInt(v, 10) >= 1 && parseInt(v, 10) <= 199));

/** 区段号编码（R7）：区号 + 段号 → '0116'；直管模式无段号只留区号。 */
export const zoneSegCode = (zoneNo: string, segNo?: string | null): string =>
  `${zoneNo}${segNo ?? ''}`;

export async function readParam<T>(
  tx: Prisma.TransactionClient,
  tenantId: string,
  key: string,
): Promise<T | null> {
  const row = await tx.tenantParam.findUnique({
    where: { tenantId_key: { tenantId, key } },
  });
  return (row?.value as T | undefined) ?? null;
}

/** 当前租户归集模式（缺省 区段管理——与既有抄表册模型一致）。 */
export async function collectModeOf(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<CollectMode> {
  const v = await readParam<string>(tx, tenantId, PARAM_COLLECT_MODE);
  return v === 'READER_DIRECT' ? 'READER_DIRECT' : 'ZONE_SEGMENT';
}

/** 月末预留工作日数（默认 6，可配 6 或 7；越界值回退 6）。 */
export async function monthEndReserveOf(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<number> {
  const v = await readParam<number>(tx, tenantId, PARAM_MONTH_END_RESERVE);
  return v === 6 || v === 7 ? v : 6;
}

// ---------------------------------------------------------------------------
// R3 工作日历：默认周一~周五为工作日；tenant_calendar_day 登记例外
// HOLIDAY（节假日，工作→不抄）/ WORKDAY（调休上班日，周末→抄）。
// 全部按「业务日字符串 YYYY-MM-DD」计算：即时点先换算到业务时区
// Asia/Shanghai 得业务日，再按字符串历表比较——与服务器本地时区无关，
// 不会跨日偏移（A5）。
// ---------------------------------------------------------------------------
type Tx = Prisma.TransactionClient;

/** 租户业务时区（水司业务日口径固定上海时区，不随部署机时区漂移）。 */
export const BIZ_TZ = 'Asia/Shanghai';
const bizDayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: BIZ_TZ });

/** 任意时点 → 租户业务日字符串 'YYYY-MM-DD'。 */
export const bizDayStr = (d: Date): string => bizDayFmt.format(d);

/** 业务日字符串 → UTC 零点 Date（写库/比较用，跨时区稳定）。 */
export const parseBizDay = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

/** 业务日字符串加 n 天（跨月/跨年正常）。 */
export const addBizDays = (s: string, n: number): string => {
  const d = parseBizDay(s);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const weekdayOf = (s: string): number => parseBizDay(s).getUTCDay();

/** 拉取租户日历例外 → Map<YYYY-MM-DD, 'HOLIDAY'|'WORKDAY'>（指定年月窗口）。 */
export async function calendarOverrides(
  tx: Tx,
  tenantId: string,
  fromDay: Date,
  toDay: Date,
): Promise<Map<string, 'HOLIDAY' | 'WORKDAY'>> {
  const rows = await tx.tenantCalendarDay.findMany({
    where: { tenantId, day: { gte: fromDay, lte: toDay } },
    select: { day: true, kind: true },
  });
  const map = new Map<string, 'HOLIDAY' | 'WORKDAY'>();
  // 存储语义=UTC 零点的业务日 → 取 ISO 前 10 位，与服务器本地时区无关。
  for (const r of rows) {
    map.set(r.day.toISOString().slice(0, 10), r.kind as 'HOLIDAY' | 'WORKDAY');
  }
  return map;
}

export const isWorkday = (
  day: string,
  overrides: Map<string, 'HOLIDAY' | 'WORKDAY'>,
): boolean => {
  const ov = overrides.get(day);
  if (ov === 'WORKDAY') return true;
  if (ov === 'HOLIDAY') return false;
  const w = weekdayOf(day);
  return w >= 1 && w <= 5;
};

/** 当月全部工作日（升序业务日字符串）。period = 'YYYYMM'。 */
export function monthWorkdays(
  period: string,
  overrides: Map<string, 'HOLIDAY' | 'WORKDAY'>,
): string[] {
  const y = period.slice(0, 4);
  const m = period.slice(4);
  const last = addBizDays(`${y}-${m}-01`, 32);
  const out: string[] = [];
  for (let i = 1; i <= 31; i++) {
    const d = `${y}-${m}-${String(i).padStart(2, '0')}`;
    if (d >= last) break;
    if (isWorkday(d, overrides)) out.push(d);
  }
  return out;
}

/**
 * 当月抄表段表：段号 N ↔ 当月第 N 个工作日（1 起）。月末预留 reserveDays
 * 个工作日不排抄表 → 可用段数 = 工作日数 − reserveDays，再封顶 16。
 * 返回 [{segNo:'01', date:UTC零点}]，长度即当月实际批次数（动态）。
 */
export function segmentCalendar(
  period: string,
  overrides: Map<string, 'HOLIDAY' | 'WORKDAY'>,
  reserveDays: number,
): { segNo: string; date: Date }[] {
  const days = monthWorkdays(period, overrides);
  const usable = Math.max(0, Math.min(MAX_SEG_NO, days.length - reserveDays));
  return days.slice(0, usable).map((d, i) => ({
    segNo: String(i + 1).padStart(2, '0'),
    date: parseBizDay(d),
  }));
}

/** 某业务日是其月的第几个工作日（1 起；非工作日返回 null）。 */
export function workdayIndex(
  day: string,
  overrides: Map<string, 'HOLIDAY' | 'WORKDAY'>,
): number | null {
  if (!isWorkday(day, overrides)) return null;
  const days = monthWorkdays(`${day.slice(0, 4)}${day.slice(5, 7)}`, overrides);
  const i = days.indexOf(day);
  return i < 0 ? null : i + 1;
}

/** 下一工作业务日（顺延查找，最多向前 45 天，覆盖长假）。 */
export function nextWorkday(
  fromDay: string,
  overrides: Map<string, 'HOLIDAY' | 'WORKDAY'>,
): string | null {
  for (let i = 1; i <= 45; i++) {
    const d = addBizDays(fromDay, i);
    if (isWorkday(d, overrides)) return d;
  }
  return null;
}
