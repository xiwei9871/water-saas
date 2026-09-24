/**
 * G4–G6 — fault injection. Plan-driven: lib/fault/plan.ts allocates
 * FaultScenarioPlan[] (deterministic namespaces, instance-scoped keys);
 * this module is CONSTRUCTION only — it consumes plans through real
 * domain flows (no direct mutation of bill/payment/ledger tables).
 *
 * Isolation: scenario accounts live in dedicated FAULT books (seq
 * 9000+) so their plans/readings/settlements never touch baseline
 * members. Structural scenarios (no-book) simply get no membership.
 *
 * Ground Truth keys come from the INDEPENDENT oracle (frozen product
 * contract literals) — never from production key helpers.
 */

import { apiImport } from '../api-import.ts';
import { apiRequire } from '../pg.ts';
import { keys } from '../keys.ts';
import { withTenantTx, type Harness, type TenantCtx } from '../harness.ts';
import type { GroundTruthEntry, Anchor } from '../manifest.ts';
import {
  applyPayments,
  createBillingRun,
  executeBillingRun,
  generateAccounts,
  mapLimit,
  services,
  type GeneratedAccount,
  type GeneratedBook,
} from '../baseline/flow.ts';
import { periodDay, shiftPeriod, type AccountPlan } from '../baseline/allocate.ts';
import { ANCHOR, oKey, T } from './oracle.ts';
import {
  allocateFaults,
  DEFAULT_FAULT_PROFILE,
  FAULT_KINDS,
  KIND_SCENARIO,
  NS,
  type FaultProfile,
  type FaultScenarioPlan,
} from './plan.ts';

const Pr = apiRequire('@prisma/client') as typeof import('@prisma/client');
const Dec = Pr.Prisma.Decimal;
const REQ = { user: { perms: ['*'] } };
type Svc = Record<string, (...a: unknown[]) => unknown>;

/** All scenario labels — 13 primary + 2 composites (order frozen). */
export const SCENARIO_TYPES = [
  ...FAULT_KINDS.map((k) => KIND_SCENARIO[k]),
] as const;

interface InjectCtx {
  h: Harness;
  ctx: TenantCtx;
  seed: number;
  books: GeneratedBook[]; // fault books, branch-major order
  accounts: Map<number, GeneratedAccount>; // accountSeq → account
  entries: GroundTruthEntry[];
  seqNoByBook: Map<string, number>;
  items: Map<string, Map<string, string>>; // `${bookId}:${period}` → waId→itemId
}

export interface ExpectedAnomaly {
  type: string;
  key: string;
  anchor: Anchor;
  orgOwnership: string[];
}

interface InjectResult {
  groundTruth: GroundTruthEntry[];
  expectedAnomalies: ExpectedAnomaly[];
  stats: Record<string, number>;
}

export async function injectFaults(
  h: Harness,
  ctx: TenantCtx,
  seed: number,
  branchIds: string[],
  faultPeriod: string, // historical; due_date already past
  readPeriod: string,  // baseline period for reading scenarios
  opts: { concurrency: number; profile?: FaultProfile },
): Promise<InjectResult> {
  const profile = opts.profile ?? DEFAULT_FAULT_PROFILE;
  const alloc = allocateFaults(profile, branchIds.length);
  const ic: InjectCtx = {
    h, ctx, seed,
    books: [],
    accounts: new Map(),
    entries: [],
    seqNoByBook: new Map(),
    items: new Map(),
  };
  let events = 0;

  const bookSvc = await services.book(h);
  const planSvc = await services.plan(h);
  const readingSvc = await services.reading(h);
  const settleSvc = await services.settlement(h);
  const srcSvc = await services.remoteSource(h);
  const deviceSvc = await services.remoteDevice(h);
  const evtSvc = await services.remoteEvent(h);
  const installMod = await apiImport('modules/customer/meter-installation.service');
  const install = h.get((installMod as Record<string, unknown>).MeterInstallationService) as Svc;
  const meterMod = await apiImport('modules/customer/meter.service');
  const meter = h.get((meterMod as Record<string, unknown>).MeterService) as Svc;
  const canonical = await apiImport<{
    buildCanonicalPayload(e: {
      vendorDeviceKey: string;
      businessPeriod: string;
      collectedAt: Date;
      readingValue: string;
      vendorQuality?: string | null;
    }): { canonicalPayload: Record<string, unknown>; payloadHash: string };
  }>('modules/remote/canonical');

  // ---- helpers ----
  const acct = (p: FaultScenarioPlan) => ic.accounts.get(p.accountSeq!)!;
  const book = (idx: number) => ic.books[idx];

  // RC1-2: addMemberTx rejects a second-book add unless the internal
  // allowMultiBook escape hatch is set — fault injection (MBK/XBM) opts in
  // explicitly; primary membership goes through the normal guarded path.
  const member = (b: GeneratedBook, a: GeneratedAccount, allowMultiBook = false) => {
    const seqNo = (ic.seqNoByBook.get(b.id) ?? 0) + 1;
    ic.seqNoByBook.set(b.id, seqNo);
    return withTenantTx(h, 'ReadingBookService.addMemberTx', ctx.tenantId, (tx) =>
      bookSvc.addMemberTx(tx, ctx, b.id, {
        waterAccountId: a.waterAccountId, seqNo, allowMultiBook,
      } as never),
    );
  };

  const genPlan = async (b: GeneratedBook, period: string) => {
    const r = (await withTenantTx(h, 'ReadingPlanService.generateTx', ctx.tenantId, (tx) =>
      planSvc.generateTx(tx, ctx, {
        bookId: b.id, period, planDate: periodDay(period, 5),
      } as never),
    )) as { items: { id: string; waterAccountId: string }[] };
    ic.items.set(
      `${b.id}:${period}`,
      new Map(r.items.map((i) => [i.waterAccountId, i.id])),
    );
  };

  const submitReading = (a: GeneratedAccount, b: GeneratedBook, period: string) =>
    withTenantTx(
      h, 'MeterReadingService.createBatchTx', ctx.tenantId,
      (tx) => readingSvc.createBatchTx(tx, ctx, [{
        planItemId: ic.items.get(`${b.id}:${period}`)!.get(a.waterAccountId)!,
        resultType: 'ACTUAL',
        readingValue: new Dec(11),
        readDate: periodDay(period, 15),
        source: 'WEB',
      }] as never),
    ).then((rows) => (rows as { id: string }[])[0]);

  const qc = (id: string, action: 'pass' | 'review' | 'reject') =>
    withTenantTx(h, 'MeterReadingService.qcTx', ctx.tenantId, (tx) =>
      readingSvc.qcTx(tx, ctx, id, action, REQ));

  const settleFinal = (a: GeneratedAccount, period: string, estimated = false) =>
    withTenantTx(h, 'SettlementService.generateTx', ctx.tenantId, async (tx) => {
      const s = (await settleSvc.generateTx(tx, ctx, {
        waterAccountId: a.waterAccountId, period,
        // EST path: operator override → isEstimated (MANUAL method);
        // OVD path: real PASSED reading → usageQty override would throw
        // OVERRIDE_TARGET_INVALID.
        ...(estimated
          ? {
              usageQty: new Dec(10),
              estimateReason: 'PILOT: operator override — meter unread',
            }
          : {}),
      } as never)) as { id: string };
      await settleSvc.finalizeTx(tx, ctx, s.id, REQ);
    });

  const entry = (
    p: FaultScenarioPlan,
    anomalies: { type: string; key: string }[],
    orgOwnership: string[] = [],
    extraBiz: Record<string, string> = {},
    extraIds: Record<string, string> = {},
  ) => {
    const a = p.accountSeq === null ? null : acct(p);
    ic.entries.push({
      scenarioKey: p.scenarioKey,
      injectionMethod: 'DOMAIN_FLOW',
      reachableInNormalOperation: true,
      businessKeys: {
        ...(a
          ? {
              accountNo: a.accountNo,
              customerNo: keys.customerNo(seed, p.kind, p.accountSeq!),
              settleNo: keys.settleNo(seed, p.kind, p.accountSeq!),
              meterNo: keys.meterNo(seed, p.accountSeq!),
            }
          : {}),
        ...extraBiz,
      },
      entityIds: {
        ...(a
          ? {
              customerId: a.customerId,
              settleAccountId: a.settleAccountId,
              waterAccountId: a.waterAccountId,
              meterId: a.meterId,
              installationId: a.installationId,
            }
          : {}),
        ...extraIds,
      },
      expected: {
        anomalies: anomalies.map((x) => ({
          type: x.type,
          key: x.key,
          anchor: ANCHOR[x.type] ?? 'ACCOUNT',
          lifecycle: ['active'] as const,
        })),
        orgOwnership,
        financialEffect: null,
      },
    });
  };

  const mkEvent = (vkey: string, period: string, seq: number, value: number) => {
    const collectedAt = new Date(
      Date.UTC(+period.slice(0, 4), +period.slice(4) - 1, 15, 1, 0, 0));
    const base = { vendorDeviceKey: vkey, businessPeriod: period, collectedAt, readingValue: value.toFixed(4) };
    const { canonicalPayload, payloadHash } = canonical.buildCanonicalPayload(base);
    return {
      externalEventKey: keys.externalEventKey(seed, seq),
      ...base,
      vendorQuality: null,
      rawPayload: { ...base, collectedAt: collectedAt.toISOString() },
      canonicalPayload,
      payloadHash,
    };
  };
  let convertedRemote = 0;
  const ingest = async (sourceId: string, evs: ReturnType<typeof mkEvent>[]) => {
    events += evs.length;
    const out = (await evtSvc.ingestBatch(ctx, sourceId, evs as never)) as {
      outcome: string; eventId?: string; readingId?: string;
    }[];
    convertedRemote += out.filter((o) => o.outcome === 'CONVERTED').length;
    return out;
  };

  // ---- fault books: per branch × faultBooksPerBranch, seq 9000+ ----
  const perBook = profile.faultBooksPerBranch;
  for (const seq of alloc.bookSeqs) {
    const b = Math.floor((seq - NS.BOOK_BASE) / perBook);
    const r = (await withTenantTx(h, 'ReadingBookService.createTx', ctx.tenantId, (tx) =>
      bookSvc.createTx(tx, ctx, {
        bookNo: keys.bookCode(seed, seq),
        name: keys.bookName(seed, seq),
        orgUnitId: branchIds[b], cadence: 'MONTHLY', meterChannel: 'MECHANICAL',
      } as never),
    )) as { id: string };
    ic.books.push({ id: r.id, branchIdx: b, seq, bookNo: keys.bookCode(seed, seq), orgUnitId: branchIds[b] });
  }

  const installedAt = periodDay(readPeriod, 1);
  const installedOvd = periodDay(faultPeriod, 1);
  const np = shiftPeriod(readPeriod, 1); // no plan is generated for it

  const byKind = (k: string) => alloc.plans.filter((p) => p.kind === k);

  // ---- scenario accounts (batched; OVD installs in faultPeriod) ----
  const planFor = (p: FaultScenarioPlan): AccountPlan => ({
    seq: p.accountSeq!, tag: p.kind, branchIdx: p.branchIdx, bookIdx: 0,
    remote: false, payProfile: 'A', usage: [10, 13],
  });
  const accountPlans = alloc.plans.filter((p) => p.accountSeq !== null);
  for (const [kinds, at] of [
    [accountPlans.filter((p) => p.kind !== 'OVD'), installedAt],
    [accountPlans.filter((p) => p.kind === 'OVD'), installedOvd],
  ] as const) {
    const gen = await generateAccounts(
      h, ctx, seed, kinds.map(planFor), opts.concurrency, at,
    );
    for (const a of gen) ic.accounts.set(a.plan.seq, a);
  }

  // ---- memberships (before plans so items exist) ----
  await mapLimit(accountPlans, opts.concurrency, async (p) => {
    if (p.primaryBookIdx !== null) await member(book(p.primaryBookIdx), acct(p));
    if (p.secondaryBookIdx !== null) await member(book(p.secondaryBookIdx), acct(p), true);
  });

  // ---- reading plans: every NON-EMPTY fault book × readPeriod;
  //      non-empty primary books × faultPeriod (OVD members live in
  //      primary books only). generateTx rejects EMPTY_BOOK. ----
  const nonEmpty = ic.books.filter((b) => (ic.seqNoByBook.get(b.id) ?? 0) > 0);
  for (const b of nonEmpty) await genPlan(b, readPeriod);
  for (let i = 0; i < ic.books.length; i += perBook)
    if ((ic.seqNoByBook.get(ic.books[i].id) ?? 0) > 0)
      await genPlan(ic.books[i], faultPeriod);

  // FLD: drop the secondary membership AFTER plans — current
  // BookMeter=1 but 2 historical plan items → PLAN_ITEM_AMBIGUOUS.
  await mapLimit(byKind('FLD'), opts.concurrency, (p) =>
    withTenantTx(h, 'ReadingBookService.removeMemberTx', ctx.tenantId, (tx) =>
      bookSvc.removeMemberTx(tx, ctx, book(p.secondaryBookIdx!).id, acct(p).waterAccountId, REQ),
    ),
  );

  // ---- structural anomalies ----
  // NAM: member of primary book + remove only ACTIVE installation →
  // isolated NO_ACTIVE_METER, anchor ACCOUNT.
  await mapLimit(byKind('NAM'), opts.concurrency, async (p) => {
    await withTenantTx(h, 'MeterInstallationService.removeTx', ctx.tenantId, (tx) =>
      install.removeTx(tx, ctx, acct(p).installationId, {
        finalReading: new Dec(0), removedAt: periodDay(readPeriod, 2),
      }, REQ),
    );
    entry(p, [
      { type: T.NO_ACTIVE_METER, key: oKey.wa(acct(p).waterAccountId, T.NO_ACTIVE_METER) },
    ], [book(p.primaryBookIdx!).orgUnitId]);
  });

  // NBK: bookless → NO_BOOK only, TENANT-anchored.
  for (const p of byKind('NBK')) {
    entry(p, [
      { type: T.NO_BOOK, key: oKey.wa(acct(p).waterAccountId, T.NO_BOOK) },
    ]);
  }

  // MAM: second meter + ACTIVE install.
  await mapLimit(byKind('MAM'), opts.concurrency, async (p) => {
    const m = (await withTenantTx(h, 'MeterService.createTx', ctx.tenantId, (tx) =>
      meter.createTx(tx, ctx, { meterNo: keys.meterNo(seed, p.extraMeterSeq!), caliber: 'DN15' } as never),
    )) as { id: string };
    const inst = (await withTenantTx(h, 'MeterInstallationService.installTx', ctx.tenantId, (tx) =>
      install.installTx(tx, ctx, {
        waterAccountId: acct(p).waterAccountId, meterId: m.id,
        initialReading: new Dec(0), installedAt: periodDay(readPeriod, 2), reason: 'NEW',
      } as never),
    )) as { id: string };
    entry(p, [
      { type: T.MULTI_ACTIVE_METER, key: oKey.wa(acct(p).waterAccountId, T.MULTI_ACTIVE_METER) },
    ], [book(p.primaryBookIdx!).orgUnitId], {}, { extraInstallationId: inst.id });
  });

  // MBK: two books same branch → coveringOrgs dedupes to one org.
  for (const p of byKind('MBK')) {
    entry(p, [
      { type: T.MULTI_BOOK, key: oKey.wa(acct(p).waterAccountId, T.MULTI_BOOK) },
    ], [book(p.primaryBookIdx!).orgUnitId]);
  }
  // XBM (composite): two books across branches → 2 covering orgs.
  for (const p of byKind('XBM')) {
    entry(p, [
      { type: T.MULTI_BOOK, key: oKey.wa(acct(p).waterAccountId, T.MULTI_BOOK) },
    ], [book(p.primaryBookIdx!).orgUnitId, book(p.secondaryBookIdx!).orgUnitId]);
  }

  // ---- QC anomalies ----
  await mapLimit(byKind('QCR'), opts.concurrency, async (p) => {
    const r = await submitReading(acct(p), book(p.primaryBookIdx!), readPeriod);
    await qc(r.id, 'review');
    entry(p, [
      { type: T.READING_QC_REVIEW, key: oKey.qcReview(r.id) },
    ], [book(p.primaryBookIdx!).orgUnitId], { period: readPeriod }, { readingId: r.id });
  });
  await mapLimit(byKind('QCJ'), opts.concurrency, async (p) => {
    const r = await submitReading(acct(p), book(p.primaryBookIdx!), readPeriod);
    await qc(r.id, 'reject');
    entry(p, [
      { type: T.READING_QC_REJECTED, key: oKey.qcRejected(r.id) },
    ], [book(p.primaryBookIdx!).orgUnitId], { period: readPeriod }, { readingId: r.id });
  });

  // ---- ESTIMATE_STREAK: 2 consecutive estimated settlements ----
  await mapLimit(byKind('EST'), opts.concurrency, async (p) => {
    await settleFinal(acct(p), readPeriod, true);
    await settleFinal(acct(p), np, true);
    entry(p, [
      { type: T.ESTIMATE_STREAK, key: oKey.wa(acct(p).waterAccountId, T.ESTIMATE_STREAK) },
    ], [book(p.primaryBookIdx!).orgUnitId]);
  });

  // ---- remote infra for bound scenarios ----
  const source = (await withTenantTx(h, 'RemoteSourceService.createTx', ctx.tenantId, (tx) =>
    srcSvc.createTx(tx, ctx, {
      code: `SRC-S${seed}-F`, name: 'Pilot 故障源', type: 'API_PULL',
      adapterKey: 'pilot-api', timezone: 'Asia/Shanghai', orgUnitId: null,
    } as never),
  )) as { id: string };

  const bindDevice = async (a: GeneratedAccount, deviceSeq: number) => {
    const vkey = keys.deviceNo(seed, deviceSeq);
    const d = (await withTenantTx(h, 'RemoteDeviceService.createDeviceTx', ctx.tenantId, (tx) =>
      deviceSvc.createDeviceTx(tx, ctx, {
        remoteSourceId: source.id, vendorDeviceKey: vkey,
      } as never),
    )) as { id: string };
    await withTenantTx(h, 'RemoteDeviceService.createBindingTx', ctx.tenantId, (tx) =>
      deviceSvc.createBindingTx(tx, ctx, d.id, {
        installationId: a.installationId,
        effectiveFrom: a.installedAt.toISOString(),
        effectiveTo: null,
      } as never),
    );
    return { deviceId: d.id, vkey };
  };
  // devices for all bound kinds (UNBOUND gets a vendor key, no device)
  const devBySeq = new Map<number, string>();
  await mapLimit(
    alloc.plans.filter((p) => p.deviceSeq !== null && p.kind !== 'UNBOUND'),
    opts.concurrency,
    async (p) => {
      const d = await bindDevice(acct(p), p.deviceSeq!);
      devBySeq.set(p.deviceSeq!, d.vkey);
    },
  );

  // UNBOUND — unknown vendorDeviceKey events (no account)
  {
    const ps = byKind('UNBOUND');
    const out = await ingest(source.id, ps.map((p, i) =>
      mkEvent(keys.deviceNo(seed, p.deviceSeq!), readPeriod, p.eventSeq!, 50 + i),
    ));
    ps.forEach((p, i) =>
      ic.entries.push({
        scenarioKey: p.scenarioKey,
        injectionMethod: 'DOMAIN_FLOW',
        reachableInNormalOperation: true,
        businessKeys: {
          externalEventKey: keys.externalEventKey(seed, p.eventSeq!),
          vendorDeviceKey: keys.deviceNo(seed, p.deviceSeq!),
        },
        entityIds: { eventId: out[i].eventId!, remoteSourceId: source.id },
        expected: {
          anomalies: [{
            type: T.REMOTE_EVENT_UNBOUND,
            key: oKey.eventUnbound(out[i].eventId!),
            anchor: ANCHOR[T.REMOTE_EVENT_UNBOUND],
            lifecycle: ['active'],
          }],
          orgOwnership: [],
          financialEffect: null,
        },
      }),
    );
  }

  // WAITING_PLAN — bound device, event period with no plan item
  {
    const ps = byKind('WPL');
    const out = await ingest(source.id, ps.map((p, i) =>
      mkEvent(devBySeq.get(p.deviceSeq!)!, np, p.eventSeq!, 66 + i),
    ));
    ps.forEach((p, i) =>
      entry(p, [
        { type: T.REMOTE_EVENT_WAITING_PLAN, key: oKey.eventWaitingPlan(out[i].eventId!) },
      ], [book(p.primaryBookIdx!).orgUnitId],
        { externalEventKey: keys.externalEventKey(seed, p.eventSeq!) },
        { eventId: out[i].eventId! }),
    );
  }

  // FAILED — ambiguous plan items (2 historical items, 1 current book)
  {
    const ps = byKind('FLD');
    const out = await ingest(source.id, ps.map((p, i) =>
      mkEvent(devBySeq.get(p.deviceSeq!)!, readPeriod, p.eventSeq!, 44 + i),
    ));
    ps.forEach((p, i) =>
      entry(p, [
        { type: T.REMOTE_EVENT_FAILED, key: oKey.eventFailed(out[i].eventId!) },
      ], [book(p.primaryBookIdx!).orgUnitId],
        { externalEventKey: keys.externalEventKey(seed, p.eventSeq!) },
        { eventId: out[i].eventId! }),
    );
  }

  // CONFLICT — passed manual reading + remote event same slot
  await mapLimit(byKind('CFL'), opts.concurrency, async (p) => {
    const r = await submitReading(acct(p), book(p.primaryBookIdx!), readPeriod);
    await qc(r.id, 'pass');
    const out = await ingest(source.id, [
      mkEvent(devBySeq.get(p.deviceSeq!)!, readPeriod, p.eventSeq!, 55),
    ]);
    entry(p, [
      { type: T.REMOTE_EVENT_CONFLICT, key: oKey.eventConflict(out[0].eventId!) },
    ], [book(p.primaryBookIdx!).orgUnitId],
      { externalEventKey: keys.externalEventKey(seed, p.eventSeq!), period: readPeriod },
      { eventId: out[0].eventId!, readingId: r.id });
  });

  // KEY_CONFLICT — ev1 converts; same externalEventKey, new payload →
  // occurrence N lands on the ORIGINAL event row.
  for (const [kind, occur] of [['KCF', 1], ['KCR', 3]] as const) {
    const ps = byKind(kind);
    if (!ps.length) continue;
    await ingest(source.id, ps.map((p, i) =>
      mkEvent(devBySeq.get(p.deviceSeq!)!, readPeriod, p.eventSeq!, 77 + i),
    ));
    let eventIds: string[] = [];
    for (let o = 0; o < occur; o++) {
      const out = await ingest(source.id, ps.map((p, i) =>
        mkEvent(devBySeq.get(p.deviceSeq!)!, readPeriod, p.eventSeq!, 100 + o * 10 + i),
      ));
      eventIds = out.map((x) => x.eventId!);
    }
    ps.forEach((p, i) =>
      entry(p, [
        { type: T.REMOTE_EVENT_KEY_CONFLICT, key: oKey.eventKeyConflict(eventIds[i], occur) },
      ], [book(p.primaryBookIdx!).orgUnitId],
        { externalEventKey: keys.externalEventKey(seed, p.eventSeq!) },
        { eventId: eventIds[i] }),
    );
  }

  // ---- UNPAID_BILL_OVERDUE: real bills in faultPeriod, unpaid ----
  const ovdPlans = byKind('OVD');
  await mapLimit(ovdPlans, opts.concurrency, async (p) => {
    const r = await submitReading(acct(p), book(p.primaryBookIdx!), faultPeriod);
    await qc(r.id, 'pass');
    await settleFinal(acct(p), faultPeriod);
  });
  if (ovdPlans.length) {
    const runId = await createBillingRun(h, ctx, faultPeriod);
    const st = await executeBillingRun(h, ctx, runId);
    if (st !== 'POSTED') throw new Error(`fault billing ${runId} ended ${st}`);
    const waIds = ovdPlans.map((p) => acct(p).waterAccountId);
    const bills = await h.tenantPrisma.runAsTenant(ctx.tenantId, (tx) =>
      (tx as { $queryRaw<T>(q: unknown): Promise<T> }).$queryRaw<{ id: string; water_account_id: string }[]>(
        Pr.Prisma.sql`SELECT id::text, water_account_id::text FROM bill
          WHERE tenant_id=${ctx.tenantId}::uuid AND period=${faultPeriod}
            AND water_account_id = ANY(${waIds}::uuid[]) AND status='POSTED'`),
    );
    const billByWa = new Map(bills.map((b) => [b.water_account_id, b.id]));
    for (const p of ovdPlans) {
      const billId = billByWa.get(acct(p).waterAccountId)!;
      entry(p, [
        { type: T.UNPAID_BILL_OVERDUE, key: oKey.bill(billId) },
      ], [book(p.primaryBookIdx!).orgUnitId], { period: faultPeriod }, { billId });
    }
  }

  // ---- EST bills: post + pay cash so the tenant drawer stays clean ----
  const estPlans = byKind('EST');
  if (estPlans.length) {
    for (const period of [readPeriod, np]) {
      const rid = await createBillingRun(h, ctx, period);
      const st = await executeBillingRun(h, ctx, rid);
      if (st !== 'POSTED') throw new Error(`est billing ${rid} ended ${st}`);
    }
    await applyPayments(h, ctx, estPlans.map(acct), opts.concurrency);
  }

  const expectedAnomalies: ExpectedAnomaly[] = ic.entries.flatMap((e) =>
    e.expected.anomalies.map((a) => ({
      type: a.type,
      key: a.key,
      anchor: a.anchor,
      orgOwnership: e.expected.orgOwnership,
    })),
  );
  return {
    groundTruth: ic.entries,
    expectedAnomalies,
    stats: {
      scenarioAccounts: ic.accounts.size,
      scenarios: alloc.plans.length,
      faultBooks: ic.books.length,
      remoteEvents: events,
      convertedRemote,
      groundTruthEntries: ic.entries.length,
      expectedAnomalies: ic.entries.reduce((s, e) => s + e.expected.anomalies.length, 0),
    },
  };
}
