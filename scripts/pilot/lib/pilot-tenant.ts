/**
 * Pilot tenant lifecycle — marker guard, create-tenant, reset.
 * Runs on the migration/owner connection (RLS bypass) AFTER the DB
 * host/name guard has passed. Never "adopts" an unmarked tenant.
 */

import type { Client } from './pg.ts';
import { keys } from './keys.ts';

export class TenantGuardError extends Error {}

export interface TenantRow {
  id: string;
  code: string;
  name: string;
  params: Record<string, unknown> | null;
}

export const PILOT_MARKER = 'pilot-generator';

export const isPilotTenant = (t: TenantRow): boolean =>
  (t.params?.pilot as { generatedBy?: string } | undefined)?.generatedBy ===
  PILOT_MARKER;

export async function findTenant(
  client: Client,
  id: string,
): Promise<TenantRow | null> {
  const { rows } = await client.query<TenantRow>(
    'SELECT id, code, name, params FROM tenant WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

/** --tenant path: must exist AND carry the pilot marker, else abort. */
export async function requireMarkedTenant(
  client: Client,
  id: string,
): Promise<TenantRow> {
  const t = await findTenant(client, id);
  if (!t) throw new TenantGuardError(`tenant ${id} does not exist`);
  if (!isPilotTenant(t)) {
    throw new TenantGuardError(
      `tenant ${id} (${t.code}) is not pilot-marked — refusing to touch a normal tenant`,
    );
  }
  return t;
}

/**
 * --create-tenant path: creates a fresh tenant row with the marker.
 * Org tree / staff / tariff are baseline (G3) concerns — G2 creates the
 * tenant shell only. Fails if code already exists (never reuses).
 */
export async function createPilotTenant(
  client: Client,
  seed: number,
): Promise<TenantRow> {
  const code = keys.tenantCode(seed);
  const { rows } = await client.query<TenantRow>(
    `INSERT INTO tenant (id, code, name, status, params, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'ACTIVE', $3::jsonb, now(), now())
     RETURNING id, code, name, params`,
    [
      code,
      `Pilot Tenant ${code}`,
      JSON.stringify({ pilot: { generatedBy: PILOT_MARKER, seed } }),
    ],
  );
  return rows[0];
}

// ---------------------------------------------------------------------------
// reset — explicit FK-safe order (children → parents). The residual scan
// afterwards is the safety net: any tenant table NOT listed here aborts.
// ---------------------------------------------------------------------------

/** Explicit FK-safe delete order. `tenant` itself is never touched. */
export const TENANT_TABLE_DELETE_ORDER: readonly string[] = [
  'work_item',
  'remote_event_process_log',
  // consumption/meter_reading precede raw_remote_event: readings FK it via
  // source_event_id (remote-converted readings).
  'consumption_component',
  'consumption_settlement',
  'meter_reading',
  'raw_remote_event',
  'remote_device_binding',
  'remote_device',
  'remote_source',
  'cashier_day_close',
  'receipt',
  // payment_alloc.prepayment_entry_id FKs the ledger — alloc first
  'payment_alloc',
  'prepayment_ledger_entry',
  'payment',
  'idempotency_key',
  'bill_item',
  'bill',
  'billing_run',
  'tariff_tier',
  'tariff_plan',
  'fee_item',
  'estimate_rule',
  'reconciliation',
  'reading_plan_item',
  'reading_plan',
  'book_meter',
  'reading_book',
  'account_event',
  'meter_installation',
  'meter',
  'water_account_household_profile',
  'water_account',
  'settle_account',
  'customer',
  'audit_log',
  'sys_sequence',
  'tenant_param',
  'staff_role',
  'role_permission',
  'staff',
  'role',
  'permission',
  'org_unit',
] as const;

/** All public tables that carry a tenant_id column. */
export async function listTenantTables(client: Client): Promise<string[]> {
  const { rows } = await client.query<{ table_name: string }>(
    `SELECT DISTINCT table_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'tenant_id'
      ORDER BY table_name`,
  );
  return rows.map((r) => r.table_name);
}

export interface ResetPlan {
  tenantId: string;
  tableCounts: { table: string; rows: number }[];
  totalRows: number;
  uncoveredTables: string[];
}

export async function planReset(
  client: Client,
  tenantId: string,
): Promise<ResetPlan> {
  const all = await listTenantTables(client);
  const listed = new Set(TENANT_TABLE_DELETE_ORDER);
  const uncoveredTables = all.filter((t) => !listed.has(t));
  const tableCounts: { table: string; rows: number }[] = [];
  for (const t of all) {
    const { rows } = await client.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM "${t}" WHERE tenant_id = $1`,
      [tenantId],
    );
    const n = parseInt(rows[0].c, 10);
    if (n > 0) tableCounts.push({ table: t, rows: n });
  }
  return {
    tenantId,
    tableCounts,
    totalRows: tableCounts.reduce((s, t) => s + t.rows, 0),
    uncoveredTables,
  };
}

/**
 * Execute reset. Caller must have required --reset AND --yes and printed
 * the plan. After deleting, dynamically scans EVERY tenant table for
 * residual rows — any miss aborts the whole run (never continues with
 * leftover data).
 */
export async function executeReset(
  client: Client,
  tenantId: string,
): Promise<{ deletedRows: number; residual: { table: string; rows: number }[] }> {
  const plan = await planReset(client, tenantId);
  if (plan.uncoveredTables.length) {
    throw new TenantGuardError(
      `reset list does not cover tenant tables: ${plan.uncoveredTables.join(', ')} — aborting`,
    );
  }
  let deletedRows = 0;
  await client.query('BEGIN');
  try {
    for (const t of TENANT_TABLE_DELETE_ORDER) {
      const r = await client.query(
        `DELETE FROM "${t}" WHERE tenant_id = $1`,
        [tenantId],
      );
      deletedRows += r.rowCount ?? 0;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
  const residual: { table: string; rows: number }[] = [];
  for (const t of await listTenantTables(client)) {
    const { rows } = await client.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM "${t}" WHERE tenant_id = $1`,
      [tenantId],
    );
    const n = parseInt(rows[0].c, 10);
    if (n > 0) residual.push({ table: t, rows: n });
  }
  if (residual.length) {
    throw new TenantGuardError(
      `reset incomplete — residual rows: ${residual
        .map((r) => `${r.table}=${r.rows}`)
        .join(', ')}`,
    );
  }
  return { deletedRows, residual };
}
