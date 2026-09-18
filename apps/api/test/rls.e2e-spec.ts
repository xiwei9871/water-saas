/**
 * RLS verification against the test database (`watersaas_test`).
 *
 * Proves, with raw `pg` connections (no Prisma):
 *  1. ws_app inside a transaction-local set_config('app.tenant_id', id, true)
 *     sees only that tenant's rows — including the `tenant` table itself.
 *  2. The setting is transaction-local: once the pooled connection is
 *     returned and reused (pool max=1 → same physical backend), queries
 *     without set_config return 0 rows — no tenant context residue.
 *  3. FORCE RLS really binds the table owner: tables are owned by
 *     `ws_owner` (non-superuser, NOBYPASSRLS); via `SET ROLE ws_owner` the
 *     same isolation applies. (postgres itself is a superuser and always
 *     bypasses RLS, so owner-level proof requires a non-superuser owner.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

const APP_URL =
  process.env.DATABASE_URL_TEST ??
  'postgresql://ws_app:ws_app_pw@localhost:5432/watersaas_test';
const OWNER_URL =
  process.env.MIGRATION_DATABASE_URL_TEST ??
  'postgresql://postgres:postgres@localhost:5432/watersaas_test';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

const owner = new pg.Client({ connectionString: OWNER_URL });

beforeAll(async () => {
  await owner.connect();
  // Fixtures via the superuser connection (bypasses RLS), idempotent.
  for (const [id, code] of [
    [TENANT_A, 'rls-a'],
    [TENANT_B, 'rls-b'],
  ] as const) {
    await owner.query(
      `INSERT INTO tenant (id, code, name, status, created_at, updated_at)
       VALUES ($1, $2, $2, 'ACTIVE', now(), now()) ON CONFLICT DO NOTHING`,
      [id, code],
    );
    await owner.query(
      `INSERT INTO customer (id, tenant_id, customer_no, name, cust_type, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $2, 'PERSONAL', now(), now())
       ON CONFLICT DO NOTHING`,
      [id, `cust-${code}`],
    );
  }
});

afterAll(async () => {
  await owner.end();
});

describe('tenant RLS', () => {
  it('ws_app sees only the configured tenant inside the transaction', async () => {
    const client = new pg.Client({ connectionString: APP_URL });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
      const a = await client.query('SELECT customer_no FROM customer ORDER BY 1');
      expect(a.rows.map((r) => r.customer_no)).toEqual(['cust-rls-a']);
      // tenant table isolates on its own id, not tenant_id
      const t = await client.query('SELECT code FROM tenant');
      expect(t.rows.map((r) => r.code)).toEqual(['rls-a']);
      await client.query('COMMIT');

      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_B]);
      const b = await client.query('SELECT customer_no FROM customer ORDER BY 1');
      expect(b.rows.map((r) => r.customer_no)).toEqual(['cust-rls-b']);
      await client.query('COMMIT');
    } finally {
      await client.end();
    }
  });

  it('leaves no tenant context on the pooled connection after the transaction', async () => {
    // max:1 forces the second client onto the same physical backend.
    const pool = new pg.Pool({ connectionString: APP_URL, max: 1 });
    try {
      const c1 = await pool.connect();
      await c1.query('BEGIN');
      await c1.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
      const inside = await c1.query('SELECT count(*)::int AS n FROM customer');
      expect(inside.rows[0].n).toBe(1);
      await c1.query('COMMIT');
      c1.release();

      const c2 = await pool.connect();
      try {
        const res = await c2.query('SELECT count(*)::int AS n FROM customer');
        expect(res.rows[0].n).toBe(0);
        const tenants = await c2.query('SELECT count(*)::int AS n FROM tenant');
        expect(tenants.rows[0].n).toBe(0);
      } finally {
        c2.release();
      }
    } finally {
      await pool.end();
    }
  });

  it('FORCE RLS binds the non-superuser table owner too', async () => {
    // Every business table must have ENABLE + FORCE row level security.
    const flags = await owner.query(
      `SELECT count(*)::int AS n FROM pg_class
       WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
         AND relname <> '_prisma_migrations'
         AND (relrowsecurity IS DISTINCT FROM true OR relforcerowsecurity IS DISTINCT FROM true)`,
    );
    expect(flags.rows[0].n).toBe(0);

    // postgres is a superuser (always bypasses RLS); SET ROLE to the real
    // non-superuser owner to prove FORCE actually applies to the owner.
    const ownerConn = new pg.Client({ connectionString: OWNER_URL });
    await ownerConn.connect();
    try {
      await ownerConn.query('SET ROLE ws_owner');
      const none = await ownerConn.query('SELECT count(*)::int AS n FROM customer');
      expect(none.rows[0].n).toBe(0);

      await ownerConn.query('BEGIN');
      await ownerConn.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
      const onlyA = await ownerConn.query('SELECT customer_no FROM customer');
      expect(onlyA.rows.map((r) => r.customer_no)).toEqual(['cust-rls-a']);
      await ownerConn.query('COMMIT');

      const noneAgain = await ownerConn.query('SELECT count(*)::int AS n FROM customer');
      expect(noneAgain.rows[0].n).toBe(0);
    } finally {
      await ownerConn.end();
    }
  });
});
