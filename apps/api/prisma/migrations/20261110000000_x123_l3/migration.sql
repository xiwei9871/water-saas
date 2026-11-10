-- 1109 v3：L3 远传区号标识 / X1 外部回推+X2 双合同+X7 状态历史 / X3 估抄修订留痕
ALTER TABLE reader_zone ADD COLUMN IF NOT EXISTS is_remote BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE install_application
  ADD COLUMN IF NOT EXISTS external_source TEXT,
  ADD COLUMN IF NOT EXISTS external_order_no TEXT,
  ADD COLUMN IF NOT EXISTS external_pushed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS external_payload JSONB,
  ADD COLUMN IF NOT EXISTS external_confirmed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS construction_contract_no TEXT,
  ADD COLUMN IF NOT EXISTS construction_contract_scan JSONB,
  ADD COLUMN IF NOT EXISTS supply_contract_no TEXT,
  ADD COLUMN IF NOT EXISTS supply_contract_scan JSONB,
  ADD COLUMN IF NOT EXISTS status_history JSONB;
ALTER TABLE meter_reading ADD COLUMN IF NOT EXISTS revision_log JSONB;
ALTER TABLE service_order ADD COLUMN IF NOT EXISTS external_dispatch BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS external_order_no TEXT,
  ADD COLUMN IF NOT EXISTS external_payload JSONB,
  ADD COLUMN IF NOT EXISTS status_history JSONB;
