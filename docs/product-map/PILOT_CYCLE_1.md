# Pilot Cycle 1 — Synthetic Ground-Truth Pilot

状态：**PLANNING GATE**（本轮只产出本文档，不实现 generator、不改 schema、
不改生产代码）

基线：`main @ b76c33b` — E8 CLOSED / E9 CLOSED / E10 Foundation MERGED /
E10 Product Epic PILOT HOLD。

**本阶段不是新 Epic。** 目标不是找更多功能，而是回答三个不能靠设计猜出来
的问题，并为已知工程债取证：

```text
Pilot Cycle 1A = synthetic ground-truth validation
               + operational evidence
               + hardening evidence
Cycle 1B      = future anonymized real-data calibration
                （真实数据暂不作为 Cycle 1A 前置条件）
```

纪律：Pilot 中禁止顺手扩 Product Scope。除 P0 立即修复项（§8）外，
所有业务卡点先记 evidence，不改模型、不加功能。

---

## 1. Pilot 目标

回答三个 HOLD 决策 + 验证既有冻结实现的运营正确性：

1. `RECOVERY_RATE` — 现金回收（cash recovery）还是债务消灭
   （debt extinguishment）？
2. `ESTIMATE_RATE` — 分母是应抄户（due）还是已结算户（settled）？
3. `REMOTE_ONLINE_RATE` — 远传在线窗口应取多少？

同时验证：E9 13 类 detector 在规模化数据下的命中/误报、scope 隔离、
episode 生命周期、账务 reconcilability、操作员真实处理路径。

---

## 2. Synthetic Generator（规划，不实现）

`scripts/pilot/generate.ts` — Planning Gate 之后单独评审实现。

### 硬性要求

- **deterministic seed**：同一 seed 生成同一数据集
- **isolated Pilot tenant**：专用 tenant，fail closed —
  禁止对未知/生产 tenant 执行（启动时校验 tenant 标记或显式白名单）
- **configurable scale / anomaly distribution**
- **2 个完整账期**（period-from / period-to）
- **re-runnable**：幂等 cleanup/reset 策略（先清后生成，或
  generation-run 标记批量回滚）

### 显式参数

```text
--tenant       必填，Pilot 专用 tenant id
--seed         必填，确定性种子
--accounts     户数（默认 profile 3,000–5,000）
--period-from  起始账期 YYYYMM
--period-to    结束账期 YYYYMM（默认 = period-from + 1）
--profile      命名配置档
```

### 默认 profile（生成配置，不是 Product semantic）

```text
3 branches
12 reading books
3,000–5,000 accounts
2 billing periods
```

---

## 3. Ground Truth 设计

Generator 在注入每个 scenario 时同步输出 ground truth——
**不进产品 schema**，只写文件：

```text
artifacts/pilot/<run-id>/ground-truth.json
artifacts/pilot/<run-id>/generation-summary.json
```

每个 injected scenario 至少记录：

```text
entity ids                — 涉及的 account/meter/bill/event/source 等 id
scenario type             — 注入场景名
expected anomaly types    — 期望命中的 detector（可为多个）
expected anchor           — TENANT / ACCOUNT / REMOTE_SOURCE
expected lifecycle        — active / cleared 的期望轨迹
expected org ownership    — 覆盖册/营业所归属（跨所时全列）
expected financial effect — 若适用（金额/方向/口径）
```

示例契约：

```text
OFF_BOOK_BILLABLE
  → expected: NO_BOOK + NO_ACTIVE_METER
  → anchor:   TENANT

EVENT_KEY_CONFLICT
  → expected: REMOTE_EVENT_KEY_CONFLICT
  → anchor:   REMOTE_SOURCE（即使 event 后续获得 binding 也不漂移）
```

允许一个 entity 同时挂多个 expected anomalies（如 off-book 户同时
NO_BOOK + NO_ACTIVE_METER + 逾期账单）。

### 评估基准

evaluation 不拿 WorkItem 自证正确——以 `ground-truth.json` 为
SoT，对比 Detector/Reconciler 实际输出：

```text
expected facts          — ground truth 中应 active 的 anomaly
detected facts          — 实际命中的 anomaly key 集
missed facts            — expected − detected
unexpected facts        — detected − expected
precision / recall      — by anomaly type
anchor mismatch         — 命中但 anchor/scope 不符
episode lifecycle       — 期望轨迹与实际不一致
mismatch
```

**确定性 detector 契约：注入场景 recall 必须 = 100%。**
任何漏报都必须调查到根因，不允许用「概率问题」解释。

False positive 逐条分类：

```text
real generator bug
detector bug
ground-truth definition bug
legitimate overlapping anomaly   — 真实共存的独立异常，不是误报
```

---

## 4. Synthetic Dataset 组成

### 4.1 Clean background（测 false positive）

大量正常户：

```text
valid book membership（单册覆盖）
single active meter
normal readings（QC PASS）
valid settlement
normal billing / payment
normal remote flow（event → binding → plan → reading）
```

### 4.2 Injected scenarios（测 recall）

E9 13 类 active detector 每类 ≥30–50 独立样本：

```text
NO_ACTIVE_METER            REMOTE_EVENT_UNBOUND
MULTI_ACTIVE_METER         REMOTE_EVENT_WAITING_PLAN
NO_BOOK                    REMOTE_EVENT_FAILED
MULTI_BOOK                 REMOTE_EVENT_CONFLICT
READING_QC_REVIEW          REMOTE_EVENT_KEY_CONFLICT
READING_QC_REJECTED        UNPAID_BILL_OVERDUE
ESTIMATE_STREAK
```

另需覆盖的复合场景：

```text
cross-branch multi-book         — 一户覆盖多所册
off-book account                — 完全无册
shared settle spanning branches — 结算户跨所（E8 假设验证点）
payment + TOP_UP split          — 混合收款
reversal                        — 冲正链路
PREPAYMENT APPLY                — 预存抵扣（allocated ≠ collected 分叉点）
remote status transition        — UNBOUND→WAITING_PLAN 等 replay
KEY_CONFLICT recurrence         — 同事件多次冲突 → 多 episode
```

---

## 5. Operator Pilot（人工抽样）

自动化评估完成后，人工在 **Web UI** 处理固定抽样队列：

```text
50–100 episodes
覆盖尽可能多 anomaly types
操作：open / drill / ack / assign / ignore / resolve
```

- 不用 Playwright 模拟——UX evidence 必须来自真人操作
- 事后通过现有 `audit_log` + `work_item` 重建操作路径
- **本轮不新增 telemetry table**；若 Pilot 后证明 audit_log 不足以
  重建路径，再单独提 telemetry change

收集指标：

```text
steps per episode
time to first ACK
time to resolve
drill frequency（进 360/详情页比例）
IGNORE rate（by type → 误报信号）
re-open / recurrence rate
需要离开 Exception Center 的次数（drill-out friction）
```

---

## 6. evidence.ts 扩充（规划）

现有采集保留：

```text
remote cadence percentiles (P50/P90/P95/P99)
estimate denominator candidates（est/due vs est/settled）
recovery numerator candidates（cash vs extinguishment）
shared-settle distribution
work_item outcomes
```

新增：

```text
IGNORED / total episodes by anomaly type
MANUAL vs AUTO resolution 分布
median / P90 time-to-ack
median / P90 time-to-resolve
recurrent episode rate
operator path（若 audit_log 足够则 derive，否则记 gap）
```

---

## 7. E10 Decision Outputs

Cycle 1A **不一定直接解除 HOLD**。必须给 Product 同时展示候选证据，
禁止自动选 winner：

```text
RECOVERY_RATE
  → cash recovery（source=PAYMENT alloc）
    vs debt extinguishment（含 PREPAYMENT APPLY）
  → 并列输出，标注分叉样本（如 TOP_UP 差异期）

ESTIMATE_RATE
  → estimated / due  vs  estimated / settled
  → 并列输出

REMOTE_ONLINE_RATE
  → event gap P50/P90/P95/P99 + candidate silence windows
  → 并列输出，不预设 1h/6h/24h
```

最终语义由 Product Decision Gate 冻结。

---

## 8. Hardening Track

记录但不自动修。重点观察面：

```text
Prisma engine-empty / parallel-load flakes
audit interceptor transaction boundary
test fixture accumulation（本轮已修多处 take 截断断言）
pagination assumptions
scope fail-closed behavior
payment / allocation / prepayment reconciliation
shared-settle behavior
```

**立即中断 Pilot 并修复**仅限：

```text
P0 safety issue
financial corruption
cross-tenant / cross-org data leak
irreversible state corruption
```

普通 UX / threshold / performance 问题：记 evidence，继续 Pilot。

---

## 9. Gate Criteria（跑数据前冻结）

### BLOCK — 出现任一

```text
cross-tenant leak
cross-org security breach
financial SoT corruption
irreversible state corruption
deterministic BLOCKING anomaly 漏报
system cannot complete primary business loop
```

### HARDENING REQUIRED — 无 BLOCK 但存在

```text
deterministic detector miss / false positive（已查根因、待修）
episode lifecycle inconsistency
meaningful operator friction
persistent engine/load instability
scope/accounting mismatch without corruption
E10 candidate semantics 证据不足
```

### PASS — 要求全部满足

```text
no P0
no unresolved P1 safety/accounting issues
all injected deterministic anomaly contracts explained
scope isolation holds
billing / payment / prepayment reconcile
episode lifecycle holds
operator sample completes end-to-end
Pilot evidence sufficient to decide next Product Gate
```

PASS 不要求：0 P2 / perfect UX / thresholds 已优化。

---

## 10. 执行序列（Planning Gate 解冻后）

```text
P1  generator 实现 + 独立评审（含 fail-closed tenant guard）
P2  数据集生成 + generation-summary 审阅
P3  自动化 ground-truth evaluation（precision/recall/anchor/lifecycle）
P4  人工 operator pilot（50–100 episodes）
P5  evidence.ts 扩充采集 + hardening 观察汇总
P6  Pilot Decision Gate → PASS / HARDENING REQUIRED / BLOCK
P7  （PASS 后）Product Decision Gate → E10 HOLD 指标语义冻结
```

---

## Planning Gate 自查

```text
[x] Pilot objective            — §1
[x] synthetic dataset model    — §2/§4
[x] ground-truth design        — §3
[x] operator sample design     — §5
[x] evidence matrix            — §6/§7
[x] hardening matrix           — §8
[x] PASS/HARDENING/BLOCK       — §9（跑数据前冻结）
[x] E10 decision outputs       — §7（不自动选 winner）
[x] 无 generator/schema/生产代码改动
```
