import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { currentTenant } from './tenant-context.js';
import { DomainEventsService } from './domain-events.service.js';

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** 路径首段 → 实体域映射（用于前端按域过滤刷新）。 */
const entityOf = (path: string): string => {
  const seg = path.replace(/^\/api\//, '').split('/')[0] ?? '';
  const map: Record<string, string> = {
    'service-orders': 'service-order',
    violations: 'violation',
    prepayments: 'prepayment',
    payments: 'payment',
    receipts: 'payment',
    'install-applications': 'install',
    install: 'install',
    'meter-readings': 'meter-reading',
    'reading-plans': 'reading-plan',
    'reading-books': 'reading-plan',
    'reading-zones': 'reading-plan',
    'water-accounts': 'water-account',
    'cashier-day-close': 'day-close',
    'billing-runs': 'billing',
    tasks: 'task',
    meters: 'meter',
    'meter-installations': 'meter',
    notices: 'notice',
    'bank-debit': 'bank-debit',
    writeoffs: 'writeoff',
    'settle-accounts': 'settle-account',
    customers: 'customer',
  };
  return map[seg] ?? seg;
};

/** M8：所有写操作 2xx 后广播实体变更事件 → SSE 推送 → 前端列表即时刷新置顶。 */
@Injectable()
export class LiveEventInterceptor implements NestInterceptor {
  constructor(private readonly events: DomainEventsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{
      method: string;
      path: string;
      statusCode?: number;
    }>();
    if (!WRITE_METHODS.has(req.method)) return next.handle();
    return next.handle().pipe(
      tap(() => {
        try {
          const tenantId = currentTenant()?.tenantId;
          if (tenantId) this.events.emit(tenantId, entityOf(req.path));
        } catch {
          /* 广播失败不阻断业务 */
        }
      }),
    );
  }
}
