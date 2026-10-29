-- 1028v2 放号-上号：用水户两新状态 + 档案号/指定抄表员/口径/复核字段。
-- 注意：enum 新值与引用它的 CHECK 约束必须分两个迁移（Postgres 不允许
-- 新枚举值与使用方同事务提交）——CHECK 放宽在 *_pending_onboard_chk。
ALTER TYPE "AccountStatus" ADD VALUE IF NOT EXISTS 'PENDING_ASSIGN';
ALTER TYPE "AccountStatus" ADD VALUE IF NOT EXISTS 'PENDING_COMPLETE';

ALTER TABLE "water_account" ADD COLUMN IF NOT EXISTS "archive_no" TEXT;
ALTER TABLE "water_account" ADD COLUMN IF NOT EXISTS "assign_reader_id" UUID;
ALTER TABLE "water_account" ADD COLUMN IF NOT EXISTS "pending_caliber" TEXT;
ALTER TABLE "water_account" ADD COLUMN IF NOT EXISTS "activate_review" JSONB;
ALTER TABLE "water_account" ADD COLUMN IF NOT EXISTS "activated_at" TIMESTAMP(3);
CREATE UNIQUE INDEX IF NOT EXISTS "water_account_tenant_id_archive_no_key" ON "water_account"("tenant_id", "archive_no");
