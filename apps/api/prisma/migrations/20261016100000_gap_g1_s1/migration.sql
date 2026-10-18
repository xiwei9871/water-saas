-- G1-G5/S1 gap remediation: penalty accrual needs no table (PENALTY bill_item
-- + tenant_param config); new tables below cover channel reconciliation,
-- collection notices, receipt books, invoice registry and install workflow.

CREATE TYPE "ReconMatchStatus" AS ENUM (
  'MATCHED', 'AMOUNT_MISMATCH', 'NOT_FOUND', 'STATUS_MISMATCH'
);

CREATE TYPE "ReceiptBookStatus" AS ENUM ('STOCK', 'ISSUED', 'EXHAUSTED', 'RETIRED');

CREATE TYPE "InvoiceStatus" AS ENUM ('ISSUED', 'VOID');

CREATE TYPE "InstallApplyStatus" AS ENUM (
  'SUBMITTED', 'SURVEYED', 'APPROVED', 'INSTALLING', 'COMPLETED', 'REJECTED', 'CANCELLED'
);

-- G3 渠道对账批次：一次上传一档
CREATE TABLE "channel_recon_batch" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "channel" TEXT NOT NULL,
  "file_name" TEXT,
  "biz_date_from" DATE,
  "biz_date_to" DATE,
  "total_rows" INTEGER NOT NULL DEFAULT 0,
  "matched" INTEGER NOT NULL DEFAULT 0,
  "mismatched" INTEGER NOT NULL DEFAULT 0,
  "missing_in_file" INTEGER NOT NULL DEFAULT 0,
  "task_id" UUID,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "created_by" UUID,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_by" UUID,
  CONSTRAINT "channel_recon_batch_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "channel_recon_batch_tenant_id_key" ON "channel_recon_batch"("tenant_id", "id");
CREATE INDEX "channel_recon_batch_tenant_created_idx" ON "channel_recon_batch"("tenant_id", "created_at");

-- G3 对账明细行：文件行 × 我方收款 的核对结果
CREATE TABLE "channel_recon_row" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "batch_id" UUID NOT NULL,
  "row_no" INTEGER NOT NULL,
  "channel_ref" TEXT NOT NULL,
  "amount" BIGINT NOT NULL,
  "paid_at" TIMESTAMPTZ,
  "match_status" "ReconMatchStatus" NOT NULL,
  "payment_id" UUID,
  "note" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "channel_recon_row_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "channel_recon_row_batch_idx" ON "channel_recon_row"("tenant_id", "batch_id");

-- G4 催缴通知单
CREATE TABLE "collection_notice" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "notice_no" TEXT NOT NULL,
  "water_account_id" UUID NOT NULL,
  "settle_account_id" UUID NOT NULL,
  "period_from" CHAR(6) NOT NULL,
  "period_to" CHAR(6) NOT NULL,
  "amount_due" BIGINT NOT NULL,
  "bill_count" INTEGER NOT NULL,
  "bills" JSONB NOT NULL,
  "print_count" INTEGER NOT NULL DEFAULT 0,
  "last_printed_at" TIMESTAMPTZ,
  "task_id" UUID,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "created_by" UUID,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_by" UUID,
  CONSTRAINT "collection_notice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "collection_notice_tenant_no_key" ON "collection_notice"("tenant_id", "notice_no");
CREATE INDEX "collection_notice_tenant_account_idx" ON "collection_notice"("tenant_id", "water_account_id");

-- G5 收据号段台账
CREATE TABLE "receipt_book" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "book_no" TEXT NOT NULL,
  "prefix" TEXT NOT NULL DEFAULT 'S',
  "range_start" INTEGER NOT NULL,
  "range_end" INTEGER NOT NULL,
  "next_no" INTEGER NOT NULL,
  "status" "ReceiptBookStatus" NOT NULL DEFAULT 'STOCK',
  "issued_to" UUID,
  "issued_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "created_by" UUID,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_by" UUID,
  CONSTRAINT "receipt_book_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "receipt_book_tenant_no_key" ON "receipt_book"("tenant_id", "book_no");
CREATE UNIQUE INDEX "receipt_book_tenant_id_key" ON "receipt_book"("tenant_id", "id");
CREATE INDEX "receipt_book_tenant_issued_idx" ON "receipt_book"("tenant_id", "issued_to", "status");

-- G5 发票登记台账（不接税控，仅登记/作废留痕）
CREATE TABLE "invoice_registry" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "invoice_no" TEXT NOT NULL,
  "water_account_id" UUID,
  "payment_id" UUID,
  "bill_id" UUID,
  "amount" BIGINT NOT NULL,
  "status" "InvoiceStatus" NOT NULL DEFAULT 'ISSUED',
  "remark" TEXT,
  "voided_at" TIMESTAMPTZ,
  "voided_by" UUID,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "created_by" UUID,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_by" UUID,
  CONSTRAINT "invoice_registry_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "invoice_registry_tenant_no_key" ON "invoice_registry"("tenant_id", "invoice_no");
CREATE INDEX "invoice_registry_tenant_account_idx" ON "invoice_registry"("tenant_id", "water_account_id");

-- S1 报装申请（独立于营销主链，归档时调立户向导落库）
CREATE TABLE "install_application" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "apply_no" TEXT NOT NULL,
  "applicant_name" TEXT NOT NULL,
  "cust_type" TEXT NOT NULL DEFAULT 'PERSONAL',
  "contact_phone" TEXT,
  "addr" TEXT NOT NULL,
  "usage_category" TEXT NOT NULL,
  "caliber_req" TEXT,
  "remark" TEXT,
  "status" "InstallApplyStatus" NOT NULL DEFAULT 'SUBMITTED',
  "org_unit_id" UUID,
  "survey_note" TEXT,
  "install_note" TEXT,
  "reject_reason" TEXT,
  "water_account_id" UUID,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "created_by" UUID,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_by" UUID,
  CONSTRAINT "install_application_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "install_application_tenant_no_key" ON "install_application"("tenant_id", "apply_no");
CREATE UNIQUE INDEX "install_application_tenant_id_key" ON "install_application"("tenant_id", "id");
CREATE INDEX "install_application_tenant_status_idx" ON "install_application"("tenant_id", "status");

-- ============ RLS + owner（与所有租户表同策略）============
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'channel_recon_batch','channel_recon_row','collection_notice',
    'receipt_book','invoice_registry','install_application'
  ] LOOP
    EXECUTE format('ALTER TABLE %I OWNER TO ws_owner;', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid);', t);
  END LOOP;
END $$;

-- install:* 权限码下发至既有租户（admin 持 '*' 不受影响；
-- 普通角色默认不绑定，由租户管理员在角色管理里按需授予）。
INSERT INTO permission (id, tenant_id, code, type, created_at, updated_at)
SELECT gen_random_uuid(), t.id, c.code, 'ACTION', now(), now()
FROM tenant t
CROSS JOIN (VALUES ('install:read'), ('install:write')) AS c(code)
ON CONFLICT (tenant_id, code) DO NOTHING;

-- 任务类型字典：报装审批 / 对账差异处理（dict 行缺失时 TASK_TYPES 回退生效，
-- 这里预置行让租户管理员可在字典管理中查看/覆盖规则）。
INSERT INTO sys_dict (id, tenant_id, category, code, name, value, seq, status, created_at, updated_at)
SELECT gen_random_uuid(), t.id, 'TASK_TYPE_PERM', c.code, c.name,
       jsonb_build_object('perm', c.perm, 'dueDays', c.due_days, 'priority', c.priority),
       c.sort, 'ACTIVE', now(), now()
FROM tenant t
CROSS JOIN (VALUES
  ('INSTALL_REVIEW', '报装审批', 'install:write', 3, 'NORMAL', 60),
  ('RECON_HANDLE',   '对账差异处理', 'payment:write', 3, 'HIGH', 61)
) AS c(code, name, perm, due_days, priority, sort)
ON CONFLICT (tenant_id, category, code) DO NOTHING;
