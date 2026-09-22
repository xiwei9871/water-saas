# E9 — Exception Center / Operational Work Queue V1（Product Gate，Rev2）

> 状态：**Rev2，按 Gate Review D1–D9 修订**。E8 已合并（main @ 062bba5）。本 Epic 从「看一个户」（E8 Object Center）走向「今天该处理哪些户」——运营工作队列，不是新的业务事实源。

## 0. 冻结前提（Rev2 冻结版）

- **E9 不新建「异常事实表」**。异常存在性一律由现有 SoT 实时推导；只有「处理过程」持久化为 WorkItem **episode**。
- **Detector = 纯事实计算**，`SoT → AnomalyFact[]`，不依赖 `work_item.status` 判定事实存在。（D1）
- **`GET /exceptions` 不得 INSERT / UPDATE / auto-resolve**。Reconcile 是独立机制（定时 / 显式 refresh / 域写后触发——实现期再选），不得隐藏在查询副作用里。（D1）
- `anomalyKey` = **deterministic fact identity**（如 `wa:{id}:NO_ACTIVE_METER`）；WorkItem = **一次 episode**。同一 key 可在不同时间重复发生；同 tenant+key 同一时间最多一个未清除 episode。（D2）
- **RESOLVED 是 fact-driven 的**：fact active → 不得 RESOLVED。人工 resolve 必须重跑 detector，fact 仍在 → `409 ANOMALY_STILL_ACTIVE`。（D3）
- 新增 E9 聚合权限 `exception:read` / `exception:manage`；drill-down 进业务页面仍要求原 domain permission——Exception Center 不是 RBAC bypass。（D4）
- 不做 SLA、升级链、通知推送、规则编辑器；severity deterministic by type，不允许人工改级。

## 1. 定位与用户

| 用户 | 典型场景 |
|---|---|
| 抄表班长 | 每天早上看「QC 待复核 / QC 驳回 / 连续估抄」队列，派工处理 |
| 营业所主管 | 看本所异常分布，盯 BLOCKING 项 |
| 柜台收费员 | 缴费时发现异常 → 跳 360 → 回队列标记 |
| 远传管理员 | UNBOUND / FAILED / CONFLICT / WAITING_PLAN 事件集中入口 |

共同句式：**「给我一份今天需要我处理的清单，按严重度排，每条能直接跳到该户/该单据的处理界面。」**

## 2. 页面 IA

```
异常中心（exception:read 可见，内容按 scope+权限域裁剪）
├─ 顶部统计条：OPEN / ACK / 今日新增 / 今日清除（本 scope）
├─ 过滤器：异常类型 | 严重度 | 状态 | 册/营业所 | 期间
├─ 队列表（分页）：severity | type | 对象 | 摘要 | episode 开始 | assignee | status
└─ 行 → 详情抽屉：异常事实快照(推导参数) + 处理记录 + [跳转 360 / 计划 / 账单 / 远传事件]
```

跳转而非内嵌处理：异常中心是**调度层**，业务动作发生在各域页面；且跳过去之后仍需原域权限（D4）。

## 3. 异常目录 V1

> **事实修正**：E8 `/360` 当前实现的 deterministic warning 是 `NO_ACTIVE_METER` / `MULTI_ACTIVE_METER`（无 `NO_BOOK`）。E9 是沿用同一方法、**由 E9 新增跨域 detector**，不是搬 E8 现成清单。

### 3.1 第一批冻结 detector（V1 active queue）

| type | severity | 推导（SoT 谓词） | identity | scope anchor |
|---|---|---|---|---|
| `NO_ACTIVE_METER` | WARNING | 非 CLOSED ∧ billable ∧ ACTIVE installation = 0；排除 MONITORING | `wa:{accountId}:NO_ACTIVE_METER` | account coverage |
| `MULTI_ACTIVE_METER` | **BLOCKING** | ACTIVE installation > 1（用量归属歧义→错账风险） | `wa:{accountId}:MULTI_ACTIVE_METER` | account coverage |
| `NO_BOOK` | WARNING | 非 CLOSED ∧ **billable=true** ∧ 无 BookMeter ∧ 无有效 plan item；**排除 MONITORING/非 billable** | `wa:{accountId}:NO_BOOK` | account coverage（无册宽放保留） |
| `READING_QC_REVIEW` | WARNING | meter_reading qcStatus=MANUAL_REVIEW 且未 superseded | `reading:{readingId}:QC_REVIEW` | account coverage |
| `READING_QC_REJECTED` | WARNING | qcStatus=REJECTED 且未 superseded | `reading:{readingId}:QC_REJECTED` | account coverage |
| `ESTIMATE_STREAK` | WARNING | 连续 isEstimated settlement ≥ 阈值（**复用/抽取 SettlementService 现有 estimateStreaks 计算，不复制算法**；阈值 Pilot 定，默认 ≥2） | `wa:{accountId}:ESTIMATE_STREAK` | account coverage |
| `REMOTE_EVENT_UNBOUND` | WARNING | raw_remote_event.status=UNBOUND | `event:{eventId}` | source.orgUnitId |
| `REMOTE_EVENT_WAITING_PLAN` | WARNING | status=WAITING_PLAN | `event:{eventId}` | source → binding → account coverage |
| `REMOTE_EVENT_FAILED` | WARNING | status=FAILED | `event:{eventId}` | 同上 |
| `REMOTE_EVENT_CONFLICT` | WARNING | status=CONFLICT（同 event key 不同 payload，数据完整性信号） | `event:{eventId}` | 同上 |
| `UNPAID_BILL_OVERDUE` | WARNING | bill.status∈{POSTED,PARTIAL_PAID} ∧ dueDate<today ∧ 本 bill outstanding>0（仅依赖 Bill + 本 bill PaymentAlloc → **bill/account-level fact**） | `bill:{billId}:OVERDUE` | **account coverage（非 settle-level）** |

REMOTE 队列**不含** `RECEIVED`（正常瞬态）/ `CONVERTED`（已成功）/ `IGNORED`（已处理）。

### 3.2 Gate 条目但不进第一批（待 Pilot 定义阈值）

| type | 卡点 |
|---|---|
| `READING_MISSING` | `plan_item.status=PENDING` ≠ 异常——PENDING 是正常待办。需定义「何时算 missing」：planDate 当天结束 / +1 天 / plan CLOSED 后 / 抄表窗口？当前只有 planDate 无 deadline。**Pilot 定阈值前不进 active queue，避免队列退化成待抄任务列表** |
| `DEVICE_SILENT` | RemoteDevice 无 `lastSeenAt`，只能从 raw event 流推算；silent 窗口取决于设备上报频率，业务阈值未定 |
| `SETTLEMENT_DRAFT_STALE` | DRAFT 超 N 天——N 无依据，Pilot |
| `CLOSED_WITH_DEBT` | 依赖 `outstandingTx` 的 **settle 净头寸** → 必须 strict settle scope / fail closed（D5）。安全规则已冻结，是否进 V1 队列看 Pilot |
| `SHARED_SETTLE_SCOPE` | settle 级聚合事实，仅 tenant 级可见；Pilot 验证 shared-settle ownership model |

### 3.3 badge-only（只在 360/详情展示，不进队列）

- 单期 `ESTIMATED`（无 streak）
- `DEVICE_SILENT` 阈值未定前的展示态
- 未来新增的纯状态提示

## 4. 严重度（Q2 冻结）

- V1 = `{BLOCKING, WARNING}`，**deterministic by type**，用户不可改级，不建 INFO。
- V1 唯一 BLOCKING = `MULTI_ACTIVE_METER`（直接造成用量归属歧义）。其余均为 WARNING；Pilot 证明需要升级再调整映射。
- 「age 升级」（WARNING 挂久变 BLOCKING）是另开设计，不在 V1。

## 5. WorkItem 生命周期（Q3+Q4+Q6 冻结）

**anomalyKey = fact identity；WorkItem = episode。**（D2）

- `anomalyKey` 例：`wa:{id}:NO_ACTIVE_METER`、`bill:{id}:OVERDUE`、`event:{id}`
- 同一 key 可多次发生：第 1 次 → episode #1；事实消失 → episode cleared；再次出现 → **新 episode** #2
- 约束语义：`UNIQUE(tenant_id, anomaly_key) WHERE cleared_at IS NULL`（Prisma 不支持 partial index → migration 原生 SQL，见 Domain Design §4）

**状态集（Q6 冻结：砍 IN_PROGRESS）**：

```
OPEN → ACK → RESOLVED
  ↘ IGNORED（仅抑制本 episode）
```

- `ACK` = 我知道了/有人接了——已足够表达处理中，不加 IN_PROGRESS
- `RESOLVED` = **fact-driven**（D3）：
  - 自动路径：reconciler 发现 fact 消失 → `status=RESOLVED, resolutionSource=AUTO, clearedAt=now`
  - 人工路径：`POST resolve` → **重跑该 key 的 detector** → fact 仍 active → `409 ANOMALY_STILL_ACTIVE`；fact 已消失 → `RESOLVED(resolutionSource=MANUAL)`
  - `RESOLVED_AUTO` 不作为独立 status，降为 `resolutionSource` 字段（AUTO/MANUAL）
- `IGNORED`：只抑制**本 episode**（需 note 必填）。fact 消失 → episode cleared；**未来重新发生 → 新 episode，不继承旧 IGNORED**
- 「操作员点了 RESOLVED 但事实还在 → 自动 reopen」的旧设计**废弃**——被 D3 的 409 拦截语义取代

## 6. Scope 与 RBAC（Q5 冻结，D4+D5）

### 6.1 RBAC（新增）

| 权限 | 语义 |
|---|---|
| `exception:read` | 看 Exception Center projection（队列/详情/统计条） |
| `exception:manage` | ACK / IGNORE / assign / note / resolve |

- drill-down 到业务页面仍要求原 domain permission：看见 `REMOTE_EVENT_CONFLICT` 不授予 `metering:remote:manage`；看见 `UNPAID_BILL_OVERDUE` 不授予 `billing:read`。与 E8 D6 同思想。
- assign 目标 staff 必须对该 anomaly 的 scope 可见（`ASSIGNEE_OUT_OF_SCOPE` 403）。

### 6.2 Data scope（继承 E8，按 detector 依赖分层）

| detector 依赖 | scope 规则 |
|---|---|
| 户锚点（wa/reading/bill 级 fact） | E8 account coverage：`wa→planItem→plan→book.orgUnitId`；任一覆盖册出界→不可见；无册宽放保留 |
| bound remote event | event→binding→installation→account 覆盖链 |
| UNBOUND remote event | `remote_source.orgUnitId` 子树；null → 仅 tenant 级 |
| **settle 净头寸 detector**（如 CLOSED_WITH_DEBT 依赖 outstandingTx） | **strict settle scope / fail closed** |

**D5 关键区分**：`UNPAID_BILL_OVERDUE` 只依赖 `Bill + 本 bill PaymentAlloc` → 是 bill/account-level fact，走 account scope，**不因为 settle 共享就升成 tenant-only**。只有真正依赖 settle 聚合净头寸的 detector 才要求 strict settle scope。

### 6.3 shared settle

- 当前安全行为冻结：**归属无法安全判定 → fail closed**，不放松现有 scope。
- Pilot 只验证「是否需要显式 shared-settle ownership model」——不决定「先不先泄露」。

## 7. UAT slices（Rev2）

- S1 scope：Branch A 用户只见 A 覆盖户的 QC/STREAK 异常；B 户不出现
- S2 闭环：QC REJECTED → 队列 → ACK → 补抄后事实消失 → reconcile 后 RESOLVED(AUTO)
- S3 人工 resolve 拦截：fact 仍在时点 resolve → `409 ANOMALY_STILL_ACTIVE`
- S4 IGNORED episode 语义：IGNORED+note → 离开活动队列；fact 消失再出现 → **新 episode** 重新 OPEN
- S5 RBAC：有 `exception:read` 无 `billing:read` → 能看 UNPAID_BILL_OVERDUE 列表项，点 drill 到账单页被拒
- S6 settle 分层：UNPAID_BILL_OVERDUE（bill-level）scoped 可见；CLOSED_WITH_DEBT（settle-level）跨所 settle → scoped 不可见、tenant 级可见

## 8. Not in Scope（V1）

- SLA / 超时升级 / 通知推送 / 邮件短信 / age 升级
- 规则编辑器 / 阈值自配
- 评论线程 / 附件 / 批量操作 / 自动派单
- `READING_MISSING`、`DEVICE_SILENT`、`SETTLEMENT_DRAFT_STALE`（§3.2，待 Pilot）
- 跨租户聚合

## 9. Gate 六问（Rev2 已按 D1–D6 定稿）

| # | 问题 | 冻结结论 |
|---|---|---|
| Q1 | 队列 vs badge | §3.1 冻结 11 类进队列；§3.2 阈值类待 Pilot；§3.3 badge-only |
| Q2 | 严重度 | {BLOCKING, WARNING}，deterministic by type；V1 仅 MULTI_ACTIVE_METER=BLOCKING |
| Q3 | identity | anomalyKey=fact identity（`wa:{id}:TYPE` / `bill:{id}:TYPE` / `event:{id}`）；WorkItem=episode；`UNIQUE(tenant,key) WHERE cleared_at IS NULL` |
| Q4 | 生命周期 | RESOLVED fact-driven；人工 resolve 重跑 detector，fact active→409；IGNORED 仅抑制本 episode |
| Q5 | scope | account coverage 继承 E8；UNBOUND event→source.orgUnitId；**bill-level≠settle-level**；shared-settle fail closed |
| Q6 | 状态集 | {OPEN, ACK, IGNORED, RESOLVED} + resolutionSource{AUTO,MANUAL}；无 IN_PROGRESS/RESOLVED_AUTO |
