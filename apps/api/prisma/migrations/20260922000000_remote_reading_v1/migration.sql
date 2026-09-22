-- E5 Remote Reading V1 — schema foundation (T1).
-- RemoteSource / RemoteDevice / RemoteDeviceBinding / RawRemoteEvent /
-- RemoteEventProcessLog, MeterInstallation location columns,
-- MeterReading.sourceEventId + nullable operator_id.
-- See docs/product-map/E5_REMOTE_READING_DOMAIN_DESIGN.md.

-- ============ 1. generated column/table diff ============

-- CreateEnum
CREATE TYPE "RemoteSourceType" AS ENUM ('FILE_IMPORT', 'API_PULL', 'WEBHOOK');

-- CreateEnum
CREATE TYPE "RemoteSourceStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "RemoteDeviceStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "RemoteEventStatus" AS ENUM ('RECEIVED', 'UNBOUND', 'WAITING_PLAN', 'FAILED', 'CONFLICT', 'CONVERTED', 'IGNORED');

-- CreateEnum
CREATE TYPE "RemoteEventActorType" AS ENUM ('SYSTEM', 'USER');

-- CreateEnum
CREATE TYPE "CoordinateSystem" AS ENUM ('WGS84', 'GCJ02', 'BD09');

-- CreateEnum
CREATE TYPE "LocationSource" AS ENUM ('MANUAL', 'GPS', 'IMPORT');

-- AlterTable
ALTER TABLE "meter_installation" ADD COLUMN     "coordinate_system" "CoordinateSystem",
ADD COLUMN     "latitude" DECIMAL(9,6),
ADD COLUMN     "location_remark" TEXT,
ADD COLUMN     "location_source" "LocationSource",
ADD COLUMN     "longitude" DECIMAL(10,6);

-- AlterTable
ALTER TABLE "meter_reading" ADD COLUMN     "source_event_id" UUID,
ALTER COLUMN "operator_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "remote_source" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "RemoteSourceType" NOT NULL,
    "adapter_key" TEXT NOT NULL,
    "status" "RemoteSourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "timezone" TEXT NOT NULL,
    "config" JSONB,
    "credential_ref" TEXT,
    "org_unit_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "remote_source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "remote_device" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "remote_source_id" UUID NOT NULL,
    "vendor_device_key" TEXT NOT NULL,
    "vendor_meter_no" TEXT,
    "communication_id" TEXT,
    "model" TEXT,
    "status" "RemoteDeviceStatus" NOT NULL DEFAULT 'ACTIVE',
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "remote_device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "remote_device_binding" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "remote_source_id" UUID NOT NULL,
    "remote_device_id" UUID NOT NULL,
    "installation_id" UUID NOT NULL,
    "effective_from" TIMESTAMPTZ NOT NULL,
    "effective_to" TIMESTAMPTZ,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "remote_device_binding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raw_remote_event" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "remote_source_id" UUID NOT NULL,
    "external_event_key" TEXT NOT NULL,
    "canonical_payload_hash" TEXT NOT NULL,
    "vendor_device_key" TEXT NOT NULL,
    "business_period" CHAR(6) NOT NULL,
    "collected_at" TIMESTAMPTZ NOT NULL,
    "reading_value" DECIMAL(18,4) NOT NULL,
    "vendor_quality" TEXT,
    "raw_payload" JSONB NOT NULL,
    "canonical_payload" JSONB NOT NULL,
    "processing_status" "RemoteEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "resolved_remote_device_id" UUID,
    "resolved_binding_id" UUID,
    "current_issue_code" TEXT,
    "current_issue_at" TIMESTAMPTZ,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "raw_remote_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "remote_event_process_log" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "remote_event_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "from_status" "RemoteEventStatus",
    "to_status" "RemoteEventStatus",
    "code" TEXT,
    "message" TEXT,
    "actor_type" "RemoteEventActorType" NOT NULL,
    "actor_staff_id" UUID,
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "remote_event_process_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "remote_source_tenant_id_code_key" ON "remote_source"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "remote_source_tenant_id_id_key" ON "remote_source"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "remote_device_tenant_id_remote_source_id_vendor_device_key_key" ON "remote_device"("tenant_id", "remote_source_id", "vendor_device_key");

-- CreateIndex
CREATE UNIQUE INDEX "remote_device_tenant_id_remote_source_id_id_key" ON "remote_device"("tenant_id", "remote_source_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "remote_device_tenant_id_id_key" ON "remote_device"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "remote_device_binding_tenant_id_remote_device_id_effective__idx" ON "remote_device_binding"("tenant_id", "remote_device_id", "effective_from");

-- CreateIndex
CREATE INDEX "remote_device_binding_tenant_id_installation_id_idx" ON "remote_device_binding"("tenant_id", "installation_id");

-- CreateIndex
CREATE UNIQUE INDEX "remote_device_binding_tenant_id_id_key" ON "remote_device_binding"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "raw_remote_event_tenant_id_processing_status_idx" ON "raw_remote_event"("tenant_id", "processing_status");

-- CreateIndex
CREATE INDEX "raw_remote_event_tenant_id_business_period_idx" ON "raw_remote_event"("tenant_id", "business_period");

-- CreateIndex
CREATE UNIQUE INDEX "raw_remote_event_tenant_id_remote_source_id_external_event__key" ON "raw_remote_event"("tenant_id", "remote_source_id", "external_event_key");

-- CreateIndex
CREATE UNIQUE INDEX "raw_remote_event_tenant_id_id_key" ON "raw_remote_event"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "remote_event_process_log_tenant_id_remote_event_id_idx" ON "remote_event_process_log"("tenant_id", "remote_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "meter_reading_tenant_id_source_event_id_key" ON "meter_reading"("tenant_id", "source_event_id");

-- AddForeignKey
ALTER TABLE "meter_reading" ADD CONSTRAINT "meter_reading_tenant_id_source_event_id_fkey" FOREIGN KEY ("tenant_id", "source_event_id") REFERENCES "raw_remote_event"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remote_source" ADD CONSTRAINT "remote_source_tenant_id_org_unit_id_fkey" FOREIGN KEY ("tenant_id", "org_unit_id") REFERENCES "org_unit"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remote_device" ADD CONSTRAINT "remote_device_tenant_id_remote_source_id_fkey" FOREIGN KEY ("tenant_id", "remote_source_id") REFERENCES "remote_source"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remote_device_binding" ADD CONSTRAINT "remote_device_binding_tenant_id_remote_source_id_fkey" FOREIGN KEY ("tenant_id", "remote_source_id") REFERENCES "remote_source"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remote_device_binding" ADD CONSTRAINT "remote_device_binding_tenant_id_remote_source_id_remote_de_fkey" FOREIGN KEY ("tenant_id", "remote_source_id", "remote_device_id") REFERENCES "remote_device"("tenant_id", "remote_source_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remote_device_binding" ADD CONSTRAINT "remote_device_binding_tenant_id_installation_id_fkey" FOREIGN KEY ("tenant_id", "installation_id") REFERENCES "meter_installation"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_remote_event" ADD CONSTRAINT "raw_remote_event_tenant_id_remote_source_id_fkey" FOREIGN KEY ("tenant_id", "remote_source_id") REFERENCES "remote_source"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remote_event_process_log" ADD CONSTRAINT "remote_event_process_log_tenant_id_remote_event_id_fkey" FOREIGN KEY ("tenant_id", "remote_event_id") REFERENCES "raw_remote_event"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============ 2. DB invariants (manual hardening — not expressible in Prisma) ============

-- exclusion constraints need btree_gist operator classes for uuid/text keys.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 2a. Binding time ranges: half-open [from, to); the same device can never be
-- bound to two installations at once, and the same installation can never be
-- served by two devices of the same source at once. effective_to NULL = ∞.
ALTER TABLE "remote_device_binding" ADD CONSTRAINT "remote_device_binding_device_range_excl"
  EXCLUDE USING gist (
    "tenant_id" WITH =,
    "remote_source_id" WITH =,
    "remote_device_id" WITH =,
    tstzrange("effective_from", "effective_to", '[)') WITH &&
  );

ALTER TABLE "remote_device_binding" ADD CONSTRAINT "remote_device_binding_installation_range_excl"
  EXCLUDE USING gist (
    "tenant_id" WITH =,
    "remote_source_id" WITH =,
    "installation_id" WITH =,
    tstzrange("effective_from", "effective_to", '[)') WITH &&
  );

-- An empty or inverted range is meaningless even without overlap.
ALTER TABLE "remote_device_binding" ADD CONSTRAINT "remote_device_binding_range_chk"
  CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from");

-- 2b. Install-point location is all-or-nothing: coordinates without a
-- coordinate system are worse than none (WGS84/GCJ02/BD09 differ by 100s of m).
ALTER TABLE "meter_installation" ADD CONSTRAINT "meter_installation_location_chk"
  CHECK (
    ("latitude" IS NULL AND "longitude" IS NULL AND "coordinate_system" IS NULL)
    OR ("latitude" IS NOT NULL AND "longitude" IS NOT NULL AND "coordinate_system" IS NOT NULL)
  );

-- 2c. MeterReading: source_event_id marks an adapter-produced REMOTE reading;
-- only such readings may omit the human operator. Human entry (WEB/IMPORT/APP)
-- and manual REMOTE readings always require operator_id.
ALTER TABLE "meter_reading" ADD CONSTRAINT "meter_reading_source_event_remote_chk"
  CHECK ("source_event_id" IS NULL OR ("result_type" = 'REMOTE' AND "source" = 'REMOTE'));

ALTER TABLE "meter_reading" ADD CONSTRAINT "meter_reading_operator_chk"
  CHECK (
    "operator_id" IS NOT NULL
    OR ("source_event_id" IS NOT NULL AND "result_type" = 'REMOTE' AND "source" = 'REMOTE')
  );

-- 2d. RawRemoteEvent identity + payloads are immutable; only the processing
-- columns may change. Enforced by trigger so no application path (including
-- ad-hoc SQL as ws_app) can rewrite a raw fact.
CREATE OR REPLACE FUNCTION "raw_remote_event_immutable"() RETURNS trigger AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."remote_source_id" IS DISTINCT FROM OLD."remote_source_id"
     OR NEW."external_event_key" IS DISTINCT FROM OLD."external_event_key"
     OR NEW."canonical_payload_hash" IS DISTINCT FROM OLD."canonical_payload_hash"
     OR NEW."vendor_device_key" IS DISTINCT FROM OLD."vendor_device_key"
     OR NEW."business_period" IS DISTINCT FROM OLD."business_period"
     OR NEW."collected_at" IS DISTINCT FROM OLD."collected_at"
     OR NEW."reading_value" IS DISTINCT FROM OLD."reading_value"
     OR NEW."raw_payload" IS DISTINCT FROM OLD."raw_payload"
     OR NEW."canonical_payload" IS DISTINCT FROM OLD."canonical_payload"
     OR NEW."received_at" IS DISTINCT FROM OLD."received_at" THEN
    RAISE EXCEPTION 'RAW_REMOTE_EVENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "raw_remote_event_immutable"
  BEFORE UPDATE ON "raw_remote_event"
  FOR EACH ROW EXECUTE FUNCTION "raw_remote_event_immutable"();

-- ============ 3. RLS on the new tenant-scoped tables ============

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'remote_source','remote_device','remote_device_binding',
    'raw_remote_event','remote_event_process_log'
  ] LOOP
    EXECUTE format('ALTER TABLE %I OWNER TO ws_owner;', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid);', t);
  END LOOP;
END $$;

-- remote_event_process_log is append-only like audit_log: ws_app may
-- INSERT/SELECT but never mutate rows.
REVOKE UPDATE, DELETE, TRUNCATE ON "remote_event_process_log" FROM ws_app;
