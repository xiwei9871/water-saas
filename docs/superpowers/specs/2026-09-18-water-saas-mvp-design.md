# 水务抄表收费 SaaS — MVP 设计规格

日期：2026-09-18
状态：待评审

## 0. 背景与范围基线

- 旧《营销系统需求分析》（`/Users/xiwei/营销系统需求分析.md`）仅作为水务业务语义和历史场景的**背景参考**，不构成本项目的功能范围、技术栈或合同约束。其中 SQL Server、C/S 架构、IE、智能表平台、银行代扣、电子发票、周检、监控表等内容**不进入本 MVP**。
- 本项目是一套**多租户 SaaS** 抄表收费系统：每家水司 = 一个租户。MVP 目标是"**可以真实小规模试用**"——数据模型按生产系统设计，但不追求 400 万户规模和全渠道收费。
- 技术栈：**NestJS + React + PostgreSQL**，模块化单体 + BullMQ Worker，pnpm monorepo。

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
│  ├─ metering   抄表册/计划/读数/质检/估抄          │
│  ├─ billing    水价引擎/开账/应收/红冲调整         │
│  ├─ payment    柜台收费/销账分摊/票据/日结         │
│  ├─ report     报表查询                          │
│  └─ integration 外部接口适配层（本期全 stub）      │
├──────────────────┴──────────────────────────────┤
│  Worker (BullMQ)：批量开账/自动质检/日结汇总       │
├─────────────────────────────────────────────────┤
│  PostgreSQL（tenant_id 隔离 + RLS 兜底）│ Redis    │
└─────────────────────────────────────────────────┘
```

- 模块依赖方向：`iam ← customer ← metering ← billing ← payment ← report`；`integration` 只被外层调用，不回调内核。ESLint 边界规则强制单向依赖，禁止跨模块直接读表——模块间通过 service 接口交互，为将来拆服务留路。
- Monorepo：`apps/api`（NestJS）、`apps/worker`（可与 api 同进程起步，逻辑独立）、`apps/web`、`packages/types`（共享 DTO/枚举）、`packages/billing-core`（估抄/阶梯水价/开账/红冲纯函数，无 IO，可单测）。
- 部署：MVP 单机 Docker Compose（api + worker + web + postgres + redis）；租户以 `tenant_code`（登录选择或子域名）路由。

### 1.2 多租户与权限

- `tenant`（水司）→ `org_unit`（公司/营业所/部门，树形）→ `staff` → `role` → `permission`（菜单+操作+数据范围）。
- 所有业务表带 `tenant_id`；JWT 携带 `tenant_id` + 数据范围，请求进入时写入 PG `app.tenant_id` 会话变量，RLS 策略兜底。
- 单据编号（客户号/收款单号等）按租户独立规则：`sys_sequence` 表。

### 1.3 财务不可变规则（修订）

- **DRAFT**：允许编辑、删除、重算。开账批次未 POST 前整批可作废重跑。
- **POSTED**：不得覆盖修改、不得物理删除。一切纠错通过 **reversal（红冲单）+ replacement（正向单）** 完成；`bill`/`payment`/`bill_item`/`payment_alloc` 均 append-only。
- 金额一律 `bigint`（分）；水量 `numeric(14,4)` m³；账期 `char(6)` `YYYYMM`。

## 2. 领域模型

### 2.1 三户 + 水表（修订：安装关系独立）

```
customer 客户 ──┐
               ├─< water_account 用水户 >── settle_account 结算户
meter 水表(物理设备) ──< meter_installation 安装关系 >── water_account
```

- `meter` 是物理设备（生命周期：库存→在网→拆除→报废），**不直接挂用水户**。
- `meter_installation`（修订点 1）：一条记录 = 一块表装在某用水户的一段时期，含 `installed_at / removed_at / initial_reading / final_reading / reason(新装|换表|故障|周检)`。同一用水户同时期最多一条 ACTIVE 安装；换表 = 旧记录 closed + 新记录 active，历史可追溯。
- `meter.parent_meter_id` 预留（总分表/比例表二期）。

### 2.2 抄表（修订：事实与结算分离，读数类型与质检分离）

```
reading_book 抄表册 ──< book_meter(册内水表+顺序)
reading_plan 抄表计划 ──< meter_reading 抄表记录(事实)
water_account + period ──> consumption_settlement 结算水量(计费输入)
```

- `meter_reading` = **采集事实**，一次现场/一次录入一条，永不覆盖：
  - `read_type`（修订点 2）：`ACTUAL | ESTIMATED | REMOTE | CORRECTED`（REMOTE 预留给智能表；CORRECTED 为补抄更正值）
  - `qc_status`：`PENDING → PASSED | REJECTED | MANUAL_REVIEW → PASSED|REJECTED`，与 read_type 正交
  - `reading_value` 可空（无法抄见时为空）；`exception_code`：`LOCKED | DIAL_DIRTY | FLOODED | OCCUPIED | STOPPED | BROKEN | SUSPECTED_THEFT | OTHER`
  - 估抄扩展字段：`estimate_method`（`AUTO_AVG3 | MANUAL`）、`estimate_basis`(jsonb 快照)、`estimate_reason`（人工改值必填）
- `consumption_settlement`（修订点 3）：每个 `water_account × period` 一条，是**开账的唯一输入**：
  - `prev_reading_value` = 上期期末表码（无论实/估，保持表码链）；`end_reading_value` = 本期期末表码（实抄值或估抄推算值，仅在完全无表码的手工结算时为 NULL）；`usage_qty`、`is_estimated`、`status: DRAFT | FINAL`
  - reconciliation 字段：`reconciled`、`actual_usage`、`delta_usage`、`reconcile_reading_id`——实抄到位后算出真实用量与补差量
- **估抄→补差闭环**（修订点 3 的 MVP 必做项）：
  1. 无法抄见 → 录 `ESTIMATED` 读数（或只有 exception + 系统暂估）→ settlement `is_estimated=true` → 正常开账（账单标"估"）
  2. 后续获得实抄（`ACTUAL`/`CORRECTED`）→ 系统计算 `actual_usage = 实抄 - 期初表码`，`delta_usage = actual_usage - 已结算 usage_qty`
  3. `delta_usage ≠ 0` → 下一次开账自动携带 `RECONCILE_DELTA` 类型 bill_item（可为负），单据可追溯回 `reconcile_reading_id`
  4. 负用量保护：实抄 < 期初（估高太多或换表未闭环）→ `MANUAL_REVIEW` 队列，人工选择"按 0 结算+红冲重开"或"负量结转"；租户参数 `negative_usage_policy: CLAMP_REVIEW(默认) | ALLOW_NEGATIVE`
- **估水算法（修订：第一版简化）**：默认 `AUTO_AVG3` = 最近 3 次有效 ACTUAL 用量平均值；系统给建议值，操作员可改、必填 `estimate_reason`。算法接口 `Estimator` 可配置（`estimate_method` + 租户参数表），去年同期/日均算法二期再注册。
- 连续估抄上限：租户参数 `max_consecutive_estimates`（默认 3），超限进"补抄任务"列表（MVP 为台账列表，不接工单流）。

### 2.3 计费与开账

- `fee_item` 费用项：水费/污水费/水资源费/违约金等，`calc_type: PER_QTY | FIXED | PERCENT`。
- `tariff_plan`（修订：可配置引擎，不硬编码地方政策）：`usage_category + effective_from/to` 版本化；`tariff_tier`：`tier_no / from_qty / to_qty / unit_price`，`to_qty=NULL` 表无限。第一版支持普通单价（单 tier）+ 阶梯价（多 tier，按自然年累计用量分档）。
- `billing_run` 开账批次：`period + type(MANUAL|AUTO)`，`status: DRAFT → POSTED（FAILED 可重跑）`；DRAFT 批可整批作废重算。
- `bill`：`status: DRAFT → POSTED → PARTIAL_PAID → PAID`；`POSTED → REVERSED`（仅经红冲）；`reversal_of_id / replaced_by_id` 自引用成链。`is_estimated` 继承自 settlement。
- `bill_item.item_type`：`NORMAL | RECONCILE_DELTA | ADJUSTMENT | PENALTY`。
- 计费引擎（`billing-core` 纯函数）：`computeBill(settlement, tariffPlan, ytdTierUsage) → billItem[]`；阶梯按自然年已结算用量定位档级。

### 2.4 收款与销账（修订：手工渠道 + 多单分摊 + 部分缴费）

- `payment`：`channel: CASH | POS | TRANSFER`（均手工登记），`status: RECEIVED → DAY_CLOSED → （REVERSED）`；一笔 payment 经 `payment_alloc` 分摊到**多个 bill**，每笔可部分缴（bill 未清部分保持 PARTIAL_PAID）。
- `receipt`：收款成功生成收据号，可打印、可作废（作废走红冲）。
- `cashier_day_close`：收费员按日结账，`by_channel` 汇总，POSTED 后收款不可再改（差错走红冲退款）。
- `prepay_balance` 字段预留（预付费二期），本期不落自动扣款。

### 2.5 状态机汇总

| 实体 | 状态流转 |
|---|---|
| meter | IN_STOCK → INSTALLED → REMOVED → SCRAPPED |
| meter_installation | ACTIVE → REMOVED |
| reading_plan | OPEN → IN_PROGRESS → DONE → CLOSED |
| meter_reading.qc_status | PENDING → PASSED / REJECTED / MANUAL_REVIEW → PASSED / REJECTED |
| consumption_settlement | DRAFT → FINAL（reconcile 字段独立演化） |
| billing_run | DRAFT → POSTED / FAILED → DRAFT 重跑 |
| bill | DRAFT → POSTED → PARTIAL_PAID → PAID；POSTED → REVERSED |
| payment | RECEIVED → DAY_CLOSED；→ REVERSED（红冲） |

### 2.6 外部接口（integration 模块，MVP 全 stub）

定义端口接口即可：`SmsPort / PaymentChannelPort / SmartMeterPort / FinancePort / ReportInstallPort`，实现类返回 `NOT_IMPLEMENTED` 或 mock，保证内核不感知外部系统。

## 3. 核心表结构（PostgreSQL，全表含 `tenant_id`、审计字段）

> 约定：`id` = uuid 主键；审计字段 `created_at/created_by/updated_at/updated_by` 略写；金额单位分；※ = 修订相关字段。

**iam**: `tenant(id, code, name, status, params jsonb)`、`org_unit(id, parent_id, name, type)`、`staff(id, org_unit_id, login, password_hash, name, status)`、`role(id, code, name, data_scope)`、`staff_role(staff_id, role_id)`、`permission(id, code, type)`、`role_permission(role_id, permission_id)`、`audit_log(id, staff_id, action, entity, entity_id, before jsonb, after jsonb, ip)`、`sys_sequence(id, seq_key, period, cur_val)`、`tenant_param(tenant_id, key, value)`

**customer**: `customer(id, customer_no, name, cust_type, id_type, id_no, phone, addr)`、`settle_account(id, settle_no, name, phone, prepay_balance bigint, status)`、`water_account(id, account_no, customer_id, settle_account_id, usage_category, addr, status, opened_at, closed_at)`、`meter(id, meter_no, serial_no, barcode, brand, model, caliber, max_dial, parent_meter_id※, status)`、`meter_installation※(id, water_account_id, meter_id, installed_at, removed_at, initial_reading, final_reading, reason, status)`、`account_event(id, water_account_id, type(TRANSFER|SUSPEND|RESUME|CLOSE), payload jsonb, effective_date)`

**metering**: `reading_book(id, book_no, name, org_unit_id, reader_id, schedule_day)`、`book_meter(book_id, installation_id, seq_no)`、`reading_plan(id, book_id, period, plan_date, reader_id, status)`、`meter_reading※(id, plan_id, installation_id, meter_id, period, read_date, read_type, reading_value, exception_code, estimate_method, estimate_basis jsonb, estimate_reason, qc_status, qc_by, qc_at, source, operator_id, remark)`、`consumption_settlement※(id, water_account_id, installation_id, period, prev_reading_value, end_reading_value, usage_qty, is_estimated, status, source_reading_id, reconciled, actual_usage, delta_usage, reconcile_reading_id)`、`estimate_rule(tenant_id, method, params jsonb, enabled)`

**billing**: `fee_item(id, code, name, calc_type)`、`tariff_plan(id, code, name, usage_category, effective_from, effective_to, status)`、`tariff_tier(id, tariff_plan_id, fee_item_id, tier_no, from_qty, to_qty, unit_price)`、`billing_run(id, period, run_type, status, posted_at)`、`bill(id, billing_run_id, settle_account_id, water_account_id, period, status, is_estimated, total_amount, issued_at, due_date, reversal_of_id, replaced_by_id)`、`bill_item(id, bill_id, fee_item_id, item_type, description, qty, unit_price, amount)`

**payment**: `payment(id, payment_no, settle_account_id, cashier_id, org_unit_id, channel, amount, status, received_at, reversal_of_id)`、`payment_alloc(id, payment_id, bill_id, amount)`、`receipt(id, payment_id, receipt_no, rcp_type, printed_at, void_flag)`、`cashier_day_close(id, cashier_id, org_unit_id, close_date, total_count, total_amount, by_channel jsonb, status, closed_at)`

**幂等与索引**：`(meter_id, period)` 唯一约束于 consumption_settlement/bill；`payment_no`、`customer_no`、`account_no` 按租户唯一；POST 端点接收 `Idempotency-Key`（`idempotency_key` 表）。

## 4. REST API（v1 骨架）

```
/auth/login  /auth/me
/tenants  /orgs  /staff  /roles  /permissions  /audit-logs  /tenant-params
/customers  /settle-accounts  /water-accounts(+ /transfer /suspend /resume /close)
/meters  /meter-installations(+ /remove 换表闭环)
/reading-books  /reading-plans(+ /generate)
/meter-readings(+ POST 批量录入 /import CSV)  /meter-readings/:id/qc (pass|reject|review)
/consumption-settlements(+ /:id/reconcile)
/estimate/preview (POST: installation_id+period → 建议估用量)
/fee-items  /tariff-plans(+ /tiers)
/billing-runs(+ POST /:id/post /:id/discard)  /bills(+ /:id/reverse 红冲)  
/payments(+ POST 含 allocs[]; /:id/reverse)  /receipts(+ /print)
/cashier-day-close(+ POST /close)
/reports/meter-daily  /reports/cashier-daily  /reports/ar-monthly  /reports/collected-monthly  /reports/recovery-rate
```

## 5. 页面清单（React + AntD）

1. **登录/租户选择**；2. **工作台**（待办：待复核读数/负用量/超限估抄台账）
3. **客户管理**：客户/用水户/结算户 CRUD、立户向导（客户号发放→安装→上段）、过户/暂停/销户
4. **水表台账**：水表库存/安装历史时间线
5. **抄表管理**：抄表册、计划生成、读数录入（含"无法抄见"+异常码+估抄建议值弹层）、CSV 导入、质检复核队列
6. **计费管理**：费用项/水价方案配置、开账批次（试算→过账）、账单查询（标"估"）、红冲
7. **收费管理**：收款台（查欠费→多账单勾选→部分缴→分摊预览）、收据打印、红冲退款、日结
8. **报表**：抄表日报/收费日报/应收实收月报/回收率
9. **系统管理**：组织/用户/角色/参数/操作日志

## 6. MVP 验收标准

1. 建两个租户，验证跨租户数据互不可见（含直连 SQL 层 RLS）。
2. 完成链路：立户（客户+用水户+装表 installation）→ 入册排计划 → 录实抄 → 质检 → 手工/批量开账 → POSTED 账单（阶梯价正确分档）。
3. 估抄闭环：某户本期标"无法抄见"→ 系统给 AVG3 建议值并可改（必填原因）→ 估抄开账（标"估"）→ 下期实抄 → 新账单自动含 `RECONCILE_DELTA` 补差行。
4. 换表：拆旧装新两条 installation，旧表 final_reading 参与当期用量，新表 initial_reading 起算，跨期账单不错算。
5. 收款：一笔 payment 分摊 2+ 账单、部分缴费→ PARTIAL_PAID、收据号生成、收费员日结汇总正确。
6. 纠错：POSTED 账单不可改；红冲 + 重开链路完整；DRAFT 批次可作废重跑。
7. 幂等：重复提交开账/收款不产生重复单据；`(meter_id, period)` 冲突受控。
8. 操作日志覆盖所有写操作；报表四张可对数。

## 7. 非功能与边界

- 目标规模：MVP 支撑单租户 ≤10 万户、日开账 ≤2 万笔（批量任务异步跑）。
- 所有列表接口分页 + `(tenant_id, …)` 复合索引；批量开账按 settle_account 分组并行、单户事务、失败可重入。
- 安全：bcrypt 密码、JWT 短期 + refresh、接口鉴权到按钮级权限码、审计日志 append-only。
- 明确不做：移动端/APP、第三方在线支付、银行代扣文件、电子发票、短信、智能表平台、在网表工单、监控/重点/周检、信用评级、欠费催收、大数据平台、总分表计费（字段预留）。
