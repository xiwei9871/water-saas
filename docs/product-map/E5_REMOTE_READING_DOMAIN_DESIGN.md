# E5 Remote Reading V1 — Domain Design v1.0

> 状态：Domain Gate 评审稿（Domain Gate 待审）
> 层级：L1 Core · 版本：v0.2.x
> 上游基线：docs/PRODUCT_MAP.md §7.2、`product-map/E5_REMOTE_READING_V1.md`（Product Gate PASS · Frozen）
> 验证基线：main @ `f69f719`（v0.2.0-mvp）
> 本文档只冻结领域设计，不含 schema/migration 实现；通过 Domain Gate 后才从最新 main 切 `feat/remote-reading-v1`。

## 1. Domain Gate 目标

E5 不建设 IoT 平台。它只解决一个问题：

> 把外部远传平台产生的"可用于营业抄表的表码事实"，安全、幂等、可追溯地接入现有 MeterReading → QC → Settlement → Reconciliation 主链。

架构边界固定为：

```
External Source
      │
      ▼
Remote Adapter
      │
      ▼
RawRemoteEvent
      │
      ├─ Idempotency
      ├─ Binding Resolution
      ├─ Plan Resolution
      └─ Conflict Detection
      │
      ▼
MeterReading
resultType=REMOTE
      │
      ▼
      QC
      │
      ▼
   Settlement
      │
      └─ historical estimated period
             ↓
        Reconciliation
```

**Adapter 的终点永远是 RawRemoteEvent**，不是 MeterReading，更不是 Settlement。MeterReading 必须由 Water SaaS kernel 自己生成。

定位冻结：E5 是 **billing-candidate remote readings ingestion**，不是高频 telemetry data lake。厂商一天传 96 个 15 分钟采样点时，高频数据留在厂商侧；进入 `RawRemoteEvent` 的应该是业务抄表候选值，不把 SaaS 变成时序数据库。

## 2. 现有系统 4 个必须尊重的现实（已对 main 核实）

### A. MeterReading 是"计划绑定"的业务事实

当前正常写入逻辑依赖：

```
ReadingPlan → ReadingPlanItem → MeterReading
```

写入后还会更新 `plan_item.status`、`completedReadingId`、plan progress。

现有 `assertReadingScope()`（`meter-reading.service.ts`）对 `planItemId = null` 会跳过组织范围判断——这只是 MVP 的防御性兼容，不是给 Remote 开的正式入口。

**冻结**：E5 V1 生成的业务 MeterReading 必须绑定 `ReadingPlanItem`。没有对应计划时，Raw Event 等待（`WAITING_PLAN`），不创建 MeterReading。

### B. Settlement 已原生认可 PASSED REMOTE

现有 Settlement 逻辑已把 `ACTUAL` / `REMOTE` 视为同一类 trusted reading，E5 **不需要修改结算算法**：

```
REMOTE → QC PASSED → Settlement
ACTUAL → QC PASSED → Settlement   （完全同轨）
```

### C. E4 Reconciliation 已解决历史估水恢复

```
REMOTE 晚到 → QC PASSED → trusted reading → Reconciliation
```

复用现有补差逻辑。**禁止**建立 `RemoteAdjustment`、`RemoteReconcile` 等新对象。

### D. `MeterReading.operatorId` 当前必填

Vendor API / Webhook / SYSTEM Adapter 没有真实抄表员。E5 正式支持 `operatorId = null`，但只允许真正的系统 Remote Reading：

```
普通 WEB / IMPORT / APP reading → operator_id NOT NULL

SYSTEM Remote reading → result_type = REMOTE
                      → source = REMOTE
                      → source_event_id NOT NULL
                      → operator_id MAY NULL
```

UI 遇到 null 显示"系统远传"。**不要**人为制造假 Staff。

## 3. Domain Objects（核心 4 + 1）

### 3.1 RemoteSource

代表"一个租户配置的一种外部远传来源"。

```
RemoteSource
─────────────────────────
id
tenantId
code
name
type            FILE_IMPORT | API_PULL | WEBHOOK
adapterKey      例：FILE_GENERIC_V1 / VENDOR_X_V1
status          ACTIVE | DISABLED
timezone        IANA，如 Asia/Shanghai（必填）
config          JSONB
credentialRef   nullable（vault:// / env:// / secret:// 引用）
orgUnitId       nullable（见 §34 scope）
createdAt / createdBy
updatedAt / updatedBy
```

- **adapterKey**：核心层只认识 `RemoteAdapter`，不认识厂商。
- **timezone 必须存在**：县级水司导出文件常见 `2026-09-21 08:30:00` 无 offset，Adapter 必须知道如何解释；数据自带 offset 时用数据自己的。
- **credentialRef** 只存引用，禁止 password/apiSecret/accessToken 明文入库；FILE_IMPORT 无需 credentialRef。

### 3.2 RemoteDeviceBinding

E5 最关键的数据模型之一。

```
RemoteDeviceBinding
─────────────────────────
id
tenantId
remoteSourceId
vendorDeviceKey
installationId
effectiveFrom
effectiveTo     nullable
createdAt / createdBy
updatedAt / updatedBy
```

**`remoteSourceId` 必须进入 binding identity**——两个厂商完全可能都有 `deviceKey = 1000001`。正确 identity 是 `source + vendorDeviceKey`。

### 3.3 RawRemoteEvent

```
RawRemoteEvent
────────────────────────────
id
tenantId
remoteSourceId
externalEventKey
canonicalPayloadHash
vendorDeviceKey
businessPeriod          YYYYMM（见 §9）
collectedAt
readingValue
vendorQuality           nullable
rawPayload              JSONB
canonicalPayload        JSONB
processingStatus
resolvedBindingId       nullable
currentIssueCode        nullable
currentIssueAt          nullable
receivedAt
createdAt / createdBy
updatedAt / updatedBy
```

### 3.4 MeterReading 扩展

```
MeterReading
+ sourceEventId   UUID nullable
  FK (tenantId, sourceEventId) → RawRemoteEvent(tenantId, id)
  UNIQUE(tenantId, sourceEventId)     — 一个 RawEvent 最多一个 Reading
+ operatorId → nullable（见 §23 DB CHECK）
```

### 3.5 RemoteEventProcessLog（+1 辅助对象）

Product Gate 已冻结"每次处理/重放变化可审计"：UNBOUND→replay、FAILED→replay、CONFLICT→IGNORED/CONVERTED。只存 `RawRemoteEvent.status` 无法回答：谁重放的、失败过几次、何时绑定成功、谁决定保留人工值。所以必须有 append-only 处理日志：

```
RemoteEventProcessLog
──────────────────────────
id
tenantId
remoteEventId
action
fromStatus
toStatus
code
message
actorType       SYSTEM | USER
actorStaffId    nullable
detail          JSONB
createdAt
```

hardening 与现有 `audit_log` 同模式：`REVOKE UPDATE / DELETE / TRUNCATE`。

## 4. Binding 时间语义

统一**半开区间 `[effectiveFrom, effectiveTo)`**：

```
旧表：2026-01-01 00:00 → 2026-06-15 10:23
新表：2026-06-15 10:23 → ∞

事件 collectedAt = 2026-05-10 → 永远归旧表，即使今天已是新表。
```

## 5. DB 防 binding overlap（不能只靠 service）

推荐 PostgreSQL exclusion constraint（migration 用 `btree_gist` extension），`effectiveTo = NULL` 视为 infinity：

```sql
EXCLUDE USING gist (
  tenant_id WITH =,
  remote_source_id WITH =,
  vendor_device_key WITH =,
  tsrange(effective_from, effective_to, '[)') WITH &&
)
```

第二条同样冻结：**同一 Source 下，同一 Installation 同一时刻只能对应一个 canonical device key**：

```
tenant + source + installation + time range 不得 overlap
```

防止 `D001 → A` 与 `D002 → A` 同时生效的误操作。V1 若真遇到一表两 device identity，届时再放宽。

## 6. Binding 与 Installation 生命周期

**冻结**：Binding 时间范围不得超出 Installation 生命周期：

```
effectiveFrom >= installation.installedAt
installation.removedAt != null → effectiveTo <= removedAt
```

换表/拆表时：

```
MeterInstallation REMOVED at T
        ↓
所有 open RemoteDeviceBinding effectiveTo = T   （同一业务事务）
```

否则表已拆、binding 还开着，新数据继续落旧表。跨表 CHECK 难做：**overlap 用 DB invariant；Installation containment 用 Domain Service + e2e 保证**。

## 7. businessPeriod 必须成为 canonical event 字段

**禁止** kernel 自己 `period = month(collectedAt)`——双月抄表、迟到数据都会出错：

```
业务账期 202610，厂商实际上传 2026-11-01 00:05
→ 按月推得 period=202611，错。
```

Adapter contract 必须产出 `businessPeriod: YYYYMM`：

| 来源 | businessPeriod 确定方式 |
|---|---|
| FileImport | 导入时用户选择目标账期 202610，Adapter 给所有 row 带上；文件自带明确账期则校验一致性 |
| API_PULL | 天然 `pull(period=202610)` |
| Webhook | 具体 VendorAdapter 必须定义 vendor payload → businessPeriod；无法可靠确定 → FAILED/`PERIOD_UNRESOLVED`，**核心系统不猜** |

## 8. collectedAt 与 readDate 分开

```
RawRemoteEvent.collectedAt   2026-09-21T23:58:44  （完整时间戳）
        ↓ 按 RemoteSource.timezone
MeterReading.readDate        DATE
```

完整时间经 `sourceEventId` 可回追 Raw Event。

## 9. Raw Event immutable 的数据库保护

schema：RawEvent 一张表保留 current processing status + append-only ProcessLog。

migration 写 trigger，**仅允许 UPDATE**：

```
processing_status, resolved_binding_id,
current_issue_code, current_issue_at, updated_at, updated_by
```

**禁止改变**：

```
remote_source_id, external_event_key, canonical_payload_hash,
vendor_device_key, business_period, collected_at, reading_value,
raw_payload, canonical_payload, received_at
```

违反 → `RAISE EXCEPTION 'RAW_REMOTE_EVENT_IMMUTABLE'`。**不要只靠 TypeScript。**

## 10. externalEventKey 实现

Adapter 统一产出 `externalEventKey` + `canonicalPayloadHash`；DB 唯一 `UNIQUE(tenantId, remoteSourceId, externalEventKey)`。

- **厂商有稳定 eventId**：`externalEventKey = vendor-event:981771882`
- **无稳定 ID**（FileImportAdapter）：

```
SHA256(
  normalizedDeviceKey
  + businessPeriod
  + collectedAtUTC
  + readingValueCanonical
  + requiredVendorFields
)
```

canonicalize 规则：device `" 00123 " → "00123"`；reading `"00120.5000" → "120.5000"`；timestamp 统一 ISO UTC；period `YYYYMM`。

## 11. same key / different payload 的审计形态

唯一约束下不能插第二行，也不能覆盖第一行。冻结：

- `RawRemoteEvent` 保持原样；
- `ProcessLog` append `action = EVENT_KEY_CONFLICT`，`detail = { incomingPayloadHash, incomingPayload }`；
- `raw_event.currentIssueCode = EVENT_KEY_CONFLICT`；
- `processingStatus` 可以仍是 `CONVERTED`——"原事件是否已转换"和"后来是否收到同 key 异内容"是两个维度，**EVENT_KEY_CONFLICT 不进 processingStatus**。

## 12. RawRemoteEvent 状态机（Domain 层补 WAITING_PLAN）

Product Spec 的状态之外补一个 `WAITING_PLAN`：

```
RECEIVED
│
├─ UNBOUND
│
├─ WAITING_PLAN
│
├─ FAILED
│
├─ CONFLICT
│    ├─ CONVERTED
│    └─ IGNORED
│
└─ CONVERTED
```

**为什么必须有**：MeterReading 正式写入依赖 ReadingPlanItem，远传数据可能先于本期计划到达——这不是 FAILED 也不是 UNBOUND，只是等待营业计划。Domain-level refinement，不改变 Product scope。

## 13. Remote Event Processor 内部结构

```
RemoteIngestService
      │
      ▼
RawRemoteEvent
      │
      ▼
RemoteEventProcessor
      │
      ├─ BindingResolver
      ├─ PlanResolver
      ├─ ConflictDetector
      └─ RemoteReadingWriter   (kernel-owned)
      │
      ▼
MeterReading
```

**Adapter 不调用 `MeterReadingService`**；由 `RemoteEventProcessor` 调 kernel-owned `RemoteReadingWriter`。File / API Pull / Webhook 走完全相同的业务路径。

## 14. Binding Resolution

```
sourceId + vendorDeviceKey + collectedAt
        ↓
RemoteDeviceBinding
WHERE sourceId = ?
  AND vendorDeviceKey = ?
  AND effectiveFrom <= collectedAt
  AND (effectiveTo IS NULL OR collectedAt < effectiveTo)
```

DB 已防 overlap → 结果只能 0 或 1。0 → `UNBOUND`；1 → 进入 Plan Resolution。

## 15. Plan Resolution

Binding → installation → waterAccount，再以 `waterAccountId + businessPeriod` 找 ReadingPlanItem：

| 结果 | 行为 |
|---|---|
| 0 个 | `WAITING_PLAN`，不创建 MeterReading |
| 1 个 | 继续 |
| >1 个 | 数据配置异常：`FAILED` `code=PLAN_ITEM_AMBIGUOUS`，**不猜** |

## 16. Remote V1 不允许 plan-less reading（invariant）

```
sourceEventId IS NOT NULL → planItemId IS NOT NULL
```

三个原因：计划完成状态需要更新；权限范围经 `ReadingBook.orgUnit` 判定；当前 QC scope 就是通过 planItem 找组织。Raw Event 可以早于计划到达——这正是 `WAITING_PLAN` 的意义。

## 17. 正常 Remote conversion 流程

前提：plan `OPEN / IN_PROGRESS`，item `PENDING / NO_READ`。

```
Raw Event
↓ 锁 event
↓ resolve binding
↓ resolve plan item
↓ 锁 plan item
↓ create MeterReading
↓ item → READ，completedReadingId → new reading
↓ advance plan
↓ event → CONVERTED
```

MeterReading 字段映射：

```
resultType      = REMOTE
source          = REMOTE
sourceEventId   = rawEvent.id
installationId  = binding.installationId
meterId         = installation.meterId
period          = event.businessPeriod
readingValue    = event.readingValue
readDate        = localDate(event.collectedAt)   // 按 source.timezone
operatorId      = NULL
qcStatus        = PENDING     // Remote 不自动 PASS QC
```

V1 保持与 ACTUAL 一样需要 QC。若 Pilot 证明厂商可靠可另做 auto-QC policy，**不是 E5**。

## 18. 并发写入复用 plan item 锁

Remote conversion 与人工抄表可同时发生（抄表员录 ACTUAL 时 Remote Event 到达）。冻结：

- Remote processor 处理前**锁 `ReadingPlanItem FOR UPDATE`**，再重读 completed reading；
- 两条链最终只有一个先成为有效 observation；
- **禁止**"先查 item=PENDING → insert → 最后才发现人工也写了"。

## 19. Conflict Matrix（冻结）

| 当前 PlanItem/Reading | Remote 到达 | 行为 |
|---|---|---|
| PENDING | REMOTE | 正常生成 |
| NO_READ | REMOTE | 正常生成 REMOTE；NO_READ 历史保留 |
| READ + ACTUAL PASSED | REMOTE | `CONFLICT` |
| READ + REMOTE PASSED | 新 Remote | `CONFLICT` |
| READ + PENDING/MANUAL_REVIEW reading | Remote | `CONFLICT` |
| READ + REJECTED reading | Remote | 可作为新 observation，重新 QC |
| 无 PlanItem | Remote | `WAITING_PLAN` |

核心原则：**Remote 不静默替换已有 trusted fact**。

## 20. Late Remote / 历史计划（E5 最关键现实场景）

```
202609 NO_READ → 估水 → Settlement FINAL → Bill POSTED
10 月厂商补传 202609 实际表码 —— 必须支持。
```

流程：`Raw Event → 匹配历史 ReadingPlanItem → create REMOTE reading → QC PENDING → QC PASSED → trusted reading → Reconciliation → Adjustment`。

`ReadingPlan DONE/CLOSED` **不应阻止** late-reading recovery。`RemoteReadingWriter` 需要两种模式：

- **normal mode**：plan `OPEN / IN_PROGRESS`
- **late recovery mode**：plan `DONE / CLOSED`
  - 创建 plan-bound REMOTE reading；
  - 更新 `completedReadingId`、item → READ；
  - plan status **不回退、不重开**；
  - Settlement/Bill 不修改；
  - QC PASS 后走 E4 Reconciliation。

这是 Remote 的独立 kernel path，**不是**强行调当前 `createBatchTx()`（它会拒绝 DONE/CLOSED plan）。

## 21. MeterReading DB CHECK（operatorId 放宽的护栏）

```
source_event_id IS NULL
  OR (result_type = 'REMOTE' AND source = 'REMOTE')

operator_id IS NOT NULL
  OR (source_event_id IS NOT NULL
      AND result_type = 'REMOTE'
      AND source = 'REMOTE')
```

只有真正 Adapter 生成的 REMOTE 可以没有人工 operator。

## 22. FileImportAdapter contract

所有 Adapter 统一输出：

```
CanonicalRemoteEvent {
  externalEventKey
  vendorDeviceKey
  businessPeriod
  collectedAt
  readingValue
  canonicalPayload
  canonicalPayloadHash
  rawPayload
  vendorQuality?
  sourceRowRef?
}
```

## 23. FileImportAdapter V1

上传参数：`RemoteSource + Target Period + File`（CSV / XLSX）。Parser 只负责 vendor columns → CanonicalRemoteEvent。

Source config 示例（**不 hard-code 中文表头**）：

```json
{
  "deviceKeyColumn": "表号",
  "readingColumn": "当前读数",
  "collectedAtColumn": "采集时间",
  "eventIdColumn": "流水号",
  "qualityColumn": "状态"
}
```

## 24. Decimal 解析

禁止 `Number("12345678.1234")` 再入库。`string → Decimal`，保持现有 `Decimal(18,4)` 规则。

## 25. 文件导入采用"部分成功"（与人工 CSV 不同）

人工 route sheet 用 all-or-nothing（一半导入让抄表员难判断）；Remote raw ingest 的原始事件是独立事实，采用**部分成功**：

```
1000 rows
────────────────
940 inserted
30 idempotent replay
5  key conflict
15 unbound
5  invalid
5  converted conflict
```

不因第 998 行格式错 ROLLBACK 前 997 行。

## 26. 每行事务 vs 整文件事务

V1：`parse entire file → wire validation → chunk processing`（每 chunk 100–500 rows），一行失败不回滚其它行。**不为 Pilot 引入 BullMQ**，先同步处理；量大后同一 Processor 可搬到 worker。

## 27. 重复文件安全重放

```
第一次：1000 rows → 1000 events
第二次：1000 rows → 1000 IDEMPOTENT_REPLAY → 0 new events → 0 new readings
```

行级 `externalEventKey` 才是最终幂等边界——不依赖 filename。可额外算 file SHA256 用于操作日志/报告，但它不是业务幂等真相。

## 28. Re-import 不自动 replay FAILED/UNBOUND（冻结）

第一次导入产生 `UNBOUND`，管理员未绑定就重新上传同一文件 → 第二次只返回 `IDEMPOTENT_REPLAY` + `existing status = UNBOUND`，**不自动重处理**。重处理必须显式 `[重放]`——行为更可解释。

## 29. Replay

```
POST /remote-events/:id/replay
允许：UNBOUND / FAILED / WAITING_PLAN
CONFLICT 不能普通 replay —— 必须走 resolve conflict
```

每次 replay：`lock event FOR UPDATE → append process log → 重新 BindingResolver → 重新 PlanResolver → 转换`。不创建新 RawEvent。

## 30. Conflict Resolution

```
POST /remote-events/:id/resolve-conflict
body: USE_REMOTE | KEEP_ACTUAL
```

- `KEEP_ACTUAL`：event `CONFLICT → IGNORED`，不产生 reading。
- `USE_REMOTE`：**不直接标 CONVERTED**。应 `create correction MeterReading → QC=PENDING → event CONVERTED`，新读数仍需 QC。

冻结语义：**冲突裁决"采用远传" ≠ 自动认定远传值正确**——它只是允许远传事实进入现有 QC 链。

## 31. Organization / RLS / scope

所有新增表：`tenant_id` + `RLS ENABLE` + `RLS FORCE`，沿用 `tenant_id = current_setting('app.tenant_id')`。

**scope 问题与冻结解法**（Product Spec 未完全解决，此处 Domain 层 security refinement）：

UNBOUND Event 没有 WaterAccount/ReadingBook/Org，无法经 `book.orgUnit` 判 dataScope。冻结：

- `RemoteSource.orgUnitId nullable`：`orgUnitId = branch` → 该 source 的未绑定数据归该 branch；`NULL` → tenant-wide source；
- tenant-wide source 的 UNBOUND raw events 只允许 `metering:remote:manage` + `DataScope.ALL` 查看；
- 普通 `metering:read` 用户只看已绑定到其组织范围内的 Remote Reading provenance；
- **cashier 不直接看 Raw Payload**——没有业务必要。

## 32. 不保留 SmartMeterPort 双轨（冻结）

现有 `SmartMeterPort` stub（`integration/ports.ts`）→ **deprecated**，未来统一为 `RemoteAdapter`：

```ts
interface RemoteAdapter {
  ingest(...): CanonicalRemoteEvent[]
}
```

Vendor API Pull / Webhook / FileImport 都只实现 Adapter——避免五年后"智能表接口 A / 远传接口 B / 文件导入 C"三套路径。

## 33. 最终 schema 关系

```
RemoteSource
    │
    ├───────────────┐
    ▼               ▼
RawRemoteEvent   RemoteDeviceBinding
    │               │
    │               ▼
    │          MeterInstallation
    │               │
    │               ▼
    │           WaterAccount
    │
    ├──── RemoteEventProcessLog
    │
    ▼
MeterReading
sourceEventId
    │
    ▼
ReadingPlanItem
    │
    ▼
    QC
    │
    ▼
Settlement
    │
    └── Reconciliation
```

与现有架构自然延伸，不另造"远传结算系统"。

## 34. Domain Gate 必测不变量

**Database**

1. binding 时间段 overlap → DB 拒绝
2. `effectiveTo <= effectiveFrom` → DB 拒绝
3. duplicate externalEventKey → unique
4. 一个 event 两个 reading（sourceEventId）→ DB 拒绝
5. sourceEventId 指向非 REMOTE → DB 拒绝
6. automated REMOTE operator=null → 允许
7. WEB/APP operator=null → DB 拒绝
8. Raw payload UPDATE → DB 拒绝
9. RLS cross-tenant → 0 rows / blocked

**Domain**

10. historical event → old installation
11. no binding → UNBOUND
12. no plan → WAITING_PLAN
13. ambiguous plan → FAILED
14. PENDING item → REMOTE reading
15. NO_READ item → REMOTE reading
16. ACTUAL PASSED → CONFLICT
17. KEEP_ACTUAL → IGNORED
18. USE_REMOTE → correction + PENDING QC
19. late remote + FINAL estimate → reconciliation path
20. remote outage → manual ACTUAL still works

**Idempotency**

21. same key + same payload → replay
22. same key + different payload → key conflict
23. same file twice → no new events
24. concurrent same event ingest → one row
25. concurrent replay → one reading

**Binding**

26. rebind at T
27. event T-1 → old installation
28. event T → new installation
29. removed installation closes binding
30. binding correction cannot orphan already converted event

## 35. E5 开发顺序（Domain Gate 过后）

| Task | 内容 |
|---|---|
| T1 | Enums + schema + migration + RLS + DB invariants |
| T2 | RemoteSource CRUD |
| T3 | RemoteDeviceBinding + effective period + exclusion constraint |
| T4 | RawRemoteEvent ingest + externalEventKey + payload conflict |
| T5 | RemoteEventProcessLog + replay state machine |
| T6 | BindingResolver + PlanResolver |
| T7 | RemoteReadingWriter + sourceEventId + SYSTEM actor |
| T8 | FileImportAdapter CSV/XLSX |
| T9 | UI: Source / Binding / Events / Replay |
| T10 | CONFLICT resolution UI |
| T11 | Late remote → QC → Reconciliation |
| T12 | Playwright Pilot UAT |

## Domain Gate 结论（待评审确认）

E5 设计收敛为 7 个构件：`RemoteSource` / `RawRemoteEvent` / `RemoteEventProcessLog` / `RemoteDeviceBinding` / `RemoteAdapter` / `RemoteEventProcessor` / `RemoteReadingWriter`。

相对 Product Spec 的三个关键 Domain 层决定：

1. **`WAITING_PLAN`**：不允许 Remote 经 `planItemId = null` 绕过营业计划与 org scope；
2. **`sourceEventId` + nullable `operatorId`**：真正区分"系统远传事实"和"人工录入"；
3. **`RemoteEventProcessLog`**：否则 UNBOUND/replay/CONFLICT/key-conflict 的冻结审计要求实现不了。
