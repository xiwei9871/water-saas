# E6 Prepayment V1 — Domain Design v1.0

> Status: FROZEN（Domain Gate） · Base: `main @ aecbb04`（含 E5 Remote Reading V1）
> Product Spec: `E6_PREPAYMENT_V1.md`（Frozen）
> 本文档把 E6 预存落到现有收费资金链，不另造收款体系。所有"已对代码核实"
> 的论断均对照当前 main 的 schema / service / migration 原文。

---

## 1. Domain Gate 目标与结论

E6 的最重要结论：**预存不是一套新收款系统，而是嵌入现有资金链的一个
append-only 账本**。现有 `Payment / PaymentAlloc / Receipt /
CashierDayClose / Bill POSTED` 五个对象分别已经承担了：

| 领域职责 | 现有对象 | E6 处置 |
|---|---|---|
| 实际资金事件 | `Payment`（含负向 reversal payment） | 继续使用，不改语义 |
| 欠费销账事实 | `PaymentAlloc` | 扩展为 PAYMENT / PREPAYMENT 双来源 |
| 收据 | `Receipt → Payment` | 沿用，一次真实收款一张收据 |
| 收费员日结 | `CashierDayClose` | 现金口径不变，预存用途做分项 snapshot |
| 账单过账入口 | `BillingRunService.postOneBill` | POSTED 事务内接自动 APPLY |
| 预存余额 | 无 | **唯一新增对象** `PrepaymentLedgerEntry`（append-only，余额 = Σ） |

E6 完成后财务模块形成三条彼此独立、可互相勾稽的事实轴：

```
Cash     = Σ payment.amount                      （真钱，含负向）
Balance  = Σ prepayment_ledger_entry.amount      （预存余额，永远非负）
Payoff   = Σ payment_alloc.amount per bill       （欠费销账，不分资金来源）
```

---

## 2. 已对 main 核实的既有事实（E6 必须尊重）

### A. Payment 是 append-only 资金事实

`payment`：`(tenant_id, payment_no)` 唯一；`amount` bigint 分；`channel ∈
{CASH, POS, TRANSFER}`；`status ∈ {RECEIVED, DAY_CLOSED, REVERSED}`——
`REVERSED` 枚举值事实上已废弃（原 Payment 状态永不被改写）。冲正 =
新建负 Payment（`reversal_of_id → 原单`，同 channel/settleAccount，归属
**原收费员 cashierId + orgUnitId**，正负腿在同一柜员抽屉序列内净额），
`received_at` 落执行日 → 进下一个日结作负行。`payment.day_close_id` 由
RECEIVED→DAY_CLOSED 守护翻转一次性盖章——日结成员是存储事实而非边界重构。
`assertSettleScope`：settleAccount → waterAccounts → planItems → plans →
books 链，**所有**覆盖 book 的 org 都须在 `ctx.orgScope` 内；无计划锚点
的结算户放行（既有 MVP carve-out）。

### B. PaymentAlloc 已是唯一销账事实，且事实上 append-only

`payment_alloc`：`payment_id NOT NULL + bill_id + amount`（bigint 分）。
Bill 已付 = `Σ payment_alloc.amount`，负向 mirror alloc 自动净额
（`appliedByBill` 已按 Σ 工作，不区分来源）。销账校验：bill 须
`POSTED | PARTIAL_PAID`、非 REVERSAL-kind、outstanding > 0、
`alloc.amount ≤ outstanding`（409 `PAYMENT_OVER_ALLOCATION`）、
`bill.settleAccountId` 与 Payment 一致。表当前允许 UPDATE/DELETE
（ws_app），E6 正式硬化为 append-only（§16）。

### C. Bill 红冲是 POSTED 侧的追加纠正

`reverseTx`：守护翻转 `POSTED|PARTIAL_PAID → REVERSED` + 新建
REVERSAL-kind bill（金额、items 全负，`dueDate=null`，`sourceType=
ORIGINAL_BILL, sourceId=原 id`，`UNIQUE(tenant, sourceType, sourceId,
billKind)` 挡二次红冲）。**PAID 与 DRAFT 不可红冲**。REVERSED 账单上的
既有 alloc 留存 → `outstandingTx.reversedBillCredit` 把这部分记为
"客户应退"信用，提示走 Payment reversal 退款而非再收。

### D. postOneBill 是唯一的 POSTED 翻转点

`postOneBill`（每账单独立事务）：`water_account FOR UPDATE`（CLOSED 拒绝）
→ `tariff_plan FOR UPDATE` → 守护 `DRAFT→POSTED`（count=0 时重读，
POSTED 视为已成功幂等返回）。锁序固定 `water_account → tariff_plan →
bill`。这是 E6 自动 APPLY 的唯一插入点（§9）。

### E. CashierDayClose 是签字现金事实

`closeTx`：staff 行 `FOR UPDATE`（串行化同柜员日结）→ `(cashier,
closeDate)` 存在即 `DAY_CLOSE_EXISTS` → 扫描 `cashier_id = self AND
status = RECEIVED AND received_at::date <= closeDate`（**≤** 语义：晚到
的冲正滚进下一个日结，历史日结不动）→ `totalAmount = Σ payment.amount`、
`byChannel` 三渠道齐备（负行净额）→ 先建 close 行 → 守护翻转盖章
`day_close_id`。closeDate = 服务器 `CURRENT_DATE` 口径（与
`received_at` 同一时钟）。

### F. WaterAccount.transferTx 只改指向

`transferTx`：改 `customerId / settleAccountId` + 写 TRANSFER
account_event。资金侧无任何动作——天然满足"预存余额属于原结算户不迁移"
（§15）。

### G. 基础设施工件可直接复用

`IdempotencyKey`（UNIQUE(tenant, key)，PROCESSING→COMPLETED，响应信封
`{replayed,status,body}`）、`SequenceService.nextFormatted`
（payment_no `P…` / receipt_no `R…` 同事务取号）、全表 RLS
（`app.tenant_id` + tenant_id WITH CHECK）、审计拦截器
（`req.auditBefore`）、BigInt→string wire 约定、所有多行锁一律
`sorted(id)` 序。

---

## 3. 新增唯一对象：PrepaymentLedgerEntry

```
prepayment_ledger_entry
─────────────────────────────
id                     uuid PK
tenant_id              uuid NOT NULL          -- RLS
settle_account_id      uuid NOT NULL          -- 资金主体（§6）
type                   TOP_UP | APPLY | REFUND | REVERSAL
amount                 bigint  NOT NULL       -- 分，有符号（§4）
payment_id             uuid NULL              -- 真实现金流（TOP_UP/REFUND/REVERSAL-of-payment 关联）
bill_id                uuid NULL              -- APPLY / APPLY-REVERSAL 关联账单
origin_top_up_id       uuid NULL              -- lot 归属（§5）：APPLY/REFUND/部分 REVERSAL 必填
reversal_of_entry_id   uuid NULL              -- REVERSAL 冲哪条原流水
idempotency_key        text  NOT NULL
operator_id            uuid NULL              -- SYSTEM 写入为 NULL
reason                 text  NULL             -- REFUND/REVERSAL 必填
created_at             timestamptz
created_by             uuid NULL

UNIQUE (tenant_id, idempotency_key)
FK (tenant_id, settle_account_id) → settle_account(tenant_id, id)
FK (tenant_id, payment_id)        → payment(tenant_id, id)
FK (tenant_id, bill_id)           → bill(tenant_id, id)
FK (tenant_id, origin_top_up_id)  → prepayment_ledger_entry(tenant_id, id)
FK (tenant_id, reversal_of_entry_id) → prepayment_ledger_entry(tenant_id, id)
RLS: 与其它租户表同款 ENABLE + FORCE + tenant policy
```

DB CHECK：

- `type='APPLY'        ⟹ bill_id NOT NULL AND origin_top_up_id NOT NULL`
- `type='TOP_UP'       ⟹ amount > 0 AND payment_id NOT NULL AND origin_top_up_id IS NULL`
- `type='REFUND'       ⟹ amount < 0 AND payment_id NOT NULL AND origin_top_up_id NOT NULL AND reason NOT NULL`
- `type='REVERSAL'     ⟹ reversal_of_entry_id NOT NULL AND reason NOT NULL`
- `type='APPLY'        ⟹ amount < 0`（APPLY 恒为消耗）
- `reversal_of_entry_id ≠ id`、`origin_top_up_id ≠ id`

**append-only**：迁移内 `REVOKE UPDATE, DELETE, TRUNCATE ON
prepayment_ledger_entry FROM ws_app`（与 `remote_event_process_log`、
E5 末批 `raw_remote_event` 同款），无 immutable trigger 必要——连
UPDATE 都不授予。余额不设缓存字段：V1 规模下 `Σ amount` 实时计算；
未来性能问题再做物化投影，不从第一天引入可漂移的冗余列。

---

## 4. 符号语义（冻结）

| type | amount 符号 | 例 |
|---|---|---|
| TOP_UP | `+` 充值额 | `+120` |
| APPLY | `−` 抵扣额 | `−100` |
| REFUND | `−` 退款额 | `−20` |
| REVERSAL | `− 原 entry.amount` | 冲 TOP_UP +100 → `−100`；红冲回退 APPLY −100 → `+100` |

**REVERSAL 不恒为负**——`REVERSAL.amount = −originalEntry.amount`。
于是全账本无条件满足 `balance = Σ amount`，红冲恢复余额和冲正扣减余额
是同一条规则的两个方向。

---

## 5. Lot 归因：originTopUpId 是资金审计的核心

总余额无法回答"余额 120 是哪次充值剩下的"。冻结为 lot 模型：

```
TOP_UP A +100 ──┬─ APPLY −80   (origin_top_up_id = A)   → A.remaining = 20
TOP_UP B +100 ──┘                                        → B.remaining = 100
balance = 120
```

- APPLY / REFUND 必须 `origin_top_up_id →` 某条 TOP_UP。
- 某 lot 的可用余额：`lot.remaining = topUp.amount + Σ(归属该 lot 的
  APPLY/REFUND amount) + Σ(冲了该 lot TOP_UP 的 REVERSAL amount)
  + Σ(冲了该 lot 名下 APPLY 的 REVERSAL amount)`。
  实现上等价于：`lot.remaining = Σ ledger.amount WHERE id=topUpId OR
  origin_top_up_id=topUpId OR reversal_of_entry_id ∈ {topUpId} ∪
  {该 lot 名下 APPLY ids}`——SQL 两层子查询即可，V1 不需要物化。
- **消耗顺序冻结：TOP_UP `created_at ASC → id ASC`（FIFO）**。用户不选
  "花哪次充值的钱"；任何重试/重放得到相同分配结果。
- `PREPAYMENT_ALREADY_APPLIED`：冲正一条 TOP_UP 要求其 `remaining ==
  amount`（完整未消耗）。已部分消耗的 TOP_UP 不能全额冲正——若其名下
  APPLY 已被账单红冲反向恢复（REVERSAL +X 落回该 lot），remaining
  回到全额则重新允许。
- REFUND 可跨 lot 拆行：余额 A 30 + B 70 退 80 → 一笔负 Payment −80 +
  `REFUND −30 (origin=A)` + `REFUND −50 (origin=B)`，守恒且可溯。

---

## 6. 资金主体 = SettleAccount（唯一）

不加 `PrepaymentAccount`、不加 `settle_account.balance` 列。一户多水表户
共享同一结算户余额。余额只读接口：

```
GET /settle-accounts/:id/prepayment
  → { balance, lots: [{entryId, amount, remaining, createdAt}] }
```

---

## 7. PaymentAlloc 双来源（不造第二套销账）

`payment_alloc` 扩列：

```
source                PAYMENT | PREPAYMENT    NOT NULL DEFAULT 'PAYMENT'
payment_id            uuid NULL              -- 改为可空
prepayment_entry_id   uuid NULL              -- → prepayment_ledger_entry

CHECK (source='PAYMENT'    ⟹ payment_id NOT NULL AND prepayment_entry_id IS NULL)
CHECK (source='PREPAYMENT' ⟹ payment_id IS NULL AND prepayment_entry_id NOT NULL)
FK (tenant_id, prepayment_entry_id) → prepayment_ledger_entry(tenant_id, id)
```

- PREPAYMENT alloc 的 `prepayment_entry_id` 指向 **APPLY 那条 ledger
  entry**（不是 TOP_UP）——一笔 APPLY 对应一条 alloc，`apply_entry.amount
  = −alloc.amount`。
- Bill 已付仍是 `Σ payment_alloc.amount`；`appliedByBill`、
  `outstandingTx`、`reversedBillCredit` 全部分源不改逻辑（不区分
  source 的 Σ 天然正确）。需要区分资金来源的展示/红冲路径按
  `source`/`payment_id IS NULL` 过滤。
- `PAYMENT_OVER_ALLOCATION`、payable 状态集、账单状态重算规则对两种
  来源完全一致——一套销账逻辑。

---

## 8. TOP_UP 流程：`POST /prepayments/top-ups`（不改 `/payments` 语义）

现有 `POST /payments` 保持"`amount = Σ allocs`"的柜台缴费语义不动。
新增专用端点，输入仅 `{settleAccountId, channel, amount}`——**不给
allocs 参数**，清欠顺序由系统冻结决定：

```
事务内（一个柜台资金事件）：
  1. settle_account 存在性 + assertSettleScope
  2. settle_account 行 FOR UPDATE（预存资金锁，§14）
  3. 扫欠费队列：settleAccount 名下 status ∈ {POSTED, PARTIAL_PAID}
     且 bill_kind ≠ REVERSAL 且 outstanding > 0 的 bill
  4. 冻结排序：dueDate ASC NULLS LAST → period ASC → issuedAt ASC → id ASC
     （dueDate NULL 回退 period；与 Bill 字段对齐）
  5. 按序填满：每 bill alloc = min(outstanding, remaining) →
     PaymentAlloc(source=PAYMENT) + 守护重算账单状态
  6. 余款 > 0 → Ledger TOP_UP(remaining, payment_id=本 Payment,
     idempotency_key=topup:{paymentId})
  7. Payment(amount=全额, RECEIVED) + Receipt × 1
```

欠费清偿排序是 Domain 冻结，**前端不可重排、不可选"先付新账单"**。
全部缴清则无 TOP_UP；无欠费则全额 TOP_UP。Bill 行锁在§14 锁序内
按 sorted(id) 取——与既有 `createTx` 同款。

幂等：HTTP Idempotency-Key 外层 + ledger `topup:{paymentId}` 内层
（§12）。一次请求重放不产生第二条 Payment/TOP_UP。

---

## 9. Bill POSTED 自动 APPLY：整户队列重扫，不止新账单

`postOneBill` 在 DRAFT→POSTED 翻转后、**同一事务内**调用领域函数：

```
applyAvailablePrepaymentTx(tx, ctx, settleAccountId)
  1. settle_account FOR UPDATE
  2. balance = Σ ledger.amount；balance ≤ 0 → return
  3. 欠费队列 = 全户 {POSTED, PARTIAL_PAID, ≠REVERSAL, outstanding>0}
     按 §8.4 冻结排序（不只是刚 POST 的那张——旧欠费优先）
  4. FIFO 消耗 lot（§5），逐账单：
     alloc = min(lot.remaining, bill.outstanding, …)
     → Ledger APPLY(−alloc, bill_id, origin_top_up_id=lot,
        idempotency_key=apply:{billId}:{applyEntrySeq} 见 §12)
     → PaymentAlloc(source=PREPAYMENT, prepayment_entry_id=APPLY.id,
        bill_id, amount=+alloc)
     → 守护重算账单状态（POSTED→PARTIAL_PAID→PAID）
```

旧欠费 A 50 + B 30、余额 60、新单 C POSTED 100：按冻结序 A 50 → B 10 →
C 0，C 保持 POSTED 欠 100。**不是** "current bill first"。

同一事务保证无半状态（不可能"账单 POSTED 了但预存没抵"）。幂等：
`postOneBill` 重跑时账单已 POSTED 直接 return，不重复进 apply 路径；
apply 的 ledger 幂等键兜底 worker/API 级重试（§12）。

`applyAvailablePrepaymentTx` 是公共领域函数：账单过账、未来人工"立即
抵扣"入口、修复脚本共用。

---

## 10. Payment reversal 升级：混合资金整笔冲正

现有 `reverseTx`（负 Payment + mirror allocs + void receipt + 历史日结
不动）保留并扩展。原 Payment 拆腿：

```
原 Payment +200 = 欠费 alloc 80 + TOP_UP 120
              ↓ reverse
新 Payment −200（reversal_of_id→原单，归原柜员抽屉）
PaymentAlloc −80（mirror，source=PAYMENT）
Ledger REVERSAL −120（reversal_of_entry_id=TOP_UP 条目，
                      idempotency_key=reverse:{topUpEntryId}）
原 receipt void
```

前置检查：该 Payment 名下每条 TOP_UP 须 `remaining == amount`（完整未
消耗），否则 **409 `PREPAYMENT_ALREADY_APPLIED`**——不允许拿别的 lot
余额兜底。若名下 APPLY 已被账单红冲反向、lot 恢复全额，则允许。

锁序：Payment FOR UPDATE → settle_account FOR UPDATE →
water_accounts(sorted) → bills(sorted)（§14）。RECEIVED 原单进日结、
负单进下一个日结、DAY_CLOSED 原单不改历史——语义全部沿用。

## 11. REFUND：真钱流出，必须有负 Payment

`POST /prepayments/refunds {settleAccountId, channel, amount, reason}`：

```
settle_account FOR UPDATE → balance ≥ amount（否则 409
PREPAYMENT_INSUFFICIENT_BALANCE）→ FIFO 拆 lot →
Payment(−amount, channel, 归发起柜员抽屉) +
REFUND −X（origin_top_up_id 逐 lot，payment_id=负 Payment，
reason 必填，key=refund:{paymentId}:{topUpId}）
```

负 Payment 进当日日结 = 真实现金流出。不开收据（reversal 同理——收据
证明"收到钱"）；客户凭证是原收据 + 流水可查。权限
`prepayment:reverse`（高风险，§13）。

## 12. 幂等键体系（不只靠 HTTP 层）

| 写入 | idempotency_key |
|---|---|
| TOP_UP | `topup:{paymentId}` |
| APPLY | `apply:{billId}:{topUpId}`（同账单同 lot 唯一一次消耗） |
| TOP_UP 冲正 | `reverse:{topUpEntryId}` |
| APPLY 反向恢复 | `reverse:{applyEntryId}` |
| REFUND | `refund:{refundPaymentId}:{topUpId}` |

`UNIQUE(tenant_id, idempotency_key)` 让 worker retry / API retry /
BillingRun retry 撞库即幂等返回（插入撞唯一 → 读已有 entry 返回）。
HTTP Idempotency-Key 仍在外层（请求级响应重放）；ledger 键是事实级
兜底。

## 13. 权限冻结

| 操作 | 权限 |
|---|---|
| TOP_UP（含先清欠） | `payment:write`（既有） |
| 余额/流水查询 | `payment:read`（既有） |
| APPLY（系统自动） | SYSTEM，事务内不走用户权限 |
| 含 TOP_UP 的 Payment 冲正 | 本人 + 当日 + 未 DAY_CLOSED → `payment:write`；否则须 `prepayment:reverse`（新增，唯一新权限码） |
| REFUND | `prepayment:reverse` 恒定 |
| 删除/修改流水 | 永远无权限（DB REVOKE） |

"当日"沿用 `CashierDayClose` 的 operating-date 语义
（`received_at::date <= closeDate` 且 `day_close_id IS NULL` 视为未日结）
——不另造时间口径。

## 14. 锁顺序冻结（真实资金，先定后写）

预存资金锁 = `settle_account` 行 `FOR UPDATE`。所有 TOP_UP / APPLY /
REFUND / TOP_UP-REVERSAL 路径必须持有。

```
Payment reversal（含混合）：
  payment → settle_account → water_accounts(sorted) → bills(sorted)

TOP_UP / REFUND / applyAvailablePrepaymentTx：
  settle_account → bills(sorted)

postOneBill（含 APPLY 联动）：
  water_account → settle_account → tariff_plan → bills(sorted) → ledger
```

铁律：绝不出现一条路径 `bill → settle_account` 而另一条
`settle_account → bill`。`postOneBill` 原本 `water_account →
tariff_plan → bill`；加入预存后 settle_account 插在 water_account 之后、
bill 之前——账户锁先于资金锁，资金锁先于账单锁，单向无环。

与既有路径的相容性：`createTx`/`reverseTx` 锁 bills(sorted)；日结锁
staff 行后扫 payment（不碰 settle_account/bill）；`reverseTx` 的
payment→accounts→bills 序与新序一致（payment 锁只在自身路径出现）。
postOneBill 的 `water_account → settle_account` 与 reversal 的
`payment → water_accounts → settle_account` 同向；无反向等待对。

## 15. WaterAccount 改挂：余额不迁移，UI 警告

`transferTx` 不动任何流水——天然正确。E6 只做：

- `GET /settle-accounts/:id/prepayment` 供前端在改挂前查
  `balance > 0` → 弹窗"原结算户仍有预存余额 ¥x，过户后余额不随水表户迁移"，
  用户确认后照常 transfer；
- e2e：transfer 前 old balance=100 → 后 old=100、new=0；
- TRANSFER_OUT/IN 跨户资金划转继续 Not in Scope。

## 16. CashierDayClose：现金事实与非现金信息分离（Domain 澄清）

签字日结只确认真实资金运动——`totalAmount` 恒等于 `Σ payment.amount`：

- 混合收款 200（清欠 80 + 转预存 120）计 **200 一次**，绝不拆分双计；
- 负向 Payment（REVERSAL −200 / REFUND −80）照常进负行。

SYSTEM APPLY 没有柜员归属，**绝不塞进任何人的签字 close**（三柜员水司
无正确答案）。实现：

- `cashier_day_close` 增 `prepayment_breakdown JSONB`（immutable
  snapshot，与 `by_channel` 同批生成）：
  `{debtCollectionAmount, topUpAmount, refundAmount, reversalAmount}`——
  该柜员当日 Payment 的**用途拆分**，合计恒等于 totalAmount；
- 全公司当日 APPLY 总额（`Σ ledger WHERE type='APPLY' AND
  created_at::date = closeDate`）作为 **non-cash informational
  metric** 在日结界面/运营日报单列，不进 `totalAmount`，不属于任何
  柜员签字事实。

展示形态（信息项不归属签字）：

```
本柜现金实收        200
  其中欠费收费       80
  其中转预存        120
  退款/冲正           0
────────────────
现金净额           200

全公司当日预存抵扣   350   ← non-cash，仅信息
```

## 17. Receipt：一套收据模型 + DB 唯一性

混合 200 交易仍一张 Receipt（`Receipt → Payment`）：内容"本次收款 200
/ 欠费销账 80 / 转预存 120"由 Payment + PAYMENT-allocs + TOP_UP 实时
组合；账单详情/收据上的预存抵扣行由 `PaymentAlloc(source=PREPAYMENT)
→ prepayment_entry_id` 引用流水号。**不建** ReceiptLine /
PrepaymentReceipt。

DB 补 `UNIQUE(tenant_id, payment_id)`（当前仅 @@index）——一个真实资金
事件至多一张收据。reversal/REFUND 负 Payment 不开收据（沿用现有约定：
收据证明收款，冲正凭证是 voided 原收据 + 流水）。

## 18. payment_alloc 硬化为 append-only

代码已按事实表使用（正 alloc + 负 mirror，不改原行）。迁移正式：

```sql
REVOKE UPDATE, DELETE, TRUNCATE ON payment_alloc FROM ws_app;
```

现金 reversal（+80/−80）与预存 APPLY/reversal（+120/−120）同规则：
只增不改，账务模型统一。E2E 补 ws_app UPDATE/DELETE → 42501（沿用
E5 `remote-schema.e2e-spec.ts` 的特权测试模式）。

## 19. 接口面与错误码

```
POST   /prepayments/top-ups                 {settleAccountId, channel, amount}
POST   /prepayments/refunds                 {settleAccountId, channel, amount, reason}
GET    /settle-accounts/:id/prepayment      余额 + lots + 最近流水
GET    /settle-accounts/:id/prepayment-entries  全量流水（分页）
既有   POST /payments, /payments/:id/reverse, /bills/:id/reverse|replace 行为扩展
```

新错误码：`PREPAYMENT_ALREADY_APPLIED`（409）、
`PREPAYMENT_INSUFFICIENT_BALANCE`（409）、`PREPAYMENT_NOT_FOUND`（404）。
Bill reverse/replace 对"PAID 且含有效 PREPAYMENT alloc"放开（§20），
纯现金 PAID 维持不可红冲。

## 20. PAID Bill 红冲的精确放开

PAID + 存在有效 PREPAYMENT alloc → 允许 reverse/replace；纯现金 PAID
维持禁止。混合支付红冲按来源分别逆转：

```
Bill 100 PAID = cash alloc 40 + prepayment alloc 60
红冲同事务：
  PREPAYMENT 腿：每条 APPLY → Ledger REVERSAL(+60, reversal_of_entry_id=
    APPLY.id, bill_id) + mirror PaymentAlloc(source=PREPAYMENT, −60)
    → 余额恢复 60，原 APPLY 永不修改
  PAYMENT 腿：alloc 保留（append-only），bill 已付归零 →
    reversedBillCredit 记 40 客户信用 → 走 Payment reversal 退现金，
    不自动替客户退款
```

`CORRECTABLE_STATUSES` 从 `{POSTED, PARTIAL_PAID}` 扩为运行时判定：
`POSTED|PARTIAL_PAID` 恒可，或 `PAID AND EXISTS(source=PREPAYMENT
alloc)`。replace 同理（replace 内部先 reverse 再补 REPLACEMENT bill；
REPLACEMENT POSTED 后立即走 §9 自动 APPLY——恢复出来的余额可能随即
又抵进新账单，这是正确行为：lot FIFO 语义保证确定性）。

## 21. DB 不变量清单（实现期逐条落 migration + DB 级测试）

1. `prepayment_ledger_entry`：ws_app 仅 SELECT/INSERT（REVOKE
   UPDATE/DELETE/TRUNCATE）。
2. `payment_alloc`：ws_app REVOKE UPDATE/DELETE/TRUNCATE。
3. Ledger type↔字段 CHECK（§3 六条）。
4. `UNIQUE(tenant_id, idempotency_key)`。
5. `receipt` 增 `UNIQUE(tenant_id, payment_id)`。
6. `payment_alloc` source CHECK（§7 两条）+ `prepayment_entry_id` FK。
7. Ledger FK 全部 `(tenant_id, …)` 复合形式（对齐全库惯例）。
8. 余额非负不由 CHECK 表达（余额是 Σ，不是行）——由"settle_account
   锁内重算 + lot.remaining ≥ 消耗额"的服务纪律保证，e2e 并发用例
   验证不为负。
9. RLS：新表同款 tenant policy；`tenant_id` 全部 NOT NULL + WITH
   CHECK。

## 22. 测试矩阵（e2e + DB，验收口径）

**e2e（HTTP）**——对应 Product Spec Acceptance：

- 充值先清欠：欠 80 交 200 → 1 Payment(+200) + 1 Receipt +
  alloc(80, PAYMENT) + TOP_UP(120)；日结 totalAmount=200 不双计。
- 无欠费全额 TOP_UP；欠 250 交 200 → 全清欠无 TOP_UP。
- Bill POSTED 自动抵扣：余额 120 抵 130 → PARTIAL_PAID 10 + APPLY
  −120 + PREPAYMENT alloc +120；足额 → PAID。
- 多账单冻结序：A80/B60/C50 余额 150 → A 全、B 60、C 10。
- 整户重扫：旧欠 A50+B30 余额 60，新单 C POSTED 100 → A50、B10、C 0。
- TOP_UP 重放：同请求重放不产第二 Payment/TOP_UP（HTTP 幂等 +
  ledger 键）。
- Payment reversal 混合腿：−200 Payment + −80 alloc + −120
  REVERSAL；TOP_UP 已消耗 → `PREPAYMENT_ALREADY_APPLIED`；名下
  APPLY 被账单红冲恢复后 → 可冲正。
- REFUND：余额 100 退 80（跨 lot 拆行）→ 负 Payment 进日结；
  退 120 → `PREPAYMENT_INSUFFICIENT_BALANCE`。
- Bill 红冲回退：APPLY 账单红冲 → REVERSAL +X 恢复余额 + mirror
  PREPAYMENT alloc −X；纯现金 PAID 红冲仍 409；PAID+预存可红冲。
- 权限：本人当日未日结冲正 `payment:write` 可过；跨日/他人须
  `prepayment:reverse`；REFUND 无该权限 → 403。
- 日结分项：prepayment_breakdown 合计 = totalAmount；APPLY 非现金
  信息项不进任何柜员 close。
- 改挂：old 户余额 100 改挂 → old=100 new=0。
- 并发：同一 settleAccount 两笔并发 TOP_UP/APPLY 序列化，余额
  永不为负；Payment reversal ∥ Bill reverse 不撕裂混合腿。

**DB 级**（ws_app 直连，沿用 remote-schema spec 模式）：ledger
UPDATE/DELETE/TRUNCATE → 42501；payment_alloc UPDATE/DELETE →
42501；type CHECK 拒绝矩阵；幂等键唯一；receipt (tenant,payment)
唯一。

## 23. Not in Scope（V1 冻结）

- 跨结算户资金划转（TRANSFER_OUT/IN）、预存利息、资金池清算。
- 第三方支付渠道、自助充值/查询。
- 余额物化缓存列（V1 实时 Σ）。
- REFUND/REVERSAL 的独立凭证模型（流水 + voided 收据即审计链）。
- 已消耗 TOP_UP 的"自动回退整串账单 APPLY"——拒绝即可，人工分步
  回退（Product Spec §11 同款）。
- Vendor/渠道级对账文件导入（属既有收费渠道语义之外）。
