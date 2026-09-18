import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * All tenant-scoped DB access goes through `runAsTenant`: it opens an
 * interactive transaction and sets `app.tenant_id` transaction-locally
 * (`set_config(..., true)`), so RLS policies apply inside fn() and no tenant
 * context survives the transaction when the pooled connection is reused.
 *
 * The underlying client connects via DATABASE_URL → ws_app (non-owner,
 * no BYPASSRLS). Owner credentials are never used at runtime.
 */
@Injectable()
export class TenantPrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly prisma = new PrismaClient();

  async onModuleInit() {
    await this.prisma.$connect();
  }

  async onModuleDestroy() {
    await this.prisma.$disconnect();
  }

  runAsTenant<T>(
    tenantId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    });
  }

  /** 仅 migration/seed/系统级 使用 — bypasses set_config; callers must scope
   *  tenant explicitly (and owner-level access never flows through here:
   *  this client is still ws_app, so RLS applies unless app.tenant_id is set). */
  get raw(): PrismaClient {
    return this.prisma;
  }
}
