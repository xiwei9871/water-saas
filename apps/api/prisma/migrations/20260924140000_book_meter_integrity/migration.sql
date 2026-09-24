-- RC1-2 (Human Pilot F9/F10): book_meter integrity.
--
-- 1) Normalize duplicate seq_no inside each book: dense 1..N ordered by the
--    existing (seq_no, created_at, water_account_id) — deterministic, keeps
--    the operator-visible order stable where possible.
-- 2) UNIQUE(book_id, seq_no): the DB backstop for route order (F9).
--
-- Single-book membership (F10) is enforced at the service layer
-- (account-row FOR UPDATE lock + ACCOUNT_IN_OTHER_BOOK + transfer), NOT by
-- a hard unique here: the MULTI_BOOK anomaly detector reads physical
-- book_meter rows, so a hard unique would make that detector untestable and
-- un-injectable (E9 fault harness). Revisit a DB-level single-book
-- constraint if the detector contract is ever retired.

-- 1) dense seq_no per book
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

-- 2) constraint
CREATE UNIQUE INDEX "book_meter_book_id_seq_no_key" ON "book_meter"("book_id", "seq_no");
