import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TenantPrismaService } from '../../common/tenant-prisma.js';

/**
 * Y3（1112v8）：次年节假日自动兜底——
 * 11/01 检查次年日历，缺失则置 tenant_param calendar.notice=pending（催管理员导入）；
 * 12/21 仍未导入 → 按"周末=假日"默认规则自动生成整年记录并置 notice=auto-applied。
 * 外部抓取无可靠公共 API，按"自动兜底规则+参数公告"实现——导入接口可重复执行且幂等。
 */
@Injectable()
export class HolidayEnsureCron {
  private readonly logger = new Logger(HolidayEnsureCron.name);
  constructor(private readonly prisma: TenantPrismaService) {}

  private tenantIds(): string[] {
    const env = (process.env.CRON_TENANT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return env;
  }

  private async ensureYear(tenantId: string, year: number): Promise<'ok' | 'applied'> {
    return this.prisma.runAsTenant(tenantId, async (tx) => {
      const existing = await tx.tenantCalendarDay.count({ where: { tenantId, day: { gte: new Date(`${year}-01-01`) } } });
      if (existing > 0) return 'ok';
      const rows: { tenantId: string; day: Date; kind: string; name: string }[] = [];
      for (let m = 0; m < 12; m++) {
        const dim = new Date(year, m + 1, 0).getDate();
        for (let d = 1; d <= dim; d++) {
          const dt = new Date(Date.UTC(year, m, d));
          const dow = dt.getUTCDay();
          rows.push({ tenantId, day: dt, kind: dow === 0 || dow === 6 ? 'HOLIDAY' : 'WORKDAY', name: 'auto-default' });
        }
      }
      await tx.tenantCalendarDay.createMany({ data: rows, skipDuplicates: true });
      await tx.tenantParam.upsert({
        where: { tenantId_key: { tenantId, key: 'calendar.notice' } },
        update: { value: `auto-applied-${year}` },
        create: { tenantId, key: 'calendar.notice', value: `auto-applied-${year}` },
      });
      return 'applied';
    });
  }

  /** 11/01 02:30：次年历缺失 → 置 pending 提醒标记。 */
  @Cron('0 30 2 1 11 *', { timeZone: 'Asia/Shanghai' })
  async remindImport(): Promise<void> {
    const year = new Date().getFullYear() + 1;
    for (const id of this.tenantIds()) {
      await this.prisma.runAsTenant(id, async (tx) => {
        const cnt = await tx.tenantCalendarDay.count({ where: { tenantId: id, day: { gte: new Date(`${year}-01-01`) } } });
        if (!cnt) {
          await tx.tenantParam.upsert({
            where: { tenantId_key: { tenantId: id, key: 'calendar.notice' } },
            update: { value: `pending-${year}` },
            create: { tenantId: id, key: 'calendar.notice', value: `pending-${year}` },
          });
        }
      });
    }
    this.logger.warn(`holiday-ensure remind done for ${this.tenantIds().length} tenants`);
  }

  /** 12/21 02:40：逾期 → 周末默认规则自动生成次年历。 */
  @Cron('0 40 2 21 12 *', { timeZone: 'Asia/Shanghai' })
  async autoApply(): Promise<void> {
    const year = new Date().getFullYear() + 1;
    for (const id of this.tenantIds()) {
      const r = await this.ensureYear(id, year);
      if (r === 'applied') this.logger.warn(`holiday-ensure auto-applied ${year} for ${id}`);
    }
  }
}
