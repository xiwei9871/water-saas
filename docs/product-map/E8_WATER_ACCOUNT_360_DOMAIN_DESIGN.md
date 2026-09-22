# E8 — WaterAccount 360° Domain Design（Domain Gate）

> Base：`main @ b086b32`（E7 已合并）。全部结论来自 main 代码核实，非假设。

## 1. Source-of-Truth Map（冻结：360 不复制事实）

| 域 | SoT | 360 消费方式 |
|---|---|---|
| 户/客户/结算户 | `water_account` / `customer` / `settle_account` | 直读 + include |
| 表/安装 | `meter` / `meter_installation` | E7 规则：当前表 = `ACTIVE ORDER BY installed_at DESC` |
| 册/计划 | `book_meter` / `reading_plan_item` → `reading_plan` → `reading_book` | 成员关系 + 当前期 item |
| 读数 | `meter_reading` | 有效读数 = `PASSED ∧ ACTUAL|REMOTE ∧ 未被 supersede` |
| 结算 | `consumption_settlement` + `consumption_component` | 只读引擎结果，不重算 |
| 欠费 | `PaymentService.outstandingTx` | **唯一 SoT**——复用，不自算 |
| 支付 | `payment` + `payment_alloc` | 按 alloc 归属本户呈现（见 §5） |
| 预存 | `PrepaymentService.balanceTx` / `entries` | E6 语义原样复用 |
| 户事件 | `account_event`（TRANSFER/SUSPEND/RESUME/CLOSE） | 新增只读端点 |
| 审计 | `audit_log`（iam 域） | 不进 360（操作审计是另一个面） |

## 2. API Inventory（main 事实）

| 资源 | 端点 | 按户过滤 | 读 scope 现状 |
|---|---|---|---|
| water-account | `GET /water-accounts`、`GET /:id`、`GET /:id/household-profiles` | — | ❌ 无 |
| water-account 写 | `PATCH /:id`、`transfer`、`suspend`、`resume`、`close` | — | ❌ 无 |
| customer | `GET /customers`、`GET /:id` | — | ❌ 无 |
| settle-account | `GET /settle-accounts`、`GET /:id` | — | ❌ 无 |
| outstanding | `GET /water-accounts/:id/outstanding` | — | ❌ 无 |
| payment | `GET /payments`（settleAccountId/cashierId/status/channel）、`GET /:id` | 无 | ❌ 无 |
| bill | `GET /bills`（waterAccountId/settleAccountId/period/status/billingRunId）、`GET /:id` | ✅ | ❌ 无 |
| settlement | `GET /consumption-settlements`（waterAccountId/period/status/isEstimated）、`GET /:id` | ✅ | ❌ 无 |
| meter-reading | `GET /meter-readings`（installationId/planItemId/period/resultType/qcStatus/q）、`GET /:id` | ⚠️ 仅经 installationId | ❌ 无 |
| reading-book/plan | `GET /reading-books*`、`GET /reading-plans*` | — | ❌ 无（写已 scope） |
| estimate | `POST /estimate/preview`（waterAccountId+period） | ✅ | ❌ 无 |
| meter-installation | `GET /meter-installations`、`/:id`、`install/remove/replace` | ✅ | ✅ E7 |
| meter | `GET /meters`、`/:id` | — | ✅ 台账租户级，detail 嵌套史已过滤（E7） |
| prepayment | `GET /prepayments/balance`、`/entries` | settleAccountId | ✅ E6 |
| account_event | **无读端点**（表已存在） | — | — |

`GET /water-accounts/:id` 已返回：户字段 + customer + settleAccount + **meterInstallations timeline** + householdSize。360 概览在它基础上补册归属/当前表解析/最近读数/欠费/预存/warnings，而不是另起炉灶。

## 3. Org Scope 冻结矩阵

统一规则（E6/E7 已冻结，E8 全量套用）：**户 → plan_item → plan → book.orgUnitId；任一覆盖册出界 → 整户出界；无册户宽放**。出界读 = `403 ORG_OUT_OF_SCOPE`，出界写同码；对象不存在 = 404（先查存在再判 scope，与 E7 顺序一致）。

| 端点 | 冻结规则 |
|---|---|
| water-accounts list | scoped → coverage 排除（同 E7 installation list 互斥构造：显式 customerId/settleAccountId 过滤先 assert 该对象 scope，再严格相等） |
| water-accounts :id 及全部子路径/写 | `assertAccountScopeTx(id)` |
| customers list/:id/patch | **D2 待拍板**（见 §9） |
| settle-accounts list/:id/patch | 复用 E6 `assertSettleScope`（任一覆盖册出界 → 整户隐藏/403） |
| outstanding | `assertAccountScopeTx(waterAccountId)` |
| payments list | 显式 `settleAccountId` → `assertSettleScope` + 严格相等；无参 → coverage 排除（同 E6 entries 规则）；新增 `waterAccountId` 过滤 → `assertAccountScopeTx` + alloc 级过滤（§5） |
| payments :id | resolve `payment.settleAccountId` → `assertSettleScope` |
| bills list | 显式 waterAccountId/settleAccountId → 对应 assert；无参 → coverage 排除 |
| bills :id | `assertAccountScopeTx(bill.waterAccountId)` |
| settlements list/:id | 同上（waterAccountId 锚点） |
| meter-readings list/:id | installation → waterAccount coverage；`plan_item_id NULL` 的 standalone 读数沿用 assertReadingScope 现状（无册可判 → 宽放，注明审阅） |
| reading-books/plans reads | 直接按 `book.orgUnitId`（书册本身是 org 锚点对象） |
| estimate/preview | `assertAccountScopeTx(waterAccountId)` |

## 4. 聚合 API 方案（待拍板 D1，推荐 A′）

**Option A — 单端点 `GET /water-accounts/:id/360` 全量**：scope 一次、无 waterfall；但 endpoint 过胖、跨 4 个权限域、数据量失控。
**Option B — 前端聚合现有资源 API**：边界干净；但首屏 8+ 请求、scope 规则各端点须逐一正确、快照时间不一致。
**Option A′（推荐）— summary 端点 + Tab 懒加载**：

```
GET /water-accounts/:id/360   → 单事务返回概览截面（§5 结构）
GET /<domain>?waterAccountId=…&take&skip → 各 Tab 历史，复用现有端点
```

理由：首屏一次 RT 拿到"这户现在怎样"（scope 判一次、一事务内一致）；历史无限增长的表走既有分页端点，不复制查询逻辑。权限上 ctx 只有 scope 没有 perm 集合——分域门禁在 endpoint 层（**D6**，见 §9）。

## 5. Summary 响应结构（单 `runAsTenant` 事务）

```jsonc
{
  "account": { /* WATER_ACCOUNT_SELECT + customer + settleAccount + householdSize */ },
  "book":    { "bookId","bookNo","name","orgUnitId","readerId","cadence" } | null,
  "currentPlanItem": { "planId","period","status","seqNo","plannedInstallationId" } | null,
  "currentInstallation": { /* INSTALLATION_SELECT 当前 ACTIVE（installed_at DESC）*/ } | null,
  "activeInstallationCount": 1,
  "latestReading": { /* 当前 installation 的最近有效读数 */ } | null,
  "latestSettlement": { "id","period","totalUsageQty","isEstimated","status" } | null,
  "outstanding": { /* outstandingTx 原样：items/total/reversedBillCredit */ },
  "prepaymentBalance": "0",
  "warnings": ["NO_BOOK","ESTIMATED", ...]
}
```

**一致性冻结**：
- `currentInstallation` 解析 = E7 规则（ACTIVE `installed_at DESC`，并列按 id）；`activeInstallationCount` 同事务计数 → `MULTI_ACTIVE_METER` badge 与展示数据天然一致。
- `latestReading` = 当前 installation 上最近一条有效读数（任意期，`readDate DESC, createdAt DESC`）。**当前表无有效读数 → null**；旧 installation 的读数只在抄表 Tab 作为历史出现，绝不冒充"当前读数"。
- `latestSettlement` = `period DESC` 最近一条；component 不进 summary（Tab 展开取）。
- `outstanding`/`prepaymentBalance` 直接调 `outstandingTx`/`balanceTx`——同一事务内，与 header 数字同源。
- `book` = `book_meter` 成员行（一户多册则取 seqNo 最小/最近创建——**D3 拍板**）；`currentPlanItem` = 该册当前期 plan 中本户 item（无当期 → 最近期）。

## 6. 端点增量（零 schema/migration）

| 端点 | 说明 |
|---|---|
| `GET /water-accounts/:id/360` | §5；`customer:read`（D6）；`assertAccountScopeTx` |
| `GET /water-accounts/:id/events` | account_event 分页只读；`customer:read`；scope 同上 |
| `GET /meter-readings?waterAccountId=` | 新增过滤（join installation），配合读 scope |
| `GET /payments?waterAccountId=` | 新增过滤：行 = 本户账单上的 `payment_alloc`（`source=PAYMENT`），返回 `{...payment, allocatedAmount}`；**D4 备选**：`source=PREPAYMENT` 的 APPLY alloc 并入同一 Tab 用 `source` badge 区分——推荐并入，否则预存抵扣的"已付"在支付 Tab 不可见 |
| 读 scope 补齐 | §3 矩阵中全部 ❌ 行 |
| 复用不改 | bills/settlements `?waterAccountId`、prepay balance/entries、installation/meter 全部 E7 端点、outstanding |

## 7. 性能与分页（冻结）

- Summary ≈ 10 条定点查询（全部走 `tenant_id` + 主键/既有索引：`meter_installation(tenant,account,status)`、`meter_reading(tenant,installation,…)`、`book_meter(tenant,account)`、`reading_plan_item(tenant,account)`、`bill(tenant,settle)`、`payment_alloc(bill)`、`prepayment_lot`）；禁止深 include fan-out；component/事件/历史一律不进 summary。
- 所有历史端点 `take ≤ 200`、默认 50；UI 每 Tab 独立分页。
- 支付 Tab：`payment_alloc ⋈ bill(waterAccountId=?)`——bill_id 已有索引，alloc 按 bill 反查无 N+1。
- 单事务读 summary 即可（repeatable-read 默认隔离足够）；**不**为"跨 Tab 一致"加长事务。

## 8. 错误语义

- 户不存在 → `404 WATER_ACCOUNT_NOT_FOUND`；存在但出界 → `403 ORG_OUT_OF_SCOPE`（存在性先于 scope 判定，与 E7 相同顺序——不存在不泄露"是否在界内"的歧义）。
- Tab 端点沿用各域既有错误码；scope 失败一律 `403 ORG_OUT_OF_SCOPE`。
- Summary 内部子查询（无读数/无结算/无册）返回 `null`，不是错误。

## 9. 待拍板决策（Gate 评审项）

- **D1 聚合形态**：推荐 A′（summary + lazy tabs）。否决项：纯 B 的 8+ waterfall 与快照漂移；纯 A 的过胖与跨权限域。
- **D2 customer/settle 读 scope**：settle-account 复用 E6 严格规则（任一覆盖册出界→整户 403/隐藏）。customer 推荐「**至少一个可见户即可见**，detail 内嵌 water-accounts 只回可见户」——customer 是身份对象不是覆盖对象，双营业所客户不该互相隐身；备选 = 与 settle 同规则（任一出界→整隐，更简单但过度隐藏）。列表按可见性过滤。
- **D3 一户多册**：summary `book` 取法——推荐 `book_meter` 中当前期有 plan 的册优先，否则最近创建；UI 多册时并列展示（如实，不合并）。
- **D4 支付 Tab 源**：推荐并入 `source=PREPAYMENT` alloc（badge 区分 柜台/预存抵扣），否则 E6 自动抵扣的已付金额在户视角缺失。
- **D5 读数过滤**：推荐 `GET /meter-readings?waterAccountId=`（join installation）而非新增专用端点。
- **D6 360 权限**：推荐 V1 单门 `customer:read`（ctx 无 perm 集合，分域隐藏需新 plumbing；试点期柜台/客服角色本就宽）。若评审要求分域：改为 header 金融卡走 `outstanding`/`prepayments/balance` 原端点（payment:read 自动 403 → UI「无权限」），summary 只回 customer/metering 域——**此为备选方案，推荐仍单门**。

## 10. 测试矩阵（Implementation Gate 用）

- Scope：§3 每行 ≥1 条（Branch A 读/写 Branch B 户资源 → 403；无册户宽放；嵌套旁路——customer detail 不泄出界户、settle detail 不泄出界账单锚点）。
- Summary：字段齐备；`currentInstallation`/`latestReading` 换表后正确；无读数→null；多 ACTIVE→count+badge；CLOSED 可读。
- 支付 Tab：跨户 payment → 本户仅见本户 alloc 金额（allocatedAmount ≠ payment.amount）；PREPAYMENT 源并入（若 D4 采纳）。
- events：分页、序、CLOSED 户可读。
- 分页：take 上限、skip 翻页。
- 性能：summary 查询数上界（断言无 per-row 查询）。
