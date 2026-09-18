# 水务抄表收费 SaaS — MVP 设计规格 v1.1

日期：2026-09-18（v1.1 修订）
状态：待评审

## 0. 背景与范围基线

- 旧《营销系统需求分析》（`/Users/xiwei/营销系统需求分析.md`）仅作为水务业务语义和历史场景的**背景参考**，不构成本项目的功能范围、技术栈或合同约束。其中 SQL Server、C/S 架构、IE、智能表平台、银行代扣、电子发票、周检、监控表等内容**不进入本 MVP**。
- 本项目是一套**多租户 SaaS** 抄表收费系统：每家水司 = 一个租户。MVP 目标是"**可以真实小规模试用**"——数据模型按生产系统设计，但不追求 400 万户规模和全渠道收费。
- 技术栈：**NestJS + React + PostgreSQL**，模块化单体 + BullMQ Worker，pnpm monorepo。

### v1.1 修订摘要

1. `consumption_settlement` 改为 header + `consumption_component`（每 component 对应一个 `meter_installation`），正确表达账期中途换表。
2. `meter_reading` 只存采集事实（`ACTUAL | REMOTE | NO_READ`）；估算只进入 settlement；更正用 `supersedes_reading_id` 链，不覆盖历史。
3. 新增 `reconciliation` 实体：以最后一次可信实抄为 anchor，支持任意连续估月后的补差；FINAL settlement 不再被回头修改。
4. 补差 = 重计价金额调整（`adjustment_amount`），而非 `delta_usage × 当前价`；`delta_usage` 仅作解释/审计。
5. 幂等改为业务来源唯一：`(tenant_id, source_type, source_id, bill_kind)`。
6. RLS：transaction-local `set_config(..., true)`、非 owner 应用角色、核心表 `FORCE ROW LEVEL SECURITY`。
7. 小修：不硬限制单用水户单 active 表；meter 状态允许复装；删除 `prepay_balance`；统一数值精度与舍入规则。

## 1. 架构

### 1.1 总体结构

```
┌─────────────────────────────────────────────────┐
│  React Web (Vite + AntD) — 管理后台 + 抄表录入     │
└──────────────────┬──────────────────────────────┘
                   │ REST / JWT
┌──────────────────▼──────────────────────────────┐
│  NestJS 模块化单体                                │
│  ├─ iam        租户/组织/用户/角色/数据权限/日志   │
│  ├─ customer   客户/用水户/结算户/水表/立户        │
│  ├─ metering   抄表册/计划/读数/质检/结算水量       │
│  ├─ billing    水价引擎/开账/应收/红冲/重计价调整   │
│  ├─ payment    柜台收费/销账分摊/票据/日结         │
│  ├─ report     报表查询                          │
│  └─ integration 外部接口适配层（本期全 stub）      │
├──────────────────┴──────────────────────────────┤
│  Worker (BullMQ)：批量开账/自动质检/日结汇总       │
├─────────────────────────────────────────────────┤
│  PostgreSQL（tenant_id 隔离 + RLS 强制）│ Redis    │
└─────────────────────────────────────────────────┘
```

- 模块依赖方向：`iam ← customer ← metering ← billing ← payment ← report`；`integration` 只被外层调用，不回调内核。ESLint 边界规则强制单向依赖，禁止跨模块直接读表——模块间通过 service 接口交互，为将来拆服务留路。
- Monorepo：`apps/api`（NestJS）、`apps/worker`（可与 api 同镜像独立进程）、`apps/web`、`packages/types`（共享 DTO/枚举）、`packages/billing-core`（估抄/阶梯水价/开账/重计价/红冲纯函数，无 IO，可单测）。
- 部署：MVP 单机 Docker Compose（api + worker + web + postgres + redis）；租户以 `tenant_code`（登录选择或子域名）路由。

### 1.2 多租户与权限

- `tenant`（水司）→ `org_unit`（公司/营业所/部门，树形）→ `staff` → `role` → `permission`（菜单+操作+数据范围）。
- 所有业务表带 `tenant_id`；JWT 携带 `tenant_id` + 数据范围。
- **RLS 实施细则（v1.1 明确）**：
  - 每个请求/任务在事务内执行 `SELECT set_config('app.tenant_id', $1, true)`——`true` 保证 transaction-local，连接归还连接池后无租户上下文残留。
  - 应用连接账号**不是表 owner**、**无 `BYPASSRLS`**；核心业务表 `ALTER TABLE ... FORCE ROW LEVEL SECURITY`。
  - 策略：`tenant_id = current_setting('app.tenant_id')::uuid`；migration 用独立 owner 角色执行。
- 单据编号按租户独立规则：`sys_sequence` 表。

### 1.3 财务不可变规则

- **DRAFT**：允许编辑、删除、重算。开账批次、结算水量未 POST/FINAL 前可作废重跑。
- **POSTED / FINAL**：不得覆盖修改、不得物理删除。一切纠错通过 reversal（红冲）+ replacement（正向单）或 reconciliation→adjustment 完成；`bill`/`bill_item`/`payment`/`payment_alloc`/`consumption_settlement`(FINAL)/`reconciliation` 均 append-only。
- 数值精度与舍入（v1.1 统一）：水量 `numeric(18,4)` m³；单价 `numeric(18,6)` 元/m³；金额 `bigint` 分。舍入规则：每条 `bill_item.amount` 按 `qty × unit_price` 以 **HALF_UP** 入到分，`bill.total = Σ items`；阶梯分档计算过程保留 4 位小数，仅在成行时舍入。

## 2. 领域模型

### 2.1 三户 + 水表 + 安装关系

```
customer 客户 ──┐
               ├─< water_account 用水户 >── settle_account 结算户
meter 水表(物理设备) ──< meter_installation 安装关系 >── water_account
```

- `meter` 是物理设备，状态机：`AVAILABLE → INSTALLED → MAINTENANCE → AVAILABLE（可复装）| RETIRED`。拆下的正常表可再装——状态只描述设备可用性，"装在哪"完全由 installation 表达。
- `meter_installation`：一条记录 = 一块表装在某用水户的一段时期：`installed_at / removed_at / initial_reading / final_reading / reason(NEW|REPLACE|FAULT|PERIODIC_CHECK)`，`status: ACTIVE | REMOVED`。**schema 不限制单用水户同时多块 ACTIVE 表**（一户多表二期即插即用）；MVP UI 层先只暴露单表操作。
- `meter.parent_meter_id` 预留（总分表/比例表二期）。

### 2.2 抄表：事实读数（v1.1 严格分离）

```
reading_book 抄表册 ──< book_meter(册内水表+顺序)
reading_plan 抄表计划 ──< meter_reading 抄表记录(采集事实)
```

`meter_reading` = **一次现场观察/一次数据采集的事实**，append-only，永不覆盖：

- `result_type: ACTUAL | REMOTE | NO_READ`（REMOTE 预留智能表；**不存在 ESTIMATED 类型——估算不是事实**）
- `reading_value`：ACTUAL/REMOTE 必填，NO_READ 恒为 NULL
- `exception_code`：NO_READ 必填——`LOCKED | DIAL_DIRTY | FLOODED | OCCUPIED | STOPPED | BROKEN | SUSPECTED_THEFT | OTHER`
- `supersedes_reading_id`：更正读数 = 新插一条 ACTUAL 并指向被更正记录，原记录永存
- `qc_status: PENDING → PASSED | REJECTED | MANUAL_REVIEW → PASSED|REJECTED`（NO_READ 同样过质检，复核异常原因）
- `source: WEB | IMPORT | APP(预留) | REMOTE(预留)`、`operator_id`、`photo_ref`(预留)、`remark`

### 2.3 结算水量：header + component（v1.1 重构）

```
consumption_settlement (water_account × period, header)
   └─< consumption_component (每个 installation 一段，本期贡献)
```

- `consumption_settlement`：`water_account_id / period / total_usage_qty / is_estimated / status: DRAFT → FINAL` + 估抄元信息 `estimate_method / estimate_basis(jsonb) / estimate_reason`。
- `consumption_component`：`settlement_id / installation_id / prev_reading_value / end_reading_value / usage_qty / source_type: READING | ESTIMATE | MANUAL / source_reading_id`。`end_reading_value`：实抄时为表码，估抄时为推算值（prev + 估用量，用于下期表码链衔接），无表码的手工结算可为 NULL。
- **中途换表达例**：9/1 旧表 100 → 9/15 拆表 final=130（component：30m³）；9/15 新表 initial=0 → 9/30 抄 18（component：18m³）。settlement.total = 48。
- **估抄闭环**：NO_READ → 生成 `source_type=ESTIMATE` component（AVG3 建议值，操作员可改并必填 `estimate_reason`）→ settlement FINAL → 开账（账单标"估"）。
- **估水算法**：第一版 `AUTO_AVG3` = 最近 3 次有效 ACTUAL 用量均值；`Estimator` 接口 + `estimate_rule` 租户参数可配置，去年同期/日均算法二期注册。
- 连续估抄上限：租户参数 `max_consecutive_estimates`（默认 3），超限进"补抄任务"台账列表（不接工单流）。

### 2.4 Reconciliation：锚点式补差（v1.1 新增实体）

```
reconciliation
  anchor_reading_id   -- 最后一次可信 ACTUAL/REMOTE 读数（表码锚点）
  actual_reading_id   -- 新到的实抄读数
  water_account_id
  from_period / to_period          -- 受影响账期范围
  actual_total_usage               -- actual - anchor
  previously_settled_usage         -- 范围内已 FINAL 结算水量合计
  delta_usage                      -- actual_total - previously_settled（可正可负，解释字段）
  correct_charge_cent              -- 按正确用量重计价的应收
  posted_charge_cent               -- 范围内已 POSTED 的用量类费用合计
  adjustment_amount_cent           -- correct - posted（正=补收，负=退减）
  status: DRAFT → APPLIED          -- APPLIED 时关联生成的调整账单
```

- **触发**：新 ACTUAL 读数入库且其覆盖范围内存在 `is_estimated` 的 FINAL settlement → 自动生成 DRAFT reconciliation（也可人工发起）。
- **语义示例**：6 月实抄 1000 → 7 月估 30 → 8 月估 35 → 9 月实抄 1080：anchor=1000，actual_total=80，settled=65，delta=+15。**锚点是最后实抄而非最近一次估算的 synthetic end**，连续估 N 月同样正确。
- **重计价（v1.1 关键）**：`billing-core.reprice()` 按租户参数 `reconcile_alloc_policy`（默认 `PROPORTIONAL_TO_SETTLED`，备选 `ALL_TO_CURRENT`）把实际用量分摊回各受影响账期，逐期用**该期生效的 tariff 版本 + 自然年阶梯状态**重算应收 → `correct_charge`；`adjustment = correct_charge − posted_charge`。金额层面的补差，天然正确处理阶梯分布变化和跨期调价。
- **不可变**：FINAL settlement 永不因后续实抄而修改；reconciliation 是新的 append-only 业务事实，经 `RECONCILE` 类型 adjustment bill 落到应收。
- **负用量保护**：actual < anchor（表码回退异常）或重算后出现异常大额 → `MANUAL_REVIEW`；租户参数 `negative_usage_policy: CLAMP_REVIEW(默认) | ALLOW_NEGATIVE`。

### 2.5 计费与开账

- `fee_item` 费用项：水费/污水费/水资源费/违约金等，`calc_type: PER_QTY | FIXED | PERCENT`。
- `tariff_plan`：`usage_category + effective_from/to` 版本化；`tariff_tier`：`tier_no / from_qty / to_qty(NULL=∞) / unit_price`。第一版：普通单价（单 tier）+ 阶梯价（多 tier，自然年累计分档）。不硬编码地方政策。
- `billing_run`：`period + run_type(MANUAL|AUTO)`，`status: DRAFT → POSTED | FAILED→DRAFT 重跑`；DRAFT 批可整批作废重算。
- `bill`（v1.1 幂等重构）：
  - `bill_kind: NORMAL | ADJUSTMENT | REVERSAL | REPLACEMENT`
  - `source_type: SETTLEMENT | RECONCILIATION | MANUAL | ORIGINAL_BILL` + `source_id`
  - **唯一业务幂等约束 `UNIQUE(tenant_id, source_type, source_id, bill_kind)`**——Worker 重跑 N 次同一来源只产生一张对应单据；REVERSAL/REPLACEMENT 的 source 为原账单。
  - `status: DRAFT → POSTED → PARTIAL_PAID → PAID`；`POSTED → REVERSED`（仅经红冲单）；`is_estimated` 继承自 settlement。
- `bill_item`：`item_type: NORMAL | ADJUSTMENT | PENALTY`；调整行可只带 `amount`（qty 可空）。
- 计费引擎（`billing-core` 纯函数）：`computeBill(settlement+components, tariffPlan, ytdTierUsage) → billItem[]`；`reprice(reconciliation ctx) → correctCharge`。
- 审计链：`Reading(事实) → Settlement(结算) → Bill(账单) → Reconciliation(偏差发现) → Adjustment Bill(财务调整)`，全链 append-only。

### 2.6 收款与销账

- `payment`：`channel: CASH | POS | TRANSFER`（手工登记），`status: RECEIVED → DAY_CLOSED → (REVERSED)`；一笔 payment 经 `payment_alloc` 分摊到**多个 bill**，可部分缴（bill 未清部分保持 PARTIAL_PAID）。
- `receipt`：收款生成收据号，可打印、可作废（走红冲）。
- `cashier_day_close`：收费员按日结账，`by_channel` 汇总；日结 POSTED 后当日收款不可改（差错走红冲退款）。
- 预付费二期再做：`prepay_transaction` 流水台账，余额 = Σ 流水（或缓存+对账），**MVP 不留 `prepay_balance` 字段**。

### 2.7 状态机汇总

| 实体 | 状态流转 |
|---|---|
| meter | AVAILABLE → INSTALLED → MAINTENANCE → AVAILABLE \| RETIRED |
| meter_installation | ACTIVE → REMOVED |
| reading_plan | OPEN → IN_PROGRESS → DONE → CLOSED |
| meter_reading.qc_status | PENDING → PASSED / REJECTED / MANUAL_REVIEW → PASSED / REJECTED |
| consumption_settlement | DRAFT → FINAL（FINAL 后冻结，reconcile 走独立实体） |
| reconciliation | DRAFT → APPLIED；异常 → MANUAL_REVIEW |
| billing_run | DRAFT → POSTED / FAILED → DRAFT 重跑 |
| bill | DRAFT → POSTED → PARTIAL_PAID → PAID；POSTED → REVERSED |
| payment | RECEIVED → DAY_CLOSED；→ REVERSED（红冲） |

### 2.8 外部接口（integration 模块，MVP 全 stub）

定义端口接口：`SmsPort / PaymentChannelPort / SmartMeterPort / FinancePort / ReportInstallPort`，实现类返回 `NOT_IMPLEMENTED` 或 mock，保证内核不感知外部系统。

## 3. 核心表结构（PostgreSQL，全表含 `tenant_id`、审计字段）

> 约定：`id` = uuid 主键；审计字段 `created_at/created_by/updated_at/updated_by` 略写；金额 `bigint` 分；水量 `numeric(18,4)`；单价 `numeric(18,6)`。

**iam**: `tenant(id, code, name, status, params jsonb)`、`org_unit(id, parent_id, name, type)`、`staff(id, org_unit_id, login, password_hash, name, status)`、`role(id, code, name, data_scope)`、`staff_role(staff_id, role_id)`、`permission(id, code, type)`、`role_permission(role_id, permission_id)`、`audit_log(id, staff_id, action, entity, entity_id, before jsonb, after jsonb, ip)`、`sys_sequence(id, seq_key, period, cur_val)`、`tenant_param(tenant_id, key, value)`

**customer**: `customer(id, customer_no, name, cust_type, id_type, id_no, phone, addr)`、`settle_account(id, settle_no, name, phone, status)`、`water_account(id, account_no, customer_id, settle_account_id, usage_category, addr, status, opened_at, closed_at)`、`meter(id, meter_no, serial_no, barcode, brand, model, caliber, max_dial, parent_meter_id, status)`、`meter_installation(id, water_account_id, meter_id, installed_at, removed_at, initial_reading, final_reading, reason, status)`、`account_event(id, water_account_id, type(TRANSFER|SUSPEND|RESUME|CLOSE), payload jsonb, effective_date)`

**metering**: `reading_book(id, book_no, name, org_unit_id, reader_id, schedule_day)`、`book_meter(book_id, water_account_id, seq_no)`（册按"去哪户抄"组织，抄表时动态解析当期 ACTIVE installation，换表不影响册内关系）、`reading_plan(id, book_id, period, plan_date, reader_id, status)`、`meter_reading(id, plan_id, installation_id, meter_id, period, read_date, result_type, reading_value, exception_code, supersedes_reading_id, qc_status, qc_by, qc_at, source, operator_id, photo_ref, remark)`、`consumption_settlement(id, water_account_id, period, total_usage_qty, is_estimated, estimate_method, estimate_basis jsonb, estimate_reason, status)`、`consumption_component(id, settlement_id, installation_id, prev_reading_value, end_reading_value, usage_qty, source_type, source_reading_id)`、`reconciliation(id, water_account_id, anchor_reading_id, actual_reading_id, from_period, to_period, actual_total_usage, previously_settled_usage, delta_usage, correct_charge_cent, posted_charge_cent, adjustment_amount_cent, status)`、`estimate_rule(tenant_id, method, params jsonb, enabled)`

**billing**: `fee_item(id, code, name, calc_type)`、`tariff_plan(id, code, name, usage_category, effective_from, effective_to, status)`、`tariff_tier(id, tariff_plan_id, fee_item_id, tier_no, from_qty, to_qty, unit_price)`、`billing_run(id, period, run_type, status, posted_at)`、`bill(id, billing_run_id, settle_account_id, water_account_id, period, bill_kind, source_type, source_id, status, is_estimated, total_amount, issued_at, due_date)`、`bill_item(id, bill_id, fee_item_id, item_type, description, qty, unit_price, amount)`、`idempotency_key(tenant_id, key, endpoint, response_ref)`

**payment**: `payment(id, payment_no, settle_account_id, cashier_id, org_unit_id, channel, amount, status, received_at, reversal_of_id)`、`payment_alloc(id, payment_id, bill_id, amount)`、`receipt(id, payment_id, receipt_no, rcp_type, printed_at, void_flag)`、`cashier_day_close(id, cashier_id, org_unit_id, close_date, total_count, total_amount, by_channel jsonb, status, closed_at)`

**唯一约束**：`UNIQUE(tenant_id, source_type, source_id, bill_kind)` on `bill`；`UNIQUE(tenant_id, water_account_id, period)` on `consumption_settlement`；`payment_no/customer_no/account_no` 按租户唯一；`UNIQUE(tenant_id, key)` on `idempotency_key`。POST 端点接收 `Idempotency-Key`。

## 4. REST API（v1 骨架）

```
/auth/login  /auth/me
/tenants  /orgs  /staff  /roles  /permissions  /audit-logs  /tenant-params
/customers  /settle-accounts  /water-accounts(+ /transfer /suspend /resume /close)
/meters  /meter-installations(+ /remove 拆表 /install 复装)
/reading-books  /reading-plans(+ /generate)
/meter-readings(+ POST 批量录入 /import CSV; 录入含 NO_READ+exception_code)
/meter-readings/:id/qc (pass|reject|review)  /meter-readings/:id/supersede (更正)
/consumption-settlements(+ /:id/finalize; GET 含 components)
/estimate/preview (POST: installation_id+period → AVG3 建议值)
/reconciliations(+ GET 列表 /:id /:id/apply → 生成 adjustment bill)
/fee-items  /tariff-plans(+ /tiers)
/billing-runs(+ POST /:id/post /:id/discard)  /bills(+ /:id/reverse 红冲 /:id/replace 重开)
/payments(+ POST 含 allocs[]; /:id/reverse)  /receipts(+ /print)
/cashier-day-close(+ POST /close)
/reports/meter-daily  /reports/cashier-daily  /reports/ar-monthly  /reports/collected-monthly  /reports/recovery-rate
```

## 5. 页面清单（React + AntD）

1. **登录/租户选择**；2. **工作台**（待办：待复核读数/MANUAL_REVIEW 结算/超限估抄台账/待应用 reconciliation）
3. **客户管理**：客户/用水户/结算户 CRUD、立户向导（客户号发放→安装→上段）、过户/暂停/销户
4. **水表台账**：水表库存/安装历史时间线（installation 视角，含换表链）
5. **抄表管理**：抄表册、计划生成、读数录入（实抄/NO_READ+异常码/更正链）、CSV 导入、质检复核队列
6. **结算与补差**：consumption_settlement 列表与 component 明细、reconciliation 审核与应用
7. **计费管理**：费用项/水价方案配置、开账批次（试算→过账）、账单查询（标"估"）、红冲/重开
8. **收费管理**：收款台（查欠费→多账单勾选→部分缴→分摊预览）、收据打印、红冲退款、日结
9. **报表**：抄表日报/收费日报/应收实收月报/回收率
10. **系统管理**：组织/用户/角色/参数/操作日志

## 6. MVP 验收标准

1. 建两个租户，验证跨租户数据互不可见——含非 owner 连接 + FORCE RLS 下的直连 SQL 验证；连接池复用后无租户上下文残留。
2. 完成链路：立户（客户+用水户+装表 installation）→ 入册排计划 → 录实抄 → 质检 → 手工/批量开账 → POSTED 账单（阶梯价正确分档）。
3. **中途换表**：账期内拆旧装新，settlement 生成两个 component（旧 30 + 新 18 = 48），账单按 48 正确计价。
4. **连续估抄补差**：实抄 1000 → 估 30 → 估 35 → 实抄 1080：reconciliation 锚定 1000，delta=+15；adjustment bill 金额 = 重计价正确应收 − 已 POSTED 应收（验证阶梯边界情形：+15 跨档时金额正确拆分）；原 FINAL settlement 不被修改。
5. 收款：一笔 payment 分摊 2+ 账单、部分缴费 → PARTIAL_PAID、收据号生成、收费员日结汇总正确。
6. 纠错：POSTED 账单不可改；红冲 + 重开链路完整；更正读数经 `supersedes_reading_id` 成链，原读数保留；DRAFT 批次可作废重跑。
7. 幂等：Worker 重跑同一 billing_run / 重复提交同一 source，只产生一张 `(source_type, source_id, bill_kind)` 对应单据。
8. 操作日志覆盖所有写操作；报表四张可对数。

## 7. 非功能与边界

- 目标规模：MVP 支撑单租户 ≤10 万户、日开账 ≤2 万笔（批量任务异步跑）。
- 所有列表接口分页 + `(tenant_id, …)` 复合索引；批量开账按 settle_account 分组并行、单户事务、失败可重入。
- 安全：bcrypt 密码、JWT 短期 + refresh、接口鉴权到按钮级权限码、审计日志 append-only。
- 明确不做：移动端/APP、第三方在线支付、银行代扣文件、电子发票、短信、智能表平台、在网表工单、监控/重点/周检、信用评级、欠费催收、大数据平台、总分表计费与预付费（字段/接口均不留半成品实现）。
