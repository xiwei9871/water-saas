# E10 Operations Dashboard V1 — Implementation Plan

状态：Implementation Gate **HOLD**（等 Pilot 拍板剩余业务口径）。本计划只定义
Implementation-Ready 前置工作与解冻后的完整实现路径。今晚执行范围为
**Foundation RC**：T1–T2 + T3–T5 中已冻结指标的 query 层 + T6 scope 修复 +
T9 的冻结指标测试；T7/T8 的完整产品面等 Implementation Gate 解冻后做。

Gate 依据：`E10_OPERATIONS_DASHBOARD_V1.md` + `E10_METRIC_DICTIONARY.md`（Rev4）。

## HOLD 指标（禁止实现最终公式）

| 指标 | 未决项 | 处置 |
|---|---|---|
| `RECOVERY_RATE` | 分子语义：cash recovery（仅 `source=PAYMENT` alloc）vs debt extinguishment（含 PREPAYMENT APPLY） | 接口不暴露该键 |
| `ESTIMATE_RATE` | 分母：应抄户 vs 已结算户 | 接口不暴露该键 |
| `REMOTE_ONLINE_RATE` | 离线窗口：1h / 6h / 24h | 接口不暴露该键 |
| `READING_MISSING` 异常阈值 | PENDING 多久算异常 | 不实现阈值；`READING_MISSING_COUNT` 仅按冻结口径计 PENDING |

约定：HOLD 指标在 API 响应里列入 `hold: [...]`，**绝不返回数字**（含 0）。

## T1 — Metric query architecture

`modules/dashboard/`：`GET /dashboard/metrics?period=YYYYMM`，
`report:read` 门控，只读、无副作用。响应携带 `attribution:
'CURRENT_PORTFOLIO_VIEW'`（D25）与 `hold` 列表。所有金额 BigInt → JSON 序列化
走既有 Nest interceptor 约定。

## T2 — ACCOUNT_AGGREGATION_OWNERSHIP helper ✅

`common/account-aggregation-ownership.ts`：

- `loadCoveringOrgsTx`：BookMeter → covering book org 集合（唯一归属 SoT）
- `aggregationInScope`：ALL → true；scoped → ≥1 覆盖册且全部 ∈ orgScope
- `aggregationScopeAccountIds` + `aggOwnPredicate`：SQL `= ANY()` 片段；
  scoped 空集合 → `AND false`（fail closed）

刻意不复用 E8 `ACCOUNT_READ_SCOPE`（读宽放 ≠ 聚合归属）。

## T3 — Metering metrics（冻结部分）

- `READING_DUE_COUNT` / `DONE` / `MISSING`：ReadingBook anchor
  （`reading_plan_item` × plan period，book.orgUnitId ∈ scope）
- `READING_ANOMALY_COUNT`：QC MANUAL_REVIEW/REJECTED 且未被 supersede，
  WaterAccount anchor（AGG_OWN）
- `ACTUAL_READ_RATE`：首采纳实读 / due，book anchor；due=0 → null

## T4 — Billing metrics（冻结）

- `PERIOD_USAGE_QTY`：`consumption_settlement` FINAL，AGG_OWN
- `BILLED_AMOUNT`（D26）：`status ∈ {POSTED,PARTIAL_PAID,PAID} ∧
  bill_kind ≠ REVERSAL`，Σ total_amount，AGG_OWN
- `GROSS_BILL_RECEIVABLE`（D27）：候选 `status ∈ {POSTED,PARTIAL_PAID} ∧
  ≠REVERSAL`；`remaining = total − Σ alloc(PAYMENT+PREPAYMENT)`；
  `Σ max(remaining,0)`；AGG_OWN
- `ACTIVE_METER_COUNT` / `METER_REPLACEMENT_COUNT` / `ACCOUNT_CLOSED_COUNT`：
  AGG_OWN + 时点/期间窗口

## T5 — Cashier / payment metrics（冻结）

- `CASHIER_COLLECTED`：`Payment.orgUnitId` anchor，status ∈
  {RECEIVED, DAY_CLOSED}，received_at ∈ 月窗，signed Σ
- `TERRITORY_DEBT_COLLECTION`：`source='PAYMENT'` 的 signed alloc Σ →
  bill → AGG_OWN。TOP_UP 腿不在 payment_alloc，天然排除
- `PREPAYMENT_BALANCE`：D20 tenant-only；scoped → `null`

## T6 — Report endpoint scope remediation ✅（本轮）

`E10_REPORT_AUDIT.md` 结论落地：为无 scope 的 4 个既有端点加过滤——

- `cashier-daily`：`p.org_unit_id ∈ orgScope`
- `ar-monthly`：bill → AGG_OWN
- `collected-monthly`：collected → `p.org_unit_id`；allocated → bill AGG_OWN；
  修正 `allocated ≡ collected` 的过期假设（E6 后 TOP_UP 走 ledger）
- `recovery-rate`：billed → AGG_OWN，collected → `p.org_unit_id`；
  公式本身仍受 Pilot HOLD，此处仅补 scope

## T7 — Dashboard API（解冻后）

多 period / drill-down / 卡片配置等完整产品面——Implementation Gate PASS 后开。
当前仅 `/dashboard/metrics` foundation 端点。

## T8 — Web dashboard（解冻后）

冻结指标卡片 + HOLD 指标显式 `NOT_CONFIGURED` 占位（不显示 0）。本轮不做。

## T9 — e2e / UAT

本轮已交付 `test/dashboard-metrics.e2e-spec.ts`（11 tests）：

- AGG_OWN：off-book 仅 tenant；单册计一次；跨所覆盖 fail closed；
  CURRENT_PORTFOLIO 历史重归属
- signed money：Payment 100 = alloc 30 + TOP_UP 70；reversal 净冲；
  PREPAYMENT APPLY 不增 cash、减 GROSS
- BILLED/GROSS predicate：DRAFT/REVERSAL 排除；负 remaining 不抵其他单
- HOLD 指标无数值；scoped PREPAYMENT_BALANCE = null
- book-anchored reading counts scope

解冻后补：UAT、dashboard UI spec、多 period 对比。
