# Pilot Generator — Implementation Plan

状态：Implementation Gate **DRAFT**（等评审后才写 `generate.ts`）。
上游：`PILOT_CYCLE_1.md`（Planning Gate PASS @ eb451cd）。
本计划强制落实 D1 / D2 / D3 三个约束。

---

## 0. 执行模型（最重要的工程选择）

**不是 HTTP per-request，也不是纯 SQL 塞库。**

`generate.ts` = tsx 脚本，`NestFactory.createApplicationContext(AppModule)`
起应用上下文，直接 resolve 各模块 service，调用与 controller 完全相同的
`*Tx(tx, ctx, dto)` 方法（`water-account.service.onboardTx`、
`meter-installation.service`、`remote-event.service.ingestBatch` 等），
每个域操作包在 `TenantPrisma.runAsTenant(pilotTenantId, tx => …)` 里。

这满足 D2 的「正式 domain path」定义：

- 走同一份 service 代码 → 同样的校验、副作用、状态机、约束
- RLS 生效（`runAsTenant` 里 `set_config('app.tenant_id')`）
- 缺的只是 HTTP 层：DTO class-validator、Permissions guard、
  audit interceptor——这些不属于业务语义，generator 不需要
- ctx 手工构造：`{ tenantId, staffId: pilotStaff, scope: 'ALL',
  orgScope: [] }`——等价 admin

性能：5,000 户 × ~7 个域事务（立户/装表/入册/2 期抄表/结算/出账/收款）
≈ 35k tx。实测单 tx 5–20ms，顺序约 6–12 min；并发 4–8 控制在
2–5 min。**不允许高并发**——e2e 已观察到并行压测下 Prisma
engine-empty flake，generator 用固定 `concurrency=6`（可配但封顶 8）。

工期估算写进 generation-summary（目标 < 15 min；超时即工程问题）。

---

## 1. D1 — 逻辑时间冻结

### 决策：as-of 相对时间，不改生产代码

```text
--as-of YYYY-MM-DD    默认 = 执行当天（数据库 CURRENT_DATE）
```

所有生成时间戳相对 `asOf` 构造：

```text
bill.due_date (逾期场景)   = asOf − 15d
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
（脚本内维护显式表清单，含 `tenant_param`/`work_item`/`audit_log`
等全部 tenant 列），随后可选重新生成。同 seed 重跑 → 相同
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

域服务实际可达性在实现时逐条验证（§5 标记 ⍰）；凡域路径被
service guard 拦截的 → 落 CONTROLLED_DB_MUTATION 并在 ground truth
如实标注。

### Fault injection 矩阵（初判，实现时校准）

| scenario | 初判 method | 理由 |
|---|---|---|
| NO_BOOK | DOMAIN_FLOW | 立户不入册即可 |
| NO_ACTIVE_METER | DOMAIN_FLOW | 立户不装表即可 |
| MULTI_BOOK | DOMAIN_FLOW ⍰ | 若入册 API 允许第二册；否则 DB mutation 插第二行 book_meter |
| MULTI_ACTIVE_METER | DOMAIN_FLOW ⍰ | installation service 注释提到「一户多表 phase-2」可能允许；若 guard 拦截 → mutation 插第二 ACTIVE |
| READING_QC_REVIEW | DOMAIN_FLOW | 提交触发 QC 阈值的读数（突增/负用量） |
| READING_QC_REJECTED | DOMAIN_FLOW | review 后走 QC reject 操作 |
| ESTIMATE_STREAK | DOMAIN_FLOW | 连续 ≥threshold 期走 estimate 接口 |
| UNPAID_BILL_OVERDUE | DOMAIN_FLOW ⍰ | 若 due_date 由 period/租户参数推出且可选历史 period；否则唯一允许的 mutation = `UPDATE bill SET due_date` |
| REMOTE_EVENT_UNBOUND | DOMAIN_FLOW | ingest 未知 vendorDeviceKey |
| REMOTE_EVENT_WAITING_PLAN | DOMAIN_FLOW | 已绑定设备但 account 无 plan 期 |
| REMOTE_EVENT_FAILED | DOMAIN_FLOW ⍰ | 需构造处理失败的事件；不可达则 mutation 置 processing_status |
| REMOTE_EVENT_CONFLICT | DOMAIN_FLOW ⍰ | ingest 与既有读数冲突的事件 |
| REMOTE_EVENT_KEY_CONFLICT | DOMAIN_FLOW | 同 event key + 不同 payload hash 重复 ingest（含 recurrence：同事件 N 次 → N 条 process_log → episode token=N） |
| 跨所 MULTI_BOOK | DOMAIN_FLOW ⍰ | 同 MULTI_BOOK，覆盖册分属两所 |
| shared settle 跨所 | DOMAIN_FLOW | settle account 挂两所 water account |
| reversal / TOP_UP / APPLY | DOMAIN_FLOW | payment reverse / prepayment 接口 |
| remote 时间间隔证据 | CONTROLLED_DB_MUTATION | receivedAt 回放窗口（cadence 证据需要精确 gap 分布） |
| 历史 episode 已清除态 | CONTROLLED_DB_MUTATION | 构造 fact 先存后消的 lifecycle（或直接驱动 reconcile 两次，前者优先） |

规则：**controlled mutation 只允许写「域路径造不出的状态」，
每处必须在 ground truth 标 `injectionMethod` +
`reachableInNormalOperation`。** evaluation 报告把
`reachableInNormalOperation=false` 的 FN/FP 单独归类——人工病理
状态的失分不计入 BLOCK 判据，只进 hardening evidence。

---

## 4. 生产 tenant 保护（fail closed）

三道闸，全部不过则拒绝执行：

```text
1. --tenant 必填；tenant 必须带生成器自置标记
   tenant.params.pilot = {"generatedBy":"pilot-generator","seed":N}
   —— 由 generate.ts --create-tenant 创建时写入
   —— 对任何无标记 tenant（含所有真实/测试 tenant）直接 abort
2. DATABASE_URL host 白名单：localhost / 127.0.0.1
   （Cycle 1A 只跑本地；远程库一律 abort）
3. --reset 二次确认：要求显式 --yes 且回显将删除的行数
```

---

## 5. Ground truth ↔ DB 对账

evaluation（`scripts/pilot/evaluate.ts`，本计划只定接口）：

```text
input : ground-truth.json + 活库
步骤  : POST /exceptions/refresh → detectAll 结果按 key 建索引
输出  : evaluation-report.json
        expected/detected/missed/unexpected
        precision/recall by type
        anchor mismatch（detected.anchor ≠ expected.anchor）
        lifecycle mismatch
        clockDrift flag
```

key 级比对而非 WorkItem 自证：`expected.anomalies[].key` 与
detected fact key 精确字符串相等；WorkItem 层面只校验 episode
生命周期（active/cleared 轨迹）不校验存在性本身。

---

## 6. 规模与配比（默认 profile，可调）

```text
accounts:        4,000
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
G1  本计划评审（本 Gate）
G2  scripts/pilot/generate.ts 骨架：tenant guard + reset + ctx/service
    harness + deterministic key scheme + ground-truth writer
G3  baseline flows（§3 上表全部 DOMAIN_FLOW 链路）
G4  fault injection（§3 矩阵逐场景，⍰ 项实现时定 method 并回写本表）
G5  evaluate.ts + 冒烟（小规模 200 户先跑通全链路）
G6  全量生成 + evaluation + 人工 operator pilot → Gate 判据
```

G2–G4 每步完成跑一次小规模 verify，不到 G6 不碰 5,000 户全量。

---

## 8. 未决项（本 Gate 需评审裁决）

```text
Q1  并发上限：6 固定 or 可配(≤8)？         建议：可配默认 6
Q2  MULTI_BOOK / MULTI_ACTIVE_METER /
    WAITING_PLAN / FAILED / CONFLICT 的
    method 初判 ⍰ 项，G4 时实测 service
    guard 后回写——允许带⍰ 过 Gate？      建议：允许，但回写是硬要求
Q3  due_date 若必须 mutation：是否接受    建议：接受——这是「时间构造」
    「UPDATE bill.due_date」作为唯一        而非「状态伪造」，仍标
    允许的财务表 mutation？                reachableInNormalOperation=true
Q4  evaluate.ts 是否随 G5 一并实现？      建议：是，否则 ground truth
                                          写完没人读
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
