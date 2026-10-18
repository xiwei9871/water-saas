/**
 * RC1 scale evidence — replay a keyed billing-run create against the
 * pilot DB and verify the multi-tx idempotency contract end to end:
 *
 *   idempotency_key: COMPLETED, billing_run_id = run.id,
 *   response_ref persisted in full, same request replays VERBATIM
 *   (replayed:true, stored body returned — generation never re-runs).
 *
 * The keyed create itself happens inside generate.ts (baseline calls
 * createBillingRun with `pilot-br-<tenant8>-<period>`); this script is
 * the post-run check.
 *
 *   cd apps/api && node ../../scripts/pilot/billing-idem-check.ts \
 *     --tenant <tenant-id> --period 202607
 */

import { createHash } from 'node:crypto';
import { assertPilotEnvironment, DbGuardError } from './lib/db-guard.ts';
import { connect } from './lib/pg.ts';
import { requireMarkedTenant } from './lib/pilot-tenant.ts';
import { bootHarness, pilotCtx } from './lib/harness.ts';
import { services } from './lib/baseline/flow.ts';

const fatal = (e: unknown): never => {
  console.error(
    `ABORT: ${e instanceof DbGuardError ? e.message : e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
  );
  process.exit(1);
};

const args = process.argv.slice(2);
const get = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const tenantId = get('--tenant');
const period = get('--period');
const key =
  get('--key') ??
  (tenantId && period
    ? `pilot-br-${tenantId.slice(0, 8)}-${period}`
    : undefined);
if (!tenantId || !period || !/^\d{6}$/.test(period)) {
  fatal(new Error('--tenant <id> --period YYYYMM are required'));
}

async function main(): Promise<void> {
  assertPilotEnvironment(process.env);
  const owner = await connect({
    connectionString:
      process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL,
  });
  const h = await bootHarness();
  try {
    const tenant = await requireMarkedTenant(owner, tenantId!);
    const keyRow = (
      await owner.query<{
        status: string;
        billing_run_id: string | null;
        response_status: number | null;
        response_ref: string | null;
      }>(
        `SELECT status, billing_run_id::text, response_status, response_ref
           FROM idempotency_key WHERE tenant_id=$1 AND key=$2`,
        [tenant.id, key],
      )
    ).rows[0];
    if (!keyRow) throw new Error(`idempotency key not found: ${key}`);
    if (keyRow.status !== 'COMPLETED')
      throw new Error(`key status ${keyRow.status} — expected COMPLETED`);
    if (!keyRow.billing_run_id)
      throw new Error('key billing_run_id NULL — TX0 link missing');
    if (keyRow.response_status !== 201)
      throw new Error(`response_status ${keyRow.response_status} — expected 201`);
    if (!keyRow.response_ref)
      throw new Error('response_ref NULL — response not persisted');

    const run = (
      await owner.query<{ id: string; status: string; generation_status: string }>(
        `SELECT id::text, status, generation_status
           FROM billing_run WHERE tenant_id=$1 AND id=$2`,
        [tenant.id, keyRow.billing_run_id],
      )
    ).rows[0];
    if (!run) throw new Error('linked billing_run missing');
    if (run.generation_status !== 'READY')
      throw new Error(`run generation_status ${run.generation_status}`);

    const billing = await services.billingRun(h);
    const meta = {
      key: key!,
      method: 'POST',
      route: '/billing-runs',
      requestHash: createHash('sha256')
        .update(JSON.stringify({ period }))
        .digest('hex'),
      responseStatus: 201,
    };
    const t0 = Date.now();
    const res = (await billing.create(
      pilotCtx(tenant.id, ''),
      { period },
      meta,
    )) as { replayed: boolean; status: number; body: { id: string } };
    const replayMs = Date.now() - t0;
    if (!res.replayed) throw new Error('same-key request re-ran generation');
    if (res.status !== 201) throw new Error(`replayed status ${res.status}`);
    if (res.body.id !== run.id)
      throw new Error(`replayed run ${res.body.id} != ${run.id}`);
    const stored = JSON.parse(keyRow.response_ref) as { id: string };
    if (JSON.stringify(stored) !== JSON.stringify(res.body))
      throw new Error('replayed body differs from stored response_ref');

    console.log(
      `billing-idem-check PASS: run=${run.id} status=${run.status}/${run.generation_status} ` +
        `key=${key} COMPLETED responseRef=${keyRow.response_ref.length}B ` +
        `replay=${replayMs}ms (verbatim, generation not re-run)`,
    );
  } finally {
    await h.close();
    await owner.end();
  }
}

main().catch(fatal);
