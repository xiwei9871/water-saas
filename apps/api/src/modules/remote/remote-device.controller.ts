import {
  Body,
  Controller,
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
import {
  RemoteDeviceService,
  type BindingBody,
  type BindingPatchBody,
  type RemoteDeviceBody,
  type RemoteDevicePatchBody,
} from './remote-device.service.js';

/** ?take default 50, hard-capped at 200; ?skip default 0. */
const pageArgs = (take?: string, skip?: string) => ({
  take: Math.min(Math.max(parseInt(take ?? '50', 10) || 50, 1), 200),
  skip: Math.max(parseInt(skip ?? '0', 10) || 0, 0),
});

/**
 * /remote-devices + /remote-device-bindings (E5 T3) — vendor device
 * identity and its effective-dated installation bindings. Reads need
 * metering:read; writes need metering:remote:manage + the source's org.
 */
@Controller()
export class RemoteDeviceController {
  constructor(
    private readonly svc: RemoteDeviceService,
    private readonly prisma: TenantPrismaService,
    private readonly idem: IdempotencyService,
  ) {}

  /** GET /remote-devices — ?remoteSourceId= / ?q= (deviceKey/meterNo/commId substring) / ?status= / paging. */
  @Get('remote-devices')
  @Permissions('metering:read')
  listDevices(
    @Query('remoteSourceId') remoteSourceId?: string,
    @Query('q') q?: string,
    @Query('status') status?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    if (remoteSourceId !== undefined) assertUuid(remoteSourceId, 'remoteSourceId');
    return this.svc.listDevices(currentTenant(), {
      ...pageArgs(take, skip),
      remoteSourceId,
      q,
      status,
    });
  }

  /** GET /remote-devices/:id — device + binding history (installations hydrated). */
  @Get('remote-devices/:id')
  @Permissions('metering:read')
  getDevice(@Param('id') id: string) {
    return this.svc.getDevice(currentTenant(), assertUuid(id, 'id'));
  }

  /** POST /remote-devices — remoteSourceId + vendorDeviceKey required. */
  @Post('remote-devices')
  @Permissions('metering:remote:manage')
  createDevice(
    @Body() body: RemoteDeviceBody,
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    const parsed: RemoteDeviceBody = {
      remoteSourceId:
        body?.remoteSourceId === undefined
          ? undefined
          : assertUuid(body.remoteSourceId, 'remoteSourceId'),
      vendorDeviceKey: body?.vendorDeviceKey,
      vendorMeterNo: body?.vendorMeterNo,
      communicationId: body?.communicationId,
      model: body?.model,
      metadata: body?.metadata,
    };
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body, responseStatus: 201 },
      (tx) => this.svc.createDeviceTx(tx, ctx, parsed),
    );
  }

  /** PATCH /remote-devices/:id — status/profile; vendorDeviceKey + source immutable. */
  @Patch('remote-devices/:id')
  @Permissions('metering:remote:manage')
  updateDevice(
    @Param('id') id: string,
    @Body() body: RemoteDevicePatchBody,
    @Req() req: Request,
  ) {
    assertUuid(id, 'id');
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.updateDeviceTx(tx, ctx, id, body, req),
    );
  }

  /** POST /remote-devices/:id/bindings — installationId + effectiveFrom (+ optional effectiveTo). */
  @Post('remote-devices/:id/bindings')
  @Permissions('metering:remote:manage')
  createBinding(
    @Param('id') id: string,
    @Body() body: BindingBody,
    @Req() req: Request,
    @Headers('idempotency-key') key?: string,
  ) {
    assertUuid(id, 'id');
    const parsed: BindingBody = {
      installationId:
        body?.installationId === undefined
          ? undefined
          : assertUuid(body.installationId, 'installationId'),
      effectiveFrom: body?.effectiveFrom,
      effectiveTo: body?.effectiveTo,
    };
    const ctx = currentTenant();
    return withOptionalIdem(
      this.prisma,
      this.idem,
      ctx,
      { key, method: 'POST', route: req.path, body, responseStatus: 201 },
      (tx) => this.svc.createBindingTx(tx, ctx, id, parsed),
    );
  }

  /** GET /remote-device-bindings — ?remoteDeviceId= / ?installationId= / paging. */
  @Get('remote-device-bindings')
  @Permissions('metering:read')
  listBindings(
    @Query('remoteDeviceId') remoteDeviceId?: string,
    @Query('installationId') installationId?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    if (remoteDeviceId !== undefined) assertUuid(remoteDeviceId, 'remoteDeviceId');
    if (installationId !== undefined) assertUuid(installationId, 'installationId');
    return this.svc.listBindings(currentTenant(), {
      ...pageArgs(take, skip),
      remoteDeviceId,
      installationId,
    });
  }

  /** PATCH /remote-device-bindings/:id — effectiveTo only (close/adjust end). */
  @Patch('remote-device-bindings/:id')
  @Permissions('metering:remote:manage')
  updateBinding(
    @Param('id') id: string,
    @Body() body: BindingPatchBody,
    @Req() req: Request,
  ) {
    assertUuid(id, 'id');
    const ctx = currentTenant();
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      this.svc.updateBindingTx(tx, ctx, id, body, req),
    );
  }
}
