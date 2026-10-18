-- CreateTable
CREATE TABLE "report_query_template" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_query_template_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "report_query_template_tenant_id_staff_id_name_key" ON "report_query_template"("tenant_id", "staff_id", "name");

-- CreateIndex
CREATE INDEX "report_query_template_tenant_id_staff_id_idx" ON "report_query_template"("tenant_id", "staff_id");
