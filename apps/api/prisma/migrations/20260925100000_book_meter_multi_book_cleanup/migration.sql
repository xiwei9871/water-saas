-- RC2 (Human Pilot F10 follow-up): clean historical multi-book memberships.
--
-- The previous migration (20260924140000_book_meter_integrity) normalized
-- seq_no and added UNIQUE(book_id, seq_no), but deliberately left
-- pre-existing duplicate memberships in place: Round-1 human testers had
-- already put the same water account into two books on the Pilot DB, and
-- F10 only closed the "stop producing new duplicates" half. This migration
-- closes the historical half:
--   keep the EARLIEST membership per (tenant_id, water_account_id)
--   (created_at ASC, book_id ASC tie-break — deterministic),
--   delete the rest, then re-dense seq_no on the affected books.
--
-- Still no UNIQUE(tenant_id, water_account_id): the single-book rule stays
-- service-enforced (water_account row FOR UPDATE + ACCOUNT_IN_OTHER_BOOK +
-- explicit transfer), and the E9 fault harness keeps its internal
-- allowMultiBook escape hatch so the MULTI_BOOK detector remains
-- exercisable.

-- 1) delete non-earliest memberships (PK is (book_id, water_account_id),
--    so each row joins exactly one ranked row)
WITH ranked AS (
  SELECT book_id,
         water_account_id,
         ROW_NUMBER() OVER (
           PARTITION BY tenant_id, water_account_id
           ORDER BY created_at, book_id
         ) AS rn
  FROM book_meter
)
DELETE FROM book_meter bm
USING ranked r
WHERE bm.book_id = r.book_id
  AND bm.water_account_id = r.water_account_id
  AND r.rn > 1;

-- 2) re-dense seq_no per book (deletions may have left gaps)
WITH ranked AS (
  SELECT book_id,
         water_account_id,
         ROW_NUMBER() OVER (
           PARTITION BY tenant_id, book_id
           ORDER BY seq_no, created_at, water_account_id
         ) AS rn
  FROM book_meter
)
UPDATE book_meter bm
SET seq_no = r.rn
FROM ranked r
WHERE bm.book_id = r.book_id
  AND bm.water_account_id = r.water_account_id
  AND bm.seq_no <> r.rn;
