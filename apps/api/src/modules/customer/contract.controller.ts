import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get,
  NotFoundException, Param, Patch, Post, Query,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { Permissions } from '../../common/permissions.decorator.js';
import { assertUuid } from '../../common/uuid.js';
import { conflictOnUnique } from '../../common/prisma-errors.js';

/**
 * P0-2（1111v6）合同管理：施工合同/供用水合同两类分区。
 * 挂载：applyNo（报装申请号）或 waterAccountId（户号）二选一必填；
 * 放号时 applyNo 名下合同自动转挂户号（见 allocation.service）。
 */
@Controller('contracts')
export class ContractController {
  constructor(private readonly prisma: TenantPrismaService) {}

  @Get()
  @Permissions('customer:read')
  list(
    @Query('waterAccountId') waId?: string,
    @Query('applyNo') applyNo?: string,
    @Query('contractType') contractType?: string,
    @Query('take') take?: string,
  ) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.contract.findMany({
        where: {
          tenantId: ctx.tenantId,
          ...(waId ? { waterAccountId: assertUuid(waId, 'waterAccountId') } : {}),
          ...(applyNo ? { applyNo } : {}),
          ...(contractType ? { contractType } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: Math.min(parseInt(take ?? '100', 10) || 100, 500),
      }),
    );
  }

  @Post()
  @Permissions('customer:write')
  create(@Body() body: Record<string, unknown>) {
    const applyNo = typeof body?.applyNo === 'string' && body.applyNo.trim() ? body.applyNo.trim() : null;
    const waId = typeof body?.waterAccountId === 'string' && body.waterAccountId.trim() ? body.waterAccountId.trim() : null;
    const contractType = String(body?.contractType ?? '');
    const contractNo = typeof body?.contractNo === 'string' && body.contractNo.trim() ? body.contractNo.trim().slice(0, 64) : null;
    if (!applyNo && !waId) {
      throw new BadRequestException({ code: 'CONTRACT_TARGET_REQUIRED', message: '户号与申请号须二选一' });
    }
    if (!['CONSTRUCTION', 'SUPPLY'].includes(contractType)) {
      throw new BadRequestException({ code: 'CONTRACT_TYPE_INVALID', message: '合同类别须为施工合同或供用水合同' });
    }
    if (!contractNo) throw new BadRequestException({ code: 'CONTRACT_NO_REQUIRED' });
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      if (waId) {
        const wa = await tx.waterAccount.findFirst({
          where: { tenantId: ctx.tenantId, id: assertUuid(waId, 'waterAccountId') },
          select: { id: true },
        });
        if (!wa) throw new NotFoundException({ code: 'WATER_ACCOUNT_NOT_FOUND' });
      }
      if (applyNo) {
        const app = await tx.installApplication.findFirst({
          where: { tenantId: ctx.tenantId, applyNo },
          select: { id: true },
        });
        if (!app) throw new NotFoundException({ code: 'APPLY_NOT_FOUND' });
      }
      return conflictOnUnique(
        tx.contract.create({
          data: {
            tenantId: ctx.tenantId,
            applyNo,
            waterAccountId: waId,
            contractType,
            contractNo,
            fileRefs: (body.fileRefs ?? null) as Prisma.InputJsonValue,
            signedAt: body.signedAt ? new Date(String(body.signedAt)) : null,
            remark: typeof body.remark === 'string' ? body.remark.slice(0, 500) : null,
            createdBy: ctx.staffId,
            updatedBy: ctx.staffId,
          },
        }),
      );
    });
  }

  @Patch(':id')
  @Permissions('customer:write')
  update(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const c = await tx.contract.findFirst({
        where: { tenantId: ctx.tenantId, id: assertUuid(id, 'id') },
      });
      if (!c) throw new NotFoundException({ code: 'CONTRACT_NOT_FOUND' });
      return tx.contract.update({
        where: { id: c.id },
        data: {
          ...(body.contractNo !== undefined ? { contractNo: String(body.contractNo).slice(0, 64) } : {}),
          ...(body.fileRefs !== undefined ? { fileRefs: body.fileRefs as Prisma.InputJsonValue } : {}),
          ...(body.signedAt !== undefined ? { signedAt: body.signedAt ? new Date(String(body.signedAt)) : null } : {}),
          ...(body.remark !== undefined ? { remark: body.remark === null ? null : String(body.remark).slice(0, 500) } : {}),
          updatedBy: ctx.staffId,
        },
      });
    });
  }

  @Delete(':id')
  @Permissions('customer:write')
  remove(@Param('id') id: string) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const r = await tx.contract.deleteMany({
        where: { tenantId: ctx.tenantId, id: assertUuid(id, 'id') },
      });
      if (!r.count) throw new NotFoundException({ code: 'CONTRACT_NOT_FOUND' });
      return { ok: true };
    });
  }
}
