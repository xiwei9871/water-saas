# Pilot Generator — Implementation Plan

状态：Implementation Gate **CLOSED — FINAL**（D4 + Q1–Q4 裁决已并入，
见 §8；未写 `generate.ts`）。
上游：`PILOT_CYCLE_1.md`（Planning Gate PASS @ eb451cd）。
本计划强制落实 D1 / D2 / D3 / D4 四个约束。

---

## 0. 执行模型（最重要的工程选择）

**不是 HTTP per-request，也不是纯 SQL 塞库。**

`generate.ts` = tsx 脚本，`NestFactory.createApplicationContext(AppModule)`
起应用上下文，直接 resolve 各模块 service，调用与 controller 完全相同的
方法（`water-account.service.onboardTx`、
`meter-installation.service`、`remote-event.service.ingestBatch` 等）。
所有 service 调用先按 D4 判断 transaction ownership——不存在
「每个域操作都包 `runAsTenant`」的 blanket rule。

这满足 D2 的「正式 domain path」定义：

- 走同一份 service 代码 → 同样的校验、副作用、状态机、约束
- RLS 生效（`runAsTenant` 里 `set_config('app.tenant_id')`）
- 缺的只是 HTTP 层：DTO class-validator、Permissions guard、
  audit interceptor——这些不属于业务语义，generator 不需要
- ctx 手工构造：`{ tenantId, staffId: pilotStaff, scope: 'ALL',
  orgScope: [] }`——等价 admin

### D4 — Transaction ownership（冻结）

每个被调 service 按事务归属分两类，G2 实现时逐 service 标注：

```text
TX_CALLER_MANAGED
  service.*Tx(tx, ctx, dto) — 事务由调用方持有
  → generator 用 TenantPrisma.runAsTenant 包一层

TX_SELF_MANAGED
  service 内部自己 runAsTenant / 自己拆事务
  → generator 直接调用，外层禁止再包 runAsTenant
```

特别注明：`RemoteEventService.ingestBatch` = **TX_SELF_MANAGED**
（每事件独立事务）。

冻结规则：**never nested `TenantPrisma.runAsTenant`。** 嵌套意味着
内层 `set_config` 覆盖外层事务边界，RLS/提交语义失真。

### 并发（Q1 FINAL）

```text
--concurrency   可配，hard cap = 8，initial default = 2
```

并发仅用于彼此独立的 entity generation。**dependency-sensitive
phase 一律串行**：

```text
shared settle / billing runs / plan generation /
same-account lifecycle / reversal / KEY_CONFLICT recurrence /
remote replay
```

升级路径：G5 200-account smoke 连续 clean runs（无
engine-empty / socket / transaction flake）后才允许默认 profile
提到 `concurrency = 6`。**`<15 min` 性能目标不得优先于
evidence reliability**——flake 即降并发，不硬撑。

---

## 1. D1 — 逻辑时间冻结

### 决策：as-of 相对时间，不改生产代码

```text
--as-of YYYY-MM-DD    默认 = 执行当天（数据库 CURRENT_DATE）
```

所有生成时间戳相对 `asOf` 构造：

```text
UNPAID_BILL_OVERDUE 时间构造:
  historical period + tenant_param.bill_due_days
  → BillingRun domain flow 自然产生 dueDate
  → 确保 dueDate < databaseCurrentDate
  generator 禁止直接写 bill.due_date
reading.reading_date      = 各自 period 内固定日
payment.received_at       = period 窗口内
remote_event.received_at  = asOf 相对偏移
episode 生命周期           = reconcile 由 asOf 时刻的 fact 快照驱动
```

### 为什么不做 clock injection

`detectUnpaidBillOverdue` 用 PostgreSQL `CURRENT_DATE`。Cycle 1A
不为 Pilot 改生产 detector。后果与对策：

- 同一 seed + 同一 `--as-of` 重跑 → **逻辑等价数据集**（时间戳绝对值
  随 asOf 语义重建，不是字节级一致——由 D3 兜住比较口径）
- `asOf` 与实际执行日分离时，overdue 判定以 **DB CURRENT_DATE** 为准：
  evaluation manifest 必须同时记录三者并校验一致性
  （asOf == databaseCurrentDate 才允许判 recall，否则标记
  `clockDrift: true`，结果降级为 HARDENING evidence 而非 Gate 证据）

```json
// generation-summary.json 头部
{ "asOf": "2026-09-23", "generatedAt": "...",
  "databaseCurrentDate": "2026-09-23", "seed": 42, "profile": "default" }
```

真正跨日期字节级可复现（clock injection）若未来需要 → 单独设计，
不在 Cycle 1A。

---

## 2. D3 — 确定性逻辑身份（选 B：semantic deterministic）

ID 不冻结（继续 `gen_random_uuid()`），冻结 **business keys**：

```text
tenant.code        = PILOT-<seed>            e.g. PILOT-0042
accountNo          = P<seed>-<scenario|BG>-<seq>
                     P0042-BG-000137   （clean background 户）
                     P0042-NBK-000007  （NO_BOOK 注入户）
meter.deviceNo     = P<seed>-M-<seq>
event external key = P<seed>-EV-<seq>
book.code / org 名 = P<seed>-...
```

ground-truth.json 结构：

```json
{
  "scenarioKey": "NO_BOOK:000007",
  "injectionMethod": "DOMAIN_FLOW",
  "reachableInNormalOperation": true,
  "businessKeys": { "accountNo": "P0042-NBK-000007" },
  "entityIds": { "waterAccountId": "<本 run UUID>" },
  "expected": {
    "anomalies": [
      { "type": "NO_BOOK", "key": "wa:<uuid>:NO_BOOK",
        "anchor": "TENANT", "lifecycle": ["active"] },
      { "type": "NO_ACTIVE_METER", "key": "wa:<uuid>:NO_ACTIVE_METER",
        "anchor": "TENANT", "lifecycle": ["active"] }
    ],
    "orgOwnership": ["<branch org id>"],
    "financialEffect": null
  }
}
```

- 一个 entity 允许挂多个 expected anomalies（上例 off-book 户）
- `entityIds` 是本 run 内评估的映射；**跨 run 比较用
  `scenarioKey` + `businessKeys`**，UUID 不参与
- evaluation 端 join：`expected.key` 里嵌的 UUID 与
  `entityIds.waterAccountId` 一致，detected fact key 直接字符串比对

### 复跑幂等

`generate.ts --reset`：按 FK 序删 `tenant_id = pilot` 的所有域行
（reset 安全断言见 §4），随后可选重新生成。同 seed 重跑 → 相同
businessKeys/scenarioKeys，新 UUID。

---

## 3. D2 — Domain flow vs 故障注入边界

### Baseline（全部 DOMAIN_FLOW）

```text
orgs (3 所) / books (12 册) / staff / tariff plan (ACTIVE)
→ onboard(customer+settle+water-account)
→ meter install（meter + installation ACTIVE）
→ book_meter 单册覆盖
→ reading plan + meter_reading ×2 期（QC PASS 正常读数）
→ consumption_settlement FINAL
→ billing run → bill POSTED
→ payment（全额/部分/TOP_UP 混合）+ day_close
→ prepayment top_up + APPLY
→ remote source + device + binding + ingestBatch + plan + process
```

域服务实际可达性在实现时逐条验证。**任何已冻结为 DOMAIN_FLOW +
`reachableInNormalOperation=true` 的 Gate scenario，若实现时无法
通过现有 domain service 构造：STOP → 回 Implementation Gate →
不得由实现者自行降级为 DB mutation。**

### Fault injection 矩阵（Q2/Q3 FINAL）

| scenario | method | 依据 |
|---|---|---|
| NO_BOOK | DOMAIN_FLOW | 立户不入册即可 |
| NO_ACTIVE_METER | DOMAIN_FLOW | 立户不装表即可 |
| MULTI_BOOK | DOMAIN_FLOW | `addMemberTx` 向不同 books 加同一 account |
| MULTI_ACTIVE_METER | DOMAIN_FLOW | `installTx` + distinct AVAILABLE meters——domain 明确允许 multiple ACTIVE/account |
| READING_QC_REVIEW | DOMAIN_FLOW | 提交触发 QC 阈值的读数（突增/负用量） |
| READING_QC_REJECTED | DOMAIN_FLOW | review 后走 QC reject 操作 |
| ESTIMATE_STREAK | DOMAIN_FLOW | 连续 ≥threshold 期走 estimate 接口 |
| UNPAID_BILL_OVERDUE | DOMAIN_FLOW | `tenant_param.bill_due_days` + historical billing period + BillingRun → POSTED/PARTIAL_PAID + remaining>0 + dueDate < DB CURRENT_DATE |
| REMOTE_EVENT_UNBOUND | DOMAIN_FLOW | ingest 未知 vendorDeviceKey |
| REMOTE_EVENT_WAITING_PLAN | DOMAIN_FLOW | bound event + 无匹配 plan item |
| REMOTE_EVENT_FAILED | DOMAIN_FLOW | ambiguous matching plan items |
| REMOTE_EVENT_CONFLICT | DOMAIN_FLOW | completed non-REJECTED reading + remote event |
| REMOTE_EVENT_KEY_CONFLICT | DOMAIN_FLOW | 同 event key + 不同 payload hash 重复 ingest（recurrence：同事件 N 次 → N 条 process_log → episode token=N） |
| 跨所 MULTI_BOOK | DOMAIN_FLOW | 同 MULTI_BOOK，覆盖册分属两所 |
| shared settle 跨所 | DOMAIN_FLOW | settle account 挂两所 water account |
| reversal / TOP_UP / APPLY | DOMAIN_FLOW | payment reverse / prepayment 接口 |
| remote 时间间隔证据 | CONTROLLED_DB_MUTATION | receivedAt 回放窗口（cadence 证据需要精确 gap 分布） |
| 历史 episode 已清除态 | 优先驱动 reconcile 两次 | fact 先存后消走自然生命周期；不可行再 mutation |

全部正式可达场景 `reachableInNormalOperation = true`。G4 仍需验证
实际 fixture construction；**禁止降级为 DB mutation**，除非发现与
主干代码事实冲突——若发生必须回 Gate。

### 财务事实伪造禁令（Q3 FINAL）

Cycle 1A Gate 样本**禁止直接修改**以下字段伪造正式可达财务事实：

```text
bill.total_amount / bill.status / bill.due_date
payment_alloc / prepayment ledger
```

未来若专测 corrupted/pathological DB state：标
`CONTROLLED_DB_MUTATION` + `reachableInNormalOperation=false` +
**hardening-only**，不进入正常 detector Gate recall。

规则：**controlled mutation 只允许写「域路径造不出的状态」，
每处必须在 ground truth 标 `injectionMethod` +
`reachableInNormalOperation`。** evaluation 报告把
`reachableInNormalOperation=false` 的 FN/FP 单独归类——人工病理
状态的失分不计入 BLOCK 判据，只进 hardening evidence。

---

## 4. 生产保护（fail closed，FINAL）

执行条件**全部**满足才允许运行，任一不过即 abort：

```text
DATABASE host ∈ {localhost, 127.0.0.1}
AND database name ∈ pilot allowlist（watersaas_pilot 或 *_pilot）
AND tenant.params.pilot.generatedBy == "pilot-generator"
```

- `--create-tenant` **也必须先通过 DB host/name guard**
- 对任何无标记 tenant（含所有真实/测试 tenant）直接 abort

`--reset`：

```text
1. 要求 --yes，先打印各表待删除行数
2. 删除后扫描 information_schema 中全部含 tenant_id 的应用表
3. assert pilot tenant residual rows == 0
4. 若发现 reset 清单遗漏任何 tenant table → abort，
   不带残留数据继续生成
```

---

## 5. Ground truth ↔ DB 对账（Q4 FINAL）

`scripts/pilot/evaluate.ts` 与 G5 同步实现。两层正确性分开评：

**Detector correctness**——直接调 `detectAll(tx, tenantId)`：

```text
ground-truth.json
      ↓
detectAll(tx, tenantId)          ← 不经过 WorkItem
      ↓
expected vs detected（key 精确比对）
      ↓
precision / recall / anchor mismatch / missed / unexpected
```

禁止从 WorkItem 反推 detector correctness。

**Episode correctness**——单独验证 reconciler：

```text
detectAll
→ ExceptionReconciler.reconcileTx
→ work_item
→ active / cleared / recurrence / resolutionSource validation
```

`POST /exceptions/refresh` 可做 API smoke，但**不得作为 detector
truth 的唯一数据入口**。

输出 `evaluation-report.json`：

```text
expected / detected / missed / unexpected
precision·recall by type
anchor mismatch（detected.anchor ≠ expected.anchor）
lifecycle mismatch（episode 层）
clockDrift flag
```

---

## 6. 规模与配比（full configured profile）

```text
accounts:        4,000  (default; configurable 3,000–5,000)
  clean background         ~3,400
  injected scenario 户      ~600
    13 类 × ~40 独立样本     ≈ 520
    复合场景（跨所/shared settle/TOP_UP/reversal/replay）≈ 80
periods:         2 个连续账期（--period-from/to）
remote:          每所 1 source，~30% 户有远传绑定，事件量 ~2×账户覆盖
books:           12（每所 4）
```

每类 ≥30 样本是统计下限；配比写进 profile JSON，非代码常量。

---

## 7. 交付切分

```text
G1  本计划评审（本 Gate）—— PASS
G2  scripts/pilot/generate.ts 骨架：tenant/DB guard + reset（含残留
    断言）+ ctx/service harness（逐 service 标 D4 事务归属）+
    deterministic key scheme + ground-truth writer
G3  baseline flows（§3 上表全部 DOMAIN_FLOW 链路）
G4  fault injection（§3 矩阵全 DOMAIN_FLOW；fixture construction
    实测，与主干冲突则回 Gate，不得自行降级 mutation）
G5  evaluate.ts + 200 户冒烟：detector correctness（detectAll 直评）+
    episode correctness（reconcileTx→work_item）；
    连续 clean runs 无 engine-empty/socket/transaction flake 后
    默认 profile 方可提 concurrency=6
G6  全量生成 + evaluation + 人工 operator pilot → Gate 判据
```

G2–G4 每步完成跑一次小规模 verify，不到 G6 不碰 full configured
profile（default 4,000；configurable 3,000–5,000）。

---

## 8. Gate 裁决记录（FINAL）

```text
Q1  concurrency：可配，hard cap=8，initial default=2；
    dependency-sensitive phase 串行；G5 clean smoke 后默认 profile
    可提 6；性能目标让位 evidence reliability          —— FINAL
Q2  scenario method：MULTI_BOOK / MULTI_ACTIVE_METER /
    WAITING_PLAN / FAILED / CONFLICT 全部 DOMAIN_FLOW，
    reachableInNormalOperation=true；G4 实测冲突须回 Gate —— FINAL
Q3  UNPAID_BILL_OVERDUE：DOMAIN_FLOW（tenant_param.bill_due_days
    + historical period + BillingRun）；Gate 样本禁止 mutation
    bill/payment_alloc/prepayment ledger                  —— FINAL
Q4  evaluate.ts：G5 同实现；detector 正确性直调 detectAll，
    episode 正确性走 reconcileTx→work_item；refresh 仅 smoke —— FINAL
D4  transaction ownership：TX_CALLER_MANAGED 外层包 runAsTenant；
    TX_SELF_MANAGED 直调禁嵌套；never nested runAsTenant —— 冻结
```

---

## 9. 不做清单（防止 scope creep）

```text
✗ 不改生产 detector / 不加 mock clock
✗ 不新增 telemetry / 审计表
✗ 不实现 HOLD 指标公式
✗ 不做 HTTP 批量接口（Pilot 专用端点不进产品）
✗ 不支持非本地 DB / 非 Pilot tenant
✗ 不生成 UI 操作脚本（operator pilot 用真人）
```
