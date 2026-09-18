import { Global, Module } from '@nestjs/common';
import { IdempotencyService } from './idempotency.service.js';
import { TenantPrismaService } from './tenant-prisma.js';

/**
 * Shared infrastructure, provided exactly once for the whole app: a single
 * PrismaClient / connection pool plus the idempotency service that rides on
 * it. Global so feature modules never re-declare TenantPrismaService (two
 * providers = two pools = double the connections).
 */
@Global()
@Module({
  providers: [TenantPrismaService, IdempotencyService],
  exports: [TenantPrismaService, IdempotencyService],
})
export class CommonModule {}
