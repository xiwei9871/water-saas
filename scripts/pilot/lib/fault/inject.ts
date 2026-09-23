/**
 * G4 — fault injection. 13 primary anomaly types + 2 composites
 * (KEY_CONFLICT_RECURRENCE, CROSS_BRANCH_MULTI_BOOK). ALL injections
 * are DOMAIN_FLOW: real services, real state machines, no direct
 * mutation of bill/payment/ledger tables.
 *
 * Isolation: scenario accounts live in dedicated FAULT books so their
 * plans/readings/settlements never touch baseline members. Structural
 * scenarios (no-book / no-meter) simply get no membership.
 *
 * Scope: construction + Ground Truth only. No precision/recall, no
 * reconciler lifecycle, no operator evidence (that's G5).
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
  services,
  type GeneratedAccount,
  type GeneratedBook,
} from '../baseline/flow.ts';
import { periodDay, type AccountPlan } from '../baseline/allocate.ts';

const Pr = apiRequire('@prisma/client') as typeof import('@prisma/client');
const Dec = Pr.Prisma.Decimal;
const REQ = { user: { perms: ['*'] } };
type Svc = Record<string, (...a: unknown[]) => unknown>;

// anomaly-key helpers from the detector module — GT keys must match
// the detector's own encoding exactly.
const exc = apiImport<{
  A: Record<string, string>;
  waKey(id: string, type: string): string;
  billKey(id: string): string;
  readingKey(id: string, type: string): string;
  eventKey(id: string, type: string): string;
  eventIssueKey(id: string, occurrence: string): string;
}>('modules/exception/types');

// deterministic seq space per scenario tag — distinct from baseline
// (0..accounts) and fault books (900+)/devices (910+).
export const TAG_SEQ: Record<string, number> = {
  NBK: 100, NAM: 101, MAM: 102, MBK: 103, XBM: 104,
  QCR: 105, QCJ: 106, EST: 107, WPL: 108, FLD: 109,
  CFL: 110, KCF: 111, KCR: 112, OVD: 113,
};
export const SCENARIO_OF_TAG: Record<string, string> = {
  NBK: 'NO_BOOK',
  NAM: 'NO_ACTIVE_METER',
  MAM: 'MULTI_ACTIVE_METER',
  MBK: 'MULTI_BOOK',
  XBM: 'CROSS_BRANCH_MULTI_BOOK',
  QCR: 'READING_QC_REVIEW',
  QCJ: 'READING_QC_REJECTED',
  EST: 'ESTIMATE_STREAK',
  WPL: 'REMOTE_EVENT_WAITING_PLAN',
  FLD: 'REMOTE_EVENT_FAILED',
  CFL: 'REMOTE_EVENT_CONFLICT',
  KCF: 'REMOTE_EVENT_KEY_CONFLICT',
  KCR: 'KEY_CONFLICT_RECURRENCE',
  OVD: 'UNPAID_BILL_OVERDUE',
};

/** All 15 scenario keys — 13 primary + KEY_CONFLICT_RECURRENCE +
 * CROSS_BRANCH_MULTI_BOOK. UNBOUND has no tag (no account), so it is
 * appended here rather than keyed in SCENARIO_OF_TAG. */
export const SCENARIO_TYPES = [
  ...Object.values(SCENARIO_OF_TAG),
  'REMOTE_EVENT_UNBOUND',
] as const;

interface InjectCtx {
  h: Harness;
  ctx: TenantCtx;
  seed: number;
  books: { FA: GeneratedBook; FB: GeneratedBook; FC: GeneratedBook };
  accounts: Map<string, GeneratedAccount>;
  entries: GroundTruthEntry[];
  seqNoByBook: Map<string, number>;
}

interface InjectResult {
  groundTruth: GroundTruthEntry[];
  expectedKeys: Set<string>;
  stats: Record<string, number>;
}

export async function injectFaults(
  h: Harness,
  ctx: TenantCtx,
  seed: number,
  branchIds: string[],
  faultPeriod: string, // historical; due_date already past
  readPeriod: string,  // baseline period for reading scenarios
): Promise<InjectResult> {
  const t = await exc;
  const ic: InjectCtx = {
    h, ctx, seed,
    books: {} as InjectCtx['books'],
    accounts: new Map(),
    entries: [],
    seqNoByBook: new Map(),
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
  const onboard = async (tag: string, installedAt: Date) => {
    const seq = TAG_SEQ[tag];
    const plan: AccountPlan = {
      seq, tag: tag as AccountPlan['tag'], branchIdx: 0, bookIdx: 0,
      remote: false, payProfile: 'A', usage: [10, 13],
    };
    const [a] = await generateAccounts(h, ctx, seed, [plan], 1, installedAt);
    ic.accounts.set(tag, a);
    return a;
  };

  const member = async (book: GeneratedBook, a: GeneratedAccount) => {
    const seqNo = (ic.seqNoByBook.get(book.id) ?? 0) + 1;
    ic.seqNoByBook.set(book.id, seqNo);
    await withTenantTx(h, 'ReadingBookService.addMemberTx', ctx.tenantId, (tx) =>
      bookSvc.addMemberTx(tx, ctx, book.id, {
        waterAccountId: a.waterAccountId, seqNo,
      } as never),
    );
  };

  const genPlan = async (book: GeneratedBook, period: string) => {
    const r = (await withTenantTx(h, 'ReadingPlanService.generateTx', ctx.tenantId, (tx) =>
      planSvc.generateTx(tx, ctx, {
        bookId: book.id, period, planDate: periodDay(period, 5),
      } as never),
    )) as { items: { id: string; waterAccountId: string }[] };
    return new Map(r.items.map((i) => [i.waterAccountId, i.id]));
  };

  const submitReading = async (
    a: GeneratedAccount, items: Map<string, string>, period: string,
  ) => {
    const rows = (await withTenantTx(
      h, 'MeterReadingService.createBatchTx', ctx.tenantId,
      (tx) => readingSvc.createBatchTx(tx, ctx, [{
        planItemId: items.get(a.waterAccountId)!,
        resultType: 'ACTUAL',
        readingValue: new Dec(11),
        readDate: periodDay(period, 15),
        source: 'WEB',
      }] as never),
    )) as { id: string }[];
    return rows[0];
  };

  const qc = (id: string, action: 'pass' | 'review' | 'reject') =>
    withTenantTx(h, 'MeterReadingService.qcTx', ctx.tenantId, (tx) =>
      readingSvc.qcTx(tx, ctx, id, action, REQ));

  const settleFinal = async (a: GeneratedAccount, period: string, estimateReason?: string) =>
    withTenantTx(h, 'SettlementService.generateTx', ctx.tenantId, async (tx) => {
      const s = (await settleSvc.generateTx(tx, ctx, {
        waterAccountId: a.waterAccountId, period,
        ...(estimateReason ? { estimateReason } : {}),
      } as never)) as { id: string };
      await settleSvc.finalizeTx(tx, ctx, s.id, REQ);
    });

  const entry = (
    tag: string,
    a: GeneratedAccount | null,
    anomalies: { type: string; key: string; anchor: Anchor }[],
    orgOwnership: string[] = [],
    extraBiz: Record<string, string> = {},
    extraIds: Record<string, string> = {},
  ) => {
    ic.entries.push({
      scenarioKey: keys.scenarioKey(SCENARIO_OF_TAG[tag], 0),
      injectionMethod: 'DOMAIN_FLOW',
      reachableInNormalOperation: true,
      businessKeys: {
        ...(a
          ? {
              accountNo: a.accountNo,
              customerNo: keys.customerNo(seed, tag, TAG_SEQ[tag]),
              settleNo: keys.settleNo(seed, tag, TAG_SEQ[tag]),
              meterNo: keys.meterNo(seed, TAG_SEQ[tag]),
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
        anomalies: anomalies.map((x) => ({ ...x, lifecycle: ['active'] as const })),
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

  // ---- fault books: FA+FB (branch0), FC (branch1) ----
  const mkBook = async (seq: number, orgUnitId: string): Promise<GeneratedBook> => {
    const r = (await withTenantTx(h, 'ReadingBookService.createTx', ctx.tenantId, (tx) =>
      bookSvc.createTx(tx, ctx, {
        bookNo: keys.bookCode(seed, seq),
        name: keys.bookName(seed, seq),
        orgUnitId, cadence: 'MONTHLY', meterChannel: 'MECHANICAL',
      } as never),
    )) as { id: string };
    return { id: r.id, branchIdx: 0, seq, bookNo: keys.bookCode(seed, seq), orgUnitId };
  };
  ic.books = {
    FA: await mkBook(900, branchIds[0]),
    FB: await mkBook(901, branchIds[0]),
    FC: await mkBook(902, branchIds[1]),
  };

  const installedAt = periodDay(readPeriod, 1);
  // next calendar month — no plan is generated for it (WAITING_PLAN slot)
  const np = (() => {
    const y = +readPeriod.slice(0, 4), m = +readPeriod.slice(4);
    return m === 12 ? `${y + 1}01` : `${y}${String(m + 1).padStart(2, '0')}`;
  })();

  // ---- scenario accounts ----
  const installedOvd = periodDay(faultPeriod, 1);
  const A = {
    NBK: await onboard('NBK', installedAt),
    NAM: await onboard('NAM', installedAt),
    MAM: await onboard('MAM', installedAt),
    MBK: await onboard('MBK', installedAt),
    XBM: await onboard('XBM', installedAt),
    QCR: await onboard('QCR', installedAt),
    QCJ: await onboard('QCJ', installedAt),
    EST: await onboard('EST', installedAt),
    WPL: await onboard('WPL', installedAt),
    FLD: await onboard('FLD', installedAt),
    CFL: await onboard('CFL', installedAt),
    KCF: await onboard('KCF', installedAt),
    KCR: await onboard('KCR', installedAt),
    OVD: await onboard('OVD', installedOvd),
  };

  // memberships (NBK/NAM stay bookless)
  await member(ic.books.FA, A.MAM);
  await member(ic.books.FA, A.MBK); await member(ic.books.FB, A.MBK);
  await member(ic.books.FA, A.XBM); await member(ic.books.FC, A.XBM);
  for (const a of [A.QCR, A.QCJ, A.EST, A.WPL, A.FLD, A.CFL, A.KCF, A.KCR, A.OVD]) {
    await member(ic.books.FA, a);
  }
  await member(ic.books.FB, A.FLD); // 2nd book → ambiguous plan items

  // ---- structural anomalies ----
  await withTenantTx(h, 'MeterInstallationService.removeTx', ctx.tenantId, (tx) =>
    install.removeTx(tx, ctx, A.NAM.installationId, {
      finalReading: new Dec(0), removedAt: periodDay(readPeriod, 2),
    }, REQ),
  );
  entry('NAM', A.NAM, [
    { type: t.A.NO_ACTIVE_METER, key: t.waKey(A.NAM.waterAccountId, t.A.NO_ACTIVE_METER), anchor: 'ACCOUNT' },
    { type: t.A.NO_BOOK, key: t.waKey(A.NAM.waterAccountId, t.A.NO_BOOK), anchor: 'ACCOUNT' },
  ]);
  entry('NBK', A.NBK, [
    { type: t.A.NO_BOOK, key: t.waKey(A.NBK.waterAccountId, t.A.NO_BOOK), anchor: 'ACCOUNT' },
  ]);

  const m2 = (await withTenantTx(h, 'MeterService.createTx', ctx.tenantId, (tx) =>
    meter.createTx(tx, ctx, { meterNo: keys.meterNo(seed, 950), caliber: 'DN15' } as never),
  )) as { id: string };
  const inst2 = (await withTenantTx(h, 'MeterInstallationService.installTx', ctx.tenantId, (tx) =>
    install.installTx(tx, ctx, {
      waterAccountId: A.MAM.waterAccountId, meterId: m2.id,
      initialReading: new Dec(0), installedAt: periodDay(readPeriod, 2), reason: 'NEW',
    } as never),
  )) as { id: string };
  entry('MAM', A.MAM, [
    { type: t.A.MULTI_ACTIVE_METER, key: t.waKey(A.MAM.waterAccountId, t.A.MULTI_ACTIVE_METER), anchor: 'ACCOUNT' },
  ], [ic.books.FA.orgUnitId], {}, { extraInstallationId: inst2.id });

  entry('MBK', A.MBK, [
    { type: t.A.MULTI_BOOK, key: t.waKey(A.MBK.waterAccountId, t.A.MULTI_BOOK), anchor: 'ACCOUNT' },
  ], [ic.books.FA.orgUnitId]);
  entry('XBM', A.XBM, [
    { type: t.A.MULTI_BOOK, key: t.waKey(A.XBM.waterAccountId, t.A.MULTI_BOOK), anchor: 'ACCOUNT' },
  ], [ic.books.FA.orgUnitId, ic.books.FC.orgUnitId]);

  // ---- fault-book plans ----
  const itemsRP = await genPlan(ic.books.FA, readPeriod);
  await genPlan(ic.books.FB, readPeriod);
  const itemsFP = await genPlan(ic.books.FA, faultPeriod);

  // ---- QC anomalies ----
  const rQCR = await submitReading(A.QCR, itemsRP, readPeriod);
  await qc(rQCR.id, 'review');
  entry('QCR', A.QCR, [
    { type: t.A.READING_QC_REVIEW, key: t.readingKey(rQCR.id, t.A.READING_QC_REVIEW), anchor: 'ACCOUNT' },
  ], [ic.books.FA.orgUnitId], { period: readPeriod }, { readingId: rQCR.id });

  const rQCJ = await submitReading(A.QCJ, itemsRP, readPeriod);
  await qc(rQCJ.id, 'reject');
  entry('QCJ', A.QCJ, [
    { type: t.A.READING_QC_REJECTED, key: t.readingKey(rQCJ.id, t.A.READING_QC_REJECTED), anchor: 'ACCOUNT' },
  ], [ic.books.FA.orgUnitId], { period: readPeriod }, { readingId: rQCJ.id });

  // ---- ESTIMATE_STREAK: 2 consecutive estimated settlements ----
  // usageQty override → still isEstimated (MANUAL method); threshold=2
  // (no tenant param) so readPeriod+np suffice.
  for (const period of [readPeriod, np]) {
    await withTenantTx(h, 'SettlementService.generateTx', ctx.tenantId, async (tx) => {
      const s = (await settleSvc.generateTx(tx, ctx, {
        waterAccountId: A.EST.waterAccountId, period,
        usageQty: new Dec(10),
        estimateReason: 'PILOT: operator override — meter unread',
      } as never)) as { id: string };
      await settleSvc.finalizeTx(tx, ctx, s.id, REQ);
    });
  }
  entry('EST', A.EST, [
    { type: t.A.ESTIMATE_STREAK, key: t.waKey(A.EST.waterAccountId, t.A.ESTIMATE_STREAK), anchor: 'ACCOUNT' },
  ], [ic.books.FA.orgUnitId]);

  // ---- remote infra for bound scenarios ----
  const source = (await withTenantTx(h, 'RemoteSourceService.createTx', ctx.tenantId, (tx) =>
    srcSvc.createTx(tx, ctx, {
      code: `SRC-S${seed}-F`, name: 'Pilot 故障源', type: 'API_PULL',
      adapterKey: 'pilot-api', timezone: 'Asia/Shanghai', orgUnitId: null,
    } as never),
  )) as { id: string };

  let devSeq = 910;
  const bindDevice = async (a: GeneratedAccount) => {
    const vkey = keys.deviceNo(seed, devSeq++);
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

  // UNBOUND — unknown vendorDeviceKey (no account)
  const unbEv = mkEvent(keys.deviceNo(seed, 999), readPeriod, 990, 50);
  const unbOut = await ingest(source.id, [unbEv]);
  ic.entries.push({
    scenarioKey: keys.scenarioKey('REMOTE_EVENT_UNBOUND', 0),
    injectionMethod: 'DOMAIN_FLOW',
    reachableInNormalOperation: true,
    businessKeys: { externalEventKey: unbEv.externalEventKey, vendorDeviceKey: unbEv.vendorDeviceKey },
    entityIds: { eventId: unbOut[0].eventId!, remoteSourceId: source.id },
    expected: {
      anomalies: [{
        type: t.A.REMOTE_EVENT_UNBOUND,
        key: t.eventKey(unbOut[0].eventId!, t.A.REMOTE_EVENT_UNBOUND),
        anchor: 'REMOTE_SOURCE',
        lifecycle: ['active'],
      }],
      orgOwnership: [],
      financialEffect: null,
    },
  });

  // WAITING_PLAN — bound device, event period with no plan item
  const wplDev = await bindDevice(A.WPL);
  const wplEv = mkEvent(wplDev.vkey, np, 991, 66);
  const wplOut = await ingest(source.id, [wplEv]);
  entry('WPL', A.WPL, [
    { type: t.A.REMOTE_EVENT_WAITING_PLAN, key: t.eventKey(wplOut[0].eventId!, t.A.REMOTE_EVENT_WAITING_PLAN), anchor: 'ACCOUNT' },
  ], [ic.books.FA.orgUnitId], { externalEventKey: wplEv.externalEventKey }, { eventId: wplOut[0].eventId! });

  // FAILED — ambiguous plan items (FLD in FA+FB, both planned)
  const fldDev = await bindDevice(A.FLD);
  const fldEv = mkEvent(fldDev.vkey, readPeriod, 992, 44);
  const fldOut = await ingest(source.id, [fldEv]);
  entry('FLD', A.FLD, [
    { type: t.A.REMOTE_EVENT_FAILED, key: t.eventKey(fldOut[0].eventId!, t.A.REMOTE_EVENT_FAILED), anchor: 'ACCOUNT' },
    { type: t.A.MULTI_BOOK, key: t.waKey(A.FLD.waterAccountId, t.A.MULTI_BOOK), anchor: 'ACCOUNT' },
  ], [ic.books.FA.orgUnitId, ic.books.FB.orgUnitId], { externalEventKey: fldEv.externalEventKey }, { eventId: fldOut[0].eventId! });

  // CONFLICT — completed non-rejected reading + remote event same slot
  const rCFL = await submitReading(A.CFL, itemsRP, readPeriod);
  await qc(rCFL.id, 'pass');
  const cflDev = await bindDevice(A.CFL);
  const cflEv = mkEvent(cflDev.vkey, readPeriod, 993, 55);
  const cflOut = await ingest(source.id, [cflEv]);
  entry('CFL', A.CFL, [
    { type: t.A.REMOTE_EVENT_CONFLICT, key: t.eventKey(cflOut[0].eventId!, t.A.REMOTE_EVENT_CONFLICT), anchor: 'ACCOUNT' },
  ], [ic.books.FA.orgUnitId], { externalEventKey: cflEv.externalEventKey }, { eventId: cflOut[0].eventId! });

  // KEY_CONFLICT — first event converts; re-ingest same key, new payload
  const kcfDev = await bindDevice(A.KCF);
  const kcfEv1 = mkEvent(kcfDev.vkey, readPeriod, 994, 77);
  await ingest(source.id, [kcfEv1]);
  const kcfEv2 = mkEvent(kcfDev.vkey, readPeriod, 994, 88);
  const kcfOut2 = await ingest(source.id, [kcfEv2]);
  const kcfEventId = kcfOut2[0].eventId!; // issue lands on the ORIGINAL row
  entry('KCF', A.KCF, [
    { type: t.A.REMOTE_EVENT_KEY_CONFLICT, key: t.eventIssueKey(kcfEventId, '1'), anchor: 'REMOTE_SOURCE' },
  ], [ic.books.FA.orgUnitId], { externalEventKey: kcfEv1.externalEventKey }, { eventId: kcfEventId });

  // KEY_CONFLICT_RECURRENCE — same key conflicts 3× → occurrences=3
  const kcrDev = await bindDevice(A.KCR);
  const kcrEv1 = mkEvent(kcrDev.vkey, readPeriod, 995, 90);
  await ingest(source.id, [kcrEv1]);
  let kcrEventId = '';
  for (const v of [91, 92, 93]) {
    const o = await ingest(source.id, [mkEvent(kcrDev.vkey, readPeriod, 995, v)]);
    kcrEventId = o[0].eventId!;
  }
  entry('KCR', A.KCR, [
    { type: t.A.REMOTE_EVENT_KEY_CONFLICT, key: t.eventIssueKey(kcrEventId, '3'), anchor: 'REMOTE_SOURCE' },
  ], [ic.books.FA.orgUnitId], { externalEventKey: kcrEv1.externalEventKey }, { eventId: kcrEventId });

  // ---- UNPAID_BILL_OVERDUE: real bill in faultPeriod, unpaid ----
  const rOVD = await submitReading(A.OVD, itemsFP, faultPeriod);
  await qc(rOVD.id, 'pass');
  await settleFinal(A.OVD, faultPeriod);
  const runId = await createBillingRun(h, ctx, faultPeriod);
  const runStatus = await executeBillingRun(h, ctx, runId);
  if (runStatus !== 'POSTED') throw new Error(`fault billing ${runId} ended ${runStatus}`);
  const ovdBill = await h.tenantPrisma.runAsTenant(ctx.tenantId, async (tx) => {
    const t2 = tx as { $queryRaw<T>(q: unknown): Promise<T> };
    const rows = await t2.$queryRaw<{ id: string }[]>(
      Pr.Prisma.sql`SELECT id::text FROM bill WHERE tenant_id=${ctx.tenantId}::uuid
        AND water_account_id=${A.OVD.waterAccountId}::uuid AND period=${faultPeriod}
        AND status='POSTED' LIMIT 1`);
    return rows[0];
  });
  entry('OVD', A.OVD, [
    { type: t.A.UNPAID_BILL_OVERDUE, key: t.billKey(ovdBill.id), anchor: 'ACCOUNT' },
  ], [ic.books.FA.orgUnitId], { period: faultPeriod }, { billId: ovdBill.id });

  // ---- EST bills: post + pay cash so the tenant drawer stays clean ----
  for (const period of [readPeriod, np]) {
    const rid = await createBillingRun(h, ctx, period);
    const st = await executeBillingRun(h, ctx, rid);
    if (st !== 'POSTED') throw new Error(`est billing ${rid} ended ${st}`);
  }
  await applyPayments(h, ctx, [A.EST], 1);

  return {
    groundTruth: ic.entries,
    expectedKeys: new Set(
      ic.entries.flatMap((e) => e.expected.anomalies.map((a) => a.key)),
    ),
    stats: {
      scenarioAccounts: ic.accounts.size,
      faultBooks: 3,
      remoteEvents: events,
      convertedRemote,
      groundTruthEntries: ic.entries.length,
      expectedAnomalies: ic.entries.reduce((s, e) => s + e.expected.anomalies.length, 0),
    },
  };
}
