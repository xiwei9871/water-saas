-- CreateIndex
CREATE INDEX "meter_reading_tenant_id_supersedes_reading_id_idx" ON "meter_reading"("tenant_id", "supersedes_reading_id");
