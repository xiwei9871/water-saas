-- 批5 P2：合同扫描件 + 编号规则配置（20261022 修订建议 2.4/V6）。
ALTER TABLE "install_application" ADD COLUMN "contract_scan" jsonb;

CREATE TABLE "doc_no_rule" (
  "id"          uuid        NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"   uuid        NOT NULL,
  "seq_key"     varchar(40) NOT NULL,
  "label"       varchar(60) NOT NULL,
  "prefix"      varchar(8)  NOT NULL,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_by"  uuid,
  CONSTRAINT "doc_no_rule_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "doc_no_rule_tenant_key" UNIQUE ("tenant_id", "seq_key")
);

ALTER TABLE "doc_no_rule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "doc_no_rule" FORCE ROW LEVEL SECURITY;

CREATE POLICY doc_no_rule_tenant ON "doc_no_rule"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
