# 修改清单（相对基线 6b08db5）

`git diff --name-status 6b08db5..HEAD`：27 个文件，+2457 / −146。

## 数据库（Prisma）

| 状态 | 路径 |
|---|---|
| A | `apps/api/prisma/migrations/20261102000000_meter_model_rebuild/migration.sql` |
| A | `apps/api/prisma/migrations/20261102000001_returned_billable_chk/migration.sql` |
| M | `apps/api/prisma/schema.prisma` |

内容：water_account 增 cadence/anchorPeriod/zoneNo/segNo/routeKey/退号留痕（RETURNED）；reading_book 增 zoneNo/segNo；install_application 增 meterQty/caliberDetails/installMeters；新表 reader_zone / tenant_calendar_day / route_pattern（带 RLS）。

## API（apps/api/src）

| 状态 | 路径 | 说明 |
|---|---|---|
| A | `src/common/metering-model.ts` | 归集模式/区段号/工作日历工具（R2/R3/R4/R7） |
| M | `src/modules/customer/onboard-wire.ts` | 立户入参透传 cadence/zoneNo/segNo |
| M | `src/modules/customer/water-account.service.ts` | 户级频次/区段写入、syncZoneBook、R10 次月纳入 |
| M | `src/modules/installation/allocation.service.ts` | R11 口径明细放号、R12 安装信息闸门、R1 deallocate 退号 |
| M | `src/modules/installation/install.controller.ts` | `install-meters` 端点（R12）、`deallocate` 端点（R1） |
| M | `src/modules/metering/meter-reading.service.ts` | R15-5 抄表跳序 routeKey 学习 |
| M | `src/modules/metering/metering.module.ts` | 注册新 controller/provider/cron |
| A | `src/modules/metering/reader-zone.controller.ts` | R14 区号绑定 API（GET/POST/PATCH + options） |
| A | `src/modules/metering/reader-zone.service.ts` | R14 绑定校验/查询 |
| M | `src/modules/metering/reading-book.service.ts` | R7 册 zoneNo/segNo 建档 |
| M | `src/modules/metering/reading-plan.controller.ts` | auto-generate / redistribute / reorder 端点 |
| A | `src/modules/metering/reading-plan.cron.ts` | R5 前一工作日 18–23 点自动生成 |
| M | `src/modules/metering/reading-plan.service.ts` | 户级频次过滤+远传剔除+routeKey 排序+autoGenerate/redistribute/reorder |
| A | `src/modules/metering/route-pattern.controller.ts` | R15-6 命名排序模式 API |
| A | `src/modules/metering/route-pattern.service.ts` | R15-6 模式保存/应用/默认 |
| A | `src/modules/metering/tenant-calendar.controller.ts` | R3 工作日历 + R2/R3 参数 config |
| M | `src/modules/task/task.types.ts` | 新任务类型 ACCOUNT_SEG_ASSIGN（R10） |

## 测试（apps/api/test）

| 状态 | 路径 | 说明 |
|---|---|---|
| M | `test/account-allocation.e2e-spec.ts` | fixture 补 installCompletedAt（适配 R12 闸门） |
| M | `test/customer.e2e-spec.ts` | 按 R10 断言 planJoined=null、当月无计划项 |

## 前端（apps/web/src）

| 状态 | 路径 | 说明 |
|---|---|---|
| M | `api/types.ts` | ReadingBook.zoneNo/segNo |
| M | `pages/m/MobileReading.tsx` | R8 一律拍照 + 模块名「抄表作业/装表上户」 |
| M | `pages/metering/ReadingBooks.tsx` | 册建/改表单换区号+段号（R7/R13） |
| A | `pages/system/ReaderZones.tsx` | R14 区号管理页（绑定+归集模式+预留天数+日历） |
| M | `routes.tsx` | 注册 `/system/zones` |
