-- A1 任务派送/指派：ASSIGNED 状态——管理岗指派给具体责任人后进入其待办，
-- 语义上等同「处理中」（待办/biz-flags open/去重口径全含）。

ALTER TYPE "TaskStatus" ADD VALUE IF NOT EXISTS 'ASSIGNED';

-- 已指派任务同样占用同 (type,biz) 的未完成唯一槽，防止对同一业务对象
-- 在指派进行中又生成重复任务。
DROP INDEX IF EXISTS "task_open_dedupe";
CREATE UNIQUE INDEX "task_open_dedupe"
  ON "task"("tenant_id", "type", "biz_type", "biz_id")
  WHERE "status" IN ('PENDING', 'CLAIMED', 'ASSIGNED');
