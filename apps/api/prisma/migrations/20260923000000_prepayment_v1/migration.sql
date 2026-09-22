-- E6 Prepayment V1 — docs/product-map/E6_PREPAYMENT_DOMAIN_DESIGN.md
-- One new append-only object (prepayment_ledger_entry) + payment_alloc
-- dual-source + receipt uniqueness + day-close prepayment breakdown.

-- CreateEnum
CREATE TYPE "PrepaymentEntryType" AS ENUM ('TOP_UP', 'APPLY', 'REFUND', 'REVERSAL');

-- CreateEnum
CREATE TYPE "PaymentAllocSource" AS ENUM ('PAYMENT', 'PREPAYMENT');

-- AlterTable
ALTER TABLE "cashier_day_close" ADD COLUMN     "prepayment_breakdown" JSONB;

-- AlterTable
ALTER TABLE "payment_alloc" ADD COLUMN     "prepayment_entry_id" UUID,
ADD COLUMN     "source" "PaymentAllocSource" NOT NULL DEFAULT 'PAYMENT',
ALTER COLUMN "payment_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "prepayment_ledger_entry" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "settle_account_id" UUID NOT NULL,
    "type" "PrepaymentEntryType" NOT NULL,
    "amount" BIGINT NOT NULL,
    "payment_id" UUID,
    "bill_id" UUID,
    "origin_top_up_id" UUID,
    "reversal_of_entry_id" UUID,
    "idempotency_key" TEXT NOT NULL,
    "operator_id" UUID,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "prepayment_ledger_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "prepayment_ledger_entry_tenant_id_settle_account_id_created_idx" ON "prepayment_ledger_entry"("tenant_id", "settle_account_id", "created_at");

-- CreateIndex
CREATE INDEX "prepayment_ledger_entry_tenant_id_bill_id_idx" ON "prepayment_ledger_entry"("tenant_id", "bill_id");

-- CreateIndex
CREATE INDEX "prepayment_ledger_entry_tenant_id_origin_top_up_id_idx" ON "prepayment_ledger_entry"("tenant_id", "origin_top_up_id");

-- CreateIndex
CREATE UNIQUE INDEX "prepayment_ledger_entry_tenant_id_idempotency_key_key" ON "prepayment_ledger_entry"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "prepay_entry_tenant_settle_id_key" ON "prepayment_ledger_entry"("tenant_id", "settle_account_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "prepay_entry_tenant_id_bill_key" ON "prepayment_ledger_entry"("tenant_id", "id", "bill_id");

-- CreateIndex
CREATE UNIQUE INDEX "bill_tenant_settle_id_key" ON "bill"("tenant_id", "settle_account_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_tenant_settle_id_key" ON "payment"("tenant_id", "settle_account_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_alloc_tenant_prepay_entry_key" ON "payment_alloc"("tenant_id", "prepayment_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_tenant_payment_key" ON "receipt"("tenant_id", "payment_id");

-- AddForeignKey
ALTER TABLE "payment_alloc" ADD CONSTRAINT "payment_alloc_prepay_fkey" FOREIGN KEY ("tenant_id", "prepayment_entry_id", "bill_id") REFERENCES "prepayment_ledger_entry"("tenant_id", "id", "bill_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prepayment_ledger_entry" ADD CONSTRAINT "prepayment_ledger_entry_tenant_id_settle_account_id_fkey" FOREIGN KEY ("tenant_id", "settle_account_id") REFERENCES "settle_account"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prepayment_ledger_entry" ADD CONSTRAINT "prepay_entry_payment_fkey" FOREIGN KEY ("tenant_id", "settle_account_id", "payment_id") REFERENCES "payment"("tenant_id", "settle_account_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prepayment_ledger_entry" ADD CONSTRAINT "prepay_entry_bill_fkey" FOREIGN KEY ("tenant_id", "settle_account_id", "bill_id") REFERENCES "bill"("tenant_id", "settle_account_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prepayment_ledger_entry" ADD CONSTRAINT "prepay_entry_origin_topup_fkey" FOREIGN KEY ("tenant_id", "settle_account_id", "origin_top_up_id") REFERENCES "prepayment_ledger_entry"("tenant_id", "settle_account_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prepayment_ledger_entry" ADD CONSTRAINT "prepay_entry_reversal_of_fkey" FOREIGN KEY ("tenant_id", "settle_account_id", "reversal_of_entry_id") REFERENCES "prepayment_ledger_entry"("tenant_id", "settle_account_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============ Domain CHECKs (design §3) ============
-- Every lot-affecting non-TOP_UP entry must carry origin_top_up_id so a
-- lot's remaining is a single-level sum. Sign/provenance per type:
ALTER TABLE "prepayment_ledger_entry" ADD CONSTRAINT
  "prepay_entry_top_up_shape"
  CHECK ("type" <> 'TOP_UP' OR (
    "amount" > 0 AND "payment_id" IS NOT NULL AND
    "origin_top_up_id" IS NULL AND "reversal_of_entry_id" IS NULL AND
    "bill_id" IS NULL));

ALTER TABLE "prepayment_ledger_entry" ADD CONSTRAINT
  "prepay_entry_apply_shape"
  CHECK ("type" <> 'APPLY' OR (
    "amount" < 0 AND "bill_id" IS NOT NULL AND
    "origin_top_up_id" IS NOT NULL AND "payment_id" IS NULL));

ALTER TABLE "prepayment_ledger_entry" ADD CONSTRAINT
  "prepay_entry_refund_shape"
  CHECK ("type" <> 'REFUND' OR (
    "amount" < 0 AND "payment_id" IS NOT NULL AND
    "origin_top_up_id" IS NOT NULL AND "reason" IS NOT NULL));

ALTER TABLE "prepayment_ledger_entry" ADD CONSTRAINT
  "prepay_entry_reversal_shape"
  CHECK ("type" <> 'REVERSAL' OR (
    "reversal_of_entry_id" IS NOT NULL AND
    "origin_top_up_id" IS NOT NULL AND "reason" IS NOT NULL));

ALTER TABLE "prepayment_ledger_entry" ADD CONSTRAINT
  "prepay_entry_no_self_ref"
  CHECK ("reversal_of_entry_id" IS NULL OR "reversal_of_entry_id" <> "id");

-- payment_alloc dual-source XOR (design §7)
ALTER TABLE "payment_alloc" ADD CONSTRAINT
  "payment_alloc_source_shape"
  CHECK (
    ("source" = 'PAYMENT'    AND "payment_id" IS NOT NULL AND "prepayment_entry_id" IS NULL) OR
    ("source" = 'PREPAYMENT' AND "payment_id" IS NULL     AND "prepayment_entry_id" IS NOT NULL));

-- ============ RLS (same policy as every tenant table) ============
ALTER TABLE "prepayment_ledger_entry" OWNER TO ws_owner;
ALTER TABLE "prepayment_ledger_entry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "prepayment_ledger_entry" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "prepayment_ledger_entry"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ============ Append-only hardening (design §3/§18) ============
-- Ledger entries are terminal facts; payment_alloc is already used as an
-- append-only fact table (+alloc / −mirror alloc, never mutate). ws_app
-- keeps SELECT/INSERT only.
REVOKE UPDATE, DELETE, TRUNCATE ON "prepayment_ledger_entry" FROM ws_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "payment_alloc" FROM ws_app;
