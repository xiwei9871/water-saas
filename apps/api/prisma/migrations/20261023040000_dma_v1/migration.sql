-- 20261023 C1/C2：DMA 独立计量分区（仅水量监控，不含水费）。

CREATE TABLE "dma_zone" (
  "id"          uuid         NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"   uuid         NOT NULL,
  "code"        varchar(40)  NOT NULL,
  "name"        varchar(80)  NOT NULL,
  "region"      varchar(120),
  "org_unit_id" uuid,
  "status"      varchar(16)  NOT NULL DEFAULT 'ACTIVE',
  "created_at"  timestamptz  NOT NULL DEFAULT now(),
  "created_by"  uuid,
  "updated_at"  timestamptz  NOT NULL DEFAULT now(),
  "updated_by"  uuid,
  CONSTRAINT "dma_zone_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "dma_zone_tenant_code_key" UNIQUE ("tenant_id", "code"),
  CONSTRAINT "dma_zone_status_chk" CHECK ("status" IN ('ACTIVE', 'DISABLED'))
);
CREATE UNIQUE INDEX "dma_zone_tenant_id_key" ON "dma_zone"("tenant_id", "id");
CREATE INDEX "dma_zone_tenant_status_idx" ON "dma_zone"("tenant_id", "status");

CREATE TABLE "dma_check_meter" (
  "id"             uuid         NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"      uuid         NOT NULL,
  "dma_id"         uuid         NOT NULL,
  "meter_id"       uuid         NOT NULL,
  "effective_from" timestamptz  NOT NULL,
  "effective_to"   timestamptz,
  "created_at"     timestamptz  NOT NULL DEFAULT now(),
  "created_by"     uuid,
  "updated_at"     timestamptz  NOT NULL DEFAULT now(),
  "updated_by"     uuid,
  CONSTRAINT "dma_check_meter_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "dma_check_meter_tenant_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "dma_check_meter_dma_meter_from_key" UNIQUE ("dma_id", "meter_id", "effective_from")
);
CREATE INDEX "dma_check_meter_tenant_dma_idx" ON "dma_check_meter"("tenant_id", "dma_id");
CREATE INDEX "dma_check_meter_tenant_meter_idx" ON "dma_check_meter"("tenant_id", "meter_id");
ALTER TABLE "dma_check_meter"
  ADD CONSTRAINT "dma_check_meter_dma_fkey"
  FOREIGN KEY ("tenant_id", "dma_id") REFERENCES "dma_zone"("tenant_id", "id") ON DELETE RESTRICT;

CREATE TABLE "dma_meter_link" (
  "id"             uuid         NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"      uuid         NOT NULL,
  "check_meter_id" uuid         NOT NULL,
  "meter_id"       uuid         NOT NULL,
  "effective_from" timestamptz  NOT NULL,
  "effective_to"   timestamptz,
  "created_at"     timestamptz  NOT NULL DEFAULT now(),
  "created_by"     uuid,
  "updated_at"     timestamptz  NOT NULL DEFAULT now(),
  "updated_by"     uuid,
  CONSTRAINT "dma_meter_link_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "dma_meter_link_tenant_id_key" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "dma_meter_link_chk_meter_from_key" UNIQUE ("check_meter_id", "meter_id", "effective_from")
);
CREATE INDEX "dma_meter_link_tenant_chk_idx" ON "dma_meter_link"("tenant_id", "check_meter_id");
CREATE INDEX "dma_meter_link_tenant_meter_idx" ON "dma_meter_link"("tenant_id", "meter_id");
ALTER TABLE "dma_meter_link"
  ADD CONSTRAINT "dma_meter_link_chk_fkey"
  FOREIGN KEY ("tenant_id", "check_meter_id") REFERENCES "dma_check_meter"("tenant_id", "id") ON DELETE RESTRICT;

ALTER TABLE "dma_zone" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dma_zone" FORCE ROW LEVEL SECURITY;
ALTER TABLE "dma_check_meter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dma_check_meter" FORCE ROW LEVEL SECURITY;
ALTER TABLE "dma_meter_link" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dma_meter_link" FORCE ROW LEVEL SECURITY;

CREATE POLICY dma_zone_tenant ON "dma_zone"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY dma_check_meter_tenant ON "dma_check_meter"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY dma_meter_link_tenant ON "dma_meter_link"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
