import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantCtx } from '../../common/tenant-context.js';
import { TaskService } from '../task/task.service.js';

/**
 * G3 渠道对账（docs/GAP_ANALYSIS_2026-10.md）。
 *
 * 银行/三方通道回盘文件导入核账：文件行按 channel_ref=我方收款单号
 * （payment_no）逐笔核对，金额/状态不一致入明细表；我方有收、文件
 * 无单的计入 missing_in_file。存在差异时挂 RECON_HANDLE 处理任务。
 *
 * Mock 通道：mockStatement 用真实收款数据伪造一份通道对账单（演示/
 * 测试用），真实通道接入时替换为通道侧文件下载/推送。
 */

export interface ReconRowInput {
  ref: string;
  amount: bigint;
  paidAt?: Date;
  note?: string;
}

export interface ReconInput {
  channel: string;
  fileName?: string;
  bizDateFrom?: Date;
  bizDateTo?: Date;
  rows: ReconRowInput[];
}

/** CSV 行：收款单号,金额(元),支付时间(可空),备注(可空)。 */
export function parseReconCsv(content: string): ReconRowInput[] {
  const out: ReconRowInput[] = [];
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const [i, line] of lines.entries()) {
    if (i === 0 && /[,，].*元|ref|单号|amount/i.test(line) && !/^\d/.test(line)) continue; // 表头
    const cells = line.split(/[,，\t]/).map((c) => c.trim());
    const ref = cells[0];
    if (!ref) continue;
    const amountTxt = cells[1] ?? '';
    const yuan = Number(amountTxt);
    if (!Number.isFinite(yuan)) {
      throw new BadRequestException({ code: 'RECON_ROW_INVALID', field: `row ${i + 1}` });
    }
    const paidAt = cells[2] ? new Date(cells[2]) : undefined;
    out.push({ ref, amount: BigInt(Math.round(yuan * 100)), paidAt, note: cells[3] });
  }
  return out;
}

@Injectable()
export class ReconService {
  constructor(private readonly tasks: TaskService) {}

  async runTx(tx: Prisma.TransactionClient, ctx: TenantCtx, input: ReconInput) {
    if (!input.rows.length) {
      throw new BadRequestException({ code: 'RECON_EMPTY' });
    }
    const refs = input.rows.map((r) => r.ref);
    const payments = await tx.payment.findMany({
      where: { tenantId: ctx.tenantId, paymentNo: { in: refs } },
      select: { id: true, paymentNo: true, amount: true, status: true, channel: true },
    });
    const byNo = new Map(payments.map((p) => [p.paymentNo, p]));

    const batch = await tx.channelReconBatch.create({
      data: {
        tenantId: ctx.tenantId,
        channel: input.channel,
        fileName: input.fileName,
        bizDateFrom: input.bizDateFrom,
        bizDateTo: input.bizDateTo,
        totalRows: input.rows.length,
        createdBy: ctx.staffId,
        updatedBy: ctx.staffId,
      },
    });

    let matched = 0;
    let mismatched = 0;
    const rows: Prisma.ChannelReconRowCreateManyInput[] = [];
    input.rows.forEach((r, i) => {
      const p = byNo.get(r.ref);
      let status: 'MATCHED' | 'AMOUNT_MISMATCH' | 'NOT_FOUND' | 'STATUS_MISMATCH';
      let note = r.note;
      if (!p) status = 'NOT_FOUND';
      else if (p.status === 'REVERSED') {
        status = 'STATUS_MISMATCH';
        note = note ?? '我方已红冲，文件仍列收款';
      } else if (p.amount !== r.amount) status = 'AMOUNT_MISMATCH';
      else status = 'MATCHED';
      if (status === 'MATCHED') matched += 1;
      else mismatched += 1;
      rows.push({
        tenantId: ctx.tenantId,
        batchId: batch.id,
        rowNo: i + 1,
        channelRef: r.ref,
        amount: r.amount,
        paidAt: r.paidAt,
        matchStatus: status,
        paymentId: p?.id,
        note,
      });
    });
    await tx.channelReconRow.createMany({ data: rows });

    // 我方已收、文件缺失的单据
    const refSet = new Set(refs);
    const missing = await tx.payment.findMany({
      where: {
        tenantId: ctx.tenantId,
        channel: input.channel as never,
        status: { in: ['RECEIVED', 'DAY_CLOSED'] },
        ...(input.bizDateFrom || input.bizDateTo
          ? {
              receivedAt: {
                ...(input.bizDateFrom ? { gte: input.bizDateFrom } : {}),
                ...(input.bizDateTo ? { lte: new Date(input.bizDateTo.getTime() + 86_399_000) } : {}),
              },
            }
          : {}),
      },
      select: { paymentNo: true, amount: true },
      take: 5000,
    });
    const missingRows = missing.filter((p) => !refSet.has(p.paymentNo));

    let taskId: string | null = null;
    if (mismatched > 0 || missingRows.length > 0) {
      const t = await this.tasks.createTask(tx, ctx, {
        type: 'RECON_HANDLE',
        title: `对账差异（${input.channel}：文件 ${input.rows.length} 笔，差异 ${mismatched} 笔，缺单 ${missingRows.length} 笔）`,
        bizType: 'RECON_BATCH',
        bizId: batch.id,
        bizLabel: input.fileName ?? `${input.channel} 对账文件`,
        reason: '渠道对账存在差异，需逐笔核实处理',
        context: {
          batchId: batch.id,
          channel: input.channel,
          mismatched,
          missingInFile: missingRows.length,
          missingRefs: missingRows.slice(0, 20).map((m) => m.paymentNo),
        },
        orgUnitId: null,
      });
      taskId = t.id || null;
    }

    const updated = await tx.channelReconBatch.update({
      where: { id: batch.id },
      data: {
        matched,
        mismatched,
        missingInFile: missingRows.length,
        taskId,
        updatedBy: ctx.staffId,
      },
    });
    return { batch: updated, missingRefs: missingRows.map((m) => m.paymentNo) };
  }
}
