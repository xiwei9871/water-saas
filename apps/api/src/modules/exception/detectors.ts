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
  qcStatus: 'MANUAL_REVIEW' | 'REJECTED',
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
    }[]
  >`
    SELECT e.id::text, e.processing_status::text, e.remote_source_id::text,
           i.water_account_id::text
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
      summary: `远传事件 ${r.id.slice(0, 8)} 状态 ${r.processing_status}`,
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
    { id: string; remote_source_id: string; current_issue_at: Date; occurrences: bigint }[]
  >`
    SELECT e.id::text, e.remote_source_id::text, e.current_issue_at,
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
      summary: `远传事件 ${r.id.slice(0, 8)} event key 冲突 @${r.current_issue_at.toISOString()} (#${r.occurrences})`,
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
    detectEstimateStreak(tx, tenantId),
    detectRemoteStatus(tx, tenantId),
    detectEventKeyConflict(tx, tenantId),
    detectUnpaidBillOverdue(tx, tenantId),
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
