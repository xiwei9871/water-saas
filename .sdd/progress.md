# SDD ledger — plan: docs/superpowers/plans/2026-09-18-water-saas-mvp.md

## Setup
- Repo: /Users/xiwei/water-saas，branch `feat/mvp`（Ruling: 不用 git worktree，仓库为本项目新建、main 仅文档，分支隔离已足够；成本：若有并行会话改 main 需 rebase）
- Spec: docs/superpowers/specs/2026-09-18-water-saas-mvp-design.md（已读，v1.1 final patch）

## Pre-flight scan（任务间接口/共享文件）

| 对/项 | 产出 → 消费 | 结论 |
|---|---|---|
| T2→T3+ | TenantPrismaService.runAsTenant / withTenant,currentTenant → 所有模块 | 一致 |
| T3→T12 | IdempotencyService.runWithKey → payment 创建 | 一致 |
| T4→T5/T6/T7 | installation/account → plan_item、readings、components | 一致 |
| T5→T6 | reading_plan_item → 读数更新 status/completed_reading_id | 一致 |
| T6→T7/T11 | PASSED readings → component / ACTUAL 触发 reconciliation | 一致 |
| T7→T10/T11 | FINAL settlement → 开账；estimated FINAL → reconciliation 范围 | 一致 |
| T8→T9/T10 | ACTIVE tariff（按 period 生效版本）→ computeBill | 一致 |
| T9→T10/T11 | computeBill/tieredAmount/reprice（Decimal）→ 开账/补差 | 一致 |
| T10→T11/T12 | POSTED bills → posted_charge / allocs 目标 | 一致 |
| T13→T4 | FinancePort.getOutstanding → close use-case | **顺序冲突：T4 先于 T13** |
| T1 enums | 全枚举 → 全模块 | 一致 |

## Rulings（执行前裁决）

1. T4 销户需 outstanding 查询但 T13 才建 ports → **Ruling**: T4 在 `customer/use-cases/close-account.use-case.ts` 内定义 `OutstandingPort` 接口 + `StubOutstandingProvider`（恒返 0）注册于 customer module；T13 时再将通用 ports 收编到 integration 模块。成本：接口日后迁移需改 provider 绑定。
2. `bill.billing_run_id`：adjustment/reversal/replacement 单不产生于 run → **Ruling**: schema 中设为 nullable。
3. `RunStatus` 枚举须含 `DRAFT/PROCESSING/PARTIAL/POSTED/FAILED`（plan global constraint）→ 写入 T2 schema 任务。
4. `reading_plan_item` 加 `@@unique([planId, waterAccountId])` 防计划重复户。
5. T7 取数规则：component 取**该 period 内该 installation 的最新 PASSED ACTUAL**（含 supersede 链顶端者）；无 → NO_READ/缺数 → ESTIMATE 路径。
6. `meter_reading.period` 字段保留（ad-hoc 读数无 plan_item 时用），冗余但必要。
7. T2 seed 用独立 `MIGRATION_DATABASE_URL` PrismaClient（owner）；runtime `TenantPrismaService` 仅 `DATABASE_URL`（ws_app）。

## Progress
Task 1: complete (commits 108ae75..cbcf856, review APPROVED)
- Ledger note: api 是 Nest12 scaffold（vitest 非 jest），与 plan 假设偏差——测试栈统一 vitest，无需改计划。
- Ledger note: colima 提供 docker；VM 重建需 `colima start` + 修 resolv.conf + registry mirrors。
- Ruling: "第34个枚举"为约束文本笔误（清单即33个），spec 状态机枚举已全覆盖；tenant/staff status 属 schema 细节，T2 可自定 enum。成本：若遗漏某 status 枚举，T2 review 兜底。
- Carried to T2: (a) api→@ws/types import 冒烟测试优先做，rootDir/main→dist 若挂即修 exports；(b) .gitignore 已补 .sdd/。
Task 2: fix round 1/5 (4 addressed, 0 open; commits 9e977a5..03e1bbd)
Task 2: complete (commits 65e4ea2..03e1bbd, review clean)
- Deviation ledger (implementer/reviewer verified): NULLIF policy 修空串bug；ws_owner 非superuser owner 证明 FORCE；Prisma 钉 6.19.3；@ws/* exports→dist；DayCloseStatus/TenantStatus/StaffStatus 补 enum。
- Carried to T3: (a) login 前 tenant_code→id 用 postgres-owned `tenant_directory` view（id/code/name/status，GRANT SELECT TO ws_app）；(b) BigInt JSON 序列化约定：全局 interceptor 转 string；(c) 新表四件套：OWNER ws_owner + ENABLE + FORCE + NULLIF policy + 复合FK；(d) 测试栈 vitest；(e) e2e 用 watersaas_test，fixtures 带前缀防污染。
Task 3: fix round 1/5 (C1-I6+minors, commit a3a6770) → re-review NEEDS_MORE (F1 dataScope self-grant)
Task 3: fix round 2/5 (F1 admin-only 收口 + F3/F5/F6b, commit d2fe8ed) → re-review F1链已闭合, 余 createPermission 漏收口 + uuid/enum/array 500 残留
Task 3: fix round 3/5 (orchestrator 直改: createPermission assertAdmin, roles :id assertUuid, staff orgUnitId/status/roleIds 校验 + 4 e2e, commit f810544)
Task 3: complete (commits 36d2464..f810544, e2e 25/25, lint clean)
- Carried patterns: grant 面一律 assertAdmin(perms含'*')；:id/body uuid 走 assertUuid→400；写路径 orgInScope；P2002→conflictOnUnique 409；幂等照 staff.create 手动 runWithKey。
- Deferred (accepted, 不阻塞): M2 响应结构不一致, M5 login rate-limit+审计, M7 部分e2e, F2 audit roleIds/entityId 保真, F4 404vs403 oracle+TOCTOU, F6a 用例顺序依赖, scoped-writer 可重置/停用子树内 staff(含admin拓扑风险)=委派模型固有, MVP 显式接受。
Task 4: fix round 1/5 (orchestrator 直改 review Important, commit 本次)
Task 4: complete (commits 5db1917 + fix, e2e 40/40)
- 修复: install/remove/transition 状态守护改 updateMany+status谓词(TOCTOU)；water/settle PATCH 加 CLOSED 闸；FinancePort.getOutstanding(tenantId, accountId) 签名；close outstanding !==0n(贷方也挡)；xNo trim/空串→发号(4处)；maxDial min:0；seq 时区注释。
- Deferred: pageArgs重复, PATCH不能置null, 复装initialReading连续性, onboard响应子集不一致, withOptionalIdem丢status, e2e共享态。
- Pattern for T5+: 状态迁移写一律 updateMany+status谓词原子化；xNo 用 ?.trim()|| 不用 ??；assertDecimal 带 min。
Task 5: fix round 1/5 (orchestrator 直改 I1/I2+minors, commit 本次, e2e 55/55)
Task 5: complete (commits 3f25880 + fix)
- 修复: generate/start/cancel 挂 orgInScope(book.orgUnitId, plan.bookId 裸列二次查); deleteTx FOR UPDATE 与 generate 串行化; generate 跳过 CLOSED 户; membersOf/plan list tiebreak; removeMember auditBefore; scheduleDay 严格数字; readerId ''→400; scoped-writer fixture+2 e2e 回归。
- Deferred: M3 CLOSED 语义混淆(加CANCELLED/close_reason 待二期), M8 requestHash 键序敏感(shared helper), M9 其余测试缺口, M10/M12。
- Pattern: plan 引 book 是裸列→scope 校验二次查 readingBook; FOR UPDATE 锁在 runAsTenant tx 内防 check-then-act 竞态。

## T6 review fixes (commit pending-hash)
- advancePlans lost-DONE race → sorted FOR UPDATE on plan row
- NO_READ item retry path (PENDING|NO_READ writable; READ via supersede)
- qcTx refuses superseded rows (READING_SUPERSEDED)
- import scope-null deny + forced IMPORT source
- partial unique index on supersedes_reading_id (DB backstop)
- e2e 82/82

## T7 complete (4be9976 + review-fix commit)
- settlement.service.ts + settlement/estimate controllers + estimator.ts + money.ts
- supersede-exclusion verified (NOT EXISTS child, not IS NULL)
- review fixes: override conflict 400, scope-before-dup, PREV_EXCEEDS_MAX_DIAL,
  P2002 shape, history tiebreak, billing-core prebuild hooks
- e2e +3 (supersede exclusion ×2, rollover) → 104/104
- notes for T9/T11: ComponentSourceType.MANUAL unused (无表码手工结算),
  per-component method only in estimateBasis JSON, out-of-order period
  settlement accepted trade-off, preview POST writes audit rows

## T8 complete (c309715 + review fix)
- tariff freeze/overlap/guarded-write hardening; tariff_tier composite FKs
- T9 contract documented: bill insert must FOR UPDATE the tariff_plan row
## T9 complete (61f43b4 + f3daf5b audit fix)
- billing-core: roundCent/tieredAmount/computeBill, 47/47
- audit hardening: TARIFF_TIERS_INVALID, finite guards, zero-PERCENT skip

### T10 DONE — billing run + bill lifecycle + 红冲 (feat 1682f59 + fix c570c27, e2e 161/161)
- Deviation kept + documented: synchronous execute() (no BullMQ/worker exists), per-bill tx, state machine preserved — a future worker calls execute() unchanged.
- Run lifecycle DRAFT→PROCESSING→POSTED|PARTIAL|FAILED; retry re-attempts generate-failures then posts remaining DRAFT bills; discard DRAFT-only. Reverse → REVERSED original + POSTED REVERSAL (negated items, ADJUSTMENT type); replace → REVERSED + POSTED REPLACEMENT recomputed on ORIGINAL plan tiers.
- T8 freeze contract honored in all 4 bill-write paths (plan FOR UPDATE before bill write/flip).
- Data-integrity review (explore): NEEDS_FIXES → 2 Important + minors addressed in c570c27:
  I2 close-vs-post serialized via water_account FOR UPDATE on both sides + DRAFT bills counted in outstanding + post refuses CLOSED;
  I1 single-bill mutations org-scoped via plan→book chain (run ops documented tenant-wide);
  M4 ytd ladder recovers REPLACEMENT usage from PER_QTY item qty;
  M1 P2002→already-billed, M2 corrupted tier→RecordedFailure, M6 discard predicate, M8 ≤4dp bound.
- Accepted edges (documented): sibling same-period runs see each other's bills as billed (operator-serial); retry can double-execute vs a live PROCESSING (integrity holds, wasted work); reversing a REPLACEMENT dead-ends the settlement (T11 note); unbilled-FINAL-settlement + close remains an ops gap.
- Forward notes for T11: reprice() is the repair path for any residual mispricing; PARTIAL_PAID reversal orphans payment_alloc (T12 to handle); M10 confirmed — replace flips original REVERSED in place, no separate REVERSAL row.

### T11 DONE — reconciliation 补差 (anchor buildReconciliation + absorb/reprice + adjustment bill)
- billing-core reconcile.ts: buildReconciliation (actual−anchor / Σsettled / remainder, negative allowed), allocateUsage (PROPORTIONAL_TO_SETTLED | ALL_TO_CURRENT, 4dp quantum, residue always on last period → Σ exact), reprice (per-period computeBill at own fee items, natural-year ytd reset).
- api reconciliation.service/controller + billing.module: POST resolves actual (explicit/latest trusted: PASSED ACTUAL|REMOTE, non-null, superseded-child probe) + anchor (same-account trusted, period ≤ actual) + span (anchor, actual] in ONE tx.
- Outcomes: meter swap or actual<anchor under default negative_usage_policy=CLAMP_REVIEW → MANUAL_REVIEW; remainder ≥0 + actual-period DRAFT settlement with no NORMAL bill → guarded updateMany ABSORB (+remainder, auditBefore pre-image); else ADJUST — reconcile_alloc_policy (default PROPORTIONAL), missing ACTIVE plan → 422 RECONCILIATION_TARIFF_MISSING, correct−posted (NORMAL|REPLACEMENT in POSTED|PARTIAL_PAID|PAID) → ONE POSTED ADJUSTMENT bill (source RECONCILIATION, per-period delta items, dueDate null, negative=credit); adjustment=0 → APPLIED no bill.
- Locks: adjustment path re-reads account status under water_account FOR UPDATE (T10 close-vs-post contract), then last span period's plan FOR UPDATE (T8 freeze); recon row lands before its bill for sourceId; UNIQUE(tenant_id, actual_reading_id) backstop → 409; withOptionalIdem on POST.
- Immutability held: FINAL settlements / POSTED bills never mutated; recon rows append-only.
- Deviations: meter swap → MANUAL_REVIEW (cross-installation attribution out of MVP); adjustment bill.period = actual.period; ALL_TO_CURRENT keeps prior settled + delta on last.
- e2e reconciliation 18/18 (absorb, negative adjust, positive adjust vs FINAL+billed, manual review, 409 replay, tenant-B isolation, 404s); billing-core 63/63; api e2e 179/179.

### T11 review-fix — spec-conformant absorb, posted completeness, serialization
- C1/I2 semantics: previously_settled = Σ FINAL-only (DRAFT usage is open usage); remainderUsage = openUsage. Absorb preconditions: remainder≥0 + actual-period settlement DRAFT + no NORMAL bill + every other span settlement FINAL → SET totalUsageQty:=openUsage (idempotent, corrects over-estimates in place).
- I1 dial-chain rewire on absorb: component on actual.installationId gets end_reading=actual, sourceType=READING, sourceReadingId=actual.id, usage=openUsage−Σ(others); missing component or qty<0 → MANUAL_REVIEW. Without it prevChain would start at the estimate's synthetic end → double-bill.
- Adjust gate: every span settlement must be FINAL + posted-side billed (NORMAL via SETTLEMENT link, REPLACEMENT resolved through ORIGINAL_BILL) else 422 RECONCILIATION_UNBILLED_SPAN{period}.
- C2: posted charge now counts NORMAL|REPLACEMENT|ADJUSTMENT — prior corrections are real debt; successive recons converge (e2e: −6000 not −9000).
- C3/M6: water_account FOR UPDATE hoisted before ALL state reads; status re-read under lock → CLOSED→409 on every leg.
- M2: every distinct span plan FOR UPDATE (sorted); tariffPlanId stays last period's plan. M3: all-bindings scope probe before 404/409 probes. M5: @@unique map name. M7: take:1 probes for latestTrusted/anchorBefore. M1 docblock: same-period re-read has no recon path (empty span → 409).
- negative_usage_policy read but reserved — negative totals are MANUAL_REVIEW under both policies (.lt(0) not isNegative — Decimal('-0')).
- e2e 22/22: +C1-sharpest (over-estimate corrected 40→25), +UNBILLED_SPAN, +C2 convergence via back-dated supersede, +CLOSED 409, +SET-replay idempotency, +component assertions.
- Note: absorbed settlement keeps is_estimated=true/estimate_method (brief didn't ask to flip; flag for reviewer).

### T11 DONE — reconciliation 锚点校准 (feat de0f5e2 + fix eb26810 + docs, e2e 183/183)
- billing-core: buildReconciliation / allocateUsage (PROPORTIONAL|ALL_TO_CURRENT, residue→last, 4dp) / reprice (per-period computeBill, natural-year ytd reset). 63/63 pkg tests.
- API: POST /reconciliations auto-derives actual (latest trusted) + anchor; span (anchor.period, actual.period]; absorb → guarded SET totalUsageQty:=openUsage + component rewire to actual (dial chain stays truthful); adjust → reprice → POSTED ADJUSTMENT bill (per-period items, negative allowed); MANUAL_REVIEW on dial regression/meter-swap/unattributable.
- Data-integrity review round 1 (explore): NEEDS_FIXES — 3 Critical double-bill defects, all fixed in eb26810:
  C1 settled=FINAL-only + adjust gate 422 RECONCILIATION_UNBILLED_SPAN (unbilled span periods no longer posted=0 double-charged);
  C2 postedChargeCent includes ADJUSTMENT-kind (overlapping reconciliations converge);
  C3 water_account FOR UPDATE hoisted before all state reads (+ CLOSED→409 all legs, scope ordering, all-span-plan locks, take:1, .lt(0), unique map name).
- Re-review APPROVED; residuals all fail-closed: N1 REPLACE-of-REPLACEMENT→false 422 (documented limitation, triple-hop pathological), N3 pre-existing gap — generate/finalize/reverse/replace don't take the account lock (architecture note, not T11 scope), N5 cosmetic prev_reading_value.
- Accepted semantics (documented): isEstimated on absorbed settlement unchanged (generation provenance, not current truth); adjustment bill.tariffPlanId = last span plan (multi-version approximation); negative_usage_policy reserved/unread; same-period anchor+actual → EMPTY_SPAN 409 (no same-period recalibration path in MVP).

### T12 DONE — counter payments 柜台收费 + 销账分摊 + receipts + cashier day-close (this commit, e2e 200/200)
- Payment module (billing ← payment direction, zero feature imports): payment.service (create/list/detail/outstanding/reverse/print + settleAccount→waterAccounts→planItems→plans→books scope probe, all-bindings rule, unbound=permissive carve-out) + controllers /payments, /water-accounts/:id/outstanding, /receipts/:id/print, /cashier-day-close(+list/detail). SequenceService moved customer/→common/ (global CommonModule) so payment numbers without importing customer.
- POST /payments: one tx — sorted bill FOR UPDATE → payable gate (non-REVERSAL, POSTED|PARTIAL_PAID, outstanding>0, alloc≤outstanding) → payment+allocs+receipt (+payment_no 'P'+receipt_no 'R' via sys_sequence) → guarded recompute (Σallocs≥total→PAID, >0→PARTIAL_PAID). 400 MISMATCH/DUPLICATE, 409 OVER_ALLOCATION/BILL_NOT_PAYABLE; withOptionalIdem (record+write atomic). Reversal-kind target excluded; over-pay/credit out of MVP scope (documented).
- Reversal is APPEND-ONLY (decided semantics): original NEVER flipped — RECEIVED stays RECEIVED so the +/− pair nets in its own close; DAY_CLOSED stays DAY_CLOSED (signed close immutable). New RECEIVED payment −amount, reversalOfId, same channel/settle, negative mirror allocs, receipt voided, bills recomputed back (0→POSTED). PaymentStatus.REVERSED now vestigial (documented); reversal-of-reversal→400, double→409 under payment-row FOR UPDATE. Post-close reversal rolls into the NEXT close as a negative line (<= closeDate sweep, not =).
- Day close: staff row FOR UPDATE serializes same-cashier races (exists-check race-free w/o unique idx) → sweep RECEIVED received_at::date<=closeDate → guarded RECEIVED→DAY_CLOSED flip on claimed ids → POSTED CashierDayClose (totals + byChannel all-3-buckets jsonb, amounts stringified for jsonb exactness). Not idem-wrapped by design (replay-safe: EXISTS/EMPTY 409s). Detail reconstructs membership exactly via prev-close boundary. closeDate=DB CURRENT_DATE default.
- BillingFinancePort.getOutstanding now Σ(total−Σallocs) over DRAFT|POSTED|PARTIAL_PAID non-REVERSAL bills; alloc term additionally spans REVERSED bills so a paid-then-red-flushed bill's surviving allocs become a blocking customer credit (resolves the T10 "PARTIAL_PAID reversal orphans payment_alloc" note) until the payment is reversed. Close-account: partial pay blocks, remaining DRAFT blocks, net-credit blocks, zero→closes (e2e-verified end to end).
- Outstanding endpoint: items=outstanding>0 payable lines; totalOutstanding=net over all live bills — negative ADJUSTMENT (recon credit) nets the total, consistent with the port.
- e2e payment 17/17: split→PAID+PARTIAL_PAID+nos, full 400/409 matrix, idem replay+conflict, outstanding+negative-ADJ netting, reverse semantics (original untouched, receipt void, rollback POSTED, double/rev-of-rev), print+reprint+void-409, close byChannel+membership+EXISTS/EMPTY, post-close reversal next-close −line + sealed-close membership, close-account ladder, reversed-bill credit edge, tenant-B, reader 403-writes, scoped 403 bound/unbound.
- Deviations: file split day-close.service/controller + account-outstanding.controller + receipt.controller instead of brief's loose filenames (module conventions); receipt print gated payment:write (mutating POST; brief allowed read|write); close not idem-wrapped (replay-safe by construction); sweep uses received::date<=closeDate so post-close stragglers roll forward — strict = would strand them forever.
- Forward notes for T13: byChannel jsonb amounts stored as strings (exactness, reports read verbatim); unbilled-FINAL-settlement + close still an ops gap; PaymentStatus.REVERSED reserved.

### T12 review-fix — outstanding credit probe, close membership, reversal serialization (this commit, e2e 204/204)
- C1 outstandingTx: added `reversedBillCredit` (Σ payment_alloc on REVERSED-status non-REVERSAL bills of the settle account) — the port's alloc term minus DRAFT; `totalOutstanding = Σ live lines − credit`. A paid-then-replaced bill's orphaned allocs now net the collectible total (probe 8000→2000, credit 6000, FinancePort agrees). Positive credit ⇒ payment-reversal refund path, not more collection.
- I1 reverseTx: payment → water_account(s) FOR UPDATE (sorted, imported billing/pricing lockAccountForUpdate) → bill locks → seq; CLOSED account → 409 PAYMENT_ACCOUNT_CLOSED (reversal is the only path that RAISES outstanding — debt resurrection on a closed account has no recovery). Lock order verified acyclic vs postOneBill (account→plan→bill: it never takes payment locks) and day-close (staff→payments only).
- I2 membership is now a STORED fact: payment.day_close_id column + (tenant,day_close_id) index — migration 20260918210000_payment_day_close_id applied+registered on watersaas+watersaas_test (sha256 checksum). closeTx order: sweep → totals → INSERT close → guarded flip stamping dayCloseId → count assert. GET /:id reads members by dayCloseId — the closedAt-boundary reconstruction was deleted (closed_at = transaction_timestamp() marks tx START, so straddling commits could misattribute members).
- I3 reversal attribution: cashierId/orgUnitId copied from the ORIGINAL payment (+/− pair nets in that cashier's drawer sequence); createdBy keeps the actor.
- Minors: byChannel buckets derived from Object.values(PayChannel); close member rows normalized camelCase in POST+GET; reverse idem hashes req.body (same-key different-body → 409, parity with create); assertCents rejects non-safe-integer numbers; createTx docblock notes SUSPENDED/CLOSED payments permitted (CLOSED has no payable bills → natural 409s).
- e2e +4 → 21/21: C1 worked example (6000 paid → replace → credit 6000/net 2000 → reverse → credit clears), I1 closed-account 409 + no-write, I2 dayCloseId stamped + straggler lands only in next close, I3 cashier-reverses-admin → original's attribution + absent from actor's list, reverse idem replay+conflict, unsafe-integer 400.

### T12 DONE — 收款/销账/收据/日结 (feat d14d7ef + fix a807a85 + nit, e2e 204/204)
- Payment create: one tx sorted-bill FOR UPDATE → payable gate → payment+allocs+receipt+P/R seq → status recompute; alloc≤outstanding, Σ=amount; idem atomic.
- Reversal APPEND-ONLY: original never flipped (RECEIVED pair nets in own close; DAY_CLOSED immutable); new −amount payment (cashierId/orgUnitId=ORIGINAL's — drawer truth), mirror −allocs, receipt voided, bills recomputed. REVERSED enum vestigial.
- Day close: staff-row lock serializes; sweep RECEIVED received_at≤closeDate (stragglers roll forward); close row first then guarded flip stamps payment.day_close_id — membership is a stored fact, not reconstructed.
- getOutstanding port: Σ(total−Σallocs) over DRAFT|POSTED|PARTIAL_PAID non-REVERSAL + alloc term spans REVERSED bills (paid-then-reversed → blocking credit). Probe endpoint mirrors minus DRAFT + surfaces reversedBillCredit.
- Data-integrity review (explore): NEEDS_FIXES → C1 probe dropped REVERSED-bill credit (cashier over-collects), I1 reverseTx no account lock → CLOSED debt resurrection (now payment→accounts→bills lock + 409), I2 membership reconstruction inexact under tx ordering (day_close_id column), I3 reversal attribution to original cashier. All fixed + verified in re-review; residual: index map name + docblock (fixed this commit).
- Known same-class residual (follow-up, documented): bill.reverseTx on a NEGATIVE bill (ADJUSTMENT) can also resurrect debt on a CLOSED account — takes no account lock yet.
- Deviation notes: day-close not idem-wrapped (replay-safe by construction); receipt print = payment:write; over-payment/credit out of MVP scope (alloc≤outstanding).

### T13 DONE — reports + integration port stubs + audit coverage (this commit, e2e 218/218)
- New modules: `report` (report.service/reports.controller/report.module — TOP of chain, imports no feature module, direct tenant-scoped queries per module-local read convention) + `integration` (ports.ts, integration.module.ts) wired into app.module. Permission code `report:read` on all 5 endpoints — per-tenant permission rows minted via POST /iam/permissions (no central dictionary; e2e seeds its own).
- 对数 predicates documented on the service so every figure reproduces: billed = Σ bill.total_amount WHERE period=P AND bill_kind<>'REVERSAL' AND status∈(POSTED,PARTIAL_PAID,PAID) — DRAFT isn't debt, REVERSED original + REVERSAL-kind counter-bill both excluded so the red-flush pair nets zero. collected = Σ payment.amount WHERE received_at∈month AND status∈(RECEIVED,DAY_CLOSED) (REVERSED vestigial); allocated = Σ payment_alloc joined to the payment's received month ≡ collected by construction (Σ allocs = amount per payment, allocs can't span months) — both sides returned so drift is visible.
- meter-daily: one row per book that has ≥1 plan in the date's period OR ≥1 attributed reading that day; item status counts are the period-plan snapshot (read/noRead/pending/skipped + total, plans); readingsTaken = meter_reading read_date=date attributed via plan_item→plan→book (any plan period — late back-period reads still count as that day's work; plan_item_id NULL readings unattributable). Scoped callers get book.orgUnitId∈ctx.orgScope pushed into WHERE (out-of-subtree orgUnitId filter → empty, no leak). Other reports are tenant-wide — permissive-read convention, orgInScope lives on write paths.
- cashier-daily: received_at::date group by cashier×channel, all PayChannel buckets 0-filled, reversal nets negative; closed = cashier_day_close exists on that close_date. recovery-rate: single-month default; `through` (must be ≥period) → cumulative billed period≤T / collected < first day of T+1; rate = Decimal toFixed(4) string, billed=0 → null.
- Raw-SQL gotcha caught by e2e: sum(bigint)→numeric→Prisma returns Decimal, not BigInt (string-concat bug '0'+'6000'+…). Fixed with ::bigint (::int for count) casts on every aggregate — convention for future raw sums.
- Integration stubs: ports are abstract classes doubling as DI tokens (FinancePort convention — a TS interface can't be a provider token; task "interfaces" satisfied via abstract-class contract). StubSmsPort/StubPaymentChannelPort/StubSmartMeterPort/StubReportInstallPort all throw NotImplementedException 501 {code:'NOT_IMPLEMENTED',port} — never silently succeed. FinancePort NOT redeclared — real one stays at customer/ports/finance.port.ts bound to BillingFinancePort; consolidation documented as a comment (moving churns CustomerModule wiring for zero gain). Unit smoke ports.spec.ts (4 tests) verifies tokens resolve + stubs throw.
- Audit coverage verified, no code needed: global AuditInterceptor covers every POST/PUT/PATCH/DELETE — T12 write paths (POST /payments, /payments/:id/reverse, /receipts/:id/print, /cashier-day-close/close) confirmed producing audit_log rows in watersaas_test; all 5 report endpoints are GET → read-only, nothing to audit. Pre-existing: intermittent "audit_log write failed" noise under parallel e2e files — best-effort interceptor by design, never fails the request.
- e2e test/report.e2e-spec.ts 14/14 (t13- prefix): meter-daily counts+filters+late-read attribution+scoped subtree, cashier-daily netting+closed flag, ar/collected monthly predicates, recovery-rate 0.5000/0.4320/null math, tenant-B empty, report:read vs billing:write 403 split, 400 param matrix. Unit 5/5. Build+lint clean.
- Deviations: output shapes are bare arrays/objects matching list-endpoint convention (no meta wrapper — none exists); meter-daily also includes books with same-day readings but no period plan (truthful "that day's work"); `plans` counter added per row for context.

### T13 DONE — 报表 + integration stubs (feat 4772a2b + fix, e2e 218/218)
- 5 reports: meter-daily (per-book plan_item status snapshot + readingsTaken on read_date, org-scoped), cashier-daily (received_at::date, channel buckets, reversals net), ar-monthly (kind≠REVERSAL + posted-side — identical to reconciliation's POSTED_STATUSES predicate), collected-monthly (RECEIVED+DAY_CLOSED, allocated≡collected), recovery-rate (single/cumulative through, 4dp, billed=0→null).
- Integration: SmsPort/PaymentChannelPort/SmartMeterPort/ReportInstallPort abstract-token stubs → NOT_IMPLEMENTED 501; FinancePort stays at customer/ports (documented inversion).
- Task review APPROVED — all money predicates reconcile exactly vs write paths. Fixed O1 (readingsTaken counted superseded rows — valid-fact child-probe added) + O7 (T13-consolidates doc drift). Documented semantics: item statuses are as-of-now; cancelled-plan items stay PENDING (regenerate double-counts plans, known); cashier-daily unscoped like all list reads.
- Raw-SQL convention learned: `sum(bigint)`→numeric→Decimal — always cast `::bigint`/`::int` (they caught it via e2e).
=== T14 done ===
a19c2a4 + 352d87f review fixes (scoped org trees/roles PUT guard/logout race/UX). 219/219 e2e.

## T14–T15b web (sessão 2)
- T14 `a19c2a4` + review fixes `352d87f`: scoped org trees (parentId outside orgScope = root), roles PUT permsTouched guard, logout epoch race, dayjs timestamps, perm-gated routes, audit-logs endpoint + page. e2e 219/219.
- T15a `d99cba8` + review fixes `f6bdaef`: customer domain pages (customers/water-accounts/onboard/settle-accounts/meters). cleanPatch null-clear semantics, GET /meters?q= added, picker label cache.
- T15b `aa80e35` + review fixes `daccd81`: metering/settlement pages (books/plans/readings+QC+import/settlements/reconciliations). API: meter-reading list/get hydrates supersededById. Committed-filter inputs, stale guards, resync-on-fail.
- Padrões web: Idempotency-Key per form-open; validateFields try/catch; next-page-when-full pagination; fmtCent cents-as-string; pickers remotos com label cache.
- T16 em andamento (f77326d3): billing/payment/report pages + aceite.

## T16 + 终审 (sessão 2 收尾)
- T16 `c0abe94` + review fixes `3ddffe8`: billing/payment/report 全部页面（资费阶梯编辑器/开账批次/账单/收费台/收款记录/日结/5 报表）+ 真实冒烟通过。
- 终审 `1744ddb`（SHIP-WITH-NITS → 全部修完）: orgs POST 幂等、ALL-scope 列表不再用冻结 orgScope、seed 补 11 权限码+角色绑定、13 个缺失错误码标签、移除未用 Redis/@ws/types、根 README。
- 全分支: 40 commits, 193 files, +48k。验证: web/api lint 0/0, pnpm -r build 绿, e2e 219/219（单跑；全量跑有已知并行套件 flake）, billing-core 63/63, api 单测 5/5。
- 已知留档: 并行 e2e 套件共享测试库偶发 flake（每个 spec 单跑皆过）; REPLACE-of-REPLACEMENT 误报 422（病态场景，fail-closed）。

## RC Gate (sessão 2 终)
- Gate 1 fresh install ✅: watersaas_rc 空库 migrate deploy + seed (2t/22p/36 policies)
- Gate 2 prod mode ✅: node dist/main (NODE_ENV=production, RC DB) + vite preview :4173 + /api proxy (vite.config 补 preview.proxy)
- Gate 3 happy path ✅: login→资费→onboard→册→计划→读数→QC→结算→开账→欠费→收款→收据→日结→报表, 金额链 3600 分全程一致 (/tmp/happy-path.mjs)
- Gate 4 flake → docs/known-issues.md (无 remote 无法建 GitHub issue)
- PR body → docs/PR_DESCRIPTION.md; remote/gh 缺失, PR 待建
- RC servers: api :3000 (rc-api shell, prod mode on RC DB), web preview :4173 (rc-web shell)

## SHIPPED
- PR #1 merged (7b4a8c3, merge commit — 任务历史保留), 42 commits → main
- tag v0.1.0-mvp 打在 merge commit, 已推 origin
- local main 已 ff 到 origin/main; feat/mvp 冻结, 进入缺陷修复/增强迭代期

## E8 WaterAccount 360° — CLOSED (merge 062bba5)
- feat/water-account-360-v1: docs gate 3313c06 + impl 41780b3 + RC1 a10b26c + RC2 5f84396 + RC3 df2b133 → merged main @ 062bba5. Zero schema/migration.
- 交付: GET /water-accounts/:id/360 (customer:read 域 only) + :id/events + :id/payment-activity (D4 union, allocatedAmount-only) + waterAccountId filters (readings/books/plans); web 360 drawer 8 permission-gated lazy tabs; UAT e8 7/7.
- 更大成果: 读侧 org-scope 系统性收口 — water-accounts/customers/settle-accounts/outstanding/payments/bills/settlements/readings/books/plans/estimate 全部 list+detail+nested+explicit-filter 补齐 shared common/account-scope.ts; 之前这些读端点全部零 scope.
- RC 修复: outstanding 加 strict settle scope (shared-settle 跨所 403); transfer/create/onboard target-reference scope; payment-activity 窄 projection 去 payment.amount; MONITORING system principal 封闭对 (create/onboard/transfer/PATCH-category 四路径同 invariant, 半系统 400 SYSTEM_PRINCIPAL_NOT_ALLOWED).
- 测试卫生: e2e 测试库跨 run 累积 → take=200 首页断言溢出, 改 RUN-scoped name/customerId/q 过滤 (account-360/customer/remote-source specs). 并行 e2e --maxWorkers=4 仍有 engine-empty 传输 flake, 隔离全绿.
- 验证基线: api e2e 445/445 clean, e8 spec 40/40, UAT 7/7, build/lint 0.

## 阶段切换: Pilot Hardening → E9/E10 (未冻结)
- 路线共识: v0.2.x 县域核心能力已齐 (E6 prepay/E7 meter lifecycle/E8 360 + remote reading + 主链路), 下一步不直接开 E9 功能, 先 Pilot/准真实闭环 (立户→装表→抄表→QC→结算→出账→预存→收款→日结→换拆表→销户→360 全史), 用真实卡点冻结 E9.
- 暂定: E9 = Exception Center / Operational Work Queue V1 (从 object center → "今天该处理哪些户"); E10 = Operations Dashboard/Reporting V1 (必须复用 E6–E8 SoT, 不另造统计口径). GIS/APP/DMA/复杂 IoT 继续后置.
- Pilot 输出规范 (冻结前沉淀三类): (a) 业务闭环结果 — 每条核心流程完成率+失败原因; (b) 异常样本集 — 频率+人工处理方式 (决定 E9 Exception Center 优先级, 不是所有 warning 堆列表); (c) 操作效率数据 — 高频操作点击数/录入字段数/耗时.
- 待验证业务假设: 共享 settle 的 strict scope (E8 RC1) — 真实水司是否普遍存在"一个结算户跨多所管理+营业员局部查看"; 若大量存在, 正确方向是显式化共享结算户的业务归属模型, 而非放松读 scope.

## E9/E10 Gate Drafts 已起草 (docs only, 待用户审)
- docs/product-map/E9_EXCEPTION_CENTER_V1.md — Product Gate: 异常目录 (推导型, 13 类分 badge/queue), severity {BLOCKING,WARNING} deterministic, work item 状态建议 {OPEN,ACK,RESOLVED,IGNORED}+RESOLVED_AUTO, scope 全继承 E8 覆盖链.
- docs/product-map/E9_EXCEPTION_CENTER_DOMAIN_DESIGN.md — detector 纯查询推导 + work_item 唯一新表 (anomalyKey 唯一约束=去重), reconcile 生命周期, RESOLVED_AUTO, key 语法 wa:/bill:/reading:/event:...
- docs/product-map/E10_OPERATIONS_DASHBOARD_V1.md — Draft: 固定指标卡+drill-down, 复用 5 个既有 report 端点, 禁前端算术.
- docs/product-map/E10_METRIC_DICTIONARY.md — 19 指标口径登记, 每条 SoT/时间/CLOSED/REVERSED/分母; 悬案: shared-settle scope 归属, REMOTE_ONLINE_RATE 无心跳字段只有 event 流.
- 顺序: E9 Gate 审 → Pilot 反馈 → 冻结 E9 → 实现; E10 字典先行, 等 E9 稳再冻结. 未写任何实现代码.

## E9/E10 Gate 收口 (Rev4 @ 1d80460)
- E9 Product+Domain Gate: PASS → 可开 feat/exception-center-v1. Rev4 冻结: 三件套分离/episode+partial unique/fact-driven RESOLVED(409)/off-book TENANT ownership/remote anchor 无自由度/KEY_CONFLICT occurrence=currentIssueAt(碰撞备用 RemoteEventProcessLog.id)/QC anti-supersede 用 child.supersedesReadingId.
- E10 Product+Metric Gate: PASS; Implementation HOLD 等 Pilot (RECOVERY_RATE 分子/ESTIMATE_RATE 分母/REMOTE_ONLINE窗口/READING_MISSING阈值/shared-settle ownership/历史归属需求).
- E10 冻结: ACCOUNT_AGGREGATION_OWNERSHIP≠read scope (BookMeter=0→tenant UNASSIGNED, branch 不计); current-portfolio view; BILLED 加 billKind≠REVERSAL; GROSS_BILL_RECEIVABLE=Σmax(remaining,0) 全 alloc source; signed-money.
- E9 Impl Plan: docs/product-map/E9_EXCEPTION_CENTER_IMPL_PLAN.md (T1 schema→T9 测试, 9 任务序列). Impl Gate 三盯点: partial unique+reconcile 并发 / off-book TENANT / remote replay episode.

## E9/E10 落地收口 (main @ b76c33b)
- E9 = CLOSED: Exception Center V1 已 merge (03e32b4)。13 类 detector + episode 工作队列 + type-first remote anchor (UNBOUND/KEY_CONFLICT 永 REMOTE_SOURCE) + exception-scoped options API + todayAdded/todayCleared。RC2 Gate PASS, 487/487 e2e + 10/10 UAT。
- E10 Foundation = MERGED: Operations Dashboard foundation 已 merge (b76c33b, 双父 03e32b4+ad988fe)。冻结指标落地 (AGG_OWN / CASHIER_COLLECTED / TERRITORY_DEBT_COLLECTION / GROSS_BILL_RECEIVABLE / CURRENT_PORTFOLIO_VIEW)；scoped legacy report 已 fail-closed (recovery-rate scope≠ALL → 403 REPORT_SCOPE_UNDEFINED)。
- E10 Product Epic = PILOT HOLD: RECOVERY_RATE / ESTIMATE_RATE / REMOTE_ONLINE_RATE 三指标刻意不返回数值，等 Pilot 决策。
- 下一阶段: Pilot Cycle 1（非 Epic）— 真实/准真实数据跑 1–2 完整账期，观察 E9 命中/误报与操作员路径，用 scripts/pilot/evidence.ts 采集三个 HOLD 指标候选数据，做 scope/accounting/audit hardening，最后 Pilot Decision Gate → PASS / HARDENING REQUIRED / BLOCK。
- 纪律: 无 P0 安全问题不改模型不加功能，业务卡点先记 evidence。

## 10·8-9 测试报告修复 + 需求分期 (requirements-2026-10.md)
- 测试报告 8 条裁定: 6 真缺陷 / 1 半误解 (实收月报口径无 bug, 加空态文案) / 1 新能力方向 (待办徽标→T 批). 需求文档另立 5 批路线图 (R 修复 / T 工单 / G schema 先行 / A-C 查询字典 / B-D 报表权限).
- 第 1 批 (bdd86a4, 已推送未部署): R1 账单页 uuid 筛选→户号/结算户/批次选择器; R2 收款记录结算户+收费员+红冲/日结引用 API 内嵌人读化; R3 抄表册/计划组织+抄表员后端内嵌 (绕 iam:read); R4 水表口径 AutoComplete; R5 代日结 cashierId ('*' 权限门槛+弹窗明示+经办人列); R6 READING_PENDING_QC 新错误码 (未质检读数单独报因); R7/R8 全站 uuid 残留收口 (台账/补差/分摊/批次失败明细户号化).
- 测试日期漂移类 bug 再修: billing spec installedAt/openedAt 钉 2026-01-01; remote-pipeline onboard installedAt 钉死 (CONVERTED→UNBOUND 翻转).

## 第 2–5 批实现完成 (待统一部署测试, 未 commit)
- 迁移 20261010120000: PayChannel+ONLINE/BANK_DEDUCT; FeeItemKind (fee_item.kind 默认 WATER_FEE); sys_dict + bad_debt_writeoff 两表带 tenant RLS.
- T1–T3: 4 类新 detector (读数 QC 四态/远传未绑/欠费账龄/估抄连续) + GET /exceptions/badge 按域 OPEN 计数 + 前端导航徽标 + 异常中心"去处理"跳转.
- G1/G3: 费用项分类 (水费/代收/其他, 综合单价=水费收入口径) + 渠道中文标签全站.
- C1: metric-dictionary.ts v2026-10.v1 — 25 指标口径固化, 无数据源指标 available:false+reason (不静默返 0); GET /reports/metric-dictionary.
- A1–A5+F1: 5 查询端点 (accounts/usage-details/bills/payments/arrears) + 对应 /export 真 xlsx (exceljs), JSON/xlsx 同一查询路径, EXPORT_ROW_CAP 护栏, 导出写 audit_log (请求内 await, 含行数). 归属过滤复用 AGG_OWN (BookMeter→ReadingBook, off-book 仅 ALL 可见).
- B1–B3: analysis-daily/monthly/yearly, byOrg/byBook 分组, 年报含 trend+同比+BAD_DEBT_WRITEOFF; 前端 Analysis.tsx 三页.
- G4: GET/POST/PATCH /iam/dicts (iam:* 权限, 查询放行 report:read+payment:read) + seed 默认 WRITEOFF_REASON/REVERSAL_TYPE/AGING_BUCKET 字典; Dicts.tsx 管理页.
- G2: /writeoffs 登记+列表+reverse (原因必须是 ACTIVE WRITEOFF_REASON 字典项, 否则 WRITEOFF_REASON_INVALID); 核销为登记层不动应收 (财务不变式); A5 欠费输出 writtenOff 列; 年报 BAD_DEBT_WRITEOFF 仅计 ACTIVE; Writeoffs.tsx.
- D1/D2: report:read 统一门槛 + AGG_OWN scoped 口径 + 柜台归属 (收款按收费员 org).
- 踩坑记录: /payments/writeoffs 被 /payments/:id 吞掉→移 /writeoffs; PG 关联子查询引用外层分组列→拆查询 JS 合并; lateral 别名 bm 无 tenant_id→暴露列; sum() numeric→BigInt 混算→全量 ::bigint; Prisma 引擎空响应为并行 e2e 连接池抖动, 顺序跑全绿.
- 验证基线: e2e 534/534, api build+nest build ✓, web build ✓, lint 0 错.

## Pilot 部署 4c9425f (2026-10-10) + E10 Playwright 巡检套件
- 部署拓扑: api `node dist/main` :3000 (water_pilot_v012, 新 JWT_SECRET) + `vite preview` 0.0.0.0:5185 → /api 代理. LAN IP 已变 192.168.3.17 (credentials.json lanUrl/release 已同步). 备份 backups/water_pilot_v012-pre-e10-*.dump.
- 关键发现: **water_pilot_v012 schema 停滞在 v02_feedback 前** —— 该迁移 9/19 就失败 (旧 usage_category 中文值阻塞) 且从未补齐; 之前"已部署 6305236"实际没跑在这个库 (无库接受轮换密码). 处置: 手工映射 4 个旧类别→RES_METERED/NON_RES → resolve --rolled-back → 19 迁移全部应用 → migrate diff 零漂移 (仅 sys_dict/bad_debt_writeoff 的 id DB 默认值差异). admin 密码按 credentials 轮换 (写 hash 用 SQL 文件, shell 会吞 $).
- seed 不能全量跑 (会把 admin 密码重置回 admin123) → 字典/费用项分类走定点 SQL.
- 上次"清测试数据"清的是 dev 库 watersaas, 不是 pilot —— pilot 的 9/19 p20260919a 数据仍在 (44户).
- 新套件 `tests/e10/` + `playwright.e10.config.ts`: 36 用例全绿 —— 页面巡检×20 (无5xx/无裸uuid) + R1选择器/G1分类/G3渠道/R5代结/T2徽标/C1字典 控件级 + A1查询导出xlsx+审计留痕/B2/B3/G4字典增停启/G2核销登记撤销/A5 writtenOff/异常badge.
- antd 测试要点: Select placeholder 在 .ant-select-selection-placeholder; 双字按钮自动插空格 (停 用); Switch 是 button.ant-switch; 下拉退场动画会让 :visible 匹配旧面板 → Enter 选高亮项最稳.
- smoke: deploy/smoke.mts 32 checks 0 unexpected (Chrome 需 --no-proxy-server 绕系统代理).

## G1–G5+S1 批次 + 抄表 H5 + 决策层报表改版 + N1–N6 (2026-10-16 → 10-18, pilot 86cb7ac)
- G1–G5+S1 (bb69f31/bfd3b37): G1 违约金计提口径弹窗; G3 渠道对账（mock 对账单粘贴→核账批次→差异计数, POST /payments/recon 子路由曾遭 @Get(':id') 遮蔽→子控制器前置); G4 催缴通知单生成+打印留痕; G5 票据台账（收据号段领用/发票登记作废, 收款自动占号）; S1 报装独立域（申请→勘察→审批→装表→归档立户, 归档复用 parseOnboardWire 自动带客户/新建表, 用水类别对齐 USAGE_CATEGORY 枚举）。
- 抄表工作台 H5 (66977e7/39bd853): /m/reading 裸路由（不进 AdminLayout, 自带登录守卫+metering:write）, 计划选择器列 OPEN/IN_PROGRESS 且 reader=我/未指派, 待抄队列按 seqNo 排序, 户卡回填 accountNo/customerName/addr/meterNo（embedItemReadings 扩展, 桌面端同受益）; 复用 POST /meter-readings source=APP + Idempotency-Key, ACTUAL/NO_READ 两分支, QC/复核规则零复制。坑: crypto.randomUUID 在非安全上下文(内网 http)undefined→白屏, 改安全回退 newIdemKey()。
- 决策层报表改版 13 项 (37b2852/2fbb8c7): Q1 统一查询明细/汇总双 Tab + summary-trend 年度聚合+同比+维度(ALL/ORG/CATEGORY)+图+导出; Q2 指标查询页(搜索/定义/公式/当前值/近N期); Q3 核实非缺陷(导出路/上限/审计俱全); R1-R5 月报三层(KPI卡→echarts→规范表 21 指标)+勾选模板(tenant_param report.metrics.monthly)+年报分月合计; R6 company.name 租户参数; R7 orgUnitId 收费按 payment.org/水量账单按户→册归属+子树∩caller scope fail-closed; H1/H2 驾驶舱五区+/iam/my-prefs 个人视图(staff_pref 新表带 RLS)。窗口化指标引擎 metricsWindow(from,to,orgIds) 复用字典口径。
- N1–N6 规范化 (86cb7ac): '/'=驾驶舱+'/workbench'=工作台拆菜单(无 report:read 自动重定向); 工作台四组模块卡(任务监控/业务办理/报表分析/系统管理+角标); '结算补差'→'结算管理'; utils/numfmt.ts 统一 fmtCent(¥千分位)/abbrevCN(万亿)/columnScale(整列统一单位); TrendChart 轴自适应; report.amountUnit 租户参数(元/万元)贯穿 meta/规范表/导出。
- 部署注意: shared/compose.env 的 MIGRATION_DATABASE_URL runtime 指向受限 ws_app(无 public CREATE)——migrate deploy 必须显式传 owner 串(-e MIGRATION_DATABASE_URL=postgres://...); releases 目录按完整 sha 命名; api:3000 无 /v1 前缀, nginx 剥 /api 前缀。
- 验证基线: API e2e 580+12(ops-report spec), e10 Playwright 41/41, web/api build ✓; 冒烟走 SSH 隧道 127.0.0.1:5185→192.168.3.185:5185(本机不在 pilot LAN)。
- 公网勘误: water.manqiaotechnology.com→175.152.66.12 是另一套系统(A0xxx 数字错误码, 全路径 401), 与本项目无关; 试点仅内网 http://192.168.3.185:5185。

## 抄表 H5 v2 + 表底 OCR 识别 (2026-10-19, pilot 4710762)
- H5 v2 (fc224ab/d309d02): 查表顺序模式/重抄(supersede)/漏抄即待抄队列/搜索定位(户号·客户·地址·电话·表号)/拍照压缩上传/离线 localStorage 队列+幂等键/水表信息抽屉(口径·类别·上期止度)+现场联系信息 PATCH /water-accounts/:id/field-contact(白名单3字段,审计)/抄表统计抽屉; 强制拍照: 非户表必拍+非正常查表必拍(前端校验,服务端未硬拒以兼容旧数据)。
- 表底识别 `POST /meter-readings/recognize` (metering:write, body {image:base64}): **纯传统 CV 不调大模型** — sharp 预处理→强圆判别(≥6 → 指针表)→字轮带检测+列向墨聚类窗口→tesseract.js 数字白名单(SPARSE_TEXT/SINGLE_LINE 双 psm × norm/negate/暗带gamma)→红轮小数边界(放宽 maroon 红+带纵向2.6×扩扫); 指针路径 Hough 圆(750px降采样)+径向暗像素角度采样+左列×1/×10/×100/×1000 组合。返回 {value,confidence,method,details,message} **仅参考不落库**, H5 预填+置信度提示人工核对。METER_OCR=off 关停。
- tessdata: `apps/api/tessdata/eng.traineddata`(tessdata_fast 4MB) 已提交随源码进镜像, `langPath` 本地+`gzip:false`+`cacheMethod:none` 运行期零网络; TESSDATA_DIR 可覆盖。
- 三类表实测: 混合字轮"0088+红7"→89(conf42,decimal_wheel_dropped); 暗光混合"00062"→9008(conf0 自动标低); 全指针8盘→300(conf53 POINTER_INFERRED_LAYOUT)。末轮半转/暗光为固有难点, 全部走人工核对兜底。
- 验证: 单测 9/9 + ocr e2e 5/5 (401/400/403/合成图/乱码兜底), 全套 e2e 587+5, e10 40/41(1 消耗性跳过), 线上三图实测 5-8s/张。
- 分支 feat/mobile-reading-v2 已推送未合 main (菜单顺序 09fcdd4 + H5v2 + OCR 同分支)。

## 2026-10-19 表底 OCR 重构：PaddleOCR PP-OCRv6（浏览器本地推理）
- 原因：自研 Tesseract/CV 管线在暗光字轮图上输出 `8`/`908`（真值 00062.825），不可靠。
- 方案：`@paddleocr/paddleocr-js@0.4.2` + PP-OCRv6 small det/rec ONNX（非大模型）。
  模型 tar(det-v6.tar/rec-v6.tar)+ort wasm/.mjs 打进 `apps/web/public/`，内网零外网依赖。
- 解析层 `apps/web/src/utils/meter-ocr.ts`：纯数字框行聚类、逐字条带暖色(mean r-g>0)截断红轮小数、
  4-6 位长度门（串号 >6 拒绝）、散布小数字框 ≥8 判为指针表返回 null → 回退服务端指针路径。
- vite.config.ts dev 中间件直发 /ort、/ocr-models（绕过 public 导入限制）。
- nginx.conf 加 /ort/ 与 /ocr-models/ location：.mjs 发 text/javascript（默认 octet-stream 会被
  动态 import 拒绝）。deploy/ 资产（Dockerfile/compose/nginx.conf）本次起入库 git。
- 线上实测三样片（57de6dc）：00062→62(99%)、0088→88(91%)、全指针 null→服务端兜底。
- e10 移动抄表 spec 过；window.__meterOcr 诊断钩子可 console 直调。
