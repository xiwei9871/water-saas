# E9 Exception Center — Domain Design（Rev2，按 Gate D1–D6 修订）

> 对应 Product Gate：`E9_EXCEPTION_CENTER_V1.md` Rev2。核心架构：**Detector / Reconciler / Query 三件套分离**。

## 1. 架构总览（D1）

```
┌─ Detector（纯函数式查询，无写）
│    SoT → AnomalyFact[]
│    不读 work_item；fact 存在性永远由 SoT 决定
│
├─ Reconciler（独立机制，唯一写 work_item 的系统路径）
│    fact 集 × open episodes → 新建 OPEN episode / 清除消失 episode
│    实现形态实现期选：定时任务 / 显式 POST /exceptions/refresh / 域写后触发
│    Gate 冻结的只是：「不在 GET 里做」
│
└─ Query（GET，只读）
     detector 当前结果 LEFT JOIN open episode handling state
     允许 GET 不触发 reconcile——episode 状态可能滞后一个 reconcile 周期，
     列表标注 asOf 时间即可；查询语义诚实优先于实时性
```

**禁止**：Controller GET 路径上任何 INSERT/UPDATE/auto-resolve。读 API 带业务写副作用会让缓存、重试、只读副本、权限审计全部变复杂，而收益只是「少一个 refresh 按钮」。

## 2. AnomalyFact 契约

```ts
type AnomalyKey = string;
// wa:{waterAccountId}:{TYPE}
// wa:{waterAccountId}:{period}:{TYPE}   （期级事实，如未来 ESTIMATE_STREAK 按 period 计）
// bill:{billId}:{TYPE}  reading:{readingId}:{TYPE}  settlement:{id}:{TYPE}
// event:{eventId}  device:{deviceId}:{TYPE}  settle:{settleId}:{TYPE}

interface AnomalyFact {
  key: AnomalyKey;              // deterministic fact identity —— 同一事实永远同 key
  type: AnomalyType;
  severity: 'BLOCKING' | 'WARNING';   // 由 type 映射，非存储字段
  waterAccountId?: string;      // 户锚点 → account coverage
  sourceOrgUnitId?: string;     // 远传锚点 → source.orgUnitId
  scopeAnchor: 'ACCOUNT' | 'REMOTE_SOURCE' | 'SETTLE' | 'TENANT';
  anchorRef: { kind: string; id: string };  // drill-down 目标
  period?: string;
  summary: string;
  detectedAt: Date;             // 计算时刻
}
```

**anomalyKey ≠ episode id**。key 是「这种事实在这个对象上」的永久身份；episode 是「这一次发生」。

## 3. Detector 推导表（V1 冻结 11 类）

| type | severity | 谓词（全部 EXISTS/GROUP BY 级） | anchor |
|---|---|---|---|
| NO_ACTIVE_METER | WARNING | `water_account` status≠CLOSED ∧ billable ∧ NOT EXISTS(installation ACTIVE)；排除 MONITORING（billable=false 天然排除） | ACCOUNT |
| MULTI_ACTIVE_METER | BLOCKING | installation group by account having count(ACTIVE)>1 | ACCOUNT |
| NO_BOOK | WARNING | status≠CLOSED ∧ billable ∧ NOT EXISTS book_meter ∧ NOT EXISTS 有效 plan_item | ACCOUNT |
| READING_QC_REVIEW | WARNING | meter_reading qcStatus=MANUAL_REVIEW ∧ supersededById IS NULL | ACCOUNT(via installation→account) |
| READING_QC_REJECTED | WARNING | qcStatus=REJECTED ∧ 未 superseded | ACCOUNT |
| ESTIMATE_STREAK | WARNING | **抽取 `SettlementService.estimateStreaks` 为共享 helper**（当前在 settlement.service.ts 内私有，report 注释处引用但 report 未实现阈值判断）；连续 isEstimated ≥ N（N Pilot，默认 2） | ACCOUNT |
| REMOTE_EVENT_UNBOUND | WARNING | raw_remote_event.status=UNBOUND | REMOTE_SOURCE |
| REMOTE_EVENT_WAITING_PLAN | WARNING | status=WAITING_PLAN | ACCOUNT（经 binding→installation）或 REMOTE_SOURCE |
| REMOTE_EVENT_FAILED | WARNING | status=FAILED | 同上 |
| REMOTE_EVENT_CONFLICT | WARNING | status=CONFLICT | 同上 |
| UNPAID_BILL_OVERDUE | WARNING | bill status∈{POSTED,PARTIAL_PAID} ∧ dueDate<today ∧ (totalAmount − Σ本bill alloc)>0 —— **bill-level，只读本 bill 的 PaymentAlloc** | ACCOUNT |

非 V1（Gate 条目，阈值待 Pilot）：READING_MISSING（PENDING≠异常，缺 deadline 语义）、DEVICE_SILENT（无 lastSeenAt）、SETTLEMENT_DRAFT_STALE、CLOSED_WITH_DEBT（settle-level，strict scope 已冻结但入队待 Pilot）、SHARED_SETTLE_SCOPE。

**排除集**：REMOTE 不含 RECEIVED/CONVERTED/IGNORED；QC 不含 PENDING（普通待办）和被 superseded 的读数；plan_item SKIPPED 不算 missing。

## 4. WorkItem episode 模型（D2，E9 唯一新表）

```prisma
model WorkItem {
  id            String   @id @default(uuid()) @db.Uuid
  tenantId      String   @map("tenant_id") @db.Uuid
  anomalyKey    String   @map("anomaly_key")          // fact identity，可重复出现于不同 episode
  anomalyType   String   @map("anomaly_type")         // string 非 enum：新增 type 免 migration
  status        WorkItemStatus @default(OPEN)          // OPEN ACK IGNORED RESOLVED
  resolutionSource ResolutionSource? @map("resolution_source") // AUTO | MANUAL，仅 RESOLVED 时有值
  assigneeId    String?  @map("assignee_id") @db.Uuid
  note          String?                                // IGNORE 必填；普通备注
  acknowledgedAt DateTime? @map("acknowledged_at")
  resolvedAt    DateTime? @map("resolved_at")
  clearedAt     DateTime? @map("cleared_at")          // episode 终结时刻；NULL = 活动 episode
  createdAt     DateTime @default(now()) @map("created_at")
  updatedAt     DateTime @updatedAt @map("updated_at")
  @@index([tenantId, anomalyType, status])
  @@index([tenantId, assigneeId, status])
  @@index([tenantId, clearedAt])
  @@map("work_item")
}
enum WorkItemStatus { OPEN ACK IGNORED RESOLVED }
enum ResolutionSource { AUTO MANUAL }
```

**episode 唯一性（D2 核心约束）**——Prisma 表达不了 partial unique，migration 里原生 SQL：

```sql
CREATE UNIQUE INDEX work_item_active_episode_key
  ON work_item (tenant_id, anomaly_key)
  WHERE cleared_at IS NULL;
```

语义：同一 fact 同一时间最多一个活动 episode；清除后同 key 可再开新 episode。历史 episode 永久保留（审计/频率统计 → Pilot 异常样本数据源）。

**注意 `clearedAt` 与 `resolvedAt` 的分工**：
- `clearedAt`：episode 是否还活着的技术标记（唯一索引载体）。RESOLVED 和「IGNORED 且 fact 消失」都会置 clearedAt。
- `resolvedAt`：业务解决时刻。IGNORED episode 被 fact 消失清掉时 clearedAt 置位但 resolvedAt 可留空（它没被解决，是被淘汰）。

## 5. Reconciler 语义（D3）

每次 reconcile run：

| fact | 活动 episode | 动作 |
|---|---|---|
| 命中 | 无 | INSERT OPEN episode |
| 命中 | OPEN/ACK | 不动（episode 继续） |
| 命中 | IGNORED | 不动（仍被抑制） |
| 命中 | — | （RESOLVED 必有 clearedAt，不可能是活动态） |
| 未命中 | OPEN/ACK | `status=RESOLVED, resolutionSource=AUTO, resolvedAt=now, clearedAt=now` |
| 未命中 | IGNORED | `clearedAt=now`（episode 终结，为下次复现腾位；不改 status） |

**人工 resolve（写 API，不是 GET）**：

```
POST /exceptions/:key/resolve
  → detector.evaluate(key) 重跑
  → fact active → 409 ANOMALY_STILL_ACTIVE
  → fact gone   → episode.status=RESOLVED, resolutionSource=MANUAL, resolvedAt, clearedAt
```

**IGNORED 不继承**（D3）：episode A 被 IGNORED → fact 消失 → A cleared → 同一 fact 复现 → **新 episode B（OPEN）**。旧 IGNORED 不传染。这保证「忽略」是对这一次发生的人工判断，不是对这类事实的永久豁免。

## 6. API 设计

```
GET  /exceptions?type=&severity=&status=&bookId=&orgUnitId=&period=&page=&take=
     → {items: AnomalyFact & {episode?: {id,status,assigneeId,note,acknowledgedAt}}, total, asOf}
     权限 exception:read；只读，不触发 reconcile

GET  /exceptions/summary → {open, ack, newToday, clearedToday, asOf}
GET  /exceptions/:key    → fact + 当前 episode + episode 历史(同 key 已清除 episodes)

POST /exceptions/:key/ack          (exception:manage)
POST /exceptions/:key/assign       {assigneeId}   —— 校验 assignee 对该 key scope 可见
POST /exceptions/:key/ignore       {note}         —— note 必填
POST /exceptions/:key/resolve      —— 重跑 detector，fact active → 409
POST /exceptions/:key/unignore     —— IGNORED 且 fact 仍 active 时解除抑制
POST /exceptions/refresh           (exception:manage) —— 显式 reconcile trigger（可选，取决于实现期选的形态）
```

写端点顺序：**先 detector.evaluate(key) 确认 fact 当前命中**（resolve 除外——resolve 是确认不命中）→ scope 校验 → 写 work_item。不存在对不存在 fact 建 episode 的接口。

## 7. RBAC 与 scope（D4+D5）

### RBAC

- `exception:read` / `exception:manage` 两个新权限，独立挂角色
- drill-down URL 仍走原域 controller → 原域 permission 照常拦截；E9 只做投影不放宽任何域

### Scope per anchor

| scopeAnchor | 判定 |
|---|---|
| ACCOUNT | E8 覆盖链批量化：收集本页 waterAccountIds → `outOfScopeAccountIds` 一次过滤 |
| REMOTE_SOURCE | `remote_source.orgUnitId` ∈ 子树；null → tenant-only |
| SETTLE | strict settle scope（`outOfScopeSettleAccountIds`）→ 跨所 settle fact scoped 不可见 |
| TENANT | 仅 tenant 级角色 |

**bill-level vs settle-level**（D5）：detector 声明自己的 anchor，不要一刀切。UNPAID_BILL_OVERDUE 只读本 bill + 本 bill alloc → ACCOUNT anchor；依赖 settle 净头寸的（CLOSED_WITH_DEBT）→ SETTLE anchor → fail closed。

## 8. 性能

- Detector：每类一条带索引 query；户级三类（NO_ACTIVE/NO_BOOK/MULTI）可合并为一次 installation/book_meter 聚合
- 列表：detector 各类并行 → 合并 → scope 批过滤 → join episode → 分页。`take=50` 默认
- 热点：READING_QC_* 走 `meter_reading` 的 qcStatus+supersededById（需确认索引，实现期评估 `@@index([tenantId,qcStatus])` 是否补）
- Reconcile 频率：实现期定（建议起步 cron 5–15min + 显式 refresh），写量 = Δ episodes，不是全量

## 9. 错误语义

| 场景 | 结果 |
|---|---|
| key 语法非法 | 400 `ANOMALY_KEY_INVALID` |
| key 超 scope | 403 `ORG_OUT_OF_SCOPE` |
| key 无 fact 命中且非 resolve 场景 | 404 `ANOMALY_NOT_FOUND` |
| resolve 但 fact 仍 active | **409 `ANOMALY_STILL_ACTIVE`**（D3 核心） |
| IGNORE 无 note | 400 `NOTE_REQUIRED` |
| assign 给不可见 staff | 403 `ASSIGNEE_OUT_OF_SCOPE` |
| 对活动态已 ACK 再 ack | 200 幂等 |
| 对已清除 episode 操作 | 409 `EPISODE_CLEARED` |
| 无 exception:manage 调写端点 | 403（标准 RBAC） |

## 10. 测试矩阵

- **Detector 正确性**：每类正例+排除例（MONITORING 户不触发 NO_BOOK/NO_ACTIVE_METER；superseded reading 不列 QC；SKIPPED item；REVERSED bill；remote RECEIVED/CONVERTED/IGNORED 不入列）
- **Episode**：同 key fact 消失→RESOLVED AUTO→复现→新 episode（行数+1，不 reopen 旧行）；IGNORED→fact 消失→cleared→复现→新 OPEN episode（不继承 IGNORED）
- **GET 无写**：mock 计数器断言 GET 不产生 work_item 写
- **D3 拦截**：fact active 时 resolve→409
- **Scope**：跨所户不可见 / UNBOUND event 按 source orgUnitId / UNPAID_BILL_OVERDUE（bill-level）scoped 可见 vs CLOSED_WITH_DEBT（settle-level）scoped 不可见
- **RBAC**：无 exception:read→403；有 read 无 manage→写端点 403；drill URL 无原域权限→原域 403
- **并发**：同 key 并发 reconcile 由 partial unique index 兜底（第二个 INSERT 冲突→幂等跳过）

## 11. 实现期才定的项（Gate 不冻结）

- Reconciler 形态：cron / 显式 refresh / 域写后触发（建议 V1 = cron + 手动 refresh 按钮）
- ESTIMATE_STREAK 阈值默认值（Pilot，暂 2）
- episode 历史展示深度（V1 详情抽屉列出同 key 历史即可）
- `meter_reading` QC 索引是否补充
