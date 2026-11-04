# 20261104 遗留问题核查报告修订落实 — 验收记录

分支：`feat/meter-model-r20261104-review2`（基线 feat1104 @ d28fb48）

| # | 项 | 状态 | 证据 |
|---|---|---|---|
| 1.1 | R7 区段号编码未生效 | 已修复 | 根因=控制器 `parsed` 白名单丢弃 zoneNo/segNo（service 早已支持）→ 透传修复；迁移同步历史册 bookNo=区+段 |
| 1.2 | R13 册周期字段残留 | 已修复 | reading_book 删 scheduleDay/cadence/anchorPeriod（schema+迁移+service/controller/plan/前端全链路；syncZoneBook/兜底册创建点同步清理） |
| 1.3 | 口径缺 DN32 | 已修复 | CALIBER_OPTIONS 补 DN32（DN 数值序保持） |
| 2 | 周检换表自动生成 | **已实施（报告误判）** | `service-order.cron.ts scanCheckDueDaily` 每日 02:00 扫描 checkPeriodYears+lastCheckDate 到期自动建 PERIODIC_CHECK 工单（AUTO_CHECK 来源）；报告按「自动生成换表」字样检索 0 次系命名差异。仍需 CRON_TENANT_IDS 配置生效 |
| 3 | 法定节假日批量导入 | 已实施 | `POST /metering/calendar/import`（days 数组+clearYear 按年清空重导+逐行错误回执）；区号页「导入节假日 CSV」按钮（日期,类型 两列） |

测试：meter-model + account-allocation spec 43/43 PASS；api/web build PASS。
迁移 `20261105000000_book_r13_r7`：drop 册三字段 + 历史册 bookNo 改区段号。
