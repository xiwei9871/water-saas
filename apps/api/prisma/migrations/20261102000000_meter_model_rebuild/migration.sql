-- 20261102 抄表业务模型重构（R1~R15 底座）：
--   water_account 增 频次(cadence)/锚点/区号/段号/路线键/退号留痕；
--   reading_book 增 区号/段号（R7 区段号编码）；
--   install_application 增 水表数量/口径明细/安装明细（R11/R12）；
--   新表 reader_zone（R14 区号—抄表员绑定）/ tenant_calendar_day
--（R3 工作日历）/ route_pattern（R15 排序模式）。
-- AccountStatus 新增 RETURNED（R1 退号作废态）——枚举值须在本迁移提交后
-- 方可被后续 CHECK 引用（见 20261102000001）。

ALTER TYPE "AccountStatus" ADD VALUE 'RETURNED';

ALTER TABLE "water_account"
  ADD COLUMN "zone_no"        VARCHAR(8),
  ADD COLUMN "seg_no"         VARCHAR(8),
  ADD COLUMN "cadence"        VARCHAR(16) NOT NULL DEFAULT 'MONTHLY',
  ADD COLUMN "anchor_period"  CHAR(6),
  ADD COLUMN "route_key"      NUMERIC(20, 6),
  ADD COLUMN "returned_at"    TIMESTAMPTZ,
  ADD COLUMN "return_reason"  TEXT;

ALTER TABLE "water_account" ADD CONSTRAINT "water_account_cadence_chk"
  CHECK ("cadence" IN ('MONTHLY', 'ODD_MONTH', 'EVEN_MONTH', 'QUARTERLY'));
ALTER TABLE "water_account" ADD CONSTRAINT "water_account_quarterly_anchor_chk"
  CHECK ("cadence" <> 'QUARTERLY' OR "anchor_period" IS NOT NULL);
CREATE INDEX "water_account_zone_idx" ON "water_account"("tenant_id", "zone_no", "seg_no");
CREATE INDEX "water_account_route_idx" ON "water_account"("tenant_id", "zone_no", "route_key");

-- R13 历史兼容：把存量册周期迁移到其成员户（一户多册时取最早入册册的周期）。
UPDATE "water_account" wa
   SET "cadence" = bm."cadence",
       "anchor_period" = bm."anchor_period"
  FROM (
    SELECT DISTINCT ON (m."water_account_id")
           m."tenant_id", m."water_account_id", b."cadence", b."anchor_period"
      FROM "book_meter" m
      JOIN "reading_book" b
        ON b."tenant_id" = m."tenant_id" AND b."id" = m."book_id"
     ORDER BY m."water_account_id", m."created_at" ASC
  ) bm
 WHERE wa."tenant_id" = bm."tenant_id"
   AND wa."id" = bm."water_account_id";

ALTER TABLE "reading_book"
  ADD COLUMN "zone_no" VARCHAR(8),
  ADD COLUMN "seg_no"  VARCHAR(8);

ALTER TABLE "install_application"
  ADD COLUMN "meter_qty"       INTEGER,
  ADD COLUMN "caliber_details" JSONB,
  ADD COLUMN "install_meters"  JSONB;

-- R14 区号—抄表员绑定
CREATE TABLE "reader_zone" (
  "id"         uuid         NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"  uuid         NOT NULL,
  "zone_no"    varchar(8)   NOT NULL,
  "reader_id"  uuid,
  "status"     varchar(16)  NOT NULL DEFAULT 'ACTIVE',
  "remark"     text,
  "created_at" timestamptz  NOT NULL DEFAULT now(),
  "created_by" uuid,
  "updated_at" timestamptz  NOT NULL DEFAULT now(),
  "updated_by" uuid,
  CONSTRAINT "reader_zone_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "reader_zone_tenant_zone_key" UNIQUE ("tenant_id", "zone_no"),
  CONSTRAINT "reader_zone_status_chk" CHECK ("status" IN ('ACTIVE', 'DISABLED'))
);
CREATE UNIQUE INDEX "reader_zone_tenant_id_key" ON "reader_zone"("tenant_id", "id");

-- R3 工作日/节假日日历（租户可维护）：HOLIDAY 节假日 / WORKDAY 调休上班日
CREATE TABLE "tenant_calendar_day" (
  "tenant_id"  uuid         NOT NULL,
  "day"        date         NOT NULL,
  "kind"       varchar(16)  NOT NULL,
  "name"       varchar(64),
  "created_at" timestamptz  NOT NULL DEFAULT now(),
  "created_by" uuid,
  "updated_at" timestamptz  NOT NULL DEFAULT now(),
  "updated_by" uuid,
  CONSTRAINT "tenant_calendar_day_pkey" PRIMARY KEY ("tenant_id", "day"),
  CONSTRAINT "tenant_calendar_day_kind_chk" CHECK ("kind" IN ('HOLIDAY', 'WORKDAY'))
);

-- R15 抄表顺序模式（命名路线模式，可切换/设默认）
CREATE TABLE "route_pattern" (
  "id"         uuid         NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"  uuid         NOT NULL,
  "zone_no"    varchar(8)   NOT NULL,
  "name"       varchar(80)  NOT NULL,
  "is_default" boolean      NOT NULL DEFAULT false,
  "entries"    jsonb        NOT NULL,
  "created_at" timestamptz  NOT NULL DEFAULT now(),
  "created_by" uuid,
  "updated_at" timestamptz  NOT NULL DEFAULT now(),
  "updated_by" uuid,
  CONSTRAINT "route_pattern_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "route_pattern_tenant_id_key" UNIQUE ("tenant_id", "id")
);
CREATE INDEX "route_pattern_zone_idx" ON "route_pattern"("tenant_id", "zone_no");

ALTER TABLE "reader_zone" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reader_zone" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tenant_calendar_day" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_calendar_day" FORCE ROW LEVEL SECURITY;
ALTER TABLE "route_pattern" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "route_pattern" FORCE ROW LEVEL SECURITY;

CREATE POLICY reader_zone_tenant ON "reader_zone"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_calendar_day_tenant ON "tenant_calendar_day"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY route_pattern_tenant ON "route_pattern"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
