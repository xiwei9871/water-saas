-- A1 任务派送/指派：ASSIGNED 状态——管理岗指派给具体责任人后进入其待办，
-- 语义上等同「处理中」（待办/biz-flags open/去重口径全含）。
-- 注：enum 新值必须单独提交后才能被使用，去重索引在后续迁移中重建。

ALTER TYPE "TaskStatus" ADD VALUE IF NOT EXISTS 'ASSIGNED';
