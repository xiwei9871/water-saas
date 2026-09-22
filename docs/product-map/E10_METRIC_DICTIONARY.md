# E10 — Metric Dictionary（Rev3，含 Org Anchor + signed-money 口径）

> 每个指标一行口径登记。规则：**先登记，后实现**；没进字典的指标不上 dashboard。金额一律 BigInt（分），服务端出数；前端只格式化。
>
> **Rev3 关键修订**：
> - 每个指标强制登记 **Org Anchor** 与 **Scope rule**（D7/D8）
> - **signed-money 语义**（D16）：所有收款类指标 = `payment.status IN (RECEIVED, DAY_CLOSED)` ∧ `Σ signed amount`；冲正是 `reversalOfId→original` 的**负数 Payment 行**（+ negative mirror alloc），`PaymentStatus.REVERSED` 是 vestigial——**不得写「REVERSED 流水排除」**
> - `allocated ≡ collected` **不再是通用不变式**（D17：Payment 可含 debt alloc + TOP_UP；`source=PREPAYMENT` 的 APPLY alloc 无 `payment.receivedAt`）
> - `collected-monthly` / `recovery-rate` **E6 后需重新审计，修正前不得作为 Dashboard SoT**

## A. 抄表域

| metric | 显示名 | SoT | 时间口径 | Org Anchor | Scope rule | CLOSED | 备注 |
|---|---|---|---|---|---|---|---|
| `READING_DUE_COUNT` | 本期应抄户数 | `reading_plan_item` join plan | period=所选期 | `ReadingBook.orgUnitId` | 册 orgUnit ∈ 子树 | 以 item 存在为准 | 分母基准 |
| `READING_DONE_COUNT` | 已抄 | item.status=READ | 同上 | 同上 | 同上 | 同上 | superseded 读数不改 item 状态 |
| `READING_MISSING_COUNT` | 未抄 | item.status=PENDING | 同上 | 同上 | 同上 | — | ⚠ 仅「未完成计数」，**非 E9 READING_MISSING 异常**（阈值待 Pilot） |
| `READING_ANOMALY_COUNT` | 异常读数笔数 | reading qcStatus∈{MANUAL_REVIEW,REJECTED} 未 superseded | period | account coverage | E8 覆盖链 | — | 与 E9 QC detector 同源 |
| `ACTUAL_READ_RATE` | 实抄率 | 分子：本期 qcStatus=PASSED ∧ resultType∈{ACTUAL,REMOTE} 首采纳读数 | period | ReadingBook.orgUnitId | 同上 | — | 分母=READING_DUE_COUNT |
| `ESTIMATE_RATE` | 估抄率 | 分子：settlement.isEstimated=true 户期数 | period | account coverage | E8 覆盖链 | 含历史期结算 | 分母 Pilot 定（应抄户 vs 已结算户） |
| `PERIOD_USAGE_QTY` | 本期用水量 | Σ settlement.totalUsageQty，status=FINAL | period | account coverage | E8 覆盖链 | 含历史期 | DRAFT 不计 |

## B. 账务域（signed-money；柜员口径 ≠ 辖区口径）

| metric | 显示名 | SoT | 时间口径 | Org Anchor | Scope rule | CLOSED | 备注 |
|---|---|---|---|---|---|---|---|
| `BILLED_AMOUNT` | 本期出账 | bill status∈{POSTED,PARTIAL_PAID,PAID} Σ totalAmount | bill.period | Bill.waterAccountId → account coverage | 覆盖链子树 | 含 | REVERSED 账单排除；现有 ar-monthly 无 scope → 复用前补谓词 |
| `CASHIER_COLLECTED` | 柜员实收 | payment status∈{RECEIVED,DAY_CLOSED} **Σ signed amount** | receivedAt 所在月 | **`Payment.orgUnitId`**（收款发生地） | payment.orgUnit ∈ 子树 | n/a | 含负数冲正行自然净额；collected-monthly 现状即此口径但无 scope |
| `TERRITORY_DEBT_COLLECTION` | 辖区账款回收 | Σ **signed** `PaymentAlloc.amount`，`source=PAYMENT`，经 payment→bill→waterAccount | 对应 `payment.receivedAt` 所在月 | Bill.waterAccountId → account coverage | E8 覆盖链 | 含 | **只统计可归属到 bill 的现金偿付**；`source=PREPAYMENT` APPLY alloc 不算当期现金收款；payment 中转入 TOP_UP 的部分无 bill anchor、不得强归属（shared-settle 下尤其禁止猜测）；reversal 的 negative mirror alloc 自然净掉 |
| `RECOVERY_RATE` | 回收率 | **IMPLEMENTATION HOLD（D18）**：分子语义待 Product/Pilot 在 cash recovery（仅 PAYMENT alloc）vs debt extinguishment（+PREPAYMENT APPLY）之间拍板；分母=scoped billed | period[+through] | 同 TERRITORY 口径 | 覆盖链 | — | 现有 recovery-rate 端点审计完成前不得复用；分子分母必须同 anchor |
| `GROSS_BILL_RECEIVABLE` | 辖区账单毛欠款 | Σ positive per-bill remaining = `totalAmount − Σ本bill alloc`（仅正数计） | 时点快照 | Bill.waterAccountId → account coverage | E8 覆盖链 | 含 CLOSED_WITH_DEBT | **D19 Option B**；与柜台 `NET_OUTSTANDING`（outstandingTx，settle 净头寸，SETTLE anchor，fail closed）是不同指标，不得混名 |
| `NET_OUTSTANDING` | 净欠费（柜台口径） | `PaymentService.outstandingTx` 复用 | 时点快照 | **SettleAccount** | strict settle scope / fail closed | 含 | D19 Option A；V1 不上 dashboard，保留柜台/360 |
| `PREPAYMENT_BALANCE` | 预存余额 | `prepay.balanceTx` per settle 汇总 | 时点快照 | SettleAccount | strict settle scope | n/a | **D20**：V1 dashboard 仅 tenant 级 aggregate 是**产品限制**；strict settle 本身允许「settle 全部关联户在 caller scope 内」的 scoped 读取——两层不得混写 |

## C. 资产/事件/异常域

| metric | 显示名 | SoT | 时间口径 | Org Anchor | Scope rule | CLOSED | 备注 |
|---|---|---|---|---|---|---|---|
| `ACTIVE_METER_COUNT` | 在册 ACTIVE 表 | meter_installation status=ACTIVE | 时点 | account coverage | E8 覆盖链 | CLOSED 户的 ACTIVE 表本身是 E9 异常 | — |
| `METER_REPLACEMENT_COUNT` | 本期换表数 | **MeterInstallation reason=REPLACE ∧ installedAt ∈ 窗口**（D15：AccountEventType 只有 TRANSFER/SUSPEND/RESUME/CLOSE，无 REPLACE——不为此加枚举） | 所选窗口 | installation.waterAccountId → account coverage | E8 覆盖链 | — | 「换」=新 installation 的 reason；如需拆「拆/装」两侧另立指标 |
| `ACCOUNT_CLOSED_COUNT` | 本期销户数 | account_event type=CLOSE / closedAt 落期 | period | event.waterAccountId → account coverage | 覆盖链 | 本身是 CLOSED | — |
| `REMOTE_ONLINE_RATE` | 远传在线率 | 窗口内有 event 的 active-binding 设备 / 全部 active-binding 设备 | 滑动窗口 N（Pilot 定） | `RemoteSource.orgUnitId` | 子树；null→tenant | — | 设备无 lastSeenAt，只能 event 流推导 |
| `EXCEPTION_OPEN_COUNT` | 待处理异常数 | E9 detector ∪ work_item 活动 episode | 时点 | 各 anomaly 自身 anchor（E9 §7 矩阵，含 TENANT） | 同 E9 | — | 依赖 E9 落地 |

## D. 通用口径约定

- **Org Anchor 三种**：`ReadingBook.orgUnitId`（抄表发生地）、`Payment.orgUnitId`（收款发生地）、`WaterAccount → E8 coverage`（业务归属地）；settle 级指标另走 strict settle scope。
- **signed-money**（D16）：收款/渠道/账款回收类一律 `Σ signed amount`；refund 是负数行，不是状态翻转。
- **期间格式**：`YYYYMM`（Char(6)）。
- **空值**：分母 0 → `null`，前端 `—`；上期无数据 → 环比 `null`。
- **权限**：指标所属域权限；无权限整组隐藏。
- **现有 report 复用前提**：先补 Org Anchor scope 谓词 + e2e；`collected-monthly`/`recovery-rate` 另需 E6 语义审计。

## E. 悬案清单（D9 边界）

**留 Pilot / Product 拍板（业务语义）**：
1. `REMOTE_ONLINE_RATE` 窗口（无 lastSeenAt，event 流推导）
2. `ESTIMATE_RATE` 分母（应抄户 vs 已结算户）
3. `READING_MISSING` lateness 阈值（与 E9 同步）
4. `RECOVERY_RATE` 分子语义：cash recovery vs debt extinguishment（D18，**拍板前 IMPLEMENTATION HOLD**）
5. shared-settle 是否需要显式 ownership model

**现冻结（安全/口径行为，不留 Pilot）**：
6. settle 级指标 → strict settle scope / fail closed
7. 归属无法安全判定 → fail closed
8. signed-money 语义全金额指标统一（D16）
9. `GROSS_BILL_RECEIVABLE` ≠ `NET_OUTSTANDING`，不得混名（D19）
