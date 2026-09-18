-- One actual reading anchors at most ONE reconciliation (append-only
-- calibration, spec §2.4): a second pass over the same actual is a
-- correction of the reconciliation itself, never a new row. The API
-- pre-checks for a friendly 409 RECONCILIATION_EXISTS; this index is the
-- DB-level backstop for the concurrent-create race.
CREATE UNIQUE INDEX "reconciliation_actual_uniq"
  ON "reconciliation" ("tenant_id", "actual_reading_id");
