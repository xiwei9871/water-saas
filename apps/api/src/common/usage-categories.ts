import { UnprocessableEntityException } from '@nestjs/common';

/**
 * Controlled usage categories (用水类别) — mirrored by DB CHECK constraints
 * on water_account.usage_category / tariff_plan.usage_category. API-level
 * validation gives a friendly 422; the CHECK is the last line of defense
 * for direct SQL/imports.
 */
export const USAGE_CATEGORIES = [
  'RES_METERED', // 居民（户表 / 一户一表）
  'RES_SHARED', // 居民（非户表 / 合表）
  'NON_RES', // 非居民
  'SPECIAL', // 特种
  'MONITORING', // 监控表 — non-billable measurement point
] as const;

export type UsageCategory = (typeof USAGE_CATEGORIES)[number];

export function assertUsageCategory(v: unknown): asserts v is UsageCategory {
  if (typeof v !== 'string' || !(USAGE_CATEGORIES as readonly string[]).includes(v)) {
    throw new UnprocessableEntityException({
      code: 'INVALID_USAGE_CATEGORY',
      allowed: USAGE_CATEGORIES,
    });
  }
}
