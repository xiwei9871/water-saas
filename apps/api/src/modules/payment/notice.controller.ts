import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant, type TenantCtx } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { assertUuid } from '../../common/uuid.js';
import { SequenceService } from '../../common/sequence.service.js';
import { TaskService } from '../task/task.service.js';
import { outOfScopeAccountIds } from '../../common/account-scope.js';
import { Prisma } from '@prisma/client';

/**
 * G4 催缴通知单：对欠费用水户生成可打印通知单并留痕（打印次数/
 * 最近打印时间），同时挂 COLLECTION 催缴任务（任务中心去重）。
 */
@Controller('payments/collection-notices')
export class NoticeController {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly seq: SequenceService,
    private readonly tasks: TaskService,
  ) {}

  @Get()
  @Permissions('payment:read')
  list(@Query('waterAccountId') waterAccountId?: string, @Query('take') take?: string) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.collectionNotice.findMany({
        where: {
          tenantId: ctx.tenantId,
          ...(waterAccountId ? { waterAccountId: assertUuid(waterAccountId, 'waterAccountId') } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: Math.min(parseInt(take ?? '50', 10) || 50, 200),
      });
      const waIds = [...new Set(rows.map((r) => r.waterAccountId))];
      const accounts = await tx.waterAccount.findMany({
        where: { tenantId: ctx.tenantId, id: { in: waIds } },
        select: { id: true, accountNo: true, customer: { select: { name: true } } },
      });
      const nameOf = new Map(accounts.map((a) => [a.id, `${a.accountNo} ${a.customer.name}`]));
      return rows.map((r) => ({ ...r, waterAccountLabel: nameOf.get(r.waterAccountId) ?? null }));
    });
  }

  /**
   * GET /payments/collection-notices/arrears — 待催缴户清单：
   * 欠费(POSTED/PARTIAL_PAID 未清)按用水户聚合，含户号/户名/电话/地址/
   * 欠费金额/欠费笔数/最早账期/最大逾期天数。可按金额下限、逾期天数、
   * 关键字过滤；默认按欠费额降序。
   */
  @Get('arrears')
  @Permissions('payment:read')
  arrears(
    @Query('minAmount') minAmount?: string,
    @Query('minOverdueDays') minOverdueDays?: string,
    @Query('q') q?: string,
    @Query('take') take?: string,
  ) {
    const ctx = currentTenant();
    const minAmtFen = Math.max(0, Math.round((Number(minAmount) || 0) * 100));
    const minDays = Math.max(0, Math.floor(Number(minOverdueDays) || 0));
    const limit = Math.min(parseInt(take ?? '200', 10) || 200, 500);
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const excluded = ctx.scope === 'ALL' ? [] : await outOfScopeAccountIds(tx, ctx);
      const excl = excluded.length ? excluded : ['00000000-0000-0000-0000-000000000000'];
      const like = q?.trim() ? `%${q.trim().replace(/[%_\\]/g, '')}%` : null;
      const rows = await tx.$queryRaw<
        {
          water_account_id: string;
          account_no: string;
          addr: string;
          customer_name: string;
          customer_no: string;
          phone: string | null;
          due: bigint;
          bills: bigint;
          oldest_period: string;
          overdue_days: number | null;
        }[]
      >(Prisma.sql`
        SELECT b.water_account_id,
               wa.account_no, wa.addr,
               c.name AS customer_name, c.customer_no, c.phone,
               sum(GREATEST(b.total_amount - COALESCE(a.paid,0),0)) AS due,
               count(*) AS bills,
               min(b.period) AS oldest_period,
               max(CURRENT_DATE - b.due_date)
                 FILTER (WHERE b.due_date IS NOT NULL AND b.due_date < CURRENT_DATE) AS overdue_days
        FROM bill b
        JOIN water_account wa ON wa.tenant_id = b.tenant_id AND wa.id = b.water_account_id
        JOIN customer c ON c.tenant_id = wa.tenant_id AND c.id = wa.customer_id
        LEFT JOIN (SELECT bill_id, sum(pa.amount) AS paid FROM payment_alloc pa
                    JOIN payment p ON p.id = pa.payment_id AND p.tenant_id = pa.tenant_id
                    WHERE pa.tenant_id = ${ctx.tenantId}::uuid
                      AND p.status IN ('RECEIVED','DAY_CLOSED')
                    GROUP BY bill_id) a ON a.bill_id = b.id
        WHERE b.tenant_id = ${ctx.tenantId}::uuid
          AND b.bill_kind <> 'REVERSAL'
          AND b.status IN ('POSTED','PARTIAL_PAID')
          AND b.water_account_id <> ALL(${excl}::uuid[])
          AND (${like}::text IS NULL OR wa.account_no ILIKE ${like}
               OR c.name ILIKE ${like} OR wa.addr ILIKE ${like} OR c.customer_no ILIKE ${like})
        GROUP BY b.water_account_id, wa.account_no, wa.addr, c.name, c.customer_no, c.phone
        HAVING sum(GREATEST(b.total_amount - COALESCE(a.paid,0),0)) >= ${Math.max(minAmtFen, 1)}
           AND (${minDays} = 0 OR
                max(CURRENT_DATE - b.due_date)
                  FILTER (WHERE b.due_date IS NOT NULL AND b.due_date < CURRENT_DATE) >= ${minDays})
        ORDER BY due DESC
        LIMIT ${limit}
      `);
      return {
        total: rows.length,
        items: rows.map((r) => ({
          waterAccountId: r.water_account_id,
          accountNo: r.account_no,
          customerName: r.customer_name,
          customerNo: r.customer_no,
          phone: r.phone,
          addr: r.addr,
          amountDue: r.due.toString(),
          billCount: Number(r.bills),
          oldestPeriod: r.oldest_period,
          overdueDays: r.overdue_days ?? 0,
        })),
      };
    });
  }

  @Get(':id')
  @Permissions('payment:read')
  detail(@Param('id') id: string) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const row = await tx.collectionNotice.findFirst({
        where: { tenantId: ctx.tenantId, id: assertUuid(id, 'id') },
      });
      if (!row) throw new BadRequestException({ code: 'NOTICE_NOT_FOUND' });
      const acc = await tx.waterAccount.findFirst({
        where: { tenantId: ctx.tenantId, id: row.waterAccountId },
        select: { accountNo: true, addr: true, customer: { select: { name: true } } },
      });
      return { ...row, account: acc };
    });
  }

  @Post()
  @Permissions('payment:write')
  create(@Body() body: { waterAccountId?: string }) {
    const ctx = currentTenant();
    const waId = assertUuid(body?.waterAccountId, 'waterAccountId');
    return this.prisma.runAsTenant(ctx.tenantId, (tx) => this.createNoticeTx(tx, ctx, waId));
  }

  /**
   * POST /payments/collection-notices/batch — {waterAccountIds: []}
   * 批量生成催缴通知单并各挂 COLLECTION 任务；每户独立成败互不影响。
   */
  @Post('batch')
  @Permissions('payment:write')
  batch(@Body() body: { waterAccountIds?: unknown }) {
    const ctx = currentTenant();
    const ids = Array.isArray(body?.waterAccountIds)
      ? body.waterAccountIds.filter((x): x is string => typeof x === 'string')
      : [];
    if (!ids.length || ids.length > 200) {
      throw new BadRequestException({ code: 'BATCH_ACCOUNTS_REQUIRED' });
    }
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const results: { waterAccountId: string; ok: boolean; noticeNo?: string; error?: string }[] = [];
      for (const raw of ids) {
        try {
          const waId = assertUuid(raw, 'waterAccountId');
          const notice = await this.createNoticeTx(tx, ctx, waId);
          results.push({ waterAccountId: waId, ok: true, noticeNo: notice.noticeNo });
        } catch (e) {
          results.push({
            waterAccountId: raw,
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      return { results, created: results.filter((r) => r.ok).length };
    });
  }

  private async createNoticeTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    waId: string,
  ) {
    const account = await tx.waterAccount.findFirst({
      where: { tenantId: ctx.tenantId, id: waId },
      select: { id: true, accountNo: true, settleAccountId: true, customer: { select: { name: true } } },
    });
    if (!account) throw new BadRequestException({ code: 'ACCOUNT_NOT_FOUND' });
    const bills = await tx.bill.findMany({
      where: {
        tenantId: ctx.tenantId,
        waterAccountId: waId,
        status: { in: ['POSTED', 'PARTIAL_PAID'] },
      },
      select: { id: true, period: true, totalAmount: true, allocs: { select: { amount: true } } },
      orderBy: { period: 'asc' },
    });
    const unpaid = bills
      .map((b) => ({ ...b, due: b.totalAmount - b.allocs.reduce((s, a) => s + a.amount, 0n) }))
      .filter((b) => b.due > 0n);
    if (!unpaid.length) {
      throw new BadRequestException({ code: 'NO_ARREARS' });
    }
    const amountDue = unpaid.reduce((s, b) => s + b.due, 0n);
    const noticeNo = await this.seq.nextFormatted(tx, ctx.tenantId, 'collection_notice', 'CJ', ctx.staffId);
    const notice = await tx.collectionNotice.create({
      data: {
        tenantId: ctx.tenantId,
        noticeNo,
        waterAccountId: waId,
        settleAccountId: account.settleAccountId,
        periodFrom: unpaid[0].period,
        periodTo: unpaid[unpaid.length - 1].period,
        amountDue,
        billCount: unpaid.length,
        bills: unpaid.map((b) => ({
          period: b.period,
          total: b.totalAmount.toString(),
          due: b.due.toString(),
        })),
        createdBy: ctx.staffId,
        updatedBy: ctx.staffId,
      },
    });
    const t = await this.tasks.createTask(tx, ctx, {
      type: 'COLLECTION',
      title: `催缴：户 ${account.accountNo} ${account.customer.name}（欠费 ${unpaid.length} 期 ${(Number(amountDue) / 100).toFixed(2)} 元）`,
      bizType: 'settleAccount',
      bizId: account.settleAccountId,
      bizLabel: `结算户 ${account.accountNo}`,
      reason: `已出具催缴通知单 ${noticeNo}`,
      context: { noticeId: notice.id, noticeNo, amountDue: amountDue.toString(), billCount: unpaid.length },
      orgUnitId: null,
    });
    return { ...notice, taskId: t.id || null };
  }

  /** 打印留痕：每次调用 print_count+1、记录最近打印时间。 */
  @Post(':id/print')
  @Permissions('payment:write')
  print(@Param('id') id: string) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const r = await tx.collectionNotice.updateMany({
        where: { tenantId: ctx.tenantId, id: assertUuid(id, 'id') },
        data: { printCount: { increment: 1 }, lastPrintedAt: new Date(), updatedBy: ctx.staffId },
      });
      if (r.count === 0) throw new BadRequestException({ code: 'NOTICE_NOT_FOUND' });
      return tx.collectionNotice.findFirst({ where: { id } });
    });
  }
}
