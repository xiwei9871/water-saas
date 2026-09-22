# E10 — Metric Dictionary（Rev2，含 Org Anchor）

> 每个指标一行口径登记。规则：**先登记，后实现**；没进字典的指标不上 dashboard。金额一律 BigInt（分），服务端出数；前端只格式化。
>
> **Rev2 关键修订（D7/D8）**：每个指标强制登记 **Org Anchor** 与 **Scope rule**。现有 report 端点**不是**统一 scoped API——仅 `meter-daily` 有 org scope；其余 4 个为 tenant-wide，复用前必须按本表补 scope 语义。

## A. 抄表域

| metric | 显示名 | SoT | 时间口径 | Org Anchor | Scope rule | CLOSED | REVERSED | 分母/备注 |
|---|---|---|---|---|---|---|---|---|
| `READING_DUE_COUNT` | 本期应抄户数 | `reading_plan_item` join plan | period=所选期 | `ReadingBook.orgUnitId`（item→plan→book） | 册 orgUnit ∈ 子树 | 以 item 存在为准 | n/a | 分母基准 |
| `READING_DONE_COUNT` | 已抄 | item.status=READ | 同上 | 同上 | 同上 | 同上 | superseded 读数不改 item 状态 | — |
| `READING_MISSING_COUNT` | 未抄 | item.status=PENDING | 同上 | 同上 | 同上 | — | — | ⚠ 仅是「未完成计数」，**非 E9 READING_MISSING 异常**（后者阈值待 Pilot） |
| `READING_ANOMALY_COUNT` | 异常读数笔数 | reading qcStatus∈{MANUAL_REVIEW,REJECTED} 未 superseded | period 读数期 | account coverage（installation→account→book） | E8 覆盖链 | — | superseded 排除 | 与 E9 QC detector 同源 |
| `ACTUAL_READ_RATE` | 实抄率 | 分子：本期 qcStatus=PASSED ∧ resultType∈{ACTUAL,REMOTE} 首采纳读数 | period | ReadingBook.orgUnitId | 同上 | — | — | 分母=READING_DUE_COUNT |
| `ESTIMATE_RATE` | 估抄率 | 分子：settlement.isEstimated=true 户期数 | period | account coverage | E8 覆盖链 | 含历史期结算 | — | 分母=本期有 settlement 的户数（Pilot 定） |
| `PERIOD_USAGE_QTY` | 本期用水量 | Σ settlement.totalUsageQty，status=FINAL | period | account coverage | E8 覆盖链 | 含历史期 | n/a | DRAFT 不计 |

## B. 账务域（D8：柜员口径 ≠ 辖区口径，两个指标并存）

| metric | 显示名 | SoT | 时间口径 | Org Anchor | Scope rule | CLOSED | REVERSED | 分母/备注 |
|---|---|---|---|---|---|---|---|---|
| `BILLED_AMOUNT` | 本期出账 | bill status∈{POSTED,PARTIAL_PAID,PAID} Σ totalAmount（ar-monthly 口径） | bill.period | **Bill.waterAccountId → E8 account coverage** | 覆盖链子树 | 含（销户后账单仍是事实） | REVERSED 排除 | 现有 ar-monthly 无 scope → 复用前补谓词 |
| `CASHIER_COLLECTED` | 柜员实收 | payment status∈{RECEIVED,DAY_CLOSED} Σ amount | receivedAt 所在月 | **`Payment.orgUnitId`（收款发生地）** | payment.orgUnit ∈ 子树 | n/a | REVERSED 流水不计 | collected-monthly 现状即此口径（tenant-wide，需加 anchor） |
| `TERRITORY_COLLECTED` | 辖区实收 | Σ payment_alloc.amount（alloc→bill→waterAccount） | alloc 对应 payment.receivedAt 所在月 | **Bill.waterAccountId → E8 account coverage** | 覆盖链子树 | 含 | REVERSED 流水的 alloc 剔除 | **与 CASHIER_COLLECTED 是不同指标**：A 户账单 B 柜台收款 → 柜员计 B、辖区计 A |
| `RECOVERY_RATE` | 回收率 | scoped billed / scoped territory-allocated | period[+through] | 同 TERRITORY 口径 | 覆盖链 | — | 两端同口径 | 分子分母必须同 anchor——不能用 cashier 口径当分子 |
| `OUTSTANDING_AMOUNT` | 欠费金额 | per-bill outstanding=totalAmount−Σ本bill alloc；按户 Σ | 时点快照 | Bill.waterAccountId → account coverage | E8 覆盖链 | **含 CLOSED_WITH_DEBT** | REVERSED 账单/alloc 按服务语义剔除 | ⚠ 若未来口径改依赖 settle 净头寸 → 升 SETTLE anchor + strict scope（fail closed） |
| `PREPAYMENT_BALANCE` | 预存余额 | `prepay.balanceTx` per settle 汇总 | 时点快照 | **SettleAccount（settle 级）** | **strict settle scope / fail closed** | n/a | 冲正 entry 自然含 Σ | shared-settle → scoped 不可见，V1 仅 tenant 级（D9） |
| `PAYMENT_CHANNEL_MIX` | 渠道占比 | payment Σ amount by channel | 日/期 | Payment.orgUnitId | 同 CASHIER | n/a | REVERSED 排除 | CASH/POS/TRANSFER |

## C. 资产/事件/异常域

| metric | 显示名 | SoT | 时间口径 | Org Anchor | Scope rule | CLOSED | REVERSED | 备注 |
|---|---|---|---|---|---|---|---|---|
| `ACTIVE_METER_COUNT` | 在册 ACTIVE 表 | meter_installation status=ACTIVE | 时点 | account coverage | E8 覆盖链 | CLOSED 户的 ACTIVE 表本身是 E9 异常 | n/a | — |
| `METER_REPLACEMENT_COUNT` | 本期换表数 | account_event type=REPLACE effectiveDate 落期 | period | event.waterAccountId → account coverage | E8 覆盖链 | — | n/a | 以业务事件为准 |
| `ACCOUNT_CLOSED_COUNT` | 本期销户数 | account_event CLOSE / closedAt 落期 | period | 同上 | 同上 | 本身是 CLOSED | n/a | — |
| `REMOTE_ONLINE_RATE` | 远传在线率 | 分子：窗口内有 event 的 active-binding 设备 / 分母：active-binding 设备总数 | 滑动窗口 N（**Pilot 定**） | `RemoteSource.orgUnitId` | 子树；null→tenant | — | — | 设备无 lastSeenAt，只能 event 流推导 |
| `EXCEPTION_OPEN_COUNT` | 待处理异常数 | E9 detector ∪ work_item.status∈{OPEN,ACK} | 时点 | 各 anomaly 自身 anchor（E9 §7 矩阵） | 同 E9 | — | — | 依赖 E9 落地 |

## D. 通用口径约定

- **Org Anchor 三种**：`ReadingBook.orgUnitId`（抄表发生地）、`Payment.orgUnitId`（收款发生地）、`WaterAccount → E8 coverage`（业务归属地）。锚错了指标就错——D8 核心。
- **期间格式**：`YYYYMM`（Char(6)），与 plan/settlement/bill 一致。
- **空值**：分母 0 → `null` 比率，前端 `—`；上期无数据 → 环比 `null`。
- **权限**：指标所属域权限（metering:read / billing:read / report:read）；无权限整组隐藏。
- **现有 report 端点复用前提**：先补 Org Anchor scope 谓词并加 e2e（D7）。

## E. 悬案清单（D9 冻结边界）

**留 Pilot（业务阈值）**：
1. `REMOTE_ONLINE_RATE` 窗口（无 lastSeenAt，event 流推导）
2. `ESTIMATE_RATE` 分母（应抄户 vs 已结算户）
3. `READING_MISSING` lateness 阈值（与 E9 同步，本字典仅登记「未完成计数」）
4. `RECOVERY_RATE` 单月 vs 累计默认展示
5. shared-settle 是否需要显式 ownership model

**现冻结（安全行为，不留 Pilot）**：
6. settle 级指标（PREPAYMENT_BALANCE、以及任何改用净头寸口径的 OUTSTANDING）→ strict settle scope / fail closed
7. 归属无法安全判定 → fail closed，无例外
