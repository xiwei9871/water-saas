-- E5 T1 Schema/DB Gate fixes — three blockers from review:
--   1. resolved_* columns were plain UUIDs: add tenant-scoped FKs so an
--      event can never point at a device/binding outside its tenant or at
--      a nonexistent row.
--   2. Frozen invariant "no plan-less remote reading" had no DB guard:
--      source_event_id IS NOT NULL → plan_item_id IS NOT NULL.
--   3. raw_remote_event_immutable forgot created_at/created_by — audit
--      columns were silently mutable.

-- AddForeignKey
ALTER TABLE "raw_remote_event" ADD CONSTRAINT "raw_remote_event_tenant_id_resolved_remote_device_id_fkey" FOREIGN KEY ("tenant_id", "resolved_remote_device_id") REFERENCES "remote_device"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_remote_event" ADD CONSTRAINT "raw_remote_event_tenant_id_resolved_binding_id_fkey" FOREIGN KEY ("tenant_id", "resolved_binding_id") REFERENCES "remote_device_binding"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Frozen invariant (Domain Design §16/§18): an adapter-produced reading is
-- always bound to a ReadingPlanItem — plan-less readings would bypass both
-- plan progress and book.orgUnit scope checks.
ALTER TABLE "meter_reading" ADD CONSTRAINT "meter_reading_source_event_plan_chk"
  CHECK ("source_event_id" IS NULL OR "plan_item_id" IS NOT NULL);

-- Re-create the immutable trigger with created_* included: the audit chain
-- of a raw fact must be as untouchable as the fact itself.
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
     OR NEW."received_at" IS DISTINCT FROM OLD."received_at"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR NEW."created_by" IS DISTINCT FROM OLD."created_by" THEN
    RAISE EXCEPTION 'RAW_REMOTE_EVENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
