# E9 — Exception Center / Operational Work Queue V1（Product Gate，Rev3）

> 状态：**Rev3，按 Gate Review D10–D14 修订**。E8 已合并（main @ 062bba5）。本 Epic 从「看一个户」（E8 Object Center）走向「今天该处理哪些户」——运营工作队列，不是新的业务事实源。

## 0. 冻结前提

- **E9 不新建「异常事实表」**。异常存在性一律由现有 SoT 实时推导；只有「处理过程」持久化为 WorkItem **episode**。
- **Detector = 纯事实计算**，`SoT → AnomalyFact[]`，不依赖 `work_item.status` 判定事实存在。（D1）
- **`GET /exceptions` 不得 INSERT / UPDATE / auto-resolve**。Reconcile 是独立机制（定时 / 显式 refresh / 域写后触发——实现期再选）。（D1）
- `anomalyKey` = **deterministic fact identity**；WorkItem = **一次 episode**。同一 key 可重复发生；同 tenant+key 同一时间最多一个未清除 episode：`UNIQUE(tenant_id, anomaly_key) WHERE cleared_at IS NULL`。（D2）
- **RESOLVED 是 fact-driven**：fact active → 不得 RESOLVED；人工 resolve 重跑 detector，fact 仍在 → `409 ANOMALY_STILL_ACTIVE`。（D3）
- 新增聚合权限 `exception:read` / `exception:manage`；drill-down 仍要求原 domain permission。（D4）
- **Remote anomaly key 必须含 anomaly type**（D10）；**off-book 户异常 = TENANT anchor**（D12）。
- 不做 SLA、升级链、通知推送、规则编辑器；severity deterministic by type。

## 1. 定位与用户

| 用户 | 典型场景 |
|---|---|
| 抄表班长 | 每天看「QC 待复核 / QC 驳回 / 连续估抄」队列，派工处理 |
| 营业所主管 | 看本所异常分布，盯 BLOCKING 项 |
| 柜台收费员 | 缴费时发现异常 → 跳 360 → 回队列标记 |
| 远传管理员 | UNBOUND / WAITING_PLAN / FAILED / CONFLICT 事件集中入口 |
| 租户管理员 | off-book 户异常（无册=无确定营业所 owner → 只进 tenant 级队列） |

共同句式：**「给我一份今天需要我处理的清单，按严重度排，每条能直接跳到该户/该单据的处理界面。」**

## 2. 页面 IA

```
异常中心（exception:read 可见，内容按 scope+权限域裁剪）
├─ 顶部统计条：OPEN / ACK / 今日新增 / 今日清除（本 scope）
├─ 过滤器：异常类型 | 严重度 | 状态 | 册/营业所 | 期间
├─ 队列表（分页）：severity | type | 对象 | 摘要 | episode 开始 | assignee | status
└─ 行 → 详情抽屉：异常事实快照(推导参数) + 处理记录 + [跳转 360 / 计划 / 账单 / 远传事件]
```

跳转而非内嵌处理：异常中心是**调度层**；跳过去之后仍需原域权限（D4）。

## 3. 异常目录 V1

> **事实口径**：E8 `/360` 当前实现的 deterministic warning 是 `NO_ACTIVE_METER` / `MULTI_ACTIVE_METER`（无 `NO_BOOK`）。E9 沿用同一方法、由 E9 新增跨域 detector。E8 D3 已冻结 book 计数语义：`0 → NO_BOOK`，`>1 → MULTI_BOOK`（D13）。

### 3.1 V1 active queue —— 冻结 13 类

| type | severity | 推导（SoT 谓词） | identity | scope anchor |
|---|---|---|---|---|
| `NO_ACTIVE_METER` | WARNING | status≠CLOSED ∧ billable ∧ ACTIVE installation=0；排除 MONITORING | `wa:{id}:NO_ACTIVE_METER` | 有册→ACCOUNT；**无册→TENANT**（D12） |
| `MULTI_ACTIVE_METER` | **BLOCKING** | ACTIVE installation > 1（用量归属歧义→错账风险） | `wa:{id}:MULTI_ACTIVE_METER` | 同上 |
| `NO_BOOK` | WARNING | status≠CLOSED ∧ billable=true ∧ **current BookMeter count=0**（D14：不看 historical plan item——历史计划项不是当前册归属 SoT） | `wa:{id}:NO_BOOK` | **TENANT**（无册即无 owner） |
| `MULTI_BOOK` | WARNING | current BookMeter count > 1（D13：需人工清理，否则产生重复 plan item / remote resolution 歧义） | `wa:{id}:MULTI_BOOK` | ACCOUNT（多册覆盖任一出界即不可见） |
| `READING_QC_REVIEW` | WARNING | meter_reading qcStatus=MANUAL_REVIEW 且未 superseded | `reading:{readingId}:QC_REVIEW` | ACCOUNT |
| `READING_QC_REJECTED` | WARNING | qcStatus=REJECTED 且未 superseded | `reading:{readingId}:QC_REJECTED` | ACCOUNT |
| `ESTIMATE_STREAK` | WARNING | 连续 isEstimated settlement ≥ N（抽取 SettlementService.estimateStreaks 共享 helper，不复制算法；N Pilot 定，默认 2） | `wa:{id}:ESTIMATE_STREAK` | ACCOUNT |
| `REMOTE_EVENT_UNBOUND` | WARNING | raw_remote_event.processingStatus=UNBOUND | `event:{eventId}:UNBOUND` | REMOTE_SOURCE |
| `REMOTE_EVENT_WAITING_PLAN` | WARNING | processingStatus=WAITING_PLAN | `event:{eventId}:WAITING_PLAN` | binding→ACCOUNT 或 REMOTE_SOURCE |
| `REMOTE_EVENT_FAILED` | WARNING | processingStatus=FAILED | `event:{eventId}:FAILED` | 同上 |
| `REMOTE_EVENT_CONFLICT` | WARNING | **processingStatus=CONFLICT**（D11：远传读数与已有读数事实冲突——REMOTE_VS_ACTUAL / REMOTE_VS_REMOTE） | `event:{eventId}:CONFLICT` | 同上 |
| `REMOTE_EVENT_KEY_CONFLICT` | WARNING | **currentIssueCode='EVENT_KEY_CONFLICT'**（D11：同 externalEventKey + 不同 canonical payload；与 processingStatus 独立，可与上者并存） | `event:{eventId}:EVENT_KEY_CONFLICT` | REMOTE_SOURCE |
| `UNPAID_BILL_OVERDUE` | WARNING | bill.status∈{POSTED,PARTIAL_PAID} ∧ dueDate<today ∧ 本 bill outstanding>0（仅 Bill+本 bill PaymentAlloc → bill/account-level fact） | `bill:{billId}:OVERDUE` | ACCOUNT（非 settle-level，D5） |

**REMOTE key 含 type（D10）**：同一 event 经 replay 状态迁移（UNBOUND→WAITING_PLAN）时，旧 fact 消失→旧 episode RESOLVED，新 fact→新 OPEN episode；不得改旧 episode 的 anomalyType 冒充同一事实。`REMOTE_EVENT_KEY_CONFLICT` 用 issue code 而非 status，可与 processing-status anomaly 同时存在。

**REMOTE 队列不含** `RECEIVED`（正常瞬态）/ `CONVERTED`（已成功）/ `IGNORED`（已处理）。

### 3.2 Gate 条目但不进第一批（待 Pilot 定义阈值）

| type | 卡点 |
|---|---|
| `READING_MISSING` | `plan_item.status=PENDING` ≠ 异常——PENDING 是正常待办，当前只有 planDate 无 deadline。阈值 Pilot 定，否则队列退化成待抄任务列表 |
| `DEVICE_SILENT` | RemoteDevice 无 `lastSeenAt`；silent 窗口取决于上报频率 |
| `SETTLEMENT_DRAFT_STALE` | DRAFT 超 N 天——N 无依据 |
| `CLOSED_WITH_DEBT` | 依赖 settle 净头寸 → strict settle scope / fail closed（安全已冻结，入队待 Pilot） |
| `SHARED_SETTLE_SCOPE` | settle 级聚合，仅 tenant 级；Pilot 验证 ownership model |

### 3.3 badge-only

单期 `ESTIMATED`；`DEVICE_SILENT` 阈值未定前的展示态；未来纯状态提示。

## 4. 严重度（Q2 冻结）

- V1 = `{BLOCKING, WARNING}`，deterministic by type，不可人工改级，无 INFO。
- V1 唯一 BLOCKING = `MULTI_ACTIVE_METER`；age 升级另开设计，不在 V1。

## 5. WorkItem 生命周期（Q3+Q4+Q6 冻结）

**anomalyKey = fact identity；WorkItem = episode**（D2）。同 key 可多次发生：fact 消失→episode cleared；复现→**新 episode**。

```
OPEN → ACK → RESOLVED
  ↘ IGNORED（仅抑制本 episode）
```

- `ACK` = 已接手；无 IN_PROGRESS
- `RESOLVED` fact-driven（D3）：reconciler 见 fact 消失→`RESOLVED(resolutionSource=AUTO)`；人工 resolve→重跑 detector→fact active→`409 ANOMALY_STILL_ACTIVE`
- `IGNORED`：note 必填；只抑制本 episode；fact 消失→cleared；**复现→新 OPEN episode，不继承旧 IGNORED**
- Remote 状态迁移适用同一规则（D10 示例：UNBOUND→WAITING_PLAN = UNBOUND episode RESOLVED + WAITING_PLAN 新 episode）

## 6. Scope 与 RBAC（Q5 冻结）

### 6.1 RBAC（D4）

| 权限 | 语义 |
|---|---|
| `exception:read` | 看队列/详情/统计条 |
| `exception:manage` | ACK / IGNORE / assign / note / resolve |

drill 到业务页面仍要求原域权限；assignee 必须对该 anomaly scope 可见。

### 6.2 Data scope（D5 + D12 分层）

| anchor | 判定 |
|---|---|
| ACCOUNT（有册户锚点） | E8 覆盖链 `wa→planItem→plan→book.orgUnitId`；任一覆盖册出界→不可见 |
| **TENANT（off-book 户锚点，D12）** | 无 BookMeter → 无确定营业所 owner → **仅 tenant 级可见/接手**。E8 读侧宽放是「看」，E9 队列是「归属」——不因 read permissive 就让所有 Branch 同时看到/接手无册任务。适用 NO_BOOK / NO_ACTIVE_METER / 一切 off-book account anomaly |
| REMOTE_SOURCE | `remote_source.orgUnitId` 子树；null→tenant-only |
| SETTLE（净头寸 detector） | strict settle scope / fail closed |

**bill-level vs settle-level**（D5）：UNPAID_BILL_OVERDUE 只读 Bill+本 bill alloc → ACCOUNT anchor；依赖 settle 净头寸的（CLOSED_WITH_DEBT）→ SETTLE anchor → fail closed。

**shared settle**：归属无法安全判定 → fail closed（现冻结）；Pilot 只验证是否需要显式 ownership model。

## 7. UAT slices（Rev3）

- S1 scope：Branch A 只见 A 覆盖户异常；off-book 户异常**不出现在任何 Branch**，tenant 级可见
- S2 闭环：QC REJECTED→ACK→补抄→fact 消失→reconcile→RESOLVED(AUTO)
- S3 人工 resolve 拦截：fact 仍在→409
- S4 IGNORED episode：fact 消失再复现→新 OPEN episode
- S5 remote replay：event UNBOUND→replay→WAITING_PLAN = 旧 episode RESOLVED + 新 episode OPEN
- S6 KEY_CONFLICT 并存：同 event 可同时挂 CONFLICT(processingStatus) 与 EVENT_KEY_CONFLICT(issueCode) 两条异常
- S7 RBAC：exception:read 无 billing:read→能看 UNPAID_BILL_OVERDUE，drill 被拒
- S8 MULTI_BOOK：户挂两册→WARNING 入队→人工清理后消失

## 8. Not in Scope（V1）

- SLA / 升级 / 通知 / age 升级 / 规则编辑器 / 评论附件 / 批量 / 自动派单
- §3.2 全部 Pilot 阈值类
- 跨租户聚合

## 9. Gate 六问（Rev3 定稿）

| # | 冻结结论 |
|---|---|
| Q1 | 13 类进队列（§3.1）；阈值类待 Pilot；badge-only §3.3 |
| Q2 | {BLOCKING, WARNING} deterministic；仅 MULTI_ACTIVE_METER=BLOCKING |
| Q3 | anomalyKey=fact identity（remote 含 type：D10）；episode=WorkItem；`UNIQUE(tenant,key) WHERE cleared_at IS NULL` |
| Q4 | RESOLVED fact-driven；人工 resolve→409 拦截；IGNORED 仅抑制本 episode |
| Q5 | account coverage 继承 E8；**off-book→TENANT anchor（D12）**；UNBOUND→source.orgUnitId；bill-level≠settle-level；shared-settle fail closed |
| Q6 | {OPEN, ACK, IGNORED, RESOLVED}+resolutionSource{AUTO,MANUAL}；无 IN_PROGRESS |
