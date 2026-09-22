# E9 Exception Center — Domain Design（Draft）

> 对应 Product Gate：`E9_EXCEPTION_CENTER_V1.md`。原则：**异常事实动态推导，处理状态最小持久化**。

## 1. 数据流总览

```
现有 SoT（不变）
├─ water_account / meter_installation / book_meter
├─ reading_plan / reading_plan_item / meter_reading
├─ consumption_settlement / bill / payment / payment_alloc
├─ prepayment_lot(+entry) / remote_source / remote_device(_binding) / raw_remote_event
│
▼ 推导层（新，纯查询，不写业务事实）
anomaly_detector：每类 type 一条 query → AnomalyFact{key,type,severity,anchorId,period?,summary,firstSeen?,lastSeen}
│
▼ 处理层（唯一新增表）
work_item：anomalyKey → {assignee, status, note, acknowledgedAt, resolvedAt, createdAt...}
│
▼ API
GET /exceptions            列表（推导 ∪ work_item 状态 join）
GET /exceptions/:key       单条（事实快照 + 处理记录）
POST /exceptions/:key/ack|assign|resolve|ignore   （写 work_item，不碰事实）
```

**关键不变式**：`work_item` 行的存在与否、状态如何，都不影响 `anomaly_detector` 的输出。列表 = detector 结果 LEFT JOIN work_item。

## 2. AnomalyFact 推导契约

```ts
type AnomalyKey =
  | `wa:${string}`              // 户级，无期
  | `wa:${string}:${string}`    // 户级+期间 (YYYYMM)
  | `bill:${string}` | `reading:${string}` | `settlement:${string}`
  | `event:${string}` | `device:${string}` | `settle:${string}`;

interface AnomalyFact {
  key: AnomalyKey;
  type: AnomalyType;            // NO_ACTIVE_METER | MULTI_ACTIVE_METER | ...
  severity: 'BLOCKING' | 'WARNING';
  waterAccountId?: string;      // 户锚点（scope 判断主键）
  anchorRef: { kind; id };      // 跳转目标
  period?: string;              // 期级异常的期间
  summary: string;              // 列表行展示，如「202606 未抄，计划日 2026-06-05」
  detectedAt: Date;             // 本次推导时刻（快照字段，不持久化）
}
```

### firstSeen 怎么办（设计取舍）

`detectedAt` 是实时的，「首次出现时间」需要历史。两个选项：

- **A（推荐 V1）**：首次出现 = WorkItem 创建时间。detector 命中时若该 key 无 work_item 则 upsert 一行 `status=OPEN`。首次出现即首次入队，天然正确。
- **B**：另建 anomaly_seen 表记首次命中。多一张表只为一个字段，不值。

因此 work_item 实际承担「出现记录 + 处理状态」双职能，schema 仍极简。

## 3. 逐类型推导规则（SoT → 谓词）

| type | 推导 query 概要 | 排除 |
|---|---|---|
| NO_ACTIVE_METER | `water_account` where status≠CLOSED AND NOT EXISTS(meter_installation where accountId=id AND status=ACTIVE) | MONITORING 户豁免 |
| MULTI_ACTIVE_METER | group by installation having count(ACTIVE)>1 | — |
| NO_BOOK | 非 CLOSED 户 AND NOT EXISTS book_meter AND NOT EXISTS 未过期 plan_item | — |
| READING_MISSING | plan_item join plan where item.status=PENDING AND plan.planDate < now() AND plan.period=当前期 | item.status=SKIPPED 不算 missing（已人工标记） |
| READING_QC_FAILED | meter_reading where qcStatus IN (REJECTED,MANUAL_REVIEW) AND supersededById IS NULL | superseded 的不重复列 |
| ESTIMATE_STREAK | settlement where accountId AND isEstimated order by period desc，连续计数≥阈值 | 阈值 Pilot 定，默认建议 ≥2 |
| UNSETTLED_PERIOD | 非 CLOSED billable 户，期已过，无 settlement 行 | MONITORING |
| SETTLEMENT_DRAFT_STALE | settlement status=DRAFT AND updatedAt < now()-N天 | — |
| UNPAID_BILL_OVERDUE | bill where status IN (POSTED,PARTIAL_PAID) AND dueDate<today AND outstanding>0（outstanding 走现有 alloc Σ 逻辑） | REVERSED 排除 |
| CLOSED_WITH_DEBT | account CLOSED AND outstanding>0 | — |
| SHARED_SETTLE_SCOPE | settle 关联户的 book 覆盖跨 org 子树（E8 scope helper 反用） | 仅 tenant 级可见 |
| REMOTE_EVENT_UNBOUND/FAILED | raw_remote_event.status ∈ 对应集合 AND 未被 CONVERTED | IGNORED 事件不进 |
| REMOTE_DEVICE_SILENT | active binding 设备 max(raw_event.receivedAt) < now()-N天 | 阈值待定，可先 badge-only |

所有推导都是 **EXISTS/GROUP BY 级查询**，无 JOIN 大宽表。户锚点类统一先取 `water_account.id` 再套 scope helper。

## 4. WorkItem 最小 schema（E9 唯一新增表）

```prisma
model WorkItem {
  id           String   @id @default(uuid()) @db.Uuid
  tenantId     String   @map("tenant_id") @db.Uuid
  anomalyKey   String   @map("anomaly_key")           // wa:xxx / bill:xxx / ...
  anomalyType  String   @map("anomaly_type")          // 冗余便于按类型过滤/索引
  assigneeId   String?  @map("assignee_id") @db.Uuid
  status       WorkItemStatus @default(OPEN)          // OPEN ACK RESOLVED IGNORED RESOLVED_AUTO
  note         String?                                 // IGNORE 必填
  acknowledgedAt DateTime? @map("acknowledged_at")
  resolvedAt     DateTime? @map("resolved_at")
  createdAt    DateTime @default(now()) @map("created_at")
  updatedAt    DateTime @updatedAt @map("updated_at")
  @@unique([tenantId, anomalyKey])      // 同 key 单行，天然去重
  @@index([tenantId, anomalyType, status])
  @@index([tenantId, assigneeId, status])
  @@map("work_item")
}
enum WorkItemStatus { OPEN ACKNOWLEDGED RESOLVED IGNORED RESOLVED_AUTO }
```

- 无 severity 字段（从 type 映射，前端拿）；无 title/body（事实在 detector）；无外键到具体业务表（key 是逻辑引用，业务行可能被删/换——WorkItem 不因此级联）。
- `anomalyType` 冗余存 string 而非 enum：新增 type 不需要 migration。

## 5. 生命周期协调（核心设计）

每次列表/详情查询时 detector 重算当前事实集，与 work_item 做 reconcile：

| 事实 | work_item | 表现 |
|---|---|---|
| 命中 | 无 | upsert OPEN，入队 |
| 命中 | OPEN/ACK | 正常显示 |
| 命中 | IGNORED | 不显示（已人工压下）；note 保留 |
| 命中 | RESOLVED* | 同一事实复活→视策略（V1 不复活，见 Q4） |
| 未命中 | OPEN/ACK | 置 RESOLVED_AUTO（系统标记，resolvedAt=now） |
| 未命中 | IGNORED/RESOLVED* | 不动作（终态幂等） |

「RESOLVED 后同事实还在」的处理：V1 约定 **RESOLVED 表示人已确认处理动作做完，事实若还在说明业务闭环没完 → 下次命中复活为新 OPEN**（key 相同 → 实际是 reopen 同一行，重置 status/resolvedAt，note 追加）。这让 RESOLVED 语义诚实：解决=人标记，事实=系统判定，两者不一致时事实说了算。

## 6. API 设计（草案，Gate 后细化）

```
GET  /exceptions?type=&severity=&status=&bookId=&orgUnitId=&period=&page=&take=
     → {items: AnomalyFact & {workItem?: {assigneeId,status,note,acknowledgedAt}}, total}
     权限：任一站内角色；返回自动 scope 裁剪

GET  /exceptions/summary    → 统计条 {open, ack, resolvedToday, newToday}

POST /exceptions/:key/ack       → {workItem}    （认领）
POST /exceptions/:key/assign    {assigneeId}    （指派，校验 assignee 可见该 key）
POST /exceptions/:key/resolve   {note?}         （人工标记已处理）
POST /exceptions/:key/ignore    {note}          （note 必填）
POST /exceptions/:key/reopen                    （IGNORED/RESOLVED 手动复活）
```

所有写端点先查 detector 确认 key 当前命中（对 IGNORED 的复活例外）→ 再写 work_item → 全程租户隔离。**不存在对不存在事实建 WorkItem 的接口**。

## 7. Scope 矩阵

| 锚点 | scope 判断 | scoped 可见性 |
|---|---|---|
| `wa:*` `bill:*` `reading:*` `settlement:*` | E8 `assertAccountScopeTx` 等价链（读侧版） | 覆盖内可见 |
| `event:*`（bound） | event→binding→installation→account 同上 | 覆盖内可见 |
| `event:*`（UNBOUND） | `remote_source.orgUnitId` 子树 | 子树内可见；null→仅 tenant |
| `device:*` | active binding → installation → account | 覆盖内可见 |
| `settle:*` | strict settle scope | **仅 tenant 级**（shared-settle 天然跨界） |

列表查询 = detector 全量 → 逐条套 scope 谓词过滤（与 E8 读列表同模式，批量化：先 collect accountIds 再 `outOfScopeAccountIds` 一次过滤）。

## 8. 性能

- 每类 detector 一条带索引 query；户级三类可合并成一次 installation/book 聚合。
- 列表默认 `take=50`；summary 用 work_item 聚合（状态计数持久化易得）+ detector count。
- 大租户风险点：`READING_MISSING` 全量扫描 plan_item×plan——已有 `@@index([tenantId,status])`，加 planDate 谓词即可。
- reconcile 的 RESOLVED_AUTO 批量 update 在查询事务内做（读请求带小写——可接受；若 Pilot 证明热点，改定时 reconcile job）。

## 9. 错误语义

| 场景 | 结果 |
|---|---|
| key 语法非法 | 400 `ANOMALY_KEY_INVALID` |
| key 命中事实但超 scope | 403 `ORG_OUT_OF_SCOPE`（复用 E8 code） |
| key 当前不命中事实且非复活场景 | 404 `ANOMALY_NOT_FOUND` |
| IGNORE 无 note | 400 `NOTE_REQUIRED` |
| assign 给不可见该异常的 staff | 403 `ASSIGNEE_OUT_OF_SCOPE` |
| 对终态 IGNORED 调 ack | 409 `WORK_ITEM_FINAL_STATE` |

## 10. 测试矩阵（草案）

- 推导正确性：每类 ≥1 正例 + 排除例（superseded reading / SKIPPED item / REVERSED bill / MONITORING 户）
- scope：跨所户异常不可见 / 无册宽放可见 / UNBOUND event 按 source orgUnitId / shared-settle 仅 tenant
- 生命周期：出现→OPEN；事实消失→RESOLVED_AUTO；IGNORED 不复活；RESOLVED 后事实仍在→reopen
- 权限域：无 metering:read 不见抄表类
- 幂等：重复 ack/resolve；并发同 key upsert（唯一约束兜底）
- UAT：对应 Product Gate §7 的 6 slices

## 11. Gate 决策点（待拍板，对应产品文档 §9）

- 阈值类参数（ESTIMATE_STREAK 连续期数、DRAFT_STALE 天数、DEVICE_SILENT 天数）：硬编码常量先行，值待 Pilot
- `IN_PROGRESS` 是否砍：建议砍
- RESOLVED-后-事实仍在 → reopen 策略：建议 reopen（诚实语义）
- WorkItem 是否需要 `type` 过滤索引之外的 bookId/orgUnitId 物化：建议不物化，靠 detector 实时 filter
