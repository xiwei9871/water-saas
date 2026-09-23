import { createRequire } from 'node:module';
import { resolve } from 'node:path';

/**
 * Read/write DB access for the system-flow suite — owner connection
 * (bypasses RLS) restricted to the dedicated database. FAIL CLOSED: any
 * other database name refuses before a single query runs.
 */
const req = createRequire(resolve('apps/api/package.json'));
const { PrismaClient } = req('@prisma/client');
export const bcrypt = req('bcrypt');

export const SF_DB = 'watersaas_system_flow';
const envDb = process.env.SF_DATABASE_NAME ?? SF_DB;
if (envDb !== SF_DB) {
  throw new Error(`Refusing non-system-flow database: ${envDb}`);
}
export const ownerUrl = `postgresql://postgres:postgres@localhost:5432/${SF_DB}`;

export async function db<T>(fn: (p: any) => Promise<T>): Promise<T> {
  const p = new PrismaClient({ datasourceUrl: ownerUrl });
  try {
    const [r] = await p.$queryRawUnsafe('SELECT current_database() AS name');
    if (r.name !== SF_DB) throw new Error(`Refusing non-system-flow database: ${r.name}`);
    return await fn(p);
  } finally {
    await p.$disconnect();
  }
}
