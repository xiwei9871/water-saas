/**
 * scripts/ is outside the pnpm workspace — bare package imports don't
 * resolve from here. Anchor a createRequire at apps/api/package.json so
 * runtime deps (pg, @nestjs/*) resolve through the api's node_modules.
 * Run via: `pnpm --filter api exec tsx ../../scripts/pilot/generate.ts`
 * (cwd=apps/api also picks up the api tsconfig so decorators transform).
 */

import { createRequire } from 'node:module';
import type { Client as PgClient, ClientConfig } from 'pg';

const apiRequire = createRequire(
  new URL('../../../apps/api/package.json', import.meta.url),
);

const pg = apiRequire('pg') as typeof import('pg');

export type Client = PgClient;

export const connect = async (config: ClientConfig): Promise<Client> => {
  const c = new pg.Client(config);
  await c.connect();
  return c;
};

export { apiRequire };
