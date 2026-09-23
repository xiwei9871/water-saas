/**
 * G5 episode-lifecycle evaluation — runs ONLY after the detector
 * snapshot is written. Mutates real facts through domain flows and
 * exercises the real ExceptionService (all SELF_MANAGED — never
 * wrapped in runAsTenant).
 */

import { apiImport } from '../api-import.ts';
import { apiRequire } from '../pg.ts';
import { keys } from '../keys.ts';
import { withTenantTx, type Harness, type TenantCtx } from '../harness.ts';
import { services } from '../baseline/flow.ts';
import type { GroundTruthEntry } from '../manifest.ts';

const Pr = apiRequire('@prisma/client') as typeof import('@prisma/client');
const Dec = Pr.Prisma.Decimal;
const REQ = { user: { perms: ['*'] } };
type Svc = Record<string, (...a: unknown[]) => unknown>;

type Tx = { $queryRaw<T>(q: unknown, ...a: unknown[]): Promise<T> };

interface EpisodeRow {
  id: string;
  anomaly_key: string;
  anomaly_type: string;
  status: string;
  resolution_source: string | null;
  acknowledged_at: string | null;
  resolved_at: string | null;
  cleared_at: string | null;
}

export interface ConcurrentCreateResult {
  oldEpisodeId: string;
  newEpisodeId: string;
  activeCount: number;
  rejectedCalls: number;
  pass: boolean;
}

/** Pure reducer for the concurrent-create race — exported so the
 *  assertion math is unit-testable without a DB. Pass requires: the
 *  fact was active going in, ZERO active episodes before the race,
 *  neither refresh rejected, and exactly ONE new active episode with
 *  an id distinct from the cleared old episode. */
export function concurrentCreateResult(opts: {
  oldEpisodeId: string;
  factActive: boolean;
  activeBefore: number;
  rejectedCalls: number;
  activeIds: string[];
}): ConcurrentCreateResult {
  const newId = opts.activeIds.find((id) => id !== opts.oldEpisodeId) ?? '';
  return {
    oldEpisodeId: opts.oldEpisodeId,
    newEpisodeId: newId,
    activeCount: opts.activeIds.length,
    rejectedCalls: opts.rejectedCalls,
    pass:
      opts.factActive &&
      opts.activeBefore === 0 &&
      opts.rejectedCalls === 0 &&
      opts.activeIds.length === 1 &&
      newId !== '' &&
      newId !== opts.oldEpisodeId,
  };
}

export interface EpisodeReport {
  initialOpen: number;
  idempotentRefresh: { created: number; resolved: number; cleared: number };
  concurrentRefresh: { duplicates: number };
  concurrentCreate: ConcurrentCreateResult;
  activeResolveRejected: boolean;
  manualResolve: {
    oldEpisodeId: string;
    resolutionSource: string;
    cleared: boolean;
    recurrenceEpisodeId: string;
  };
  ackAutoResolve: {
    oldEpisodeId: string;
    resolved: boolean;
    resolutionSource: string;
    recurrenceEpisodeId: string;
  };
  ignoredLifecycle: {
    ignoredEpisodeId: string;
    clearedStillIgnored: boolean;
    recurrenceEpisodeId: string;
  };
  duplicateActiveKeys: number;
  pass: boolean;
  notes: string[];
}

const fail = (notes: string[], msg: string) => notes.push(`FAIL: ${msg}`);

export async function evaluateEpisodes(
  h: Harness,
  ctx: TenantCtx,
  seed: number,
  entries: GroundTruthEntry[],
): Promise<EpisodeReport> {
  const notes: string[] = [];
  const excMod = await apiImport('modules/exception/exception.service');
  const excSvc = h.get((excMod as Record<string, unknown>).ExceptionService) as Svc;
  const bookSvc = await services.book(h);
  const installMod = await apiImport('modules/customer/meter-installation.service');
  const install = h.get((installMod as Record<string, unknown>).MeterInstallationService) as Svc;
  const meterMod = await apiImport('modules/customer/meter.service');
  const meter = h.get((meterMod as Record<string, unknown>).MeterService) as Svc;

  const q = <T>(sql: unknown, ...args: unknown[]): Promise<T> =>
    h.tenantPrisma.runAsTenant(ctx.tenantId, (tx) =>
      (tx as Tx).$queryRaw<T>(sql, ...args),
    );
  const episodes = (ks: string[]) =>
    q<EpisodeRow[]>(
      Pr.Prisma.sql`SELECT id::text, anomaly_key, anomaly_type, status,
        resolution_source::text, acknowledged_at::text, resolved_at::text, cleared_at::text
        FROM work_item WHERE tenant_id=${ctx.tenantId}::uuid
          AND anomaly_key = ANY(${ks}) ORDER BY created_at`,
    );

  const det = await apiImport<{
    detectAll(tx: Tx, tenantId: string): Promise<{ key: string }[]>;
  }>('modules/exception/detectors');

  const scenarioKey = (type: string) =>
    entries.find((e) => e.scenarioKey === `${type}:000000`);
  const anomalyKey = (type: string) => scenarioKey(type)?.expected.anomalies[0]?.key;
  const NAM = anomalyKey('NO_ACTIVE_METER')!;
  const NBK = anomalyKey('NO_BOOK')!;
  const MBK = anomalyKey('MULTI_BOOK')!;
  const XBM = anomalyKey('CROSS_BRANCH_MULTI_BOOK')!;
  const nbkWaId = scenarioKey('NO_BOOK')!.entityIds.waterAccountId;
  const mbkWaId = scenarioKey('MULTI_BOOK')!.entityIds.waterAccountId;
  const namWaId = scenarioKey('NO_ACTIVE_METER')!.entityIds.waterAccountId;
  const xbmWaId = scenarioKey('CROSS_BRANCH_MULTI_BOOK')!.entityIds.waterAccountId;

  // fault book ids by business key
  const books = await q<{ id: string; book_no: string }[]>(
    Pr.Prisma.sql`SELECT id::text, book_no FROM reading_book
      WHERE tenant_id=${ctx.tenantId}::uuid AND book_no IN (${keys.bookCode(seed, 900)}, ${keys.bookCode(seed, 901)}, ${keys.bookCode(seed, 902)})`,
  );
  const FA = books.find((b) => b.book_no === keys.bookCode(seed, 900))!.id;
  const FB = books.find((b) => b.book_no === keys.bookCode(seed, 901))!.id;
  const FC = books.find((b) => b.book_no === keys.bookCode(seed, 902))!.id;

  const refresh = () =>
    excSvc.refresh(ctx) as Promise<{
      detected: number; created: number; resolved: number; cleared: number;
    }>;

  // ---- 1. initial reconcile ----
  const r1 = await refresh();
  const after1 = await episodes(
    entries.flatMap((e) => e.expected.anomalies.map((a) => a.key)),
  );
  const openKeys = after1.filter((e) => e.cleared_at === null);
  const dupActive = new Map<string, number>();
  for (const e of openKeys) dupActive.set(e.anomaly_key, (dupActive.get(e.anomaly_key) ?? 0) + 1);
  const dupCount = [...dupActive.values()].filter((c) => c > 1).length;
  if (r1.created !== openKeys.length)
    fail(notes, `initial refresh created=${r1.created} but active=${openKeys.length}`);
  if (openKeys.some((e) => e.status !== 'OPEN'))
    fail(notes, 'initial episodes not all OPEN');
  if (dupCount) fail(notes, `duplicate active keys after initial refresh: ${dupCount}`);

  // ---- 2. idempotent refresh ----
  const r2 = await refresh();
  const after2 = await episodes(
    entries.flatMap((e) => e.expected.anomalies.map((a) => a.key)),
  );
  const ids1 = new Set(after1.map((e) => e.id));
  if (after2.some((e) => !ids1.has(e.id)))
    fail(notes, 'second refresh produced new episode rows');
  if (r2.created !== 0 || r2.resolved !== 0 || r2.cleared !== 0)
    fail(notes, `second refresh not idempotent: ${JSON.stringify(r2)}`);

  // ---- 3. concurrent refresh (no nested tx — two independent calls) ----
  const [c1, c2] = await Promise.allSettled([refresh(), refresh()]);
  if (c1.status === 'rejected' || c2.status === 'rejected')
    fail(notes, 'concurrent refresh rejected');
  const dupRows = await q<{ anomaly_key: string; c: bigint }[]>(
    Pr.Prisma.sql`SELECT anomaly_key, count(*) c FROM work_item
      WHERE tenant_id=${ctx.tenantId}::uuid AND cleared_at IS NULL
      GROUP BY anomaly_key HAVING count(*) > 1`,
  );
  if (dupRows.length) fail(notes, `concurrent duplicates: ${dupRows.length}`);

  // ---- 3b. concurrent CREATE race — XBM: clear the episode first,
  //      recur the fact WITHOUT refreshing, then two parallel refresh
  //      calls must create exactly ONE new active episode (partial
  //      unique + ON CONFLICT DO NOTHING under a real insert race). ----
  const xbmOld = (await episodes([XBM])).find((e) => e.cleared_at === null);
  await withTenantTx(h, 'ReadingBookService.removeMemberTx', ctx.tenantId, (tx) =>
    bookSvc.removeMemberTx(tx, ctx, FC, xbmWaId, REQ),
  );
  await refresh(); // fact gone → old XBM episode cleared (RESOLVED/AUTO)
  await withTenantTx(h, 'ReadingBookService.addMemberTx', ctx.tenantId, (tx) =>
    bookSvc.addMemberTx(tx, ctx, FC, { waterAccountId: xbmWaId, seqNo: 902 } as never),
  );
  const factActive = await h.tenantPrisma
    .runAsTenant(ctx.tenantId, (tx) => det.detectAll(tx as Tx, ctx.tenantId))
    .then((fs) => fs.some((f) => f.key === XBM));
  const activeBefore = (await episodes([XBM])).filter((e) => e.cleared_at === null).length;
  const race = await Promise.allSettled([refresh(), refresh()]);
  const rejectedCalls = race.filter((s) => s.status === 'rejected').length;
  const xbmActiveIds = (await episodes([XBM]))
    .filter((e) => e.cleared_at === null)
    .map((e) => e.id);
  const concurrentCreate = concurrentCreateResult({
    oldEpisodeId: xbmOld?.id ?? '',
    factActive,
    activeBefore,
    rejectedCalls,
    activeIds: xbmActiveIds,
  });
  if (!concurrentCreate.pass)
    fail(notes, `concurrent-create race failed: ${JSON.stringify(concurrentCreate)}`);

  // ---- 4. active manual-resolve guard ----
  let rejected = false;
  try {
    await excSvc.resolve(ctx, NAM);
  } catch (e) {
    const code =
      (e as { getResponse?: () => { code?: string } }).getResponse?.()?.code ??
      (e as Error).message;
    rejected = String(code).includes('ANOMALY_STILL_ACTIVE');
  }
  if (!rejected) fail(notes, 'resolve on active fact did not yield 409');

  // ---- 5. NBK manual resolve → recurrence ----
  await withTenantTx(h, 'ReadingBookService.addMemberTx', ctx.tenantId, (tx) =>
    bookSvc.addMemberTx(tx, ctx, FA, { waterAccountId: nbkWaId, seqNo: 900 } as never),
  );
  const nbkBefore = await episodes([NBK]);
  const nbkResolved = (await excSvc.resolve(ctx, NBK, 'pilot manual resolve')) as { id: string };
  const nbkAfterResolve = await episodes([NBK]);
  const nbkOld = nbkAfterResolve.find((e) => e.id === nbkBefore[0].id);
  if (!nbkOld || nbkOld.status !== 'RESOLVED' || nbkOld.resolution_source !== 'MANUAL' || !nbkOld.cleared_at)
    fail(notes, `manual resolve bad state: ${JSON.stringify(nbkOld)}`);
  await withTenantTx(h, 'ReadingBookService.removeMemberTx', ctx.tenantId, (tx) =>
    bookSvc.removeMemberTx(tx, ctx, FA, nbkWaId, REQ),
  );
  await refresh();
  const nbkRecur = (await episodes([NBK])).find((e) => e.cleared_at === null);
  if (!nbkRecur || nbkRecur.id === nbkResolved.id || nbkRecur.status !== 'OPEN')
    fail(notes, 'NBK recurrence did not open a NEW episode');

  // ---- 6. NAM ack → auto resolve → recurrence ----
  await excSvc.ack(ctx, NAM);
  const namAcked = (await episodes([NAM])).find((e) => e.cleared_at === null);
  if (!namAcked || namAcked.status !== 'ACK' || !namAcked.acknowledged_at)
    fail(notes, 'ack did not produce ACK + acknowledgedAt');

  const m = (await withTenantTx(h, 'MeterService.createTx', ctx.tenantId, (tx) =>
    meter.createTx(tx, ctx, { meterNo: keys.meterNo(seed, 6960), caliber: 'DN15' } as never),
  )) as { id: string };
  const newInst = (await withTenantTx(h, 'MeterInstallationService.installTx', ctx.tenantId, (tx) =>
    install.installTx(tx, ctx, {
      waterAccountId: namWaId, meterId: m.id,
      initialReading: new Dec(0), installedAt: new Date(), reason: 'NEW',
    } as never),
  )) as { id: string };
  await refresh();
  const namAuto = (await episodes([NAM])).find((e) => e.id === namAcked!.id);
  if (!namAuto || namAuto.status !== 'RESOLVED' || namAuto.resolution_source !== 'AUTO' || !namAuto.cleared_at)
    fail(notes, `ack→auto bad state: ${JSON.stringify(namAuto)}`);

  await withTenantTx(h, 'MeterInstallationService.removeTx', ctx.tenantId, (tx) =>
    install.removeTx(tx, ctx, newInst.id, {
      finalReading: new Dec(0), removedAt: new Date(),
    }, REQ),
  );
  await refresh();
  const namRecur = (await episodes([NAM])).find((e) => e.cleared_at === null);
  if (!namRecur || namRecur.id === namAcked!.id || namRecur.status !== 'OPEN')
    fail(notes, 'NAM recurrence did not open a NEW episode');

  // ---- 7. MBK ignored lifecycle ----
  const mbkBefore = (await episodes([MBK])).find((e) => e.cleared_at === null);
  await excSvc.ignore(ctx, MBK, 'Pilot lifecycle test');
  await withTenantTx(h, 'ReadingBookService.removeMemberTx', ctx.tenantId, (tx) =>
    bookSvc.removeMemberTx(tx, ctx, FB, mbkWaId, REQ),
  );
  await refresh();
  const mbkCleared = (await episodes([MBK])).find((e) => e.id === mbkBefore!.id);
  const clearedStillIgnored =
    !!mbkCleared && mbkCleared.status === 'IGNORED' && !!mbkCleared.cleared_at;
  if (!clearedStillIgnored)
    fail(notes, `ignored episode wrong terminal state: ${JSON.stringify(mbkCleared)}`);
  await withTenantTx(h, 'ReadingBookService.addMemberTx', ctx.tenantId, (tx) =>
    bookSvc.addMemberTx(tx, ctx, FB, { waterAccountId: mbkWaId, seqNo: 901 } as never),
  );
  await refresh();
  const mbkRecur = (await episodes([MBK])).find((e) => e.cleared_at === null);
  if (!mbkRecur || mbkRecur.id === mbkBefore!.id || mbkRecur.status !== 'OPEN')
    fail(notes, 'MBK recurrence did not open a NEW episode');

  // ---- final: duplicate active keys across the tenant ----
  const finalDup = await q<{ anomaly_key: string; c: bigint }[]>(
    Pr.Prisma.sql`SELECT anomaly_key, count(*) c FROM work_item
      WHERE tenant_id=${ctx.tenantId}::uuid AND cleared_at IS NULL
      GROUP BY anomaly_key HAVING count(*) > 1`,
  );

  return {
    initialOpen: r1.created,
    idempotentRefresh: { created: r2.created, resolved: r2.resolved, cleared: r2.cleared },
    concurrentRefresh: { duplicates: dupRows.length },
    concurrentCreate,
    activeResolveRejected: rejected,
    manualResolve: {
      oldEpisodeId: nbkBefore[0]?.id ?? '',
      resolutionSource: nbkOld?.resolution_source ?? '',
      cleared: !!nbkOld?.cleared_at,
      recurrenceEpisodeId: nbkRecur?.id ?? '',
    },
    ackAutoResolve: {
      oldEpisodeId: namAcked?.id ?? '',
      resolved: namAuto?.status === 'RESOLVED',
      resolutionSource: namAuto?.resolution_source ?? '',
      recurrenceEpisodeId: namRecur?.id ?? '',
    },
    ignoredLifecycle: {
      ignoredEpisodeId: mbkBefore?.id ?? '',
      clearedStillIgnored,
      recurrenceEpisodeId: mbkRecur?.id ?? '',
    },
    duplicateActiveKeys: finalDup.length,
    pass:
      notes.length === 0 &&
      r2.created === 0 && r2.resolved === 0 && r2.cleared === 0 &&
      dupRows.length === 0 && concurrentCreate.pass && rejected &&
      !!nbkRecur && !!namRecur && !!mbkRecur && finalDup.length === 0,
    notes,
  };
}
