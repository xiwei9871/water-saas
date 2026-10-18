-- 员工个人偏好（H2 驾驶舱个人视图等 per-staff JSON 配置）。
CREATE TABLE staff_pref (
  tenant_id   uuid        NOT NULL,
  staff_id    uuid        NOT NULL,
  key         text        NOT NULL,
  value       jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid,
  CONSTRAINT staff_pref_pkey PRIMARY KEY (tenant_id, staff_id, key),
  CONSTRAINT staff_pref_staff_fkey FOREIGN KEY (tenant_id, staff_id)
    REFERENCES staff (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE staff_pref OWNER TO ws_app;
ALTER TABLE staff_pref ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_pref FORCE ROW LEVEL SECURITY;
CREATE POLICY staff_pref_tenant ON staff_pref
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
