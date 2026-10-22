import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import type { TenantCtx } from '../../common/tenant-context.js';
import { ServiceOrderService } from './service-order.service.js';

/** 系统生成单据的操作者占位（staffId 无 FK，审计可查 sourceType=AUTO_CHECK）。 */
const SYSTEM_STAFF = '00000000-0000-0000-0000-000000000000';

/**
 * 20261021 整改 任务B：到期检定每日定时扫描。
 * 多租户下 tenant 表受 RLS 保护无法跨租户枚举 —— 定时范围由环境变量
 * `CRON_TENANT_IDS`（逗号分隔 uuid）声明；试点单租户只需配一个。
 */
@Injectable()
export class ServiceOrderCron {
  private readonly logger = new Logger(ServiceOrderCron.name);

  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly orders: ServiceOrderService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_2AM, { timeZone: 'Asia/Shanghai' })
  async scanCheckDueDaily(): Promise<void> {
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
        const r = await this.orders.scanCheckDue(ctx);
        if (r.created.length) {
          this.logger.log(`auto-check scan tenant=${tenantId} created=${r.created.length}`);
        }
      } catch (err) {
        this.logger.error(`auto-check scan tenant=${tenantId} failed: ${String(err)}`);
      }
    }
  }
}
