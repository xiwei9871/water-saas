-- 20261026 追加抄表独立功能 + DMA D1：
-- 1) reading_plan.plan_type：常规 REGULAR / 追加 SUPPLEMENT（单户计划）。
-- 2) 表具角色 CHECK（考核表）废除——考核表唯一判定 = 用水户用水类别
--    MONITORING；存量 CHECK 一律复位 NORMAL（总分表关系不受影响）。
ALTER TABLE "reading_plan" ADD COLUMN IF NOT EXISTS "plan_type" varchar(16) NOT NULL DEFAULT 'REGULAR';
UPDATE "meter" SET "meter_role" = 'NORMAL', "updated_at" = now() WHERE "meter_role" = 'CHECK';
