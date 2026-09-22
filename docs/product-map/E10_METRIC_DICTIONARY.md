# E10 — Metric Dictionary（Rev4 Final，含 Org Anchor + Aggregation Ownership）

> 每个指标一行口径登记。规则：**先登记，后实现**；没进字典的指标不上 dashboard。金额一律 BigInt（分），服务端出数；前端只格式化。
>
> **口径总则**：
> - **payment-derived cash 指标** = `payment.status IN (RECEIVED, DAY_CLOSED)` ∧ `Σ signed amount`（D16：冲正是 `reversalOfId→original` 的负数 Payment 行 + negative mirror alloc；`PaymentStatus.REVERSED` vestigial，不写「REVERSED 流水排除」）。BILLED/RECEIVABLE/PREPAYMENT_BALANCE 不以 Payment.status 为谓词
> - `allocated ≡ collected` **不再是通用不变式**（D17）：Payment 可含 debt alloc + TOP_UP；`source=PREPAYMENT` 的 APPLY alloc 无 `payment.receivedAt`
> - `collected-monthly` / `recovery-rate` **E6 后需重新审计，修正前不得作 Dashboard SoT**

## 0. ACCOUNT_AGGREGATION_OWNERSHIP（D24——统计归属 ≠ 读可见性）

**E8 `ACCOUNT_READ_SCOPE` ≠ E10 `ACCOUNT_AGGREGATION_OWNERSHIP`**。E8 对无册户读侧宽放是为「新户可访问」；若套用聚合，同一 off-book 户会被多所 dashboard 重复计数。

| current BookMeter count | 归属 |
|---|---|
| = 0 | **UNASSIGNED / TENANT**——scoped branch aggregate 不计，tenant aggregate 计入 |
| ≥ 1 | E8 account coverage：任一覆盖册出 caller scope → 不计（fail closed）；全部在 scope → 计一次 |

适用全部 WaterAccount-anchor 指标（表中 Scope rule 列写 `AGG_OWN` 者）。ReadingBook / Payment.orgUnitId / RemoteSource anchor 指标不受影响。

## 0.1 历史归属语义（D25——CURRENT-PORTFOLIO VIEW）

无 `WaterAccount→Org` effective-dated snapshot → WaterAccount-anchor 历史指标 = **current-portfolio view**：查历史 period 时按查询时点的 current ownership 归属，**不得声称历史营业所绩效**。ReadingBook-anchor 用 plan/book 历史 anchor；Payment cashier 用 `Payment.orgUnitId` 发生时 anchor。若 Pilot 要求历史归属 → 另开 effective ownership Epic，不在 V1 偷造。

## A. 抄表域

| metric | 显示名 | SoT | 时间口径 | Org Anchor | Scope rule | CLOSED | 备注 |
|---|---|---|---|---|---|---|---|
| `READING_DUE_COUNT` | 本期应抄户数 | `reading_plan_item` join plan | period=所选期 | `ReadingBook.orgUnitId` | 册 orgUnit ∈ 子树 | 以 item 存在为准 | 分母基准 |
| `READING_DONE_COUNT` | 已抄 | item.status=READ | 同上 | 同上 | 同上 | 同上 | superseded 读数不改 item 状态 |
| `READING_MISSING_COUNT` | 未抄 | item.status=PENDING | 同上 | 同上 | 同上 | — | ⚠ 仅「未完成计数」，**非 E9 READING_MISSING 异常**（阈值待 Pilot） |
| `READING_ANOMALY_COUNT` | 异常读数笔数 | reading qcStatus∈{MANUAL_REVIEW,REJECTED} ∧ NOT EXISTS child supersedesReadingId=id（同 E9 D23） | period | WaterAccount | AGG_OWN | — | 与 E9 QC detector 同源 |
| `ACTUAL_READ_RATE` | 实抄率 | 分子：本期 qcStatus=PASSED ∧ resultType∈{ACTUAL,REMOTE} 首采纳读数 | period | ReadingBook.orgUnitId | 册子树 | — | 分母=READING_DUE_COUNT |
| `ESTIMATE_RATE` | 估抄率 | 分子：settlement.isEstimated=true 户期数 | period | WaterAccount | AGG_OWN | 含历史期结算 | 分母 Pilot 定 |
| `PERIOD_USAGE_QTY` | 本期用水量 | Σ settlement.totalUsageQty，status=FINAL | period | WaterAccount | AGG_OWN | 含历史期 | DRAFT 不计 |

## B. 账务域

| metric | 显示名 | SoT | 时间口径 | Org Anchor | Scope rule | CLOSED | 备注 |
|---|---|---|---|---|---|---|---|
| `BILLED_AMOUNT` | 本期出账 | `status∈{POSTED,PARTIAL_PAID,PAID} ∧ billKind≠REVERSAL` Σ totalAmount（D26，与 ar-monthly 谓词对齐） | bill.period | Bill.waterAccountId | AGG_OWN | 含 | REVERSED status 与 REVERSAL kind 双排除；ar-monthly 复用前补 scope 谓词 |
| `CASHIER_COLLECTED` | 柜员实收 | payment status∈{RECEIVED,DAY_CLOSED} Σ signed amount | receivedAt 所在月 | **`Payment.orgUnitId`** | payment.orgUnit ∈ 子树 | n/a | 含负数冲正行净额；collected-monthly 现状即此口径但无 scope |
| `TERRITORY_DEBT_COLLECTION` | 辖区账款回收 | Σ signed `PaymentAlloc.amount`，**`source=PAYMENT` only**，alloc→payment→bill→waterAccount | 对应 `payment.receivedAt` 所在月 | Bill.waterAccountId | AGG_OWN | 含 | 只统计可归属 bill 的现金偿付；PREPAYMENT APPLY alloc 不算当期现金；转入 TOP_UP 部分无 bill anchor 不得强归属；negative mirror alloc 自然净掉 |
| `RECOVERY_RATE` | 回收率 | **IMPLEMENTATION HOLD（D18）**：分子语义待拍板——cash recovery（仅 source=PAYMENT alloc）vs debt extinguishment（+PREPAYMENT APPLY）；分母=AGG_OWN scoped billed | period[+through] | Bill.waterAccountId | AGG_OWN | — | 现有 recovery-rate 审计完成前不得复用；分子分母同 anchor |
| `GROSS_BILL_RECEIVABLE` | 辖区账单毛欠款 | 候选：`status∈{POSTED,PARTIAL_PAID} ∧ billKind≠REVERSAL`；per-bill `remaining = totalAmount − Σ alloc（**source=PAYMENT+PREPAYMENT 全计**，两者都已实际消灭债务）`；**`Σ max(remaining, 0)`**（D27） | 时点快照 | Bill.waterAccountId | AGG_OWN | 含 CLOSED_WITH_DEBT | **D19 Option B**；不引 reversedBillCredit/prepayment balance/settle 净头寸（那是 NET_OUTSTANDING） |
| `NET_OUTSTANDING` | 净欠费（柜台口径） | `PaymentService.outstandingTx` 复用 | 时点快照 | SettleAccount | strict settle scope / fail closed | 含 | D19 Option A；V1 不上 dashboard，保留柜台/360 |
| `PREPAYMENT_BALANCE` | 预存余额 | `prepay.balanceTx` per settle 汇总 | 时点快照 | SettleAccount | strict settle scope | n/a | **D20**：V1 dashboard tenant-only aggregate 是产品限制；strict settle 本身允许全关联户在 scope 内时 scoped 读取——两层不得混写 |

## C. 资产/事件/异常域

| metric | 显示名 | SoT | 时间口径 | Org Anchor | Scope rule | CLOSED | 备注 |
|---|---|---|---|---|---|---|---|
| `ACTIVE_METER_COUNT` | 在册 ACTIVE 表 | meter_installation status=ACTIVE | 时点 | WaterAccount | AGG_OWN | CLOSED 户的 ACTIVE 表本身是 E9 异常 | — |
| `METER_REPLACEMENT_COUNT` | 本期换表数 | **MeterInstallation reason=REPLACE ∧ installedAt ∈ 窗口**（D15：AccountEventType 只有 TRANSFER/SUSPEND/RESUME/CLOSE，不为此加枚举） | 所选窗口 | installation.waterAccountId | AGG_OWN | — | 「换」=新 installation 的 reason；拆/装两侧如需分列另立指标 |
| `ACCOUNT_CLOSED_COUNT` | 本期销户数 | account_event type=CLOSE / closedAt 落期 | period | event.waterAccountId | AGG_OWN | 本身是 CLOSED | — |
| `REMOTE_ONLINE_RATE` | 远传在线率 | 窗口内有 event 的 active-binding 设备 / 全部 active-binding 设备 | 滑动窗口 N（Pilot 定） | `RemoteSource.orgUnitId` | 子树；null→tenant | — | 设备无 lastSeenAt，只能 event 流推导 |
| `EXCEPTION_OPEN_COUNT` | 待处理异常数 | E9 detector ∪ work_item 活动 episode | 时点 | 各 anomaly 自身 anchor（E9 §7 矩阵，含 TENANT） | 同 E9 | — | 依赖 E9 落地 |

## D. 通用口径约定

- **Org Anchor 三种 + 一种**：`ReadingBook.orgUnitId`（抄表发生地）、`Payment.orgUnitId`（收款发生地）、`WaterAccount → AGG_OWN`（业务归属，D24）、`RemoteSource.orgUnitId`；settle 级指标走 strict settle scope。
- **signed-money**（D16）：payment-derived cash 指标一律 `Σ signed amount`；refund 是负数行，不是状态翻转。
- **期间格式**：`YYYYMM`（Char(6)）。
- **空值**：分母 0 → `null`，前端 `—`；上期无数据 → 环比 `null`。
- **权限**：指标所属域权限；无权限整组隐藏。
- **现有 report 复用前提**：先补 Org Anchor scope 谓词 + e2e；`collected-monthly`/`recovery-rate` 另需 E6 语义审计。

## E. 悬案清单

**留 Pilot / Product 拍板（业务语义）**：
1. `REMOTE_ONLINE_RATE` 窗口（无 lastSeenAt，event 流推导）
2. `ESTIMATE_RATE` 分母（应抄户 vs 已结算户）
3. `READING_MISSING` lateness 阈值（与 E9 同步）
4. `RECOVERY_RATE` 分子语义：cash recovery vs debt extinguishment（D18，**拍板前 IMPLEMENTATION HOLD**）
5. shared-settle 是否需要显式 ownership model
6. 历史营业所归属需求（若出现 → 另开 effective ownership Epic，D25）

**现冻结（安全/口径行为，不留 Pilot）**：
7. settle 级指标 → strict settle scope / fail closed
8. 归属无法安全判定 → fail closed（含 AGG_OWN 的「任一覆盖册出界→不计」）
9. signed-money 语义全 payment-derived 指标统一（D16）
10. `GROSS_BILL_RECEIVABLE` ≠ `NET_OUTSTANDING`，不得混名（D19）
11. WaterAccount-anchor 指标一律 AGG_OWN + current-portfolio view（D24/D25）
