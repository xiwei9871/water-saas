import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { AnyPermissions, Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import {
  monthEndReserveOf,
  segmentCalendar,
  calendarOverrides,
  PARAM_MONTH_END_RESERVE,
  parseBizDay,
  bizDayStr,
  daysInMonth,
} from '../../common/metering-model.js';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD_RE = /^\d{6}$/;

/**
 * R3 工作日/节假日日历（租户可维护）：默认周一~周五为工作日，
 * 例外日登记 HOLIDAY（节假日不抄）/ WORKDAY（调休上班日）。
 */
@Controller('metering/calendar')
export class TenantCalendarController {
  constructor(private readonly prisma: TenantPrismaService) {}

  /** GET /metering/calendar?period=YYYYMM — 当月工作日与抄表段表。 */
  @Get()
  @Permissions('metering:read')
  async show(@Query('period') period?: string) {
    const ctx = currentTenant();
    const p = period && PERIOD_RE.test(period)
      ? period
      : bizDayStr(new Date()).slice(0, 7).replace('-', '');
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const [overrides, reserve] = await Promise.all([
        calendarOverrides(
          tx,
          ctx.tenantId,
          parseBizDay(`${p.slice(0, 4)}-${p.slice(4)}-01`),
          parseBizDay(`${p.slice(0, 4)}-${p.slice(4)}-${String(daysInMonth(p)).padStart(2, '0')}`),
        ),
        monthEndReserveOf(tx, ctx.tenantId),
      ]);
      const days = [...overrides.entries()].map(([day, kind]) => ({ day, kind }));
      const segs = segmentCalendar(p, overrides, reserve).map((s) => ({
        segNo: s.segNo,
        date: s.date.toISOString().slice(0, 10),
      }));
      // R2 修订-1103：统一区段管理，不再返回归集模式。
      return {
        period: p,
        reserveDays: reserve,
        exceptions: days,
        segments: segs,
      };
    });
  }

  /**
   * PUT /metering/calendar/config {reserveDays?} — R3 月末预留工作日。
   * R2 修订-1103：归集模式开关已取消（统一区段管理），collectMode 入参
   * 忽略不再落库。
   */
  @Post('config')
  @AnyPermissions('iam:write', 'metering:write')
  putConfig(@Body() body: { reserveDays?: unknown }) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      if (body?.reserveDays !== undefined) {
        const n = Number(body.reserveDays);
        if (n !== 6 && n !== 7) {
          throw new BadRequestException({ code: 'RESERVE_DAYS_INVALID' });
        }
        await tx.tenantParam.upsert({
          where: { tenantId_key: { tenantId: ctx.tenantId, key: PARAM_MONTH_END_RESERVE } },
          create: {
            tenantId: ctx.tenantId,
            key: PARAM_MONTH_END_RESERVE,
            value: n,
            createdBy: ctx.staffId,
            updatedBy: ctx.staffId,
          },
          update: { value: n, updatedBy: ctx.staffId },
        });
      }
      return { ok: true };
    });
  }

  /** POST /metering/calendar {day, kind, name?} — 登记例外日（幂等覆盖）。 */
  @Post()
  @AnyPermissions('iam:write', 'metering:write')
  put(@Body() body: { day?: string; kind?: string; name?: string }) {
    if (!body?.day || !DAY_RE.test(body.day)) {
      throw new BadRequestException({ code: 'DAY_INVALID' });
    }
    if (body.kind !== 'HOLIDAY' && body.kind !== 'WORKDAY') {
      throw new BadRequestException({ code: 'DAY_KIND_INVALID' });
    }
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.tenantCalendarDay.upsert({
        where: {
          tenantId_day: { tenantId: ctx.tenantId, day: new Date(`${body.day}T00:00:00Z`) },
        },
        create: {
          tenantId: ctx.tenantId,
          day: new Date(`${body.day}T00:00:00Z`),
          kind: body.kind!,
          name: body.name?.trim() || null,
          createdBy: ctx.staffId,
          updatedBy: ctx.staffId,
        },
        update: { kind: body.kind!, name: body.name?.trim() || null, updatedBy: ctx.staffId },
      }),
    );
  }

  @Delete(':day')
  @AnyPermissions('iam:write', 'metering:write')
  remove(@Param('day') day: string, @Req() req: Request) {
    if (!DAY_RE.test(day)) throw new BadRequestException({ code: 'DAY_INVALID' });
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.tenantCalendarDay.findUnique({
        where: {
          tenantId_day: { tenantId: ctx.tenantId, day: new Date(`${day}T00:00:00Z`) },
        },
      });
      if (existing) {
        req.auditBefore = existing;
        await tx.tenantCalendarDay.delete({
          where: {
            tenantId_day: { tenantId: ctx.tenantId, day: new Date(`${day}T00:00:00Z`) },
          },
        });
      }
      return { day, deleted: !!existing };
    });
  }
}
