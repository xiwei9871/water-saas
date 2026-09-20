/** Paid estimate recovery: real API/engine, isolated tenant, historical reading fixtures. */
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import request from 'supertest';
import type { Server } from 'node:http';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST ??
  'postgresql://ws_app:ws_app_pw@localhost:5432/watersaas_test';
const owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL_TEST ??
  'postgresql://postgres:postgres@localhost:5432/watersaas_test' });
let app: INestApplication<Server>;
let token: string;
let tenantId: string;
let staffId: string;
const code = `recovery-${randomUUID().slice(0, 8)}`;
const post = (path: string, body: object) =>
  request(app.getHttpServer()).post(path).auth(token, { type: 'bearer' }).send(body);
const get = (path: string) => request(app.getHttpServer()).get(path).auth(token, { type: 'bearer' });

beforeAll(async () => {
  const tenant = await owner.tenant.create({ data: { code, name: '估水恢复回归', status: 'ACTIVE' } });
  tenantId = tenant.id;
  const org = await owner.orgUnit.create({ data: { tenantId, name: '测试营业所', type: 'COMPANY' } });
  const role = await owner.role.create({ data: { tenantId, code: 'admin', name: '管理员', dataScope: 'ALL' } });
  const staff = await owner.staff.create({ data: { tenantId, orgUnitId: org.id,
    login: 'admin', name: '回归管理员', passwordHash: await bcrypt.hash('recovery-pass', 10), status: 'ACTIVE' } });
  staffId = staff.id;
  await owner.staffRole.create({ data: { tenantId, staffId, roleId: role.id } });
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = module.createNestApplication();
  await app.listen(0, '127.0.0.1');
  token = (await request(app.getHttpServer()).post('/auth/login')
    .send({ tenantCode: code, login: 'admin', password: 'recovery-pass' }).expect(201)).body.accessToken;
}, 30_000);
afterAll(async () => { await app?.close(); await owner.$disconnect(); });

async function reading(a: any, period: string, value: number) {
  return owner.meterReading.create({ data: { tenantId, installationId: a.installation.id,
    meterId: a.meter.id, period, readDate: new Date(`${period.slice(0, 4)}-${period.slice(4)}-28`),
    resultType: 'ACTUAL', readingValue: value, qcStatus: 'PASSED', qcBy: staffId, qcAt: new Date(),
    source: 'WEB', operatorId: staffId } });
}
async function settlement(a: any, period: string, extra = {}) {
  return (await post('/consumption-settlements', { waterAccountId: a.waterAccount.id, period, ...extra }).expect(201)).body;
}
async function billAndPay(a: any, s: any, pay = true) {
  await post(`/consumption-settlements/${s.id}/finalize`, {}).expect(201);
  const run = (await post('/billing-runs', { period: s.period }).expect(201)).body;
  await post(`/billing-runs/${run.id}/post`, {}).expect(201);
  const bill = await owner.bill.findFirstOrThrow({ where: { tenantId, sourceId: s.id, billKind: 'NORMAL' } });
  if (pay && bill.totalAmount > 0n) {
    await post('/payments', { settleAccountId: a.settleAccount.id, channel: 'CASH',
      amount: bill.totalAmount.toString(), allocs: [{ billId: bill.id, amount: bill.totalAmount.toString() }] }).expect(201);
  }
  return bill;
}
async function accountFixture(maxDial: number | null, tiered = true, tierLimit = 260, firstPrice = '3') {
  const category = `EXAMPLE-${randomUUID().slice(0, 8)}`;
  const fee = (await post('/fee-items', { code: category, name: '示例水费（非地方政策）', calcType: 'PER_QTY' }).expect(201)).body;
  const tiers = tiered
    ? [{ feeItemId: fee.id, tierNo: 1, fromQty: 0, toQty: tierLimit, unitPrice: firstPrice },
       { feeItemId: fee.id, tierNo: 2, fromQty: tierLimit, toQty: null, unitPrice: '5' }]
    : [{ feeItemId: fee.id, tierNo: 1, fromQty: 0, toQty: null, unitPrice: '3' }];
  const tariff = (await post('/tariff-plans', { code: category, name: category, usageCategory: category,
    effectiveFrom: '2026-01-01', tiers }).expect(201)).body;
  await post(`/tariff-plans/${tariff.id}/activate`, {}).expect(201);
  const a = (await post('/water-accounts/onboard', {
    customer: { name: category, custType: 'PERSONAL' },
    account: { usageCategory: category, addr: '跨年估水回归地址', openedAt: '2025-12-30' },
    meter: { brand: 'recovery', ...(maxDial === null ? {} : { maxDial }) },
    installation: { initialReading: 0, installedAt: '2025-12-30' },
  }).expect(201)).body;
  return a;
}
async function fixture(maxDial: number | null, tiered = true) {
  const a = await accountFixture(maxDial, tiered);
  for (const [i, dial] of [20, 42, 59, 80, 101, 124, 154, 175, 205, 235, 250].entries()) {
    const period = `2026${String(i + 1).padStart(2, '0')}`;
    await reading(a, period, dial);
    await billAndPay(a, await settlement(a, period));
  }
  const preview = (await post('/estimate/preview', { waterAccountId: a.waterAccount.id, period: '202612' }).expect(200)).body;
  expect(preview).toMatchObject({ suggestedUsage: '25', basis: { historyUsageQtys: ['30', '30', '15'] } });
  const estimate = await settlement(a, '202612', { estimateReason: '表污无法抄表' });
  expect(estimate).toMatchObject({ totalUsageQty: '25', isEstimated: true });
  expect(estimate.components[0]).toMatchObject({ prevReadingValue: '250', endReadingValue: '275', sourceType: 'ESTIMATE' });
  const bill = await billAndPay(a, estimate);
  expect(bill.totalAmount).toBe(tiered ? 10500n : 7500n);
  const actual = await reading(a, '202701', 265);
  return { a, estimate, bill, actual };
}

describe('estimated dial is never a rollover anchor', () => {
  for (const maxDial of [null, 10000]) {
    it(`requires reconciliation before settlement, maxDial=${maxDial}`, async () => {
      const { a } = await fixture(maxDial);
      const response = await post('/consumption-settlements', { waterAccountId: a.waterAccount.id, period: '202701' });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('ESTIMATE_RECOVERY_REQUIRES_RECONCILIATION');
      expect(await owner.consumptionSettlement.count({ where: { tenantId, waterAccountId: a.waterAccount.id, period: '202701' } })).toBe(0);
    }, 60_000);
  }
});

it('same-year adjustment restores the remaining annual tier quota', async () => {
  const a = await accountFixture(10000, true, 270);
  await reading(a, '202601', 250);
  await billAndPay(a, await settlement(a, '202601'));
  await billAndPay(a, await settlement(a, '202602', { usageQty: 25, estimateReason: '表污，人工核定25' }));
  const actual = await reading(a, '202603', 265);
  const correction = (await post('/reconciliations', { waterAccountId: a.waterAccount.id, actualReadingId: actual.id }).expect(201)).body;
  expect(correction.adjustmentAmountCent).toBe('-4000');
  await billAndPay(a, await settlement(a, '202603'));
  await reading(a, '202604', 280);
  const next = await settlement(a, '202604');
  expect(next.totalUsageQty).toBe('15');
  // Correct cumulative use is265, not the uncorrected estimated275:
  // 5m³ ×3 +10m³ ×5 =65 yuan, not75.
  expect((await billAndPay(a, next, false)).totalAmount).toBe(6500n);
}, 60_000);

it('a later correction replaces an earlier quantity correction instead of subtracting both', async () => {
  const a = await accountFixture(10000, true, 270);
  await reading(a, '202601', 250);
  await billAndPay(a, await settlement(a, '202601'));
  await billAndPay(a, await settlement(a, '202602', { usageQty: 25, estimateReason: '人工核定25' }));
  const first = await reading(a, '202603', 265);
  await post('/reconciliations', { waterAccountId: a.waterAccount.id, actualReadingId: first.id }).expect(201);
  await billAndPay(a, await settlement(a, '202603'));
  const revised = await reading(a, '202603', 260);
  await owner.meterReading.update({ where: { id: revised.id }, data: { supersedesReadingId: first.id } });
  const result = (await post('/reconciliations', { waterAccountId: a.waterAccount.id, actualReadingId: revised.id }).expect(201)).body;
  expect(result.adjustmentAmountCent).toBe('-1500');
  await reading(a, '202604', 280);
  const next = await settlement(a, '202604');
  expect(next.components[0]).toMatchObject({ prevReadingValue: '260', usageQty: '20' });
  expect((await billAndPay(a, next, false)).totalAmount).toBe(8000n);
}, 60_000);

it('a corrected dial remains the checkpoint when the recovery month has no settlement', async () => {
  const { a, actual } = await fixture(10000);
  await post('/reconciliations', { waterAccountId: a.waterAccount.id, actualReadingId: actual.id }).expect(201);
  await reading(a, '202702', 280);
  expect((await settlement(a, '202702')).components[0]).toMatchObject({ prevReadingValue: '265', usageQty: '15' });
}, 60_000);

it('an older same-month reconciliation cannot replace a later settled actual dial', async () => {
  const { a, actual } = await fixture(10000);
  await post('/reconciliations', { waterAccountId: a.waterAccount.id, actualReadingId: actual.id }).expect(201);
  const later = await reading(a, '202701', 270);
  await owner.meterReading.update({ where: { id: later.id }, data: { readDate: new Date('2027-01-30') } });
  const january = await settlement(a, '202701');
  expect(january.totalUsageQty).toBe('5');
  await billAndPay(a, january, false);
  await reading(a, '202702', 280);
  expect((await settlement(a, '202702')).components[0]).toMatchObject({ prevReadingValue: '270', usageQty: '10' });
}, 60_000);

it('a zero-money adjustment still corrects the annual quantity cursor', async () => {
  const a = await accountFixture(10000, true, 300, '0');
  await reading(a, '202601', 250);
  await billAndPay(a, await settlement(a, '202601'));
  await billAndPay(a, await settlement(a, '202602', { usageQty: 25, estimateReason: '免费档内估水' }));
  const actual = await reading(a, '202603', 265);
  const result = (await post('/reconciliations', { waterAccountId: a.waterAccount.id, actualReadingId: actual.id }).expect(201)).body;
  expect(result).toMatchObject({ status: 'APPLIED', remainderUsage: '-10', adjustmentAmountCent: '0' });
  await billAndPay(a, await settlement(a, '202603'));
  await reading(a, '202604', 305);
  // Remaining free quantity =300−265=35, leaving5m³ charged at5 yuan.
  expect((await billAndPay(a, await settlement(a, '202604'), false)).totalAmount).toBe(2500n);
}, 60_000);

it('a zero-money correction can restore the original estimated quantity', async () => {
  const a = await accountFixture(10000, true, 300, '0');
  await reading(a, '202601', 250);
  await billAndPay(a, await settlement(a, '202601'));
  await billAndPay(a, await settlement(a, '202602', { usageQty: 25, estimateReason: '免费档内估水' }));
  const first = await reading(a, '202603', 265);
  await post('/reconciliations', { waterAccountId: a.waterAccount.id, actualReadingId: first.id }).expect(201);
  await billAndPay(a, await settlement(a, '202603'));
  const revised = await reading(a, '202603', 275);
  await owner.meterReading.update({ where: { id: revised.id }, data: { supersedesReadingId: first.id } });
  const result = (await post('/reconciliations', { waterAccountId: a.waterAccount.id, actualReadingId: revised.id }).expect(201)).body;
  expect(result.adjustmentAmountCent).toBe('0');
  await reading(a, '202604', 305);
  const next = await settlement(a, '202604');
  expect(next.components[0]).toMatchObject({ prevReadingValue: '275', usageQty: '30' });
  // Restore annual usage to275:25 free +5 charged; old correction must not survive.
  expect((await billAndPay(a, next, false)).totalAmount).toBe(2500n);
}, 60_000);

describe('paid estimate → adjustment → settlement → next actual', () => {
  for (const tiered of [false, true]) {
    it(`preserves money and dial across year boundary (${tiered ? 'tiered' : 'flat'} example tariff)`, async () => {
      const { a, estimate, bill, actual } = await fixture(10000, tiered);
      const frozen = await owner.consumptionComponent.findMany({ where: { tenantId, settlementId: estimate.id } });
      const key = randomUUID();
      const reconcile = () => post('/reconciliations', { waterAccountId: a.waterAccount.id, actualReadingId: actual.id })
        .set('Idempotency-Key', key);
      const result = (await reconcile().expect(201)).body;
      expect(result).toMatchObject({ actualTotalUsage: '15', previouslySettledUsage: '25', remainderUsage: '-10',
        status: 'APPLIED', adjustmentAmountCent: tiered ? '-5000' : '-3000' });
      expect((await reconcile().expect(201)).body.id).toBe(result.id);
      await post('/reconciliations', { waterAccountId: a.waterAccount.id, actualReadingId: actual.id }).expect(409);
      expect(await owner.bill.findUniqueOrThrow({ where: { id: bill.id } })).toMatchObject({ status: 'PAID', totalAmount: bill.totalAmount });
      expect(await owner.consumptionComponent.findMany({ where: { tenantId, settlementId: estimate.id } })).toEqual(frozen);
      const jan = await settlement(a, '202701');
      expect(jan.totalUsageQty).toBe('0');
      expect(jan.components[0]).toMatchObject({ prevReadingValue: '265', endReadingValue: '265', usageQty: '0', sourceType: 'READING' });
      expect((await billAndPay(a, jan)).totalAmount).toBe(0n);
      expect((await get(`/water-accounts/${a.waterAccount.id}/outstanding`).expect(200)).body.totalOutstanding)
        .toBe(tiered ? '-5000' : '-3000');
      await reading(a, '202702', 280);
      const feb = await settlement(a, '202702');
      expect(feb.components[0]).toMatchObject({ prevReadingValue: '265', endReadingValue: '280', usageQty: '15' });
      // Natural-year reset: new year uses tier1, never last year's tier2.
      expect((await billAndPay(a, feb, false)).totalAmount).toBe(4500n);
      expect((await get(`/water-accounts/${a.waterAccount.id}/outstanding`).expect(200)).body.totalOutstanding)
        .toBe(tiered ? '-500' : '1500');
    }, 60_000);
  }
});
