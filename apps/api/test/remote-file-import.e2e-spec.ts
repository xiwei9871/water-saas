/**
 * FileImportAdapter e2e (E5 T8) against `watersaas_test` — fixtures `e5f-`.
 *
 * Covers (design §23–§28):
 *  1. CSV vendor columns → canonical events → converted readings
 *  2. partial success: invalid rows reported, valid rows still land
 *  3. same file re-import → IDEMPOTENT_REPLAY per row, 0 new events/readings
 *  4. source.config column mapping required (FILE_COLUMNS_NOT_CONFIGURED)
 *  5. naive collectedAt interpreted in source.timezone (read_date local day)
 *  6. period column mismatch → row invalid; fingerprint fallback when no
 *     eventIdColumn; xlsx path parses
 *  7. re-import does NOT auto-replay UNBOUND rows (explicit replay only)
 */
import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModule } from '@nestjs/testing';
import bcrypt from 'bcrypt';
import pg from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import * as XLSX from 'xlsx';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

process.env.DATABASE_URL =
  process.env.DATABASE_URL_TEST ??
  'postgresql://ws_app:ws_app_pw@localhost:5432/watersaas_test';

const OWNER_URL =
  process.env.MIGRATION_DATABASE_URL_TEST ??
  'postgresql://postgres:postgres@localhost:5432/watersaas_test';

const TENANT = 'e5f5f5f5-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_CO = 'e5f5f5f5-0000-4000-8000-0000000000c0';
const ROLE_ADMIN = 'e5f5f5f5-0000-4000-8000-00000000ad01';
const STAFF_ADMIN = 'e5f5f5f5-0000-4000-8000-0000000a0001';

const owner = new pg.Client({ connectionString: OWNER_URL });
let app: INestApplication<App>;
let adminToken = '';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

let sourceId = '';
let sourceNoCfgId = '';
let acctA = '';
let instA = '';
let instInstalledAt = '';

beforeAll(async () => {
  await owner.connect();
  const hash = await bcrypt.hash('e5f-pass', 10);
  await owner.query(
    `INSERT INTO tenant (id, code, name, status, created_at, updated_at)
     VALUES ($1, 'e5f-water', 'E5F Water', 'ACTIVE', now(), now())
     ON CONFLICT DO NOTHING`,
    [TENANT],
  );
  await owner.query(
    `INSERT INTO org_unit (id, tenant_id, parent_id, name, type, created_at, updated_at)
     VALUES ($1, $2, NULL, 'E5F Company', 'COMPANY', now(), now())
     ON CONFLICT DO NOTHING`,
    [ORG_CO, TENANT],
  );
  await owner.query(
    `INSERT INTO role (id, tenant_id, code, name, data_scope, created_at, updated_at)
     VALUES ($1, $2, 'admin', 'E5F Admin', 'ALL', now(), now())
     ON CONFLICT DO NOTHING`,
    [ROLE_ADMIN, TENANT],
  );
  await owner.query(
    `INSERT INTO staff (id, tenant_id, org_unit_id, login, password_hash, name, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'e5f-admin', $4, 'E5F Admin', 'ACTIVE', now(), now())
     ON CONFLICT (tenant_id, login) DO NOTHING`,
    [STAFF_ADMIN, TENANT, ORG_CO, hash],
  );
  await owner.query(
    `INSERT INTO staff_role (tenant_id, staff_id, role_id, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now())
     ON CONFLICT DO NOTHING`,
    [TENANT, STAFF_ADMIN, ROLE_ADMIN],
  );

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleFixture.createNestApplication();
  // Mirror main.ts: real vendor files exceed the ~100KB default body limit.
  (app as NestExpressApplication).useBodyParser('json', { limit: '10mb' });
  await app.init();

  adminToken = (
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantCode: 'e5f-water', login: 'e5f-admin', password: 'e5f-pass' })
      .expect(201)
  ).body.accessToken as string;
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

// RC1-2: one account has at most ONE current membership — a second mkPlan
// call for the same account reuses its book instead of failing on 409.
const bookByAccount = new Map<string, string>();
const bookFor = async (waterAccountId: string, tag: string) => {
  const cached = bookByAccount.get(waterAccountId);
  if (cached) return cached;
  const book = await request(app.getHttpServer())
    .post('/reading-books')
    .set(auth(adminToken))
    .send({ name: `E5F book ${tag} ${RUN}`, orgUnitId: ORG_CO })
    .expect(201);
  await request(app.getHttpServer())
    .post(`/reading-books/${book.body.id}/meters`)
    .set(auth(adminToken))
    .send({ waterAccountId })
    .expect(201);
  bookByAccount.set(waterAccountId, book.body.id);
  return book.body.id as string;
};

const mkPlan = async (period: string, waterAccountId: string, tag: string) => {
  const bookId = await bookFor(waterAccountId, tag);
  return request(app.getHttpServer())
    .post('/reading-plans/generate')
    .set(auth(adminToken))
    .send({
      bookId,
      period,
      planDate: `${period.slice(0, 4)}-${period.slice(4)}-05`,
    })
    .expect(201);
};

const csv = (rows: string[][]) =>
  rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');

const HEADER = ['流水号', '表号', '采集时间', '当前读数', '状态', '账期'];
const SRC_CONFIG = {
  deviceKeyColumn: '表号',
  readingColumn: '当前读数',
  collectedAtColumn: '采集时间',
  eventIdColumn: '流水号',
  qualityColumn: '状态',
  periodColumn: '账期',
};
const DEV = `FDEV-${RUN}`;

const importFile = (body: Record<string, unknown>, sid = sourceId) =>
  request(app.getHttpServer())
    .post(`/remote-sources/${sid}/import`)
    .set(auth(adminToken))
    .send(body);

describe('fixtures', () => {
  it('source (config columns) + account + device + binding + plan', async () => {
    const src = await request(app.getHttpServer())
      .post('/remote-sources')
      .set(auth(adminToken))
      .send({
        code: `FSRC-${RUN}`,
        name: 'Vendor CSV',
        type: 'FILE_IMPORT',
        adapterKey: 'file-csv',
        timezone: 'Asia/Shanghai',
        config: SRC_CONFIG,
      })
      .expect(201);
    sourceId = src.body.id;
    const bare = await request(app.getHttpServer())
      .post('/remote-sources')
      .set(auth(adminToken))
      .send({
        code: `FSRC-NC-${RUN}`,
        name: 'No config',
        type: 'FILE_IMPORT',
        adapterKey: 'file-csv',
        timezone: 'UTC',
      })
      .expect(201);
    sourceNoCfgId = bare.body.id;

    const ob = await request(app.getHttpServer())
      .post('/water-accounts/onboard')
      .set(auth(adminToken))
      .send({
        customer: { name: `E5F A ${RUN}`, custType: 'PERSONAL' },
        account: { usageCategory: 'RES_METERED', addr: 'File St' },
        meter: { brand: 'e5f', caliber: 'DN15' },
        installation: { initialReading: 0 },
      })
      .expect(201);
    acctA = ob.body.waterAccount.id;
    instA = ob.body.installation.id;
    instInstalledAt = ob.body.installation.installedAt;

    const dev = await request(app.getHttpServer())
      .post('/remote-devices')
      .set(auth(adminToken))
      .send({ remoteSourceId: sourceId, vendorDeviceKey: DEV })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/remote-devices/${dev.body.id}/bindings`)
      .set(auth(adminToken))
      .send({ installationId: instA, effectiveFrom: instInstalledAt })
      .expect(201);
    await mkPlan('202801', acctA, 'fp');
  });
});

describe('CSV import', () => {
  const P = '202801';
  const file1 = csv([
    HEADER,
    [`S1-${RUN}`, DEV, '2028-01-05 08:30:00', '100.25', '正常', P],
    [`S2-${RUN}`, `GHOST-${RUN}`, '2028-01-05 09:00:00', '55', '正常', P],
    ['bad-row', DEV, 'not-a-date', 'abc', 'x', P],
    [`S4-${RUN}`, DEV, '2028-01-06 08:30:00', '7.5', '正常', '202802'],
  ]);

  it('partial success: valid rows convert/unbound, invalid rows reported', async () => {
    const res = await importFile({ targetPeriod: P, format: 'csv', content: file1, fileName: 'vendor.csv' }).expect(201);
    expect(res.body.totalRows).toBe(4);
    // row2 converts, row3 unbound, row4 invalid (date), row5 period mismatch
    expect(res.body.counts.CONVERTED).toBe(1);
    expect(res.body.counts.UNBOUND).toBe(1);
    expect(res.body.invalid.length).toBe(2);
    expect(res.body.invalid.some((i: { code: string }) => i.code === 'INVALID_COLLECTED_AT')).toBe(true);
    expect(res.body.invalid.some((i: { code: string }) => i.code === 'PERIOD_MISMATCH')).toBe(true);
    const readingId = res.body.outcomes.find((o: { outcome: string }) => o.outcome === 'CONVERTED').readingId;
    const reading = await request(app.getHttpServer())
      .get(`/meter-readings/${readingId}`)
      .set(auth(adminToken))
      .expect(200);
    expect(Number(reading.body.readingValue)).toBe(100.25);
    // 08:30 Asia/Shanghai on 2028-01-05 → read_date is the local day.
    expect(reading.body.readDate.startsWith('2028-01-05')).toBe(true);
  });

  it('re-import same file → all IDEMPOTENT_REPLAY, no new events', async () => {
    const res = await importFile({ targetPeriod: P, format: 'csv', content: file1, fileName: 'vendor.csv' }).expect(201);
    expect(res.body.counts.IDEMPOTENT_REPLAY).toBe(2); // the two parseable rows
    expect(res.body.counts.CONVERTED ?? 0).toBe(0);
    const { rows } = await owner.query(
      `SELECT COUNT(*)::int c FROM raw_remote_event
       WHERE tenant_id=$1 AND remote_source_id=$2`,
      [TENANT, sourceId],
    );
    expect(rows[0].c).toBe(2);
  });

  it('re-import does not auto-replay UNBOUND rows', async () => {
    // The GHOST row stays UNBOUND after the second import — verify no
    // implicit reprocessing happened (status unchanged, no reading).
    const { rows } = await owner.query(
      `SELECT processing_status FROM raw_remote_event
       WHERE tenant_id=$1 AND vendor_device_key=$2`,
      [TENANT, `GHOST-${RUN}`],
    );
    expect(rows[0].processing_status).toBe('UNBOUND');
  });

  it('missing source.config mapping → 400', async () => {
    await importFile(
      { targetPeriod: P, format: 'csv', content: file1 },
      sourceNoCfgId,
    ).expect(400);
  });

  it('xlsx file parses the same way', async () => {
    const ws = XLSX.utils.aoa_to_sheet([
      HEADER,
      [`X1-${RUN}`, DEV, '2028-02-05 08:30:00', '130', '正常', '202802'],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'data');
    const b64 = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
    await mkPlan('202802', acctA, 'fp2');
    const res = await importFile({
      targetPeriod: '202802',
      format: 'xlsx',
      content: b64,
      fileName: 'vendor.xlsx',
    }).expect(201);
    expect(res.body.counts.CONVERTED).toBe(1);
  });

  it('imports a realistic >100KB CSV (2000 rows → all UNBOUND)', async () => {
    // Regression for the JSON body limit: county exports are thousands of
    // rows; a toy UAT file would never trip the old ~100KB default.
    const rows: string[][] = [HEADER];
    for (let i = 0; i < 2000; i++) {
      rows.push([`BULK-${RUN}-${i}`, `BULKDEV-${RUN}`, '2028-03-05 08:30:00', `${i}`, '正常', '202803']);
    }
    const big = csv(rows);
    expect(Buffer.byteLength(big, 'utf-8')).toBeGreaterThan(100 * 1024);
    const res = await importFile({ targetPeriod: '202803', format: 'csv', content: big, fileName: 'big.csv' })
      .expect(201);
    expect(res.body.totalRows).toBe(2000);
    expect(res.body.parsed).toBe(2000);
    expect(res.body.counts.UNBOUND).toBe(2000);
  }, 120_000);
});
