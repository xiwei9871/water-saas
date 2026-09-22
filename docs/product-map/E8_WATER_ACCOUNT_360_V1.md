# E8 — WaterAccount 360° V1（Product Gate）

> 状态：**Draft for Gate**。E7 已合并（main @ b086b32）。本 Epic 是**聚合视图**，不是新业务流程——各领域对象继续作为 Source of Truth，360 只聚合，不复制事实。

## 1. 定位与用户

WaterAccount = 水务运营的对象中心。从一个户出发，柜面/抄表班长/客服能在**一个页面**回答"这户现在什么状况"。

| 用户 | 典型场景 |
|---|---|
| 柜台收费员 | 用户来缴费：查欠 → 看预存 → 看最近账单 → 收款。需要 outstanding + prepay balance + 最近账单一屏可见 |
| 抄表班长 | 用户报"表不对/读数不对"：看当前表、最近读数、换表史、抄表册归属 |
| 客服/主管 | 投诉或审计：完整时间线（户事件 + 表事件 + 账单 + 支付），CLOSED 户历史可读 |
| 营业所人员（scoped） | 只能看自己册覆盖的户——**E8 把读侧 scope 补齐是本 Epic 的一半价值** |

## 2. 页面 IA

既有 `WaterAccounts` 列表行内增加「360」入口 → 独立详情页 `/water-accounts/:id`（E7 的水表抽屉内容迁移/复用为「水表」Tab）。

```
┌ Header：户号 · 客户 · 状态Tag · 欠费合计 · 预存余额 · warning badges ┐
├ 概览(summary，首屏一次拉取)                                        ┤
├ Tabs（懒加载分页）                                                 ┤
│  水表 | 抄表 | 用量结算 | 账单欠费 | 支付 | 预存 | 生命周期          │
└───────────────────────────────────────────────────────────────────┘
```

### A. 概览（summary，非 Tab，随页首渲染）

- accountNo / customer / settleAccount / 地址 / usageCategory / status / billable / openedAt / closedAt / householdSize
- 当前册归属（bookNo + orgUnit 名）与当前期 plan item 状态
- 当前表（meterNo + installedAt）、最近有效读数（值 + readDate + resultType + qcStatus，标注属于哪条 installation）
- outstanding 合计 + 最近账单行、prepay balance
- warning badges（§6）

### B. 水表 Tab（复用 E7，禁止重写）

当前 ACTIVE（installed_at DESC 最新）、>1 ACTIVE 警示、installation timeline、装/换/拆操作、meter detail 抽屉——全部沿用 E7 组件与 API。

### C. 抄表 Tab

- 当前册 + 当前期 plan item（seqNo、状态、plannedInstallation）
- 最近有效读数卡片 + 历史读数表（分页）：period / readDate / readingValue / resultType / qcStatus / source / installation（meterNo）/ superseded 标记
- 空态：无读数 → 「该户尚无有效读数」；换表后当前 installation 无读数 → 明确显示「当前表暂无读数」，历史读数归属旧表单独标注

### D. 用量结算 Tab

- settlement 列表（分页）：period / totalUsageQty / isEstimated / status
- 行展开 → consumption components：installation（meterNo）/ prev→end / usageQty / sourceType
- 期中换表期天然显示多条 component（E7 已验证 0→80、10→35 双段）
- 不重算用量——只读 settlement engine 结果

### E. 账单欠费 Tab

- outstanding 卡：totalOutstanding + reversedBillCredit + prepayBalance（**唯一 SoT = `GET /water-accounts/:id/outstanding`**，前端不做 bill−payment 自算）
- 账单列表（分页）：period / billKind / totalAmount / paidAmount / outstanding / status / isEstimated / dueDate

### F. 支付 Tab

- 列表按 **allocation** 呈现而非 payment.amount：一笔 payment 跨多户账单时，本户只看到分摊到本户账单的金额
- 列：receivedAt / paymentNo / channel / status / **allocatedToAccount**（本户所得）/ 关联 bill period / cashier
- payment 全额与跨户分摊细节不进 360（那是支付域详情页的事）

### G. 预存 Tab（复用 E6）

- balance + lots（余额卡）
- entries 流水（分页）：type / amount / operator / bill / createdAt（沿用 E6 语义，SYSTEM=自动抵扣）

### H. 生命周期 Tab

- **户**事件 timeline：TRANSFER / SUSPEND / RESUME / CLOSE（account_event，append-only）
- 与表生命周期分开—— installation timeline 在水表 Tab，不混入
- 注意：schema 中 AccountEventType 无 OPEN 值，开户事件不落 account_event——首行由 `openedAt` 合成展示，不伪造事件行

## 3. CLOSED / SUSPENDED

- **CLOSED**：360 全量可读（历史账单/支付/表史/读数/结算/事件）；所有写操作隐藏（装表/换表/拆表/过户/停复/编辑/申报人数）。
- **SUSPENDED**：按各领域现行规则，本 Epic 不改语义（表务允许、结算/账单按现状）。

## 4. Org Scope（本 Epic 的另一半）

沿用冻结规则：WaterAccount → ReadingPlanItem → ReadingPlan → ReadingBook.orgUnitId；**任一覆盖册出界 → 整户出界；无册户宽放**。

**审计发现（main @ b086b32 事实）——读侧 scope 缺口是系统性的**：

| 端点 | 读 scope 现状 |
|---|---|
| GET /water-accounts、/:id、household-profiles | ❌ 无 |
| GET /customers、/:id | ❌ 无 |
| GET /settle-accounts、/:id | ❌ 无 |
| GET /water-accounts/:id/outstanding | ❌ 无 |
| GET /payments、/:id | ❌ 无（写路径已 scope） |
| GET /bills、/:id | ❌ 无（reverse/replace 已 scope） |
| GET /consumption-settlements、/:id | ❌ 无（generate/finalize 已 scope） |
| GET /meter-readings、/:id | ❌ 无（qc/supersede/import 已 scope） |
| GET /reading-books、/:id、/reading-plans 系列 | ❌ 无（写路径已 scope） |
| POST /estimate/preview | ❌ 无（只探存在性） |
| GET /meter-installations、/meters、/prepayments/* | ✅ E7/E6 已修 |

E8 必须：360 页所有子查询统一走 coverage 规则；上述 ❌ 端点在 E8 补齐读 scope（同租户内 Branch A 不可读 Branch B 户的任何资源，**包括经 detail 嵌套的旁路**）。

## 5. Warning / Attention（计算型 badges，不建表）

deterministic 派生，summary 内一次算出：

- `MULTI_ACTIVE_METER` >1 ACTIVE installation
- `NO_ACTIVE_METER` 非 CLOSED 户无 ACTIVE 表
- `NO_BOOK` 无任何册覆盖（抄不到表风险）
- `NO_RECENT_READING` 当前 installation 无有效读数
- `ESTIMATED` 最近 settlement isEstimated
- `OUTSTANDING` totalOutstanding > 0
- `CLOSED_WITH_DEBT` CLOSED 且仍有 outstanding

禁止扩成"异常检测平台"。

## 6. UAT slices

- S1 概览首屏：户头 + 当前表 + 最近读数 + outstanding + 预存一屏齐
- S2 换表户：当前表=新表、最近读数属新 installation、水表 Tab 双记录、结算 Tab 期中双 component 展开
- S3 支付分摊：settle account 下两户，payment 跨户分配 → 本户只显示本户 alloc 金额
- S4 CLOSED 户：全 Tab 可读、写操作全隐藏
- S5 scope：Branch A 用户访问 Branch B 户的 360 → 403；各 Tab 端点单独调用也 403（嵌套旁路测试）
- S6 warnings：多 ACTIVE 表户 + 无册户 + 欠费户 badges 正确
- S7 分页：账单/支付/读数/事件超过页大小可翻页，首屏不炸量

## 7. Not in Scope

- 不改 settlement/payment/prepayment/meter 任何领域逻辑；不建 warning 表；不做跨户对比/报表；不做 360 导出；不改 CLOSED/SUSPENDED 业务语义；无 schema/migration。
