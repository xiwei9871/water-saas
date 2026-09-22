/**
 * E6 Prepayment DB invariants against `watersaas_test` — fixtures `e6s-`.
 *
 * Covers domain design §3/§7/§21:
 *  - ledger + payment_alloc append-only (ws_app UPDATE/DELETE/TRUNCATE 42501)
 *  - ledger type-shape CHECKs (TOP_UP/APPLY/REFUND/REVERSAL)
 *  - payment_alloc source XOR CHECK
 *  - composite FKs: alloc (tenant, entry, bill) → ledger (tenant, id, bill)
 *    and ledger (tenant, settle, payment|bill|entry) → same principal
 *  - UNIQUE idempotency_key, receipt (tenant,payment), alloc (tenant, entry)
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DATABASE_URL =
  process.env.DATABASE_URL_TEST ??
  'postgresql://ws_app:ws_app_pw@localhost:5432/watersaas_test';

const OWNER_URL =
  process.env.MIGRATION_DATABASE_URL_TEST ??
  'postgresql://postgres:postgres@localhost:5432/watersaas_test';
const APP_URL =
  process.env.DATABASE_URL_TEST ??
  'postgresql://ws_app:ws_app_pw@localhost:5432/watersaas_test';

const TENANT = 'e6e6e6e6-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG = 'e6e6e6e6-0000-4000-8000-0000000000c0';
const STAFF = 'e6e6e6e6-0000-4000-8000-0000000a0001';
const SETTLE = 'e6e6e6e6-0000-4000-8000-000000005001';
const SETTLE2 = 'e6e6e6e6-0000-4000-8000-000000005002';
const CUST = 'e6e6e6e6-0000-4000-8000-00000000c001';
const WACC = 'e6e6e6e6-0000-4000-8000-00000000aa01';
const BILL = 'e6e6e6e6-0000-4000-8000-00000000bb01';
const BILL2 = 'e6e6e6e6-0000-4000-8000-00000000bb02';
const PAYMENT = 'e6e6e6e6-0000-4000-8000-00000000ff01';
const TOPUP = 'e6e6e6e6-0000-4000-8000-00000000e001';
const APPLY = 'e6e6e6e6-0000-4000-8000-00000000e002';
const APPLY2 = 'e6e6e6e6-0000-4000-8000-00000000e003';
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

const owner = new pg.Client({ connectionString: OWNER_URL });
const app = new pg.Client({ connectionString: APP_URL });

const expectPgError = async (fn: () => Promise<unknown>, code: string) => {
  try {
    await fn();
  } catch (e) {
    expect(e).toMatchObject({ code });
    return;
  }
  throw new Error(`expected PostgreSQL error ${code}`);
};

beforeAll(async () => {
  await owner.connect();
  await app.connect();
  await owner.query(
    `INSERT INTO tenant (id, code, name, status, created_at, updated_at)
     VALUES ($1,'e6s-water','E6S Water','ACTIVE',now(),now()) ON CONFLICT DO NOTHING`,
    [TENANT],
  );
  await owner.query(
    `INSERT INTO org_unit (id, tenant_id, parent_id, name, type, created_at, updated_at)
     VALUES ($1,$2,NULL,'E6S Co','COMPANY',now(),now()) ON CONFLICT DO NOTHING`,
    [ORG, TENANT],
  );
  await owner.query(
    `INSERT INTO staff (id, tenant_id, org_unit_id, login, password_hash, name, status, created_at, updated_at)
     VALUES ($1,$2,$3,'e6s-admin','x','E6S','ACTIVE',now(),now())
     ON CONFLICT (tenant_id, login) DO NOTHING`,
    [STAFF, TENANT, ORG],
  );
  for (const [id, no] of [
    [SETTLE, 'e6s-settle-1'],
    [SETTLE2, 'e6s-settle-2'],
  ] as const) {
    await owner.query(
      `INSERT INTO settle_account (id, tenant_id, settle_no, name, status, created_at, updated_at)
       VALUES ($1,$2,$3,'S','NORMAL',now(),now()) ON CONFLICT DO NOTHING`,
      [id, TENANT, no],
    );
  }
  await owner.query(
    `INSERT INTO customer (id, tenant_id, customer_no, name, cust_type, created_at, updated_at)
     VALUES ($1,$2,'e6s-c-1','C','PERSONAL',now(),now()) ON CONFLICT DO NOTHING`,
    [CUST, TENANT],
  );
  await owner.query(
    `INSERT INTO water_account (id, tenant_id, account_no, customer_id, settle_account_id, usage_category, addr, status, created_at, updated_at)
     VALUES ($1,$2,'e6s-wa-1',$3,$4,'RES_METERED','x','NORMAL',now(),now()) ON CONFLICT DO NOTHING`,
    [WACC, TENANT, CUST, SETTLE],
  );
  for (const id of [BILL, BILL2]) {
    await owner.query(
      `INSERT INTO bill (id, tenant_id, settle_account_id, water_account_id, period, bill_kind, source_type, source_id, status, total_amount, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'202801','NORMAL','MANUAL',$5,'POSTED',10000,now(),now()) ON CONFLICT DO NOTHING`,
      [id, TENANT, SETTLE, WACC, id],
    );
  }
  await owner.query(
    `INSERT INTO payment (id, tenant_id, payment_no, settle_account_id, cashier_id, org_unit_id, channel, amount, status, received_at, created_at, updated_at)
     VALUES ($1,$2,'e6s-p-1',$3,$4,$5,'CASH',20000,'RECEIVED',now(),now(),now()) ON CONFLICT DO NOTHING`,
    [PAYMENT, TENANT, SETTLE, STAFF, ORG],
  );
  // A clean TOP_UP + APPLY pair other tests reference.
  await owner.query(
    `INSERT INTO prepayment_ledger_entry
       (id, tenant_id, settle_account_id, type, amount, payment_id, origin_top_up_id, idempotency_key, created_at)
     VALUES ($1,$2,$3,'TOP_UP',12000,$4,NULL,'e6s-topup-1',now())
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
    [TOPUP, TENANT, SETTLE, PAYMENT],
  );
  await owner.query(
    `INSERT INTO prepayment_ledger_entry
       (id, tenant_id, settle_account_id, type, amount, bill_id, origin_top_up_id, idempotency_key, created_at)
     VALUES ($1,$2,$3,'APPLY',-6000,$4,$5,'e6s-apply-1',now())
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
    [APPLY, TENANT, SETTLE, BILL, TOPUP],
  );
  // Second APPLY on BILL2 — used by the wrong-bill FK test (never alloc'd).
  await owner.query(
    `INSERT INTO prepayment_ledger_entry
       (id, tenant_id, settle_account_id, type, amount, bill_id, origin_top_up_id, idempotency_key, created_at)
     VALUES ($1,$2,$3,'APPLY',-6000,$4,$5,'e6s-apply-2',now())
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
    [APPLY2, TENANT, SETTLE, BILL2, TOPUP],
  );
  // Fixture PREPAYMENT alloc on APPLY (the "already settled" leg).
  await owner.query(
    `INSERT INTO payment_alloc (id, tenant_id, source, prepayment_entry_id, bill_id, amount, created_at, updated_at)
     VALUES (gen_random_uuid(),$1,'PREPAYMENT',$2,$3,6000,now(),now())
     ON CONFLICT (tenant_id, prepayment_entry_id) DO NOTHING`,
    [TENANT, APPLY, BILL],
  );
});

afterAll(async () => {
  await owner.end();
  await app.end();
});

describe('append-only hardening (ws_app)', () => {
  it('ledger UPDATE/DELETE/TRUNCATE → 42501; INSERT stays allowed', async () => {
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT]);
    const ins = await app.query(
      `INSERT INTO prepayment_ledger_entry
         (id, tenant_id, settle_account_id, type, amount, bill_id, origin_top_up_id, idempotency_key, created_at)
       VALUES (gen_random_uuid(),$1,$2,'APPLY',-100,$3,$4,$5,now()) RETURNING id`,
      [TENANT, SETTLE, BILL, TOPUP, `e6s-ap-allowed-${RUN}`],
    );
    expect(ins.rows[0].id).toBeTruthy();
    await app.query('COMMIT');

    await expectPgError(
      () =>
        app.query(
          `UPDATE prepayment_ledger_entry SET amount=0 WHERE id=$1`,
          [TOPUP],
        ),
      '42501',
    );
    await expectPgError(
      () => app.query(`DELETE FROM prepayment_ledger_entry WHERE id=$1`, [TOPUP]),
      '42501',
    );
    await expectPgError(
      () => app.query(`TRUNCATE prepayment_ledger_entry`),
      '42501',
    );
  });

  it('payment_alloc UPDATE/DELETE/TRUNCATE → 42501', async () => {
    await expectPgError(
      () => app.query(`UPDATE payment_alloc SET amount=0 WHERE tenant_id=$1`, [TENANT]),
      '42501',
    );
    await expectPgError(
      () => app.query(`DELETE FROM payment_alloc WHERE tenant_id=$1`, [TENANT]),
      '42501',
    );
    await expectPgError(() => app.query(`TRUNCATE payment_alloc`), '42501');
  });
});

describe('ledger type-shape CHECKs', () => {
  // amount, payment_id, bill_id, origin_top_up_id, reversal_of_entry_id, reason
  const bad = (type: string, vals: unknown[]) =>
    expectPgError(
      () =>
        owner.query(
          `INSERT INTO prepayment_ledger_entry
             (id, tenant_id, settle_account_id, type, amount, payment_id, bill_id,
              origin_top_up_id, reversal_of_entry_id, reason, idempotency_key, created_at)
           VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,gen_random_uuid()::text,now())`,
          [TENANT, SETTLE, type, ...vals],
        ),
      '23514',
    );

  it('rejects malformed rows per type', async () => {
    // TOP_UP with a bill_id / without payment / negative amount
    await bad('TOP_UP', [100, null, BILL, null, null, null]);
    await bad('TOP_UP', [-5, PAYMENT, null, null, null, null]);
    // APPLY positive / missing bill / missing origin / carrying payment
    await bad('APPLY', [100, null, BILL, TOPUP, null, null]);
    await bad('APPLY', [-100, null, null, TOPUP, null, null]);
    await bad('APPLY', [-100, PAYMENT, BILL, TOPUP, null, null]);
    // REFUND positive / missing origin / missing reason / missing payment
    await bad('REFUND', [100, PAYMENT, null, TOPUP, null, 'r']);
    await bad('REFUND', [-100, PAYMENT, null, TOPUP, null, null]);
    await bad('REFUND', [-100, null, null, TOPUP, null, 'r']);
    // REVERSAL missing target / missing origin / missing reason
    await bad('REVERSAL', [-100, null, null, TOPUP, null, 'r']);
    await bad('REVERSAL', [-100, null, null, TOPUP, APPLY, null]);
  });
});

describe('composite FK / unique invariants', () => {
  it('PREPAYMENT alloc pointing at an entry of a DIFFERENT bill → 23503', async () => {
    await expectPgError(
      () =>
        owner.query(
          `INSERT INTO payment_alloc (id, tenant_id, source, prepayment_entry_id, bill_id, amount, created_at, updated_at)
           VALUES (gen_random_uuid(),$1,'PREPAYMENT',$2,$3,6000,now(),now())`,
          [TENANT, APPLY2, BILL], // entry lives on BILL2, alloc claims BILL
        ),
      '23503',
    );
  });

  it('PREPAYMENT alloc consistent (entry.bill_id = alloc.bill_id) lands; 1:1 enforced', async () => {
    // Fixture alloc on APPLY landed in beforeAll — assert it exists, then
    // prove a second alloc on the same settlement entry is rejected.
    const r = await owner.query(
      `SELECT id FROM payment_alloc WHERE tenant_id=$1 AND prepayment_entry_id=$2`,
      [TENANT, APPLY],
    );
    expect(r.rows.length).toBe(1);
    await expectPgError(
      () =>
        owner.query(
          `INSERT INTO payment_alloc (id, tenant_id, source, prepayment_entry_id, bill_id, amount, created_at, updated_at)
           VALUES (gen_random_uuid(),$1,'PREPAYMENT',$2,$3,6000,now(),now())`,
          [TENANT, APPLY, BILL],
        ),
      '23505',
    );
  });

  it('ledger payment FK enforces same settle_account', async () => {
    // TOP_UP on SETTLE2 but pointing at PAYMENT (which lives on SETTLE)
    await expectPgError(
      () =>
        owner.query(
          `INSERT INTO prepayment_ledger_entry
             (id, tenant_id, settle_account_id, type, amount, payment_id, idempotency_key, created_at)
           VALUES (gen_random_uuid(),$1,$2,'TOP_UP',500,$3,gen_random_uuid()::text,now())`,
          [TENANT, SETTLE2, PAYMENT],
        ),
      '23503',
    );
  });

  it('ledger bill FK enforces same settle_account', async () => {
    await expectPgError(
      () =>
        owner.query(
          `INSERT INTO prepayment_ledger_entry
             (id, tenant_id, settle_account_id, type, amount, bill_id, origin_top_up_id, idempotency_key, created_at)
           VALUES (gen_random_uuid(),$1,$2,'APPLY',-500,$3,$4,gen_random_uuid()::text,now())`,
          [TENANT, SETTLE2, BILL, TOPUP], // BILL lives on SETTLE, not SETTLE2
        ),
      '23503',
    );
  });

  it('origin_top_up_id self-reference → 23514', async () => {
    // prepay_entry_no_self_origin: an entry can never be its own lot.
    await expectPgError(
      () =>
        owner.query(
          `INSERT INTO prepayment_ledger_entry
             (id, tenant_id, settle_account_id, type, amount, bill_id,
              origin_top_up_id, idempotency_key, created_at)
           VALUES ('e6e1f000-0000-4000-8000-000000000001',$1,$2,'APPLY',-500,$3,
                   'e6e1f000-0000-4000-8000-000000000001',gen_random_uuid()::text,now())`,
          [TENANT, SETTLE, BILL],
        ),
      '23514',
    );
  });

  it('idempotency_key unique per tenant', async () => {
    await expectPgError(
      () =>
        owner.query(
          `INSERT INTO prepayment_ledger_entry
             (id, tenant_id, settle_account_id, type, amount, payment_id, idempotency_key, created_at)
           VALUES (gen_random_uuid(),$1,$2,'TOP_UP',500,$3,'e6s-topup-1',now())`,
          [TENANT, SETTLE, PAYMENT],
        ),
      '23505',
    );
  });

  it('receipt (tenant, payment) unique', async () => {
    await owner.query(
      `INSERT INTO receipt (id, tenant_id, payment_id, receipt_no, created_at, updated_at)
       VALUES (gen_random_uuid(),$1,$2,'e6s-r-1',now(),now()) ON CONFLICT DO NOTHING`,
      [TENANT, PAYMENT],
    );
    await expectPgError(
      () =>
        owner.query(
          `INSERT INTO receipt (id, tenant_id, payment_id, receipt_no, created_at, updated_at)
           VALUES (gen_random_uuid(),$1,$2,'e6s-r-2',now(),now())`,
          [TENANT, PAYMENT],
        ),
      '23505',
    );
  });

  it('payment_alloc source XOR: payment+entry → 23514', async () => {
    await expectPgError(
      () =>
        owner.query(
          `INSERT INTO payment_alloc (id, tenant_id, source, payment_id, prepayment_entry_id, bill_id, amount, created_at, updated_at)
           VALUES (gen_random_uuid(),$1,'PAYMENT',$2,$3,$4,100,now(),now())`,
          [TENANT, PAYMENT, APPLY, BILL],
        ),
      '23514',
    );
  });
});
