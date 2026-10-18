-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('PENDING', 'CLAIMED', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- AlterTable (drift cleanup: ids are client-generated, no DB default needed)
ALTER TABLE "bad_debt_writeoff" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "sys_dict" ALTER COLUMN "id" DROP DEFAULT;

-- CreateTable
CREATE TABLE "task" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "biz_type" TEXT NOT NULL,
    "biz_id" UUID NOT NULL,
    "biz_label" TEXT,
    "reason" TEXT NOT NULL,
    "context" JSONB,
    "required_perm" TEXT NOT NULL,
    "org_unit_id" UUID,
    "assignee_id" UUID,
    "status" "TaskStatus" NOT NULL DEFAULT 'PENDING',
    "priority" "TaskPriority" NOT NULL DEFAULT 'NORMAL',
    "due_at" TIMESTAMP(3),
    "source_task_id" UUID,
    "candidate_count" INTEGER NOT NULL DEFAULT 0,
    "escalated_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "completed_by" UUID,
    "cancelled_at" TIMESTAMP(3),
    "cancel_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "task_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "task_tenant_id_status_type_idx" ON "task"("tenant_id", "status", "type");
CREATE INDEX "task_tenant_id_assignee_id_status_idx" ON "task"("tenant_id", "assignee_id", "status");
CREATE INDEX "task_tenant_id_biz_type_biz_id_idx" ON "task"("tenant_id", "biz_type", "biz_id");
CREATE INDEX "task_tenant_id_due_at_idx" ON "task"("tenant_id", "due_at");

-- At most ONE open task per (tenant, type, biz): re-triggering while a task is
-- still open must dedupe, not spam duplicates. DONE/CANCELLED frees the key
-- so the same business object can legitimately re-trigger a fresh task later.
CREATE UNIQUE INDEX "task_open_dedupe"
  ON "task"("tenant_id", "type", "biz_type", "biz_id")
  WHERE "status" IN ('PENDING', 'CLAIMED');

-- ============ RLS (same policy as every tenant table) ============
ALTER TABLE "task" OWNER TO ws_owner;
ALTER TABLE "task" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "task"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ============ T3: 任务类型 → 所需权限 映射字典（全租户播种，后台可改）====
-- value JSON: {perm: 所需权限码, dueDays: 默认期限天数, priority: 默认优先级}
INSERT INTO "sys_dict" ("id","tenant_id","category","code","name","seq","status","value","created_at","updated_at")
SELECT gen_random_uuid(), t.id, 'TASK_TYPE_PERM', v.code, v.name, v.seq, 'ACTIVE', v.val::jsonb, now(), now()
FROM tenant t CROSS JOIN (VALUES
  ('SUPPLEMENT',        '补差任务',     10, '{"perm":"billing:write","dueDays":3,"priority":"HIGH"}'),
  ('METER_REVIEW',      '抄表异常复核', 20, '{"perm":"metering:qc","dueDays":2,"priority":"HIGH"}'),
  ('COLLECTION',        '催缴任务',     30, '{"perm":"payment:write","dueDays":7,"priority":"NORMAL"}'),
  ('REVERSAL_APPROVAL', '红冲审批',     40, '{"perm":"billing:write","dueDays":2,"priority":"HIGH"}'),
  ('WRITEOFF_APPROVAL', '核销审批',     50, '{"perm":"billing:write","dueDays":3,"priority":"HIGH"}')
) AS v(code,name,seq,val)
WHERE NOT EXISTS (
  SELECT 1 FROM sys_dict d
  WHERE d.tenant_id=t.id AND d.category='TASK_TYPE_PERM' AND d.code=v.code
);

-- 催缴规则字典（欠费金额阈值(分)/逾期天数），后台可调。
INSERT INTO "sys_dict" ("id","tenant_id","category","code","name","seq","status","value","created_at","updated_at")
SELECT gen_random_uuid(), t.id, 'TASK_RULE', 'COLLECTION', '催缴规则', 10, 'ACTIVE',
       '{"amountThreshold":100000,"overdueDays":30}'::jsonb, now(), now()
FROM tenant t
WHERE NOT EXISTS (
  SELECT 1 FROM sys_dict d
  WHERE d.tenant_id=t.id AND d.category='TASK_RULE' AND d.code='COLLECTION'
);
