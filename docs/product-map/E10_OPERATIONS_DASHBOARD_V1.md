# E10 — Operations Dashboard / Reporting V1（Product Gate Draft）

> 状态：**Draft，冻结排期晚于 E9**。原则更严格：**Dashboard 不拥有任何计算口径**，只消费 E6–E9 已定义的 SoT / query service / report endpoint。详细口径见 `E10_METRIC_DICTIONARY.md`。

## 1. 定位

一页固定指标卡 + drill-down 的运营首页。回答管理层/班长一句话问题：**「本期干得怎么样，哪里卡住了，点进去就能处理。」**

与既有 `report:*` 模块的关系：E10 是这些口径的**呈现层整合**，不新造统计。已有端点直接复用：

| 已有 | E10 复用为 |
|---|---|
| `GET /reports/meter-daily` | 抄表进度卡（应抄/已抄/未抄/异常） |
| `GET /reports/ar-monthly` | 出账金额卡 |
| `GET /reports/collected-monthly` | 实收金额卡（含渠道拆分） |
| `GET /reports/recovery-rate` | 回收率卡 |
| `GET /reports/cashier-daily` | 收款渠道卡 |

E10 新增的仅是少数「状态计数」指标（户/表/异常数），且每条必须先在字典里登记 SoT 后才允许实现。

## 2. 页面 IA

```
运营看板（默认 landing 候选，权限域自适应）
├─ 顶部：period 选择器（默认当前期）+ 营业所筛选（scope 内）
├─ 指标卡组 1「抄表」：应抄 | 已抄 | 未抄 | 异常户 | 实抄率 | 估抄率
├─ 指标卡组 2「账务」：本期用水量 | 出账金额 | 实收金额 | 回收率 | 欠费金额 | 预存余额
├─ 指标卡组 3「资产/远传」：ACTIVE 表 | 本期换表 | 本期销户 | 远传在线率
└─ 异常摘要组：OPEN 异常数 → 跳 E9 队列（E9 落地后启用，之前隐藏）
```

每张卡：`数值 + 环比箭头(可选) + drill-down 链接`。无图表库重度依赖——V1 数字卡为主，趋势条用简单 sparkline 即可。

## 3. Drill-down 契约

| 指标 | drill 目标 |
|---|---|
| 未抄户数 | Reading Plan 页（预填 period + status=PENDING 过滤） |
| 异常户数 | E9 Exception Center（E9 未上时链接到 360 入口或隐藏） |
| 欠费金额 | 账单列表（status∈POSTED/PARTIAL_PAID + overdue）→ 户 360 |
| 实收/出账 | 对应月报页（已有 report 前端或明细列表） |
| 远传在线率 | Remote source/device 管理页 |
| 换表/销户 | Account events / 水表列表（预填日期范围） |

原则：**drill 到已存在的列表页 + 预填 filter**，不新建二级报表页。

## 4. 口径红线（继承 E8/E9 不变式）

- **禁止前端算术**：不允许 `sum(bills) - sum(payments)` 之类在浏览器里组装口径。金额一律后端算好返回。
- **单一口径源**：同一指标在 dashboard、月报、360 上数值必须一致——都从字典登记的 service/query 出数。
- **scope 是行为不是过滤**：所有指标按 caller org scope 出数；营业所对比仅 tenant 级角色可见。
- **CLOSED/REVERSED 处理**：逐指标在字典写死（如欠费含 CLOSED 户、实收不含 REVERSED 流水），不做全局开关。

## 5. Scope / 权限行为

- 指标卡按域分组显隐：无 `billing:read` → 账务组整组隐藏（不是显示 0）。
- 全租户角色看全量 + 营业所对比维度；scoped 角色看本所子树数字。
- period 选择器仅允许**已生成的期间**（有 plan/settlement 的 period 集合），不允许任意日期范围——防口径漂移。

## 6. Not in Scope（V1）

- 通用 BI / 自选维度 / 自定义公式 / 保存视图
- 导出 Excel/PDF（Pilot 后再议，先保证数字对）
- 实时刷新 / websocket（V1 进页查询 + 手动刷新）
- 预测、同比深度分析、图表编辑器
- GIS 地图、DMA 分区计量视图
- 告警阈值配置（那是 E9+ 的事）

## 7. Pilot 验证问题

- 哪些指标管理层真的每天看？（→ 决定首屏 6 张卡）
- 「营业所对比」在县域水司是否敏感数据？（→ 决定对比维度是否 scoped-only）
- 欠费金额点进去之后，操作员下一步动作是什么？（→ drill 目标是否要直达收款台）
- 期间选择粒度：自然月 vs 抄表周期，实际业务按哪个算？（→ 字典 period 语义收口）

## 8. UAT slices（草案）

- S1 所长登录：三组卡全显，数字 = 本所 scope 口径，与对应 report 端点一致
- S2 收费员：仅账务组可见，抄表/资产组隐藏
- S3 drill：欠费金额 → 账单列表过滤生效 → 单条 → 360 账单 Tab
- S4 一致性：dashboard 实收数字 == `collected-monthly` 同 period 返回值（直接复用断言）
- S5 环比/趋势（若保留）：上期无数据时显示 — 而非 0

## 9. 冻结前置条件

1. `E10_METRIC_DICTIONARY.md` 全指标口径签字（SoT/分母/CLOSED/REVERSED 各项）
2. E9 异常口径稳定（异常户数卡依赖 E9 detector）
3. Pilot 第一轮：确认指标优先级排序与 drill 目标
