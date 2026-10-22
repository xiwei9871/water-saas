-- 报装纳入双向关联（20261022 修订建议 2.2）：申请↔立户要素互写 + 来源追溯。
ALTER TABLE "install_application" ADD COLUMN "contract_no" text;
ALTER TABLE "install_application" ADD COLUMN "settle_account_id" uuid;
ALTER TABLE "install_application" ADD COLUMN "meter_no" text;
-- 装表环节接收的完成信息（表号/口径/完成日期/工程费）。
ALTER TABLE "install_application" ADD COLUMN "install_meter_no" text;
ALTER TABLE "install_application" ADD COLUMN "install_caliber" text;
ALTER TABLE "install_application" ADD COLUMN "install_completed_at" timestamptz;
ALTER TABLE "install_application" ADD COLUMN "fee_required" numeric(18,2);
ALTER TABLE "install_application" ADD COLUMN "fee_received" numeric(18,2);
ALTER TABLE "install_application" ADD COLUMN "fee_note" text;
-- 反向关联：户/客户/表记来源报装单号，可回查"该户是哪个报装来的"。
ALTER TABLE "water_account" ADD COLUMN "source_apply_no" text;
ALTER TABLE "customer" ADD COLUMN "source_apply_no" text;
ALTER TABLE "meter" ADD COLUMN "source_apply_no" text;
