import { Controller, Req, Sse } from '@nestjs/common';
import type { Request } from 'express';
import type { MessageEvent } from '@nestjs/common';
import { filter, map } from 'rxjs';
import { DomainEventsService } from './domain-events.service.js';

/**
 * GET /events/stream?access_token= — M8 全系统实时推送：
 * 本租户任何写操作成功后推送 {entity, ts}，前端按域刷新对应列表。
 * EventSource 无法带 Authorization 头，与 /tasks/events 同款 ?access_token=。
 */
@Controller('events')
export class EventsController {
  constructor(private readonly events: DomainEventsService) {}

  @Sse('stream')
  stream(@Req() req: Request) {
    const tenantId = (req as Request & { user?: { tenantId?: string } }).user?.tenantId;
    return this.events.events$.pipe(
      filter((e) => e.tenantId === tenantId),
      map((e) => ({ data: { entity: e.entity, ts: Date.now() } }) as MessageEvent),
    );
  }
}
