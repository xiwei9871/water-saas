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
}
