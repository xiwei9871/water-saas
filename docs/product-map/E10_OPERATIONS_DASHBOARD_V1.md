# E10 — Operations Dashboard / Reporting V1（Product Gate Draft，Rev2）

> 状态：**Draft Rev2，按 Gate Review D7–D9 修订；implementation HOLD**。原则不变且更严格：**Dashboard 不拥有任何计算口径**。详细口径见 `E10_METRIC_DICTIONARY.md`。

## 1. 定位

一页固定指标卡 + drill-down 的运营首页。回答：**「本期干得怎么样，哪里卡住了，点进去就能处理。」**

## 2. 与既有 report 端点的关系（D7 修订——重要）

**不可再表述为「E10 直接复用现有 5 个 report endpoint」**。当前代码事实：

| 端点 | org scope 现状 |
|---|---|
| `GET /reports/meter-daily` | **已有** org scope（scoped 用户只见 subtree books，e2e 已验证） |
| `GET /reports/cashier-daily` | tenant-wide SQL（`tenant_id` 谓词），**无**统一 org scope |
| `GET /reports/ar-monthly` | 同上 |
| `GET /reports/collected-monthly` | 同上 |
| `GET /reports/recovery-rate` | 同上 |

且现有 e2e 只验证了 meter-daily 的 scoped 行为，**其余 4 个 financial report 的 scoped 语义从未被定义或测试**。

因此：

- E10 实现前，每个 metric 必须先完成 `Metric → SoT → Org Anchor → Scope predicate` 矩阵登记（字典已加 Org Anchor 列）
- 复用某 report 端点的前提是**先给它补/定义 scope 语义**，那是 API 层改造，不是前端整合
- 「Cashier collected」与「Territory collected」是**两个不同指标**（D8），现有 collected-monthly 只覆盖前者口径

## 3. 页面 IA

```
运营看板（默认 landing 候选，权限域自适应）
├─ 顶部：period 选择器（默认当前期）+ 营业所筛选（scope 内，tenant 级才有对比）
├─ 指标卡组 1「抄表」：应抄 | 已抄 | 未抄 | 异常读数 | 实抄率 | 估抄率
├─ 指标卡组 2「账务」：本期用水量 | 出账 | 辖区实收 | 柜员实收 | 回收率 | 欠费 | 预存余额
├─ 指标卡组 3「资产/远传」：ACTIVE 表 | 本期换表 | 本期销户 | 远传在线率
└─ 异常摘要组：OPEN 异常数 → 跳 E9 队列（E9 落地后启用）
```

每张卡：数值 + drill-down 链接。V1 数字卡为主，无重图表依赖。

## 4. Drill-down 契约

| 指标 | drill 目标 |
|---|---|
| 未抄户数 | Reading Plan 页（period + status=PENDING 预填） |
| 异常读数/异常户数 | E9 Exception Center（未上线前隐藏） |
| 欠费金额 | 账单列表（overdue 过滤）→ 户 360 |
| 辖区实收/出账 | 对应月报/明细列表 |
| 柜员实收 | cashier-daily 对应视图 |
| 远传在线率 | Remote source/device 页 |
| 换表/销户 | Account events / 水表列表（日期范围预填） |

原则：drill 到已存在列表页 + 预填 filter，不新建二级报表。

## 5. 口径红线（不变式）

- **禁前端算术**：金额一律后端出数，前端只格式化
- **单一口径源**：dashboard、月报、360 同一指标数值一致——同一 SoT query
- **scope 是行为不是过滤**：所有指标按 caller scope 出数（D7：这正是现有 financial reports 缺的，实现前先补）
- **CLOSED/REVERSED 处理**：逐指标在字典写死，无全局开关

## 6. Scope / 权限行为（D7+D8 修订）

- 指标卡按域分组显隐：无 `billing:read` → 账务组隐藏（不显示 0）
- **Org Anchor 决定一切**（D8）：
  - 抄表指标 → `ReadingBook.orgUnitId` 子树
  - 柜员业绩 → `Payment.orgUnitId`（收款发生的营业所）
  - 辖区应收/实收/回收率 → `Bill.waterAccountId` / `PaymentAlloc→Bill→WaterAccount` 的 E8 account coverage（账单**归属**的营业所）
  - 远传 → `RemoteSource.orgUnitId`
- 典型分裂场景已入字典：Branch A 的账单在 Branch B 柜台收款 → **柜员业绩记 B，辖区回收记 A**——两个指标并存，不得混算
- 营业所对比维度仅 tenant 级可见

## 7. shared-settle（D9 冻结）

- 安全行为现在就冻结：**归属无法安全判定 → fail closed**。OUTSTANDING/PREPAYMENT_BALANCE 等 settle 级指标 V1 仅 tenant 级可见。
- Pilot 只验证「是否需要显式 settle ownership model」，不决定是否先泄露。

## 8. Not in Scope（V1）

- 通用 BI / 自选维度 / 自定义公式 / 保存视图 / 导出
- 实时推送、预测分析、图表编辑器
- GIS 地图、DMA 分区计量
- 告警阈值配置（E9+ 的事）

## 9. Pilot 验证问题（D9：只留业务阈值，不留安全边界）

留给 Pilot 的：
- `REMOTE_ONLINE_RATE` 静默窗口（1h/6h/24h/一个采集周期——设备无 lastSeenAt，只能从 event 流推）
- `READING_MISSING` / `DEVICE_SILENT` 阈值（与 E9 同步）
- 指标首屏优先级（管理层每天真看哪几张）
- shared-settle ownership model 的需求证据
- 期间语义：dashboard period 跟自然月还是抄表周期（现 plan.period 即 YYYYMM，倾向复用）

**不留给 Pilot 的**：任何数据 scope 行为（D9——scope 现在就冻结，Pilot 不决定「先不先泄露」）。

## 10. UAT slices（草案）

- S1 所长：三组卡全显，数字 = 本所 scope 口径
- S2 收费员：仅账务组可见
- S3 drill：欠费 → 账单列表 → 360 账单 Tab
- S4 口径一致：dashboard 与对应 report 端点同 period 同 scope 返回值一致
- S5 柜员/辖区分离：A 户账单在 B 柜台收款 → 柜员实收计 B、辖区回收计 A（e2e 构造）

## 11. 冻结前置条件

1. 字典全指标 Org Anchor + scope predicate 签字（本轮已登记）
2. 复用的 report 端点完成 scope 语义改造（实现期工作项）
3. E9 异常口径稳定（异常数卡依赖 E9 detector）
4. Pilot 第一轮定业务阈值
