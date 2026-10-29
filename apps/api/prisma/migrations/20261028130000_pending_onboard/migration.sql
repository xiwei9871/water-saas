-- 1028v2 放号-上号：用水户两新状态 + 档案号/指定抄表员/口径/复核字段
ALTER TYPE "AccountStatus" ADD VALUE IF NOT EXISTS 'PENDING_ASSIGN';
ALTER TYPE "AccountStatus" ADD VALUE IF NOT EXISTS 'PENDING_COMPLETE';

ALTER TABLE "water_account" ADD COLUMN IF NOT EXISTS "archive_no" TEXT;
ALTER TABLE "water_account" ADD COLUMN IF NOT EXISTS "assign_reader_id" UUID;
ALTER TABLE "water_account" ADD COLUMN IF NOT EXISTS "pending_caliber" TEXT;
ALTER TABLE "water_account" ADD COLUMN IF NOT EXISTS "activate_review" JSONB;
ALTER TABLE "water_account" ADD COLUMN IF NOT EXISTS "activated_at" TIMESTAMP(3);
CREATE UNIQUE INDEX IF NOT EXISTS "water_account_tenant_id_archive_no_key" ON "water_account"("tenant_id", "archive_no");

-- billable 检查放宽：原约束要求 billable=(非监控表)。放号-上号引入预占态——
-- PENDING_ASSIGN/PENDING_COMPLETE 户恒不可计费（billable=false），与监控表并列合法。
ALTER TABLE "water_account" DROP CONSTRAINT IF EXISTS "water_account_billable_chk";
ALTER TABLE "water_account" ADD CONSTRAINT "water_account_billable_chk"
  CHECK (billable = (usage_category <> 'MONITORING'::text
                     AND status NOT IN ('PENDING_ASSIGN'::"AccountStatus", 'PENDING_COMPLETE'::"AccountStatus")));
