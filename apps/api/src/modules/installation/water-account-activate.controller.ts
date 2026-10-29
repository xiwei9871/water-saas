import {
  BadRequestException,
  Body,
  Controller,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { assertUuid } from '../../common/uuid.js';
import { AllocationService, type ActivateInput } from './allocation.service.js';

/**
 * 1028v2 放号-上号：用水户三态操作端点（与 customer 域
 * WaterAccountController 同路径、按方法级权限区分）——
 * 放号/上号链路属报装域延伸，集中在安装模块避免 customer↔install 环依赖。
 */
@Controller('water-accounts')
export class WaterAccountActivateController {
  constructor(private readonly alloc: AllocationService) {}

  private static perms(req: Request): string[] {
    return ((req as Request & { user?: { perms?: string[] } }).user?.perms ?? []) as string[];
  }

  /** B2 上号：抄表员现场复核四项一致 + 录表号 → 激活为已上号（待补全），
   *  并办结报装申请与「立户上号」任务。抄表员按文档授予 customer:read。 */
  @Post(':id/activate')
  @Permissions('customer:read')
  activate(
    @Param('id') id: string,
    @Body() body: ActivateInput,
    @Req() req: Request,
  ) {
    const ctx = currentTenant();
    if (!body?.meterNo?.trim()) {
      throw new BadRequestException({ code: 'METER_NO_REQUIRED' });
    }
    return this.alloc.activate(ctx, assertUuid(id, 'id'), body, WaterAccountActivateController.perms(req));
  }

  /** C1/B4 信息补录：已上号（待补全）户补齐客户/结算户/合同等 → 正常。 */
  @Post(':id/complete-info')
  @Permissions('customer:write')
  completeInfo(
    @Param('id') id: string,
    @Body()
    body: {
      customerId?: string;
      settleAccountId?: string;
      contractNo?: string;
      contractScan?: unknown;
      readingBookId?: string;
      householdSize?: number;
      addr?: string;
    },
  ) {
    const ctx = currentTenant();
    if (!body?.customerId || !body?.settleAccountId) {
      throw new BadRequestException({ code: 'PRINCIPAL_REQUIRED' });
    }
    return this.alloc.completeInfo(ctx, assertUuid(id, 'id'), {
      customerId: assertUuid(body.customerId, 'customerId'),
      settleAccountId: assertUuid(body.settleAccountId, 'settleAccountId'),
      contractNo: body.contractNo,
      contractScan: body.contractScan,
      readingBookId: body.readingBookId ? assertUuid(body.readingBookId, 'readingBookId') : undefined,
      householdSize: body.householdSize,
      addr: body.addr,
    });
  }
}
