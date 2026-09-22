-- CreateEnum
CREATE TYPE "WorkItemStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'IGNORED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "ResolutionSource" AS ENUM ('AUTO', 'MANUAL');

-- CreateTable
CREATE TABLE "work_item" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "anomaly_key" TEXT NOT NULL,
    "anomaly_type" TEXT NOT NULL,
    "status" "WorkItemStatus" NOT NULL DEFAULT 'OPEN',
    "resolution_source" "ResolutionSource",
    "assignee_id" UUID,
    "note" TEXT,
    "acknowledged_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "cleared_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "work_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "work_item_tenant_id_anomaly_type_status_idx" ON "work_item"("tenant_id", "anomaly_type", "status");

-- CreateIndex
CREATE INDEX "work_item_tenant_id_assignee_id_status_idx" ON "work_item"("tenant_id", "assignee_id", "status");

-- CreateIndex
CREATE INDEX "work_item_tenant_id_cleared_at_idx" ON "work_item"("tenant_id", "cleared_at");

-- E9 D2: at most ONE active episode per (tenant_id, anomaly_key). Episodes may
-- recur over time, so uniqueness is scoped to cleared_at IS NULL — a cleared
-- episode frees the key for the next occurrence. Prisma cannot express partial
-- indexes; this is the hand-written core of this migration.
CREATE UNIQUE INDEX "work_item_active_episode_key"
  ON "work_item"("tenant_id", "anomaly_key")
  WHERE "cleared_at" IS NULL;

-- ============ RLS (same policy as every tenant table) ============
ALTER TABLE "work_item" OWNER TO ws_owner;
ALTER TABLE "work_item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "work_item" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "work_item"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
