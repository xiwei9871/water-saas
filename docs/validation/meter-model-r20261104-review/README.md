# 20261104 核查报告修订落实 — 验收记录

分支：`feat/meter-model-r20261104-review`（基线 fix1103 @ d9ef5fd）

## 总清单 6 项 + 遗留 1 项

| # | 项 | 状态 | 证据 |
|---|---|---|---|
| 1 | 用水类别枚举去重 | 已实施 | `USAGE_CATEGORY_OPTIONS` 仅 5 受控值（旧别名仅渲染回落）；迁移 UPDATE 历史 RESIDENTIAL/NON_RESIDENTIAL |
| 2 | 法定工作日历 | 已实施 | `STATUTORY_CALENDAR` 预置 2025–2026（国办发明电〔2025〕7号），优先级 手动例外>法定>周一~五；区号页提示文案更新 |
| 3 | 漏损→产销差 | 已实施 | MeterRelations 卡片/字段/率全部改「产销差」，与 DMA 模块一致 |
| 4 | 上号逻辑重构 | 已实施 | `pending_caliber` 列下线（迁移）；放号只按数量放空号（口径明细改参考软提示）；上号表号带出口径/用户名/安装地址；新增 `use_addr` 用水地址（默认=安装地址可修订） |
| 5 | 统一查询表头排序 | 已实施 | `smartSorter`（数值/金额数值、日期按时间、文本 zh-CN、口径走数值）；全动态列三态 ↑/↓ |
| 6 | 口径数值排序 | 已实施 | `caliberNum/caliberSorter` 共用工具；表计列表口径列 sorter；字典数组顺序保持 DN15<DN100 |
| 7 | R5 自动生成可视化 | 已实施 | `GET /reading-plans/gen-runs` + 区号页「自动生成运行记录」卡片（OK/SKIPPED/FAILED 标签+CRON_TENANT_IDS 提示） |

## W1–W8 对应

- W1：下拉仅 5 类 + 迁移清旧码
- W2：法定日历默认 + 手动覆盖
- W3：无「漏损」字样残留（总分表）
- W4：待上号列表无预占口径；放号纯数量
- W5：表号带出三要素 + 用水地址字段（默认=安装地址可修订）
- W6：运行记录卡片 + cron 配置提示
- W7：表头三态排序按类型适配
- W8：DN 数值排序（DN15<DN100）

## 验证

- spec：account-allocation + meter-model + customer = **71/71 PASS**
- api/web build：PASS
- 迁移 `20261104120000_r1104_review`：drop pending_caliber + add use_addr + 旧枚举 UPDATE（测试库已手工挂，CI 将全量迁移验证）
