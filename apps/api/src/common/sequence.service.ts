import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Current 'yyyyMM' period (server-local calendar month). Tenants in a
 * different timezone can see a number land on the other side of a month
 * boundary by ±1 day — acceptable for MVP numbering (unique, not gapless).
 */
const currentPeriod = (): string => {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
};

/**
 * Tenant-scoped document numbering (spec §1.2): numbers are
 * `<prefix><yyyyMM><6-digit sequence>` drawn from `sys_sequence`, isolated by
 * the (tenant_id, seq_key, period) unique index. The UPSERT … RETURNING runs
 * inside the caller's runAsTenant transaction, so concurrent allocations can
 * never collide and a rolled-back request returns its number (gaps are fine —
 * numbering is unique, not gapless).
 *
 * The physical unique index is NULLS NOT DISTINCT; a non-NULL period matches
 * plain ON CONFLICT inference (verified against PG15).
 *
 * Lives in common/ (registered on the global CommonModule): every module
 * consumes it — customer (customer_no/settle_no/account_no/meter_no),
 * metering (book_no), payment (payment_no/receipt_no) — and the module
 * direction forbids payment importing customer where it originally sat.
 */
export interface SeqSlot {
  seqKey: string;
  prefix: string;
  /**
   * True when `no` is already taken in that entity's number space.
   * Explicit/migrated numbers can sit ahead of a counter, so alignment must
   * skip candidates that were never issued by sys_sequence itself.
   */
  exists?: (no: string) => Promise<boolean>;
}

@Injectable()
export class SequenceService {
  async nextFormatted(
    tx: Prisma.TransactionClient,
    tenantId: string,
    seqKey: string,
    prefix: string,
    staffId?: string,
  ): Promise<string> {
    const period = currentPeriod();
    const rows = await tx.$queryRaw<{ cur_val: bigint }[]>`
      INSERT INTO sys_sequence (id, tenant_id, seq_key, period, cur_val,
                                created_at, created_by, updated_at, updated_by)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${seqKey}, ${period}::char(6), 1,
              now(), ${staffId ?? null}::uuid, now(), ${staffId ?? null}::uuid)
      ON CONFLICT (tenant_id, seq_key, period)
      DO UPDATE SET cur_val = sys_sequence.cur_val + 1,
                    updated_at = now(),
                    updated_by = ${staffId ?? null}::uuid
      RETURNING cur_val`;
    return `${prefix}${period}${rows[0].cur_val.toString().padStart(6, '0')}`;
  }

  /**
   * Round-2 numbering: entities created inside ONE onboard share a single
   * numeric suffix — 客户号/结算户/户号/表号 differ only by prefix, so an
   * operator can tell at a glance that C/S/A/M rows are the same household.
   *
   * Locks every slot's (tenant, seq_key, period) row FOR UPDATE inside the
   * caller's tx, then issues max(cur_val)+1 to ALL slots — counters jump
   * forward together (gaps are fine, numbering is unique not gapless) and
   * stay aligned for the next onboard. A candidate already taken by an
   * explicit/migrated number bumps the shared target until all spaces are
   * free. Same-tx rollback returns the numbers, like nextFormatted.
   */
  async nextAligned(
    tx: Prisma.TransactionClient,
    tenantId: string,
    slots: SeqSlot[],
    staffId?: string,
  ): Promise<string[]> {
    if (slots.length === 0) return [];
    const period = currentPeriod();
    for (const s of slots) {
      await tx.$executeRaw`
        INSERT INTO sys_sequence (id, tenant_id, seq_key, period, cur_val,
                                  created_at, created_by, updated_at, updated_by)
        VALUES (gen_random_uuid(), ${tenantId}::uuid, ${s.seqKey},
                ${period}::char(6), 0, now(), ${staffId ?? null}::uuid,
                now(), ${staffId ?? null}::uuid)
        ON CONFLICT (tenant_id, seq_key, period) DO NOTHING`;
    }
    const rows = await tx.$queryRaw<{ seq_key: string; cur_val: bigint }[]>`
      SELECT seq_key, cur_val FROM sys_sequence
      WHERE tenant_id = ${tenantId}::uuid AND period = ${period}::char(6)
        AND seq_key IN (${Prisma.join(slots.map((s) => s.seqKey))})
      ORDER BY seq_key FOR UPDATE`;
    const cur = new Map(rows.map((r) => [r.seq_key, Number(r.cur_val)]));
    let target = Math.max(...slots.map((s) => cur.get(s.seqKey) ?? 0)) + 1;
    let attempts = 0;
    for (;;) {
      const candidates = slots.map(
        (s) => `${s.prefix}${period}${String(target).padStart(6, '0')}`,
      );
      const taken = await Promise.all(
        slots.map((s, i) =>
          s.exists ? s.exists(candidates[i]) : Promise.resolve(false),
        ),
      );
      if (!taken.some(Boolean)) break;
      if (++attempts >= 50) {
        throw new Error(
          'aligned numbering exhausted: explicit numbers occupy 50 consecutive suffixes',
        );
      }
      target += 1;
    }
    for (const s of slots) {
      await tx.$executeRaw`
        UPDATE sys_sequence
        SET cur_val = ${target}, updated_at = now(),
            updated_by = ${staffId ?? null}::uuid
        WHERE tenant_id = ${tenantId}::uuid AND seq_key = ${s.seqKey}
          AND period = ${period}::char(6)`;
    }
    return slots.map(
      (s) => `${s.prefix}${period}${String(target).padStart(6, '0')}`,
    );
  }
}
