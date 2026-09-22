import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { assertUuid } from '../../common/uuid.js';
import { ExceptionService } from './exception.service.js';

const int = (v: string | undefined, def: number, max: number): number => {
  const n = parseInt(v ?? '', 10);
  if (Number.isNaN(n) || n < 1) return def;
  return Math.min(n, max);
};

/**
 * /exceptions — E9 operational work queue. Read endpoints are PURE reads
 * (detector + episode join; never write — D1). Episode writes re-evaluate
 * the underlying fact first (D3/D7). `POST /exceptions/refresh` is the
 * explicit reconcile trigger (exception:manage).
 */
@Controller('exceptions')
export class ExceptionController {
  constructor(private readonly svc: ExceptionService) {}

  @Get()
  @Permissions('exception:read')
  list(
    @Query('type') type?: string,
    @Query('severity') severity?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('take') take?: string,
  ) {
    return this.svc.list(currentTenant(), {
      type,
      severity,
      status,
      page: int(page, 1, 1000000),
      take: int(take, 50, 200),
    });
  }

  @Get('summary')
  @Permissions('exception:read')
  summary() {
    return this.svc.summary(currentTenant());
  }

  /** POST /exceptions/refresh — explicit reconcile trigger. Tenant-wide;
   *  the caller's orgScope does not narrow which facts reconcile. */
  @Post('refresh')
  @Permissions('exception:manage')
  refresh() {
    return this.svc.refresh(currentTenant());
  }

  @Get(':key')
  @Permissions('exception:read')
  detail(@Param('key') key: string) {
    return this.svc.detail(currentTenant(), decodeURIComponent(key));
  }

  @Post(':key/ack')
  @Permissions('exception:manage')
  ack(@Param('key') key: string) {
    return this.svc.ack(currentTenant(), decodeURIComponent(key));
  }

  @Post(':key/assign')
  @Permissions('exception:manage')
  assign(@Param('key') key: string, @Body() body: { assigneeId?: string }) {
    if (!body?.assigneeId) {
      throw new BadRequestException({ code: 'ASSIGNEE_REQUIRED', field: 'assigneeId' });
    }
    return this.svc.assign(currentTenant(), decodeURIComponent(key), assertUuid(body.assigneeId, 'assigneeId'));
  }

  @Post(':key/ignore')
  @Permissions('exception:manage')
  ignore(@Param('key') key: string, @Body() body: { note?: string }) {
    return this.svc.ignore(currentTenant(), decodeURIComponent(key), body?.note);
  }

  @Post(':key/unignore')
  @Permissions('exception:manage')
  unignore(@Param('key') key: string) {
    return this.svc.unignore(currentTenant(), decodeURIComponent(key));
  }

  @Post(':key/resolve')
  @Permissions('exception:manage')
  resolve(@Param('key') key: string, @Body() body?: { note?: string }) {
    return this.svc.resolve(currentTenant(), decodeURIComponent(key), body?.note);
  }
}
