-- One reading may be superseded by at most ONE child (append-only
-- correction chain). Application guards this with FOR UPDATE + child
-- check; this partial index is the DB-level backstop so a chain head
-- can never be double-linked even under a missed code path.
CREATE UNIQUE INDEX "meter_reading_supersedes_unique"
  ON "meter_reading" ("tenant_id", "supersedes_reading_id")
  WHERE "supersedes_reading_id" IS NOT NULL;
