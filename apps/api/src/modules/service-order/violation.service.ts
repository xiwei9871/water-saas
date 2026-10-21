import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { assertAccountScopeTx, outOfScopeAccountIds } from '../../common/account-scope.js';
import { TenantCtx } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { TaskService } from '../task/task.service.js';
import { parseDate } from './service-order.types.js';

type Tx = Prisma.TransactionClient;

const bad = (code: string, extra?: Record<string, unknown>) =>
  new BadRequestException({ code, ...extra });

/** 归档佐证：现场照片 ≥1 + 处罚文书 ≥1（evidence.site / evidence.penaltyDoc）。 */
const ARCHIVE_NEED = ['site（现场照片）', 'penaltyDoc（处罚文书）'] as const;

/**
 * 20261021 整改 任务E：违章用水处理。
 * 两入口：稽查登记(INSPECT，直接 PROCESSING) / 抄表员上报(READING，先 PENDING_REVIEW)。
 * 处置链：登记→VIOLATION_HANDLE 任务→核实/处理(罚款+补缴)→佐证归档；
 * 可联动建表务工单（停水/拆表）。
 */
@Injectable()
export class ViolationService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly tasks: TaskService,
  ) {}

  list(
    ctx: TenantCtx,
    q: { status?: string; waterAccountId?: string; take: number; skip: number },
  ) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const excluded = ctx.scope === 'ALL' ? [] : await outOfScopeAccountIds(tx, ctx);
      const where: Prisma.WaterViolationWhereInput = {
        tenantId: ctx.tenantId,
        ...(q.status ? { status: q.status } : {}),
        ...(q.waterAccountId ? { waterAccountId: q.waterAccountId } : {}),
        ...(excluded.length ? { waterAccountId: { notIn: excluded } } : {}),
      };
      const [total, items] = await Promise.all([
        tx.waterViolation.count({ where }),
        tx.waterViolation.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: q.take,
          skip: q.skip,
        }),
      ]);
      return { total, items };
    });
  }

  /** 登记（INSPECT 直接进处理中；READING 经 meterReading 上报走待核实）。 */
  async createTx(
    tx: Tx,
    ctx: TenantCtx,
    body: {
      waterAccountId?: unknown;
      violationType?: unknown;
      occurredDate?: unknown;
      description?: unknown;
      photoRefs?: unknown;
      sourceType?: unknown;
      sourceReadingId?: unknown;
    },
    req: Request,
  ) {
    const waId = typeof body.waterAccountId === 'string' ? body.waterAccountId : '';
    const vtype = String(body.violationType ?? '').trim();
    if (!waId || !vtype) throw bad('VIOLATION_FIELDS_REQUIRED');
    await assertAccountScopeTx(tx, ctx, waId);
    // 违章类型以 VIOLATION_TYPE 字典为准
    const dict = await tx.sysDict.findFirst({
      where: { tenantId: ctx.tenantId, category: 'VIOLATION_TYPE', code: vtype, status: 'ACTIVE' },
      select: { code: true },
    });
    if (!dict) throw bad('VIOLATION_TYPE_INVALID', { violationType: vtype });

    const sourceType = body.sourceType === 'READING' ? 'READING' : 'INSPECT';
    let sourceId: string | null = null;
    if (sourceType === 'READING') {
      sourceId = typeof body.sourceReadingId === 'string' ? body.sourceReadingId : null;
      if (!sourceId) throw bad('SOURCE_READING_REQUIRED');
      const reading = await tx.meterReading.findFirst({
        where: { tenantId: ctx.tenantId, id: sourceId },
        select: { id: true, installationId: true },
      });
      if (!reading) throw new NotFoundException({ code: 'READING_NOT_FOUND' });
      // 校验该抄表记录确实属于该户
      const inst = await tx.meterInstallation.findFirst({
        where: { tenantId: ctx.tenantId, id: reading.installationId },
        select: { waterAccountId: true },
      });
      if (inst?.waterAccountId !== waId) {
        throw bad('READING_ACCOUNT_MISMATCH');
      }
    }
    const photos = Array.isArray(body.photoRefs)
      ? body.photoRefs.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
      : undefined;

    const row = await tx.waterViolation.create({
      data: {
        tenantId: ctx.tenantId,
        waterAccountId: waId,
        violationType: vtype,
        reporterId: ctx.staffId,
        occurredDate:
          body.occurredDate === undefined || body.occurredDate === null || body.occurredDate === ''
            ? null
            : parseDate(String(body.occurredDate), 'OCCURRED_DATE_INVALID'),
        description: body.description ? String(body.description) : null,
        photoRefs: photos?.length ? (photos as Prisma.InputJsonValue) : Prisma.JsonNull,
        status: sourceType === 'READING' ? 'PENDING_REVIEW' : 'PROCESSING',
        sourceType,
        sourceId,
        createdBy: ctx.staffId,
        updatedBy: ctx.staffId,
      },
    });
    // 违章处置任务（稽查岗 metering:service）——两条来源都要。
    const t = await this.tasks.createTask(tx, ctx, {
      type: 'VIOLATION_HANDLE',
      title: `违章处置：${vtype} 户${waId.slice(0, 8)}`,
      bizType: 'violation',
      bizId: row.id,
      reason: (body.description as string) ?? '违章用水登记/上报',
    });
    await tx.waterViolation.updateMany({
      where: { tenantId: ctx.tenantId, id: row.id },
      data: { taskId: t.id },
    });
    return { ...row, taskId: t.id };
  }

  /** 核实：PENDING_REVIEW → PROCESSING | DISMISSED。 */
  async verifyTx(
    tx: Tx,
    ctx: TenantCtx,
    id: string,
    body: { confirm?: unknown; note?: unknown },
    req: Request,
  ) {
    const cur = await tx.waterViolation.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!cur) throw new NotFoundException({ code: 'VIOLATION_NOT_FOUND' });
    if (cur.status !== 'PENDING_REVIEW') throw bad('VIOLATION_STATE', { status: cur.status });
    await assertAccountScopeTx(tx, ctx, cur.waterAccountId);
    req.auditBefore = cur;
    const confirm = body.confirm === true;
    const next = confirm ? 'PROCESSING' : 'DISMISSED';
    const row = await tx.waterViolation.update({
      where: { tenantId_id: { tenantId: ctx.tenantId, id } },
      data: {
        status: next,
        processNote: body.note ? String(body.note) : null,
        updatedBy: ctx.staffId,
      },
    });
    if (!confirm) {
      await this.tasks.autoCompleteByBiz(tx, ctx, 'VIOLATION_HANDLE', 'violation', id, '核实误报');
    }
    return row;
  }

  /** 处理：录罚款/补缴/经办 → PROCESSED；可挂联动工单 id。 */
  async processTx(
    tx: Tx,
    ctx: TenantCtx,
    id: string,
    body: {
      penaltyAmount?: unknown;
      backbillAmount?: unknown;
      note?: unknown;
      serviceOrderId?: unknown;
    },
    req: Request,
  ) {
    const cur = await tx.waterViolation.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!cur) throw new NotFoundException({ code: 'VIOLATION_NOT_FOUND' });
    if (cur.status !== 'PROCESSING') throw bad('VIOLATION_STATE', { status: cur.status });
    await assertAccountScopeTx(tx, ctx, cur.waterAccountId);
    req.auditBefore = cur;
    const num = (v: unknown) =>
      v === undefined || v === null || v === '' ? null : Number(v);
    const row = await tx.waterViolation.update({
      where: { tenantId_id: { tenantId: ctx.tenantId, id } },
      data: {
        status: 'PROCESSED',
        penaltyAmount: num(body.penaltyAmount),
        backbillAmount: num(body.backbillAmount),
        processNote: body.note ? String(body.note) : null,
        processorId: ctx.staffId,
        processedAt: new Date(),
        serviceOrderId:
          typeof body.serviceOrderId === 'string' ? body.serviceOrderId : cur.serviceOrderId,
        updatedBy: ctx.staffId,
      },
    });
    await this.tasks.autoCompleteByBiz(tx, ctx, 'VIOLATION_HANDLE', 'violation', id, '处理完成');
    return row;
  }

  /** 归档：须传 evidence.site[] + evidence.penaltyDoc[]（或 photoRefs 兜底）。 */
  async archiveTx(
    tx: Tx,
    ctx: TenantCtx,
    id: string,
    body: { evidence?: unknown; photoRefs?: unknown },
    req: Request,
  ) {
    const cur = await tx.waterViolation.findFirst({
      where: { tenantId: ctx.tenantId, id },
    });
    if (!cur) throw new NotFoundException({ code: 'VIOLATION_NOT_FOUND' });
    if (cur.status !== 'PROCESSED') throw bad('VIOLATION_STATE', { status: cur.status });
    await assertAccountScopeTx(tx, ctx, cur.waterAccountId);
    req.auditBefore = cur;
    const ev = (body.evidence ?? {}) as Record<string, unknown>;
    const site = [
      ...(Array.isArray(ev.site) ? ev.site : []),
      ...(Array.isArray(body.photoRefs) ? body.photoRefs : []),
      ...(Array.isArray(cur.photoRefs) ? (cur.photoRefs as unknown[]) : []),
    ].filter((x): x is string => typeof x === 'string' && x.trim() !== '');
    const docs = (Array.isArray(ev.penaltyDoc) ? ev.penaltyDoc : []).filter(
      (x): x is string => typeof x === 'string' && x.trim() !== '',
    );
    const missing: string[] = [];
    if (site.length < 1) missing.push(ARCHIVE_NEED[0]);
    if (docs.length < 1) missing.push(ARCHIVE_NEED[1]);
    if (missing.length) {
      throw bad('EVIDENCE_REQUIRED', {
        missing,
        message: `归档须佐证：${missing.join('、')}`,
      });
    }
    const row = await tx.waterViolation.update({
      where: { tenantId_id: { tenantId: ctx.tenantId, id } },
      data: {
        status: 'ARCHIVED',
        evidence: { site, penaltyDoc: docs } as Prisma.InputJsonValue,
        archivedBy: ctx.staffId,
        archivedAt: new Date(),
        updatedBy: ctx.staffId,
      },
    });
    return row;
  }
}
