import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import type { TenantCtx } from '../../common/tenant-context.js';
import { bizDayStr } from '../../common/metering-model.js';
import { ReadingPlanService } from './reading-plan.service.js';

const SYSTEM_STAFF = '00000000-0000-0000-0000-000000000000';

/**
 * R5/A1 抄表「下一工作日」计划自动生成：每个工作日 18:00–23:00 整点
 * 扫描——以当前业务日为基准找下一个工作抄表日，命中段号 N 则对
 * 段号=N 的区段册生成计划（幂等）。每次运行写 plan_gen_run（含失败
 * 原因）支持补偿重试；多租户范围由 CRON_TENANT_IDS 声明，未配置
 * 启动即告警且每次扫描记 WARN（不产生任何生成动作）。
 */
@Injectable()
export class ReadingPlanCron implements OnModuleInit {
  private readonly logger = new Logger(ReadingPlanCron.name);

  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly plans: ReadingPlanService,
  ) {}

  onModuleInit() {
    if (this.tenantIds().length === 0) {
      this.logger.warn(
        'CRON_TENANT_IDS 未配置——自动生成抄表计划 cron 不会为任何租户执行',
      );
    }
  }

  private tenantIds(): string[] {
    return (process.env.CRON_TENANT_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  @Cron('0 0 18-23 * * *', { timeZone: 'Asia/Shanghai' })
  async generateNextDayPlans(): Promise<void> {
    const ids = this.tenantIds();
    if (ids.length === 0) {
      this.logger.warn('auto-plan skipped: CRON_TENANT_IDS empty');
      return;
    }
    const runDay = bizDayStr(new Date());
    for (const tenantId of ids) {
      // 1112v8-N3：租户参数二级开关——autoPlanEnabled=false 时跳过（默认启用兼容旧行为）。
      const toggle = await this.prisma.runAsTenant(tenantId, (tx) =>
        tx.tenantParam.findFirst({
          where: { tenantId, key: 'autoPlanEnabled' },
          select: { value: true },
        }),
      );
      if (toggle && String(toggle.value) === 'false') {
        this.logger.warn(`auto-plan skipped: tenant ${tenantId} autoPlanEnabled=false`);
        continue;
      }
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
            `auto-plan tenant=${tenantId} runDay=${runDay} seg=${r.segNo} generated=${r.generated.length}`,
          );
        }
      } catch (err) {
        // 失败详情已落 plan_gen_run(status=FAILED)，此处告警便于运维补偿重试。
        this.logger.error(
          `auto-plan tenant=${tenantId} runDay=${runDay} failed: ${String(err)}`,
        );
      }
    }
  }
}
