/**
 * Resolve Nest/domain modules from the COMPILED api build.
 *
 * Why not src/? tsx/esbuild does not emit `design:paramtypes`
 * metadata — Nest instantiates every injected service with NO
 * dependencies. dist/ is built by tsc (emitDecoratorMetadata) so DI
 * works. The generator therefore requires `pnpm --filter api build`
 * before a live run.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // scripts/pilot/lib
export const API_DIST = join(HERE, '../../../apps/api/dist');

export const apiImport = <T = Record<string, unknown>>(
  rel: string,
): Promise<T> => {
  const p = join(API_DIST, `${rel}.js`);
  if (!existsSync(p)) {
    throw new Error(
      `api build missing (${rel}.js) — run 'pnpm --filter api build' first`,
    );
  }
  return import(pathToFileURL(p).href) as Promise<T>;
};
