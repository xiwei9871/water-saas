-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "StaffStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "OrgType" AS ENUM ('COMPANY', 'BRANCH', 'DEPT');

-- CreateEnum
CREATE TYPE "DataScope" AS ENUM ('ALL', 'ORG_SUBTREE', 'SELF');

-- CreateEnum
CREATE TYPE "PermType" AS ENUM ('MENU', 'ACTION', 'DATA');

-- CreateEnum
CREATE TYPE "CustType" AS ENUM ('PERSONAL', 'ORG');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('NORMAL', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "AccountEventType" AS ENUM ('TRANSFER', 'SUSPEND', 'RESUME', 'CLOSE');

-- CreateEnum
CREATE TYPE "MeterStatus" AS ENUM ('AVAILABLE', 'INSTALLED', 'MAINTENANCE', 'RETIRED');

-- CreateEnum
CREATE TYPE "InstallationStatus" AS ENUM ('ACTIVE', 'REMOVED');

-- CreateEnum
CREATE TYPE "InstallReason" AS ENUM ('NEW', 'REPLACE', 'FAULT', 'PERIODIC_CHECK');

-- CreateEnum
CREATE TYPE "PlanStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'DONE', 'CLOSED');

-- CreateEnum
CREATE TYPE "PlanItemStatus" AS ENUM ('PENDING', 'READ', 'NO_READ', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ReadResultType" AS ENUM ('ACTUAL', 'REMOTE', 'NO_READ');

-- CreateEnum
CREATE TYPE "ExceptionCode" AS ENUM ('LOCKED', 'DIAL_DIRTY', 'FLOODED', 'OCCUPIED', 'STOPPED', 'BROKEN', 'SUSPECTED_THEFT', 'OTHER');

-- CreateEnum
CREATE TYPE "QcStatus" AS ENUM ('PENDING', 'PASSED', 'REJECTED', 'MANUAL_REVIEW');

-- CreateEnum
CREATE TYPE "ReadSource" AS ENUM ('WEB', 'IMPORT', 'APP', 'REMOTE');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('DRAFT', 'FINAL');

-- CreateEnum
CREATE TYPE "ComponentSourceType" AS ENUM ('READING', 'ESTIMATE', 'MANUAL');

-- CreateEnum
CREATE TYPE "EstimateMethod" AS ENUM ('AUTO_AVG3', 'MANUAL');

-- CreateEnum
CREATE TYPE "ReconStatus" AS ENUM ('DRAFT', 'ABSORBED', 'APPLIED', 'MANUAL_REVIEW');

-- CreateEnum
CREATE TYPE "CalcType" AS ENUM ('PER_QTY', 'FIXED', 'PERCENT');

-- CreateEnum
CREATE TYPE "TariffStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "RunType" AS ENUM ('MANUAL', 'AUTO');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('DRAFT', 'PROCESSING', 'PARTIAL', 'POSTED', 'FAILED');

-- CreateEnum
CREATE TYPE "BillKind" AS ENUM ('NORMAL', 'ADJUSTMENT', 'REVERSAL', 'REPLACEMENT');

-- CreateEnum
CREATE TYPE "BillSourceType" AS ENUM ('SETTLEMENT', 'RECONCILIATION', 'MANUAL', 'ORIGINAL_BILL');

-- CreateEnum
CREATE TYPE "BillStatus" AS ENUM ('DRAFT', 'POSTED', 'PARTIAL_PAID', 'PAID', 'REVERSED');

-- CreateEnum
CREATE TYPE "BillItemType" AS ENUM ('NORMAL', 'ADJUSTMENT', 'PENALTY');

-- CreateEnum
CREATE TYPE "IdemStatus" AS ENUM ('PROCESSING', 'COMPLETED');

-- CreateEnum
CREATE TYPE "PayChannel" AS ENUM ('CASH', 'POS', 'TRANSFER');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('RECEIVED', 'DAY_CLOSED', 'REVERSED');

-- CreateEnum
CREATE TYPE "ReceiptType" AS ENUM ('RECEIPT');

-- CreateEnum
CREATE TYPE "DayCloseStatus" AS ENUM ('POSTED');

-- CreateTable
CREATE TABLE "tenant" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "params" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_unit" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "parent_id" UUID,
    "name" TEXT NOT NULL,
    "type" "OrgType" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "org_unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "org_unit_id" UUID NOT NULL,
    "login" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "StaffStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "data_scope" "DataScope" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_role" (
    "tenant_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "staff_role_pkey" PRIMARY KEY ("staff_id","role_id")
);

-- CreateTable
CREATE TABLE "permission" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "type" "PermType" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permission" (
    "tenant_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "role_permission_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "staff_id" UUID,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" UUID,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sys_sequence" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "seq_key" TEXT NOT NULL,
    "period" CHAR(6),
    "cur_val" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "sys_sequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_param" (
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "tenant_param_pkey" PRIMARY KEY ("tenant_id","key")
);

-- CreateTable
CREATE TABLE "customer" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "customer_no" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cust_type" "CustType" NOT NULL,
    "id_type" TEXT,
    "id_no" TEXT,
    "phone" TEXT,
    "addr" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settle_account" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "settle_no" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "status" "AccountStatus" NOT NULL DEFAULT 'NORMAL',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "settle_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "water_account" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_no" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "settle_account_id" UUID NOT NULL,
    "usage_category" TEXT NOT NULL,
    "addr" TEXT NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'NORMAL',
    "opened_at" DATE,
    "closed_at" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "water_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meter" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "meter_no" TEXT NOT NULL,
    "serial_no" TEXT,
    "barcode" TEXT,
    "brand" TEXT,
    "model" TEXT,
    "caliber" TEXT,
    "max_dial" DECIMAL(18,4),
    "parent_meter_id" UUID,
    "status" "MeterStatus" NOT NULL DEFAULT 'AVAILABLE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "meter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meter_installation" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "water_account_id" UUID NOT NULL,
    "meter_id" UUID NOT NULL,
    "installed_at" TIMESTAMP(3) NOT NULL,
    "removed_at" TIMESTAMP(3),
    "initial_reading" DECIMAL(18,4) NOT NULL,
    "final_reading" DECIMAL(18,4),
    "reason" "InstallReason" NOT NULL,
    "status" "InstallationStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "meter_installation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_event" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "water_account_id" UUID NOT NULL,
    "type" "AccountEventType" NOT NULL,
    "payload" JSONB,
    "effective_date" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "account_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reading_book" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "book_no" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "org_unit_id" UUID NOT NULL,
    "reader_id" UUID,
    "schedule_day" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "reading_book_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "book_meter" (
    "tenant_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "water_account_id" UUID NOT NULL,
    "seq_no" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "book_meter_pkey" PRIMARY KEY ("book_id","water_account_id")
);

-- CreateTable
CREATE TABLE "reading_plan" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "period" CHAR(6) NOT NULL,
    "plan_date" DATE NOT NULL,
    "reader_id" UUID,
    "status" "PlanStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "reading_plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reading_plan_item" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "water_account_id" UUID NOT NULL,
    "seq_no" INTEGER NOT NULL,
    "planned_installation_id" UUID,
    "status" "PlanItemStatus" NOT NULL DEFAULT 'PENDING',
    "completed_reading_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "reading_plan_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meter_reading" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plan_item_id" UUID,
    "installation_id" UUID NOT NULL,
    "meter_id" UUID NOT NULL,
    "period" CHAR(6) NOT NULL,
    "read_date" DATE NOT NULL,
    "result_type" "ReadResultType" NOT NULL,
    "reading_value" DECIMAL(18,4),
    "exception_code" "ExceptionCode",
    "supersedes_reading_id" UUID,
    "qc_status" "QcStatus" NOT NULL DEFAULT 'PENDING',
    "qc_by" UUID,
    "qc_at" TIMESTAMP(3),
    "source" "ReadSource" NOT NULL,
    "operator_id" UUID NOT NULL,
    "photo_ref" TEXT,
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "meter_reading_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consumption_settlement" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "water_account_id" UUID NOT NULL,
    "period" CHAR(6) NOT NULL,
    "total_usage_qty" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "is_estimated" BOOLEAN NOT NULL DEFAULT false,
    "estimate_method" "EstimateMethod",
    "estimate_basis" JSONB,
    "estimate_reason" TEXT,
    "status" "SettlementStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "consumption_settlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consumption_component" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "settlement_id" UUID NOT NULL,
    "installation_id" UUID NOT NULL,
    "prev_reading_value" DECIMAL(18,4) NOT NULL,
    "end_reading_value" DECIMAL(18,4),
    "usage_qty" DECIMAL(18,4) NOT NULL,
    "source_type" "ComponentSourceType" NOT NULL,
    "source_reading_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "consumption_component_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "water_account_id" UUID NOT NULL,
    "anchor_reading_id" UUID NOT NULL,
    "actual_reading_id" UUID NOT NULL,
    "from_period" CHAR(6) NOT NULL,
    "to_period" CHAR(6) NOT NULL,
    "actual_total_usage" DECIMAL(18,4) NOT NULL,
    "previously_settled_usage" DECIMAL(18,4) NOT NULL,
    "remainder_usage" DECIMAL(18,4) NOT NULL,
    "absorbed_settlement_id" UUID,
    "correct_charge_cent" BIGINT,
    "posted_charge_cent" BIGINT,
    "adjustment_amount_cent" BIGINT,
    "status" "ReconStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "reconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "estimate_rule" (
    "tenant_id" UUID NOT NULL,
    "method" "EstimateMethod" NOT NULL,
    "params" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "estimate_rule_pkey" PRIMARY KEY ("tenant_id","method")
);

-- CreateTable
CREATE TABLE "fee_item" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "calc_type" "CalcType" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "fee_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tariff_plan" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "usage_category" TEXT NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "status" "TariffStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "tariff_plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tariff_tier" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "tariff_plan_id" UUID NOT NULL,
    "fee_item_id" UUID NOT NULL,
    "tier_no" INTEGER NOT NULL,
    "from_qty" DECIMAL(18,4) NOT NULL,
    "to_qty" DECIMAL(18,4),
    "unit_price" DECIMAL(18,6) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "tariff_tier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_run" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "period" CHAR(6) NOT NULL,
    "run_type" "RunType" NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'DRAFT',
    "posted_at" TIMESTAMP(3),
    "total_count" INTEGER NOT NULL DEFAULT 0,
    "success_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "failed_settlement_ids" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "billing_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "billing_run_id" UUID,
    "settle_account_id" UUID NOT NULL,
    "water_account_id" UUID NOT NULL,
    "period" CHAR(6) NOT NULL,
    "bill_kind" "BillKind" NOT NULL,
    "source_type" "BillSourceType" NOT NULL,
    "source_id" UUID NOT NULL,
    "tariff_plan_id" UUID,
    "status" "BillStatus" NOT NULL DEFAULT 'DRAFT',
    "is_estimated" BOOLEAN NOT NULL DEFAULT false,
    "total_amount" BIGINT NOT NULL,
    "issued_at" TIMESTAMP(3),
    "due_date" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "bill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_item" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "bill_id" UUID NOT NULL,
    "fee_item_id" UUID,
    "item_type" "BillItemType" NOT NULL,
    "description" TEXT,
    "qty" DECIMAL(18,4),
    "unit_price" DECIMAL(18,6),
    "amount" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "bill_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_key" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_status" INTEGER,
    "response_ref" TEXT,
    "status" "IdemStatus" NOT NULL DEFAULT 'PROCESSING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "payment_no" TEXT NOT NULL,
    "settle_account_id" UUID NOT NULL,
    "cashier_id" UUID NOT NULL,
    "org_unit_id" UUID NOT NULL,
    "channel" "PayChannel" NOT NULL,
    "amount" BIGINT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'RECEIVED',
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversal_of_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_alloc" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "bill_id" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "payment_alloc_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "receipt_no" TEXT NOT NULL,
    "rcp_type" "ReceiptType" NOT NULL DEFAULT 'RECEIPT',
    "printed_at" TIMESTAMP(3),
    "void_flag" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cashier_day_close" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "cashier_id" UUID NOT NULL,
    "org_unit_id" UUID NOT NULL,
    "close_date" DATE NOT NULL,
    "total_count" INTEGER NOT NULL,
    "total_amount" BIGINT NOT NULL,
    "by_channel" JSONB NOT NULL,
    "status" "DayCloseStatus" NOT NULL DEFAULT 'POSTED',
    "closed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "cashier_day_close_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_code_key" ON "tenant"("code");

-- CreateIndex
CREATE INDEX "org_unit_tenant_id_parent_id_idx" ON "org_unit"("tenant_id", "parent_id");

-- CreateIndex
CREATE INDEX "staff_tenant_id_org_unit_id_idx" ON "staff"("tenant_id", "org_unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "staff_tenant_id_login_key" ON "staff"("tenant_id", "login");

-- CreateIndex
CREATE UNIQUE INDEX "role_tenant_id_code_key" ON "role"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "staff_role_tenant_id_role_id_idx" ON "staff_role"("tenant_id", "role_id");

-- CreateIndex
CREATE UNIQUE INDEX "permission_tenant_id_code_key" ON "permission"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "role_permission_tenant_id_permission_id_idx" ON "role_permission"("tenant_id", "permission_id");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_entity_entity_id_idx" ON "audit_log"("tenant_id", "entity", "entity_id");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_created_at_idx" ON "audit_log"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "sys_sequence_tenant_id_seq_key_period_key" ON "sys_sequence"("tenant_id", "seq_key", "period");

-- CreateIndex
CREATE UNIQUE INDEX "customer_tenant_id_customer_no_key" ON "customer"("tenant_id", "customer_no");

-- CreateIndex
CREATE UNIQUE INDEX "settle_account_tenant_id_settle_no_key" ON "settle_account"("tenant_id", "settle_no");

-- CreateIndex
CREATE INDEX "water_account_tenant_id_customer_id_idx" ON "water_account"("tenant_id", "customer_id");

-- CreateIndex
CREATE INDEX "water_account_tenant_id_settle_account_id_idx" ON "water_account"("tenant_id", "settle_account_id");

-- CreateIndex
CREATE INDEX "water_account_tenant_id_usage_category_idx" ON "water_account"("tenant_id", "usage_category");

-- CreateIndex
CREATE UNIQUE INDEX "water_account_tenant_id_account_no_key" ON "water_account"("tenant_id", "account_no");

-- CreateIndex
CREATE UNIQUE INDEX "meter_tenant_id_meter_no_key" ON "meter"("tenant_id", "meter_no");

-- CreateIndex
CREATE INDEX "meter_installation_tenant_id_water_account_id_status_idx" ON "meter_installation"("tenant_id", "water_account_id", "status");

-- CreateIndex
CREATE INDEX "meter_installation_tenant_id_meter_id_idx" ON "meter_installation"("tenant_id", "meter_id");

-- CreateIndex
CREATE INDEX "account_event_tenant_id_water_account_id_idx" ON "account_event"("tenant_id", "water_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "reading_book_tenant_id_book_no_key" ON "reading_book"("tenant_id", "book_no");

-- CreateIndex
CREATE INDEX "book_meter_tenant_id_book_id_idx" ON "book_meter"("tenant_id", "book_id");

-- CreateIndex
CREATE INDEX "reading_plan_tenant_id_period_idx" ON "reading_plan"("tenant_id", "period");

-- CreateIndex
CREATE INDEX "reading_plan_tenant_id_book_id_period_idx" ON "reading_plan"("tenant_id", "book_id", "period");

-- CreateIndex
CREATE INDEX "reading_plan_item_tenant_id_status_idx" ON "reading_plan_item"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "reading_plan_item_tenant_id_water_account_id_idx" ON "reading_plan_item"("tenant_id", "water_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "reading_plan_item_plan_id_water_account_id_key" ON "reading_plan_item"("plan_id", "water_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "reading_plan_item_plan_id_seq_no_key" ON "reading_plan_item"("plan_id", "seq_no");

-- CreateIndex
CREATE INDEX "meter_reading_tenant_id_period_idx" ON "meter_reading"("tenant_id", "period");

-- CreateIndex
CREATE INDEX "meter_reading_tenant_id_installation_id_period_idx" ON "meter_reading"("tenant_id", "installation_id", "period");

-- CreateIndex
CREATE INDEX "meter_reading_tenant_id_plan_item_id_idx" ON "meter_reading"("tenant_id", "plan_item_id");

-- CreateIndex
CREATE INDEX "meter_reading_tenant_id_qc_status_idx" ON "meter_reading"("tenant_id", "qc_status");

-- CreateIndex
CREATE INDEX "consumption_settlement_tenant_id_period_status_idx" ON "consumption_settlement"("tenant_id", "period", "status");

-- CreateIndex
CREATE UNIQUE INDEX "consumption_settlement_tenant_id_water_account_id_period_key" ON "consumption_settlement"("tenant_id", "water_account_id", "period");

-- CreateIndex
CREATE INDEX "consumption_component_tenant_id_settlement_id_idx" ON "consumption_component"("tenant_id", "settlement_id");

-- CreateIndex
CREATE INDEX "reconciliation_tenant_id_water_account_id_idx" ON "reconciliation"("tenant_id", "water_account_id");

-- CreateIndex
CREATE INDEX "reconciliation_tenant_id_status_idx" ON "reconciliation"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "fee_item_tenant_id_code_key" ON "fee_item"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "tariff_plan_tenant_id_usage_category_status_idx" ON "tariff_plan"("tenant_id", "usage_category", "status");

-- CreateIndex
CREATE UNIQUE INDEX "tariff_plan_tenant_id_code_effective_from_key" ON "tariff_plan"("tenant_id", "code", "effective_from");

-- CreateIndex
CREATE INDEX "tariff_tier_tenant_id_tariff_plan_id_idx" ON "tariff_tier"("tenant_id", "tariff_plan_id");

-- CreateIndex
CREATE UNIQUE INDEX "tariff_tier_tariff_plan_id_fee_item_id_tier_no_key" ON "tariff_tier"("tariff_plan_id", "fee_item_id", "tier_no");

-- CreateIndex
CREATE INDEX "billing_run_tenant_id_period_status_idx" ON "billing_run"("tenant_id", "period", "status");

-- CreateIndex
CREATE INDEX "bill_tenant_id_water_account_id_period_idx" ON "bill"("tenant_id", "water_account_id", "period");

-- CreateIndex
CREATE INDEX "bill_tenant_id_settle_account_id_status_idx" ON "bill"("tenant_id", "settle_account_id", "status");

-- CreateIndex
CREATE INDEX "bill_tenant_id_billing_run_id_idx" ON "bill"("tenant_id", "billing_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "bill_tenant_id_source_type_source_id_bill_kind_key" ON "bill"("tenant_id", "source_type", "source_id", "bill_kind");

-- CreateIndex
CREATE INDEX "bill_item_tenant_id_bill_id_idx" ON "bill_item"("tenant_id", "bill_id");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_key_tenant_id_key_key" ON "idempotency_key"("tenant_id", "key");

-- CreateIndex
CREATE INDEX "payment_tenant_id_settle_account_id_status_idx" ON "payment"("tenant_id", "settle_account_id", "status");

-- CreateIndex
CREATE INDEX "payment_tenant_id_cashier_id_status_idx" ON "payment"("tenant_id", "cashier_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payment_tenant_id_payment_no_key" ON "payment"("tenant_id", "payment_no");

-- CreateIndex
CREATE INDEX "payment_alloc_tenant_id_payment_id_idx" ON "payment_alloc"("tenant_id", "payment_id");

-- CreateIndex
CREATE INDEX "payment_alloc_tenant_id_bill_id_idx" ON "payment_alloc"("tenant_id", "bill_id");

-- CreateIndex
CREATE INDEX "receipt_tenant_id_payment_id_idx" ON "receipt"("tenant_id", "payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_tenant_id_receipt_no_key" ON "receipt"("tenant_id", "receipt_no");

-- CreateIndex
CREATE INDEX "cashier_day_close_tenant_id_cashier_id_close_date_idx" ON "cashier_day_close"("tenant_id", "cashier_id", "close_date");

-- CreateIndex
CREATE INDEX "cashier_day_close_tenant_id_close_date_idx" ON "cashier_day_close"("tenant_id", "close_date");

-- ===========================================================================
-- Tenant RLS infrastructure (manually appended — replicate this block in any
-- future migration that adds tenant-scoped tables).
-- ===========================================================================

-- Application runtime role: non-owner, no BYPASSRLS → fully subject to RLS.
-- Guarded: roles are cluster-global, so this migration can also be deployed to
-- the test database on the same cluster.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ws_app') THEN
    CREATE ROLE ws_app LOGIN PASSWORD 'ws_app_pw' NOINHERIT;
  END IF;
END $$;

-- Non-superuser table owner. postgres itself is a superuser and always
-- bypasses RLS; making a plain role the owner is what lets FORCE RLS bind
-- the table owner too.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ws_owner') THEN
    CREATE ROLE ws_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

GRANT CONNECT ON DATABASE watersaas TO ws_app;
GRANT USAGE ON SCHEMA public TO ws_app;
GRANT USAGE ON SCHEMA public TO ws_owner;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ws_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ws_app;

-- Test database exists only in dev/CI clusters — grant when present.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_database WHERE datname = 'watersaas_test') THEN
    EXECUTE 'GRANT CONNECT ON DATABASE watersaas_test TO ws_app';
  END IF;
END $$;

-- ENABLE + FORCE RLS on every tenant-scoped business table. The policy is
-- transaction-local via set_config('app.tenant_id', ..., true); when unset,
-- current_setting returns NULL and the policy hides all rows.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'customer','settle_account','water_account','meter','meter_installation','account_event',
    'reading_book','book_meter','reading_plan','reading_plan_item','meter_reading',
    'consumption_settlement','consumption_component','reconciliation','estimate_rule',
    'fee_item','tariff_plan','tariff_tier','billing_run','bill','bill_item','idempotency_key',
    'payment','payment_alloc','receipt','cashier_day_close','audit_log','sys_sequence','tenant_param',
    'org_unit','staff','role','staff_role','role_permission','permission'
  ] LOOP
    EXECUTE format('ALTER TABLE %I OWNER TO ws_owner;', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid);', t);
  END LOOP;
END $$;

-- tenant has no tenant_id — isolate on its own primary key.
ALTER TABLE tenant OWNER TO ws_owner;
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant
  USING (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
