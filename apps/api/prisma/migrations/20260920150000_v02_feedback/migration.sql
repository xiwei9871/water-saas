-- v0.2 feedback: monitoring accounts, household-scaled tiers,
-- book-level reading cadence, NO_READ entry estimate, controlled
-- usage categories. See docs/superpowers/specs/2026-09-20-v02-feedback-design.md.

-- ============ 1. usage_category data migration (before CHECK) ============
-- Known legacy value → controlled code. Anything else fails the migration
-- below (fail-fast, never silently remap business meaning).
UPDATE "water_account" SET "usage_category" = 'RES_METERED' WHERE "usage_category" = 'RESIDENTIAL';
UPDATE "tariff_plan"   SET "usage_category" = 'RES_METERED' WHERE "usage_category" = 'RESIDENTIAL';

DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg(DISTINCT quote_literal(u), ', ') INTO bad
  FROM (
    SELECT usage_category AS u FROM water_account
    UNION ALL
    SELECT usage_category FROM tariff_plan
  ) t
  WHERE u NOT IN ('RES_METERED', 'RES_SHARED', 'NON_RES', 'SPECIAL', 'MONITORING');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'v02_feedback: unmappable usage_category values present: %. Map them before running this migration.', bad;
  END IF;
END $$;

-- ============ 2. generated column/table diff ============

-- AlterTable
ALTER TABLE "consumption_settlement" ADD COLUMN     "household_size_snapshot" INTEGER;

-- AlterTable
ALTER TABLE "customer" ADD COLUMN     "system_key" TEXT;

-- AlterTable
ALTER TABLE "meter_reading" ADD COLUMN     "estimate_qty" DECIMAL(18,4);

-- AlterTable
ALTER TABLE "reading_book" ADD COLUMN     "anchor_period" CHAR(6),
ADD COLUMN     "cadence" TEXT NOT NULL DEFAULT 'MONTHLY',
ADD COLUMN     "meter_channel" TEXT NOT NULL DEFAULT 'MECHANICAL';

-- AlterTable
ALTER TABLE "tariff_plan" ADD COLUMN     "base_household" INTEGER,
ADD COLUMN     "per_person_qty" DECIMAL(18,4);

-- AlterTable
ALTER TABLE "water_account" ADD COLUMN     "billable" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "water_account_household_profile" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "water_account_id" UUID NOT NULL,
    "household_size" INTEGER NOT NULL,
    "effective_from_period" CHAR(6) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "water_account_household_profile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "water_account_household_profile_tenant_id_water_account_id__key" ON "water_account_household_profile"("tenant_id", "water_account_id", "effective_from_period");

-- CreateIndex
CREATE UNIQUE INDEX "customer_tenant_id_system_key_key" ON "customer"("tenant_id", "system_key");

-- AddForeignKey
ALTER TABLE "water_account_household_profile" ADD CONSTRAINT "water_account_household_profile_tenant_id_water_account_id_fkey" FOREIGN KEY ("tenant_id", "water_account_id") REFERENCES "water_account"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============ 3. CHECK constraints (DB invariants, not just API) ============

ALTER TABLE "water_account" ADD CONSTRAINT "water_account_usage_category_chk"
  CHECK ("usage_category" IN ('RES_METERED', 'RES_SHARED', 'NON_RES', 'SPECIAL', 'MONITORING'));

ALTER TABLE "tariff_plan" ADD CONSTRAINT "tariff_plan_usage_category_chk"
  CHECK ("usage_category" IN ('RES_METERED', 'RES_SHARED', 'NON_RES', 'SPECIAL', 'MONITORING'));

-- billable is a derived invariant: MONITORING → false, everything else → true.
ALTER TABLE "water_account" ADD CONSTRAINT "water_account_billable_chk"
  CHECK ("billable" = ("usage_category" <> 'MONITORING'));

ALTER TABLE "reading_book" ADD CONSTRAINT "reading_book_cadence_chk"
  CHECK ("cadence" IN ('MONTHLY', 'BIMONTHLY'));

ALTER TABLE "reading_book" ADD CONSTRAINT "reading_book_meter_channel_chk"
  CHECK ("meter_channel" IN ('MECHANICAL', 'REMOTE_MANUAL', 'REMOTE_AUTO'));

-- BIMONTHLY without an anchor period is meaningless (odd/even undefined).
ALTER TABLE "reading_book" ADD CONSTRAINT "reading_book_bimonthly_anchor_chk"
  CHECK ("cadence" <> 'BIMONTHLY' OR "anchor_period" IS NOT NULL);

-- estimate_qty is a quantity carried by NO_READ rows only — a real dial
-- reading must never carry it (would blur the trusted-reading chain).
ALTER TABLE "meter_reading" ADD CONSTRAINT "meter_reading_estimate_qty_chk"
  CHECK ("estimate_qty" IS NULL OR "result_type" = 'NO_READ');

-- ============ 4. RLS for the new tenant table ============

ALTER TABLE "water_account_household_profile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "water_account_household_profile" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "water_account_household_profile"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ============ 5. FK constraint names: align with Prisma defaults ============
-- (custom-named FKs from 20260918130000 → default names; no semantic change)

ALTER TABLE "tariff_tier" DROP CONSTRAINT "tariff_tier_tenant_fee_item_fk";
ALTER TABLE "tariff_tier" DROP CONSTRAINT "tariff_tier_tenant_plan_fk";
ALTER TABLE "tariff_tier" ADD CONSTRAINT "tariff_tier_tenant_id_tariff_plan_id_fkey" FOREIGN KEY ("tenant_id", "tariff_plan_id") REFERENCES "tariff_plan"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tariff_tier" ADD CONSTRAINT "tariff_tier_tenant_id_fee_item_id_fkey" FOREIGN KEY ("tenant_id", "fee_item_id") REFERENCES "fee_item"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
