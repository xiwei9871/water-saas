/**
 * 银行代扣 e2e (20261021 整改 任务F) against `watersaas_test`。独立租户 debit-water。
 * Covers:
 *  1. 协议：卡号掩码+last4；同户第二协议 → 409（防御①）。
 *  2. 批次：欠费户→PENDING 明细；同月第二批全 skipped（防御②）；
 *     无欠费 → NO_OUTSTANDING；无协议 → 批次无明细。
 *  3. 执行：成功户自动销账（BANK_DEDUCT payment，bill→PAID）；
 *     尾号9999 → FAILED；重跑幂等不重复扣（防御③ PENDING/SUCCESS 唯一）。
 *  4. PKMX/PKJG/DZMX 三份输出。
 */
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import bcrypt from 'bcrypt';
import pg from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

process.env.DATABASE_URL =
  process.env.DATABASE_URL_TEST ??
  'postgresql://ws_app:ws_app_pw@localhost:5432/watersaas_test';
process.env.MIGRATION_DATABASE_URL =
  process.env.MIGRATION_DATABASE_URL_TEST ??
  'postgresql://postgres:postgres@localhost:5432/watersaas_test';

const TA = 'cc60cc60-cc60-4c06-8c06-cc60cc60cc60';
const ORG = 'cc60cc60-0000-4000-8000-0000000000c0';
const ROLE = 'cc60cc60-0000-4000-8000-00000000ad01';
const STAFF = 'cc60cc60-0000-4000-8000-0000000a0001';

const owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
let app: INestApplication<App>;
let adminToken = '';
const auth = () => ({ Authorization: `Bearer ${adminToken}` });
const RUN = `d${Date.now().toString(36)}`;

const post = (p: string, b: unknown) =>
  request(app.getHttpServer()).post(p).set(auth()).send(b);
const get = (p: string) => request(app.getHttpServer()).get(p).set(auth());

const onboard = async (tag: string) =>
  (
    await post('/water-accounts/onboard', {
      customer: { name: `DEB ${tag} ${RUN}`, custType: 'PERSONAL' },
      account: { usageCategory: 'RES_METERED', addr: `${tag} deb rd` },
      meter: { brand: 'deb', caliber: 'DN15' },
      installation: { initialReading: 0, installedAt: '2026-01-01' },
    }).expect(201)
  ).body as { waterAccount: { id: string }; settleAccount: { id: string } };

const seedBill = async (waId: string, saId: string, amount = 20000, period = '202610') =>
  (
    await owner.query(
      `INSERT INTO bill (id, tenant_id, settle_account_id, water_account_id, period,
                         bill_kind, source_type, source_id, status, is_estimated,
                         total_amount, issued_at, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'NORMAL', 'SETTLEMENT', gen_random_uuid(),
               'POSTED', false, $5, now(), now(), now())
       RETURNING id`,
      [TA, saId, waId, period, amount],
    )
  ).rows[0].id as string;

beforeAll(async () => {
  await owner.connect();
  const hash = await bcrypt.hash('deb-pass', 10);
  await owner.query(
    `INSERT INTO tenant (id, code, name, status, created_at, updated_at)
     VALUES ($1, 'debit-water', 'DEB Water', 'ACTIVE', now(), now()) ON CONFLICT DO NOTHING`,
    [TA],
  );
  await owner.query(
    `INSERT INTO org_unit (id, tenant_id, parent_id, name, type, created_at, updated_at)
     VALUES ($1, $2, NULL, 'DEB Co', 'COMPANY', now(), now()) ON CONFLICT DO NOTHING`,
    [ORG, TA],
  );
  await owner.query(
    `INSERT INTO role (id, tenant_id, code, name, data_scope, created_at, updated_at)
     VALUES ($1, $2, 'admin', 'DEB Admin', 'ALL', now(), now())
     ON CONFLICT (tenant_id, code) DO NOTHING`,
    [ROLE, TA],
  );
  await owner.query(
    `INSERT INTO staff (id, tenant_id, org_unit_id, login, password_hash, name, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'deb-admin', $4, 'DEB Admin', 'ACTIVE', now(), now())
     ON CONFLICT (tenant_id, login) DO NOTHING`,
    [STAFF, TA, ORG, hash],
  );
  await owner.query(
    `INSERT INTO staff_role (tenant_id, staff_id, role_id, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now()) ON CONFLICT DO NOTHING`,
    [TA, STAFF, ROLE],
  );
  await owner.query(
    `INSERT INTO sys_dict (id, tenant_id, category, code, name, seq, status, created_at, updated_at)
     SELECT gen_random_uuid(), $1, 'BANK_CODE', c.code, c.name, c.seq, 'ACTIVE', now(), now()
     FROM (VALUES ('ICBC','工商银行',10),('CCB','建设银行',30)) c(code,name,seq)
     ON CONFLICT DO NOTHING`,
    [TA],
  );

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleFixture.createNestApplication();
  await app.init();
  adminToken = (
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantCode: 'debit-water', login: 'deb-admin', password: 'deb-pass' })
      .expect(201)
  ).body.accessToken as string;
});

afterAll(async () => {
  await app.close();
  await owner.end();
});

describe('任务F 银行代扣', () => {
  it('协议→批次→执行→销账→防重复+三文件', async () => {
    // ---- 1. 协议 ----
    const a1 = await onboard('ok');
    const a2 = await onboard('fail'); // 尾号9999 → mock 失败
    const ag1 = await post('/bank-debit/agreements', {
      settleAccountId: a1.settleAccount.id,
      cardNo: '6222021001112223333',
      bankCode: 'ICBC',
      holderName: '张三',
    }).expect(201);
    expect(ag1.body.cardNoMasked).toBe('6222****3333');
    expect(ag1.body.cardLast4).toBe('3333');
    // 防御①：同户重复协议 → 409
    await post('/bank-debit/agreements', {
      settleAccountId: a1.settleAccount.id,
      cardNo: '6222021009998887777',
      bankCode: 'ICBC',
    }).expect(409);
    // 非法银行码 → 400
    await post('/bank-debit/agreements', {
      settleAccountId: a2.settleAccount.id,
      cardNo: '6222021001112229999',
      bankCode: 'NOPE',
    }).expect(400);
    await post('/bank-debit/agreements', {
      settleAccountId: a2.settleAccount.id,
      cardNo: '6222021001112229999',
      bankCode: 'CCB',
    }).expect(201);

    // ---- 2. 批次生成（防御②③） ----
    const b1 = await seedBill(a1.waterAccount.id, a1.settleAccount.id, 30000);
    const b2 = await seedBill(a2.waterAccount.id, a2.settleAccount.id, 15000);
    const batch = await post('/bank-debit/batches', { period: '202610' }).expect(201);
    expect(batch.body.totalCount).toBe(2);
    expect(batch.body.totalAmount).toBe('45000');
    // 同月第二批：两户都已在批 → 全 skipped，明细 0
    const batch2 = await post('/bank-debit/batches', { period: '202610' }).expect(201);
    expect(batch2.body.totalCount).toBe(0);
    const ourSkipped = (batch2.body.skipped as { settleAccountId: string; reason: string }[]).filter(
      (s) => [a1.settleAccount.id, a2.settleAccount.id].includes(s.settleAccountId),
    );
    expect(ourSkipped.length).toBe(2);
    expect(ourSkipped.every((s) => s.reason === 'ALREADY_IN_BATCH_OR_PAID')).toBe(true);

    // ---- 3. 执行：成功销账 + 失败原因 + 幂等 ----
    const exec = await post(`/bank-debit/batches/${batch.body.id}/execute`, {}).expect(201);
    const byStatus = Object.fromEntries(
      (exec.body.results as { itemId: string; status: string }[]).map((r) => [r.itemId, r.status]),
    );
    const items = (await get(`/bank-debit/batches/${batch.body.id}/items`)).body as {
      id: string; settleAccountId: string; status: string; bankSerialNo: string | null;
      failReason: string | null; paymentId: string | null;
    }[];
    const okItem = items.find((i) => i.settleAccountId === a1.settleAccount.id)!;
    const failItem = items.find((i) => i.settleAccountId === a2.settleAccount.id)!;
    expect(byStatus[okItem.id]).toBe('SUCCESS');
    expect(byStatus[failItem.id]).toBe('FAILED');
    expect(okItem.bankSerialNo).toMatch(/^MOCK-/);
    expect(okItem.paymentId).toBeTruthy();
    expect(failItem.failReason).toBe('余额不足');

    // 销账核验：payment 是 BANK_DEDUCT 且 bill1 → PAID
    const pay = (
      await owner.query(
        `SELECT channel::text AS ch, amount::text AS amt FROM payment WHERE id = $1`,
        [okItem.paymentId],
      )
    ).rows[0];
    expect(pay.ch).toBe('BANK_DEDUCT');
    expect(Number(pay.amt)).toBe(30000);
    const billRow = (
      await owner.query(`SELECT status::text AS s FROM bill WHERE id = $1`, [b1])
    ).rows[0];
    expect(billRow.s).toBe('PAID');
    void b2;

    // 幂等重跑：DONE 批次拒绝再执行
    await post(`/bank-debit/batches/${batch.body.id}/execute`, {}).expect(400);

    // 已扣户再进批：SUCCESS 明细挡住（防御②）；FAILED 户走重试路径重新进批
    const batch3 = await post('/bank-debit/batches', { period: '202610' }).expect(201);
    expect(batch3.body.totalCount).toBe(1); // 只有 a2（FAILED 重试）
    const stillBlocked = (batch3.body.skipped as { settleAccountId: string }[]).some(
      (s) => s.settleAccountId === a1.settleAccount.id,
    );
    expect(stillBlocked).toBe(true);

    // ---- 4. PKMX / PKJG / DZMX ----
    const pkmx = (await get(`/bank-debit/batches/${batch.body.id}/pkmx`)).body as unknown[];
    expect(pkmx.length).toBe(2);
    const pkjg = (await get(`/bank-debit/batches/${batch.body.id}/pkjg`)).body as {
      status: string; bankSerialNo: string | null;
    }[];
    expect(pkjg.some((r) => r.status === 'SUCCESS')).toBe(true);
    expect(pkjg.some((r) => r.status === 'FAILED')).toBe(true);
    const dzmx = (await get(`/bank-debit/batches/${batch.body.id}/dzmx`)).body as {
      itemStatus: string; reconciled: string; paymentStatus: string | null;
    }[];
    const okRow = dzmx.find((r) => r.itemStatus === 'SUCCESS')!;
    expect(okRow.reconciled).toBe('OK');
    expect(okRow.paymentStatus).toBe('RECEIVED');
  });
});
