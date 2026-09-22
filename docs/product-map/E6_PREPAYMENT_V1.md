# Epic E6 — Prepayment V1（预存水费）

> 状态：Product Gate PASS · Frozen
> 层级：L1 Core · 版本：v0.2.x（近期优先，紧随 E5）
> 冻结日期：2026-09-21
> 上游基线：docs/PRODUCT_MAP.md §7.3、§11.2
> 分支前提：从已合入 E5 的最新 main 切 `feat/prepayment-v1`，不 stacked。

## User

- 收费员：收预存款、给客户解释余额和抵扣、当日错收冲正。
- 营业员/管理员：查看任意结算户的预存余额与流水、处理退款和跨日冲正。
- 管理人员：看预存总额、抵扣规模、异常冲正。
- 系统（SYSTEM）：账单 POSTED 后自动抵扣。

## Problem

郊县水司欠费/回收率压力高。居民预存能改善现金回收，但预存如果不能进账务闭环（收据、日结、自动抵扣、可追溯冲正），只会变成账外资金，比没有更糟。

关键风险（本 Epic 要防的）：

- 余额成为可随意改写的字段 → 资金对不上；
- 抵扣绕过 Allocation 另造销账逻辑 → 同一笔欠费两套账；
- 冲正通过删除/修改流水实现 → 审计链断；
- 日结后资金口径变化 → 收费员日结金额对不上。

## Core Scenarios

1. **预存充值（含已有欠费）**：客户有欠费 80，来柜台交 200"多的存着" → **一次收款、一张收据、一次现金流入 ¥200**，资金用途拆分：先按账龄顺序清欠费（Allocation 80），剩余 120 才记 `+TOP_UP` 形成预存余额——不允许"欠着钱同时存着钱"，也不允许日结计成两笔现金收入。
2. **账单自动抵扣**：账单 POSTED 130，预存余额 120 → 自动 Allocation 抵扣 120 → 账单 PARTIAL_PAID 剩 10，余额 0。余额充足则全额抵扣 → PAID。
3. **多账单顺序**：余额 150，欠费账单 80（老）+ 60（次新）+ 50（新 POSTED）→ 依次抵扣 80、60，剩 10 抵新单 → 新单 PARTIAL_PAID 剩 40。
4. **抵扣解释**：账单详情/收据显示"预存抵扣 ¥100.00（流水号 …）"，客户能看懂钱去哪了；日结中预存抵扣单独列示，**不混入现金实收**。
5. **当日冲正**：收费员充错金额（当日未日结）→ 本人发起 REVERSAL 负向流水，原充值保留。
6. **跨日冲正/退款**：已日结的充值错误或客户主动退款 → 管理员/主管发起 REVERSAL/REFUND 负向流水。已被 APPLY 消耗的 TOP_UP 不允许直接全额冲正（`PREPAYMENT_ALREADY_APPLIED`），只能先回退相关 Bill/APPLY 或对可用余额 REFUND。
7. **账单红冲回退预存**：已抵扣的账单被红冲 → 追加反向 ledger 恢复预存余额；混合支付（现金+预存）按各自来源分别逆转。
8. **余额查询**：收费台搜索客户即见预存余额；360°/结算户页可查看全部流水。
9. **日结**：现金收款、预存充值、退款/冲正、预存抵扣（非现金信息项）分项列示；跨日冲正计入执行日，历史日结不改写。

## Business Rules

冻结规则（与 PRODUCT_MAP §7.3 一致）：

1. 预存账户 = **SettleAccount**（结算户是资金责任主体；一户多水表户共享余额）。
2. Ledger append-only：entry 类型 `TOP_UP` / `APPLY` / `REFUND` / `REVERSAL`；**绝无** update/delete/负值改写的后门。
3. `balance = Σ effective ledger entries`；允许物化缓存列做性能优化，但缓存可由流水全量重建，不是唯一真相。
4. **充值先清欠**：TOP_UP 入账前，收到的资金先按账龄顺序清偿该结算户现有有效欠费（正常 Allocation），剩余部分才形成预存余额。资金链完整为：客户支付 → 清已有欠费（Allocation）→ 余款 TOP_UP → 未来账单 APPLY。**一次柜台资金事件语义**：客户递进的 ¥200 是一次 cash inflow / 一次 cashier transaction / 一张收据，资金用途拆分为"偿还已有账单 ¥80 + 转预存 ¥120"——Allocation 与 TOP_UP 是**用途拆分**，不是两笔独立现金收入；DayClose 只确认本次实际现金流入 ¥200，收据解释为"本次收款 ¥200：欠费销账 ¥80，转预存 ¥120"。
5. 自动抵扣时机：**Bill → POSTED 事务内**。账单过账即检查该结算户余额并按确定顺序分配，**复用既有 Allocation**，不新建销账路径。
6. **抵扣排序冻结**：`dueDate ASC → period ASC → issuedAt ASC → id ASC`（dueDate 为空时回退 period）。与现有 Bill 模型对齐——任何重试得到相同分配结果。
7. 允许部分抵扣；抵扣后账单状态按既有规则走 PARTIAL_PAID/PAID。
8. 手工收费与自动抵扣同源：收费员收现金抵扣账单 = Allocation(payment)；系统自动抵扣 = Allocation(prepaymentApply)。两种 Allocation 共享 outstanding 计算。
9. **现金口径分离**：`TOP_UP` 是现金/银行实收（cash inflow）；`APPLY` 是内部资金销账（non-cash settlement），**绝不二次计入实收**；`REFUND` 是现金流出（cash outflow）；`REVERSAL` 按被冲事实产生反向效果。DayClose/报表必须分列：现金收款、预存充值、退款/冲正、预存抵扣（非现金信息项）——绝不能混成一个数字。**澄清（Domain Gate 对齐）**：`CashierDayClose` 是柜员级签字现金事实，SYSTEM 自动 APPLY 无柜员归属——不进入任何柜员的 `totalAmount`，只在日结界面/运营日报作为 non-cash informational metric 单列；柜员 close 可附当日收款的预存用途拆分 snapshot（欠费收费/转预存/退款/冲正），其合计恒等于该柜员现金净额。
10. **红冲联动**：账单被 reversal/replacement 时，其上已发生的预存 APPLY 必须追加反向 ledger entry 恢复余额——绝不修改原 APPLY。混合支付（现金+预存）的红冲按各自来源分别逆转：预存部分恢复余额，现金部分走既有 Payment reversal 规则。
11. REFUND 必须为负向 entry；REVERSAL 必须指向原流水且 `amount = −originalEntry.amount`（冲正 TOP_UP 时为负，回退 APPLY 时为正），reason 必填。**已消耗 TOP_UP 保护**：未被 APPLY 消耗的 TOP_UP 可按权限 REVERSAL；已部分/全部被 APPLY 消耗的 TOP_UP 禁止直接全额冲正（拒绝 `PREPAYMENT_ALREADY_APPLIED`），否则会造成负余额——纠错须先按业务原因回退相关 Bill/APPLY，或仅对当前可用余额做 REFUND；V1 不自动跨多张历史账单反向展开所有 APPLY。
12. TOP_UP 必须开收据；APPLY 的抵扣在账单收据/详情中可解释；REFUND/REVERSAL 进流水与日结口径。
13. 幂等：充值、抵扣、冲正均要求幂等键；同一账单重复过账/重试不得产生重复 APPLY。
14. 预存余额为**正数语义**；不允许透支抵扣（抵扣上限=余额）。REFUND 不得使余额为负（退款不得超过当前余额）。
15. **资金归属冻结**：WaterAccount 改挂结算户时，原 SettleAccount 的预存余额**不自动迁移**——那是原账户的资金事实；有余额的结算户发生改挂/解绑时 UI 必须警告；跨结算户资金转移（TRANSFER_OUT/IN）不属于 V1。
16. 监控表/不计费户不产生账单，自然不发生 APPLY；其余账务行为不特殊。

## Data / State

新增对象（产品层命名，schema 设计阶段细化）：

| 对象 | 状态机 | 说明 |
|---|---|---|
| PrepaymentLedgerEntry | POSTED（终态，不可变） | tenant + settleAccountId + type + amount(分，带符号) + refType/refId（payment/bill/receipt）+ operator + 幂等键 |
| SettleAccount（既有） | — | 增加余额视图：实时 Σ 或物化缓存（可重建） |
| Allocation（既有） | 沿用 | 增加 `source=PREPAYMENT` 维度关联 ledger APPLY entry |
| Receipt（既有） | 沿用 | TOP_UP 收据；账单收据含预存抵扣行 |
| DayClose（既有） | 沿用 | 日结汇总含预存充值/冲正/退款分项 |

状态流转要点：Ledger 无状态机（写完即终态）；账单状态机不变（POSTED→PARTIAL_PAID→PAID），APPLY 只是其 Payment 来源之一。

## UI Entry

- **收费台**：客户/结算户选中后显示预存余额；充值入口；缴费时可见"预存已抵扣"明细。
- **结算户详情 / 360° 收费区块**：余额 + 流水列表（类型、金额、关联单据、操作人、时间、冲正指向）。
- **账单详情**：预存抵扣行（金额、流水号）。
- **收费记录/日结**：现金收款、预存充值、退款/冲正、预存抵扣（非现金）分项汇总。
- **改挂警告**：水表户改挂结算户时，若原结算户有预存余额，弹窗明示"余额不随户迁移"。
- **异常中心（E9 接入口）**：跨日冲正、退款待办。

## Permission

| 操作 | 权限 |
|---|---|
| 预存充值（TOP_UP，含先清欠） | 收费员（`payment:write`，既有） |
| 查看余额/流水 | 收费员、营业员、管理员（`payment:read`，既有） |
| 系统自动抵扣（APPLY） | SYSTEM（事务内，不走用户权限） |
| 当日未日结充值冲正（REVERSAL） | 原收费员（`payment:write` + 同日 + 未日结 + 本人约束） |
| 已日结冲正（REVERSAL）/ 客户退款（REFUND） | 管理员/主管（**新增** `prepayment:reverse`） |
| 删除流水 | 永远禁止（无权限可授予） |

V1 只新增一个高风险权限 `prepayment:reverse`，不再细分。

## Audit

- 每条 Ledger entry 自带审计（operator、createdAt、幂等键、refId）。
- REVERSAL/REFUND 必须携带原 entry 引用与理由（reason 必填）。
- 日结后历史金额不改写；跨日冲正计入执行日日结。
- 任一时刻 `Σ ledger` 可与物化余额、日结累计、欠费抵扣三方对账。

## Acceptance

- 资金守恒：任意时点 `余额 = Σ流水`，可用脚本/e2e 重算核对。
- 充值先清欠：有欠费时充值，欠费先按 `dueDate → period → issuedAt → id`（dueDate 空回退 period）顺序 Allocation，余款才进余额；一次收款只产生一次现金流入、一张收据，日结不重复计现金。
- 账单 POSTED 自动抵扣：足额→PAID，不足→PARTIAL_PAID，多账单按冻结排序。
- 现金口径：日结中现金收款/预存充值/退款冲正/预存抵扣分项列示，APPLY 不重复计入实收。
- 红冲回退：已抵扣账单红冲后，预存余额经反向 ledger 恢复，原 APPLY 不被修改。
- 幂等：同一充值请求重放只产生一条 TOP_UP；同一账单不重复 APPLY。
- 冲正/退款只增不改：原流水保留，负向 entry 可追溯；日结后冲正不影响历史日结。
- 已消耗保护：已被 APPLY 消耗的 TOP_UP 直接全额冲正返回 `PREPAYMENT_ALREADY_APPLIED`，余额永不为负。
- 抵扣可解释：账单详情与收据均能看到预存抵扣金额与流水引用。
- 归属：水表户改挂结算户后，原结算户余额不迁移且 UI 有警告证据。
- e2e 覆盖：充值清欠（单次收款/单收据）、全额/部分/多账单抵扣、当日冲正、跨日冲正权限、已消耗 TOP_UP 冲正拒绝、退款上限、账单红冲回退、日结分项、余额重算一致性。

## Not in Scope

- 银行代扣、微信/支付宝等第三方支付渠道（v0.4+）。
- 复杂预存清算、跨主体资金池、预存利息。
- 预存欠费催缴策略、自动停复水联动。
- 客户自助充值/自助查询（APP/微信营业厅属 L4）。
- 一户多结算主体之间的资金划转；跨结算户预存余额迁移（TRANSFER_OUT/TRANSFER_IN）——有余额结算户改挂时仅 UI 警告，不做自动迁移。
