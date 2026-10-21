-- 20261021 整改 任务F：银行代扣（协议/批次/扣款明细；PKMX/PKJG/DZMX 输出）。
-- 三道防重复防线：
--   防御① 协议有效（settle_account 至多一条 ACTIVE 协议，偏唯一索引）
--   防御② 生成批次时跳过同期已有 PENDING(在批)/SUCCESS(已扣) 的户
--   防御③ 数据库硬约束：同户同期至多一条 PENDING / 至多一条 SUCCESS
CREATE TABLE bank_debit_agreement (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  settle_account_id uuid NOT NULL,
  card_no_masked    text NOT NULL,
  card_last4        text NOT NULL,
  bank_code         text NOT NULL,
  holder_name       text,
  sign_date         date,
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CANCELLED')),
  cancelled_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid,
  CONSTRAINT debit_agreement_account_fk
    FOREIGN KEY (tenant_id, settle_account_id) REFERENCES settle_account (tenant_id, id)
);
CREATE UNIQUE INDEX bank_debit_agreement_tenant_id_key ON bank_debit_agreement (tenant_id, id);
-- 防御①：每户至多一条有效协议
CREATE UNIQUE INDEX bank_debit_agreement_live_uniq
  ON bank_debit_agreement (tenant_id, settle_account_id) WHERE status = 'ACTIVE';
ALTER TABLE bank_debit_agreement ENABLE ROW LEVEL SECURITY;
CREATE POLICY bank_debit_agreement_tenant ON bank_debit_agreement
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

CREATE TABLE bank_debit_batch (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  period       char(6) NOT NULL,
  total_count  int NOT NULL DEFAULT 0,
  total_amount bigint NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'GENERATED' CHECK (status IN ('GENERATED','EXECUTING','DONE')),
  generated_by uuid,
  executed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX bank_debit_batch_tenant_id_key ON bank_debit_batch (tenant_id, id);
CREATE INDEX bank_debit_batch_period ON bank_debit_batch (tenant_id, period);
ALTER TABLE bank_debit_batch ENABLE ROW LEVEL SECURITY;
CREATE POLICY bank_debit_batch_tenant ON bank_debit_batch
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

CREATE TABLE bank_debit_item (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  batch_id          uuid NOT NULL,
  settle_account_id uuid NOT NULL,
  period            char(6) NOT NULL,
  amount            bigint NOT NULL,
  status            text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SUCCESS','FAILED','SKIPPED')),
  bank_serial_no    text,
  fail_reason       text,
  payment_id        uuid,
  executed_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT debit_item_batch_fk
    FOREIGN KEY (tenant_id, batch_id) REFERENCES bank_debit_batch (tenant_id, id),
  CONSTRAINT debit_item_account_fk
    FOREIGN KEY (tenant_id, settle_account_id) REFERENCES settle_account (tenant_id, id)
);
CREATE UNIQUE INDEX bank_debit_item_tenant_id_key ON bank_debit_item (tenant_id, id);
CREATE INDEX bank_debit_item_batch ON bank_debit_item (tenant_id, batch_id);
-- 防御③：同户同期至多一条 PENDING（在批中，不可被第二个批次再扣）/ 至多一条 SUCCESS（已扣不重复）
CREATE UNIQUE INDEX bank_debit_item_pending_uniq
  ON bank_debit_item (tenant_id, settle_account_id, period) WHERE status = 'PENDING';
CREATE UNIQUE INDEX bank_debit_item_success_uniq
  ON bank_debit_item (tenant_id, settle_account_id, period) WHERE status = 'SUCCESS';
ALTER TABLE bank_debit_item ENABLE ROW LEVEL SECURITY;
CREATE POLICY bank_debit_item_tenant ON bank_debit_item
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

-- 银行字典
INSERT INTO sys_dict (id, tenant_id, category, code, name, seq, status, created_at, updated_at)
SELECT gen_random_uuid(), t.id, 'BANK_CODE', c.code, c.name, c.seq, 'ACTIVE', now(), now()
FROM tenant t
CROSS JOIN (VALUES
  ('ICBC', '工商银行', 10), ('ABC', '农业银行', 20), ('CCB', '建设银行', 30),
  ('BOC', '中国银行', 40),  ('COMM', '交通银行', 50)
) AS c(code, name, seq)
ON CONFLICT DO NOTHING;
