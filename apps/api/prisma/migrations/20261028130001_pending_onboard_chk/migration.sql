-- billable 检查放宽：原约束要求 billable=(非监控表)。放号-上号引入预占态——
-- PENDING_ASSIGN/PENDING_COMPLETE 户恒不可计费（billable=false），与监控表并列合法。
-- 独立迁移：enum 新值须先在前一迁移提交后方可被 CHECK 引用。
ALTER TABLE "water_account" DROP CONSTRAINT IF EXISTS "water_account_billable_chk";
ALTER TABLE "water_account" ADD CONSTRAINT "water_account_billable_chk"
  CHECK (billable = (usage_category <> 'MONITORING'::text
                     AND status NOT IN ('PENDING_ASSIGN'::"AccountStatus", 'PENDING_COMPLETE'::"AccountStatus")));
