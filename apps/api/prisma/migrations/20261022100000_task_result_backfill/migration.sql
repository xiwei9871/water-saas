-- 任务驱动闭环 3.4：完成任务必须回填处理结果+佐证，供后期回查。
ALTER TABLE "task" ADD COLUMN "result_note" text;
ALTER TABLE "task" ADD COLUMN "result_evidence" jsonb;
