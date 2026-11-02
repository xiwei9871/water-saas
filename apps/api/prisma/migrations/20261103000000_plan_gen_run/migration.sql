-- R5 自动抄表计划运行记录（Stage2 A1）
CREATE TABLE "plan_gen_run" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "run_date" date NOT NULL,
  "plan_date" date,
  "seg_no" varchar(2),
  "status" varchar(12) NOT NULL DEFAULT 'OK',
  "generated" int NOT NULL DEFAULT 0,
  "error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "plan_gen_run_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "plan_gen_run_tenant_run_date_idx" ON "plan_gen_run"("tenant_id", "run_date");

ALTER TABLE "plan_gen_run" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plan_gen_run" FORCE ROW LEVEL SECURITY;
CREATE POLICY plan_gen_run_tenant ON "plan_gen_run"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
