import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantCtx } from '../../common/tenant-context.js';
import { detectAll } from './detectors.js';

/**
 * E9 Reconciler — the ONLY system path that writes work_item (D1).
 * Facts are recomputed every run; episodes are opened for new facts and
 * cleared when facts disappear. Never invoked from GET handlers.
 *
 * Reconcile is tenant-wide (episodes are tenant facts); caller scope only
 * gates WHO may trigger it, not WHAT it sees.
 */
@Injectable()
export class ExceptionReconciler {
  /**
   * One reconcile pass. Returns counts for observability.
   * Concurrency: two parallel passes race on the partial unique index
   * `(tenant_id, anomaly_key) WHERE cleared_at IS NULL` — the loser's
   * INSERT hits P2002 and is skipped as an idempotent race (C1/C2).
   */
  async reconcileTx(
    tx: Prisma.TransactionClient,
    ctx: TenantCtx,
  ): Promise<{ detected: number; created: number; resolved: number; cleared: number }> {
    const facts = await detectAll(tx, ctx.tenantId);
    const active = await tx.workItem.findMany({
      where: { tenantId: ctx.tenantId, clearedAt: null },
      select: { id: true, anomalyKey: true, anomalyType: true, status: true },
    });
    const byKey = new Map(active.map((e) => [e.anomalyKey, e]));
    const factKeys = new Set(facts.map((f) => f.key));
    const now = new Date();

    // open episodes for facts with no active episode
    let created = 0;
    for (const f of facts) {
      const existing = byKey.get(f.key);
      if (existing) {
        // defensive: RESOLVED without clearedAt is an inconsistent episode —
        // terminate it so this occurrence is a fresh episode (never reopen)
        if (existing.status === 'RESOLVED') {
          await tx.workItem.updateMany({
            where: { tenantId: ctx.tenantId, id: existing.id, clearedAt: null },
            data: { clearedAt: now, updatedBy: ctx.staffId },
          });
        } else {
          continue;
        }
      }
      // ON CONFLICT DO NOTHING on the partial-unique index: a concurrent
      // reconcile that wins the same key is an idempotent race, not a 500.
      // (A caught P2002 would still abort the whole tx — Postgres marks the
      // transaction failed — so the conflict must never reach an error.)
      const n = await tx.$executeRaw`
        INSERT INTO work_item
          (id, tenant_id, anomaly_key, anomaly_type, status,
           created_by, updated_by, created_at, updated_at)
        VALUES (gen_random_uuid(), ${ctx.tenantId}::uuid, ${f.key}, ${f.type},
                'OPEN'::"WorkItemStatus", ${ctx.staffId ?? null}::uuid,
                ${ctx.staffId ?? null}::uuid, now(), now())
        ON CONFLICT (tenant_id, anomaly_key) WHERE cleared_at IS NULL
        DO NOTHING`;
      if (n > 0) created++;
    }

    // clear episodes whose fact disappeared
    let resolved = 0;
    let cleared = 0;
    for (const e of active) {
      if (factKeys.has(e.anomalyKey)) continue;
      if (e.status === 'OPEN' || e.status === 'ACK') {
        // D3: fact-driven resolution — reconciler observed the fact gone
        const r = await tx.workItem.updateMany({
          where: { tenantId: ctx.tenantId, id: e.id, clearedAt: null },
          data: {
            status: 'RESOLVED',
            resolutionSource: 'AUTO',
            resolvedAt: now,
            clearedAt: now,
            updatedBy: ctx.staffId,
          },
        });
        resolved += r.count;
      } else {
        // IGNORED (or an already-RESOLVED straggler) — end the episode so a
        // recurrence can open a fresh one; status stays as the operator left it
        const r = await tx.workItem.updateMany({
          where: { tenantId: ctx.tenantId, id: e.id, clearedAt: null },
          data: { clearedAt: now, updatedBy: ctx.staffId },
        });
        cleared += r.count;
      }
    }
    return { detected: facts.length, created, resolved, cleared };
  }
}
