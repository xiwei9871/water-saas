/**
 * G5-of-G2 — Nest application-context harness + D4 call helper.
 * Boots AppModule WITHOUT an HTTP listener; always closes (even on error).
 * services resolve lazily — domain flows are G3+, G2 only needs the
 * TenantPrisma handle to prove the ownership plumbing.
 */

import { apiImport } from './api-import.ts';
import { apiRequire } from './pg.ts';
import { assertCallerManaged } from './tx-registry.ts';

export interface TenantCtx {
  tenantId: string;
  staffId: string;
  scope: 'ALL' | 'ORG_SUBTREE' | 'SELF';
  orgScope: string[];
}

/** Generator ctx — equivalent to an ALL-scope admin. */
export const pilotCtx = (tenantId: string, staffId: string): TenantCtx => ({
  tenantId,
  staffId,
  scope: 'ALL',
  orgScope: [],
});

export interface Harness {
  app: { get(token: unknown, opts?: unknown): unknown };
  tenantPrisma: {
    runAsTenant<T>(
      tenantId: string,
      fn: (tx: unknown) => Promise<T>,
    ): Promise<T>;
  };
  get<T>(token: unknown): T;
  close(): Promise<void>;
}

export async function bootHarness(): Promise<Harness> {
  const { NestFactory } = apiRequire('@nestjs/core') as {
    NestFactory: {
      createApplicationContext(
        module: unknown,
        opts?: unknown,
      ): Promise<{
        get(t: unknown, o?: unknown): never;
        close(): Promise<void>;
      }>;
    };
  };
  const { AppModule } = await apiImport<{ AppModule: unknown }>(
    'app.module',
  );
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
    // default abortOnError silently process.exit(1)s on DI failure —
    // we want the thrown error instead.
    abortOnError: false,
  });
  const { TenantPrismaService } = await apiImport<{
    TenantPrismaService: unknown;
  }>('common/tenant-prisma');
  const tenantPrisma = app.get(TenantPrismaService, {
    strict: false,
  }) as Harness['tenantPrisma'];
  return {
    app,
    tenantPrisma,
    get: <T>(token: unknown) => app.get(token, { strict: false }) as T,
    close: () => app.close(),
  };
}

/**
 * The ONLY wrapper allowed around service calls. Refuses (throws) for
 * anything not registered TX_CALLER_MANAGED — so a TX_SELF_MANAGED
 * method can never be wrapped in a nested runAsTenant.
 */
export async function withTenantTx<T>(
  h: Harness,
  serviceMethod: string,
  tenantId: string,
  fn: (tx: unknown) => Promise<T>,
): Promise<T> {
  assertCallerManaged(serviceMethod);
  return h.tenantPrisma.runAsTenant(tenantId, fn);
}
