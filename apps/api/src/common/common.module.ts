import { Global, Module } from '@nestjs/common';
import { IdempotencyService } from './idempotency.service.js';
import { SequenceService } from './sequence.service.js';
import { TenantPrismaService } from './tenant-prisma.js';

/**
 * Shared infrastructure, provided exactly once for the whole app: a single
 * PrismaClient / connection pool plus the idempotency service that rides on
 * it. Global so feature modules never re-declare TenantPrismaService (two
 * providers = two pools = double the connections). SequenceService is the
 * tenant document-numbering facility — stateless (the caller's tx carries
 * everything), so a single global provider serves every module.
 */
@Global()
@Module({
  providers: [TenantPrismaService, IdempotencyService, SequenceService],
  exports: [TenantPrismaService, IdempotencyService, SequenceService],
})
export class CommonModule {}
