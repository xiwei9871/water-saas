import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ServiceOrderStatus } from '@prisma/client';
import type { Request } from 'express';
import { assertAccountScopeTx, outOfScopeAccountIds } from '../../common/account-scope.js';
import { SequenceService } from '../../common/sequence.service.js';
import { TenantCtx } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { CloseAccountUseCase } from '../customer/use-cases/close-account.use-case.js';
import { MeterInstallationService } from '../customer/meter-installation.service.js';
import { WaterAccountService, type EventBody } from '../customer/water-account.service.js';
import { TaskService } from '../task/task.service.js';
import {
  ARCHIVE_EVIDENCE,
  parseCheckPayload,
  parseClosePayload,
  parseDate,
  parseFaultPayload,
  parseSitePayload,
  parseStatusPayload,
  SERVICE_TYPES,
  type ServiceType,
} from './service-order.types.js';

type Tx = Prisma.TransactionClient;

/** 工单来源（20261020 核查 T5）：人工发起 / 抄表异常上报 / 到期检定扫描。 */
export const ORDER_SOURCE_TYPES = ['MANUAL', 'READING_REPORT', 'AUTO_CHECK'] as const;
export type OrderSourceType = (typeof ORDER_SOURCE_TYPES)[number];

export interface ServiceOrderBody {
  waterAccountId: string;
  serviceType: string;
  reason?: string;
  meterInstallationId?: string;
  meterId?: string;
  /** 申请侧补充信息（地址/联系方式/预约时间等），原样存 payload。 */
  payload?: Prisma.InputJsonValue;
  sourceType?: OrderSourceType;
  /** 抄表上报的 meter_reading.id — 校验同租户且推导账户一致。 */
  sourceReadingId?: string;
  /** 现场照片引用（上传接口返回值），合并进 payload.photoRefs。 */
  photoRefs?: string[];
}

export interface ExecuteBody {
  resultNote?: string;
  /** 各类型执行载荷：见 service-order.types.ts 各 parse*Payload。 */
  payload?: Record<string, unknown>;
}

const SELECT = {
  id: true,
  orderNo: true,
  waterAccountId: true,
  meterInstallationId: true,
  meterId: true,
  serviceType: true,
  reason: true,
  payload: true,
  sourceType: true,
  sourceReadingId: true,
  orgUnitId: true,
  status: true,
  applicantId: true,
  appliedAt: true,
  approverId: true,
  approvedAt: true,
  approvalNote: true,
  dispatcherId: true,
  assigneeId: true,
  dispatchedAt: true,
  taskId: true,
  executedBy: true,
  executedAt: true,
  resultNote: true,
  linkRef: true,
  archivedBy: true,
  archivedAt: true,
  createdAt: true,
} satisfies Prisma.MeterServiceOrderSelect;

const invalid = (from: string, to: string) =>
  new ConflictException({ code: 'SERVICE_ORDER_INVALID_TRANSITION', from, to });

/**
 * 表务工单（20261019 整合需求 T1-T6）— 11 类表务处置统一工单流：
 *   申请 → 审批(tenant_param meterService.requireApproval 可关) →
 *   派单(自动建 Task) → 执行(域联动) → 归档；可驳回/撤销。
 *
 * 执行联动：CHECK 类写 AccountEvent(METER_CHECK)；FAULT 走 replaceTx
 * 三要素分段；SUSPEND/STOP → suspendTx；RESUME → resumeTx；CLOSE →
 * CloseAccountUseCase（余额/预存校验内置）。所有域动作与工单状态翻转
 * 同事务提交 — 联动失败整体回滚，工单不落 EXECUTED 假完成。
 */
@Injectable()
export class ServiceOrderService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly seq: SequenceService,
    private readonly tasks: TaskService,
    private readonly accounts: WaterAccountService,
    private readonly installations: MeterInstallationService,
    private readonly closeAccount: CloseAccountUseCase,
  ) {}

  async list(
    ctx: TenantCtx,
    q: {
      take: number;
      skip: number;
      status?: ServiceOrderStatus;
      serviceType?: string;
      waterAccountId?: string;
      orgUnitId?: string;
      sourceType?: string;
      from?: string;
      to?: string;
    },
  ) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const excluded = ctx.scope === 'ALL' ? [] : await outOfScopeAccountIds(tx, ctx);
      const where: Prisma.MeterServiceOrderWhereInput = {
        tenantId: ctx.tenantId,
        ...(q.status ? { status: q.status } : {}),
        ...(q.serviceType ? { serviceType: q.serviceType } : {}),
        ...(q.waterAccountId ? { waterAccountId: q.waterAccountId } : {}),
        ...(q.orgUnitId ? { orgUnitId: q.orgUnitId } : {}),
        ...(q.sourceType ? { sourceType: q.sourceType } : {}),
        ...(excluded.length ? { waterAccountId: { notIn: excluded } } : {}),
        ...(q.from || q.to
          ? {
              createdAt: {
                ...(q.from ? { gte: parseDate(q.from, 'FROM_INVALID') } : {}),
                ...(q.to ? { lte: parseDate(q.to, 'TO_INVALID') } : {}),
              },
            }
          : {}),
      };
      const [total, items] = await Promise.all([
        tx.meterServiceOrder.count({ where }),
        tx.meterServiceOrder.findMany({
          where,
          select: SELECT,
          orderBy: { createdAt: 'desc' },
          take: q.take,
          skip: q.skip,
        }),
      ]);
      await this.hydrateNames(tx, items);
      return { total, items };
    });
  }

  async getById(ctx: TenantCtx, id: string) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const row = await tx.meterServiceOrder.findFirst({
        where: { tenantId: ctx.tenantId, id },
        select: { ...SELECT, updatedAt: true },
      });
      if (!row) throw new NotFoundException({ code: 'SERVICE_ORDER_NOT_FOUND' });
      await assertAccountScopeTx(tx, ctx, row.waterAccountId);
      await this.hydrateNames(tx, [row]);
      // 目标表具档案（T6 执行屏展示）：优先工单 meterId，否则经表位推导。
      const targetMeterId =
        row.meterId ??
        (row.meterInstallationId
          ? (
              await tx.meterInstallation.findFirst({
                where: { tenantId: ctx.tenantId, id: row.meterInstallationId },
                select: { meterId: true },
              })
            )?.meterId ?? null
          : null);
      const targetMeter = targetMeterId
        ? await tx.meter.findFirst({
            where: { tenantId: ctx.tenantId, id: targetMeterId },
            select: {
              id: true,
              meterNo: true,
              serialNo: true,
              caliber: true,
              brand: true,
              model: true,
              maxDial: true,
              checkPeriodYears: true,
              lastCheckDate: true,
              status: true,
            },
          })
        : null;
      const installation = row.meterInstallationId
        ? await tx.meterInstallation.findFirst({
            where: { tenantId: ctx.tenantId, id: row.meterInstallationId },
            select: {
              id: true,
              status: true,
              installedAt: true,
              removedAt: true,
              initialReading: true,
              finalReading: true,
              locationRemark: true,
            },
          })
        : null;
      return { ...row, targetMeter, installation };
    });
  }

  // ------------------------------------------------------------------
  // 申请
  // ------------------------------------------------------------------
  create(ctx: TenantCtx, body: ServiceOrderBody) {
    return this.prisma.runAsTenant(ctx.tenantId, (tx) => this.createTx(tx, ctx, body));
  }

  async createTx(tx: Tx, ctx: TenantCtx, body: ServiceOrderBody) {
    if (!SERVICE_TYPES.includes(body.serviceType as never)) {
      throw new BadRequestException({
        code: 'SERVICE_TYPE_INVALID',
        serviceType: body.serviceType,
      });
    }
    await assertAccountScopeTx(tx, ctx, body.waterAccountId);
    const account = await tx.waterAccount.findFirst({
      where: { tenantId: ctx.tenantId, id: body.waterAccountId },
      select: { id: true, status: true },
    });
    if (!account) throw new NotFoundException({ code: 'WATER_ACCOUNT_NOT_FOUND' });
    if (account.status === 'CLOSED') {
      throw new ConflictException({ code: 'ACCOUNT_CLOSED' });
    }

    // 抄表上报来源：reading 必须属于本租户且经 installation 归属同一户；
    // 表位/水表可从读数自动带出（上报人只选了户和照片时不必再挑表位）。
    let installationId = body.meterInstallationId ?? null;
    let meterId = body.meterId ?? null;
    if (body.sourceReadingId) {
      const reading = await tx.meterReading.findFirst({
        where: { tenantId: ctx.tenantId, id: body.sourceReadingId },
        select: {
          id: true,
          meterId: true,
          installation: { select: { id: true, waterAccountId: true } },
        },
      });
      if (!reading) throw new BadRequestException({ code: 'SOURCE_READING_NOT_FOUND' });
      if (reading.installation.waterAccountId !== body.waterAccountId) {
        throw new BadRequestException({ code: 'SOURCE_READING_ACCOUNT_MISMATCH' });
      }
      installationId ??= reading.installation.id;
      meterId ??= reading.meterId;
    }
    if (installationId) {
      const inst = await tx.meterInstallation.findFirst({
        where: {
          tenantId: ctx.tenantId,
          id: installationId,
          waterAccountId: body.waterAccountId,
        },
        select: { id: true, meterId: true },
      });
      if (!inst) {
        throw new BadRequestException({ code: 'INSTALLATION_ACCOUNT_MISMATCH' });
      }
      meterId ??= inst.meterId;
    } else {
      // 未指定表位 → 自动挂该户最新在装表位（抄表上报等入口只传户号；
      // 目标表具档案/检定回写都依赖这个关联）。
      const active = await tx.meterInstallation.findFirst({
        where: {
          tenantId: ctx.tenantId,
          waterAccountId: body.waterAccountId,
          status: 'ACTIVE',
        },
        select: { id: true, meterId: true },
        orderBy: { installedAt: 'desc' },
      });
      if (active) {
        installationId = active.id;
        meterId ??= active.meterId;
      }
    }
    const sourceType: OrderSourceType =
      body.sourceType && (ORDER_SOURCE_TYPES as readonly string[]).includes(body.sourceType)
        ? body.sourceType
        : 'MANUAL';

    // 片区锚点：该户覆盖册中任意一本的 orgUnitId（统计按时间×片区用）。
    // ReadingPlan 上无 book 关系对象，分两段解析。
    const planItem = await tx.readingPlanItem.findFirst({
      where: { tenantId: ctx.tenantId, waterAccountId: body.waterAccountId },
      select: { planId: true },
    });
    const plan = planItem
      ? await tx.readingPlan.findFirst({
          where: { tenantId: ctx.tenantId, id: planItem.planId },
          select: { bookId: true },
        })
      : null;
    const book = plan
      ? await tx.readingBook.findFirst({
          where: { tenantId: ctx.tenantId, id: plan.bookId },
          select: { orgUnitId: true },
        })
      : null;
    const orgUnitId = book?.orgUnitId ?? null;

    // 审批可配置：tenant_param meterService.requireApproval = 'false' 时跳过
    // 审批环节，申请即 APPROVED 可派单（小水司单人流程）。
    const param = await tx.tenantParam.findUnique({
      where: { tenantId_key: { tenantId: ctx.tenantId, key: 'meterService.requireApproval' } },
      select: { value: true },
    });
    const requireApproval = String(param?.value ?? 'true') !== 'false';
    const status: ServiceOrderStatus = requireApproval ? 'PENDING_APPROVAL' : 'APPROVED';

    const orderNo = await this.seq.nextFormatted(
      tx,
      ctx.tenantId,
      'service_order',
      'SG',
      ctx.staffId,
    );
    const order = await tx.meterServiceOrder.create({
      data: {
        tenantId: ctx.tenantId,
        orderNo,
        waterAccountId: body.waterAccountId,
        meterInstallationId: installationId,
        meterId,
        serviceType: body.serviceType,
        reason: body.reason ?? null,
        payload: body.photoRefs?.length
          ? ({
              ...((body.payload as Record<string, unknown>) ?? {}),
              photoRefs: body.photoRefs,
            } as Prisma.InputJsonValue)
          : (body.payload ?? Prisma.JsonNull),
        sourceType,
        sourceReadingId: body.sourceReadingId ?? null,
        orgUnitId,
        status,
        applicantId: ctx.staffId,
        approvedAt: requireApproval ? null : new Date(),
        approverId: requireApproval ? null : ctx.staffId,
        createdBy: ctx.staffId,
        updatedBy: ctx.staffId,
      },
      select: SELECT,
    });
    // 20261020 核查 T2：待审批节点自动建审批任务进待办中心
    // （dedupe 由 task_open_dedupe 兜底）。
    if (requireApproval) {
      await this.tasks.createTask(tx, ctx, {
        type: 'SVC_APPROVAL',
        title: `表务工单待审批 ${orderNo}`,
        bizType: 'service_order',
        bizId: order.id,
        reason: body.reason ?? '表务工单申请',
      });
    }
    return order;
  }

  // ------------------------------------------------------------------
  // 审批 / 驳回
  // ------------------------------------------------------------------
  approveTx(tx: Tx, ctx: TenantCtx, id: string, body: { note?: string }, req: Request) {
    return this.transition(tx, ctx, id, 'PENDING_APPROVAL', 'APPROVED', req, async (t) => {
      const row = await t.meterServiceOrder.update({
        where: { tenantId_id: { tenantId: ctx.tenantId, id } },
        data: {
          approverId: ctx.staffId,
          approvedAt: new Date(),
          approvalNote: body.note ?? null,
        },
        select: SELECT,
      });
      await this.tasks.autoCompleteByBiz(t, ctx, 'SVC_APPROVAL', 'service_order', id, '审批通过');
      return row;
    });
  }

  rejectTx(tx: Tx, ctx: TenantCtx, id: string, body: { note?: string }, req: Request) {
    return this.transition(tx, ctx, id, 'PENDING_APPROVAL', 'REJECTED', req, async (t) => {
      const row = await t.meterServiceOrder.update({
        where: { tenantId_id: { tenantId: ctx.tenantId, id } },
        data: { approverId: ctx.staffId, approvedAt: new Date(), approvalNote: body.note ?? null },
        select: SELECT,
      });
      await this.tasks.autoCompleteByBiz(t, ctx, 'SVC_APPROVAL', 'service_order', id, '审批驳回');
      return row;
    });
  }

  // ------------------------------------------------------------------
  // 派单 — 翻转 + SVC_EXECUTE Task 创建同事务；Task 幂等靠 task_open_dedupe
  // ------------------------------------------------------------------
  dispatchTx(
    tx: Tx,
    ctx: TenantCtx,
    id: string,
    body: { assigneeId?: string; note?: string },
    req: Request,
  ) {
    return this.transition(tx, ctx, id, 'APPROVED', 'DISPATCHED', req, async (t) => {
      const task = await this.tasks.createTask(t, ctx, {
        type: 'SVC_EXECUTE',
        title: `表务工单待执行`,
        bizType: 'service_order',
        bizId: id,
        reason: body.note ?? '表务派单',
      });
      return t.meterServiceOrder.update({
        where: { tenantId_id: { tenantId: ctx.tenantId, id } },
        data: {
          dispatcherId: ctx.staffId,
          assigneeId: body.assigneeId ?? null,
          dispatchedAt: new Date(),
          taskId: task.id || null,
        },
        select: SELECT,
      });
    });
  }

  // ------------------------------------------------------------------
  // 执行 — 域联动同事务；重放安全（已 EXECUTED 直接返回）
  // ------------------------------------------------------------------
  async executeTx(tx: Tx, ctx: TenantCtx, id: string, body: ExecuteBody, req: Request) {
    {
      const order = await tx.meterServiceOrder.findFirst({
        where: { tenantId: ctx.tenantId, id },
      });
      if (!order) throw new NotFoundException({ code: 'SERVICE_ORDER_NOT_FOUND' });
      if (order.status === 'EXECUTED' || order.status === 'ARCHIVED') {
        return tx.meterServiceOrder.findUniqueOrThrow({
          where: { tenantId_id: { tenantId: ctx.tenantId, id } },
          select: SELECT,
        });
      }
      if (order.status !== 'DISPATCHED') throw invalid(order.status, 'EXECUTED');
      await assertAccountScopeTx(tx, ctx, order.waterAccountId);
      req.auditBefore = order;

      const linkRef = await this.runLinkage(tx, ctx, order, body, req);
      const flipped = await tx.meterServiceOrder.updateMany({
        where: { tenantId: ctx.tenantId, id, status: 'DISPATCHED' },
        data: {
          status: 'EXECUTED',
          executedBy: ctx.staffId,
          executedAt: new Date(),
          resultNote: body.resultNote ?? null,
          linkRef: linkRef ?? Prisma.JsonNull,
          updatedBy: ctx.staffId,
        },
      });
      if (flipped.count === 0) throw invalid(order.status, 'EXECUTED');
      await this.tasks.autoCompleteByBiz(tx, ctx, 'SVC_EXECUTE', 'service_order', id, '执行完成');
      return tx.meterServiceOrder.findUniqueOrThrow({
        where: { tenantId_id: { tenantId: ctx.tenantId, id } },
        select: SELECT,
      });
    }
  }

  /** 各类型执行载荷 → 域动作；返回写入 linkRef 的产物引用。 */
  private async runLinkage(
    tx: Tx,
    ctx: TenantCtx,
    order: {
      id: string;
      orderNo: string;
      waterAccountId: string;
      meterInstallationId: string | null;
      meterId: string | null;
      serviceType: string;
      payload?: Prisma.JsonValue | null;
    },
    body: ExecuteBody,
    req: Request,
  ): Promise<Prisma.InputJsonValue | undefined> {
    const t = order.serviceType;
    // 现场照片留证（全类型）：payload.photoRefs → linkRef 合并带出。
    const photoRefs = Array.isArray(body.payload?.photoRefs)
      ? (body.payload!.photoRefs as unknown[]).filter((x): x is string => typeof x === 'string')
      : undefined;
    const withPhotos = (
      ref: Record<string, unknown> | undefined,
    ): Prisma.InputJsonValue | undefined =>
      photoRefs?.length
        ? ({ ...(ref ?? {}), photoRefs } as Prisma.InputJsonValue)
        : (ref as Prisma.InputJsonValue | undefined);

    if (t === 'PERIODIC_CHECK' || t === 'DISPUTE_CHECK') {
      // 在网表到期检定 = 先换表后送检（20261021 整改 任务B）：工单 payload
      // 标记 needReplace 时，执行需同时传换表三要素 + 检定载荷。
      const needReplace =
        (order.payload as Record<string, unknown> | null)?.needReplace === true;
      let replaceRef: Record<string, unknown> | undefined;
      if (needReplace) {
        const fp = parseFaultPayload(body.payload);
        const installationId =
          order.meterInstallationId ??
          (typeof body.payload?.meterInstallationId === 'string'
            ? body.payload.meterInstallationId
            : null);
        if (!installationId) {
          throw new BadRequestException({ code: 'FAULT_INSTALLATION_REQUIRED' });
        }
        const result = await this.installations.replaceTx(
          tx,
          ctx,
          installationId,
          {
            newMeterId: fp.newMeterId,
            oldFinalReading: new Prisma.Decimal(fp.oldFinalReading),
            newInitialReading: new Prisma.Decimal(fp.newInitialReading),
            replacedAt: parseDate(fp.replacedAt, 'REPLACED_AT_INVALID'),
            reason: 'PERIODIC_CHECK',
          },
          req,
        );
        replaceRef = {
          removedInstallationId: installationId,
          newInstallationId: result.installed?.id ?? null,
          newMeterId: fp.newMeterId,
        };
      }
      const p = parseCheckPayload(body.payload);
      const ev = await tx.accountEvent.create({
        data: {
          tenantId: ctx.tenantId,
          waterAccountId: order.waterAccountId,
          type: 'METER_CHECK',
          payload: {
            orderNo: order.orderNo,
            checkOrg: p.checkOrg ?? null,
            checkDate: p.checkDate ?? null,
            checkResult: p.checkResult ?? null,
            checkError: p.checkError ?? null,
            certNo: p.certNo ?? null,
            nextCheckDate: p.nextCheckDate ?? null,
            photoRefs: photoRefs ?? null,
          },
          effectiveDate: parseDate(p.effectiveDate) ?? parseDate(p.checkDate) ?? new Date(),
          createdBy: ctx.staffId,
          updatedBy: ctx.staffId,
        },
        select: { id: true },
      });
      // 检定结果回写表具档案：lastCheckDate ← checkDate；下次检定
      // 日期由 checkPeriodYears 推算，机构给出 nextCheckDate 时优先。
      const checkDay = parseDate(p.checkDate) ?? parseDate(p.effectiveDate);
      if (order.meterId && checkDay) {
        await tx.meter.updateMany({
          where: { tenantId: ctx.tenantId, id: order.meterId },
          data: { lastCheckDate: checkDay, updatedBy: ctx.staffId },
        });
      }
      return withPhotos({
        accountEventId: ev.id,
        nextCheckDate: p.nextCheckDate ?? null,
        ...(replaceRef ? { replace: replaceRef } : {}),
      });
    }
    if (t === 'FAULT') {
      const p = parseFaultPayload(body.payload);
      // 工单发起时可不关联表位；执行时 payload.meterInstallationId 兜底。
      const installationId =
        order.meterInstallationId ??
        (typeof body.payload?.meterInstallationId === 'string'
          ? body.payload.meterInstallationId
          : null);
      if (!installationId) {
        throw new BadRequestException({ code: 'FAULT_INSTALLATION_REQUIRED' });
      }
      const result = await this.installations.replaceTx(
        tx,
        ctx,
        installationId,
        {
          newMeterId: p.newMeterId,
          oldFinalReading: new Prisma.Decimal(p.oldFinalReading),
          newInitialReading: new Prisma.Decimal(p.newInitialReading),
          replacedAt: parseDate(p.replacedAt, 'REPLACED_AT_INVALID'),
          reason: 'FAULT',
        },
        req,
      );
      return withPhotos({
        removedInstallationId: installationId,
        newInstallationId: result.installed?.id ?? null,
        newMeterId: p.newMeterId,
      });
    }
    if (t === 'SUSPEND' || t === 'STOP' || t === 'RESUME') {
      const p = parseStatusPayload(body.payload);
      const ev: EventBody = {
        effectiveDate: parseDate(p.effectiveDate),
        remark: p.remark ?? `表务工单 ${order.orderNo}`,
      };
      const updated =
        t === 'RESUME'
          ? await this.accounts.resumeTx(tx, ctx, order.waterAccountId, ev, req)
          : await this.accounts.suspendTx(tx, ctx, order.waterAccountId, ev, req);
      return withPhotos({ waterAccountStatus: updated.status });
    }
    if (t === 'CLOSE') {
      // 销户=拆表+结清（20261020 核查 T6）：先按拆除读数拆表，再走
      // CloseAccountUseCase 的欠款/预存校验 —— 任一失败整体回滚。
      const p = parseClosePayload(body.payload);
      let installationId =
        order.meterInstallationId ?? p.meterInstallationId ?? null;
      if (!installationId) {
        const active = await tx.meterInstallation.findFirst({
          where: {
            tenantId: ctx.tenantId,
            waterAccountId: order.waterAccountId,
            status: 'ACTIVE',
          },
          select: { id: true },
          orderBy: { installedAt: 'desc' },
        });
        installationId = active?.id ?? null;
      }
      if (!installationId) {
        throw new BadRequestException({ code: 'CLOSE_NO_ACTIVE_INSTALLATION' });
      }
      const removed = await this.installations.removeTx(
        tx,
        ctx,
        installationId,
        {
          finalReading: new Prisma.Decimal(p.finalReading),
          removedAt: parseDate(p.removedAt, 'REMOVED_AT_INVALID'),
        },
        req,
      );
      const closed = await this.closeAccount.execute(
        tx,
        ctx,
        order.waterAccountId,
        {
          effectiveDate: parseDate(p.removedAt, 'REMOVED_AT_INVALID'),
          remark: p.remark ?? `表务销户 ${order.orderNo}`,
        },
        req,
      );
      return withPhotos({
        waterAccountStatus: closed.status,
        removedInstallationId: removed.id,
        finalReading: p.finalReading,
      });
    }
    if (t === 'FLOW_LIMIT') {
      // 限流：无账户状态机动作，方式/限值/恢复日期留痕 linkRef。
      const p = parseStatusPayload(body.payload);
      return withPhotos({
        limitMethod: p.limitMethod ?? null,
        limitValue: p.limitValue ?? null,
        effectiveDate: p.effectiveDate ?? null,
        restoreDate: p.restoreDate ?? null,
      });
    }
    // FACILITY_MAINTENANCE / SITE_RECTIFICATION / METER_GROUP_CLEANING：
    // 现场作业内容 + 照片留痕。
    const site = parseSitePayload(body.payload);
    return withPhotos({ content: site.content ?? null, sitePhotoRefs: site.photoRefs ?? null });
  }

  // ------------------------------------------------------------------
  // 归档 / 撤销
  // ------------------------------------------------------------------
  archiveTx(tx: Tx, ctx: TenantCtx, id: string, body: { photoRefs?: unknown }, req: Request) {
    return this.transition(tx, ctx, id, 'EXECUTED', 'ARCHIVED', req, async (t) => {
      // 20261021 整改 任务A：归档前强制佐证校验 —— linkRef.photoRefs ∪
      // 归档补传 photoRefs，数量按处置类型清单核对，不足拒绝归档。
      const cur = await t.meterServiceOrder.findUniqueOrThrow({
        where: { tenantId_id: { tenantId: ctx.tenantId, id } },
        select: { serviceType: true, linkRef: true },
      });
      const spec = ARCHIVE_EVIDENCE[cur.serviceType as ServiceType];
      if (spec) {
        const stored = (cur.linkRef as Record<string, unknown> | null)?.photoRefs;
        const merged = new Set<string>(
          [
            ...(Array.isArray(stored) ? stored : []),
            ...(Array.isArray(body.photoRefs) ? body.photoRefs : []),
          ].filter((x): x is string => typeof x === 'string' && x.trim() !== ''),
        );
        if (merged.size < spec.min) {
          throw new BadRequestException({
            code: 'EVIDENCE_REQUIRED',
            need: spec.items,
            got: merged.size,
            message: `归档需佐证资料：${spec.items.join('、')}（至少 ${spec.min} 项，当前 ${merged.size} 项）`,
          });
        }
        if (Array.isArray(body.photoRefs) && body.photoRefs.length) {
          await t.meterServiceOrder.update({
            where: { tenantId_id: { tenantId: ctx.tenantId, id } },
            data: {
              linkRef: {
                ...((cur.linkRef as Record<string, unknown> | null) ?? {}),
                photoRefs: [...merged],
              } as Prisma.InputJsonValue,
            },
          });
        }
      }
      const row = await t.meterServiceOrder.update({
        where: { tenantId_id: { tenantId: ctx.tenantId, id } },
        data: { archivedBy: ctx.staffId, archivedAt: new Date() },
        select: SELECT,
      });
      await this.tasks.autoCompleteByBiz(t, ctx, 'SVC_APPROVAL', 'service_order', id, '归档');
      await this.tasks.autoCompleteByBiz(t, ctx, 'SVC_EXECUTE', 'service_order', id, '归档');
      return row;
    });
  }

  async cancelTx(tx: Tx, ctx: TenantCtx, id: string, body: { reason?: string }, req: Request) {
    {
      const order = await tx.meterServiceOrder.findFirst({
        where: { tenantId: ctx.tenantId, id },
        select: { id: true, status: true, waterAccountId: true },
      });
      if (!order) throw new NotFoundException({ code: 'SERVICE_ORDER_NOT_FOUND' });
      if (!['PENDING_APPROVAL', 'APPROVED', 'DISPATCHED'].includes(order.status)) {
        throw invalid(order.status, 'CANCELLED');
      }
      await assertAccountScopeTx(tx, ctx, order.waterAccountId);
      req.auditBefore = order;
      const flipped = await tx.meterServiceOrder.updateMany({
        where: { tenantId: ctx.tenantId, id, status: order.status },
        data: {
          status: 'CANCELLED',
          approvalNote: body.reason ?? null,
          updatedBy: ctx.staffId,
        },
      });
      if (flipped.count === 0) throw invalid(order.status, 'CANCELLED');
      await this.tasks.autoCompleteByBiz(tx, ctx, 'SVC_APPROVAL', 'service_order', id, '工单撤销');
      await this.tasks.autoCompleteByBiz(tx, ctx, 'SVC_EXECUTE', 'service_order', id, '工单撤销');
      return tx.meterServiceOrder.findUniqueOrThrow({
        where: { tenantId_id: { tenantId: ctx.tenantId, id } },
        select: SELECT,
      });
    }
  }

  // ------------------------------------------------------------------
  // T12 查询：水表生命周期轨迹 — 该户装/拆/换 + 表务工单 + 账户事件
  // 合成一条时间线（归档口径以档案留痕为准）。
  // ------------------------------------------------------------------
  async meterLifecycle(ctx: TenantCtx, waterAccountId: string) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      await assertAccountScopeTx(tx, ctx, waterAccountId);
      const [installations, orders, events] = await Promise.all([
        tx.meterInstallation.findMany({
          where: { tenantId: ctx.tenantId, waterAccountId },
          select: {
            id: true,
            meterId: true,
            installedAt: true,
            removedAt: true,
            initialReading: true,
            finalReading: true,
            reason: true,
            status: true,
          },
          orderBy: { installedAt: 'asc' },
        }),
        tx.meterServiceOrder.findMany({
          where: { tenantId: ctx.tenantId, waterAccountId },
          select: {
            id: true,
            orderNo: true,
            serviceType: true,
            status: true,
            appliedAt: true,
            executedAt: true,
            resultNote: true,
            linkRef: true,
          },
          orderBy: { appliedAt: 'asc' },
        }),
        tx.accountEvent.findMany({
          where: { tenantId: ctx.tenantId, waterAccountId },
          select: { id: true, type: true, payload: true, effectiveDate: true, createdAt: true },
          orderBy: { effectiveDate: 'asc' },
        }),
      ]);
      // 换表记录（T12 之三）：REMOVED 安装行的 (finalReading, removedAt)
      // 与接替行的 (initialReading, installedAt) — 分段水量由结算端
      // ConsumptionComponent(installation 维度) 落地，此处给查询侧明细。
      const timeline = [
        ...installations.flatMap((i) => [
          {
            at: i.installedAt,
            kind: 'INSTALL' as const,
            refId: i.id,
            meterId: i.meterId,
            detail: { reason: i.reason, initialReading: i.initialReading },
          },
          ...(i.removedAt
            ? [
                {
                  at: i.removedAt,
                  kind: 'REMOVE' as const,
                  refId: i.id,
                  meterId: i.meterId,
                  detail: { reason: i.reason, finalReading: i.finalReading },
                },
              ]
            : []),
        ]),
        ...orders.map((o) => ({
          at: o.executedAt ?? o.appliedAt,
          kind: 'SERVICE_ORDER' as const,
          refId: o.id,
          meterId: null as string | null,
          detail: {
            orderNo: o.orderNo,
            serviceType: o.serviceType,
            status: o.status,
            resultNote: o.resultNote,
            linkRef: o.linkRef,
          },
        })),
        ...events.map((e) => ({
          at: e.effectiveDate,
          kind: 'ACCOUNT_EVENT' as const,
          refId: e.id,
          meterId: null as string | null,
          detail: { type: e.type, payload: e.payload },
        })),
      ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
      return { waterAccountId, installations, orders, timeline };
    });
  }

  // ------------------------------------------------------------------
  // 到期检定扫描（20261020 核查 T4）：对 设有 checkPeriodYears +
  // lastCheckDate 的在装水表，下次检定日 ≤ 触发日(默认提前
  // meterService.checkLeadDays=30 天) 即自动生成 PERIODIC_CHECK 工单
  // （sourceType=AUTO_CHECK）并建审批任务。幂等：同表存在未完结
  // 检定类工单则跳过。无检定属性/无上次检定日期的表不生成任务。
  // POST /service-orders/scan-check-due — 人工/调度均可触发。
  // ------------------------------------------------------------------
  async scanCheckDue(
    ctx: TenantCtx,
    opts?: { leadDays?: number; asOf?: string },
  ) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const param = await tx.tenantParam.findUnique({
        where: { tenantId_key: { tenantId: ctx.tenantId, key: 'meterService.checkLeadDays' } },
        select: { value: true },
      });
      const leadDays =
        opts?.leadDays ?? Math.max(0, parseInt(String(param?.value ?? '30'), 10) || 30);
      const asOf = opts?.asOf ? parseDate(opts.asOf, 'AS_OF_INVALID')! : new Date();
      const triggerAt = new Date(asOf.getTime() + leadDays * 86400000);

      const due = await tx.$queryRaw<
        {
          installation_id: string;
          water_account_id: string;
          meter_id: string;
          meter_no: string;
          next_check_date: Date;
        }[]
      >`
        SELECT mi.id AS installation_id, mi.water_account_id, m.id AS meter_id,
               m.meter_no,
               (m.last_check_date + make_interval(years => m.check_period_years))::timestamp
                 AS next_check_date
        FROM meter m
        JOIN meter_installation mi
          ON mi.tenant_id = m.tenant_id AND mi.meter_id = m.id AND mi.status = 'ACTIVE'
        JOIN water_account wa
          ON wa.tenant_id = m.tenant_id AND wa.id = mi.water_account_id
        WHERE m.tenant_id = ${ctx.tenantId}::uuid
          AND m.check_period_years IS NOT NULL
          AND m.last_check_date IS NOT NULL
          AND m.last_check_date + make_interval(years => m.check_period_years)
                <= ${triggerAt}
          AND wa.status <> 'CLOSED'
          AND NOT EXISTS (
            SELECT 1 FROM meter_service_order so
            WHERE so.tenant_id = m.tenant_id
              AND so.meter_id = m.id
              AND so.service_type IN ('PERIODIC_CHECK', 'DISPUTE_CHECK')
              AND so.status IN ('PENDING_APPROVAL', 'APPROVED', 'DISPATCHED', 'EXECUTED')
          )`;

      const created = [];
      for (const d of due) {
        const order = await this.createTx(tx, ctx, {
          waterAccountId: d.water_account_id,
          serviceType: 'PERIODIC_CHECK',
          // 在网表周期检定 = 换表+送检（20261021 整改 任务B）：执行时须
          // 先完成换表三要素，再录检定结果。
          reason: `水表 ${d.meter_no} 检定到期（下次检定日 ${d.next_check_date.toISOString().slice(0, 10)}，在网表需先换表后送检）`,
          meterInstallationId: d.installation_id,
          meterId: d.meter_id,
          sourceType: 'AUTO_CHECK',
          payload: { needReplace: true },
        });
        created.push({
          orderId: order.id,
          orderNo: order.orderNo,
          waterAccountId: d.water_account_id,
          meterNo: d.meter_no,
          nextCheckDate: d.next_check_date,
        });
      }
      return { leadDays, asOf, scanned: due.length, created };
    });
  }

  // ------------------------------------------------------------------
  // T11 表务处置统计：类型×状态交叉分布 + 平均处置时长 + 按期完成率
  // （按期 = appliedAt→executedAt ≤ 72h，tenant_param
  //  meterService.slaHours 可改）。期间过滤落在 appliedAt 上。
  // ------------------------------------------------------------------
  async stats(ctx: TenantCtx, q: { from?: string; to?: string }) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const param = await tx.tenantParam.findUnique({
        where: { tenantId_key: { tenantId: ctx.tenantId, key: 'meterService.slaHours' } },
        select: { value: true },
      });
      const slaHours = Math.max(1, parseInt(String(param?.value ?? '72'), 10) || 72);
      const from = parseDate(q.from, 'FROM_INVALID');
      const to = q.to
        ? new Date(`${parseDate(q.to, 'TO_INVALID')!.toISOString().slice(0, 10)}T23:59:59.999Z`)
        : undefined;

      const byTypeStatus = await tx.$queryRaw<
        { service_type: string; status: string; n: bigint }[]
      >`
        SELECT service_type, status::text AS status, count(*)::bigint AS n
        FROM meter_service_order
        WHERE tenant_id = ${ctx.tenantId}::uuid
          AND (${from ?? null}::timestamptz IS NULL OR applied_at >= ${from ?? null}::timestamptz)
          AND (${to ?? null}::timestamptz IS NULL OR applied_at <= ${to ?? null}::timestamptz)
        GROUP BY service_type, status`;

      const dur = await tx.$queryRaw<
        { service_type: string; avg_hours: number | null; on_time: bigint; done: bigint }[]
      >`
        SELECT service_type,
               avg(EXTRACT(EPOCH FROM (executed_at - applied_at)) / 3600.0) AS avg_hours,
               count(*) FILTER (WHERE executed_at - applied_at <= make_interval(hours => ${slaHours}::int))::bigint AS on_time,
               count(*)::bigint AS done
        FROM meter_service_order
        WHERE tenant_id = ${ctx.tenantId}::uuid
          AND executed_at IS NOT NULL
          AND (${from ?? null}::timestamptz IS NULL OR applied_at >= ${from ?? null}::timestamptz)
          AND (${to ?? null}::timestamptz IS NULL OR applied_at <= ${to ?? null}::timestamptz)
        GROUP BY service_type`;

      // ---- 20261021 整改 任务G：文档口径 6 表务指标 ----
      const periodEnd = to ?? new Date();
      const kpis = await tx.$queryRaw<
        {
          replaced: bigint;
          fault_replaced: bigint;
          active_total: bigint;
          due_total: bigint;
          checked: bigint;
          check_pass: bigint;
          check_total: bigint;
          resume_on_time: bigint;
          resume_total: bigint;
          svc_on_time: bigint;
          svc_total: bigint;
        }[]
      >`
        WITH repl AS (
          SELECT reason, count(*)::bigint n
          FROM meter_installation
          WHERE tenant_id = ${ctx.tenantId}::uuid
            AND reason IN ('REPLACE', 'FAULT', 'PERIODIC_CHECK')
            AND installed_at <= ${periodEnd}
            AND (${from ?? null}::timestamptz IS NULL OR installed_at >= ${from ?? null}::timestamptz)
          GROUP BY reason
        ),
        due AS (
          SELECT count(*)::bigint n FROM meter m
          WHERE m.tenant_id = ${ctx.tenantId}::uuid
            AND m.check_period_years IS NOT NULL
            AND m.last_check_date IS NOT NULL
            AND m.last_check_date + make_interval(years => m.check_period_years) <= ${periodEnd}
        ),
        checked AS (
          SELECT count(DISTINCT so.meter_id)::bigint n
          FROM meter_service_order so
          WHERE so.tenant_id = ${ctx.tenantId}::uuid
            AND so.service_type IN ('PERIODIC_CHECK','DISPUTE_CHECK')
            AND so.status IN ('EXECUTED','ARCHIVED')
            AND so.executed_at <= ${periodEnd}
            AND (${from ?? null}::timestamptz IS NULL OR so.executed_at >= ${from ?? null}::timestamptz)
        ),
        chk AS (
          SELECT count(*)::bigint total,
                 count(*) FILTER (WHERE payload->>'checkResult' IN ('PASS','ADJUSTED'))::bigint pass
          FROM account_event
          WHERE tenant_id = ${ctx.tenantId}::uuid
            AND type = 'METER_CHECK'
            AND effective_date <= ${periodEnd}
            AND (${from ?? null}::timestamptz IS NULL OR effective_date >= ${from ?? null}::timestamptz)
        ),
        svc AS (
          SELECT count(*)::bigint total,
                 count(*) FILTER (WHERE executed_at - applied_at <= make_interval(hours => ${slaHours}::int))::bigint on_time,
                 count(*) FILTER (WHERE service_type = 'RESUME')::bigint resume_total,
                 count(*) FILTER (WHERE service_type = 'RESUME'
                   AND executed_at - applied_at <= make_interval(hours => ${slaHours}::int))::bigint resume_on_time
          FROM meter_service_order
          WHERE tenant_id = ${ctx.tenantId}::uuid
            AND executed_at IS NOT NULL
            AND applied_at <= ${periodEnd}
            AND (${from ?? null}::timestamptz IS NULL OR applied_at >= ${from ?? null}::timestamptz)
        )
        SELECT
          COALESCE((SELECT sum(n) FROM repl), 0) AS replaced,
          COALESCE((SELECT n FROM repl WHERE reason = 'FAULT'), 0) AS fault_replaced,
          (SELECT count(*)::bigint FROM meter_installation
            WHERE tenant_id = ${ctx.tenantId}::uuid AND status = 'ACTIVE') AS active_total,
          (SELECT n FROM due) AS due_total,
          (SELECT n FROM checked) AS checked,
          (SELECT pass FROM chk) AS check_pass,
          (SELECT total FROM chk) AS check_total,
          (SELECT resume_on_time FROM svc) AS resume_on_time,
          (SELECT resume_total FROM svc) AS resume_total,
          (SELECT on_time FROM svc) AS svc_on_time,
          (SELECT total FROM svc) AS svc_total`;

      const k = kpis[0];
      const ratio = (a: bigint | number, b: bigint | number) =>
        Number(b) > 0 ? Number(a) / Number(b) : null;
      const metrics = {
        /** 换表率 = 本期换表数 ÷ 在装表总数 */
        replaceRate: ratio(k.replaced, k.active_total),
        /** 故障换表率 = 故障换表 ÷ 换表总数 */
        faultReplaceRate: ratio(k.fault_replaced, k.replaced),
        /** 周期检定完成率 = 期内已执行检定处置 ÷ 到期应检表数 */
        checkDoneRate: ratio(k.checked, k.due_total),
        /** 检定合格率 = PASS/ADJUSTED ÷ 检定事件总数 */
        checkPassRate: ratio(k.check_pass, k.check_total),
        /** 复水及时率 = 时限内复水 ÷ 应复水 */
        resumeOnTimeRate: ratio(k.resume_on_time, k.resume_total),
        /** 表务处置及时率 = 时限内完成 ÷ 完成总数 */
        svcOnTimeRate: ratio(k.svc_on_time, k.svc_total),
      };

      return { slaHours, byTypeStatus, durations: dur, metrics };
    });
  }

  // ------------------------------------------------------------------
  // T12 换表记录：REMOVED 安装行配对后继 ACTIVE 行（同户同表位接续），
  // 给出分段水量所需的 old.finalReading / new.initialReading 明细。
  // ------------------------------------------------------------------
  async replaceRecords(
    ctx: TenantCtx,
    q: { take: number; skip: number; waterAccountId?: string },
  ) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const excluded = ctx.scope === 'ALL' ? [] : await outOfScopeAccountIds(tx, ctx);
      // 换表记录以「新装行」为锚点：replaceTx 把 reason=REPLACE/FAULT
      // 写在新安装行上，其 installedAt = 老行 removedAt（同一物理时刻）。
      const where: Prisma.MeterInstallationWhereInput = {
        tenantId: ctx.tenantId,
        reason: { in: ['REPLACE', 'FAULT'] },
        ...(q.waterAccountId ? { waterAccountId: q.waterAccountId } : {}),
        ...(excluded.length ? { waterAccountId: { notIn: excluded } } : {}),
      };
      const [total, newRows] = await Promise.all([
        tx.meterInstallation.count({ where }),
        tx.meterInstallation.findMany({
          where,
          select: {
            id: true,
            waterAccountId: true,
            meterId: true,
            installedAt: true,
            initialReading: true,
            reason: true,
            status: true,
            waterAccount: {
              select: { accountNo: true, customer: { select: { name: true, customerNo: true } } },
            },
            meter: { select: { meterNo: true, serialNo: true } },
          },
          orderBy: { installedAt: 'desc' },
          take: q.take,
          skip: q.skip,
        }),
      ]);
      // 配对被换下的一行：同户 removedAt = 新行 installedAt。
      const predecessors = await tx.meterInstallation.findMany({
        where: {
          tenantId: ctx.tenantId,
          status: 'REMOVED',
          OR: newRows.map((r) => ({
            waterAccountId: r.waterAccountId,
            removedAt: r.installedAt,
          })),
        },
        select: {
          id: true,
          waterAccountId: true,
          meterId: true,
          installedAt: true,
          removedAt: true,
          initialReading: true,
          finalReading: true,
          meter: { select: { meterNo: true, serialNo: true } },
        },
      });
      const prev = new Map(
        predecessors.map((p) => [`${p.waterAccountId}:${p.removedAt!.toISOString()}`, p]),
      );
      const items = newRows.map((r) => {
        const old = prev.get(`${r.waterAccountId}:${r.installedAt.toISOString()}`);
        return {
          newInstallationId: r.id,
          removedInstallationId: old?.id ?? null,
          waterAccountId: r.waterAccountId,
          waterAccountLabel: r.waterAccount
            ? `${r.waterAccount.accountNo} ${r.waterAccount.customer.name}`
            : null,
          reason: r.reason,
          replacedAt: r.installedAt,
          oldMeter: old
            ? {
                meterId: old.meterId,
                meterNo: old.meter.meterNo,
                serialNo: old.meter.serialNo,
                finalReading: old.finalReading,
                installedAt: old.installedAt,
                initialReading: old.initialReading,
              }
            : null,
          newMeter: {
            meterId: r.meterId,
            meterNo: r.meter.meterNo,
            serialNo: r.meter.serialNo,
            initialReading: r.initialReading,
            status: r.status,
          },
        };
      });
      return { total, items };
    });
  }

  // ------------------------------------------------------------------
  // 内部
  // ------------------------------------------------------------------
  /**
   * Guarded single-step transition: the UPDATE predicate includes the
   * expected from-status so a concurrent transition loses the race
   * (count=0 → 409) instead of double-writing.
   */
  private async transition(
    tx: Tx,
    ctx: TenantCtx,
    id: string,
    from: ServiceOrderStatus,
    to: ServiceOrderStatus,
    req: Request,
    mutate: (t: Tx) => Promise<unknown>,
  ) {
    const order = await tx.meterServiceOrder.findFirst({
      where: { tenantId: ctx.tenantId, id },
      select: { id: true, status: true, waterAccountId: true },
    });
    if (!order) throw new NotFoundException({ code: 'SERVICE_ORDER_NOT_FOUND' });
    if (order.status !== from) throw invalid(order.status, to);
    await assertAccountScopeTx(tx, ctx, order.waterAccountId);
    req.auditBefore = order;
    const flipped = await tx.meterServiceOrder.updateMany({
      where: { tenantId: ctx.tenantId, id, status: from },
      data: { status: to, updatedBy: ctx.staffId },
    });
    if (flipped.count === 0) throw invalid(from, to);
    await mutate(tx);
    return tx.meterServiceOrder.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: ctx.tenantId, id } },
      select: SELECT,
    });
  }

  private async hydrateNames(
    tx: Tx,
    items: {
      applicantId?: string | null;
      approverId?: string | null;
      assigneeId?: string | null;
      executedBy?: string | null;
      waterAccountId?: string | null;
      meterId?: string | null;
      sourceReadingId?: string | null;
    }[],
  ) {
    const ids = [
      ...new Set(
        items
          .flatMap((i) => [i.applicantId, i.approverId, i.assigneeId, i.executedBy])
          .filter((x): x is string => Boolean(x)),
      ),
    ];
    if (ids.length) {
      const staff = await tx.staff.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true },
      });
      const names = new Map(staff.map((s) => [s.id, s.name]));
      for (const i of items) {
        Object.assign(i, {
          applicantName: i.applicantId ? (names.get(i.applicantId) ?? '—') : null,
          approverName: i.approverId ? (names.get(i.approverId) ?? '—') : null,
          assigneeName: i.assigneeId ? (names.get(i.assigneeId) ?? '—') : null,
          executedByName: i.executedBy ? (names.get(i.executedBy) ?? '—') : null,
        });
      }
    }
    // 展示层取值规范：用水户/表具/读数一律回填业务编号，前端不得拼截断 UUID
    const accIds = [
      ...new Set(items.map((i) => i.waterAccountId).filter((x): x is string => Boolean(x))),
    ];
    if (accIds.length) {
      const accs = await tx.waterAccount.findMany({
        where: { id: { in: accIds } },
        select: {
          id: true,
          accountNo: true,
          addr: true,
          customer: { select: { name: true, customerNo: true } },
        },
      });
      const accMap = new Map(accs.map((a) => [a.id, a]));
      for (const i of items) {
        const a = i.waterAccountId ? accMap.get(i.waterAccountId) : null;
        Object.assign(i, {
          waterAccountLabel: a
            ? `${a.accountNo} ${a.customer.name}（${a.addr}）`
            : null,
        });
      }
    }
    const meterIds = [
      ...new Set(items.map((i) => i.meterId).filter((x): x is string => Boolean(x))),
    ];
    if (meterIds.length) {
      const meters = await tx.meter.findMany({
        where: { id: { in: meterIds } },
        select: { id: true, meterNo: true, serialNo: true },
      });
      const mMap = new Map(meters.map((m) => [m.id, m]));
      for (const i of items) {
        const m = i.meterId ? mMap.get(i.meterId) : null;
        Object.assign(i, { meterLabel: m ? `${m.meterNo}${m.serialNo ? ` / ${m.serialNo}` : ''}` : null });
      }
    }
    const readingIds = [
      ...new Set(items.map((i) => i.sourceReadingId).filter((x): x is string => Boolean(x))),
    ];
    if (readingIds.length) {
      const readings = await tx.meterReading.findMany({
        where: { id: { in: readingIds } },
        select: { id: true, readingValue: true, readingDate: true },
      });
      const rMap = new Map(readings.map((r) => [r.id, r]));
      for (const i of items) {
        const r = i.sourceReadingId ? rMap.get(i.sourceReadingId) : null;
        Object.assign(i, {
          sourceReadingLabel: r ? `读数 ${r.readingValue}` : null,
        });
      }
    }
  }
}
