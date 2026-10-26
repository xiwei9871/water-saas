import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { IdempotencyService } from '../../common/idempotency.service.js';
import { withOptionalIdem } from '../../common/idempotent.js';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { assertUuid } from '../../common/uuid.js';
import { MeterStockService } from './meter-stock.service.js';

const pageArgs = (take?: string, skip?: string) => ({
  take: Math.min(Math.max(parseInt(take ?? '50', 10) || 50, 1), 200),
  skip: Math.max(parseInt(skip ?? '0', 10) || 0, 0),
});

/** 20261021 整改 任务D：水表库房 — 库房/货位/出入库流水（归属表务管理）。 */
@Controller()
export class MeterStockController {
  constructor(
    private readonly svc: MeterStockService,
    private readonly prisma: TenantPrismaService,
    private readonly idem: IdempotencyService,
  ) {}

  @Get('meter-warehouses')
  @Permissions('metering:service')
  warehouses() {
    return this.svc.listWarehouses(currentTenant());
  }

  @Post('meter-warehouses')
  @Permissions('metering:service')
  createWarehouse(@Body() body: Record<string, unknown>, @Req() req: Request) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.createWarehouseTx(tx, ctx, body, req),
    );
  }

  @Post('meter-warehouses/:id/locations')
  @Permissions('metering:service')
  createLocation(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.createLocationTx(tx, ctx, assertUuid(id, 'id'), body),
    );
  }

  /** X1-1 编辑库房（名称/所属单位/状态；code 不可改）。 */
  @Patch('meter-warehouses/:id')
  @Permissions('metering:service')
  updateWarehouse(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.updateWarehouseTx(tx, ctx, assertUuid(id, 'id'), body),
    );
  }

  /** X1-2/X1-3 删除库房（仅空库房；有货位/库存/流水 → 409）。 */
  @Delete('meter-warehouses/:id')
  @Permissions('metering:service')
  deleteWarehouse(@Param('id') id: string) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.deleteWarehouseTx(tx, ctx, assertUuid(id, 'id')),
    );
  }

  /** X1-1 编辑货位（名称/状态；code 不可改）。 */
  @Patch('meter-warehouses/:id/locations/:locId')
  @Permissions('metering:service')
  updateLocation(
    @Param('id') id: string,
    @Param('locId') locId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.updateLocationTx(
        tx,
        ctx,
        assertUuid(id, 'id'),
        assertUuid(locId, 'locId'),
        body,
      ),
    );
  }

  /** X1-2/X1-3 删除货位（有空货位才可删；有在库表/流水 → 409）。 */
  @Delete('meter-warehouses/:id/locations/:locId')
  @Permissions('metering:service')
  deleteLocation(@Param('id') id: string, @Param('locId') locId: string) {
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.deleteLocationTx(
        tx,
        ctx,
        assertUuid(id, 'id'),
        assertUuid(locId, 'locId'),
      ),
    );
  }

  /** 出入库流水列表（?meterId= / ?docNo= / ?warehouseId= 过滤 + 分页）。 */
  @Get('meter-stock/movements')
  @Permissions('metering:service')
  movements(
    @Query('meterId') meterId?: string,
    @Query('docNo') docNo?: string,
    @Query('warehouseId') warehouseId?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.svc.listMovements(currentTenant(), {
      meterId: meterId ? assertUuid(meterId, 'meterId') : undefined,
      docNo: docNo?.trim() || undefined,
      warehouseId: warehouseId ? assertUuid(warehouseId, 'warehouseId') : undefined,
      ...pageArgs(take, skip),
    });
  }

  /** GET /meter-stock/meters/:id/trail — 表号全生命周期（流水+装拆履历）。 */
  @Get('meter-stock/meters/:id/trail')
  @Permissions('metering:service')
  trail(@Param('id') id: string) {
    return this.svc.meterTrail(currentTenant(), assertUuid(id, 'id'));
  }

  /** 20261023 D1：GET /meter-stock/selectable?type=&kw= — 按流水类型的候选表。 */
  @Get('meter-stock/selectable')
  @Permissions('metering:service')
  selectable(@Query('type') type?: string, @Query('kw') kw?: string, @Query('take') take?: string) {
    return this.svc.selectable(
      currentTenant(),
      type ?? '',
      kw?.trim() || undefined,
      Math.min(Math.max(parseInt(take ?? '50', 10) || 50, 1), 200),
    );
  }

  /** GET /meter-stock — 在库表清单（?warehouseId=）。 */
  @Get('meter-stock')
  @Permissions('metering:service')
  stock(@Query('warehouseId') warehouseId?: string, @Query('take') take?: string, @Query('skip') skip?: string) {
    return this.svc.stock(currentTenant(), {
      warehouseId: warehouseId ? assertUuid(warehouseId, 'warehouseId') : undefined,
      ...pageArgs(take, skip),
    });
  }

  /** POST /meter-stock/movements — {type, meterIds[], warehouseId?, locationId?, docNo?, supplier?, batchNo?, remark?} */
  @Post('meter-stock/movements')
  @Permissions('metering:service')
  move(
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body, responseStatus: 201 },
      (tx) => this.svc.moveTx(tx, ctx, body, req),
    );
  }
}
