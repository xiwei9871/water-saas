-- CreateEnum
CREATE TYPE "BillingRunGenerationStatus" AS ENUM ('GENERATING', 'READY');

-- AlterTable
ALTER TABLE "billing_run" ADD COLUMN     "generation_status" "BillingRunGenerationStatus" NOT NULL DEFAULT 'READY';

-- AlterTable
ALTER TABLE "idempotency_key" ADD COLUMN     "billing_run_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "billing_run_tenant_id_id_key" ON "billing_run"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "idempotency_key_tenant_id_billing_run_id_idx" ON "idempotency_key"("tenant_id", "billing_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_key_tenant_id_billing_run_id_key" ON "idempotency_key"("tenant_id", "billing_run_id");

-- AddForeignKey
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_tenant_id_billing_run_id_fkey" FOREIGN KEY ("tenant_id", "billing_run_id") REFERENCES "billing_run"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
