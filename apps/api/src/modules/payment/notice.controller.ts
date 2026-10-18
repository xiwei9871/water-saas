import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { assertUuid } from '../../common/uuid.js';
import { SequenceService } from '../../common/sequence.service.js';
import { TaskService } from '../task/task.service.js';

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
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
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
    });
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
