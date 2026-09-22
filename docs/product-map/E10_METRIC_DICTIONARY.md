# E10 — Metric Dictionary（Draft）

> 每个指标一行口径登记。规则：**先登记，后实现**；没进字典的指标不上 dashboard。金额一律 BigInt（分），服务端出数；前端只做格式化，不做加减。

口径列约定：
- **SoT**：出数的表/service/report endpoint（唯一来源，禁止第二算法）
- **时间**：指标的时间语义（期间 / 发生日 / 时点快照）
- **scope**：org 裁剪方式
- **CLOSED/REVERSED**：包含策略

---

## A. 抄表域（SoT：reading_plan_item / meter_reading / consumption_settlement）

| metric | 显示名 | SoT | 时间口径 | CLOSED | REVERSED | 分母/备注 |
|---|---|---|---|---|---|---|
| `READING_DUE_COUNT` | 本期应抄户数 | `reading_plan_item` join plan | period=所选期，plan.status≠CLOSED | 户 CLOSED 时 item 通常不再生成——以 item 存在为准，不另判 | n/a | 分母基准 |
| `READING_DONE_COUNT` | 已抄 | item.status=READ | 同上 | 同上 | 被 supersede 的读数不影响 item 状态 | — |
| `READING_MISSING_COUNT` | 未抄（逾期） | item.status=PENDING AND plan.planDate<today | 同上 | — | — | 复用 E9 READING_MISSING 谓词 |
| `READING_ANOMALY_COUNT` | 异常读数笔数 | reading qcStatus∈{REJECTED,MANUAL_REVIEW} 未 superseded | period 读数期 | — | superseded 排除 | 与 E9 READING_QC_FAILED 同源 |
| `ACTUAL_READ_RATE` | 实抄率 | 分子：本期 qcStatus=PASSED 且 resultType∈{ACTUAL,REMOTE} 的首采纳读数 | period | — | — | 分母=READING_DUE_COUNT |
| `ESTIMATE_RATE` | 估抄率 | 分子：settlement.isEstimated=true 的户期数 | period | 含 CLOSED 户的历史期结算 | — | 分母=本期有 settlement 的户数；Pilot 定分母 |
| `PERIOD_USAGE_QTY` | 本期用水量 | Σ settlement.totalUsageQty，status=FINAL | period | 含历史期（结算属事实记录） | n/a | DRAFT 不计（未定稿不进报表） |

## B. 账务域（SoT：bill / payment / payment_alloc / prepayment_lot）

| metric | 显示名 | SoT | 时间口径 | CLOSED | REVERSED | 分母/备注 |
|---|---|---|---|---|---|---|
| `BILLED_AMOUNT` | 本期出账金额 | `reports/ar-monthly` 同款：bill status∈{POSTED,PARTIAL_PAID,PAID} Σ totalAmount | bill.period | 含（欠费户销户后账单仍是事实） | REVERSED 排除 | 直接调 ar-monthly，不重复算 |
| `RECEIVED_AMOUNT` | 本期实收 | `reports/collected-monthly`：payment status∈{RECEIVED,DAY_CLOSED} Σ amount | payment.receivedAt 所在月 | n/a | REVERSED 流水不计 | 复用现有口径（allocated ≡ collected） |
| `RECOVERY_RATE` | 回收率 | `reports/recovery-rate` | period[+through 累计] | — | 同上两端口径 | 分子分母同源定义 |
| `OUTSTANDING_AMOUNT` | 欠费金额 | per-bill outstanding = totalAmount − Σ payment_alloc.amount（PaymentService 既有逻辑）；按户 Σ | **时点快照**（查询当下），非期间 | **含 CLOSED_WITH_DEBT** | REVERSED 账单不参与；REVERSED 流水的 alloc 需按服务语义剔除 | drill→欠费账单列表 |
| `PREPAYMENT_BALANCE` | 预存余额 | `prepay.balanceTx` per settle 汇总 | 时点快照 | n/a | 冲正 ledger entry 自然含在 Σ 内 | settle 级→按户 scope 归属见 §scope 备注 |
| `PAYMENT_CHANNEL_MIX` | 渠道占比 | `reports/cashier-daily` / collected-monthly channel 拆分 | 日/期 | n/a | REVERSED 排除 | CASH/POS/TRANSFER |

## C. 资产/事件域（SoT：meter_installation / account_event / remote_*）

| metric | 显示名 | SoT | 时间口径 | CLOSED | REVERSED | 备注 |
|---|---|---|---|---|---|---|
| `ACTIVE_METER_COUNT` | 在册 ACTIVE 表数 | meter_installation status=ACTIVE | 时点快照 | 户 CLOSED 的表应已 REMOVED——若仍 ACTIVE 本身是异常 | n/a | — |
| `METER_REPLACEMENT_COUNT` | 本期换表数 | account_event type=REPLACE（effectiveDate 落期）或 installation REMOVED+reason=REPLACE | period | — | n/a | 以 account_event 为准（业务事件） |
| `ACCOUNT_CLOSED_COUNT` | 本期销户数 | account_event type=CLOSE / water_account.closedAt 落期 | period | 本身就是 CLOSED | n/a | — |
| `REMOTE_ONLINE_RATE` | 远传在线率 | 分子：active binding 设备在窗口内有 event；分母：active binding 设备总数 | 滑动窗口 N 天（**阈值待定，同 E9 DEVICE_SILENT**） | — | — | ⚠ 无 lastSeenAt 字段，只能由 raw event 推导；Pilot 定窗口 |
| `EXCEPTION_OPEN_COUNT` | 待处理异常数 | E9 detector + work_item.status∈{OPEN,ACK} | 时点 | — | — | 依赖 E9 落地；此前隐藏此卡 |

## D. 通用口径约定

- **scope**：户锚点指标走 E8 覆盖链（book→orgUnit 子树）；settle 锚点（PREPAYMENT_BALANCE、OUTSTANDING）——**Pilot 待定**：跨所 settle 的余额是否拆到所，或仅 tenant 级展示。V1 建议 scoped 用户只看户锚点指标，settle 级指标仅 tenant 角色。
- **期间格式**：`YYYYMM`（Char(6)），与 plan/settlement/bill 一致。
- **空值**：分母为 0 → 返回 `null` 比率而非 0，前端显示 `—`。
- **环比**：上期同 scope 同口径；上期无数据 → `null`。
- **权限**：每指标所属域权限（metering:read / billing:read / report:read）；无权限整组隐藏。

## E. 待 Pilot 定稿的口径悬案

1. `OUTSTANDING_AMOUNT`/`PREPAYMENT_BALANCE` 的 scope 归属（shared-settle 场景）
2. `ESTIMATE_RATE` 分母（应抄户数 vs 已结算户数）
3. `REMOTE_ONLINE_RATE` 窗口长度（设备无心跳字段，只有 event 流）
4. `RECOVERY_RATE` 单月 vs 累计默认展示哪个
5. 期间语义：dashboard period 选择器跟自然月还是抄表周期（当前 plan.period 就是 YYYYMM，倾向复用）
