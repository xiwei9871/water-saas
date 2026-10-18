import type { Prisma } from '@prisma/client';
import { accountEstimateStreaksTx } from '../../common/estimate-streak.js';
import {
  A, severityOf, waKey, billKey, readingKey, eventKey, eventIssueKey,
  buildKey, type AnomalyFact, type ParsedKey,
} from './types.js';

/**
 * E9 detectors — PURE fact computation (D1). No work_item reads, no writes.
 * Each detector returns AnomalyFact[]; scope filtering happens later in the
 * query layer so the same facts feed tenant-wide reconcile and scoped views.
 *
 * Predicates are the Rev4-frozen ones — do not extend without a Gate rev.
 */

const fact = (f: Omit<AnomalyFact, 'severity'>): AnomalyFact => ({
  ...f,
  severity: severityOf(f.type),
});

/** account number for summary strings — one batch lookup per detect pass. */
async function accountNos(
  tx: Prisma.TransactionClient,
  tenantId: string,
  ids: string[],
): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await tx.waterAccount.findMany({
    where: { tenantId, id: { in: ids } },
    select: { id: true, accountNo: true },
  });
  return new Map(rows.map((r) => [r.id, r.accountNo]));
}

// ---------------------------------------------------------------------------
// account/meter detectors (D12: anchor decided later by CURRENT BookMeter
// count — detectors only carry waterAccountId)
// ---------------------------------------------------------------------------

async function detectNoActiveMeter(tx: Prisma.TransactionClient, tenantId: string): Promise<AnomalyFact[]> {
  const rows = await tx.$queryRaw<{ id: string; account_no: string }[]>`
    SELECT wa.id::text, wa.account_no
    FROM water_account wa
    WHERE wa.tenant_id = ${tenantId}::uuid
      AND wa.status <> 'CLOSED'
      AND wa.billable
      AND NOT EXISTS (
        SELECT 1 FROM meter_installation mi
        WHERE mi.tenant_id = wa.tenant_id
          AND mi.water_account_id = wa.id
          AND mi.status = 'ACTIVE'
      )`;
  return rows.map((r) =>
    fact({
      key: waKey(r.id, A.NO_ACTIVE_METER),
      type: A.NO_ACTIVE_METER,
      waterAccountId: r.id,
      anchorRef: { kind: 'water-account', id: r.id },
      summary: `账户 ${r.account_no} 无 ACTIVE 表`,
    }),
  );
}

async function detectMultiActiveMeter(tx: Prisma.TransactionClient, tenantId: string): Promise<AnomalyFact[]> {
  const rows = await tx.$queryRaw<{ id: string; account_no: string; cnt: bigint }[]>`
    SELECT wa.id::text, wa.account_no, COUNT(mi.id) AS cnt
    FROM water_account wa
    JOIN meter_installation mi
      ON mi.tenant_id = wa.tenant_id AND mi.water_account_id = wa.id AND mi.status = 'ACTIVE'
    WHERE wa.tenant_id = ${tenantId}::uuid
    GROUP BY wa.id, wa.account_no
    HAVING COUNT(mi.id) > 1`;
  return rows.map((r) =>
    fact({
      key: waKey(r.id, A.MULTI_ACTIVE_METER),
      type: A.MULTI_ACTIVE_METER,
      waterAccountId: r.id,
      anchorRef: { kind: 'water-account', id: r.id },
      summary: `账户 ${r.account_no} 存在 ${r.cnt} 块 ACTIVE 表`,
    }),
  );
}

/** D14: CURRENT BookMeter membership only — historical plan items are not
 *  the SoT for current book ownership. Excludes CLOSED / non-billable /
 *  MONITORING (billable=false covers MONITORING). */
async function detectNoBook(tx: Prisma.TransactionClient, tenantId: string): Promise<AnomalyFact[]> {
  const rows = await tx.$queryRaw<{ id: string; account_no: string }[]>`
    SELECT wa.id::text, wa.account_no
    FROM water_account wa
    WHERE wa.tenant_id = ${tenantId}::uuid
      AND wa.status <> 'CLOSED'
      AND wa.billable
      AND NOT EXISTS (
        SELECT 1 FROM book_meter bm
        WHERE bm.tenant_id = wa.tenant_id AND bm.water_account_id = wa.id
      )`;
  return rows.map((r) =>
    fact({
      key: waKey(r.id, A.NO_BOOK),
      type: A.NO_BOOK,
      waterAccountId: r.id,
      anchorRef: { kind: 'water-account', id: r.id },
      summary: `账户 ${r.account_no} 未挂任何抄表册`,
    }),
  );
}

/** D13: >1 current BookMeter — duplicate plan items / remote ambiguity. */
async function detectMultiBook(tx: Prisma.TransactionClient, tenantId: string): Promise<AnomalyFact[]> {
  const rows = await tx.$queryRaw<{ id: string; account_no: string; cnt: bigint }[]>`
    SELECT wa.id::text, wa.account_no, COUNT(*) AS cnt
    FROM water_account wa
    JOIN book_meter bm
      ON bm.tenant_id = wa.tenant_id AND bm.water_account_id = wa.id
    WHERE wa.tenant_id = ${tenantId}::uuid
    GROUP BY wa.id, wa.account_no
    HAVING COUNT(*) > 1`;
  return rows.map((r) =>
    fact({
      key: waKey(r.id, A.MULTI_BOOK),
      type: A.MULTI_BOOK,
      waterAccountId: r.id,
      anchorRef: { kind: 'water-account', id: r.id },
      summary: `账户 ${r.account_no} 挂 ${r.cnt} 个抄表册`,
    }),
  );
}

// ---------------------------------------------------------------------------
// reading QC (D23 anti-supersede via child.supersedes_reading_id)
// ---------------------------------------------------------------------------

async function detectReadingQc(
  tx: Prisma.TransactionClient,
  tenantId: string,
  qcStatus: 'MANUAL_REVIEW' | 'REJECTED' | 'PENDING',
  type: string,
  label: string,
): Promise<AnomalyFact[]> {
  const rows = await tx.$queryRaw<
    { id: string; water_account_id: string; period: string; account_no: string }[]
  >`
    SELECT r.id::text, mi.water_account_id::text, r.period, wa.account_no
    FROM meter_reading r
    JOIN meter_installation mi
      ON mi.tenant_id = r.tenant_id AND mi.id = r.installation_id
    JOIN water_account wa
      ON wa.tenant_id = mi.tenant_id AND wa.id = mi.water_account_id
    WHERE r.tenant_id = ${tenantId}::uuid
      AND r.qc_status = ${qcStatus}::"QcStatus"
      AND NOT EXISTS (
        SELECT 1 FROM meter_reading child
        WHERE child.tenant_id = r.tenant_id
          AND child.supersedes_reading_id = r.id
      )`;
  return rows.map((r) =>
    fact({
      key: readingKey(r.id, type),
      type,
      waterAccountId: r.water_account_id,
      anchorRef: { kind: 'reading', id: r.id },
      period: r.period,
      summary: `账户 ${r.account_no} ${r.period} 期读数${label}`,
    }),
  );
}

// ---------------------------------------------------------------------------
// estimate streak — shared streak math via common/estimate-streak.ts
// ---------------------------------------------------------------------------

async function detectEstimateStreak(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<AnomalyFact[]> {
  // threshold: tenant param max_consecutive_estimates, default 2 (Pilot 定稿)
  const param = await tx.tenantParam.findUnique({
    where: { tenantId_key: { tenantId, key: 'max_consecutive_estimates' } },
    select: { value: true },
  });
  const raw = typeof param?.value === 'string' ? param.value : '';
  const threshold = Math.max(1, parseInt(raw, 10) || 2);

  const candidates = await tx.waterAccount.findMany({
    where: { tenantId, status: { not: 'CLOSED' }, billable: true },
    select: { id: true },
  });
  const streaks = await accountEstimateStreaksTx(
    tx,
    tenantId,
    candidates.map((c) => c.id),
  );
  const hits = candidates.filter((c) => (streaks.get(c.id) ?? 0) >= threshold);
  const nos = await accountNos(tx, tenantId, hits.map((h) => h.id));
  return hits.map((h) =>
    fact({
      key: waKey(h.id, A.ESTIMATE_STREAK),
      type: A.ESTIMATE_STREAK,
      waterAccountId: h.id,
      anchorRef: { kind: 'water-account', id: h.id },
      summary: `账户 ${nos.get(h.id) ?? h.id} 连续估抄 ${streaks.get(h.id)} 期`,
    }),
  );
}

// ---------------------------------------------------------------------------
// remote events (D10/D11/D21/D22)
// ---------------------------------------------------------------------------

const REMOTE_STATUS_TYPES = {
  UNBOUND: A.REMOTE_EVENT_UNBOUND,
  WAITING_PLAN: A.REMOTE_EVENT_WAITING_PLAN,
  FAILED: A.REMOTE_EVENT_FAILED,
  CONFLICT: A.REMOTE_EVENT_CONFLICT,
} as const;

/** processingStatus-based anomalies. UNBOUND has no resolved account →
 *  REMOTE_SOURCE anchor; the other three resolved a waterAccount upstream
 *  (D21) → carry waterAccountId for ACCOUNT/TENANT resolution. */
async function detectRemoteStatus(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<AnomalyFact[]> {
  const rows = await tx.$queryRaw<
    {
      id: string;
      processing_status: string;
      remote_source_id: string;
      water_account_id: string | null;
      external_event_key: string;
      vendor_device_key: string;
    }[]
  >`
    SELECT e.id::text, e.processing_status::text, e.remote_source_id::text,
           i.water_account_id::text, e.external_event_key, e.vendor_device_key
    FROM raw_remote_event e
    LEFT JOIN remote_device_binding b
      ON b.tenant_id = e.tenant_id
     AND b.remote_source_id = e.remote_source_id
     AND b.remote_device_id = e.resolved_remote_device_id
     AND b.id = e.resolved_binding_id
    LEFT JOIN meter_installation i
      ON i.tenant_id = b.tenant_id AND i.id = b.installation_id
    WHERE e.tenant_id = ${tenantId}::uuid
      AND e.processing_status IN ('UNBOUND','WAITING_PLAN','FAILED','CONFLICT')`;
  return rows.map((r) => {
    const type = REMOTE_STATUS_TYPES[r.processing_status as keyof typeof REMOTE_STATUS_TYPES];
    const unbound = r.processing_status === 'UNBOUND';
    return fact({
      key: eventKey(r.id, type),
      type,
      // D21: REMOTE_SOURCE anchor only for UNBOUND. WAITING_PLAN/FAILED/
      // CONFLICT anchor the resolved account (off-book → TENANT via D12);
      // if resolution is somehow absent, they fall to TENANT — never source.
      waterAccountId: unbound ? undefined : (r.water_account_id ?? undefined),
      remoteSourceId: unbound ? r.remote_source_id : undefined,
      anchorRef: { kind: 'remote-event', id: r.id },
      summary: `远传事件 ${r.external_event_key || r.vendor_device_key}（设备 ${r.vendor_device_key}）状态 ${r.processing_status}`,
    });
  });
}

/** D11/D22: EVENT_KEY_CONFLICT is keyed by issue-occurrence. Occurrence token =
 *  COUNT of EVENT_KEY_CONFLICT process-log rows for the event — monotonically
 *  increasing, immune to timestamp-precision collisions (two conflicts inside
 *  the same millisecond would share currentIssueAt; the log count cannot).
 *  Independent of processingStatus — may coexist with a CONFLICT anomaly. */
async function detectEventKeyConflict(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<AnomalyFact[]> {
  const rows = await tx.$queryRaw<
    {
      id: string;
      remote_source_id: string;
      current_issue_at: Date;
      occurrences: bigint;
      external_event_key: string;
      vendor_device_key: string;
    }[]
  >`
    SELECT e.id::text, e.remote_source_id::text, e.current_issue_at,
           e.external_event_key, e.vendor_device_key,
           (SELECT count(*) FROM remote_event_process_log l
            WHERE l.tenant_id = e.tenant_id AND l.remote_event_id = e.id
              AND l.code = 'EVENT_KEY_CONFLICT') AS occurrences
    FROM raw_remote_event e
    WHERE e.tenant_id = ${tenantId}::uuid
      AND e.current_issue_code = 'EVENT_KEY_CONFLICT'
      AND e.current_issue_at IS NOT NULL`;
  return rows.map((r) =>
    fact({
      key: eventIssueKey(r.id, String(r.occurrences)),
      type: A.REMOTE_EVENT_KEY_CONFLICT,
      remoteSourceId: r.remote_source_id,
      anchorRef: { kind: 'remote-event', id: r.id },
      summary: `远传事件 ${r.external_event_key || r.vendor_device_key}（设备 ${r.vendor_device_key}）事件键冲突 @${r.current_issue_at.toISOString()}（第 ${r.occurrences} 次）`,
    }),
  );
}

// ---------------------------------------------------------------------------
// billing — bill-level fact only (Bill + own PaymentAlloc; D5: NOT settle-level)
// ---------------------------------------------------------------------------

async function detectUnpaidBillOverdue(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<AnomalyFact[]> {
  const rows = await tx.$queryRaw<
    { id: string; water_account_id: string; period: string; remaining: bigint; account_no: string }[]
  >`
    SELECT b.id::text, b.water_account_id::text, b.period,
           b.total_amount - COALESCE(a.paid, 0) AS remaining,
           wa.account_no
    FROM bill b
    JOIN water_account wa
      ON wa.tenant_id = b.tenant_id AND wa.id = b.water_account_id
    LEFT JOIN LATERAL (
      SELECT SUM(pa.amount) AS paid
      FROM payment_alloc pa
      WHERE pa.tenant_id = b.tenant_id AND pa.bill_id = b.id
    ) a ON true
    WHERE b.tenant_id = ${tenantId}::uuid
      AND b.status IN ('POSTED','PARTIAL_PAID')
      AND b.due_date < CURRENT_DATE
      AND b.total_amount - COALESCE(a.paid, 0) > 0`;
  return rows.map((r) =>
    fact({
      key: billKey(r.id),
      type: A.UNPAID_BILL_OVERDUE,
      waterAccountId: r.water_account_id,
      anchorRef: { kind: 'bill', id: r.id },
      period: r.period,
      summary: `账单 ${r.period} 逾期未缴，剩余 ${r.remaining}`,
    }),
  );
}

// ---------------------------------------------------------------------------
// T1 (10·8-9 报告 §7) — 结算/开账/销户侧的待办异常
// ---------------------------------------------------------------------------

/** 实抄止度低于已出账估止 —— 与 GET /reconciliations/drift-hints 同一事实源：
 *  PASSED 实抄/远传 R2 取代了仍在喂养 FINAL 结算的 R1，且 R2 尚未锚定补差。 */
async function detectSettlementDrift(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<AnomalyFact[]> {
  const rows = await tx.$queryRaw<
    { reading_id: string; water_account_id: string; period: string; account_no: string }[]
  >`
    SELECT r2.id::text AS reading_id, wa.id::text AS water_account_id,
           r2.period, wa.account_no
    FROM meter_reading r2
    JOIN meter_reading r1
      ON r1.tenant_id = r2.tenant_id AND r1.id = r2.supersedes_reading_id
    JOIN consumption_component cc
      ON cc.tenant_id = r1.tenant_id AND cc.source_reading_id = r1.id
    JOIN consumption_settlement cs
      ON cs.tenant_id = cc.tenant_id AND cs.id = cc.settlement_id
     AND cs.status = 'FINAL'
    JOIN meter_installation mi
      ON mi.tenant_id = r2.tenant_id AND mi.id = r2.installation_id
    JOIN water_account wa
      ON wa.tenant_id = mi.tenant_id AND wa.id = mi.water_account_id
    WHERE r2.tenant_id = ${tenantId}::uuid
      AND r2.qc_status = 'PASSED'
      AND r2.result_type IN ('ACTUAL', 'REMOTE')
      AND NOT EXISTS (
        SELECT 1 FROM reconciliation rc
        WHERE rc.tenant_id = r2.tenant_id AND rc.actual_reading_id = r2.id
      )
    GROUP BY wa.id, wa.account_no, r2.id, r2.period`;
  return rows.map((r) =>
    fact({
      key: readingKey(r.reading_id, A.SETTLEMENT_DRIFT),
      type: A.SETTLEMENT_DRIFT,
      waterAccountId: r.water_account_id,
      anchorRef: { kind: 'water-account', id: r.water_account_id },
      period: r.period,
      summary: `账户 ${r.account_no} 实抄读数已修正但 ${r.period} 期未补差——请到「补差管理」处理`,
    }),
  );
}

/**
 * 开账前置检查三态：OPEN 计划中 ≤ 当前账期的计划项，逐项判：
 *   PENDING/NO_READ → PLANNED_NO_READING（缺读数）
 *   READ 但无结算    → PLANNED_NO_SETTLEMENT（缺结算）
 *   READ 但结算 DRAFT → SETTLEMENT_UNFINALIZED（未终审，不会出账）
 * 一户一条（wa key 去重），period 取该户最新的欠账计划期。
 */
async function detectPlanCoverage(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<AnomalyFact[]> {
  const rows = await tx.$queryRaw<
    {
      water_account_id: string;
      account_no: string;
      period: string;
      item_status: string;
      settlement_status: string | null;
    }[]
  >`
    SELECT i.water_account_id::text, wa.account_no, p.period,
           i.status::text AS item_status, cs.status::text AS settlement_status
    FROM reading_plan_item i
    JOIN reading_plan p
      ON p.tenant_id = i.tenant_id AND p.id = i.plan_id
     AND p.status = 'OPEN'
    JOIN water_account wa
      ON wa.tenant_id = i.tenant_id AND wa.id = i.water_account_id
     AND wa.status <> 'CLOSED' AND wa.billable
    LEFT JOIN consumption_settlement cs
      ON cs.tenant_id = i.tenant_id
     AND cs.water_account_id = i.water_account_id
     AND cs.period = p.period
    WHERE i.tenant_id = ${tenantId}::uuid
      AND p.period <= to_char(now() AT TIME ZONE 'UTC', 'YYYYMM')
      AND (
        i.status IN ('PENDING', 'NO_READ')
        OR (i.status = 'READ' AND (cs.id IS NULL OR cs.status = 'DRAFT'))
      )
    ORDER BY i.water_account_id, p.period DESC`;
  const byAccount = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    // 一户多期欠账时只报最新一期 —— 处理动作相同，避免刷屏。
    if (!byAccount.has(r.water_account_id)) byAccount.set(r.water_account_id, r);
  }
  const TYPE_OF: Record<string, string> = {
    PENDING: A.PLANNED_NO_READING,
    NO_READ: A.PLANNED_NO_READING,
    READ: A.PLANNED_NO_SETTLEMENT,
  };
  const REASON: Record<string, string> = {
    PENDING: '本期尚未抄表',
    NO_READ: '本期标记未抄见',
    READ: '本期已抄但未生成结算（可能因读数未质检）',
  };
  return [...byAccount.values()].map((r) => {
    const type =
      r.item_status === 'READ' && r.settlement_status === 'DRAFT'
        ? A.SETTLEMENT_UNFINALIZED
        : TYPE_OF[r.item_status] ?? A.PLANNED_NO_READING;
    const reason =
      type === A.SETTLEMENT_UNFINALIZED
        ? '结算仍为草稿（未终审），开账不会出账'
        : (REASON[r.item_status] ?? '计划项未完成');
    return fact({
      key: waKey(r.water_account_id, type),
      type,
      waterAccountId: r.water_account_id,
      anchorRef: { kind: 'water-account', id: r.water_account_id },
      period: r.period,
      summary: `账户 ${r.account_no} ${r.period} 期：${reason}`,
    });
  });
}

/** 销户残留：已 CLOSED 用水户名下仍有未清应收或结算户预存余额。 */
async function detectClosedBalance(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<AnomalyFact[]> {
  const rows = await tx.$queryRaw<
    {
      water_account_id: string;
      account_no: string;
      unpaid: bigint;
      prepay: bigint;
    }[]
  >`
    SELECT wa.id::text AS water_account_id, wa.account_no,
           COALESCE((
             SELECT sum(b.total_amount - COALESCE(a.paid, 0))
             FROM bill b
             LEFT JOIN LATERAL (
               SELECT sum(pa.amount) AS paid FROM payment_alloc pa
               WHERE pa.tenant_id = b.tenant_id AND pa.bill_id = b.id
             ) a ON true
             WHERE b.tenant_id = wa.tenant_id
               AND b.water_account_id = wa.id
               AND b.status IN ('POSTED', 'PARTIAL_PAID')
           ), 0)::bigint AS unpaid,
           COALESCE((
             SELECT sum(e.amount) FROM prepayment_ledger_entry e
             WHERE e.tenant_id = wa.tenant_id
               AND e.settle_account_id = wa.settle_account_id
           ), 0)::bigint AS prepay
    FROM water_account wa
    WHERE wa.tenant_id = ${tenantId}::uuid
      AND wa.status = 'CLOSED'`;
  return rows
    .filter((r) => r.unpaid !== 0n || r.prepay !== 0n)
    .map((r) => {
      const parts: string[] = [];
      if (r.unpaid !== 0n) parts.push(`未清应收 ${Number(r.unpaid) / 100} 元`);
      if (r.prepay !== 0n) parts.push(`预存余额 ${Number(r.prepay) / 100} 元`);
      return fact({
        key: waKey(r.water_account_id, A.CLOSED_BALANCE_LEFT),
        type: A.CLOSED_BALANCE_LEFT,
        waterAccountId: r.water_account_id,
        anchorRef: { kind: 'water-account', id: r.water_account_id },
        summary: `账户 ${r.account_no} 已销户但仍有${parts.join('、')}——请按销户预检路径清理`,
      });
    });
}

// ---------------------------------------------------------------------------

/** All detectors — one pass, facts are scope-agnostic (filtering later). */
export async function detectAll(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<AnomalyFact[]> {
  const groups = await Promise.all([
    detectNoActiveMeter(tx, tenantId),
    detectMultiActiveMeter(tx, tenantId),
    detectNoBook(tx, tenantId),
    detectMultiBook(tx, tenantId),
    detectReadingQc(tx, tenantId, 'MANUAL_REVIEW', A.READING_QC_REVIEW, '待人工复核'),
    detectReadingQc(tx, tenantId, 'REJECTED', A.READING_QC_REJECTED, 'QC 驳回'),
    detectReadingQc(tx, tenantId, 'PENDING', A.READING_QC_PENDING, '待质检'),
    detectEstimateStreak(tx, tenantId),
    detectRemoteStatus(tx, tenantId),
    detectEventKeyConflict(tx, tenantId),
    detectUnpaidBillOverdue(tx, tenantId),
    detectSettlementDrift(tx, tenantId),
    detectPlanCoverage(tx, tenantId),
    detectClosedBalance(tx, tenantId),
  ]);
  return groups.flat();
}

/**
 * Re-evaluate ONE anomaly key (write-path gate: resolve must confirm the
 * fact is gone; ack/ignore/assign require it to exist). Returns null when
 * the fact does not currently hold.
 */
export async function evaluateKey(
  tx: Prisma.TransactionClient,
  tenantId: string,
  parsed: ParsedKey,
): Promise<AnomalyFact | null> {
  const all = await detectAll(tx, tenantId);
  const want = buildKey(parsed);
  return all.find((f) => f.key === want) ?? null;
}
