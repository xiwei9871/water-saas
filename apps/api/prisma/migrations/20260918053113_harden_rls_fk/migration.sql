/*
  Warnings:

  - A unique constraint covering the columns `[tenant_id,id]` on the table `bill` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[tenant_id,id]` on the table `consumption_settlement` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[tenant_id,id]` on the table `customer` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[tenant_id,id]` on the table `meter` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[tenant_id,id]` on the table `meter_installation` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[tenant_id,id]` on the table `org_unit` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[tenant_id,id]` on the table `payment` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[tenant_id,id]` on the table `reading_plan` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[tenant_id,id]` on the table `reading_plan_item` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[tenant_id,id]` on the table `settle_account` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[tenant_id,id]` on the table `staff` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[tenant_id,id]` on the table `tariff_plan` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[tenant_id,id]` on the table `water_account` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "bill_tenant_id_id_key" ON "bill"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "book_meter_tenant_id_water_account_id_idx" ON "book_meter"("tenant_id", "water_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "consumption_settlement_tenant_id_id_key" ON "consumption_settlement"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_tenant_id_id_key" ON "customer"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "meter_tenant_id_status_idx" ON "meter"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "meter_tenant_id_id_key" ON "meter"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "meter_installation_tenant_id_id_key" ON "meter_installation"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "org_unit_tenant_id_id_key" ON "org_unit"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_tenant_id_id_key" ON "payment"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "reading_plan_tenant_id_id_key" ON "reading_plan"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "reading_plan_item_tenant_id_id_key" ON "reading_plan_item"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "settle_account_tenant_id_id_key" ON "settle_account"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "staff_tenant_id_id_key" ON "staff"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tariff_plan_tenant_id_id_key" ON "tariff_plan"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "water_account_tenant_id_id_key" ON "water_account"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_tenant_id_org_unit_id_fkey" FOREIGN KEY ("tenant_id", "org_unit_id") REFERENCES "org_unit"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "water_account" ADD CONSTRAINT "water_account_tenant_id_customer_id_fkey" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customer"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "water_account" ADD CONSTRAINT "water_account_tenant_id_settle_account_id_fkey" FOREIGN KEY ("tenant_id", "settle_account_id") REFERENCES "settle_account"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter_installation" ADD CONSTRAINT "meter_installation_tenant_id_meter_id_fkey" FOREIGN KEY ("tenant_id", "meter_id") REFERENCES "meter"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter_installation" ADD CONSTRAINT "meter_installation_tenant_id_water_account_id_fkey" FOREIGN KEY ("tenant_id", "water_account_id") REFERENCES "water_account"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reading_plan_item" ADD CONSTRAINT "reading_plan_item_tenant_id_plan_id_fkey" FOREIGN KEY ("tenant_id", "plan_id") REFERENCES "reading_plan"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reading_plan_item" ADD CONSTRAINT "reading_plan_item_tenant_id_water_account_id_fkey" FOREIGN KEY ("tenant_id", "water_account_id") REFERENCES "water_account"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter_reading" ADD CONSTRAINT "meter_reading_tenant_id_plan_item_id_fkey" FOREIGN KEY ("tenant_id", "plan_item_id") REFERENCES "reading_plan_item"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter_reading" ADD CONSTRAINT "meter_reading_tenant_id_installation_id_fkey" FOREIGN KEY ("tenant_id", "installation_id") REFERENCES "meter_installation"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consumption_component" ADD CONSTRAINT "consumption_component_tenant_id_settlement_id_fkey" FOREIGN KEY ("tenant_id", "settlement_id") REFERENCES "consumption_settlement"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consumption_component" ADD CONSTRAINT "consumption_component_tenant_id_installation_id_fkey" FOREIGN KEY ("tenant_id", "installation_id") REFERENCES "meter_installation"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill" ADD CONSTRAINT "bill_tenant_id_tariff_plan_id_fkey" FOREIGN KEY ("tenant_id", "tariff_plan_id") REFERENCES "tariff_plan"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill" ADD CONSTRAINT "bill_tenant_id_water_account_id_fkey" FOREIGN KEY ("tenant_id", "water_account_id") REFERENCES "water_account"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill" ADD CONSTRAINT "bill_tenant_id_settle_account_id_fkey" FOREIGN KEY ("tenant_id", "settle_account_id") REFERENCES "settle_account"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_item" ADD CONSTRAINT "bill_item_tenant_id_bill_id_fkey" FOREIGN KEY ("tenant_id", "bill_id") REFERENCES "bill"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_alloc" ADD CONSTRAINT "payment_alloc_tenant_id_payment_id_fkey" FOREIGN KEY ("tenant_id", "payment_id") REFERENCES "payment"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_alloc" ADD CONSTRAINT "payment_alloc_tenant_id_bill_id_fkey" FOREIGN KEY ("tenant_id", "bill_id") REFERENCES "bill"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Hardening additions (manual)
-- ===========================================================================

-- audit_log is append-only: ws_app may INSERT/SELECT but never mutate rows.
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_log" FROM ws_app;

-- sys_sequence: replace the plain unique index with NULLS NOT DISTINCT so a
-- NULL period (non-periodic sequences) can't fork sequence values.
DROP INDEX "sys_sequence_tenant_id_seq_key_period_key";
CREATE UNIQUE INDEX "sys_sequence_tenant_id_seq_key_period_key"
  ON "sys_sequence" ("tenant_id", "seq_key", "period") NULLS NOT DISTINCT;
