-- tariff_tier had NO foreign keys at all (T8 review M2): orphan and
-- cross-tenant tiers were preventable only app-side. Composite
-- tenant-scoped FKs to tariff_plan and fee_item close that hole the same
-- way migration 053113 hardened every other child table.
ALTER TABLE "fee_item"
  ADD CONSTRAINT "fee_item_tenant_id_id_key" UNIQUE ("tenant_id", "id");

ALTER TABLE "tariff_tier"
  ADD CONSTRAINT "tariff_tier_tenant_plan_fk"
    FOREIGN KEY ("tenant_id", "tariff_plan_id")
    REFERENCES "tariff_plan"("tenant_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "tariff_tier_tenant_fee_item_fk"
    FOREIGN KEY ("tenant_id", "fee_item_id")
    REFERENCES "fee_item"("tenant_id", "id") ON DELETE RESTRICT;
