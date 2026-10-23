-- 20261023 B1：抄表周期精确为 每月/单月/双月/季度 四种。
-- 先放开旧 CHECK 再改写存量值，否则 UPDATE 撞旧约束。
ALTER TABLE "reading_book" DROP CONSTRAINT "reading_book_cadence_chk";
ALTER TABLE "reading_book" DROP CONSTRAINT "reading_book_bimonthly_anchor_chk";

-- 存量 BIMONTHLY 按 anchor_period 月份奇偶映射（anchor 语义即奇偶）。
UPDATE "reading_book"
   SET "cadence" = CASE
     WHEN "anchor_period" IS NOT NULL
          AND substring("anchor_period" from 5 for 2)::int % 2 = 1
       THEN 'ODD_MONTH'
       ELSE 'EVEN_MONTH'
   END
 WHERE "cadence" = 'BIMONTHLY';

ALTER TABLE "reading_book" ADD CONSTRAINT "reading_book_cadence_chk"
  CHECK ("cadence" IN ('MONTHLY', 'ODD_MONTH', 'EVEN_MONTH', 'QUARTERLY'));
-- 仅季度册需要首抄月锚点（单/双月由月份奇偶天然决定）。
ALTER TABLE "reading_book" ADD CONSTRAINT "reading_book_quarterly_anchor_chk"
  CHECK ("cadence" <> 'QUARTERLY' OR "anchor_period" IS NOT NULL);
