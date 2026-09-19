-- T12 review I2: day-close membership is a first-class fact. The
-- RECEIVED→DAY_CLOSED flip stamps day_close_id so GET
-- /cashier-day-close/:id reads members exactly — reconstructing from
-- closed_at boundaries misattributes payments whose commits straddle a
-- queued close (closed_at = transaction_timestamp() = tx START).
ALTER TABLE "payment" ADD COLUMN "day_close_id" uuid;
CREATE INDEX "payment_tenant_day_close_idx" ON "payment" ("tenant_id", "day_close_id");
