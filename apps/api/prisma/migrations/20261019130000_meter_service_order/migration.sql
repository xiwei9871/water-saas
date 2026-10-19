-- 表务管理模块（2026-10-19 需求 T1-T4）：统一表务处置工单 + SERVICE_TYPE 字典 + metering:service 权限回填
CREATE TYPE "ServiceOrderStatus" AS ENUM (
  'PENDING_APPROVAL', 'APPROVED', 'DISPATCHED', 'EXECUTED', 'ARCHIVED', 'REJECTED', 'CANCELLED'
);

CREATE TABLE meter_service_order (
  id                    uuid        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id             uuid        NOT NULL,
  order_no              text        NOT NULL,
  water_account_id      uuid        NOT NULL,
  meter_installation_id uuid,
  meter_id              uuid,
  service_type          text        NOT NULL,
  reason                text,
  payload               jsonb,
  status                "ServiceOrderStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
  applicant_id          uuid,
  applied_at            timestamptz NOT NULL DEFAULT now(),
  approver_id           uuid,
  approved_at           timestamptz,
  approval_note         text,
  dispatcher_id         uuid,
  assignee_id           uuid,
  dispatched_at         timestamptz,
  task_id               uuid,
  executed_by           uuid,
  executed_at           timestamptz,
  result_note           text,
  link_ref              jsonb,
  archived_by           uuid,
  archived_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid,
  CONSTRAINT meter_service_order_pkey PRIMARY KEY (id),
  CONSTRAINT meter_service_order_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT meter_service_order_tenant_id_order_no_key UNIQUE (tenant_id, order_no),
  CONSTRAINT meter_service_order_account_fkey FOREIGN KEY (tenant_id, water_account_id)
    REFERENCES water_account (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX meter_service_order_status_idx ON meter_service_order (tenant_id, status);
CREATE INDEX meter_service_order_account_idx ON meter_service_order (tenant_id, water_account_id);
CREATE INDEX meter_service_order_type_idx ON meter_service_order (tenant_id, service_type, created_at);

ALTER TABLE meter_service_order OWNER TO ws_app;
ALTER TABLE meter_service_order ENABLE ROW LEVEL SECURITY;
ALTER TABLE meter_service_order FORCE ROW LEVEL SECURITY;
CREATE POLICY meter_service_order_tenant ON meter_service_order
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

-- 处置类型字典（11 类，sys_dict 可配置/停用/扩展）
INSERT INTO sys_dict (id, tenant_id, category, code, name, seq, status, created_at, updated_at)
SELECT gen_random_uuid(), t.id, 'SERVICE_TYPE', c.code, c.name, c.seq, 'ACTIVE', now(), now()
FROM tenant t
CROSS JOIN (VALUES
  ('PERIODIC_CHECK',        '周期校验',    10),
  ('DISPUTE_CHECK',         '争议检定',    20),
  ('FAULT',                 '水表故障(换表)', 30),
  ('SUSPEND',               '暂停供水(报停)', 40),
  ('STOP',                  '停水',        50),
  ('RESUME',                '复水',        60),
  ('FLOW_LIMIT',            '限流',        70),
  ('FACILITY_MAINTENANCE',  '表位设施维护',  80),
  ('SITE_RECTIFICATION',    '表位整改',    90),
  ('METER_GROUP_CLEANING',  '表组清洁',    100),
  ('CLOSE',                 '销户(拆表销户)', 110)
) AS c(code, name, seq)
ON CONFLICT (tenant_id, category, code) DO NOTHING;

-- metering:service 权限回填所有存量租户（沿用 backfill_permission_codes 模式）
INSERT INTO permission (id, tenant_id, code, type, created_at, updated_at)
SELECT gen_random_uuid(), t.id, 'metering:service', 'ACTION', now(), now()
FROM tenant t
ON CONFLICT (tenant_id, code) DO NOTHING;

-- 绑定到种子默认角色：reader(现场抄表/处置) + reviewer(复核/审批) 可发起处置
INSERT INTO role_permission (tenant_id, role_id, permission_id, created_at, updated_at)
SELECT r.tenant_id, r.id, p.id, now(), now()
FROM role r
JOIN permission p ON p.tenant_id = r.tenant_id AND p.code = 'metering:service'
WHERE r.code IN ('reader', 'reviewer')
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- 检定档案写入 account_event 用的事件类型
ALTER TYPE "AccountEventType" ADD VALUE IF NOT EXISTS 'METER_CHECK';
