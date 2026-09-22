# E9 — Exception Center / Operational Work Queue V1（Product Gate Draft）

> 状态：**Draft for Gate**。E8 已合并（main @ 062bba5）。本 Epic 从「看一个户」（E8 Object Center）走向「今天该处理哪些户」——运营工作队列，不是新的业务事实源。

## 0. 冻结前提（先写死，再展开）

- **E9 不新建「异常事实表」**。异常存在性一律由现有 SoT 实时推导；只有「处理过程」需要持久化。
- WorkItem 表达的是：谁接单 / 何时确认 / 处理备注 / 是否忽略 / 何时关闭 / 关联哪个 anomalyKey。它**不复制业务事实**。
- `exception.status = OPEN` 不决定异常是否存在——SoT 推导决定。WorkItem 状态只是处理进度。
- 不做 SLA、升级链、通知推送、规则编辑器（Pilot 数据回来前不冻结这些）。

## 1. 定位与用户

| 用户 | 典型场景 |
|---|---|
| 抄表班长 | 每天早上看「本期未抄 / QC 失败 / 连续估抄」队列，派工处理 |
| 营业所主管 | 看本所全部异常分布，盯 BLOCKING 项（欠费、无表、无册） |
| 柜台收费员 | 缴费时发现异常 → 跳转 360 查看 → 回队列标记已处理/忽略 |
| 系统管理员 | 远传异常（UNBOUND/FAILED 事件、设备离线）集中入口 |

共同句式：**「给我一份今天需要我处理的清单，按严重度排，每条能直接跳到该户/该单据的处理界面。」**

## 2. 页面 IA

```
异常中心（独立菜单项，权限域内全员可见自己 scope 的队列）
├─ 顶部统计条：OPEN / ACK / IN_PROGRESS / 今日新增 / 今日关闭（本 scope）
├─ 过滤器：异常类型 | 严重度 | 状态 | 册/营业所 | 期间
├─ 队列表（分页）：severity | type | 对象(户号/单号) | 摘要 | 首次出现 | 最近复现 | assignee | status
└─ 行 → 详情抽屉：异常事实快照(推导参数) + 处理记录 + [跳转 360 / 计划 / 账单 / 远传事件]
```

跳转而非内嵌处理：异常中心是**调度层**，业务动作仍发生在各域页面（换表去水表 Tab、补抄去抄表页、收款去收费台）。

## 3. 异常目录 V1（推导型，逐条给 SoT 推导规则）

每条给出：type / 推导源 / 身份键 identity / 默认严重度建议 / 备注。

### 户/表层（customer 域推导）

| type | 推导 | identity | 建议级别 |
|---|---|---|---|
| `NO_ACTIVE_METER` | 非 CLOSED 户 ∧ ACTIVE installation = 0 | `wa:{accountId}` | WARNING |
| `MULTI_ACTIVE_METER` | ACTIVE installation > 1 | `wa:{accountId}` | WARNING |
| `NO_BOOK` | 非 CLOSED 户 ∧ 无 book_meter 成员行 ∧ 无有效 plan item | `wa:{accountId}` | WARNING |

### 抄表/结算层（metering 域推导）

| type | 推导 | identity | 建议级别 |
|---|---|---|---|
| `READING_MISSING` | 当前期 plan_item.status=PENDING ∧ plan.planDate < today | `wa:{accountId}:{period}` | WARNING |
| `READING_QC_FAILED` | 存在 qcStatus ∈ {REJECTED, MANUAL_REVIEW} 且未被 supersede 的读数 | `reading:{readingId}` | WARNING |
| `ESTIMATE_STREAK` | 连续 isEstimated settlement ≥ 阈值（沿用 `max_consecutive_estimates` 语义，阈值待定） | `wa:{accountId}` | WARNING |
| `UNSETTLED_PERIOD` | 可结算期已过 ∧ 无 settlement 行（billable 户） | `wa:{accountId}:{period}` | WARNING |
| `SETTLEMENT_DRAFT_STALE` | settlement status=DRAFT 超 N 天（N 待定，默认 7） | `settlement:{id}` | INFO |

### 账务层（billing/payment 域推导）

| type | 推导 | identity | 建议级别 |
|---|---|---|---|
| `UNPAID_BILL_OVERDUE` | bill.status ∈ {POSTED, PARTIAL_PAID} ∧ dueDate < today ∧ outstanding>0 | `bill:{billId}` | WARNING |
| `CLOSED_WITH_DEBT` | 户 CLOSED ∧ outstanding > 0 | `wa:{accountId}` | BLOCKING |
| `SHARED_SETTLE_SCOPE` | settle 上存在跨 org-scope 覆盖的户（E8 RC1 场景）→ 仅管理员可见 | `settle:{settleId}` | INFO |

### 远传层（remote 域推导）

| type | 推导 | identity | 建议级别 |
|---|---|---|---|
| `REMOTE_EVENT_UNBOUND` | raw_remote_event.status=UNBOUND | `event:{eventId}` | WARNING |
| `REMOTE_EVENT_FAILED` | raw_remote_event.status ∈ {FAILED, CONFLICT, WAITING_PLAN} | `event:{eventId}` | WARNING |
| `REMOTE_DEVICE_SILENT` | ACTIVE binding 设备最近一条 event 距现在 > N 天（**N 无 SoT 依据，需 Pilot 定阈值；V1 可作为 badge-only 不进队列**） | `device:{deviceId}` | INFO? |

> badge-only（只进 360/详情页警示、不进工作队列）：`ESTIMATED`（单期）、`REMOTE_DEVICE_SILENT`（阈值未定前）、未来新增的纯展示类 warning。

## 4. 严重度（待拍板 Q2）

V1 建议两档而非三档：

- **BLOCKING**：不处理就错账/漏账/资金风险（`CLOSED_WITH_DEBT`、未来 `SETTLEMENT_NEGATIVE` 类）
- **WARNING**：需要人工跟进但不阻断
- `INFO`：观察项——建议 V1 先不建，badge-only

严重度 **deterministic 由 type 决定**，不允许人工改级（避免运营口径漂移）。Pilot 若证明需要人工升级，E9.1 再议。

## 5. WorkItem 生命周期（待拍板 Q6）

建议 V1 只用三个状态 + 一个终态：

```
OPEN → ACKNOWLEDGED → RESOLVED
  ↘ IGNORED（终态，需 note 必填）
```

- **自动消失**：SoT 推导不再命中（如补抄完成、账单付清）→ WorkItem 自动转 `RESOLVED_AUTO`，留痕但不再占队列。禁止「事实已消失但 item 仍 OPEN」的假队列。
- **IGNORED 的复活**：同一 anomalyKey 被忽略后事实仍存在 → 不复活（避免刷屏）；事实先消失再出现 → 新 WorkItem。
- `IN_PROGRESS`：V1 建议**砍掉**——ACKNOWLEDGED 已够表达「有人认领在办」，多一档只增加状态维护成本。待拍板。

## 6. Org Scope（继承 E8 收口规则）

- 户锚点异常：走 `waterAccount → planItem → plan → book.orgUnitId` 覆盖规则——**任一覆盖册出界 → 整条异常对 scoped 用户不可见**（与读 scope 完全一致，不搞第二套）。
- 无册户异常（NO_BOOK、NO_ACTIVE_METER 等）：沿用宽放——本来就需要人去补册，藏起反而漏。
- `SHARED_SETTLE_SCOPE` / 跨所结算户相关：scoped 用户**不可见**（strict），仅租户级角色可见——这正是 Pilot 要验证的边界。
- 远传异常：event → binding → installation → account 能锚到户则用户规则；UNBOUND 事件锚到 `remote_source.orgUnitId`；`orgUnitId=null`（tenant-wide 源）→ 仅租户级角色。
- WorkItem 的 assignee 只能是**能看到该异常的 staff**（assignment 时校验 scope）。

## 7. UAT slices（草案）

- S1 抄表班长：Branch A 用户只看到 Branch A 册覆盖户的 READING_MISSING/QC_FAILED，Branch B 户异常不出现
- S2 处理闭环：QC 失败读数 → 队列出现 → 认领(ACK) → 去抄表页补抄 → 事实消失 → item 自动 RESOLVED_AUTO
- S3 忽略语义：NO_BOOK 户 IGNORED+备注 → 队列消失；事实仍在但不再打扰
- S4 欠费：CLOSED_WITH_DEBT 户 → BLOCKING 置顶 + 跳 360 账单 Tab
- S5 scope 边界：shared-settle 户异常对 Branch A 不可见；admin 可见
- S6 无权限域：无 metering:read 的用户看不到抄表类异常（权限域隔离同 D6）

## 8. Not in Scope（V1 明确不做）

- SLA / 超时升级 / 通知推送 / 邮件短信
- 规则编辑器 / 阈值自配（阈值先硬编码进推导）
- 异常评论线程 / 附件
- 跨租户/集团聚合
- 批量操作（V1 单条处理；批量若 Pilot 证明高频再加）
- 自动派单（V1 手动 assignee；自动派工属工作流 Epic）

## 9. Gate 待拍板问题（用户已列 6 问，此处给建议答案）

| # | 问题 | 建议 |
|---|---|---|
| Q1 | 哪些进队列哪些 badge-only | §3 表已分；原则：需要「人去做一个动作」的进队列，纯状态的做 badge |
| Q2 | 严重度档位 | V1 = {BLOCKING, WARNING}，deterministic by type，INFO 暂不建 |
| Q3 | identity 键 | `wa:{accountId}`（户级）/ `wa:{accountId}:{period}`（期级）/ `bill:{id}` `reading:{id}` `settlement:{id}` `event:{id}` `device:{id}` `settle:{id}`（对象级）——**前缀+对象键，保证稳定去重** |
| Q4 | 事实消失后 WorkItem | 自动 `RESOLVED_AUTO`；IGNORED 不复活除非事实消失后再出现 |
| Q5 | scope | 完全继承 E8 覆盖链 + 远传 orgUnitId 锚；shared-settle 类仅租户级 |
| Q6 | 状态集 | 建议 {OPEN, ACKNOWLEDGED, RESOLVED, IGNORED} + 系统态 RESOLVED_AUTO；砍 IN_PROGRESS |
