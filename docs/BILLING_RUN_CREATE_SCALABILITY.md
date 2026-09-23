# BillingRun createTx — Scalability Design (P1, post-G6 hardening)

Status: **design for adjudication — no code changes yet**
Source finding: G6 full-profile evidence (`docs/PILOT_CYCLE_1A_REPORT.md`)

## 1. Problem

`BillingRunService.createTx` generates **all** DRAFT bills for a period
in ONE Prisma interactive transaction:

```text
findMany FINAL settlements (period)
  → for each settlement, serially:
      account-facts lookup
      already-billed probe
      pickPlan / loadFeeItems / ytdBeforeQty
      lockPlanForUpdate (T8 freeze)
      bill.create + feeItemIdMap + insertBillItems
```

≈ 8 queries × N settlements, serial, inside one interactive tx bounded
by Prisma's 5 s default timeout (`TenantPrismaService.runAsTenant`
passes no options).

Observed (G6, local PG, watersaas_pilot):

```text
500 settlements   PASS   (~2–4 s)
1000 settlements  FAIL   "Transaction already closed … 5000 ms"
4000 profile      unreachable without harness timeout
```

The pilot proved the business logic + data model are correct at 4000
accounts under a widened budget — it did **not** prove the production
transaction envelope supports it. A real tenant above ~800 settlements
per period cannot create a billing run today.

## 2. Frozen contract to preserve

Pinned by `billing.e2e-spec.ts` + class docblock; all must hold:

- `POST /billing-runs {period}` → **201 synchronous** response:
  `status='DRAFT'`, `totalCount`, `successCount` (already-billed count),
  `failedSettlementIds[]` (stage 'generate' records), `bills[]`.
- Per-settlement failures are **records, never aborts**
  (`TARIFF_NOT_FOUND`, `FEE_ITEM_NOT_FOUND`, `WATER_ACCOUNT_NOT_FOUND`,
  engine `DomainError`s); unexpected errors abort the request loudly.
- `billable=false` (MONITORING) settlements: skipped, outside the
  denominator entirely.
- Already-billed (any run's NORMAL bill, any status): skipped as
  success; `UNIQUE(tenant_id, source_type, source_id, bill_kind)` is the
  idempotency backstop; a lost unique race = resolved, not a failure.
- Two DRAFT runs over one period: accepted operator-serial edge.
- `discard`: DRAFT-only teardown (run + DRAFT bills), period re-runnable.
- `post`/`retry` (execute): claim tx → per-failure retry tx →
  per-bill post tx → finalize tx. Unchanged.
- `createTx` stays TX_CALLER_MANAGED in the registry; callers wrap.

## 3. Options

### A — Raise the interactive-tx timeout (minimal, interim)

Add an options param to `runAsTenant`/`$transaction` (e.g.
`{ timeout: 60_000 }`), applied at the create call site.

- Pros: smallest diff; unblocks immediately.
- Cons: does not fix the shape of the problem — one unbounded serial
  loop inside one tx; every scale-up re-hits the wall; long tx holds
  locks/snapshot longer; masks rather than bounds the work.
- Verdict: acceptable **temporary** hardening; not the fix.

### B — Bounded-batch multi-tx create (recommended)

Mirror the `execute` pattern (claim → per-batch tx → finalize) instead
of one unbounded tx. Synchronous in-request, same response shape.

```text
TX0  claim/create:
       insert billing_run {status:'DRAFT', totals:0, failures:[]}
       snapshot FINAL settlement ids for period (ordered, in memory —
       4000 uuids is trivial)

LOOP  batches of B settlements (default B=200, env-tunable):
  TXk  per batch:
       loadAccountFacts(batch)               — 1 query
       for each settlement in batch:
         billable=false            → skipped++
         already-billed probe      → success (skip)
         generateBillForSettlement → bill+items
         RecordedFailure/DomainError → accumulate failure record
         unique violation          → success (skip)
         unexpected error          → abort request loudly
       (each batch ≈ 8×200 queries — comfortably under any budget)

TXN  finalize:
       recompute from committed truth:
         totalCount    = settlements − skipped
         drafted       = count(bill where billingRunId=run)
         successCount  = totalCount − failures − drafted   (unchanged formula)
         failedCount   = failures.length
       update run row
       return withBills(run)
```

Cost model: 4000 settlements → ~20 small txs ≈ same total wall time as
today (~60 s observed incl. post), each tx far below 5 s.

### C — Async create (202 + worker / BullMQ)

Returns run id immediately; generation progresses in background.
Correct long-term shape for very large tenants, but changes the API
contract, needs a worker the project deliberately doesn't have yet
("MVP execution note" in class docblock), and expands blast radius.
Deferred — do not conflate with this fix.

**Recommendation: B now; optionally A as a stopgap if B's review
findings block.**

## 4. Option B — decisions needing adjudication

### 4.1 Concurrent post during generation

Today atomic create makes this race impossible; multi-tx introduces a
window where the run is DRAFT with partial bills and a concurrent
`post` could claim it (DRAFT→PROCESSING) and finalize over an
incomplete bill set — leaving post-generation inserts stranded as
DRAFT under a finalized run.

Options:

- **(i) Documented operator-serial edge** — same carve-out already
  accepted for two DRAFT runs over one period ("operator-serial in
  practice; flagged rather than silently handled"). Cheapest; risk is
  operator fires post while a create is still generating.
- **(ii) Generation marker, no schema change** — stage a
  `{stage:'generating'}` sentinel in `failedSettlementIds` at TX0,
  post/retry claim refuses runs containing it (409
  `RUN_STILL_GENERATING`), finalize removes it. Zero schema churn;
  slightly abuses a failure column.
- **(iii) Schema column** (`generationDoneAt` / `generateStatus`) —
  cleanest, but schema change → needs explicit approval per pilot
  rules.

Recommendation: (ii) if we want a real guard with zero schema churn;
(i) is defensible for the current operator-serial model. Decide.

### 4.2 Crash mid-create

Process dies between TX0 and TXN → DRAFT run with partial bills and
stale totals. Recovery path already exists and needs no new machinery:
`discard` (DRAFT teardown removes partial bills) → re-create →
already-billed probe absorbs any leftovers. Document it like the
PROCESSING-crash→retry rescue. To keep this airtight, finalize
(TXN) is the only place counts become non-zero; a mid-create run
shows `totalCount=0`, which is honest "still generating" state —
paired with 4.1(ii), post can also refuse it.

### 4.3 Batch size + boundary

Default `B=200`. Batches are pure slices of the TX0-snapshotted id
list — no `WHERE id IN pending` recompute needed (already-billed probe
keeps every batch idempotent anyway). Per-batch account-facts load
replaces today's single loadAccountFacts call.

### 4.4 Where the loop lives

`POST /billing-runs` handler: claim TX0 via `runAsTenant`, loop batch
txs via `runAsTenant` (each `createTx`-flavored private method taking
`(tx, ctx, run, batch)`), finalize TXN. `createTx` is replaced by
`create` orchestration + `generateBatch(tx, …)` — registry entries
updated accordingly (caller-managed stays caller-managed).

## 5. Same-class watch-list (not in scope)

`ExceptionService.refresh` reconciles all facts in one self-managed tx.
600 facts passed at G6; the ceiling is unprobed. Flag only — re-test at
Cycle 1B scale; do not preemptively batch it.

## 6. Verification plan (required before "P1 closed")

1. `billing.e2e-spec.ts` passes **unmodified** — response contract,
   counts, failure records, discard/post/retry all pinned.
2. New e2e: create over >800 FINAL settlements **through the production
   path** (plain `runAsTenant`, no harness timeout) → completes.
3. Production-path regression at pilot scale: 1000- and 4000-account
   `POST /billing-runs` equivalent — the harness `withTenantTxTimeout`
   workaround must become unnecessary and be removed.
4. Batch-boundary determinism: failure records identical regardless
   of which batch a settlement lands in.
5. Crash-rescue: abort mid-create → discard → re-create → identical
   final bill set.
6. If 4.1(ii): post during generation → 409 `RUN_STILL_GENERATING`.
