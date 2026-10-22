-- 20261020 核查整改：水表检定周期属性 + 工单来源/片区锚点
ALTER TABLE "meter" ADD COLUMN "check_period_years" INT;
ALTER TABLE "meter" ADD COLUMN "last_check_date" DATE;
ALTER TABLE "meter_service_order" ADD COLUMN "source_type" TEXT NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "meter_service_order" ADD COLUMN "source_reading_id" UUID;
ALTER TABLE "meter_service_order" ADD COLUMN "org_unit_id" UUID;
CREATE INDEX "meter_service_order_org_idx" ON "meter_service_order"("tenant_id", "org_unit_id", "created_at");
CREATE INDEX "meter_check_due_idx" ON "meter"("tenant_id", "last_check_date") WHERE "last_check_date" IS NOT NULL;
