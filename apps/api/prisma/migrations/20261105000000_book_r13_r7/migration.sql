-- 1104 遗留核查：R13 抄表册删周期三字段（频次归属用水户）；R7 历史册 bookNo 同步为区段号编码。
ALTER TABLE reading_book DROP COLUMN IF EXISTS schedule_day;
ALTER TABLE reading_book DROP COLUMN IF EXISTS cadence;
ALTER TABLE reading_book DROP COLUMN IF EXISTS anchor_period;
-- 历史旧册：已赋区段号但 bookNo 仍是 B+年月+流水 → 改写为 区号+段号。
UPDATE reading_book
SET book_no = zone_no || seg_no, updated_at = now()
WHERE zone_no IS NOT NULL AND seg_no IS NOT NULL
  AND book_no <> zone_no || seg_no;
