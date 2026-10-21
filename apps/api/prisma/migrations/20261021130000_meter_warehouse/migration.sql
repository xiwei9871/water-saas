-- 20261021 整改 任务D：水表库房全生命周期。
-- 状态扩展：在库 AVAILABLE / 在途 IN_TRANSIT / 已领用 ISSUED / 在用 INSTALLED / 已报废 RETIRED
ALTER TYPE "MeterStatus" ADD VALUE IF NOT EXISTS 'ISSUED';
ALTER TYPE "MeterStatus" ADD VALUE IF NOT EXISTS 'IN_TRANSIT';
ALTER TABLE meter ADD COLUMN warehouse_id uuid;
ALTER TABLE meter ADD COLUMN location_id  uuid;
COMMENT ON COLUMN meter.warehouse_id IS '当前所在库房（在库时）；领用/安装后清空';
COMMENT ON COLUMN meter.location_id  IS '当前所在货位（在库时）';

-- 库房
CREATE TABLE meter_warehouse (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  code       text NOT NULL,
  name       text NOT NULL,
  owner      text,
  status     text NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT meter_warehouse_code_key UNIQUE (tenant_id, code)
);
CREATE UNIQUE INDEX meter_warehouse_tenant_id_key ON meter_warehouse (tenant_id, id);
ALTER TABLE meter_warehouse ENABLE ROW LEVEL SECURITY;
CREATE POLICY meter_warehouse_tenant ON meter_warehouse
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

-- 货位
CREATE TABLE meter_warehouse_location (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  warehouse_id uuid NOT NULL,
  code         text NOT NULL,
  name         text NOT NULL,
  status       text NOT NULL DEFAULT 'ACTIVE',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meter_location_wh_fk
    FOREIGN KEY (tenant_id, warehouse_id) REFERENCES meter_warehouse (tenant_id, id),
  CONSTRAINT meter_location_code_key UNIQUE (tenant_id, warehouse_id, code)
);
CREATE UNIQUE INDEX meter_location_tenant_id_key ON meter_warehouse_location (tenant_id, id);
ALTER TABLE meter_warehouse_location ENABLE ROW LEVEL SECURITY;
CREATE POLICY meter_location_tenant ON meter_warehouse_location
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

-- 出入库流水（水表全生命周期追溯）
CREATE TABLE meter_stock_movement (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  meter_id      uuid NOT NULL,
  movement_type text NOT NULL CHECK (movement_type IN
    ('PURCHASE_IN','ISSUE_OUT','RETURN_IN','SCRAP_OUT','TRANSFER')),
  doc_no        text,          -- 单据号（采购单/领用单/退库单号）
  supplier      text,          -- 采购入库供应商
  batch_no      text,          -- 采购批次号
  warehouse_id  uuid,          -- 目标库房（入库类）；出库类记来源库房
  location_id   uuid,
  operator_id   uuid,          -- 经办人
  moved_at      timestamptz NOT NULL DEFAULT now(),
  remark        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meter_movement_meter_fk
    FOREIGN KEY (tenant_id, meter_id) REFERENCES meter (tenant_id, id)
);
CREATE UNIQUE INDEX meter_movement_tenant_id_key ON meter_stock_movement (tenant_id, id);
CREATE INDEX meter_movement_meter ON meter_stock_movement (tenant_id, meter_id, moved_at);
CREATE INDEX meter_movement_doc ON meter_stock_movement (tenant_id, doc_no);
ALTER TABLE meter_stock_movement ENABLE ROW LEVEL SECURITY;
CREATE POLICY meter_movement_tenant ON meter_stock_movement
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
