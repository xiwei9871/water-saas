-- E5 Release Review fixes — DB layer:
--   1. raw_remote_event_immutable becomes a true WHITELIST: only the seven
--      processing columns may change; every current and future column is
--      immutable by default (jsonb diff instead of a column blacklist).
--   2. resolved_* provenance now proves the SAME remote_source — and the
--      resolved binding must belong to the resolved device — via composite
--      foreign keys (replacing the tenant-only FKs from the T1 fix).

CREATE OR REPLACE FUNCTION "raw_remote_event_immutable"() RETURNS trigger AS $$
BEGIN
  IF to_jsonb(OLD) - ARRAY[
       'processing_status', 'resolved_remote_device_id', 'resolved_binding_id',
       'current_issue_code', 'current_issue_at', 'updated_at', 'updated_by'
     ]::text[]
     IS DISTINCT FROM
     to_jsonb(NEW) - ARRAY[
       'processing_status', 'resolved_remote_device_id', 'resolved_binding_id',
       'current_issue_code', 'current_issue_at', 'updated_at', 'updated_by'
     ]::text[]
  THEN
    RAISE EXCEPTION 'RAW_REMOTE_EVENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE "raw_remote_event"
  DROP CONSTRAINT "raw_remote_event_tenant_id_resolved_remote_device_id_fkey",
  DROP CONSTRAINT "raw_remote_event_tenant_id_resolved_binding_id_fkey";

-- Target for the 4-column provenance FK: a binding is uniquely identified
-- by (tenant, source, device, id) — the event's resolved pair must agree
-- on all three shared dimensions.
ALTER TABLE "remote_device_binding" ADD CONSTRAINT
  "remote_device_binding_tenant_source_device_id_key"
  UNIQUE ("tenant_id", "remote_source_id", "remote_device_id", "id");

ALTER TABLE "raw_remote_event" ADD CONSTRAINT
  "raw_remote_event_resolved_device_fkey"
  FOREIGN KEY ("tenant_id", "remote_source_id", "resolved_remote_device_id")
  REFERENCES "remote_device" ("tenant_id", "remote_source_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "raw_remote_event" ADD CONSTRAINT
  "raw_remote_event_resolved_binding_fkey"
  FOREIGN KEY ("tenant_id", "remote_source_id", "resolved_remote_device_id", "resolved_binding_id")
  REFERENCES "remote_device_binding" ("tenant_id", "remote_source_id", "remote_device_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- MATCH SIMPLE skips FK validation when any referencing column is NULL,
-- so a binding could be set while the device stays NULL and provenance
-- would silently disagree. A resolved binding always implies a resolved
-- device (the processor sets them together) — enforce that pairing.
ALTER TABLE "raw_remote_event" ADD CONSTRAINT
  "raw_remote_event_resolved_binding_requires_device"
  CHECK ("resolved_binding_id" IS NULL OR "resolved_remote_device_id" IS NOT NULL);

-- Frozen rule: raw remote facts are append-only. The immutable UPDATE
-- trigger above protects identity/payload columns, but ws_app still held
-- DELETE+TRUNCATE via the blanket init grant. Revoke both — UPDATE stays
-- granted because processing metadata legitimately evolves.
REVOKE DELETE, TRUNCATE ON "raw_remote_event" FROM ws_app;
