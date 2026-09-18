import { Decimal } from 'decimal.js';
import { DomainError } from './errors.js';
import { roundCent } from './round.js';

/**
 * One tariff tier row (spec §2.5 `tariff_tier`):
 * `fromQty`/`toQty` are CUMULATIVE annual-usage boundaries in m³
 * (`toQty === null` = unbounded top tier), `unitPrice` is 元/m³.
 */
export interface TariffTier {
  tierNo: number;
  fromQty: Decimal;
  toQty: Decimal | null;
  unitPrice: Decimal;
}

/** One priced tier segment — materializes as one `bill_item` row. */
export interface TierPart {
  tierNo: number;
  qty: Decimal;
  unitPrice: Decimal;
  amountCent: bigint;
}

export interface TieredAmount {
  amountCent: bigint;
  parts: TierPart[];
}

/**
 * Price `qty` m³ against cumulative-annual tier boundaries.
 *
 * Semantics (spec §1.3/§2.5 — 自然年累计分档):
 * - `ytdBeforeQty` = consumption already billed this calendar year (the
 *   caller computes it; year rollover is not this function's concern).
 * - `cursor` = ytdBeforeQty + qty already allocated to earlier tiers in
 *   THIS call. Each tier's capacity for this bill is
 *   `toQty === null ? remaining : max(0, toQty - cursor)` — a tier the
 *   cursor has already passed contributes nothing.
 * - Tiers are walked in `tierNo` order regardless of input order.
 * - Quantities keep full Decimal precision through the walk (分档计算过程
 *   保留4位小数); each tier line rounds to cents INDEPENDENTLY via
 *   roundCent (仅在成行时舍入), and `amountCent = Σ parts.amountCent`.
 *
 * Errors (all DomainError):
 * - `NEGATIVE_QTY`            — qty < 0. Negative zero (-0.0000) is zero.
 * - `NEGATIVE_YTD_BEFORE_QTY` — ytdBeforeQty < 0.
 * - `TARIFF_NO_TIERS`         — qty > 0 but tiers is empty.
 * - `TARIFF_TIERS_EXHAUSTED`  — qty remains after the last tier (no
 *   unbounded top tier covers it). Never silently under-bill: an
 *   unpriceable remainder means the tariff plan is misconfigured.
 * - `TARIFF_TIERS_INVALID`    — malformed windows: `toQty` values must be
 *   strictly increasing in tierNo order and `null` may appear only as the
 *   last tier. The API layer (`assertTiersValid`) enforces contiguity at
 *   write time; this is the engine's own last line of defense — a gap or
 *   overlap would otherwise be silently repriced at the WRONG rate.
 * - `INVALID_QTY`/`INVALID_YTD`/`INVALID_TIER_VALUE` — non-finite Decimal
 *   input (NaN/Infinity). The engine only throws DomainError for bad input.
 */
export function tieredAmount(
  qty: Decimal,
  ytdBeforeQty: Decimal,
  tiers: TariffTier[],
): TieredAmount {
  if (!qty.isFinite()) {
    throw new DomainError('INVALID_QTY', `qty must be finite, got ${qty}`);
  }
  if (!ytdBeforeQty.isFinite()) {
    throw new DomainError(
      'INVALID_YTD',
      `ytdBeforeQty must be finite, got ${ytdBeforeQty}`,
    );
  }
  if (qty.lt(0)) {
    throw new DomainError('NEGATIVE_QTY', `qty must be >= 0, got ${qty}`);
  }
  if (ytdBeforeQty.lt(0)) {
    throw new DomainError(
      'NEGATIVE_YTD_BEFORE_QTY',
      `ytdBeforeQty must be >= 0, got ${ytdBeforeQty}`,
    );
  }
  if (qty.isZero()) return { amountCent: 0n, parts: [] };
  if (tiers.length === 0) {
    throw new DomainError(
      'TARIFF_NO_TIERS',
      `cannot price qty ${qty}: tariff has no tiers`,
    );
  }

  const ordered = [...tiers].sort((a, b) => a.tierNo - b.tierNo);

  // Window integrity: toQty must strictly increase in tierNo order and
  // null is only legal on the last tier. A zero-width/regressive/gapped
  // ladder would otherwise price silently at the wrong rate.
  for (let i = 0; i < ordered.length; i++) {
    const t = ordered[i];
    if (!t.unitPrice.isFinite() || (t.toQty !== null && !t.toQty.isFinite())) {
      throw new DomainError(
        'INVALID_TIER_VALUE',
        `tier ${t.tierNo}: non-finite unitPrice/toQty`,
      );
    }
    if (t.toQty === null && i !== ordered.length - 1) {
      throw new DomainError(
        'TARIFF_TIERS_INVALID',
        `unbounded tier ${t.tierNo} is not the last tier`,
      );
    }
    if (i > 0 && t.toQty !== null) {
      const prev = ordered[i - 1].toQty;
      if (prev !== null && t.toQty.lte(prev)) {
        throw new DomainError(
          'TARIFF_TIERS_INVALID',
          `tier ${t.tierNo} toQty ${t.toQty} does not exceed previous ${prev}`,
        );
      }
    }
  }

  let remaining = qty;
  let cursor = ytdBeforeQty;
  let amountCent = 0n;
  const parts: TierPart[] = [];

  for (const t of ordered) {
    if (remaining.lte(0)) break;
    const cap =
      t.toQty === null
        ? remaining
        : Decimal.max(new Decimal(0), t.toQty.minus(cursor));
    const inTier = Decimal.min(remaining, cap);
    if (inTier.lte(0)) continue;
    const cent = roundCent(inTier.times(t.unitPrice));
    parts.push({
      tierNo: t.tierNo,
      qty: inTier,
      unitPrice: t.unitPrice,
      amountCent: cent,
    });
    amountCent += cent;
    remaining = remaining.minus(inTier);
    cursor = cursor.plus(inTier);
  }

  if (remaining.gt(0)) {
    throw new DomainError(
      'TARIFF_TIERS_EXHAUSTED',
      `${remaining} m³ of ${qty} exceeds all tier boundaries (top tier must have toQty = null)`,
    );
  }
  return { amountCent, parts };
}
