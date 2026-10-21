-- 20261021 整改 任务C：总分表（总表挂分表）。
-- meter.meter_role: NORMAL普通/MASTER总表/SUB分表/CHECK考核表(监控表归入此枚举)
ALTER TABLE meter ADD COLUMN meter_role text NOT NULL DEFAULT 'NORMAL';
COMMENT ON COLUMN meter.meter_role IS 'NORMAL普通/MASTER总表/SUB分表/CHECK考核表';

-- 总分表关系：主表-分表一对多 + 计费模式（MASTER=按总表计费/SUB=按分表计费）
CREATE TABLE meter_relation (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  master_meter_id  uuid NOT NULL,
  sub_meter_id     uuid NOT NULL,
  billing_mode     text NOT NULL DEFAULT 'SUB',
  effective_date   date NOT NULL,
  expired_date     date,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid,
  CONSTRAINT meter_relation_master_fk
    FOREIGN KEY (tenant_id, master_meter_id) REFERENCES meter (tenant_id, id),
  CONSTRAINT meter_relation_sub_fk
    FOREIGN KEY (tenant_id, sub_meter_id) REFERENCES meter (tenant_id, id),
  CONSTRAINT meter_relation_not_self CHECK (master_meter_id <> sub_meter_id),
  CONSTRAINT meter_relation_mode_chk CHECK (billing_mode IN ('MASTER','SUB'))
);
CREATE UNIQUE INDEX meter_relation_tenant_id_key ON meter_relation (tenant_id, id);
CREATE UNIQUE INDEX meter_relation_sub_live ON meter_relation (tenant_id, sub_meter_id)
  WHERE expired_date IS NULL;
CREATE INDEX meter_relation_master ON meter_relation (tenant_id, master_meter_id);
ALTER TABLE meter_relation ENABLE ROW LEVEL SECURITY;
ALTER TABLE meter_relation FORCE ROW LEVEL SECURITY;
CREATE POLICY meter_relation_tenant ON meter_relation
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
