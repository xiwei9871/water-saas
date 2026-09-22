# E10 Report Semantic Audit — /reports/* vs Metric Dictionary Rev4

审计对象：`apps/api/src/modules/report/report.service.ts` +
`reports.controller.ts`。逐端点核对 SoT / 时间基准 / scope / org anchor /
E6（prepayment）兼容性 / signed-money 正确性 / 可否复用 / 所需整改。

## 总览

| endpoint | SoT | 时间基准 | org anchor | scope（修复前） | E6 兼容 | 复用判定 |
|---|---|---|---|---|---|---|
| meter-daily | plan/item + meter_reading | plan.period = date 期 + 当日 taken | ReadingBook.orgUnitId | ✅ 已相交 ctx.orgScope | n/a | 公式可复用（book anchor） |
| cashier-daily | payment + cashier_day_close | received_at::date | —（缺失） | ❌ tenant 全量 | ✅ signed Σ | **已修**：补 `p.org_unit_id ∈ scope` |
| ar-monthly | bill | bill.period | —（缺失） | ❌ tenant 全量 | n/a | **已修**：补 AGG_OWN（= D26 BILLED predicate） |
| collected-monthly | payment + payment_alloc | received_at ∈ 月窗 | —（缺失） | ❌ tenant 全量 | ⚠️ stale 假设 | **已修**：双侧 anchor + 文档假设更正 |
| recovery-rate | bill + payment | period / cumulative ≤T | —（缺失） | ❌ tenant 全量 | ⚠️ 分子语义未定 | **已修 scope**；公式仍 HOLD |

## 逐项

### /reports/meter-daily

- SoT：plan(period) → item status counts + 当日 readingsTaken。
- anchor：ReadingBook.orgUnitId；`bookId`/`orgUnitId` 参数与
  `ctx.orgScope` 在 WHERE 层相交（service line ~173–175）。
- 结论：**安全复用**。book-anchored 指标口径与字典一致。

### /reports/cashier-daily

- SoT：`payment` status ∈ {RECEIVED, DAY_CLOSED}，received_at::date。
- 问题：**无 org scope**——scoped reviewer（seed 中 ORG_SUBTREE +
  report:read）可看到全所收费。P1。
- 修复：`AND p.org_unit_id = ANY(ctx.orgScope)`（Payment.orgUnitId =
  柜台发生地 anchor，与 CASHIER_COLLECTED 同语义）。
- E6：Σ signed amount 天然兼容 reversal。

### /reports/ar-monthly

- SoT：bill `status ∈ {POSTED,PARTIAL_PAID,PAID} ∧ bill_kind ≠ REVERSAL`，
  Σ total_amount —— predicate 与 D26 BILLED_AMOUNT **完全一致**。
- 问题：无 scope → 跨所泄露。P1。
- 修复：bill.water_account_id → AGG_OWN（off-book 仅 tenant；任一覆盖册
  出 scope 即排除）。

### /reports/collected-monthly

- collected 侧：Σ payment.amount by channel = CASHIER_COLLECTED 公式 ✓。
- allocated 侧：Σ `payment_alloc`（source=PAYMENT 隐含——alloc 行必有
  bill，TOP_UP 不进 alloc）。
- **stale 假设（已更正）**：docblock 原写 `allocated ≡ collected by
  construction`。E6 后 Payment 100 → debt alloc 30 + TOP_UP 70（TOP_UP 走
  prepayment_ledger_entry），allocated ≤ collected。该「对数即断言」的
  表述已删除，改为返回两侧独立口径。**P1（文档假设过期，非数值 bug）**。
- scope 修复：collected → `p.org_unit_id`；allocated → bill → AGG_OWN
  （TERRITORY_DEBT_COLLECTION 语义）。

### /reports/recovery-rate

- 现有公式：`collected / billed`，分子 = Σ payment.amount（cash
  recovery 候选口径）。
- E10 HOLD：分子语义未拍板（cash recovery vs debt extinguishment
  含 PREPAYMENT APPLY）。**现有端点保留其原公式但不作为 dashboard
  RECOVERY_RATE 的依据**——dashboard 不暴露该指标。
- scope 修复：billed → AGG_OWN；collected → `p.org_unit_id`。

## 修复后回归面

`report*.e2e-spec.ts` 现有断言均基于 ALL-scope admin 或 tenant 级调用，
scope 过滤对 ALL 为 no-op；scoped 行为由
`test/dashboard-metrics.e2e-spec.ts` 的 AGG_OWN/anchor 用例覆盖。
