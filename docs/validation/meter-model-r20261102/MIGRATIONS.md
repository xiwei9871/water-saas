# Prisma 迁移记录

## 本轮新增迁移（2 个）

1. `apps/api/prisma/migrations/20261102000000_meter_model_rebuild/migration.sql`
   - water_account 增列：cadence、anchorPeriod、zoneNo、segNo、routeKey、
     returnedAt、returnReason；AccountStatus 枚举增 RETURNED
   - reading_book 增列：zoneNo、segNo
   - install_application 增列：meterQty、caliberDetails、installMeters、
     installMeterNo、installCaliber、installCompletedAt
   - 新表：reader_zone、tenant_calendar_day、route_pattern（均含 tenant_id + RLS）
   - 存量册 cadence 回填到 water_account
2. `apps/api/prisma/migrations/20261102000001_returned_billable_chk/migration.sql`
   - AccountStatus 枚举补 PENDING_ASSIGN（测试库缺值修正）
   - water_account billable 一致性 CHECK（billable 随 status/usageCategory 导出）

## 应用状态（实测 `_prisma_migrations`）

| 库 | 20261102000000 | 20261102000001 | 说明 |
|---|---|---|---|
| `watersaas`（dev, localhost:5432） | finished（1 step） | **未应用** | dev 库被 P3009 阻断（见下） |
| `watersaas_test` | finished（1 step） | finished（1 step） | 测试库两个迁移均已应用 |

## P3009 失败迁移记录（未处理，待人工确认）

- 失败迁移 ID：**`20260918130000_tariff_tier_composite_fk`**
- 所在库：`watersaas`（dev）
- 记录：`finished_at=NULL, rolled_back_at=NULL, applied_steps_count=0`，
  started_at `2026-10-27 05:36:55.820893 UTC`（本轮开工前既有的历史失败）
- 现场证据：`pnpm exec prisma migrate deploy`（dev 库）输出：
  ```
  Error: P3009
  migrate found failed migrations in the target database, new migrations will
  not be applied.
  The `20260918130000_tariff_tier_composite_fk` migration started at
  2026-10-27 05:36:55.820893 UTC failed
  ```
- 另有两行 rolled_back：`20260918053113_harden_rls_fk`、`20260918045712_init`
- 影响：dev 库 `migrate deploy` 被该失败记录阻断；本轮迁移 20261102000000
  已在 dev 库 finished（历史会话中应用），20261102000001 尚未应用。
- **处置：按任务要求未经确认不修改迁移历史、不动生产库。**如需推进，
  建议人工审查该迁移的半成品状态后用 `prisma migrate resolve
  --rolled-back 20260918130000_tariff_tier_composite_fk` 解除阻断，
  再 `migrate deploy` 补齐。

## 备注

- `watersaas_test` 另有一行 rolled_back：`20261016120000_staff_pref_report_v2`（存量）。
- 本轮未在任何库执行 destroy/reset。
