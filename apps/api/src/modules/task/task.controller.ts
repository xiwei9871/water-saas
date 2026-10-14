import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { assertUuid } from '../../common/uuid.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TASK_TYPE_CODES } from './task.types.js';
import { TaskService } from './task.service.js';

const BOXES = new Set(['todo', 'done', 'alert']);

/** /tasks — 待办中心：所有登录用户可看自己的待办/已办；领取与完成在服务端做候选人校验。 */
@Controller('tasks')
export class TaskController {
  constructor(private readonly svc: TaskService) {}

  private static perms(req: Request): string[] {
    return ((req as Request & { user?: { perms?: string[] } }).user?.perms ?? []) as string[];
  }

  /** GET /tasks?box=todo|done|alert&type=&take=&skip= */
  @Get()
  list(
    @Req() req: Request,
    @Query('box') box = 'todo',
    @Query('type') type?: string,
    @Query('take', new DefaultValuePipe(50), ParseIntPipe) take = 50,
    @Query('skip', new DefaultValuePipe(0), ParseIntPipe) skip = 0,
  ) {
    if (!BOXES.has(box)) {
      throw new BadRequestException({ code: 'INVALID_TASK_BOX', box });
    }
    if (type && !TASK_TYPE_CODES.includes(type)) {
      throw new BadRequestException({ code: 'INVALID_TASK_TYPE', type });
    }
    if (take < 1 || take > 200 || skip < 0) {
      throw new BadRequestException({ code: 'INVALID_PAGING' });
    }
    return this.svc.list(currentTenant(), TaskController.perms(req), {
      box: box as 'todo' | 'done' | 'alert',
      type,
      take,
      skip,
    });
  }

  /** GET /tasks/badge — 顶部角标：我的待办数 + 超期数 + 无候选告警数（iam:write）。 */
  @Get('badge')
  badge(@Req() req: Request) {
    return this.svc.badge(currentTenant(), TaskController.perms(req));
  }

  /** GET /tasks/:id — 详情 + 候选人 + canClaim。 */
  @Get(':id')
  detail(@Req() req: Request, @Param('id') id: string) {
    assertUuid(id, 'id');
    return this.svc.getById(currentTenant(), TaskController.perms(req), id);
  }

  /** POST /tasks/:id/claim — 领取式：先领先得。 */
  @Post(':id/claim')
  claim(@Req() req: Request, @Param('id') id: string) {
    assertUuid(id, 'id');
    return this.svc.claim(currentTenant(), TaskController.perms(req), id);
  }

  /** POST /tasks/:id/complete — {note?}：认领人完成 → 解锁后续流程。 */
  @Post(':id/complete')
  complete(@Param('id') id: string, @Body() body: { note?: string }) {
    assertUuid(id, 'id');
    const note = typeof body?.note === 'string' ? body.note.slice(0, 500) : undefined;
    return this.svc.complete(currentTenant(), id, note);
  }

  /** POST /tasks/:id/cancel — {reason}：取消任务（管理端 iam:write 守卫在路由层）。 */
  @Post(':id/cancel')
  cancel(@Param('id') id: string, @Body() body: { reason?: string }) {
    assertUuid(id, 'id');
    const reason = typeof body?.reason === 'string' ? body.reason.slice(0, 200) : undefined;
    return this.svc.cancel(currentTenant(), id, reason);
  }
}
