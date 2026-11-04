-- 1104 修订：W1 旧用水类别枚举迁移 + W4 删放号预分配口径 + W5 用水地址。
-- 1) 旧枚举并入受控集（RESIDENTIAL→RES_METERED、NON_RESIDENTIAL→NON_RES）。
UPDATE water_account SET usage_category = 'RES_METERED' WHERE usage_category = 'RESIDENTIAL';
UPDATE water_account SET usage_category = 'NON_RES' WHERE usage_category = 'NON_RESIDENTIAL';
UPDATE tariff_plan   SET usage_category = 'RES_METERED' WHERE usage_category = 'RESIDENTIAL';
UPDATE tariff_plan   SET usage_category = 'NON_RES' WHERE usage_category = 'NON_RESIDENTIAL';
-- 2) 放号不再预分配口径（口径由上号链接的水表档案带出）。
ALTER TABLE water_account DROP COLUMN IF EXISTS pending_caliber;
-- 3) 用水地址（默认=安装地址，历史数据回填 addr）。
ALTER TABLE water_account ADD COLUMN IF NOT EXISTS use_addr varchar(200);
UPDATE water_account SET use_addr = addr WHERE use_addr IS NULL;
