-- R1 退号：RETURNED 户恒不可计费（billable=false），与预占/监控表并列合法。
-- enum 新值须在前一迁移提交后方可被 CHECK 引用。
ALTER TABLE "water_account" DROP CONSTRAINT IF EXISTS "water_account_billable_chk";
ALTER TABLE "water_account" ADD CONSTRAINT "water_account_billable_chk"
  CHECK (billable = (usage_category <> 'MONITORING'::text
                     AND status NOT IN ('PENDING_ASSIGN'::"AccountStatus",
                                        'PENDING_COMPLETE'::"AccountStatus",
                                        'RETURNED'::"AccountStatus")));
