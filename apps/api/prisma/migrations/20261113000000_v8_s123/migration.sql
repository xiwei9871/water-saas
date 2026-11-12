-- 1112v8 S2/S3：完工凭证+防覆盖+订阅+外部调用留痕
ALTER TABLE install_application
  ADD COLUMN IF NOT EXISTS install_proof_file_refs JSONB,
  ADD COLUMN IF NOT EXISTS field_overrides JSONB;
CREATE TABLE IF NOT EXISTS webhook_subscription (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL, url TEXT NOT NULL,
  event_types JSONB NOT NULL, secret TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID, updated_at TIMESTAMPTZ, updated_by UUID
);
CREATE TABLE IF NOT EXISTS external_call (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL, direction TEXT NOT NULL,
  biz_type TEXT NOT NULL, biz_id UUID, endpoint TEXT,
  payload JSONB, result TEXT, skipped_fields JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS external_call_biz_idx ON external_call (tenant_id, biz_type, biz_id);
-- S2 存量迁移：已登记装表信息的 INSTALLING 申请 → WAITING_NUMBER
UPDATE install_application SET status = 'WAITING_NUMBER', updated_at = now()
WHERE status = 'INSTALLING' AND install_meters IS NOT NULL;
