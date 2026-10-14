/**
 * Task center (任务书 T1–T18) — end-to-end on the real API.
 *
 * Covered:
 *  - SUPPLEMENT: QC-confirm detection → task, candidate lookup by permission
 *    + org data-scope (T18), todo visibility, claim race, settlement block
 *    (T9), unlock via reconciliation auto-complete, open-task dedupe.
 *  - METER_REVIEW: entry anomaly (读数倒挂) → task; manual claim→complete.
 *  - COLLECTION: arrears over TASK_RULE threshold → task on payment.
 *  - REVERSAL_APPROVAL: payment reversal → task (billing:write candidates).
 *  - WRITEOFF_APPROVAL: write-off registration → task.
 *  - T16: billing-run marks SETTLEMENT_BLOCKED_BY_TASK for blocked accounts.
 *  - T17: overdue → URGENT + escalatedAt, counted in badge for supervisors.
 *  - T11: alert box lists candidate-less tasks for admins.
 *  - badge shape {todo, escalated, alerts}.
 */
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import request from 'supertest';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST ??
  'postgresql://ws_app:ws_app_pw@localhost:5432/watersaas_test';
const owner = new PrismaClient({
  datasourceUrl: process.env.MIGRATION_DATABASE_URL_TEST ??
    'postgresql://postgres:postgres@localhost:5432/watersaas_test',
});

const T = randomUUID();
const ORG_CO = randomUUID();
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const RUN = `T${Date.now().toString(36)}`.toUpperCase();
const TENANT_CODE = `task-${RUN}`;

let app: INestApplication<Server>;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const post = (p: string, body: unknown, tok = tokens.admin) =>
  request(app.getHttpServer()).post(p).set(auth(tok)).send(body);
const get = (p: string, tok = tokens.admin) =>
  request(app.getHttpServer()).get(p).set(auth(tok));

const login = async (loginName: string) =>
  (
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantCode: TENANT_CODE, login: loginName, password: 'task-pass' })
      .expect(201)
  ).body.accessToken as string;

const PERMS = [
  '*',
  'billing:write',
  'billing:read',
  'metering:qc',
  'payment:write',
  'payment:read',
  'customer:read',
  'iam:write',
];
const ROLES = {
  admin: randomUUID(),
  billAll: randomUUID(),
  billB: randomUUID(),
  qcAll: randomUUID(),
  cashier: randomUUID(),
  plain: randomUUID(),
};

beforeAll(async () => {
  await owner.tenant.create({
    data: { id: T, code: TENANT_CODE, name: 'Task Water', status: 'ACTIVE' },
  });
  await owner.orgUnit.createMany({
    data: [
      { id: ORG_CO, tenantId: T, name: 'Task Co', type: 'COMPANY' },
      { id: ORG_A, tenantId: T, parentId: ORG_CO, name: 'Branch A', type: 'BRANCH' },
      { id: ORG_B, tenantId: T, parentId: ORG_CO, name: 'Branch B', type: 'BRANCH' },
    ],
  });
  const roleRows = [
    { id: ROLES.admin, code: 'admin', name: '管理员', dataScope: 'ALL' },
    { id: ROLES.billAll, code: 'bill-all', name: '营收(全域)', dataScope: 'ALL' },
    { id: ROLES.billB, code: 'bill-b', name: '营收(B区)', dataScope: 'ORG_SUBTREE' },
    { id: ROLES.qcAll, code: 'qc-all', name: '质检(全域)', dataScope: 'ALL' },
    { id: ROLES.cashier, code: 'cashier', name: '收费员', dataScope: 'ALL' },
    { id: ROLES.plain, code: 'plain', name: '查询员', dataScope: 'ORG_SUBTREE' },
  ];
  for (const r of roleRows) {
    await owner.role.create({ data: { tenantId: T, ...r } });
  }
  const permIds = new Map<string, string>();
  for (const code of PERMS) {
    const p = await owner.permission.create({
      data: { tenantId: T, code, type: 'ACTION' },
    });
    permIds.set(code, p.id);
  }
  const grant = async (roleId: string, code: string) =>
    owner.rolePermission.create({
      data: { tenantId: T, roleId, permissionId: permIds.get(code)! },
    });
  await grant(ROLES.admin, '*');
  await grant(ROLES.billAll, 'billing:write');
  await grant(ROLES.billB, 'billing:write');
  await grant(ROLES.qcAll, 'metering:qc');
  await grant(ROLES.cashier, 'payment:write');
  await grant(ROLES.cashier, 'payment:read');
  await grant(ROLES.plain, 'customer:read');

  const hash = await bcrypt.hash('task-pass', 10);
  const staff = [
    { login: 'admin', name: '管理员', role: ROLES.admin, org: ORG_CO },
    { login: 'billerA', name: '营收甲', role: ROLES.billAll, org: ORG_CO },
    { login: 'billerB', name: '营收乙', role: ROLES.billB, org: ORG_B },
    { login: 'qc', name: '质检员', role: ROLES.qcAll, org: ORG_CO },
    { login: 'cashier', name: '收费员', role: ROLES.cashier, org: ORG_CO },
    { login: 'plain', name: '查询员', role: ROLES.plain, org: ORG_A },
  ];
  for (const s of staff) {
    const st = await owner.staff.create({
      data: {
        tenantId: T,
        orgUnitId: s.org,
        login: s.login,
        name: s.name,
        passwordHash: hash,
        status: 'ACTIVE',
      },
    });
    await owner.staffRole.create({
      data: { tenantId: T, staffId: st.id, roleId: s.role },
    });
    ids[`staff_${s.login}`] = st.id;
  }

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleFixture.createNestApplication();
  await app.listen(0, '127.0.0.1');
  for (const s of staff) tokens[s.login] = await login(s.login);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await owner.$disconnect();
});

const onboard = async (label: string) =>
  (
    await post('/water-accounts/onboard', {
      customer: { name: `Task ${label} ${RUN}`, custType: 'PERSONAL' },
      account: { usageCategory: 'RES_METERED', addr: `${label} St` },
      meter: { brand: 'task', caliber: 'DN15' },
      installation: { initialReading: 0, installedAt: '2025-12-30' },
    }).expect(201)
  ).body as {
    waterAccount: { id: string };
    settleAccount: { id: string };
    installation: { id: string };
    meter: { id: string };
  };

let tariffReady = false;
const ensureTariff = async () => {
  if (tariffReady) return;
  const fee = (
    await post('/fee-items', {
      code: `F${RUN}`.slice(0, 38),
      name: '示例水费',
      calcType: 'PER_QTY',
    }).expect(201)
  ).body;
  const tariff = (
    await post('/tariff-plans', {
      code: `TP${RUN}`.slice(0, 38),
      name: '单一价',
      usageCategory: 'RES_METERED',
      effectiveFrom: '2026-01-01',
      tiers: [{ feeItemId: fee.id, tierNo: 1, fromQty: 0, toQty: null, unitPrice: '3' }],
    }).expect(201)
  ).body;
  await post(`/tariff-plans/${tariff.id}/activate`, {}).expect(201);
  tariffReady = true;
};

/** 开户 + 绑 A 区册 + 估水结算(FINAL)。是否开账缴费由调用方决定。 */
const estimatedAccount = async (label: string, period: string, bookOrg = ORG_A) => {
  await ensureTariff();
  const a = await onboard(label);
  const book = await owner.readingBook.create({
    data: { tenantId: T, bookNo: `BK${label}${RUN}`.slice(0, 38), name: `册${label}`, orgUnitId: bookOrg },
  });
  await owner.bookMeter.create({
    data: { tenantId: T, bookId: book.id, waterAccountId: a.waterAccount.id, seqNo: 1 },
  });
  const settlement = (
    await post('/consumption-settlements', {
      waterAccountId: a.waterAccount.id,
      period,
      usageQty: 20,
      estimateReason: '表污',
    }).expect(201)
  ).body;
  await post(`/consumption-settlements/${settlement.id}/finalize`, {}).expect(201);
  return { ...a, settlement };
};

const billAndPay = async (
  a: { settleAccount: { id: string } },
  settlement: { id: string; period: string },
) => {
  const run = (await post('/billing-runs', { period: settlement.period }).expect(201)).body;
  await post(`/billing-runs/${run.id}/post`, {}).expect(201);
  const bill = await owner.bill.findFirstOrThrow({
    where: { tenantId: T, sourceId: settlement.id, billKind: 'NORMAL' },
  });
  if (bill.totalAmount > 0n) {
    await post('/payments', {
      settleAccountId: a.settleAccount.id,
      channel: 'CASH',
      amount: bill.totalAmount.toString(),
      allocs: [{ billId: bill.id, amount: bill.totalAmount.toString() }],
    }).expect(201);
  }
  return bill;
};

const seedReading = (
  a: { installation: { id: string }; meter: { id: string } },
  period: string,
  value: number,
  qcStatus = 'PENDING',
) =>
  owner.meterReading.create({
    data: {
      tenantId: T,
      installationId: a.installation.id,
      meterId: a.meter.id,
      period,
      readDate: new Date(`${period.slice(0, 4)}-${period.slice(4)}-25`),
      resultType: 'ACTUAL',
      readingValue: value,
      qcStatus,
      source: 'WEB',
      operatorId: ids.staff_admin,
    },
  });

describe('T5/T6/T9 SUPPLEMENT 补差任务全链路', () => {
  it('QC 确认实抄<估抄 → 任务生成且候选人按权限+数据范围反查', async () => {
    const a = await estimatedAccount('sup', '202601');
    await billAndPay(a, a.settlement);
    ids.supAcct = a.waterAccount.id;
    // 核销 span=(anchor.period, actual.period]：锚点必须在估抄账期之前。
    // 锚=开户底度0（可信读数行），实际止度15 < 估抄止度20 → 估高场景。
    await seedReading(a, '202512', 0, 'PASSED');
    const reading = await seedReading(a, '202602', 15);
    ids.supReading = reading.id;

    const qc = await post(`/meter-readings/${reading.id}/qc`, { action: 'pass' });
    expect(qc.status).toBe(201);
    expect(qc.body.supplementTask).toMatchObject({ deduped: false });
    expect(qc.body.supplementTask.id).toBeTruthy();
    // T18：候选人 = admin(*) + billerA(billing:write, ALL)；billerB 同权限但
    // 数据范围在 B 区、锚定册在 A 区 → 排除。
    const names = qc.body.supplementTask.candidates.map((c: { name: string }) => c.name);
    expect(names).toContain('管理员');
    expect(names).toContain('营收甲');
    expect(names).not.toContain('营收乙');
    expect(names).not.toContain('收费员');

    const task = await owner.task.findFirstOrThrow({
      where: { tenantId: T, type: 'SUPPLEMENT', bizId: a.waterAccount.id },
    });
    ids.supTask = task.id;
    expect(task).toMatchObject({
      status: 'PENDING',
      requiredPerm: 'billing:write',
      orgUnitId: ORG_A,
      candidateCount: 2,
    });
    const ctx = task.context as Record<string, unknown>;
    expect(ctx.period).toBe('202602');
    expect(ctx.diff).toBe('-5');
  }, 60_000);

  it('待办可见性：候选人可见，同权限异区/无权限不可见', async () => {
    const mine = async (tok: string) =>
      (await get('/tasks?box=todo', tok).expect(200)).body.items.map(
        (t: { id: string }) => t.id,
      );
    expect(await mine(tokens.billerA)).toContain(ids.supTask);
    expect(await mine(tokens.billerB)).not.toContain(ids.supTask);
    expect(await mine(tokens.plain)).not.toContain(ids.supTask);
    expect(await mine(tokens.cashier)).not.toContain(ids.supTask);
  });

  it('领取竞争：非候选人 403，先领先得，旁人 409', async () => {
    await post(`/tasks/${ids.supTask}/claim`, {}, tokens.plain).expect(403);
    await post(`/tasks/${ids.supTask}/claim`, {}, tokens.billerB).expect(403);
    await post(`/tasks/${ids.supTask}/claim`, {}, tokens.billerA).expect(201);
    const dup = await post(`/tasks/${ids.supTask}/claim`, {});
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('TASK_ALREADY_CLAIMED');
    // 领取后从其他候选人待办消失，仍在认领人列表（CLAIMED 态）。
    const adminIds = (await get('/tasks?box=todo').expect(200)).body.items.map(
      (t: { id: string }) => t.id,
    );
    expect(adminIds).not.toContain(ids.supTask);
    const myIds = (await get('/tasks?box=todo', tokens.billerA).expect(200)).body.items.map(
      (t: { id: string }) => t.id,
    );
    expect(myIds).toContain(ids.supTask);
  });

  it('结算阻断 + 幂等去重 + 核销应用自动完成解锁', async () => {
    const blocked = await post('/consumption-settlements', {
      waterAccountId: ids.supAcct,
      period: '202602',
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('SETTLEMENT_BLOCKED_BY_TASK');
    expect(blocked.body.tasks[0].id).toBe(ids.supTask);
    expect(blocked.body.candidates.map((c: { name: string }) => c.name)).toContain('营收甲');
    // 幂等：阻断路径不重复建任务。
    expect(
      await owner.task.count({ where: { tenantId: T, type: 'SUPPLEMENT', bizId: ids.supAcct } }),
    ).toBe(1);

    // 业务动作（补差核销应用）自动完成任务 → 解锁。
    const rec = await post('/reconciliations', {
      waterAccountId: ids.supAcct,
      actualReadingId: ids.supReading,
    });
    expect(rec.status).toBe(201);
    const task = await owner.task.findUniqueOrThrow({ where: { id: ids.supTask } });
    expect(task.status).toBe('DONE');
    expect(task.completedAt).not.toBeNull();

    const settled = await post('/consumption-settlements', {
      waterAccountId: ids.supAcct,
      period: '202602',
    });
    expect(settled.status).toBe(201);
  }, 60_000);
});

describe('T12 METER_REVIEW 抄表异常复核', () => {
  it('读数倒挂 → 复核任务 → 手动领取/完成', async () => {
    const a = await onboard('rev');
    await seedReading(a, '202601', 300, 'PASSED');
    const book = await owner.readingBook.create({
      data: { tenantId: T, bookNo: `BKREV${RUN}`.slice(0, 38), name: '册rev', orgUnitId: ORG_A },
    });
    await owner.bookMeter.create({
      data: { tenantId: T, bookId: book.id, waterAccountId: a.waterAccount.id, seqNo: 1 },
    });
    const plan = await owner.readingPlan.create({
      data: {
        tenantId: T,
        bookId: book.id,
        period: '202602',
        planDate: new Date('2026-02-01'),
        status: 'OPEN',
      },
    });
    const item = await owner.readingPlanItem.create({
      data: { tenantId: T, planId: plan.id, waterAccountId: a.waterAccount.id, seqNo: 1 },
    });

    const entry = await post('/meter-readings', {
      planItemId: item.id,
      resultType: 'ACTUAL',
      readingValue: '100',
      readDate: '2026-02-10',
    });
    expect(entry.status).toBe(201);
    expect(entry.body.reviewTasks).toHaveLength(1);
    expect(entry.body.reviewTasks[0].reason).toContain('倒挂');
    const task = await owner.task.findFirstOrThrow({
      where: { tenantId: T, type: 'METER_REVIEW' },
    });
    ids.reviewTask = task.id;
    expect(task.requiredPerm).toBe('metering:qc');
    expect(task.reason).toContain('读数倒挂');

    // qc 是候选人；billerA 无 metering:qc → 不可领。
    await post(`/tasks/${task.id}/claim`, {}, tokens.billerA).expect(403);
    await post(`/tasks/${task.id}/claim`, {}, tokens.qc).expect(201);
    const done = await post(
      `/tasks/${task.id}/complete`,
      { note: '现场核实为换表' },
      tokens.qc,
    );
    expect(done.status).toBe(201);
    const after = await owner.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.status).toBe('DONE');
    expect((after.context as Record<string, unknown>).completionNote).toBe('现场核实为换表');
    const doneBox = (await get('/tasks?box=done', tokens.qc).expect(200)).body.items;
    expect(doneBox.map((t: { id: string }) => t.id)).toContain(task.id);
  }, 60_000);
});

describe('T13 COLLECTION + T14 REVERSAL_APPROVAL', () => {
  it('欠费超阈值 → 催缴任务（payment:write）；红冲 → 审批任务（billing:write）', async () => {
    const a = await onboard('col');
    const settlement = await owner.consumptionSettlement.create({
      data: {
        tenantId: T,
        waterAccountId: a.waterAccount.id,
        period: '202601',
        totalUsageQty: 100,
        isEstimated: false,
        status: 'FINAL',
      },
    });
    const bill = await owner.bill.create({
      data: {
        tenantId: T,
        settleAccountId: a.settleAccount.id,
        waterAccountId: a.waterAccount.id,
        period: '202601',
        billKind: 'NORMAL',
        sourceType: 'SETTLEMENT',
        sourceId: settlement.id,
        status: 'POSTED',
        totalAmount: 200000n,
        issuedAt: new Date(),
        dueDate: new Date('2026-02-15'),
      },
    });
    const pay = await post('/payments', {
      settleAccountId: a.settleAccount.id,
      channel: 'CASH',
      amount: '1000',
      allocs: [{ billId: bill.id, amount: '1000' }],
    });
    expect(pay.status).toBe(201);
    const colTask = await owner.task.findFirstOrThrow({
      where: { tenantId: T, type: 'COLLECTION', bizId: a.settleAccount.id },
    });
    ids.colTask = colTask.id;
    expect(colTask.requiredPerm).toBe('payment:write');
    expect(colTask.reason).toContain('欠费');
    const cashierTodo = (await get('/tasks?box=todo', tokens.cashier).expect(200)).body.items;
    expect(cashierTodo.map((t: { id: string }) => t.id)).toContain(colTask.id);

    const rev = await post(`/payments/${pay.body.id}/reverse`, { reason: '误收' });
    expect(rev.status).toBe(201);
    const revTask = await owner.task.findFirstOrThrow({
      where: { tenantId: T, type: 'REVERSAL_APPROVAL', bizType: 'payment' },
    });
    expect(revTask.requiredPerm).toBe('billing:write');
    expect(revTask.reason).toContain('误收');
    const billerTodo = (await get('/tasks?box=todo', tokens.billerA).expect(200)).body.items;
    expect(billerTodo.map((t: { id: string }) => t.id)).toContain(revTask.id);
  }, 60_000);
});

describe('T3 类型-权限映射字典改即生效（§4.2-8）', () => {
  it('TASK_TYPE_PERM 改 perm → 新建任务候选人随之变化', async () => {
    // 把 METER_REVIEW 映射从 metering:qc 改为 payment:write —— 应即时生效，
    // 无需重启（resolveRule 每次直读 sys_dict）。
    const dict = await owner.sysDict.create({
      data: {
        tenantId: T,
        category: 'TASK_TYPE_PERM',
        code: 'METER_REVIEW',
        name: '抄表异常复核(改)',
        seq: 1,
        status: 'ACTIVE',
        value: { perm: 'payment:write', dueDays: 1, priority: 'LOW' },
      },
    });
    try {
      const a = await onboard('dyn');
      await seedReading(a, '202601', 300, 'PASSED');
      const book = await owner.readingBook.create({
        data: { tenantId: T, bookNo: `BKDYN${RUN}`.slice(0, 38), name: '册dyn', orgUnitId: ORG_A },
      });
      await owner.bookMeter.create({
        data: { tenantId: T, bookId: book.id, waterAccountId: a.waterAccount.id, seqNo: 1 },
      });
      const plan = await owner.readingPlan.create({
        data: { tenantId: T, bookId: book.id, period: '202602', planDate: new Date('2026-02-01'), status: 'OPEN' },
      });
      const item = await owner.readingPlanItem.create({
        data: { tenantId: T, planId: plan.id, waterAccountId: a.waterAccount.id, seqNo: 1 },
      });
      const entry = await post('/meter-readings', {
        planItemId: item.id,
        resultType: 'ACTUAL',
        readingValue: '100',
        readDate: '2026-02-10',
      });
      expect(entry.status).toBe(201);
      expect(entry.body.reviewTasks).toHaveLength(1);
      const task = await owner.task.findFirstOrThrow({
        where: { tenantId: T, type: 'METER_REVIEW', id: entry.body.reviewTasks[0].id },
      });
      // 映射已生效：perm/优先级/期限按字典值
      expect(task.requiredPerm).toBe('payment:write');
      expect(task.priority).toBe('LOW');
      const cashierTodo = (await get('/tasks?box=todo', tokens.cashier).expect(200)).body.items;
      expect(cashierTodo.map((t: { id: string }) => t.id)).toContain(task.id);
      const qcTodo = (await get('/tasks?box=todo', tokens.qc).expect(200)).body.items;
      expect(qcTodo.map((t: { id: string }) => t.id)).not.toContain(task.id);
    } finally {
      // 还原映射，避免影响同租户其他用例
      await owner.sysDict.delete({ where: { tenantId_id: { tenantId: T, id: dict.id } } });
    }
  }, 60_000);
});

describe('T15 WRITEOFF_APPROVAL', () => {
  it('核销登记 → 审批任务', async () => {
    const a = await onboard('wo');
    await owner.sysDict.create({
      data: {
        tenantId: T,
        category: 'WRITEOFF_REASON',
        code: 'AGED3Y',
        name: '账龄超3年',
        seq: 1,
        status: 'ACTIVE',
      },
    });
    const res = await post('/writeoffs', {
      settleAccountId: a.settleAccount.id,
      amount: 500,
      reasonCode: 'AGED3Y',
      effectiveDate: '2026-10-14',
    });
    expect(res.status).toBe(201);
    const task = await owner.task.findFirstOrThrow({
      where: { tenantId: T, type: 'WRITEOFF_APPROVAL', bizId: res.body.id },
    });
    expect(task.requiredPerm).toBe('billing:write');
    expect((task.context as Record<string, unknown>).reasonName).toBe('账龄超3年');
  }, 60_000);
});

describe('T16 出账批次阻断 + T17 超期升级 + T11 无候选告警 + badge', () => {
  it('出账批次对挂起补差任务的户记 SETTLEMENT_BLOCKED_BY_TASK', async () => {
    const a = await estimatedAccount('run', '202603');
    // 结算完成后才检出问题（如事后补录低读数走 QC）→ 打开中的任务必须在
    // 出账闸门生效。直接注入任务模拟该时序。
    await owner.task.create({
      data: {
        tenantId: T,
        type: 'SUPPLEMENT',
        title: '补差：出账闸门验证',
        bizType: 'waterAccount',
        bizId: a.waterAccount.id,
        reason: '测试注入',
        requiredPerm: 'billing:write',
        status: 'PENDING',
        priority: 'NORMAL',
        candidateCount: 2,
      },
    });
    const run = (await post('/billing-runs', { period: '202603' }).expect(201)).body;
    const detail = (await get(`/billing-runs/${run.id}`).expect(200)).body;
    const fails = (detail.failedSettlementIds ?? []) as { code?: string }[];
    expect(fails.some((f) => f.code === 'SETTLEMENT_BLOCKED_BY_TASK')).toBe(true);
  }, 60_000);

  it('超期任务懒升级为 URGENT + escalated，并计入 badge', async () => {
    await owner.task.update({
      where: { id: ids.colTask },
      data: { dueAt: new Date(Date.now() - 3600_000) },
    });
    const list = (await get('/tasks?box=todo').expect(200)).body.items;
    const row = list.find((t: { id: string }) => t.id === ids.colTask);
    expect(row).toMatchObject({ priority: 'URGENT' });
    expect(row.escalatedAt).not.toBeNull();
    const badge = (await get('/tasks/badge').expect(200)).body;
    expect(badge.todo).toBeGreaterThanOrEqual(1);
    expect(badge.escalated).toBeGreaterThanOrEqual(1);
  });

  it('无候选责任人 → alert 箱 + badge.alerts 对管理员可见', async () => {
    const ghost = await owner.task.create({
      data: {
        tenantId: T,
        type: 'COLLECTION',
        title: '催缴：无候选验证',
        bizType: 'settleAccount',
        bizId: randomUUID(),
        reason: '测试注入',
        requiredPerm: 'ghost:perm',
        status: 'PENDING',
        priority: 'NORMAL',
        candidateCount: 0,
      },
    });
    const alerts = (await get('/tasks?box=alert').expect(200)).body.items;
    expect(alerts.map((t: { id: string }) => t.id)).toContain(ghost.id);
    const badge = (await get('/tasks/badge').expect(200)).body;
    expect(badge.alerts).toBeGreaterThanOrEqual(1);
    const plainTodo = (await get('/tasks?box=todo', tokens.plain).expect(200)).body.items;
    expect(plainTodo.map((t: { id: string }) => t.id)).not.toContain(ghost.id);
  });
});
