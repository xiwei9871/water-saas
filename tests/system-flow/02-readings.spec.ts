import { test, expect, evidence } from './helpers/test';
import { load, save } from './helpers/state';
import { db } from './helpers/db';
import { login } from './helpers/ui';
import { createBook, addBookMembers, generatePlan, openPlanDetail, startPlan, batchEnter, qcReading, type EntrySpec } from './helpers/reading';
import { button, response } from './helpers/ui';

/**
 * J2 — 抄表册 → 册成员 → 计划生成 → 录入 → QC，全部真实 UI。
 * Period 202607 only (period 2 rides along inside J3 for the second run).
 * Deterministic usage: ACTUAL reading = installation initial + usage.
 */
const P1 = '202607';

/** deterministic usage per account for period 1 */
export const usage1 = (key: string) => {
  const n = Number(key.slice(-3));
  return 10 + (n % 7);
};

test.describe.configure({ mode: 'serial' });

test('J2 books + members + plan + entry + QC (period 202607)', async ({ page }, info) => {
  const s = load();
  const people = s.people;
  const byPrefix = (prefix: string) => people.filter((p) => p.key.startsWith(prefix));
  const bookA = byPrefix('SF-A-');                    // 8
  const bookB = byPrefix('SF-B-');                    // 4
  const bookC = [...byPrefix('SF-C-'), ...byPrefix('SF-S-'), ...byPrefix('SF-N-')]; // 7

  // ---- books (admin) ----
  await login(page);
  const bookDefs = [
    { key: 'A', bookNo: 'SF-BOOK-A', name: '城东一册', org: s.branches[0], reader: s.roles['sf-reader'], members: bookA },
    { key: 'B', bookNo: 'SF-BOOK-B', name: '城西一册', org: s.branches[1], members: bookB },
    { key: 'C', bookNo: 'SF-BOOK-C', name: '城南一册', org: s.branches[2], members: bookC },
  ];
  for (const b of bookDefs) {
    if (!s.books.find((x) => x.bookNo === b.bookNo)) {
      const created = await createBook(page, {
        bookNo: b.bookNo, name: b.name, orgName: b.org.name,
        readerName: b.reader ? `${b.reader.name}（${b.reader.login}）` : undefined,
        scheduleDay: 5,
      });
      s.books.push({ ...created, memberKeys: b.members.map((m) => m.key) });
      save(s);
    }
    const book = s.books.find((x) => x.bookNo === b.bookNo);
    // reconcile-first: read current membership from DB before any re-add —
    // a checkpointed add that crashed mid-list must not be replayed blindly.
    book.members = await db((p) =>
      p.bookMeter.findMany({ where: { tenantId: s.tenantId, bookId: book.id } }));
    const missing = b.members.filter(
      (m) => !book.members.some((mm: any) => mm.waterAccountId === m.waterAccount.id),
    );
    if (missing.length) {
      await addBookMembers(page, b.name, missing);
      book.members = await db((p) =>
        p.bookMeter.findMany({ where: { tenantId: s.tenantId, bookId: book.id } }));
      save(s);
    }
  }
  await evidence(page, info, 'j2-books', s.books);

  // ---- plans + entry: reader does book A; admin does B/C ----
  const planEntries: Record<string, EntrySpec[]> = {};
  for (const b of bookDefs) {
    const members = b.members;
    planEntries[b.key] = members.map((m) => {
      if (m.key === 'SF-A-008') {
        return { accountNo: m.key, resultType: 'NO_READ' as const, exceptionCode: '锁闭无法入户', estimateQty: '15' };
      }
      const initial = Number(m.installation.initialReading ?? 0);
      return { accountNo: m.key, resultType: 'ACTUAL' as const, value: String(initial + usage1(m.key)) };
    });
  }

  for (const b of bookDefs) {
    if (!s.plans[`${P1}-${b.key}`]) {
      // reconcile-first: the plan may already exist from a crashed attempt
      const bookId = s.books.find((x) => x.bookNo === b.bookNo)!.id;
      const existing = await db((p) =>
        p.readingPlan.findFirst({ where: { tenantId: s.tenantId, bookId, period: P1 } }));
      if (!existing) {
        await generatePlan(page, b.name, P1, b.bookNo);
      }
      const planId = (existing ?? await db((p) =>
        p.readingPlan.findFirstOrThrow({ where: { tenantId: s.tenantId, bookId, period: P1 } }))).id;
      await startPlan(page, b.name, planId);
      const detail = await openPlanDetail(page, b.name);
      s.plans[`${P1}-${b.key}`] = { id: detail.id, bookKey: b.key, period: P1, itemCount: detail.items.length };
      save(s);
      expect(detail.items.length).toBe(b.members.length);
    }
    if (!s.readings[`${P1}-${b.key}`]) {
      // reconcile-first: batch entry is single-tx — if committed, every
      // plan item already has a reading; never re-click blindly.
      const planId = s.plans[`${P1}-${b.key}`].id;
      const done = await db((p) => p.meterReading.count({
        where: { tenantId: s.tenantId, planItem: { planId } },
      }));
      if (done === 0) {
        const res = await batchEnter(page, planId, b.name, planEntries[b.key]);
        s.readings[`${P1}-${b.key}`] = { created: res.created, entries: planEntries[b.key] };
      } else {
        s.readings[`${P1}-${b.key}`] = { created: done, entries: planEntries[b.key], reconciled: true };
      }
      save(s);
    }
  }

  // ---- QC (reviewer): pass all; one MANUAL_REVIEW→pass; one REJECT→re-enter→pass ----
  // Reconcile-first: QC clicks are not checkpointed — read qc_status from
  // DB before clicking so a mid-QC crash doesn't re-click a PASSED row.
  // returns live (unsuperseded) readings — a row is superseded when another
  // row's supersedesReadingId points at it (no supersededById column).
  const qcOf = (accountNo: string) => db(async (p) => {
    const acct = await p.waterAccount.findFirstOrThrow({ where: { tenantId: s.tenantId, accountNo } });
    const all = await p.meterReading.findMany({
      where: { tenantId: s.tenantId, installation: { waterAccountId: acct.id }, period: P1 },
      select: { id: true, qcStatus: true, supersedesReadingId: true },
    });
    const superseded = new Set(all.map((r: any) => r.supersedesReadingId).filter(Boolean));
    return all.filter((r: any) => !superseded.has(r.id));
  });
  await login(page, 'sf-reviewer');
  const allEntries = Object.values(planEntries).flat();
  for (const e of allEntries) {
    if (e.accountNo === 'SF-A-002' || e.accountNo === 'SF-A-003') continue;
    const rows = await qcOf(e.accountNo);
    if (rows.some((r: any) => r.qcStatus === 'PENDING')) {
      await qcReading(page, e.accountNo, '通过');
    }
  }
  // review path: SF-A-002 → 复核 then 通过 (skip legs already done)
  {
    const rows = await qcOf('SF-A-002');
    if (rows[0]?.qcStatus === 'PENDING') await qcReading(page, 'SF-A-002', '复核');
    const after = await qcOf('SF-A-002');
    if (after[0]?.qcStatus === 'MANUAL_REVIEW') {
      await qcReading(page, 'SF-A-002', '通过');
    }
  }
  // reject path: SF-A-003 → 驳回 (READING_QC_REJECTED fact for J7), then
  // the reader supersedes it with a corrected ACTUAL and QC passes —
  // the fact clears by supersede (detector anti-joins on the child).
  const a3 = bookA.find((m) => m.key === 'SF-A-003');
  const corrected = String(Number(a3.installation.initialReading ?? 0) + usage1('SF-A-003') + 1);
  {
    const rows = await qcOf('SF-A-003');
    if (rows[0]?.qcStatus === 'PENDING') {
      await qcReading(page, 'SF-A-003', '驳回');
      await evidence(page, info, 'j2-qc-rejected');
    }
  }
  {
    const rows = await qcOf('SF-A-003');
    if (!rows.some((r: any) => r.qcStatus === 'PASSED')) {
      // supersede the rejected reading via UI (reader role)
      const rejected = rows.find((r: any) => r.qcStatus === 'REJECTED');
      if (rejected) {
        await login(page, 'sf-reader');
        await page.goto('/metering/readings');
        const search = page.getByPlaceholder('搜索户号、客户或地址');
        await search.fill('SF-A-003');
        await search.press('Enter');
        const rejectedRow = page.getByRole('row').filter({ hasText: 'SF-A-003' }).filter({ hasText: '质检驳回' });
        await rejectedRow.getByRole('button', { name: '更正' }).click();
        const supModal = page.getByRole('dialog', { name: /更正读数/ });
        await supModal.getByLabel('更正后表码读数').fill(corrected);
        await response(page, /\/meter-readings\/[0-9a-f-]+\/supersede/, () =>
          button(supModal, '更正').click());
        s.readings[`${P1}-A`].corrected = { 'SF-A-003': corrected };
        save(s);
        await login(page, 'sf-reviewer');
        await page.goto('/metering/readings');
        const search2 = page.getByPlaceholder('搜索户号、客户或地址');
        await search2.fill('SF-A-003');
        await search2.press('Enter');
        const liveRow = page.getByRole('row').filter({ hasText: 'SF-A-003' }).filter({ has: page.getByRole('button', { name: '通过' }) });
        await response(page, /\/meter-readings\/[0-9a-f-]+\/qc/, () =>
          liveRow.getByRole('button', { name: '通过' }).click());
      }
    }
  }

  // ---- verify ----
  await db(async (p) => {
    for (const b of bookDefs) {
      const plan = await p.readingPlan.findFirstOrThrow({
        where: { tenantId: s.tenantId, id: s.plans[`${P1}-${b.key}`].id },
        include: { items: true },
      });
      const open = plan.items.filter((i: any) => i.status === 'PENDING');
      expect(open, `${b.bookNo} pending items`).toHaveLength(0);
    }
    // latest unsuperseded reading per account exists; NO_READ has no value
    for (const e of allEntries) {
      const acct = await p.waterAccount.findFirstOrThrow({ where: { tenantId: s.tenantId, accountNo: e.accountNo } });
      const all = await p.meterReading.findMany({
        where: { tenantId: s.tenantId, installation: { waterAccountId: acct.id }, period: P1 },
      });
      const superseded = new Set(all.map((r: any) => r.supersedesReadingId).filter(Boolean));
      const readings = all.filter((r: any) => !superseded.has(r.id));
      expect(readings.length).toBe(1);
      expect(readings[0].qcStatus).toBe('PASSED');
      if (e.resultType === 'NO_READ') {
        expect(readings[0].resultType).toBe('NO_READ');
        expect(readings[0].estimateQty?.toString()).toBe(e.estimateQty);
      } else {
        const want = e.accountNo === 'SF-A-003' ? corrected : e.value;
        expect(Number(readings[0].readingValue)).toBe(Number(want));
      }
    }
  });
  s.stages.j2 = true;
  save(s);
  await evidence(page, info, 'j2-done', { plans: s.plans });
});
