/**
 * E5 Remote Reading V1 — DB invariant verification (Domain Design §34).
 *
 * Runs raw `pg` against `watersaas_test` (no Nest/Prisma): owner connection
 * seeds fixtures (bypasses RLS), ws_app connection proves RLS/privilege
 * invariants. Covers the Database layer of the frozen test matrix:
 *   binding overlap / range checks (exclusion + CHECK)
 *   externalEventKey uniqueness (tenant, source, key)
 *   meter_reading sourceEventId / operator_id CHECKs
 *   raw_remote_event payload immutability (trigger)
 *   remote_event_process_log append-only (REVOKE)
 *   RLS cross-tenant isolation on all new tables
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

const APP_URL =
  process.env.DATABASE_URL_TEST ??
  'postgresql://ws_app:ws_app_pw@localhost:5432/watersaas_test';
const OWNER_URL =
  process.env.MIGRATION_DATABASE_URL_TEST ??
  'postgresql://postgres:postgres@localhost:5432/watersaas_test';

const TENANT_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const TENANT_B = 'bbbbbbbb-2222-4222-8222-222222222222';

const owner = new pg.Client({ connectionString: OWNER_URL });
const app = new pg.Client({ connectionString: APP_URL });

let sourceId: string;
let deviceId: string;
let device2Id: string;
let installationId: string;
let meterId: string;
let eventId: string;

const expectPgError = async (fn: () => Promise<unknown>, code: string) => {
  await expect(fn()).rejects.toMatchObject({ code });
};

beforeAll(async () => {
  await owner.connect();
  await app.connect();

  for (const [id, code] of [
    [TENANT_A, 'e5-a'],
    [TENANT_B, 'e5-b'],
  ] as const) {
    await owner.query(
      `INSERT INTO tenant (id, code, name, status, created_at, updated_at)
       VALUES ($1, $2, $2, 'ACTIVE', now(), now()) ON CONFLICT DO NOTHING`,
      [id, code],
    );
  }

  // Clean any leftovers from a previous run (children before parents; the
  // superuser owner bypasses RLS and the append-only REVOKE applies to ws_app
  // only). Scope deletes to this spec's tenants and keys.
  for (const t of [TENANT_A, TENANT_B]) {
    await owner.query(
      `DELETE FROM meter_reading WHERE tenant_id=$1 AND source_event_id IS NOT NULL`,
      [t],
    );
    await owner.query(
      `DELETE FROM remote_event_process_log WHERE tenant_id=$1`,
      [t],
    );
    await owner.query(`DELETE FROM raw_remote_event WHERE tenant_id=$1`, [t]);
    await owner.query(
      `DELETE FROM remote_device_binding WHERE tenant_id=$1`,
      [t],
    );
    await owner.query(`DELETE FROM remote_device WHERE tenant_id=$1`, [t]);
    await owner.query(
      `DELETE FROM remote_source WHERE tenant_id=$1 AND code='e5-src'`,
      [t],
    );
  }

  // Account chain: customer → settle_account → water_account → meter → installation.
  await owner.query(
    `INSERT INTO customer (id, tenant_id, customer_no, name, cust_type, created_at, updated_at)
     VALUES ('cccccccc-1111-4111-8111-111111111111', $1, 'e5-cust', 'E5 Cust', 'PERSONAL', now(), now())
     ON CONFLICT DO NOTHING`,
    [TENANT_A],
  );
  await owner.query(
    `INSERT INTO settle_account (id, tenant_id, settle_no, name, status, created_at, updated_at)
     VALUES ('dddddddd-1111-4111-8111-111111111111', $1, 'e5-settle', 'E5 Settle', 'NORMAL', now(), now())
     ON CONFLICT DO NOTHING`,
    [TENANT_A],
  );
  await owner.query(
    `INSERT INTO water_account (id, tenant_id, account_no, customer_id, settle_account_id, usage_category, addr, status, billable, created_at, updated_at)
     VALUES ('eeeeeeee-1111-4111-8111-111111111111', $1, 'e5-acct', 'cccccccc-1111-4111-8111-111111111111', 'dddddddd-1111-4111-8111-111111111111', 'RES_METERED', 'E5 addr', 'NORMAL', true, now(), now())
     ON CONFLICT DO NOTHING`,
    [TENANT_A],
  );
  const m = await owner.query(
    `INSERT INTO meter (id, tenant_id, meter_no, status, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, 'e5-meter', 'INSTALLED', now(), now())
     ON CONFLICT DO NOTHING RETURNING id`,
    [TENANT_A],
  );
  meterId = m.rows[0]?.id ?? (
    await owner.query(
      `SELECT id FROM meter WHERE tenant_id=$1 AND meter_no='e5-meter'`,
      [TENANT_A],
    )
  ).rows[0].id;
  const inst = await owner.query(
    `INSERT INTO meter_installation (id, tenant_id, water_account_id, meter_id, installed_at, initial_reading, reason, status, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, 'eeeeeeee-1111-4111-8111-111111111111', $2, '2026-01-01', 0, 'NEW', 'ACTIVE', now(), now())
     ON CONFLICT DO NOTHING RETURNING id`,
    [TENANT_A, meterId],
  );
  installationId = inst.rows[0]?.id ?? (
    await owner.query(
      `SELECT id FROM meter_installation WHERE tenant_id=$1 AND meter_id=$2`,
      [TENANT_A, meterId],
    )
  ).rows[0].id;

  // Remote source + devices.
  const src = await owner.query(
    `INSERT INTO remote_source (id, tenant_id, code, name, type, adapter_key, timezone, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, 'e5-src', 'E5 Source', 'FILE_IMPORT', 'FILE_GENERIC_V1', 'Asia/Shanghai', now(), now())
     ON CONFLICT DO NOTHING RETURNING id`,
    [TENANT_A],
  );
  sourceId = src.rows[0]?.id ?? (
    await owner.query(
      `SELECT id FROM remote_source WHERE tenant_id=$1 AND code='e5-src'`,
      [TENANT_A],
    )
  ).rows[0].id;
  const insertDevice = async (key: string) => {
    const r = await owner.query(
      `INSERT INTO remote_device (id, tenant_id, remote_source_id, vendor_device_key, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, now(), now())
       ON CONFLICT DO NOTHING RETURNING id`,
      [TENANT_A, sourceId, key],
    );
    return (
      r.rows[0]?.id ??
      (
        await owner.query(
          `SELECT id FROM remote_device WHERE tenant_id=$1 AND remote_source_id=$2 AND vendor_device_key=$3`,
          [TENANT_A, sourceId, key],
        )
      ).rows[0].id
    );
  };
  deviceId = await insertDevice('D001');
  device2Id = await insertDevice('D002');

  const ev = await owner.query(
    `INSERT INTO raw_remote_event (id, tenant_id, remote_source_id, external_event_key, canonical_payload_hash, vendor_device_key, business_period, collected_at, reading_value, raw_payload, canonical_payload, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'evt-001', 'hash-001', 'D001', '202609', '2026-09-21T00:00:00Z', 123.45, '{}'::jsonb, '{}'::jsonb, now(), now())
     ON CONFLICT DO NOTHING RETURNING id`,
    [TENANT_A, sourceId],
  );
  eventId =
    ev.rows[0]?.id ??
    (
      await owner.query(
        `SELECT id FROM raw_remote_event WHERE tenant_id=$1 AND remote_source_id=$2 AND external_event_key='evt-001'`,
        [TENANT_A, sourceId],
      )
    ).rows[0].id;
});

afterAll(async () => {
  await app.end();
  await owner.end();
});

describe('remote_device_binding invariants', () => {
  it('rejects overlapping ranges for the same device (exclusion)', async () => {
    await owner.query(
      `INSERT INTO remote_device_binding (id, tenant_id, remote_source_id, remote_device_id, installation_id, effective_from, effective_to, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, '2026-01-01T00:00:00Z', '2026-06-15T10:23:00Z', now(), now())`,
      [TENANT_A, sourceId, deviceId, installationId],
    );
    await expectPgError(
      () =>
        owner.query(
          `INSERT INTO remote_device_binding (id, tenant_id, remote_source_id, remote_device_id, installation_id, effective_from, effective_to, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, '2026-06-01T00:00:00Z', NULL, now(), now())`,
          [TENANT_A, sourceId, deviceId, installationId],
        ),
      '23P01',
    );
  });

  it('accepts adjacent half-open ranges for the same device', async () => {
    // Second installation on another meter — same device, contiguous range.
    const m2 = await owner.query(
      `INSERT INTO meter (id, tenant_id, meter_no, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'e5-meter-2', 'INSTALLED', now(), now())
       ON CONFLICT DO NOTHING RETURNING id`,
      [TENANT_A],
    );
    const meter2Id =
      m2.rows[0]?.id ??
      (
        await owner.query(
          `SELECT id FROM meter WHERE tenant_id=$1 AND meter_no='e5-meter-2'`,
          [TENANT_A],
        )
      ).rows[0].id;
    const i2 = await owner.query(
      `INSERT INTO meter_installation (id, tenant_id, water_account_id, meter_id, installed_at, initial_reading, reason, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'eeeeeeee-1111-4111-8111-111111111111', $2, '2026-06-15T10:23:00Z', 0, 'REPLACE', 'ACTIVE', now(), now())
       ON CONFLICT DO NOTHING RETURNING id`,
      [TENANT_A, meter2Id],
    );
    const inst2Id =
      i2.rows[0]?.id ??
      (
        await owner.query(
          `SELECT id FROM meter_installation WHERE tenant_id=$1 AND meter_id=$2`,
          [TENANT_A, meter2Id],
        )
      ).rows[0].id;
    const r = await owner.query(
      `INSERT INTO remote_device_binding (id, tenant_id, remote_source_id, remote_device_id, installation_id, effective_from, effective_to, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, '2026-06-15T10:23:00Z', NULL, now(), now()) RETURNING id`,
      [TENANT_A, sourceId, deviceId, inst2Id],
    );
    expect(r.rows[0].id).toBeTruthy();
  });

  it('rejects effective_to <= effective_from (CHECK)', async () => {
    await expectPgError(
      () =>
        owner.query(
          `INSERT INTO remote_device_binding (id, tenant_id, remote_source_id, remote_device_id, installation_id, effective_from, effective_to, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, '2027-01-01T00:00:00Z', '2026-01-01T00:00:00Z', now(), now())`,
          [TENANT_A, sourceId, device2Id, installationId],
        ),
      '23514',
    );
  });

  it('rejects two devices of one source overlapping on one installation', async () => {
    await expectPgError(
      () =>
        owner.query(
          `INSERT INTO remote_device_binding (id, tenant_id, remote_source_id, remote_device_id, installation_id, effective_from, effective_to, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, '2026-02-01T00:00:00Z', '2026-03-01T00:00:00Z', now(), now())`,
          [TENANT_A, sourceId, device2Id, installationId],
        ),
      '23P01',
    );
  });
});

describe('raw_remote_event invariants', () => {
  it('enforces UNIQUE(tenant, source, external_event_key)', async () => {
    await expectPgError(
      () =>
        owner.query(
          `INSERT INTO raw_remote_event (id, tenant_id, remote_source_id, external_event_key, canonical_payload_hash, vendor_device_key, business_period, collected_at, reading_value, raw_payload, canonical_payload, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'evt-001', 'hash-different', 'D001', '202609', '2026-09-21T00:00:00Z', 999, '{}'::jsonb, '{}'::jsonb, now(), now())`,
          [TENANT_A, sourceId],
        ),
      '23505',
    );
  });

  it('same key under a different tenant is a different event', async () => {
    await owner.query(
      `INSERT INTO remote_source (id, tenant_id, code, name, type, adapter_key, timezone, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'e5-src', 'E5 Src B', 'FILE_IMPORT', 'FILE_GENERIC_V1', 'Asia/Shanghai', now(), now())`,
      [TENANT_B],
    );
    const bSrc = await owner.query(
      `SELECT id FROM remote_source WHERE tenant_id=$1 AND code='e5-src'`,
      [TENANT_B],
    );
    const r = await owner.query(
      `INSERT INTO raw_remote_event (id, tenant_id, remote_source_id, external_event_key, canonical_payload_hash, vendor_device_key, business_period, collected_at, reading_value, raw_payload, canonical_payload, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'evt-001', 'hash-001', 'D001', '202609', '2026-09-21T00:00:00Z', 1, '{}'::jsonb, '{}'::jsonb, now(), now()) RETURNING id`,
      [TENANT_B, bSrc.rows[0].id],
    );
    expect(r.rows[0].id).toBeTruthy();
  });

  it('immutable trigger rejects payload/identity UPDATE, allows status UPDATE', async () => {
    await expectPgError(
      () =>
        owner.query(
          `UPDATE raw_remote_event SET raw_payload = '{"tampered":true}'::jsonb WHERE id = $1`,
          [eventId],
        ),
      'P0001',
    );
    await expectPgError(
      () =>
        owner.query(
          `UPDATE raw_remote_event SET collected_at = '2026-09-22T00:00:00Z' WHERE id = $1`,
          [eventId],
        ),
      'P0001',
    );
    await expectPgError(
      () =>
        owner.query(
          `UPDATE raw_remote_event SET reading_value = 999 WHERE id = $1`,
          [eventId],
        ),
      'P0001',
    );
    const ok = await owner.query(
      `UPDATE raw_remote_event SET processing_status='UNBOUND', current_issue_code='DEVICE_UNBOUND', updated_at=now() WHERE id=$1 RETURNING processing_status`,
      [eventId],
    );
    expect(ok.rows[0].processing_status).toBe('UNBOUND');
  });
});

describe('meter_reading remote invariants', () => {
  const insertReading = (opts: {
    resultType: string;
    source: string;
    operatorId: string | null;
    sourceEventId?: string | null;
  }) =>
    owner.query(
      `INSERT INTO meter_reading (id, tenant_id, installation_id, meter_id, period, read_date, result_type, reading_value, source, operator_id, source_event_id, qc_status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, '202609', '2026-09-21', $4, 123.45, $5, $6, $7, 'PENDING', now(), now())`,
      [
        TENANT_A,
        installationId,
        meterId,
        opts.resultType,
        opts.source,
        opts.operatorId,
        opts.sourceEventId ?? null,
      ],
    );

  it('allows adapter REMOTE reading with NULL operator + source_event_id', async () => {
    const r = await insertReading({
      resultType: 'REMOTE',
      source: 'REMOTE',
      operatorId: null,
      sourceEventId: eventId,
    });
    expect(r.rowCount).toBe(1);
  });

  it('rejects a second reading bound to the same raw event', async () => {
    await expectPgError(
      () =>
        insertReading({
          resultType: 'REMOTE',
          source: 'REMOTE',
          operatorId: null,
          sourceEventId: eventId,
        }),
      '23505',
    );
  });

  it('rejects source_event_id on a non-REMOTE reading', async () => {
    // Fresh event so the CHECK (not the sourceEventId unique) is what fires.
    const ev2 = await owner.query(
      `INSERT INTO raw_remote_event (id, tenant_id, remote_source_id, external_event_key, canonical_payload_hash, vendor_device_key, business_period, collected_at, reading_value, raw_payload, canonical_payload, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'evt-002', 'hash-002', 'D001', '202609', '2026-09-21T01:00:00Z', 124, '{}'::jsonb, '{}'::jsonb, now(), now()) RETURNING id`,
      [TENANT_A, sourceId],
    );
    await expectPgError(
      () =>
        insertReading({
          resultType: 'ACTUAL',
          source: 'WEB',
          operatorId: 'ffffffff-1111-4111-8111-111111111111',
          sourceEventId: ev2.rows[0].id,
        }),
      '23514',
    );
  });

  it('rejects NULL operator on human WEB reading', async () => {
    await expectPgError(
      () =>
        insertReading({
          resultType: 'ACTUAL',
          source: 'WEB',
          operatorId: null,
        }),
      '23514',
    );
  });

  it('rejects NULL operator on manual REMOTE reading without source_event_id', async () => {
    await expectPgError(
      () =>
        insertReading({
          resultType: 'REMOTE',
          source: 'REMOTE',
          operatorId: null,
        }),
      '23514',
    );
  });
});

describe('append-only process log', () => {
  it('ws_app may INSERT/SELECT but not UPDATE/DELETE', async () => {
    // INSERT needs the tenant context for the WITH CHECK policy; UPDATE/DELETE
    // then run in autocommit so a rejected statement can't poison a shared
    // transaction and mask the next privilege error.
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
    const ins = await app.query(
      `INSERT INTO remote_event_process_log (id, tenant_id, remote_event_id, action, to_status, actor_type)
       VALUES (gen_random_uuid(), $1, $2, 'STATUS_CHANGE', 'UNBOUND', 'SYSTEM') RETURNING id`,
      [TENANT_A, eventId],
    );
    await app.query('COMMIT');
    const logId = ins.rows[0].id as string;
    const attempts = [
      () =>
        app.query(
          `UPDATE remote_event_process_log SET message='x' WHERE id=$1 AND tenant_id=$2`,
          [logId, TENANT_A],
        ),
      () =>
        app.query(
          `DELETE FROM remote_event_process_log WHERE id=$1 AND tenant_id=$2`,
          [logId, TENANT_A],
        ),
    ];
    for (const attempt of attempts) {
      await expectPgError(attempt, '42501');
    }
  });
});

describe('RLS on new remote tables', () => {
  it('ws_app sees only its own tenant rows; cross-tenant insert blocked', async () => {
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
    const a = await app.query(
      `SELECT count(*)::int AS n FROM remote_source WHERE code='e5-src'`,
    );
    expect(a.rows[0].n).toBe(1);
    const ev = await app.query(
      `SELECT count(*)::int AS n FROM raw_remote_event WHERE external_event_key='evt-001'`,
    );
    expect(ev.rows[0].n).toBe(1);
    await app.query('COMMIT');

    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_B]);
    const bSrc = await app.query(
      `SELECT count(*)::int AS n FROM remote_source WHERE code='e5-src'`,
    );
    expect(bSrc.rows[0].n).toBe(1); // tenant B's own source, not A's
    const bEv = await app.query(
      `SELECT vendor_device_key FROM raw_remote_event WHERE external_event_key='evt-001'`,
    );
    expect(bEv.rows[0].vendor_device_key).toBe('D001');
    // insert pretending to be tenant A under B's context → policy violation
    await expectPgError(
      () =>
        app.query(
          `INSERT INTO remote_device (id, tenant_id, remote_source_id, vendor_device_key, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 'D999', now(), now())`,
          [TENANT_A, sourceId],
        ),
      '42501',
    );
    await app.query('ROLLBACK');
  });
});
