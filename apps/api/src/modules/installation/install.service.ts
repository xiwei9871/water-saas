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
    // 受理即生成供用水合同号（2.2 要素：合同号在受理环节产生）。
    const contractNo = await this.seq.nextFormatted(tx, ctx.tenantId, 'install_contract', 'HT', ctx.staffId);
    const app = await tx.installApplication.create({
      data: {
        tenantId: ctx.tenantId,
        applyNo,
        contractNo,
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
    installInitialReading?: number,
    installInfo?: {
      meterNo?: string;
      caliber?: string;
      completedAt?: Date;
      feeRequired?: number;
      feeReceived?: number;
      feeNote?: string;
    },
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
      ...(to === 'INSTALLING' && installInitialReading !== undefined
        ? { installInitialReading }
        : {}),
      // 2.1 接收完成信息：表号/口径/装表完成日期/工程费随装表流转一并登记。
      ...(to === 'INSTALLING' && installInfo?.meterNo !== undefined
        ? { installMeterNo: installInfo.meterNo }
        : {}),
      ...(to === 'INSTALLING' && installInfo?.caliber !== undefined
        ? { installCaliber: installInfo.caliber }
        : {}),
      ...(to === 'INSTALLING' && installInfo?.completedAt !== undefined
        ? { installCompletedAt: installInfo.completedAt }
        : {}),
      ...(to === 'INSTALLING' && installInfo?.feeRequired !== undefined
        ? { feeRequired: installInfo.feeRequired }
        : {}),
      ...(to === 'INSTALLING' && installInfo?.feeReceived !== undefined
        ? { feeReceived: installInfo.feeReceived }
        : {}),
      ...(to === 'INSTALLING' && installInfo?.feeNote !== undefined
        ? { feeNote: installInfo.feeNote }
        : {}),
      ...(to === 'REJECTED' ? { rejectReason: note ?? '' } : {}),
    };
    const updated = await tx.installApplication.update({ where: { id: app.id }, data: patch });
    if (['REJECTED', 'CANCELLED'].includes(to)) {
      await this.tasks.autoCompleteByBiz(tx, ctx, 'INSTALL_REVIEW', 'INSTALL_APPLICATION', app.id, `申请${to === 'REJECTED' ? '被驳回' : '已取消'}`);
    }
    // V7：取消时已收工程费须线下退款——响应带 refundDue 供前端警示。
    const refundDue =
      to === 'CANCELLED' && app.feeReceived && Number(app.feeReceived) > 0
        ? Number(app.feeReceived)
        : undefined;
    return { ...updated, refundDue };
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
    // 2.2 报装纳入：立户事务写入来源单号（户/新建客户/新建表记 source_apply_no）。
    const result = await this.accounts.onboardTx(tx, ctx, {
      ...merged,
      sourceApplyNo: app.applyNo,
    });
    const waId = (result as { waterAccount?: { id: string } }).waterAccount?.id;
    if (!waId) throw new BadRequestException({ code: 'ONBOARD_NO_ACCOUNT' });
    const updated = await this.completeFromOnboardTx(tx, ctx, app, result);
    return { ...updated, waterAccountId: waId };
  }

  /**
   * 归档/向导立户共用的回写：申请单 → COMPLETED + 正向回写
   * 结算户/表号 + INSTALL_REVIEW 任务自动办结（2.2 正向回写）。
   */
  async completeFromOnboardTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    app: { id: string; applyNo: string },
    result: unknown,
  ) {
    const waId = (result as { waterAccount?: { id: string } }).waterAccount?.id;
    if (!waId) throw new BadRequestException({ code: 'ONBOARD_NO_ACCOUNT' });
    const settleId = (result as { settleAccount?: { id: string } }).settleAccount?.id ?? null;
    const settleNo = (result as { settleAccount?: { settleNo?: string } }).settleAccount?.settleNo ?? null;
    const meterNo = (result as { meter?: { meterNo: string } }).meter?.meterNo ?? null;
    const updated = await tx.installApplication.update({
      where: { id: app.id },
      data: {
        status: 'COMPLETED',
        waterAccountId: waId,
        settleAccountId: settleId,
        meterNo,
        updatedBy: ctx.staffId,
      },
    });
    await this.tasks.autoCompleteByBiz(tx, ctx, 'INSTALL_REVIEW', 'INSTALL_APPLICATION', app.id, '归档完成');
    await this.ensureFeeCollectionTask(tx, ctx, app.id, settleId, settleNo);
    return updated;
  }

  /** V7 工程费闭环：应收 &gt; 实收的差额 → 立户时自动生成催缴任务（走收费侧补收）。 */
  private async ensureFeeCollectionTask(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    appId: string,
    settleAccountId: string | null,
    settleNo: string | null,
  ) {
    if (!settleAccountId) return;
    const app = await tx.installApplication.findFirst({
      where: { tenantId: ctx.tenantId, id: appId },
      select: { applyNo: true, feeRequired: true, feeReceived: true },
    });
    if (!app?.feeRequired) return;
    const deficit = app.feeRequired.minus(app.feeReceived ?? 0);
    if (deficit.lte(0)) return;
    const deficitCent = deficit.mul(100).toFixed(0);
    await this.tasks.createTask(tx, ctx, {
      type: 'COLLECTION',
      title: `工程费补收：${app.applyNo} 差额 ¥${deficit.toFixed(2)}`,
      bizType: 'settleAccount',
      bizId: settleAccountId,
      bizLabel: settleNo,
      reason: `报装 ${app.applyNo} 工程费应收 ¥${app.feeRequired} 实收 ¥${app.feeReceived ?? 0}，差额随户挂账`,
      context: {
        settleNo: settleNo ?? settleAccountId,
        arrearsCent: deficitCent,
        overdueDays: 0,
        feeApplyNo: app.applyNo,
        feeRequired: app.feeRequired.toString(),
        feeReceived: app.feeReceived?.toString() ?? '0',
      },
      orgUnitId: null,
    });
  }
}
