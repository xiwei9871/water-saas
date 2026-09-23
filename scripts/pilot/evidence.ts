/**
 * Pilot evidence collector — read-only. Prints observation data that Pilot /
 * Product need to un-HOLD E10 metrics. It deliberately does NOT pick a
 * formula: candidate values are printed side by side for comparison.
 *
 * Usage:
 *   pnpm --filter api exec tsx ../../scripts/pilot/evidence.ts <tenantId>
 * Env: DATABASE_URL (defaults to local dev DSN).
 */
import pg from 'pg';

const tenantId = process.argv[2];
if (!tenantId) {
  console.error('usage: evidence.ts <tenantId>');
  process.exit(1);
}
const db = new pg.Client({
  connectionString:
    process.env.DATABASE_URL ??
    'postgresql://ws_app:ws_app_pw@localhost:5432/watersaas',
});

const q = async (label: string, sql: string, params: unknown[] = [tenantId]) => {
  const r = await db.query(sql, params);
  console.log(`\n=== ${label} ===`);
  console.table(r.rows);
};

const main = async () => {
await db.connect();
await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);

// 1) Remote device event cadence → REMOTE_ONLINE_RATE window evidence
await q(
  'remote event inter-arrival (minutes) per device, p50/p90/p95/p99',
  `WITH ev AS (
     SELECT resolved_remote_device_id, received_at,
            received_at - lag(received_at) OVER (
              PARTITION BY resolved_remote_device_id ORDER BY received_at) AS gap
     FROM raw_remote_event
     WHERE tenant_id = $1 AND resolved_remote_device_id IS NOT NULL),
   g AS (SELECT resolved_remote_device_id, extract(epoch FROM gap)/60.0 AS min
         FROM ev WHERE gap IS NOT NULL)
   SELECT resolved_remote_device_id::text,
          count(*) AS samples,
          round(percentile_cont(0.5)  WITHIN GROUP (ORDER BY min)) AS p50_min,
          round(percentile_cont(0.9)  WITHIN GROUP (ORDER BY min)) AS p90_min,
          round(percentile_cont(0.95) WITHIN GROUP (ORDER BY min)) AS p95_min,
          round(percentile_cont(0.99) WITHIN GROUP (ORDER BY min)) AS p99_min
   FROM g GROUP BY resolved_remote_device_id ORDER BY resolved_remote_device_id`,
);

// 2) Estimate-rate denominator candidates — side by side, no verdict
await q(
  'ESTIMATE_RATE denominator candidates per period',
  `WITH due AS (
     SELECT p.period, count(*) AS due_accounts
     FROM reading_plan_item i
     JOIN reading_plan p ON p.tenant_id=i.tenant_id AND p.id=i.plan_id
     WHERE i.tenant_id=$1 AND i.status <> 'SKIPPED'
     GROUP BY p.period),
   settled AS (
     SELECT period, count(*) AS settled_accounts,
            count(*) FILTER (WHERE is_estimated) AS estimated_accounts
     FROM consumption_settlement WHERE tenant_id=$1 AND status='FINAL'
     GROUP BY period)
   SELECT d.period, d.due_accounts, s.settled_accounts, s.estimated_accounts,
          CASE WHEN d.due_accounts>0
               THEN round(s.estimated_accounts::numeric/d.due_accounts,4) END
            AS est_over_due,
          CASE WHEN s.settled_accounts>0
               THEN round(s.estimated_accounts::numeric/s.settled_accounts,4) END
            AS est_over_settled
   FROM due d LEFT JOIN settled s ON s.period=d.period
   ORDER BY d.period`,
);

// 3) Recovery-rate numerator candidates — cash vs extinguishment, side by side
await q(
  'RECOVERY_RATE numerator candidates per period',
  `WITH billed AS (
     SELECT period, sum(total_amount) AS billed
     FROM bill WHERE tenant_id=$1 AND bill_kind<>'REVERSAL'
       AND status IN ('POSTED','PARTIAL_PAID','PAID') GROUP BY period),
   cash AS (
     SELECT b.period, sum(a.amount) AS cash_recovery
     FROM payment_alloc a
     JOIN payment p ON p.tenant_id=a.tenant_id AND p.id=a.payment_id
     JOIN bill b ON b.tenant_id=a.tenant_id AND b.id=a.bill_id
     WHERE a.tenant_id=$1 AND a.source='PAYMENT'
       AND p.status IN ('RECEIVED','DAY_CLOSED') GROUP BY b.period),
   exting AS (
     SELECT b.period, sum(a.amount) AS debt_extinguished
     FROM payment_alloc a
     JOIN bill b ON b.tenant_id=a.tenant_id AND b.id=a.bill_id
     WHERE a.tenant_id=$1 GROUP BY b.period)
   SELECT b.period, b.billed, c.cash_recovery, e.debt_extinguished,
          round(c.cash_recovery::numeric/nullif(b.billed,0),4) AS cash_rate,
          round(e.debt_extinguished::numeric/nullif(b.billed,0),4) AS extinguish_rate
   FROM billed b
   LEFT JOIN cash c ON c.period=b.period
   LEFT JOIN exting e ON e.period=b.period
   ORDER BY b.period`,
);

// 4) shared-settle distribution → does settle span multiple org branches?
await q(
  'shared-settle: settle accounts whose bills span >1 covering org',
  `WITH acct_org AS (
     SELECT DISTINCT bm.water_account_id, rb.org_unit_id
     FROM book_meter bm JOIN reading_book rb
       ON rb.tenant_id=bm.tenant_id AND rb.id=bm.book_id
     WHERE bm.tenant_id=$1),
   settle_org AS (
     SELECT b.settle_account_id, count(DISTINCT ao.org_unit_id) AS orgs,
            count(*) AS bills
     FROM bill b JOIN water_account wa
       ON wa.tenant_id=b.tenant_id AND wa.id=b.water_account_id
     JOIN acct_org ao ON ao.water_account_id=b.water_account_id
     WHERE b.tenant_id=$1 GROUP BY b.settle_account_id)
   SELECT orgs AS distinct_covering_orgs, count(*) AS settle_accounts,
          sum(bills) AS bills
   FROM settle_org GROUP BY orgs ORDER BY orgs`,
);

// 5) E9 closed-loop outcomes (if work_item exists)
try {
await q(
  'work_item outcomes by anomaly_type',
  `SELECT anomaly_type, status, resolution_source,
          count(*) AS episodes,
          round(avg(extract(epoch FROM coalesce(resolved_at,now())-created_at)/3600.0),1)
            AS avg_hours_to_resolve
   FROM work_item WHERE tenant_id=$1
   GROUP BY anomaly_type, status, resolution_source ORDER BY 1,2`,
);
} catch {
  console.log('\n=== work_item outcomes ===\n(table absent — E9 branch not deployed here)');
}

await db.end();
};

main().catch((e) => { console.error(e); process.exit(1); });
