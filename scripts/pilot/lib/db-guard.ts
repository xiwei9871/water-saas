/**
 * DB safety guard — P0. Pure string/URL checks; evaluated BEFORE any
 * connection or write. --yes can never bypass this.
 */

export interface PilotDb {
  /** Raw hostname as written in the DSN. */
  host: string;
  /** 'LOOPBACK' for localhost/127.0.0.1 — same target either way. */
  canonicalHost: 'LOOPBACK';
  port: number;
  name: string;
}

export class DbGuardError extends Error {}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);
const PG_DEFAULT_PORT = 5432;

const target = (d: PilotDb) => `${d.host}:${d.port}/${d.name}`;

/**
 * Throws DbGuardError unless host is loopback AND database name is
 * `watersaas_pilot` or ends with `_pilot`. Returns {host,port,name}
 * on pass — never echoes credentials.
 */
export function assertPilotDatabase(
  connectionString: string,
  label = 'DATABASE_URL',
): PilotDb {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new DbGuardError(`${label}: unparseable connection string`);
  }
  const host = url.hostname;
  const port = url.port ? parseInt(url.port, 10) : PG_DEFAULT_PORT;
  const name = url.pathname.replace(/^\//, '').split('/')[0];
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new DbGuardError(
      `${label}: host '${host}' is not loopback — refusing to run against a remote/tunneled database`,
    );
  }
  if (!(name === 'watersaas_pilot' || name.endsWith('_pilot'))) {
    throw new DbGuardError(
      `${label}: database '${name}' not in pilot allowlist (watersaas_pilot or *_pilot) — refusing`,
    );
  }
  return { host, canonicalHost: 'LOOPBACK', port, name };
}

/**
 * Both runtime and migration DSNs must independently pass the guard AND
 * point at the same database target — generation writes through the
 * runtime conn while reset reads through the migration conn; divergent
 * targets would let one side silently miss. Credentials may differ.
 * Error prints targets only, never passwords.
 */
export function assertPilotEnvironment(env: NodeJS.ProcessEnv): {
  runtime: PilotDb;
  migration: PilotDb;
} {
  const rt = env.DATABASE_URL;
  const mg = env.MIGRATION_DATABASE_URL ?? env.DATABASE_URL;
  if (!rt) throw new DbGuardError('DATABASE_URL is not set');
  if (!mg) throw new DbGuardError('MIGRATION_DATABASE_URL is not set');
  const runtime = assertPilotDatabase(rt, 'DATABASE_URL');
  const migration = assertPilotDatabase(mg, 'MIGRATION_DATABASE_URL');
  if (
    runtime.canonicalHost !== migration.canonicalHost ||
    runtime.port !== migration.port ||
    runtime.name !== migration.name
  ) {
    throw new DbGuardError(
      `runtime and migration DSNs point at different targets — ` +
        `DATABASE_URL=${target(runtime)} vs ` +
        `MIGRATION_DATABASE_URL=${target(migration)} — refusing`,
    );
  }
  return { runtime, migration };
}
