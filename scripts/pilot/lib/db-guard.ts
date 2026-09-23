/**
 * DB safety guard — P0. Pure string/URL checks; evaluated BEFORE any
 * connection or write. --yes can never bypass this.
 */

export interface PilotDb {
  host: string;
  name: string;
}

export class DbGuardError extends Error {}

const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Throws DbGuardError unless host is localhost AND database name is
 * `watersaas_pilot` or ends with `_pilot`. Returns {host,name} on pass.
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
  const name = url.pathname.replace(/^\//, '').split('/')[0];
  if (!ALLOWED_HOSTS.has(host)) {
    throw new DbGuardError(
      `${label}: host '${host}' not in {localhost,127.0.0.1} — refusing to run against a remote/tunneled database`,
    );
  }
  if (!(name === 'watersaas_pilot' || name.endsWith('_pilot'))) {
    throw new DbGuardError(
      `${label}: database '${name}' not in pilot allowlist (watersaas_pilot or *_pilot) — refusing`,
    );
  }
  return { host, name };
}

/** Both runtime and migration DSNs must independently pass the guard. */
export function assertPilotEnvironment(env: NodeJS.ProcessEnv): {
  runtime: PilotDb;
  migration: PilotDb;
} {
  const rt = env.DATABASE_URL;
  const mg = env.MIGRATION_DATABASE_URL ?? env.DATABASE_URL;
  if (!rt) throw new DbGuardError('DATABASE_URL is not set');
  if (!mg) throw new DbGuardError('MIGRATION_DATABASE_URL is not set');
  return {
    runtime: assertPilotDatabase(rt, 'DATABASE_URL'),
    migration: assertPilotDatabase(mg, 'MIGRATION_DATABASE_URL'),
  };
}
