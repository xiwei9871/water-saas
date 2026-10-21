-- 20261021 整改 任务E：违章用水处理。
-- 两入口：稽查人员登记(INSPECT) + 抄表员上报疑似违章(READING, status 待核实)。
CREATE TABLE water_violation (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  water_account_id uuid NOT NULL,
  violation_type   text NOT NULL,
  reporter_id      uuid,
  occurred_date    date,
  description      text,
  photo_refs       jsonb,
  status           text NOT NULL DEFAULT 'PENDING_REVIEW',
  source_type      text NOT NULL DEFAULT 'INSPECT'
                   CHECK (source_type IN ('INSPECT','READING')),
  source_id        uuid,
  penalty_amount   numeric(18,2),
  backbill_amount  numeric(18,2),
  processor_id     uuid,
  processed_at     timestamptz,
  process_note     text,
  evidence         jsonb,
  task_id          uuid,
  service_order_id uuid,
  archived_by      uuid,
  archived_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid,
  CONSTRAINT violation_account_fk
    FOREIGN KEY (tenant_id, water_account_id) REFERENCES water_account (tenant_id, id),
  CONSTRAINT violation_status_chk CHECK (status IN
    ('PENDING_REVIEW','PROCESSING','PROCESSED','ARCHIVED','DISMISSED'))
);
CREATE UNIQUE INDEX water_violation_tenant_id_key ON water_violation (tenant_id, id);
CREATE INDEX water_violation_account ON water_violation (tenant_id, water_account_id);
CREATE INDEX water_violation_status ON water_violation (tenant_id, status);
ALTER TABLE water_violation ENABLE ROW LEVEL SECURITY;
CREATE POLICY water_violation_tenant ON water_violation
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

-- 违章类型字典（可配置/停用/扩展）
INSERT INTO sys_dict (id, tenant_id, category, code, name, seq, status, created_at, updated_at)
SELECT gen_random_uuid(), t.id, 'VIOLATION_TYPE', c.code, c.name, c.seq, 'ACTIVE', now(), now()
FROM tenant t
CROSS JOIN (VALUES
  ('THEFT',           '盗窃用水',       10),
  ('PRIVATE_CONN',    '私自接水',       20),
  ('TAMPER',          '破坏表计',       30),
  ('SEAL_BROKEN',     '破坏铅封',       40),
  ('CATEGORY_MISUSE', '擅自改变用水性质', 50)
) AS c(code, name, seq)
ON CONFLICT DO NOTHING;

-- 违章处置任务类型（→ metering:service 稽查岗）
INSERT INTO sys_dict (id, tenant_id, category, code, name, value, seq, status, created_at, updated_at)
SELECT gen_random_uuid(), t.id, 'TASK_TYPE_PERM', 'VIOLATION_HANDLE', '违章处置',
       '{"perm":"metering:service","dueDays":3,"priority":"HIGH"}'::jsonb, 90, 'ACTIVE', now(), now()
FROM tenant t
ON CONFLICT DO NOTHING;
