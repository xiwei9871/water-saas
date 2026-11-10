import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { InstallApplyStatus, Prisma } from '@prisma/client';
import type { TenantCtx } from '../../common/tenant-context.js';
import { SequenceService } from '../../common/sequence.service.js';
import { TaskService } from '../task/task.service.js';
import { WaterAccountService, type OnboardBody } from '../customer/water-account.service.js';
import { WebhookService } from '../../common/webhook.service.js';

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
  /** 问题6（1027）：申请人证件。 */
  certType?: string;
  certNo?: string;
  certPhoto?: unknown;
  /** R11：申请水表数量（1–9999）与口径明细 [{caliber, qty}]（合计须=数量）。 */
  meterQty?: number;
  caliberDetails?: { caliber: string; qty: number }[];
}

@Injectable()
export class InstallService {
  constructor(
    private readonly seq: SequenceService,
    private readonly tasks: TaskService,
    private readonly accounts: WaterAccountService,
    private readonly webhook: WebhookService,
  ) {}

  async createTx(tx: Prisma.TransactionClient, ctx: TenantCtx, body: CreateApplyBody) {
    const applyNo = await this.seq.nextFormatted(tx, ctx.tenantId, 'install_apply', 'BZ', ctx.staffId);
    // 受理即生成供用水合同号（2.2 要素：合同号在受理环节产生）。
    const contractNo = await this.seq.nextFormatted(tx, ctx.tenantId, 'install_contract', 'HT', ctx.staffId);
    // R11：数量/口径明细校验（申报口径合计须等于申请数量）。
    if (body.meterQty !== undefined) {
      const q = Number(body.meterQty);
      if (!Number.isInteger(q) || q < 1 || q > 9999) {
        throw new BadRequestException({ code: 'METER_QTY_INVALID', value: body.meterQty });
      }
    }
    const details = (body.caliberDetails ?? []).filter((d) => d && d.qty > 0);
    if (details.length) {
      const sum = details.reduce((s, d) => s + Math.floor(d.qty), 0);
      if (body.meterQty !== undefined && sum !== Number(body.meterQty)) {
        throw new BadRequestException({ code: 'CALIBER_DETAILS_MISMATCH', sum, meterQty: body.meterQty });
      }
      for (const d of details) {
        if (!Number.isInteger(d.qty) || d.qty < 1) {
          throw new BadRequestException({ code: 'CALIBER_DETAILS_INVALID', detail: d });
        }
      }
    }
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
        certType: body.certType ?? null,
        certNo: body.certNo ?? null,
        certPhoto: Array.isArray(body.certPhoto)
          ? body.certPhoto.slice(0, 3).map((x) => String(x).slice(0, 800_000))
          : undefined,
        orgUnitId: body.orgUnitId ?? null,
        meterQty: body.meterQty ?? null,
        caliberDetails: details.length ? (details as unknown as Prisma.InputJsonValue) : undefined,
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
    // X1-A：状态变更即推送工程系统（配置了 webhook.install.url 才发）。
    this.webhook.pushInstall(ctx.tenantId, {
      applyId: app.id, applyNo: app.applyNo, status: to,
      applicantName: app.applicantName, addr: app.addr,
      caliberDetails: app.caliberDetails, changedAt: new Date().toISOString(),
    });
    // X7：状态历史栈（最近在前，封顶 6 条；revert 弹栈回退）。
    const hist = [
      { status: app.status, at: new Date().toISOString(), by: ctx.staffId, to },
      ...((app.statusHistory as { status: string }[] | null) ?? []),
    ].slice(0, 6);
    const patch: Prisma.InstallApplicationUpdateInput = {
      status: to,
      statusHistory: hist as Prisma.InputJsonValue,
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

  /**
   * 归档确认（R3 合并精简）：不再承载建户逻辑——立户唯一入口是
   * POST /water-accounts/onboard（带 sourceApplyNo 自动办结本申请）。
   * 本端点仅在申请已被向导立户回写（waterAccountId 非空）后确认归档态，
   * 未立户的申请返回 409 指引走立户向导。
   */
  async archiveTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    id: string,
  ) {
    const app = await tx.installApplication.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!app) throw new NotFoundException({ code: 'APPLY_NOT_FOUND' });
    if (!app.waterAccountId) {
      throw new ConflictException({
        code: 'APPLY_NOT_ONBOARDED',
        message: '请先经「客户管理 → 立户向导」立户（来源报装单自动办结本申请）',
      });
    }
    if (app.status !== 'COMPLETED') {
      return tx.installApplication.update({
        where: { id: app.id },
        data: { status: 'COMPLETED', updatedBy: ctx.staffId },
      });
    }
    return app;
  }

  /**
   * X1 外部系统"安装完成"回推：校验字段齐备 → 存回推原文+字段 →
   * 状态推进至 INSTALLING（待放号）；缺字段返回 EXTERNAL_MISSING_FIELDS
   * 清单不写半成品。幂等键=externalOrderNo：重复回推同键→标记
   * externalConfirmed=false 等人工确认，不覆盖人工修订字段。
   */
  async externalCompleteTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    id: string,
    body: Record<string, unknown>,
  ) {
    const app = await tx.installApplication.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!app) throw new NotFoundException({ code: 'APPLY_NOT_FOUND' });
    if (body.applyNo && body.applyNo !== app.applyNo) {
      throw new BadRequestException({ code: 'EXTERNAL_APPLYNO_MISMATCH' });
    }
    const missing: string[] = [];
    for (const f of ['externalOrderNo', 'installCompletedAt', 'installInitialReading']) {
      if (body[f] === undefined || body[f] === null || body[f] === '') missing.push(f);
    }
    const meters = body.installMeters as { meterNo?: string }[] | undefined;
    if (!Array.isArray(meters) || meters.length === 0 || meters.some((m) => !m?.meterNo)) {
      missing.push('installMeters[].meterNo');
    }
    if (missing.length) {
      throw new BadRequestException({ code: 'EXTERNAL_MISSING_FIELDS', missing });
    }
    if (!['SUBMITTED', 'SURVEYED', 'APPROVED', 'INSTALLING'].includes(app.status)) {
      throw new ConflictException({ code: 'EXTERNAL_STATE_INVALID', from: app.status });
    }
    const isRepeat =
      app.externalOrderNo === String(body.externalOrderNo) && app.externalOrderNo !== null;
    const hist = [
      { status: app.status, at: new Date().toISOString(), by: ctx.staffId, to: 'INSTALLING', via: 'external' },
      ...((app.statusHistory as { status: string }[] | null) ?? []),
    ].slice(0, 6);
    return tx.installApplication.update({
      where: { id: app.id },
      data: {
        status: app.status === 'INSTALLING' ? 'INSTALLING' : 'INSTALLING',
        statusHistory: hist as Prisma.InputJsonValue,
        externalSource: String(body.sourceSystem ?? 'EXTERNAL'),
        externalOrderNo: String(body.externalOrderNo),
        externalPushedAt: new Date(),
        externalPayload: body as Prisma.InputJsonValue,
        // 重复回推：数据落地但需人工再确认（人工修订不被自动覆盖的标记位）。
        externalConfirmed: isRepeat ? false : false,
        installCompletedAt: new Date(String(body.installCompletedAt)),
        installInitialReading: Number(body.installInitialReading),
        installMeters: meters as Prisma.InputJsonValue,
        installMeterNo: String(body.installMeterNo ?? meters![0].meterNo),
        installCaliber: String(body.installCaliber ?? (meters![0] as { caliber?: string }).caliber ?? '') || null,
        ...(body.feeRequired !== undefined ? { feeRequired: Number(body.feeRequired) } : {}),
        ...(body.feeReceived !== undefined ? { feeReceived: Number(body.feeReceived) } : {}),
        ...(body.feeNote !== undefined ? { feeNote: String(body.feeNote) } : {}),
        ...(body.constructionContractNo !== undefined
          ? { constructionContractNo: String(body.constructionContractNo) }
          : {}),
        ...(body.surveyNote !== undefined ? { surveyNote: String(body.surveyNote) } : {}),
        ...(body.installNote !== undefined ? { installNote: String(body.installNote) } : {}),
        updatedBy: ctx.staffId,
      },
    });
  }

  /** X1 人工确认外部回推（修订字段走 PATCH 留 audit）。 */
  async confirmExternalTx(tx: Prisma.TransactionClient, ctx: TenantCtx, id: string) {
    return tx.installApplication.update({
      where: { tenantId_id: { tenantId: ctx.tenantId, id } },
      data: { externalConfirmed: true, updatedBy: ctx.staffId },
    });
  }

  /**
   * X7 撤销回退：弹状态历史栈回上一步（≤3 次/步骤，终态不可撤）。
   * 已填数据保留（本方法只回退 status 字段）。
   */
  async revertTx(tx: Prisma.TransactionClient, ctx: TenantCtx, id: string, reason: string) {
    const app = await tx.installApplication.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!app) throw new NotFoundException({ code: 'APPLY_NOT_FOUND' });
    if (['COMPLETED', 'CANCELLED', 'REJECTED'].includes(app.status)) {
      throw new ConflictException({ code: 'REVERT_NOT_ALLOWED', from: app.status });
    }
    const hist = (app.statusHistory as { status: string; to?: string }[] | null) ?? [];
    const prev = hist[0];
    if (!prev) throw new ConflictException({ code: 'REVERT_NO_HISTORY' });
    const reverts = hist.filter((h) => h.to === app.status).length;
    if (reverts >= 3) throw new ConflictException({ code: 'REVERT_LIMIT' });
    return tx.installApplication.update({
      where: { id: app.id },
      data: {
        status: prev.status as InstallApplyStatus,
        statusHistory: [
          ...hist.slice(1),
          { status: prev.status, at: new Date().toISOString(), by: ctx.staffId, to: app.status, reverted: true, reason },
        ].slice(0, 6) as Prisma.InputJsonValue,
        updatedBy: ctx.staffId,
      },
    });
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
