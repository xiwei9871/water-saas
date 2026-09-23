/**
 * G2 skeleton unit tests — pure parts only (CLI, DB guard, key factory,
 * manifest writer, D4 registry + withTenantTx stub). DB/Nest integration
 * is exercised by the G2 smoke checklist, not here.
 */
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CliError, parseArgs } from '../../../scripts/pilot/lib/cli.js';
import {
  assertPilotDatabase,
  assertPilotEnvironment,
  DbGuardError,
} from '../../../scripts/pilot/lib/db-guard.js';
import { keys } from '../../../scripts/pilot/lib/keys.js';
import {
  assertCallerManaged,
  OwnershipError,
  TX_REGISTRY,
} from '../../../scripts/pilot/lib/tx-registry.js';
import { withTenantTx, type Harness } from '../../../scripts/pilot/lib/harness.js';
import {
  ManifestWriter,
  writeJsonAtomic,
} from '../../../scripts/pilot/lib/manifest.js';

const BASE = [
  '--tenant', '11111111-2222-3333-4444-555555555555',
  '--seed', '42',
  '--period-from', '202607',
];

describe('CLI parse', () => {
  it('valid args → defaults applied', () => {
    const a = parseArgs(BASE);
    expect(a.seed).toBe(42);
    expect(a.accounts).toBe(4000);
    expect(a.periodTo).toBe('202608');
    expect(a.concurrency).toBe(2);
    expect(a.profile).toBe('default');
    expect(a.reset).toBe(false);
  });

  it('--tenant xor --create-tenant; neither → error', () => {
    expect(() =>
      parseArgs(['--seed', '1', '--period-from', '202607']),
    ).toThrow(CliError);
    expect(() =>
      parseArgs([...BASE, '--create-tenant']),
    ).toThrow(CliError);
  });

  it('reject: bad uuid / bad period / concurrency >8 / bad as-of / unknown flag', () => {
    expect(() => parseArgs(['--tenant', 'abc', '--seed', '1', '--period-from', '202607'])).toThrow(CliError);
    expect(() => parseArgs([...BASE.slice(2), '--tenant', BASE[1], '--period-from', '202613'])).toThrow(CliError);
    expect(() => parseArgs([...BASE, '--concurrency', '9'])).toThrow(CliError);
    expect(() => parseArgs([...BASE, '--concurrency', '0'])).toThrow(CliError);
    expect(() => parseArgs([...BASE, '--as-of', '23-09-2026'])).toThrow(CliError);
    expect(() => parseArgs([...BASE, '--bogus'])).toThrow(CliError);
  });

  it('period rollover: 202612 → 202701', () => {
    const a = parseArgs([
      '--tenant', BASE[1], '--seed', '1', '--period-from', '202612',
    ]);
    expect(a.periodTo).toBe('202701');
  });
});

describe('DB guard (P0)', () => {
  it('pass: localhost + watersaas_pilot / *_pilot', () => {
    expect(
      assertPilotDatabase('postgresql://u:p@localhost:5432/watersaas_pilot'),
    ).toEqual({ host: 'localhost', name: 'watersaas_pilot' });
    expect(
      assertPilotDatabase('postgresql://u:p@127.0.0.1:5432/x_pilot'),
    ).toEqual({ host: '127.0.0.1', name: 'x_pilot' });
  });

  it('abort: remote host / tunnel alias / non-pilot db name', () => {
    for (const dsn of [
      'postgresql://u:p@db.internal:5432/watersaas_pilot',
      'postgresql://u:p@prod-tunnel:5432/x_pilot',
      'postgresql://u:p@localhost:5432/watersaas',
      'postgresql://u:p@localhost:5432/watersaas_test',
      'postgresql://u:p@localhost:5432/pilotx',
      'not a url',
    ]) {
      expect(() => assertPilotDatabase(dsn)).toThrow(DbGuardError);
    }
  });

  it('abort: both env DSNs must pass independently', () => {
    expect(() =>
      assertPilotEnvironment({
        DATABASE_URL: 'postgresql://u:p@localhost/x_pilot',
        MIGRATION_DATABASE_URL: 'postgresql://u:p@evil.example.com/x_pilot',
      } as NodeJS.ProcessEnv),
    ).toThrow(DbGuardError);
  });
});

describe('semantic keys (D3)', () => {
  it('deterministic: same input → same key', () => {
    expect(keys.accountNo(42, 'NBK', 7)).toBe(keys.accountNo(42, 'NBK', 7));
    expect(keys.tenantCode(42)).toBe('PILOT-0042');
    expect(keys.accountNo(42, 'NBK', 7)).toBe('P0042-NBK-000007');
    expect(keys.scenarioKey('NO_BOOK', 7)).toBe('NO_BOOK:000007');
  });

  it('distinct seq/scenario/seed → distinct keys', () => {
    const a = keys.accountNo(42, 'NBK', 7);
    expect(keys.accountNo(42, 'NBK', 8)).not.toBe(a);
    expect(keys.accountNo(42, 'MAB', 7)).not.toBe(a);
    expect(keys.accountNo(43, 'NBK', 7)).not.toBe(a);
    expect(keys.externalEventKey(42, 1)).toMatch(/^P0042-EV-000001$/);
  });
});

describe('D4 transaction ownership registry', () => {
  it('RemoteEventService.ingestBatch is SELF_MANAGED', () => {
    expect(TX_REGISTRY['RemoteEventService.ingestBatch']).toBe(
      'TX_SELF_MANAGED',
    );
  });

  it('assertCallerManaged: refuses SELF_MANAGED and unregistered', () => {
    expect(() =>
      assertCallerManaged('RemoteEventService.ingestBatch'),
    ).toThrow(OwnershipError);
    expect(() => assertCallerManaged('SomeService.unknownTx')).toThrow(
      OwnershipError,
    );
    expect(() =>
      assertCallerManaged('WaterAccountService.onboardTx'),
    ).not.toThrow();
  });

  it('withTenantTx: wraps CALLER_MANAGED, never wraps SELF_MANAGED', async () => {
    const runAsTenant = vi.fn((_t: string, fn: (tx: unknown) => unknown) =>
      fn('TX'),
    );
    const h = { tenantPrisma: { runAsTenant } } as unknown as Harness;
    await expect(
      withTenantTx(h, 'WaterAccountService.onboardTx', 'tid', async () => 'ok'),
    ).resolves.toBe('ok');
    expect(runAsTenant).toHaveBeenCalledTimes(1);
    await expect(
      withTenantTx(h, 'RemoteEventService.ingestBatch', 'tid', async () => 'x'),
    ).rejects.toThrow(OwnershipError);
    expect(runAsTenant).toHaveBeenCalledTimes(1); // never reached the wrapper
  });
});

describe('manifest writer', () => {
  it('atomic write: .tmp gone, valid JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pilot-mw-'));
    try {
      const p = join(dir, 'out.json');
      await writeJsonAtomic(p, { a: 1 });
      expect(existsSync(`${p}.tmp`)).toBe(false);
      expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ a: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ground-truth entry serializes the frozen shape', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pilot-gt-'));
    try {
      const w = new ManifestWriter(dir);
      await w.init();
      await w.writeGroundTruth({
        runId: 'run-s42-x',
        seed: 42,
        entries: [
          {
            scenarioKey: 'NO_BOOK:000001',
            injectionMethod: 'DOMAIN_FLOW',
            reachableInNormalOperation: true,
            businessKeys: { accountNo: 'P0042-NBK-000001' },
            entityIds: { waterAccountId: 'uuid-1' },
            expected: {
              anomalies: [
                {
                  type: 'NO_BOOK',
                  key: 'wa:uuid-1:NO_BOOK',
                  anchor: 'TENANT',
                  lifecycle: ['active'],
                },
              ],
              orgOwnership: [],
              financialEffect: null,
            },
          },
        ],
      });
      const gt = JSON.parse(
        readFileSync(join(dir, 'ground-truth.json'), 'utf8'),
      );
      expect(gt.entries[0].expected.anomalies).toHaveLength(1);
      expect(gt.entries[0].injectionMethod).toBe('DOMAIN_FLOW');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
