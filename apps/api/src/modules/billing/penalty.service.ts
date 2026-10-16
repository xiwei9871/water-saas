import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantCtx } from '../../common/tenant-context.js';

/**
 * G1 违约金计提（docs/GAP_ANALYSIS_2026-10.md）。
 *
 * 口径：欠费本金 × 日费率 × 逾期天数，封顶本金 × capRatio。
 *   - 本金 = 账单总额 − 已有违约金 − 已分摊金额（违约金不滚违约金）。
 *   - 逾期天数 = asOf − bill.dueDate（dueDate 为空的不计提）。
 *   - 每账单一行 PENALTY 账单项，重复计提幂等更新该行并重调总额。
 * 配置走 tenant_param 'billing.penalty'：{enabled,dailyRate,capRatio}，
 * 默认停用——未开启时调用方拿到显式 400 而不是静默 0 条。
 */
export interface PenaltyConfig {
  enabled: boolean;
  dailyRate: number;
  capRatio: number;
}

export const PENALTY_PARAM_KEY = 'billing.penalty';
const DEFAULT_CFG: PenaltyConfig = { enabled: false, dailyRate: 0.0005, capRatio: 0.5 };

const DAY_MS = 86_400_000;

@Injectable()
export class PenaltyService {
  async configTx(tx: Prisma.TransactionClient, ctx: TenantCtx): Promise<PenaltyConfig> {
    const row = await tx.tenantParam.findUnique({
      where: { tenantId_key: { tenantId: ctx.tenantId, key: PENALTY_PARAM_KEY } },
    });
    const v = row?.value as Partial<PenaltyConfig> | undefined;
    if (!v || typeof v !== 'object') return DEFAULT_CFG;
    return {
      enabled: v.enabled === true,
      dailyRate: typeof v.dailyRate === 'number' && v.dailyRate >= 0 ? v.dailyRate : DEFAULT_CFG.dailyRate,
      capRatio: typeof v.capRatio === 'number' && v.capRatio >= 0 ? v.capRatio : DEFAULT_CFG.capRatio,
    };
  }

  /** 计提扫描：返回逐户结果供响应与审计留痕。 */
  async accrueTx(tx: Prisma.TransactionClient, ctx: TenantCtx, asOf: Date) {
    const cfg = await this.configTx(tx, ctx);
    if (!cfg.enabled) {
      throw new BadRequestException({ code: 'PENALTY_DISABLED' });
    }
    const bills = await tx.bill.findMany({
      where: {
        tenantId: ctx.tenantId,
        status: { in: ['POSTED', 'PARTIAL_PAID'] },
        dueDate: { lt: asOf },
      },
      select: {
        id: true,
        dueDate: true,
        totalAmount: true,
        items: { where: { itemType: 'PENALTY' }, select: { id: true, amount: true } },
        allocs: { select: { amount: true } },
      },
    });
    let accrued = 0;
    let totalPenalty = 0n;
    const detail: { billId: string; days: number; amount: number }[] = [];
    for (const b of bills) {
      const existing = b.items.reduce((s, i) => s + i.amount, 0n);
      const allocated = b.allocs.reduce((s, a) => s + a.amount, 0n);
      const base = b.totalAmount - existing - allocated;
      const days = Math.floor((asOf.getTime() - b.dueDate!.getTime()) / DAY_MS);
      if (base <= 0n || days <= 0) continue;
      const raw = Number(base) * cfg.dailyRate * days;
      const capped = Math.min(Math.round(raw), Math.round(Number(base) * cfg.capRatio));
      const amount = BigInt(capped);
      const delta = amount - existing;
      if (delta === 0n) continue;
      const desc = `违约金（欠费本金 ¥${(Number(base) / 100).toFixed(2)}，逾期 ${days} 天）`;
      if (b.items.length > 0) {
        await tx.billItem.update({
          where: { id: b.items[0].id },
          data: { amount, description: desc, updatedBy: ctx.staffId },
        });
      } else {
        await tx.billItem.create({
          data: {
            tenantId: ctx.tenantId,
            billId: b.id,
            itemType: 'PENALTY',
            description: desc,
            amount,
            createdBy: ctx.staffId,
            updatedBy: ctx.staffId,
          },
        });
      }
      await tx.bill.update({
        where: { id: b.id },
        data: { totalAmount: { increment: delta }, updatedBy: ctx.staffId },
      });
      accrued += 1;
      totalPenalty += delta;
      detail.push({ billId: b.id, days, amount: capped });
    }
    return { scanned: bills.length, accrued, totalPenalty: totalPenalty.toString(), detail };
  }
}
