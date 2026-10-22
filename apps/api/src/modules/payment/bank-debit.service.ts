import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { assertSettleScopeTx } from '../../common/account-scope.js';
import { TenantCtx } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { BANK_DEBIT_PORT, type BankDebitPort } from './bank-debit.port.js';
import { PaymentService } from './payment.service.js';

type Tx = Prisma.TransactionClient;
const bad = (code: string, extra?: Record<string, unknown>) =>
  new BadRequestException({ code, ...extra });

const maskCard = (cardNo: string) => {
  const digits = cardNo.replace(/\s+/g, '');
  if (digits.length < 8) throw bad('CARD_NO_INVALID');
  const last4 = digits.slice(-4);
  return { masked: `${digits.slice(0, 4)}****${last4}`, last4 };
};

/**
 * 20261021 整改 任务F：银行代扣。
 * 协议(每户至多一条ACTIVE) → 月度批次 → 扣款明细(PKMX) → 执行(端口适配器扣款，
 * 成功自动销账走 BANK_DEDUCT payment) → 结果(PKJG) / 对账明细(DZMX)。
 * 三道防重复：
 *   ① DB 偏唯一：每户至多一条 ACTIVE 协议；
 *   ② 生成批次时跳过同期已有 PENDING/SUCCESS 明细的户；
 *   ③ DB 偏唯一：同户同期至多一条 PENDING、至多一条 SUCCESS（并发兜底）。
 */
@Injectable()
export class BankDebitService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly payments: PaymentService,
    @Inject(BANK_DEBIT_PORT) private readonly bank: BankDebitPort,
  ) {}

  // ---------- 协议 ----------
  listAgreements(ctx: TenantCtx, q: { status?: string }) {
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.bankDebitAgreement.findMany({
        where: { tenantId: ctx.tenantId, ...(q.status ? { status: q.status } : {}) },
        include: { settleAccount: { select: { id: true, settleNo: true, name: true } } },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  async createAgreementTx(
    tx: Tx,
    ctx: TenantCtx,
    body: { settleAccountId?: unknown; cardNo?: unknown; bankCode?: unknown; holderName?: unknown },
    req: Request,
  ) {
    const saId = typeof body.settleAccountId === 'string' ? body.settleAccountId : '';
    if (!saId || !body.cardNo || !body.bankCode) throw bad('AGREEMENT_FIELDS_REQUIRED');
    await assertSettleScopeTx(tx, ctx, saId);
    const sa = await tx.settleAccount.findFirst({
      where: { tenantId: ctx.tenantId, id: saId },
      select: { id: true },
    });
    if (!sa) throw new NotFoundException({ code: 'SETTLE_ACCOUNT_NOT_FOUND' });
    const bank = await tx.sysDict.findFirst({
      where: { tenantId: ctx.tenantId, category: 'BANK_CODE', code: String(body.bankCode), status: 'ACTIVE' },
      select: { code: true },
    });
    if (!bank) throw bad('BANK_CODE_INVALID', { bankCode: body.bankCode });
    const { masked, last4 } = maskCard(String(body.cardNo));
    const dup = await tx.bankDebitAgreement.findFirst({
      where: { tenantId: ctx.tenantId, settleAccountId: saId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (dup) throw new ConflictException({ code: 'AGREEMENT_ALREADY_ACTIVE', existing: dup.id });
    const row = await tx.bankDebitAgreement.create({
      data: {
        tenantId: ctx.tenantId,
        settleAccountId: saId,
        cardNoMasked: masked,
        cardLast4: last4,
        bankCode: String(body.bankCode),
        holderName: body.holderName ? String(body.holderName) : null,
        signDate: new Date(),
        createdBy: ctx.staffId,
        updatedBy: ctx.staffId,
      },
    });
    req.auditBefore = undefined;
    return row;
  }

  async cancelAgreementTx(tx: Tx, ctx: TenantCtx, id: string, req: Request) {
    const cur = await tx.bankDebitAgreement.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!cur) throw new NotFoundException({ code: 'AGREEMENT_NOT_FOUND' });
    if (cur.status === 'CANCELLED') return cur;
    req.auditBefore = cur;
    return tx.bankDebitAgreement.update({
      where: { tenantId_id: { tenantId: ctx.tenantId, id } },
      data: { status: 'CANCELLED', cancelledAt: new Date(), updatedBy: ctx.staffId },
    });
  }

  // ---------- 批次 ----------
  listBatches(ctx: TenantCtx) {
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.bankDebitBatch.findMany({
        where: { tenantId: ctx.tenantId },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  /** 账户当前欠费合计（POSTED/PARTIAL_PAID 的 total−已分摊）。 */
  private async outstandingFor(tx: Tx, ctx: TenantCtx, settleAccountId: string, uptoPeriod: string) {
    const bills = await tx.bill.findMany({
      where: {
        tenantId: ctx.tenantId,
        settleAccountId,
        status: { in: ['POSTED', 'PARTIAL_PAID'] },
        period: { lte: uptoPeriod },
        billKind: { not: 'REVERSAL' },
      },
      select: { id: true, totalAmount: true },
    });
    if (bills.length === 0) return { bills: [] as { id: string; outstanding: bigint }[] };
    const applied = await tx.paymentAlloc.groupBy({
      by: ['billId'],
      where: { tenantId: ctx.tenantId, billId: { in: bills.map((b) => b.id) } },
      _sum: { amount: true },
    });
    const paidMap = new Map(applied.map((r) => [r.billId, r._sum.amount ?? 0n]));
    return {
      bills: bills
        .map((b) => ({ id: b.id, outstanding: b.totalAmount - (paidMap.get(b.id) ?? 0n) }))
        .filter((b) => b.outstanding > 0n),
    };
  }

  /** 生成批次：有效协议户 → 当期欠费 → 防御②跳过已在批/已扣 → 明细 PENDING。 */
  async createBatchTx(tx: Tx, ctx: TenantCtx, body: { period?: unknown }, req: Request) {
    const period = String(body.period ?? '').trim();
    if (!/^\d{6}$/.test(period)) throw bad('PERIOD_INVALID');
    const agreements = await tx.bankDebitAgreement.findMany({
      where: { tenantId: ctx.tenantId, status: 'ACTIVE' },
    });
    if (agreements.length === 0) throw bad('NO_ACTIVE_AGREEMENTS');
    // 防御②：同期已有 PENDING 或 SUCCESS 明细的结算户跳过
    const existing = await tx.bankDebitItem.findMany({
      where: { tenantId: ctx.tenantId, period, status: { in: ['PENDING', 'SUCCESS'] } },
      select: { settleAccountId: true, status: true },
    });
    const blocked = new Set(existing.map((e) => e.settleAccountId));

    const batch = await tx.bankDebitBatch.create({
      data: {
        tenantId: ctx.tenantId,
        period,
        status: 'GENERATED',
        generatedBy: ctx.staffId,
        createdBy: ctx.staffId,
      },
    });
    let count = 0;
    let total = 0n;
    const skipped: { settleAccountId: string; reason: string }[] = [];
    for (const ag of agreements) {
      if (blocked.has(ag.settleAccountId)) {
        skipped.push({ settleAccountId: ag.settleAccountId, reason: 'ALREADY_IN_BATCH_OR_PAID' });
        continue;
      }
      const { bills } = await this.outstandingFor(tx, ctx, ag.settleAccountId, period);
      const amount = bills.reduce((s, b) => s + b.outstanding, 0n);
      if (amount <= 0n) {
        skipped.push({ settleAccountId: ag.settleAccountId, reason: 'NO_OUTSTANDING' });
        continue;
      }
      try {
        await tx.bankDebitItem.create({
          data: {
            tenantId: ctx.tenantId,
            batchId: batch.id,
            settleAccountId: ag.settleAccountId,
            period,
            amount,
            status: 'PENDING',
          },
        });
      } catch (e) {
        // 防御③：并发批次撞 PENDING 偏唯一索引 → 跳过而非炸掉整批
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          skipped.push({ settleAccountId: ag.settleAccountId, reason: 'ALREADY_IN_BATCH_OR_PAID' });
          continue;
        }
        throw e;
      }
      count += 1;
      total += amount;
    }
    await tx.bankDebitBatch.update({
      where: { tenantId_id: { tenantId: ctx.tenantId, id: batch.id } },
      data: { totalCount: count, totalAmount: total },
    });
    req.auditBefore = undefined;
    return { ...batch, totalCount: count, totalAmount: total, skipped };
  }

  /** 执行批次：逐条 PENDING → 端口扣款 → 成功自动销账（BANK_DEDUCT）。幂等可重跑。 */
  async executeBatchTx(tx: Tx, ctx: TenantCtx, id: string, req: Request) {
    const batch = await tx.bankDebitBatch.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!batch) throw new NotFoundException({ code: 'BATCH_NOT_FOUND' });
    if (batch.status === 'DONE') throw bad('BATCH_ALREADY_DONE');
    await tx.bankDebitBatch.updateMany({
      where: { tenantId: ctx.tenantId, id, status: 'GENERATED' },
      data: { status: 'EXECUTING' },
    });
    const items = await tx.bankDebitItem.findMany({
      where: { tenantId: ctx.tenantId, batchId: id, status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
    });
    const agreements = await tx.bankDebitAgreement.findMany({
      where: {
        tenantId: ctx.tenantId,
        settleAccountId: { in: items.map((i) => i.settleAccountId) },
        status: 'ACTIVE',
      },
    });
    const agMap = new Map(agreements.map((a) => [a.settleAccountId, a]));
    const results: { itemId: string; status: string; failReason?: string }[] = [];

    for (const item of items) {
      const ag = agMap.get(item.settleAccountId);
      const { bills } = await this.outstandingFor(tx, ctx, item.settleAccountId, batch.period);
      const outstanding = bills.reduce((s, b) => s + b.outstanding, 0n);
      const chargeAmount = item.amount < outstanding ? item.amount : outstanding;
      if (!ag || chargeAmount <= 0n) {
        // 协议失效或欠费已清 → 跳过（防御②的执行期复核）
        await tx.bankDebitItem.updateMany({
          where: { tenantId: ctx.tenantId, id: item.id, status: 'PENDING' },
          data: { status: 'SKIPPED', failReason: !ag ? 'AGREEMENT_CANCELLED' : 'OUTSTANDING_CLEARED' },
        });
        results.push({ itemId: item.id, status: 'SKIPPED' });
        continue;
      }
      const res = await this.bank.charge({
        itemId: item.id,
        settleAccountId: item.settleAccountId,
        amount: chargeAmount,
        cardLast4: ag.cardLast4,
        bankCode: ag.bankCode,
        period: batch.period,
      });
      if (!res.ok) {
        await tx.bankDebitItem.updateMany({
          where: { tenantId: ctx.tenantId, id: item.id, status: 'PENDING' },
          data: { status: 'FAILED', failReason: res.failReason ?? '扣款失败', executedAt: new Date() },
        });
        results.push({ itemId: item.id, status: 'FAILED', failReason: res.failReason });
        continue;
      }
      // 成功：自动销账 —— 贪心分摊到未清账单（BANK_DEDUCT 渠道）
      const allocs: { billId: string; amount: bigint }[] = [];
      let left = chargeAmount;
      for (const b of bills) {
        if (left <= 0n) break;
        const take = b.outstanding < left ? b.outstanding : left;
        allocs.push({ billId: b.id, amount: take });
        left -= take;
      }
      const payment = await this.payments.createTx(tx, ctx, {
        settleAccountId: item.settleAccountId,
        channel: 'BANK_DEDUCT',
        amount: chargeAmount,
        allocs,
      });
      const flipped = await tx.bankDebitItem.updateMany({
        where: { tenantId: ctx.tenantId, id: item.id, status: 'PENDING' },
        data: {
          status: 'SUCCESS',
          bankSerialNo: res.bankSerialNo,
          paymentId: payment.id,
          executedAt: new Date(),
        },
      });
      if (flipped.count === 0) {
        throw new ConflictException({ code: 'ITEM_RACE' });
      }
      results.push({ itemId: item.id, status: 'SUCCESS' });
    }
    await tx.bankDebitBatch.updateMany({
      where: { tenantId: ctx.tenantId, id, status: { not: 'DONE' } },
      data: { status: 'DONE', executedAt: new Date() },
    });
    req.auditBefore = batch;
    return { batchId: id, processed: items.length, results };
  }

  items(ctx: TenantCtx, batchId: string) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const b = await tx.bankDebitBatch.findFirst({
        where: { tenantId: ctx.tenantId, id: batchId },
        select: { id: true },
      });
      if (!b) throw new NotFoundException({ code: 'BATCH_NOT_FOUND' });
      const rows = await tx.bankDebitItem.findMany({
        where: { tenantId: ctx.tenantId, batchId },
        orderBy: { createdAt: 'asc' },
      });
      const saIds = [...new Set(rows.map((r) => r.settleAccountId))];
      const sas = saIds.length
        ? await tx.settleAccount.findMany({
            where: { tenantId: ctx.tenantId, id: { in: saIds } },
            select: { id: true, settleNo: true, name: true },
          })
        : [];
      const saMap = new Map(sas.map((s) => [s.id, s]));
      return rows.map((r) => ({ ...r, settle: saMap.get(r.settleAccountId) ?? null }));
    });
  }

  /** PKMX 扣款明细（送银行前的批次文件）。 */
  pkmx(ctx: TenantCtx, batchId: string) {
    return this.items(ctx, batchId).then((rows) =>
      rows.map((r) => ({
        itemId: r.id,
        settleNo: r.settle?.settleNo,
        holder: r.settle?.name,
        amount: r.amount.toString(),
        period: r.period,
      })),
    );
  }

  /** PKJG 扣款结果（银行回盘后的结果明细）。 */
  pkjg(ctx: TenantCtx, batchId: string) {
    return this.items(ctx, batchId).then((rows) =>
      rows.map((r) => ({
        itemId: r.id,
        settleNo: r.settle?.settleNo,
        amount: r.amount.toString(),
        status: r.status,
        bankSerialNo: r.bankSerialNo,
        failReason: r.failReason,
        executedAt: r.executedAt,
      })),
    );
  }

  /** DZMX 对账明细：扣款明细 vs 销账 payment 核对。 */
  dzmx(ctx: TenantCtx, batchId: string) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const rows = await this.items(ctx, batchId);
      const payIds = rows.map((r) => r.paymentId).filter((x): x is string => !!x);
      const pays = payIds.length
        ? await tx.payment.findMany({
            where: { tenantId: ctx.tenantId, id: { in: payIds } },
            select: { id: true, amount: true, status: true, receivedAt: true },
          })
        : [];
      const payMap = new Map(pays.map((p) => [p.id, p]));
      return rows.map((r) => {
        const pay = r.paymentId ? payMap.get(r.paymentId) : null;
        return {
          itemId: r.id,
          settleNo: r.settle?.settleNo,
          debitAmount: r.amount.toString(),
          itemStatus: r.status,
          bankSerialNo: r.bankSerialNo,
          paymentId: r.paymentId,
          paymentAmount: pay ? pay.amount.toString() : null,
          paymentStatus: pay?.status ?? null,
          reconciled:
            r.status !== 'SUCCESS'
              ? 'N/A'
              : pay && pay.status === 'RECEIVED'
                ? 'OK'
                : 'MISMATCH',
        };
      });
    });
  }
}
