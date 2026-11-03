# P3009 迁移失败处置方案（待审批，未执行）

## 现状（2026-11-02 复核）

- 失败迁移：`20260918130000_tariff_tier_composite_fk`
- dev 库 `watersaas` `_prisma_migrations`：started 2026-10-27 05:36:55，
  finished_at/rolled_back_at 均 NULL，applied_steps_count=0
- 实测对象：`tariff_tier_tenant_plan_fk` / `tariff_tier_tenant_fee_item_fk`
  / `fee_item_tenant_id_id_key` 均不存在 → 首个 DDL 前即失败，库内无半成品
- watersaas_test 有同样失败行；watersaas_fresh（全新库）51/51 成功——
  即迁移 SQL 本身在空库可跑，dev 库失败系当日数据/对象状态导致

## 失败原因（推定）

迁移含两步：①`fee_item` 加 `(tenant_id,id)` 复合 UNIQUE；②`tariff_tier`
加两复合 FK。任一失败均全事务回滚。dev 库可能存在：(a) fee_item 已有
(tenant_id,id) 重复行使 UNIQUE 建不上；(b) tariff_tier 含跨租户/孤儿行
违反新 FK。**未对 dev 库执行数据探查 SQL（只读 `_prisma_migrations`
与对象存在性），处置前必须先查明。**

## 处置步骤（审批后执行，全程只限 dev 库）

```sql
-- 探查（只读）
SELECT tenant_id, id, count(*) FROM fee_item GROUP BY 1,2 HAVING count(*)>1;
SELECT t.* FROM tariff_tier t
 LEFT JOIN tariff_plan p ON p.tenant_id=t.tenant_id AND p.id=t.tariff_plan_id
 WHERE p.id IS NULL OR p.tenant_id<>t.tenant_id;
SELECT t.* FROM tariff_tier t
 LEFT JOIN fee_item f ON f.tenant_id=t.tenant_id AND f.id=t.fee_item_id
 WHERE f.id IS NULL OR f.tenant_id<>t.tenant_id;
```
1. 清理探查到的违规数据（业务确认后 UPDATE/DELETE 并留审计）
2. `pnpm exec prisma migrate resolve --rolled-back 20260918130000_tariff_tier_composite_fk`
   （dev 库 DATABASE_URL）
3. `pnpm exec prisma migrate deploy` 重放该迁移及后续
4. 校验约束已建、_prisma_migrations 行 finished

## 风险与回退

- resolve --rolled-back 只改迁移登记表，不动业务数据
- 清理违规数据前必须业务确认（tariff_tier 孤儿行归属）
- watersaas_test 的同名失败行同法处理（测试库可直接重建）
- **生产库不在本方案范围——生产未授权，任何处置需另行审批**
