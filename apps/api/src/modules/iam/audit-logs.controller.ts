import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { Permissions } from '../../common/permissions.decorator.js';
import { currentTenant } from '../../common/tenant-context.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import { assertUuid } from '../../common/uuid.js';

const MAX_TAKE = 200;

const parsePage = (raw: string | undefined, name: string, fallback: number): number => {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new BadRequestException({ code: 'INVALID_PAGINATION', field: name });
  }
  return n;
};

/**
 * Read-only view over the append-only audit_log (written by
 * AuditInterceptor on every successful mutating request). Tenant-scoped,
 * newest first, with skip/take pagination and optional entity/action/staffId
 * filters.
 */
@Controller('iam/audit-logs')
export class AuditLogsController {
  constructor(private readonly prisma: TenantPrismaService) {}

  @Get()
  @Permissions('iam:read')
  list(
    @Query('take') take?: string,
    @Query('skip') skip?: string,
    @Query('entity') entity?: string,
    @Query('action') action?: string,
    @Query('staffId') staffId?: string,
  ) {
    const ctx = currentTenant();
    const takeN = Math.min(parsePage(take, 'take', 50), MAX_TAKE);
    const skipN = parsePage(skip, 'skip', 0);
    if (staffId !== undefined) assertUuid(staffId, 'staffId');
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.auditLog.findMany({
        where: {
          tenantId: ctx.tenantId,
          entity: entity || undefined,
          action: action ? { contains: action } : undefined,
          staffId: staffId ?? undefined,
        },
        orderBy: { createdAt: 'desc' },
        take: takeN,
        skip: skipN,
        select: {
          id: true,
          staffId: true,
          action: true,
          entity: true,
          entityId: true,
          ip: true,
          createdAt: true,
        },
      }),
    );
  }
}
