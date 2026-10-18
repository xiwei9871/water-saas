import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { InstallApplyStatus, Prisma } from '@prisma/client';
import type { TenantCtx } from '../../common/tenant-context.js';
import { SequenceService } from '../../common/sequence.service.js';
import { TaskService } from '../task/task.service.js';
import { WaterAccountService, type OnboardBody } from '../customer/water-account.service.js';

/**
 * S1 报装申请（docs/GAP_ANALYSIS_2026-10.md，独立于营销主链的域）。
 *
 * 流程：SUBMITTED → SURVEYED → APPROVED → INSTALLING → COMPLETED
 *                                                  ↘（归档 = 调立户向导建账）
 * 任一步可 REJECTED / CANCELLED（终态）。提交即挂 INSTALL_REVIEW
 * 审批任务（任务中心候选按 install:write 反查），终态自动办结。
 */

const NEXT: Record<InstallApplyStatus, InstallApplyStatus[]> = {
  SUBMITTED: ['SURVEYED', 'REJECTED', 'CANCELLED'],
  SURVEYED: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['INSTALLING', 'REJECTED', 'CANCELLED'],
  INSTALLING: ['CANCELLED'],
  COMPLETED: [],
  REJECTED: [],
  CANCELLED: [],
};

export interface CreateApplyBody {
  applicantName: string;
  custType?: 'PERSONAL' | 'ORG';
  contactPhone?: string;
  addr: string;
  usageCategory: string;
  caliberReq?: string;
  remark?: string;
  orgUnitId?: string;
}

@Injectable()
export class InstallService {
  constructor(
    private readonly seq: SequenceService,
    private readonly tasks: TaskService,
    private readonly accounts: WaterAccountService,
  ) {}

  async createTx(tx: Prisma.TransactionClient, ctx: TenantCtx, body: CreateApplyBody) {
    const applyNo = await this.seq.nextFormatted(tx, ctx.tenantId, 'install_apply', 'BZ', ctx.staffId);
    const app = await tx.installApplication.create({
      data: {
        tenantId: ctx.tenantId,
        applyNo,
        applicantName: body.applicantName,
        custType: body.custType ?? 'PERSONAL',
        contactPhone: body.contactPhone,
        addr: body.addr,
        usageCategory: body.usageCategory,
        caliberReq: body.caliberReq,
        remark: body.remark,
        orgUnitId: body.orgUnitId ?? null,
        createdBy: ctx.staffId,
        updatedBy: ctx.staffId,
      },
    });
    await this.tasks.createTask(tx, ctx, {
      type: 'INSTALL_REVIEW',
      title: `报装申请 ${applyNo}（${body.applicantName}）待勘察审批`,
      bizType: 'INSTALL_APPLICATION',
      bizId: app.id,
      bizLabel: applyNo,
      reason: '新报装申请待勘察/审批',
      context: { applyNo, applicantName: body.applicantName, usageCategory: body.usageCategory, addr: body.addr },
      orgUnitId: body.orgUnitId ?? null,
    });
    return app;
  }

  async transitionTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    id: string,
    to: InstallApplyStatus,
    note?: string,
  ) {
    const app = await tx.installApplication.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!app) throw new NotFoundException({ code: 'APPLY_NOT_FOUND' });
    if (!NEXT[app.status].includes(to)) {
      throw new ConflictException({ code: 'INVALID_APPLY_TRANSITION', from: app.status, to });
    }
    const patch: Prisma.InstallApplicationUpdateInput = {
      status: to,
      updatedBy: ctx.staffId,
      ...(to === 'SURVEYED' && note !== undefined ? { surveyNote: note } : {}),
      ...(to === 'INSTALLING' && note !== undefined ? { installNote: note } : {}),
      ...(to === 'REJECTED' ? { rejectReason: note ?? '' } : {}),
    };
    const updated = await tx.installApplication.update({ where: { id: app.id }, data: patch });
    if (['REJECTED', 'CANCELLED'].includes(to)) {
      await this.tasks.autoCompleteByBiz(tx, ctx, 'INSTALL_REVIEW', 'INSTALL_APPLICATION', app.id, `申请${to === 'REJECTED' ? '被驳回' : '已取消'}`);
    }
    return updated;
  }

  /** 归档：INSTALLING 状态下按立户向导建账（同事务），回写户号并办结任务。 */
  async archiveTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    id: string,
    onboard: OnboardBody,
  ) {
    const app = await tx.installApplication.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!app) throw new NotFoundException({ code: 'APPLY_NOT_FOUND' });
    if (app.status !== 'INSTALLING' && app.status !== 'APPROVED') {
      throw new ConflictException({ code: 'APPLY_NOT_READY', status: app.status });
    }
    if (!onboard?.account || !onboard?.installation) {
      throw new BadRequestException({ code: 'ONBOARD_BODY_INVALID' });
    }
    // 归档客户缺省时用申请单信息建客——归档即立户不该要求重录申请人资料。
    const merged: OnboardBody = {
      ...onboard,
      customer:
        onboard.customer ??
        (onboard.customerId
          ? undefined
          : {
              name: app.applicantName,
              custType: app.custType as 'PERSONAL' | 'ORG',
              phone: app.contactPhone ?? undefined,
              addr: app.addr,
            }),
    };
    const result = await this.accounts.onboardTx(tx, ctx, merged);
    const waId = (result as { waterAccount?: { id: string } }).waterAccount?.id;
    if (!waId) throw new BadRequestException({ code: 'ONBOARD_NO_ACCOUNT' });
    const updated = await tx.installApplication.update({
      where: { id: app.id },
      data: { status: 'COMPLETED', waterAccountId: waId, updatedBy: ctx.staffId },
    });
    await this.tasks.autoCompleteByBiz(tx, ctx, 'INSTALL_REVIEW', 'INSTALL_APPLICATION', app.id, '归档完成');
    return { ...updated, waterAccountId: waId };
  }
}
