import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  AnyPermissions,
  Permissions,
} from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { assertUuid } from '../../common/uuid.js';
import { TaskService } from '../task/task.service.js';

const assertDate = (v: unknown, field: string): string => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new BadRequestException({ code: 'INVALID_DATE', field });
  }
  const d = new Date(`${v}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
    throw new BadRequestException({ code: 'INVALID_DATE', field });
  }
  return v;
};

/**
 * G2 坏账核销登记（轻量版）——人工登记 + 字典原因 + 留痕。
 *
 * 刻意不做账务冲销：应收/账单的 financial invariant 保持原样，核销额
 * 只在报表层（B3 年报 / 欠费清单 writtenOff 列）标注扣减。REVERSED
 * 记录保留（append-only），与红冲同款语义。
 *
 * reasonCode 必须命中租户字典 WRITEOFF_REASON 的 ACTIVE 项 ——
 * 未配置原因字典时登记动作报 WRITEOFF_REASON_INVALID 并指明去
 * 「字典管理」配置，而不是退化为自由文本。
 */
// NOTE: `/payments/writeoffs` 会被 PaymentController 的 `GET /payments/:id`
// 抢先匹配（控制器注册顺序），故挂独立前缀。
@Controller('writeoffs')
export class WriteoffController {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly tasks: TaskService,
  ) {}

  @Get()
  @AnyPermissions('payment:read', 'report:read')
  list(
    @Query('settleAccountId') settleAccountId?: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    if (status !== undefined && status !== 'ACTIVE' && status !== 'REVERSED') {
      throw new BadRequestException({ code: 'WRITEOFF_STATUS_INVALID' });
    }
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.badDebtWriteoff.findMany({
        where: {
          tenantId: ctx.tenantId,
          ...(settleAccountId !== undefined
            ? { settleAccountId: assertUuid(settleAccountId, 'settleAccountId') }
            : {}),
          ...(status !== undefined ? { status: status as 'ACTIVE' | 'REVERSED' } : {}),
          ...(from !== undefined
            ? { effectiveDate: { gte: new Date(`${assertDate(from, 'from')}T00:00:00.000Z`) } }
            : {}),
          ...(to !== undefined
            ? { effectiveDate: { lte: new Date(`${assertDate(to, 'to')}T00:00:00.000Z`) } }
            : {}),
        },
        orderBy: [{ effectiveDate: 'desc' }, { createdAt: 'desc' }],
        take: Math.min(Math.max(Number(take) || 50, 1), 500),
        skip: Math.max(Number(skip) || 0, 0),
      });
      // 人读化：结算户号/户名、账单单内嵌
      const settleIds = [...new Set(rows.map((r) => r.settleAccountId))];
      const settles = await tx.settleAccount.findMany({
        where: { tenantId: ctx.tenantId, id: { in: settleIds } },
        select: { id: true, settleNo: true, name: true },
      });
      const settleMap = new Map(settles.map((s) => [s.id, s]));
      const waIds = [
        ...new Set(rows.map((r) => r.waterAccountId).filter((v): v is string => !!v)),
      ];
      const was = await tx.waterAccount.findMany({
        where: { tenantId: ctx.tenantId, id: { in: waIds } },
        select: { id: true, accountNo: true },
      });
      const waMap = new Map(was.map((w) => [w.id, w.accountNo]));
      return rows.map((r) => ({
        ...r,
        settleNo: settleMap.get(r.settleAccountId)?.settleNo ?? null,
        settleName: settleMap.get(r.settleAccountId)?.name ?? null,
        accountNo: r.waterAccountId ? waMap.get(r.waterAccountId) ?? null : null,
      }));
    });
  }

  /**
   * POST {settleAccountId, waterAccountId?, billId?, amount, reasonCode,
   *       note?, effectiveDate} — 登记一笔核销。amount 单位：分（正数）。
   */
  @Post()
  @Permissions('payment:write')
  async create(
    @Body()
    body: {
      settleAccountId?: string;
      waterAccountId?: string;
      billId?: string;
      amount?: number;
      reasonCode?: string;
      note?: string;
      effectiveDate?: string;
    },
    @Req() req: Request,
  ) {
    const ctx = currentTenant();
    const settleAccountId = assertUuid(body?.settleAccountId, 'settleAccountId');
    const waterAccountId =
      body?.waterAccountId !== undefined
        ? assertUuid(body.waterAccountId, 'waterAccountId')
        : undefined;
    const billId =
      body?.billId !== undefined ? assertUuid(body.billId, 'billId') : undefined;
    if (!Number.isInteger(body?.amount) || (body.amount as number) <= 0) {
      throw new BadRequestException({ code: 'WRITEOFF_AMOUNT_INVALID' });
    }
    if (typeof body?.reasonCode !== 'string' || body.reasonCode.trim() === '') {
      throw new BadRequestException({ code: 'WRITEOFF_REASON_REQUIRED' });
    }
    const effectiveDate = new Date(
      `${assertDate(body?.effectiveDate, 'effectiveDate')}T00:00:00.000Z`,
    );
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      // reasonCode 必须命中 ACTIVE 字典项
      const reason = await tx.sysDict.findUnique({
        where: {
          tenantId_category_code: {
            tenantId: ctx.tenantId,
            category: 'WRITEOFF_REASON',
            code: (body.reasonCode as string).trim(),
          },
        },
      });
      if (!reason || reason.status !== 'ACTIVE') {
        throw new BadRequestException({
          code: 'WRITEOFF_REASON_INVALID',
          message: '核销原因未在字典中配置或已停用，请先在「字典管理」维护 WRITEOFF_REASON',
        });
      }
      const settle = await tx.settleAccount.findUnique({
        where: { tenantId_id: { tenantId: ctx.tenantId, id: settleAccountId } },
        select: { id: true },
      });
      if (!settle) {
        throw new NotFoundException({ code: 'SETTLE_ACCOUNT_NOT_FOUND' });
      }
      if (waterAccountId !== undefined) {
        const wa = await tx.waterAccount.findUnique({
          where: { tenantId_id: { tenantId: ctx.tenantId, id: waterAccountId } },
          select: { id: true, settleAccountId: true },
        });
        if (!wa) throw new NotFoundException({ code: 'WATER_ACCOUNT_NOT_FOUND' });
      }
      if (billId !== undefined) {
        const bill = await tx.bill.findUnique({
          where: { tenantId_id: { tenantId: ctx.tenantId, id: billId } },
          select: { id: true },
        });
        if (!bill) throw new NotFoundException({ code: 'BILL_NOT_FOUND' });
      }
      const created = await tx.badDebtWriteoff.create({
        data: {
          tenantId: ctx.tenantId,
          settleAccountId,
          ...(waterAccountId !== undefined ? { waterAccountId } : {}),
          ...(billId !== undefined ? { billId } : {}),
          amount: BigInt(body.amount as number),
          reasonCode: (body.reasonCode as string).trim(),
          ...(body.note !== undefined ? { note: body.note } : {}),
          effectiveDate,
          createdBy: ctx.staffId,
          updatedBy: ctx.staffId,
        },
      });
      // 任务书 T15：核销发起 → 审批任务（billing:write 候选，事后复核制）。
      const settleNo = await tx.settleAccount.findUnique({
        where: { tenantId_id: { tenantId: ctx.tenantId, id: settleAccountId } },
        select: { settleNo: true },
      });
      await this.tasks.createTask(tx, ctx, {
        type: 'WRITEOFF_APPROVAL',
        title: `核销审批：结算户 ${settleNo?.settleNo ?? settleAccountId} ¥${(Number(body.amount) / 100).toFixed(2)}`,
        bizType: 'badDebtWriteoff',
        bizId: created.id,
        bizLabel: settleNo?.settleNo ?? null,
        reason: `坏账核销登记（原因：${reason.name}）`,
        context: {
          writeoffId: created.id,
          settleAccountId,
          settleNo: settleNo?.settleNo ?? null,
          amountCent: String(body.amount),
          reasonCode: reason.code,
          reasonName: reason.name,
          waterAccountId: waterAccountId ?? null,
          billId: billId ?? null,
          effectiveDate: body.effectiveDate,
        },
        orgUnitId: null,
      });
      return created;
    });
  }

  /** POST /:id/reverse — 撤销核销（保留历史行，标 REVERSED）。 */
  @Post(':id/reverse')
  @Permissions('payment:write')
  async reverse(@Param('id') id: string, @Req() req: Request) {
    const ctx = currentTenant();
    const writeoffId = assertUuid(id, 'id');
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const row = await tx.badDebtWriteoff.findUnique({
        where: { tenantId_id: { tenantId: ctx.tenantId, id: writeoffId } },
      });
      if (!row) throw new NotFoundException({ code: 'WRITEOFF_NOT_FOUND' });
      if (row.status === 'REVERSED') {
        throw new BadRequestException({ code: 'WRITEOFF_ALREADY_REVERSED' });
      }
      req.auditBefore = row;
      return tx.badDebtWriteoff.update({
        where: { tenantId_id: { tenantId: ctx.tenantId, id: writeoffId } },
        data: {
          status: 'REVERSED',
          reversedAt: new Date(),
          reversedBy: ctx.staffId,
          updatedBy: ctx.staffId,
        },
      });
    });
  }
}
