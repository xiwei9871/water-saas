-- A1 续：已指派任务同样占用同 (type,biz) 的未完成唯一槽，防止对同一业务
-- 对象在指派进行中又生成重复任务。（ASSIGNED 枚举值需独立迁移先提交）

DROP INDEX IF EXISTS "task_open_dedupe";
CREATE UNIQUE INDEX "task_open_dedupe"
  ON "task"("tenant_id", "type", "biz_type", "biz_id")
  WHERE "status" IN ('PENDING', 'CLAIMED', 'ASSIGNED');
