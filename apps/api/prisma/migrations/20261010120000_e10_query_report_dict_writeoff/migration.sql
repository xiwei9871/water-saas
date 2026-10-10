-- E10 batch: G1 费用项分类 + G3 渠道扩充 + G4 统一字典 + G2 坏账核销登记

-- G3: channel enum expansion (online collection / bank direct debit).
-- ADD VALUE cannot run inside a transaction block on PG<12; Prisma migrate
-- wraps each migration in its own tx on PG12+ which is fine.
ALTER TYPE "PayChannel" ADD VALUE 'ONLINE';
ALTER TYPE "PayChannel" ADD VALUE 'BANK_DEDUCT';

-- G1: fee item classification for 综合单价 (水费收入不含代收项).
CREATE TYPE "FeeItemKind" AS ENUM ('WATER_FEE', 'AGENCY', 'OTHER');
ALTER TABLE "fee_item" ADD COLUMN "kind" "FeeItemKind" NOT NULL DEFAULT 'WATER_FEE';

-- DictStatus / WriteoffStatus
CREATE TYPE "DictStatus" AS ENUM ('ACTIVE', 'DISABLED');
CREATE TYPE "WriteoffStatus" AS ENUM ('ACTIVE', 'REVERSED');

-- G4 统一字典
CREATE TABLE "sys_dict" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "status" "DictStatus" NOT NULL DEFAULT 'ACTIVE',
    "value" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "sys_dict_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sys_dict_tenant_id_category_code_key" ON "sys_dict"("tenant_id", "category", "code");
CREATE UNIQUE INDEX "sys_dict_tenant_id_id_key" ON "sys_dict"("tenant_id", "id");
CREATE INDEX "sys_dict_tenant_id_category_status_idx" ON "sys_dict"("tenant_id", "category", "status");

-- G2 坏账核销登记
CREATE TABLE "bad_debt_writeoff" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "settle_account_id" UUID NOT NULL,
    "water_account_id" UUID,
    "bill_id" UUID,
    "amount" BIGINT NOT NULL,
    "reason_code" TEXT NOT NULL,
    "note" TEXT,
    "status" "WriteoffStatus" NOT NULL DEFAULT 'ACTIVE',
    "effective_date" DATE NOT NULL,
    "reversed_at" TIMESTAMP(3),
    "reversed_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "bad_debt_writeoff_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "bad_debt_writeoff_tenant_id_id_key" ON "bad_debt_writeoff"("tenant_id", "id");
CREATE INDEX "bad_debt_writeoff_tenant_id_settle_account_id_status_idx" ON "bad_debt_writeoff"("tenant_id", "settle_account_id", "status");
CREATE INDEX "bad_debt_writeoff_tenant_id_effective_date_idx" ON "bad_debt_writeoff"("tenant_id", "effective_date");

-- ============ RLS (same policy as every tenant table) ============
ALTER TABLE "sys_dict" OWNER TO ws_owner;
ALTER TABLE "sys_dict" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sys_dict" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sys_dict"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "bad_debt_writeoff" OWNER TO ws_owner;
ALTER TABLE "bad_debt_writeoff" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bad_debt_writeoff" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "bad_debt_writeoff"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
