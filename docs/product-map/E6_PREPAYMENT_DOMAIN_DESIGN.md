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
| 正向 POSTED 债务入口 | `postOneBill` / `replaceTx` / `ReconciliationService.createTx` 正 ADJUSTMENT | 同事务接自动 APPLY（§9） |
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

### D. 可支付 POSTED 债务的产出不只 postOneBill 一处

`postOneBill`（每账单独立事务）：`water_account FOR UPDATE`（CLOSED 拒绝）
→ `tariff_plan FOR UPDATE` → 守护 `DRAFT→POSTED`（count=0 时重读，
POSTED 视为已成功幂等返回）。锁序固定 `water_account → tariff_plan →
bill`。

但 `BillService.replaceTx` 直接 `create` 一条 `status=POSTED` 的
REPLACEMENT bill，`ReconciliationService.createTx` 也会直接建
`billKind=ADJUSTMENT, status=POSTED, sourceType=RECONCILIATION` 且金额
可正可负——POSTED 债务的产出不只有 run 入口，且正 ADJUSTMENT 是
**当前 main 已存在的生产路径**，不是未来扩展。因此 E6 自动 APPLY 的
触发点冻结为**领域事件**"新的正向可支付债务进入 POSTED"，而不是某个
service 方法名（§9）。实现时必须再全库搜索一遍
`status: 'POSTED'`/`bill.create` 路径（含未来 correction 入口），
确保无一漏接；`billKind='REVERSAL'`（负向纠正单）与非正金额
ADJUSTMENT 恒不触发 APPLY。

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
UNIQUE (tenant_id, settle_account_id, id)   -- 供 ledger 自引用复合 FK
FK (tenant_id, settle_account_id) → settle_account(tenant_id, id)
FK (tenant_id, settle_account_id, payment_id)   → payment(tenant_id, settle_account_id, id)
FK (tenant_id, settle_account_id, bill_id)      → bill(tenant_id, settle_account_id, id)
FK (tenant_id, settle_account_id, origin_top_up_id)     → self(tenant_id, settle_account_id, id)
FK (tenant_id, settle_account_id, reversal_of_entry_id) → self(tenant_id, settle_account_id, id)
RLS: 与其它租户表同款 ENABLE + FORCE + tenant policy
```

Ledger 引用全部按 **(tenant, settleAccount, target)** 复合 FK——不只
保证同租户，还保证同资金主体：一条 entry 的 payment / bill /
originTopUp / reversalOf 必然落在同一个 settle_account 名下（为此
`payment` / `bill` 各补 `UNIQUE(tenant_id, settle_account_id, id)`）。

DB CHECK：

- `type='TOP_UP'   ⟹ amount > 0 AND payment_id NOT NULL AND origin_top_up_id IS NULL AND reversal_of_entry_id IS NULL AND bill_id IS NULL`
- `type='APPLY'    ⟹ amount < 0 AND bill_id NOT NULL AND origin_top_up_id NOT NULL AND payment_id IS NULL`
- `type='REFUND'   ⟹ amount < 0 AND payment_id NOT NULL AND origin_top_up_id NOT NULL AND reason NOT NULL`
- `type='REVERSAL' ⟹ reversal_of_entry_id NOT NULL AND origin_top_up_id NOT NULL AND reason NOT NULL`
- `reversal_of_entry_id ≠ id`、`origin_top_up_id ≠ id`
- REVERSAL target 仅 `TOP_UP`/`APPLY`（跨行规则，CHECK 表达不了——
  服务层拒绝其它 target，e2e 覆盖）。

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

- **一切影响某 lot 余额的非 TOP_UP entry 都必须写
  `origin_top_up_id`**（DB CHECK 强制，§3）：APPLY、REFUND、
  REVERSAL-of-APPLY、REVERSAL-of-TOP_UP 全部直接归属 lot——

```
TOP_UP A +100   origin=null
APPLY    −80    origin=A
REFUND   −10    origin=A
REVERSAL +80    origin=A, reversal_of=那条APPLY
REVERSAL −100   origin=A, reversal_of=TOP_UP A
```

  于是 lot 余额是**单层聚合**，不需要二层追踪：

```
lot.remaining = topUp.amount + Σ entry.amount
                WHERE origin_top_up_id = topUp.id
```

- REVERSAL 的合法 target 只有 `TOP_UP` 与 `APPLY` 两种。REFUND 自身的
  "撤销退款" Product Spec 未定义——V1 不支持，也不悄悄留口。
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
FK (tenant_id, prepayment_entry_id, bill_id)
   → prepayment_ledger_entry(tenant_id, id, bill_id)   -- 同一条 Bill，见下
UNIQUE (tenant_id, prepayment_entry_id)   -- 一条 settlement entry 至多一条 alloc
```

**billId 一致性由 DB 保证（冻结）**：`prepayment_ledger_entry` 增
`UNIQUE(tenant_id, id, bill_id)`，`payment_alloc` 用
`(tenant_id, prepayment_entry_id, bill_id)` 复合 FK 引用它——于是
`alloc.billId ≡ entry.billId` 在数据库层成立，服务写错目标账单的 bug
会直接 23503 而非静默错账（MATCH SIMPLE 下两列均非 NULL 才校验，
PAYMENT 行 entry 为 NULL 不受影响）。ledger 自身的
`(tenant, settleAccount, bill)` 复合 FK 又保证该账单属于同一结算户，
资金链闭合。

- **`prepayment_entry_id` 指向产生该 Allocation 的那条 ledger
  entry**（冻结，不是指向 lot 的 TOP_UP）：

```
正常抵扣：  Ledger APPLY     −60  →  PaymentAlloc +60 → prepaymentEntryId=APPLY
账单红冲：  Ledger REVERSAL  +60  →  PaymentAlloc −60 → prepaymentEntryId=REVERSAL
```

  统一不变量：`PREPAYMENT alloc.prepaymentEntryId` 的目标 entry 满足
  `type='APPLY'` 或 `type='REVERSAL' AND reversal_of_entry_id 指向一条
  APPLY`，且 `ledgerEntry.amount = −alloc.amount`（触发器或服务纪律 +
  e2e 验证；`UNIQUE(tenant, prepayment_entry_id)` 保证一条 settlement
  entry 至多产出一条 alloc，模型保持 1:1）。
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
事务内（一个柜台资金事件；写入顺序受 FK 约束——alloc/ledger 都引用
Payment，Payment 必须先落行。"先清欠"是资金用途的优先顺序，不是
INSERT 的物理顺序）：
  1. settle_account 存在性 + assertSettleScope
  2. settle_account 行 FOR UPDATE（预存资金锁，§14）
  3. 扫欠费队列：settleAccount 名下 status ∈ {POSTED, PARTIAL_PAID}
     且 bill_kind ≠ REVERSAL 且 outstanding > 0 的 bill，
     行锁按 sorted(id) 取（与既有 createTx 同款）
  4. 按冻结 comparator（§8a）计算本次用途拆分
     （欠费 X、转预存 amount−X）——纯内存计算，先不写库
  5. 创建 Payment(amount=全额, RECEIVED)
  6. 创建欠费 PaymentAlloc(source=PAYMENT) 各行
  7. 余款 > 0 → Ledger TOP_UP(remaining, payment_id=Payment.id,
     idempotency_key=topup:{paymentId})
  8. 创建 Receipt × 1
  9. 守护重算各 bill 状态（POSTED→PARTIAL_PAID→PAID）
```

### 8a. 欠费排序 comparator（冻结，唯一实现）

TOP_UP 清欠与自动 APPLY 必须调用**同一个排序 helper**。冻结算法：

```
effectiveDueKey(bill) = bill.dueDate ?? endOfMonth(bill.period)
   -- dueDate 为 NULL 时回退 period 当月最后一天（冻结此口径，
   --    不允许各实现自行理解"NULLS LAST"）

ORDER BY effectiveDueKey ASC
       → period ASC
       → issuedAt ASC NULLS LAST
       → id ASC
```

即：`period='202607'` 且无 dueDate 的账单按 `2026-07-31` 参与比较——
有明确 dueDate 的 6 月账单仍排在它之前，而无 dueDate 的 202401 老账
（key=2024-01-31）排在最前。比 `dueDate ASC NULLS LAST` 更贴近
"账龄"语义：NULL dueDate 不是"永不逾期"，而是"以出账期月为准"。

欠费清偿排序是 Domain 冻结，**前端不可重排、不可选"先付新账单"**。
全部缴清则无 TOP_UP；无欠费则全额 TOP_UP。

幂等：HTTP Idempotency-Key 外层 + ledger `topup:{paymentId}` 内层
（§12）。一次请求重放不产生第二条 Payment/TOP_UP。

---

## 9. 自动 APPLY：触发点是"新正向 POSTED 债务"，不是某个方法名

冻结为领域函数 + 明确的调用集合：

```
applyAvailablePrepaymentForPostedDebtTx(tx, ctx, settleAccountId)
  1. settle_account FOR UPDATE（§14；调用方须已持 water_account 锁）
  2. balance = Σ ledger.amount；balance ≤ 0 → return
  3. 欠费队列 = 全户 {POSTED, PARTIAL_PAID, ≠REVERSAL, outstanding>0}
     按 §8a 冻结 comparator（不只是刚 POST 的那张——旧欠费优先）；
     队列内 bill 行锁按 sorted(id) 取
  4. FIFO 消耗 lot（§5），逐账单：
     alloc = min(lot.remaining, bill.outstanding)
     → Ledger APPLY(−alloc, bill_id, origin_top_up_id=lot,
        idempotency_key=apply:{billId}:{topUpId})
     → PaymentAlloc(source=PREPAYMENT, prepayment_entry_id=APPLY.id,
        bill_id, amount=+alloc)
     → 守护重算账单状态（POSTED→PARTIAL_PAID→PAID）
```

**调用集合（冻结，实现时全库搜索 `bill` POSTED 产出点逐一核对）**：

| 路径 | 接入方式 |
|---|---|
| `BillingRunService.postOneBill` | DRAFT→POSTED 翻转后同事务调用 |
| `BillService.replaceTx` | REPLACEMENT bill 建为 POSTED 后同事务调用 |
| `ReconciliationService.createTx`（正 ADJUSTMENT） | `totalAmount > 0` 的 ADJUSTMENT bill 建为 POSTED 后同事务调用；`totalAmount <= 0` 不触发 |
| 未来任何"正向可支付债务进入 POSTED"的路径 | 必须调用；`billKind='REVERSAL'`（负向纠正单）恒不触发 |

旧欠费 A 50 + B 30、余额 60、新单 C POSTED 100：按冻结序 A 50 → B 10 →
C 0，C 保持 POSTED 欠 100。**不是** "current bill first"。

同一事务保证无半状态（不可能"账单 POSTED 了但预存没抵"）。幂等：
`postOneBill` 重跑时账单已 POSTED 直接 return，不重复进 apply 路径；
apply 的 ledger 幂等键兜底 worker/API 级重试（§12）。

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

锁序：Payment FOR UPDATE → water_accounts(sorted) →
settle_account FOR UPDATE → bills(sorted)（§14——与现有实现同向，
且与 postOneBill 的 `water→settle` 不构成反向等待对）。RECEIVED 原单
进日结、负单进下一个日结、DAY_CLOSED 原单不改历史——语义全部沿用。

**退款 Payment 不可再冲正**：REFUND 生成的负 Payment 是资金流出事实，
`/payments/:id/reverse` 对它再 reverse 会凭空造出正腿。冻结：
被 REFUND ledger entry 引用的 Payment → `reverse` 拒绝
`PAYMENT_NOT_REVERSABLE`（与"reversal 不可再 reverse"同码族）。

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
BillingRun retry 撞库即幂等。HTTP Idempotency-Key 仍在外层（请求级
响应重放）；ledger 键是事实级兜底。

**幂等写入实现合同（冻结，E5 踩过的坑）**：禁止"catch 唯一冲突后在同
一 PostgreSQL 事务内继续查询"——unique violation 会 abort 整个 tx，
后续 SELECT 也失败。一律用：

```
INSERT ... ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
RETURNING ...
  -- 无 RETURNING 行 → SELECT existing（此时无 aborted 态）
```

或在持有 `settle_account FOR UPDATE` 锁时先 probe 再插（锁内串行，
probe 可靠）。

## 13. 权限冻结

| 操作 | 权限 |
|---|---|
| TOP_UP（含先清欠） | `payment:write`（既有） |
| 余额/流水查询 | `payment:read`（既有） |
| APPLY（系统自动） | SYSTEM，事务内不走用户权限 |
| 含 TOP_UP 的 Payment 冲正 | 同时满足下方三个"当日错收"条件 → `payment:write`；否则须 `prepayment:reverse`（新增，唯一新权限码） |
| REFUND | `prepayment:reverse` 恒定 |
| 删除/修改流水 | 永远无权限（DB REVOKE） |

**"当日错收"冻结为可编码的三元条件**（缺一不可）：

```
original.cashierId   = ctx.staffId
original.dayCloseId IS NULL
original.receivedAt::date = CURRENT_DATE   -- DB 时钟，与 DayClose 同口径
```

`dayCloseId IS NULL` 单独**不等于**"当日"——昨天漏日结的充值今天仍未
日结，但已不是当日错收。三条件全过 → `payment:write` 可冲正；任一不
满足且 Payment 名下含 TOP_UP → 必须 `prepayment:reverse`。

**实现合同**：`/payments/:id/reverse` 的 Guard 不能用单一
`@Permissions('payment:write')`（会把只持 `prepayment:reverse` 的主管
拦在 service 外），改为

```
@AnyPermissions('payment:write', 'prepayment:reverse')
```

service 内再按上表二次判定：普通现金 Payment 冲正仍要求
`payment:write`（`prepayment:reverse` 不顺带授予普通冲正权）；含
TOP_UP 的 Payment 按三元条件分流两码。

## 14. 锁顺序冻结（真实资金，先定后写）

预存资金锁 = `settle_account` 行 `FOR UPDATE`。所有 TOP_UP / APPLY /
REFUND / TOP_UP-REVERSAL 路径必须持有。

```
Payment reversal（含混合）：
  payment → water_accounts(sorted) → settle_account → bills(sorted)

TOP_UP / REFUND：
  settle_account → bills(sorted)

新 POSTED 债务（postOneBill / replaceTx，含 APPLY 联动）：
  water_account → settle_account → tariff_plan → bills(sorted) → ledger

Bill reverse / replace（含预存回退）：
  water_account → settle_account → tariff_plan（如需要）→ bills/ledger
```

铁律（冻结）：**任何路径都不允许 `settle_account → water_account` 的
锁序**——`postOneBill`/`replaceTx` 是 `water → settle`，若 Payment
reversal 写成 `settle → water` 则并发时 Tx A 持 settle 等 water、
Tx B 持 water 等 settle，构成标准 deadlock。统一方向后所有路径都是
`账户 → 资金 → 账单` 单向链。同理不允许一条 `bill → settle` 对另一条
`settle → bill`。

与既有路径的相容性：`createTx`/`reverseTx` 锁 bills(sorted)（reverse
本就是 `payment → accounts → bills`，插入 settle_account 于
accounts 之后、bills 之前即可，与现状最接近、改动最小）；日结锁
staff 行后扫 payment（不碰 settle_account/bill）；payment 行锁只在
reversal 自身路径出现，无环。

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
  该柜员当日 Payment 的**用途拆分**，合计恒等于 totalAmount。
  计算口径冻结（按 Payment 整条归类，不二次拆负单，否则一笔 −200
  混合冲正会被再拆成 −80 debt + −120 reversal 双计）：

  | Payment 形态 | 归类 |
  |---|---|
  | 普通正 Payment（reversalOfId=null，无 REFUND 引用） | debtCollection = Σ 其 PAYMENT allocs；topUp = Σ 其名下 TOP_UP；两者合计 = amount |
  | REFUND 产生的负 Payment | 整笔 → refundAmount |
  | reversal Payment（reversalOfId ≠ null，含混合冲正） | 整笔 → reversalAmount |
  | 无预存参与的普通缴费 | debtCollection = amount |
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
3. Ledger type↔字段 CHECK（§3 七条：非 TOP_UP 必带
   `origin_top_up_id`；REVERSAL 必带 `reversal_of_entry_id+reason`）。
4. `UNIQUE(tenant_id, idempotency_key)`。
5. `receipt` 增 `UNIQUE(tenant_id, payment_id)`。
6. `payment_alloc` source CHECK（§7 两条）+ `UNIQUE(tenant_id,
   prepayment_entry_id)`（1 settlement entry : 1 alloc）+
   复合 FK `(tenant_id, prepayment_entry_id, bill_id)` →
   `ledger(tenant_id, id, bill_id)`（配套 ledger
   `UNIQUE(tenant_id, id, bill_id)`）——DB 层强制
   `alloc.billId ≡ entry.billId`。
7. Ledger 引用全部 `(tenant_id, settle_account_id, target)` 复合 FK；
   配套 `payment`/`bill` 增 `UNIQUE(tenant_id, settle_account_id, id)`、
   ledger 自身 `UNIQUE(tenant_id, settle_account_id, id)`——同租户且
   同资金主体，不止同租户。
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
  永不为负；Payment reversal ∥ Bill reverse 不撕裂混合腿；
  Payment reversal ∥ postOneBill 走同向锁序（water→settle），
  无 deadlock。
- REPLACEMENT bill 触发 APPLY：`replaceTx` 产出的正向 POSTED 债务
  立即参与抵扣；REVERSAL-kind bill 不触发。
- Reconciliation 正 ADJUSTMENT：`totalAmount > 0` → POSTED 同事务
  APPLY；`totalAmount <= 0` → 不触发（当前 main 已有路径，非扩展）。
- "当日错收"三条件：本人+未日结+receivedAt=今日 → payment:write 过；
  昨日未日结的 TOP_UP 单冲正（dayCloseId 仍 NULL）→ 须
  prepayment:reverse；只有 prepayment:reverse 的主管过 Guard 后普通
  现金冲正仍 403。
- 排序 comparator：dueDate NULL 的 202401 老账（key=月末）排在前，
  有 dueDate 的新账按 dueDate；两实现（TOP_UP 清欠 / 自动 APPLY）
  同序。
- REFUND Payment 再冲正 → `PAYMENT_NOT_REVERSABLE`。
- 红冲 alloc 归因：REVERSED 账单上 PREPAYMENT 腿的 −X alloc 指向
  REVERSAL entry（不指向原 APPLY），1:1。
- prepayment_breakdown：混合正单拆分 debtCollection/topUp；REFUND/
  reversal 负单整笔归类，四项合计 = totalAmount。

**DB 级**（ws_app 直连，沿用 remote-schema spec 模式）：ledger
UPDATE/DELETE/TRUNCATE → 42501；payment_alloc UPDATE/DELETE →
42501；type CHECK 拒绝矩阵；幂等键唯一；receipt (tenant,payment)
唯一；PREPAYMENT alloc 指向 billId 不一致的 ledger entry →
23503（复合 FK）；幂等写入走 `ON CONFLICT DO NOTHING RETURNING`
回归用例（同事务重放不 abort）。

## 23. Not in Scope（V1 冻结）

- 跨结算户资金划转（TRANSFER_OUT/IN）、预存利息、资金池清算。
- 第三方支付渠道、自助充值/查询。
- 余额物化缓存列（V1 实时 Σ）。
- REFUND/REVERSAL 的独立凭证模型（流水 + voided 收据即审计链）。
- 已消耗 TOP_UP 的"自动回退整串账单 APPLY"——拒绝即可，人工分步
  回退（Product Spec §11 同款）。
- Vendor/渠道级对账文件导入（属既有收费渠道语义之外）。
