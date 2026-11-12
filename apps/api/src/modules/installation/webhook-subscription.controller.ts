import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { Permissions } from '../../common/permissions.decorator.js';
import { assertUuid } from '../../common/uuid.js';

/**
 * 1112v8-S3：出站推送订阅配置（本期预留——落配置，
 * 申请进入安装环节时产生 OUTBOUND_PENDING 待发记录，未配置不推）。
 */
@Controller('webhook-subscriptions')
export class WebhookSubscriptionController {
  constructor(private readonly prisma: TenantPrismaService) {}

  @Get()
  @Permissions('iam:read')
  list() {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.webhookSubscription.findMany({
        where: { tenantId: ctx.tenantId },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  @Post()
  @Permissions('iam:write')
  create(@Body() body: { url?: string; eventTypes?: string[]; secret?: string; enabled?: boolean }) {
    if (typeof body?.url !== 'string' || !/^https?:\/\//.test(body.url.trim())) {
      throw new BadRequestException({ code: 'WEBHOOK_URL_INVALID', message: '回调地址须为 http(s) URL' });
    }
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.webhookSubscription.create({
        data: {
          tenantId: ctx.tenantId,
          url: body.url!.trim().slice(0, 500),
          eventTypes: Array.isArray(body.eventTypes) && body.eventTypes.length ? body.eventTypes : ['install.status_changed'],
          secret: body.secret?.slice(0, 128) ?? null,
          enabled: body.enabled !== false,
          createdBy: ctx.staffId,
          updatedBy: ctx.staffId,
        },
      }),
    );
  }

  @Delete(':id')
  @Permissions('iam:write')
  async remove(@Param('id') id: string) {
    const ctx = currentTenant();
    const r = await this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.webhookSubscription.deleteMany({ where: { tenantId: ctx.tenantId, id: assertUuid(id, 'id') } }),
    );
    if (!r.count) throw new NotFoundException({ code: 'SUBSCRIPTION_NOT_FOUND' });
    return { ok: true };
  }
}
