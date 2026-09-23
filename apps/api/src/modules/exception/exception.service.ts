import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { staffScopeTx } from '../../common/org-scope.js';
import { TenantPrismaService } from '../../common/tenant-prisma.js';
import type { TenantCtx } from '../../common/tenant-context.js';
import { detectAll, evaluateKey } from './detectors.js';
import { ExceptionReconciler } from './reconciler.js';
import { anchoredVisible, filterVisible, resolveAnchors, factVisibleTo, objectAnchorTx, objectAnchorsBatchTx, type AnchoredFact } from './scope.js';
import { parseKey, type AnomalyFact } from './types.js';

const badKey = () => new BadRequestException({ code: 'ANOMALY_KEY_INVALID' });
const notFound = () => new NotFoundException({ code: 'ANOMALY_NOT_FOUND' });
const outOfScope = () => new ForbiddenException({ code: 'ORG_OUT_OF_SCOPE' });

/**
 * E9 Exception Center service — orchestrates the three separated pieces:
 * Detector (pure) → Reconciler (writes) → Query (read-only join).
 * GET paths in this service NEVER write work_item (D1).
 */
@Injectable()
export class ExceptionService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly reconciler: ExceptionReconciler,
  ) {}

  // ------------------------------------------------------------------
  // query (read-only — MUST NOT write work_item)
  // ------------------------------------------------------------------

  async list(
    ctx: TenantCtx,
    q: {
      type?: string; severity?: string; status?: string;
      /** A1: 仅匹配 fact.period；无 period 的 anomaly 在 period 过滤下不返回 */
      period?: string;
      /** A1: org/book 过滤作用于已解析 anchor —— 只能收窄已可见集合，
       *  off-book TENANT / 未解析对象永远不匹配 org/book 过滤 */
      orgUnitId?: string; bookId?: string;
      page: number; take: number;
    },
  ) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      let facts = await filterVisible(tx, ctx, await detectAll(tx, ctx.tenantId));
      if (q.type) facts = facts.filter((f) => f.type === q.type);
      if (q.severity) facts = facts.filter((f) => f.severity === q.severity);
      if (q.period) facts = facts.filter((f) => f.period === q.period);
      if (q.orgUnitId) {
        facts = facts.filter((f) => f.coveringOrgs?.includes(q.orgUnitId!) === true);
      }
      if (q.bookId) {
        facts = facts.filter(
          (f) => f.anchor === 'ACCOUNT' && (f.coveringBookIds ?? []).includes(q.bookId!),
        );
      }

      const episodes = await tx.workItem.findMany({
        where: {
          tenantId: ctx.tenantId,
          anomalyKey: { in: facts.map((f) => f.key) },
          clearedAt: null,
        },
      });
      const epByKey = new Map(episodes.map((e) => [e.anomalyKey, e]));

      let items = facts.map((f) => this.toItem(f, epByKey.get(f.key)));
      if (q.status) {
        // facts without an episode are implicitly OPEN (reconcile pending)
        items = items.filter((i) => i.episode.status === q.status);
      }
      items.sort((a, b) =>
        a.severity === b.severity ? a.key.localeCompare(b.key) : a.severity === 'BLOCKING' ? -1 : 1,
      );
      const total = items.length;
      const start = (q.page - 1) * q.take;
      return {
        items: items.slice(start, start + q.take),
        total,
        page: q.page,
        take: q.take,
        asOf: new Date().toISOString(),
      };
    });
  }

  async summary(ctx: TenantCtx) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const facts = await filterVisible(tx, ctx, await detectAll(tx, ctx.tenantId));
      const episodes = await tx.workItem.findMany({
        where: {
          tenantId: ctx.tenantId,
          anomalyKey: { in: facts.map((f) => f.key) },
          clearedAt: null,
        },
        select: { anomalyKey: true, status: true },
      });
      const epByKey = new Map(episodes.map((e) => [e.anomalyKey, e.status]));
      let open = 0, ack = 0, suppressed = 0;
      for (const f of facts) {
        const s = epByKey.get(f.key) ?? 'OPEN';
        if (s === 'OPEN') open++;
        else if (s === 'ACK') ack++;
        else if (s === 'IGNORED') suppressed++;
      }

      // A2 — todayAdded / todayCleared: episode timestamps in today's UTC
      // operating window, scope re-derived from the anomaly key's underlying
      // object (cleared facts no longer exist — objectAnchorTx applies the
      // same D21 anchor rules without widening scope).
      const dayStart = new Date();
      dayStart.setUTCHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
      const todays = await tx.workItem.findMany({
        where: {
          tenantId: ctx.tenantId,
          OR: [
            { createdAt: { gte: dayStart, lt: dayEnd } },
            { clearedAt: { gte: dayStart, lt: dayEnd } },
          ],
        },
        select: { anomalyKey: true, createdAt: true, clearedAt: true },
      });
      let todayAdded = 0, todayCleared = 0;
      if (todays.length) {
        // batch object-anchor resolution — one query per object kind, not N+1.
        // Unparseable keys are dropped here and treated as invisible below.
        const valid = todays
          .map((w, i) => ({ w, i, parsed: parseKey(w.anomalyKey) }))
          .filter((x): x is typeof x & { parsed: NonNullable<typeof x.parsed> } => x.parsed !== null);
        const anchors = await objectAnchorsBatchTx(tx, ctx.tenantId, valid.map((x) => x.parsed));
        for (let vi = 0; vi < valid.length; vi++) {
          const { w } = valid[vi];
          const anchor = anchors.get(vi) ?? null;
          // unresolvable object → TENANT-level: visible to ALL scope only
          const visible = anchor ? anchoredVisible(anchor, ctx) : ctx.scope === 'ALL';
          if (!visible) continue;
          if (w.createdAt >= dayStart && w.createdAt < dayEnd) todayAdded++;
          if (w.clearedAt && w.clearedAt >= dayStart && w.clearedAt < dayEnd) todayCleared++;
        }
      }
      return {
        open, acknowledged: ack, suppressedIgnored: suppressed,
        activeFacts: facts.length, todayAdded, todayCleared,
        asOf: new Date().toISOString(),
      };
    });
  }

  async detail(ctx: TenantCtx, key: string) {
    const parsed = parseKey(key);
    if (!parsed) throw badKey();
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const fact = await evaluateKey(tx, ctx.tenantId, parsed);
      if (!fact) throw notFound();
      const [anchored] = await resolveAnchors(tx, ctx.tenantId, [fact]);
      if (!anchoredVisible(anchored, ctx)) throw outOfScope();
      const episode = await tx.workItem.findFirst({
        where: { tenantId: ctx.tenantId, anomalyKey: key, clearedAt: null },
      });
      const history = await tx.workItem.findMany({
        where: { tenantId: ctx.tenantId, anomalyKey: key, clearedAt: { not: null } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
      return { fact: anchored, episode: episode ?? null, history };
    });
  }

  // ------------------------------------------------------------------
  // reconcile trigger (the ONLY writing system path besides operator APIs)
  // ------------------------------------------------------------------

  async refresh(ctx: TenantCtx) {
    return this.prisma.runAsTenant(ctx.tenantId, (tx) => this.reconciler.reconcileTx(tx, ctx));
  }

  // ------------------------------------------------------------------
  // options projections — minimal picklists so the UI never needs
  // iam:read / metering:read to render its own filters (RC2 P1).
  // Scoped callers only see options inside their own orgScope.
  // ------------------------------------------------------------------

  async optionOrgs(ctx: TenantCtx) {
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.orgUnit.findMany({
        where: {
          tenantId: ctx.tenantId,
          ...(ctx.scope === 'ALL' ? {} : { id: { in: ctx.orgScope } }),
        },
        select: { id: true, name: true, type: true, parentId: true },
        orderBy: { name: 'asc' },
      }),
    );
  }

  async optionBooks(ctx: TenantCtx) {
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.readingBook.findMany({
        where: {
          tenantId: ctx.tenantId,
          ...(ctx.scope === 'ALL' ? {} : { orgUnitId: { in: ctx.orgScope } }),
        },
        select: { id: true, name: true, bookNo: true, orgUnitId: true },
        orderBy: { bookNo: 'asc' },
      }),
    );
  }

  async optionAssignees(ctx: TenantCtx) {
    return this.prisma.runAsTenant(ctx.tenantId, (tx) =>
      tx.staff.findMany({
        where: {
          tenantId: ctx.tenantId,
          status: 'ACTIVE',
          ...(ctx.scope === 'ALL' ? {} : { orgUnitId: { in: ctx.orgScope } }),
        },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    );
  }

  // ------------------------------------------------------------------
  // episode writes — every path re-evaluates the fact first (D3/D7)
  // ------------------------------------------------------------------

  /** shared gate: parse key → fact must currently exist → caller visible. */
  private async gate(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
    key: string,
  ): Promise<{ fact: AnomalyFact }> {
    const parsed = parseKey(key);
    if (!parsed) throw badKey();
    const fact = await evaluateKey(tx, ctx.tenantId, parsed);
    if (!fact) throw notFound();
    if (!(await factVisibleTo(tx, ctx.tenantId, fact, ctx))) throw outOfScope();
    return { fact };
  }

  /** fetch active episode or throw — cleared episodes are terminal. */
  private async activeEpisode(tx: Prisma.TransactionClient, ctx: TenantCtx, key: string) {
    const ep = await tx.workItem.findFirst({
      where: { tenantId: ctx.tenantId, anomalyKey: key, clearedAt: null },
    });
    if (!ep) throw new ConflictException({ code: 'EPISODE_CLEARED' });
    return ep;
  }

  async ack(ctx: TenantCtx, key: string) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      await this.gate(tx, ctx, key);
      const ep = await this.activeEpisode(tx, ctx, key);
      if (ep.status === 'IGNORED') throw new ConflictException({ code: 'WORK_ITEM_FINAL_STATE' });
      if (ep.status === 'ACK') return ep; // idempotent
      return tx.workItem.update({
        where: { id: ep.id },
        data: { status: 'ACK', acknowledgedAt: new Date(), assigneeId: ep.assigneeId ?? ctx.staffId, updatedBy: ctx.staffId },
      });
    });
  }

  async assign(ctx: TenantCtx, key: string, assigneeId: string) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const { fact } = await this.gate(tx, ctx, key);
      const ep = await this.activeEpisode(tx, ctx, key);
      // assignee must be able to see this anomaly under their own scope
      const who = await staffScopeTx(tx, ctx.tenantId, assigneeId);
      if (!who) throw new BadRequestException({ code: 'ASSIGNEE_NOT_FOUND' });
      if (!(await factVisibleTo(tx, ctx.tenantId, fact, who))) {
        throw new ForbiddenException({ code: 'ASSIGNEE_OUT_OF_SCOPE' });
      }
      return tx.workItem.update({
        where: { id: ep.id },
        data: { assigneeId, updatedBy: ctx.staffId },
      });
    });
  }

  async ignore(ctx: TenantCtx, key: string, note: string | undefined) {
    if (!note?.trim()) throw new BadRequestException({ code: 'NOTE_REQUIRED', field: 'note' });
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      await this.gate(tx, ctx, key);
      const ep = await this.activeEpisode(tx, ctx, key);
      if (ep.status === 'IGNORED') return ep; // idempotent
      return tx.workItem.update({
        where: { id: ep.id },
        data: { status: 'IGNORED', note: note.trim(), updatedBy: ctx.staffId },
      });
    });
  }

  /**
   * D3/D7: RESOLVED is fact-driven. Manual resolve re-evaluates the
   * detector — a still-active fact is a 409, not a stale queue entry.
   */
  async resolve(ctx: TenantCtx, key: string, note?: string) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      const parsed = parseKey(key);
      if (!parsed) throw badKey();
      const fact = await evaluateKey(tx, ctx.tenantId, parsed);
      if (fact) {
        if (!(await factVisibleTo(tx, ctx.tenantId, fact, ctx))) throw outOfScope();
        throw new ConflictException({ code: 'ANOMALY_STILL_ACTIVE' });
      }
      // fact gone — scope must come from the underlying object (D21 anchor),
      // not the (now-absent) fact.
      const anchor = await objectAnchorTx(tx, ctx.tenantId, parsed);
      if (!anchor) throw notFound();
      if (!anchoredVisible(anchor, ctx)) throw outOfScope();
      const ep = await tx.workItem.findFirst({
        where: { tenantId: ctx.tenantId, anomalyKey: key, clearedAt: null },
      });
      if (!ep) throw notFound();
      if (ep.status === 'IGNORED') throw new ConflictException({ code: 'WORK_ITEM_FINAL_STATE' });
      const now = new Date();
      return tx.workItem.update({
        where: { id: ep.id },
        data: {
          status: 'RESOLVED',
          resolutionSource: 'MANUAL',
          resolvedAt: now,
          clearedAt: now,
          note: note?.trim() || ep.note,
          updatedBy: ctx.staffId,
        },
      });
    });
  }

  /** unignore: lift suppression while the fact is still active. */
  async unignore(ctx: TenantCtx, key: string) {
    return this.prisma.runAsTenant(ctx.tenantId, async (tx) => {
      await this.gate(tx, ctx, key);
      const ep = await this.activeEpisode(tx, ctx, key);
      if (ep.status !== 'IGNORED') throw new ConflictException({ code: 'WORK_ITEM_NOT_IGNORED' });
      return tx.workItem.update({
        where: { id: ep.id },
        data: { status: 'OPEN', updatedBy: ctx.staffId },
      });
    });
  }

  private toItem(f: AnchoredFact, ep?: {
    id: string; status: string; assigneeId: string | null; note: string | null;
    acknowledgedAt: Date | null; resolvedAt: Date | null; createdAt: Date;
  }) {
    return {
      key: f.key,
      type: f.type,
      severity: f.severity,
      anchor: f.anchor,
      waterAccountId: f.waterAccountId ?? null,
      remoteSourceId: f.remoteSourceId ?? null,
      anchorRef: f.anchorRef,
      period: f.period ?? null,
      summary: f.summary,
      episode: ep
        ? {
            id: ep.id,
            status: ep.status,
            assigneeId: ep.assigneeId,
            note: ep.note,
            acknowledgedAt: ep.acknowledgedAt,
            resolvedAt: ep.resolvedAt,
            since: ep.createdAt,
          }
        : { id: null, status: 'OPEN', assigneeId: null, note: null, acknowledgedAt: null, resolvedAt: null, since: null },
    };
  }
}
