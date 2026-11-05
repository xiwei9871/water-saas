-- v3 X9：结算户级预存阈值覆盖（分）；null 回退租户参数规则。
ALTER TABLE settle_account ADD COLUMN IF NOT EXISTS prepay_warn_cent BIGINT;
