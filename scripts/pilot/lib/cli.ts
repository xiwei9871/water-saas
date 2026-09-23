/**
 * G2 CLI — parse + validate. Pure: no I/O, no imports beyond types.
 * Fail-fast on any invalid combination — never silently pick a tenant.
 */

export interface GenerateArgs {
  tenantId?: string;
  createTenant: boolean;
  seed: number;
  accounts: number;
  periodFrom: string;
  periodTo: string;
  profile: string;
  asOf?: string;
  concurrency: number;
  reset: boolean;
  yes: boolean;
  /** G4 fault injection on top of the clean baseline. */
  faults: boolean;
  outputDir: string;
  help: boolean;
}

export const CONCURRENCY_DEFAULT = 2;
export const CONCURRENCY_MAX = 8;
export const ACCOUNTS_DEFAULT = 4000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIOD_RE = /^\d{6}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class CliError extends Error {}

const takeValue = (argv: string[], i: number, flag: string): string => {
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) {
    throw new CliError(`${flag} requires a value`);
  }
  return v;
};

const validPeriod = (p: string) => {
  if (!PERIOD_RE.test(p)) return false;
  const m = parseInt(p.slice(4), 10);
  return m >= 1 && m <= 12;
};

/** Real calendar validation — rejects 2026-02-30, accepts 2028-02-29. */
const validDate = (s: string): boolean => {
  if (!DATE_RE.test(s)) return false;
  const y = parseInt(s.slice(0, 4), 10);
  const m = parseInt(s.slice(5, 7), 10);
  const d = parseInt(s.slice(8, 10), 10);
  if (m < 1 || m > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= dim[m - 1];
};

const nextPeriod = (p: string): string => {
  const y = parseInt(p.slice(0, 4), 10);
  const m = parseInt(p.slice(4), 10);
  return m === 12 ? `${y + 1}01` : `${y}${String(m + 1).padStart(2, '0')}`;
};

export function parseArgs(argv: string[]): GenerateArgs {
  const a: Partial<GenerateArgs> & { help: boolean } = {
    createTenant: false,
    reset: false,
    yes: false,
    faults: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    switch (f) {
      case '--tenant':
        a.tenantId = takeValue(argv, i++, f);
        break;
      case '--create-tenant':
        a.createTenant = true;
        break;
      case '--seed':
        a.seed = parseInt(takeValue(argv, i++, f), 10);
        break;
      case '--accounts':
        a.accounts = parseInt(takeValue(argv, i++, f), 10);
        break;
      case '--period-from':
        a.periodFrom = takeValue(argv, i++, f);
        break;
      case '--period-to':
        a.periodTo = takeValue(argv, i++, f);
        break;
      case '--profile':
        a.profile = takeValue(argv, i++, f);
        break;
      case '--as-of':
        a.asOf = takeValue(argv, i++, f);
        break;
      case '--concurrency':
        a.concurrency = parseInt(takeValue(argv, i++, f), 10);
        break;
      case '--reset':
        a.reset = true;
        break;
      case '--yes':
        a.yes = true;
        break;
      case '--faults':
        a.faults = true;
        break;
      case '--output':
        a.outputDir = takeValue(argv, i++, f);
        break;
      case '--help':
      case '-h':
        a.help = true;
        break;
      default:
        throw new CliError(`unknown flag: ${f}`);
    }
  }

  if (a.help) return a as GenerateArgs;

  // tenant selection: exactly one mode, never ambiguous
  if (a.tenantId && a.createTenant) {
    throw new CliError('--tenant and --create-tenant are mutually exclusive');
  }
  if (!a.tenantId && !a.createTenant) {
    throw new CliError('one of --tenant <uuid> or --create-tenant is required');
  }
  if (a.tenantId && !UUID_RE.test(a.tenantId)) {
    throw new CliError(`--tenant must be a uuid, got: ${a.tenantId}`);
  }

  if (a.seed === undefined || !Number.isInteger(a.seed) || a.seed < 0) {
    throw new CliError('--seed <non-negative int> is required');
  }
  a.accounts ??= ACCOUNTS_DEFAULT;
  // Frozen cap: smoke=small, G5=200, full profile=3,000–5,000.
  if (!Number.isInteger(a.accounts) || a.accounts < 1 || a.accounts > 5000) {
    throw new CliError(`--accounts must be 1..5000, got: ${a.accounts}`);
  }
  if (!a.periodFrom || !validPeriod(a.periodFrom)) {
    throw new CliError('--period-from YYYYMM (valid month) is required');
  }
  a.periodTo ??= nextPeriod(a.periodFrom);
  if (!validPeriod(a.periodTo) || a.periodTo < a.periodFrom) {
    throw new CliError(`--period-to must be a valid period >= period-from`);
  }
  a.profile ??= 'default';
  if (a.asOf !== undefined && !validDate(a.asOf)) {
    throw new CliError(`--as-of must be a real YYYY-MM-DD date, got: ${a.asOf}`);
  }
  a.concurrency ??= CONCURRENCY_DEFAULT;
  if (
    !Number.isInteger(a.concurrency) ||
    a.concurrency < 1 ||
    a.concurrency > CONCURRENCY_MAX
  ) {
    throw new CliError(
      `--concurrency must be 1..${CONCURRENCY_MAX}, got: ${a.concurrency}`,
    );
  }
  a.outputDir ??= 'artifacts/pilot';
  return a as GenerateArgs;
}

/**
 * P1-2: `--reset` without `--yes` is a plan-only early exit — nothing
 * after it may run (no harness, no generation, no manifests).
 */
export const isResetDryRun = (
  a: Pick<GenerateArgs, 'reset' | 'yes'>,
): boolean => a.reset && !a.yes;

export const USAGE = `generate.ts — Pilot Cycle 1A synthetic generator (G2 skeleton)

  --tenant <uuid>        existing Pilot-marked tenant   ┐ exactly one
  --create-tenant        create PILOT-<seed> tenant     ┘ required
  --seed <int>           deterministic seed (required)
  --accounts <int>       default ${ACCOUNTS_DEFAULT}
  --period-from YYYYMM   required
  --period-to YYYYMM     default = period-from + 1
  --profile <name>       default 'default'
  --as-of YYYY-MM-DD     default = database CURRENT_DATE
  --concurrency <1..8>   default ${CONCURRENCY_DEFAULT}, hard cap ${CONCURRENCY_MAX}
  --reset                delete tenant-scoped rows (needs --yes to execute)
  --yes                  confirm destructive ops
  --faults               G4: inject the 15-scenario anomaly matrix on top
                         of the clean baseline (construction + GT only)
  --output <dir>         default artifacts/pilot
`;
