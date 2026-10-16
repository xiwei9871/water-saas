import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Put,
  Req,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';

/** 允许的偏好键白名单 —— 防止 staff_pref 变成任意写通道。 */
const PREF_KEYS = new Set(['dashboard.view', 'report.columns']);

/**
 * /iam/my-prefs/:key —— 员工自助个人偏好（H2 驾驶舱个人视图、报表列勾选）。
 * 无权限码门槛（登录即可读写自己的偏好），写入走审计拦截器。
 */
@Controller('iam/my-prefs')
export class MyPrefsController {
  constructor(private readonly prisma: TenantPrismaService) {}

  @Get(':key')
  async get(@Param('key') key: string) {
    if (!PREF_KEYS.has(key)) {
      throw new BadRequestException({ code: 'PREF_KEY_INVALID', key });
    }
    const ctx = currentTenant();
    const row = await this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.staffPref.findUnique({
        where: {
          tenantId_staffId_key: { tenantId: ctx.tenantId, staffId: ctx.staffId, key },
        },
      }),
    );
    return row?.value ?? null;
  }

  @Put(':key')
  async put(
    @Param('key') key: string,
    @Body() body: { value?: Prisma.InputJsonValue },
    @Req() req: Request,
  ) {
    if (!PREF_KEYS.has(key)) {
      throw new BadRequestException({ code: 'PREF_KEY_INVALID', key });
    }
    if (body === null || body === undefined || !('value' in body)) {
      throw new BadRequestException({ code: 'PARAM_VALUE_REQUIRED' });
    }
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      req.auditBefore = await tx.staffPref.findUnique({
        where: {
          tenantId_staffId_key: { tenantId: ctx.tenantId, staffId: ctx.staffId, key },
        },
      });
      return tx.staffPref.upsert({
        where: {
          tenantId_staffId_key: { tenantId: ctx.tenantId, staffId: ctx.staffId, key },
        },
        create: {
          tenantId: ctx.tenantId,
          staffId: ctx.staffId,
          key,
          value: body.value as Prisma.InputJsonValue,
          createdBy: ctx.staffId,
          updatedBy: ctx.staffId,
        },
        update: {
          value: body.value as Prisma.InputJsonValue,
          updatedBy: ctx.staffId,
        },
      });
    });
  }
}
