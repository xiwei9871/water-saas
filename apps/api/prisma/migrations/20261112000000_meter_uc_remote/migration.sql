-- 1111v6 P0-1：meter 表字段持久化（假成功根因）
ALTER TABLE meter ADD COLUMN IF NOT EXISTS usage_category TEXT;
ALTER TABLE meter ADD COLUMN IF NOT EXISTS is_remote BOOLEAN NOT NULL DEFAULT false;

-- 1111v6 P1-4：待放号状态
ALTER TYPE "InstallApplyStatus" ADD VALUE IF NOT EXISTS 'WAITING_NUMBER';

-- 1111v6 P0-2：合同实体
CREATE TABLE IF NOT EXISTS contract (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  apply_no TEXT,
  water_account_id UUID,
  contract_type TEXT NOT NULL,
  contract_no TEXT NOT NULL,
  file_refs JSONB,
  signed_at DATE,
  remark TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID,
  updated_at TIMESTAMPTZ,
  updated_by UUID,
  UNIQUE (tenant_id, contract_no)
);
CREATE INDEX IF NOT EXISTS contract_apply_no_idx ON contract (tenant_id, apply_no);
CREATE INDEX IF NOT EXISTS contract_wa_idx ON contract (tenant_id, water_account_id);

-- N4：权限中文名
ALTER TABLE permission ADD COLUMN IF NOT EXISTS name TEXT;
UPDATE permission SET name='客户查询' WHERE code='customer:read';
UPDATE permission SET name='客户维护' WHERE code='customer:write';
UPDATE permission SET name='抄表查询' WHERE code='metering:read';
UPDATE permission SET name='抄表录入' WHERE code='metering:write';
UPDATE permission SET name='抄表质检' WHERE code='metering:qc';
UPDATE permission SET name='远传管理' WHERE code='metering:remote:manage';
UPDATE permission SET name='表务工单' WHERE code='metering:service';
UPDATE permission SET name='计费查询' WHERE code='billing:read';
UPDATE permission SET name='计费开账' WHERE code='billing:write';
UPDATE permission SET name='收费查询' WHERE code='payment:read';
UPDATE permission SET name='收费操作' WHERE code='payment:write';
UPDATE permission SET name='预存冲正' WHERE code='prepayment:reverse';
UPDATE permission SET name='报装查询' WHERE code='install:read';
UPDATE permission SET name='报装办理' WHERE code='install:write';
UPDATE permission SET name='系统查询' WHERE code='iam:read';
UPDATE permission SET name='系统管理' WHERE code='iam:write';
UPDATE permission SET name='报表查询' WHERE code='report:read';
UPDATE permission SET name='异常查看' WHERE code='exception:read';
UPDATE permission SET name='异常处理' WHERE code='exception:manage';
