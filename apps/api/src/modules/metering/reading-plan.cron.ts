import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import type { TenantCtx } from '../../common/tenant-context.js';
import { ReadingPlanService } from './reading-plan.service.js';

const SYSTEM_STAFF = '00000000-0000-0000-0000-000000000000';

/**
 * R5 抄表前一工作日 18:00–24:00 自动生成次日计划。
 * 每个抄表日前一晚整点扫描：次日若是当月第 N 个抄表段工作日，
 * 为段号=N 的在用区段册生成次日计划（幂等，已生成跳过）。
 * 多租户范围由 CRON_TENANT_IDS 声明（与检定扫描同口径）。
 */
@Injectable()
export class ReadingPlanCron {
  private readonly logger = new Logger(ReadingPlanCron.name);

  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly plans: ReadingPlanService,
  ) {}

  @Cron('0 0 18-23 * * *', { timeZone: 'Asia/Shanghai' })
  async generateNextDayPlans(): Promise<void> {
    const ids = (process.env.CRON_TENANT_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const tenantId of ids) {
      const ctx: TenantCtx = {
        tenantId,
        staffId: SYSTEM_STAFF,
        scope: 'ALL',
        orgScope: [],
      };
      try {
        const r = await this.plans.autoGenerateForDate(ctx, new Date());
        if (r.generated.length) {
          this.logger.log(
            `auto-plan tenant=${tenantId} seg=${r.segNo} generated=${r.generated.length}`,
          );
        }
      } catch (err) {
        this.logger.error(`auto-plan tenant=${tenantId} failed: ${String(err)}`);
      }
    }
  }
}
