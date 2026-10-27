ALTER TABLE "meter_stock_movement"
  ADD COLUMN "from_warehouse_id" UUID,
  ADD COLUMN "from_location_id" UUID;
