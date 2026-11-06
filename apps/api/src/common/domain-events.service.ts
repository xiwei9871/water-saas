import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';

export interface DomainEvent {
  tenantId: string;
  /** 实体域：service-order / violation / prepayment / payment /
   *  install / meter-reading / reading-plan / water-account / day-close / task … */
  entity: string;
}

/**
 * M8 全系统实时置顶：写操作成功（2xx）后由 LiveEventInterceptor 统一广播；
 * 各域服务也可主动 emit。前端 /events/stream SSE 订阅后即时刷新列表。
 */
@Injectable()
export class DomainEventsService {
  private readonly bus = new Subject<DomainEvent>();
  readonly events$ = this.bus.asObservable();

  emit(tenantId: string, entity: string) {
    this.bus.next({ tenantId, entity });
    // 任务流同款：800ms 后再推一次，保证事务可见性。
    setTimeout(() => this.bus.next({ tenantId, entity }), 800);
  }
}
