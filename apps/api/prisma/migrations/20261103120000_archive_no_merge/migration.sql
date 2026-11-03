-- 1103 修订：两号合一——用水户仅保留「用户档案号」(account_no)，
-- 删除第二编号 archive_no（区域码+段号+流水）。待上号户作废档案号
-- 以户号为用户档案号重打标签；历史引用 account_no 不变。
DROP INDEX IF EXISTS "water_account_tenant_id_archive_no_key";
ALTER TABLE "water_account" DROP COLUMN IF EXISTS "archive_no";
