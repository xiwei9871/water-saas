# Independent Release Candidate Audit — `feat/mvp` vs `main`

**Auditor role**: independent RC reviewer (not the implementer). Read-only audit —
no product code was modified. All findings were reproduced against a live
production-mode deployment (`node dist/main`, `vite preview`) backed by a fresh
migrated+seeded PostgreSQL database (`watersaas_rc`), using attack scripts kept
outside the repository (`/tmp/audit-*.mjs`).

**Scope of evidence**: every claim below is backed by an executed HTTP request,
SQL query, or direct code-path citation. Nothing is reported on speculation.

---

## Executive Summary

The release candidate is **structurally sound**: tenant isolation holds under
live attack at both API and RLS layers, money is conserved across every tested
path (payments, allocations, reversals, day closes, reconciliations), and all
concurrency probes serialized correctly. Zero Critical findings.

Three **Important** defects were found by actively constructing the scenarios
the spec calls out — none corrupt existing data, but each is a realistic
workflow that either blocks a core operation, silently loses billable revenue,
or breaks fresh deployment on non-default infrastructure:

| # | Finding | Area |
|---|---------|------|
| I-1 | Reconciliation anchor lookup fails ~50% of same-day reading pairs (`ANCHOR_NOT_FOUND`) — random-UUID tiebreak used as a chronological comparator | billing / calibration |
| I-2 | Meter removal dated into an already-FINAL/billed period silently discards billable usage | customer / metering |
| I-3 | Init migration hardcodes `GRANT CONNECT ON DATABASE watersaas` — deploy fails on clusters without that literal DB name | deployment |

**Recommendation: `SHIP-WITH-FIXES`** (Critical = 0, Important = 3)

---

## Critical findings

None.

## Important findings

### I-1 — Reconciliation `anchorBefore` uses random UUID as intra-day tiebreaker → `ANCHOR_NOT_FOUND` on ~50% of same-day reading pairs

- **Severity**: Important
- **Location**: `apps/api/src/modules/billing/reconciliation.service.ts`, `anchorBefore()`, lines 736–762.
- **Trigger**: two trusted (ACTUAL/REMOTE, QC PASSED, non-superseded) readings on one account sharing the same `read_date` — e.g. both entered today with the default `read_date = now()`, or back-dated to the same day — where the earlier/lower-period reading's UUIDv4 sorts *after* the actual's.
- **Observed**: water account `a725416d` holds PASSED ACTUAL readings `db309894` (1000 @ period 202901) and `a8e8403d` (1080 @ period 202904), both `read_date = 2026-09-19`. `POST /reconciliations {waterAccountId}` → **404 `ANCHOR_NOT_FOUND`**, reproduced identically via `latestTrusted` and via explicit `actualReadingId`. The pair can never be reconciled — the +15 m³ calibration for that account is permanently unreachable until a reading lands on a different `read_date`.
- **Expected**: the anchor is the trusted reading immediately preceding the actual chronologically. With `read_date` at day granularity the predicate must order by something chronological (`period`, `created_at`, or entry sequence), not UUID.
- **Root cause**: `WHERE ... readDate < actual.readDate OR (readDate = actual.readDate AND id < actual.id)` with `orderBy readDate desc, id desc`. `id` is `gen_random_uuid()` (v4, random) — verified: third group `4xxx` on every row. Same-day ordering is a coin flip: account `2a1de518` (anchor `86e1…` < actual `e280…`) reconciled fine in the same run; account `a725416d` (anchor `db30…` > actual `a8e8…`) cannot.
- **Business impact**: the spec's core 补差 workflow — estimate periods corrected by a new actual read — fails closed ~half the time precisely in the most common data-entry pattern (meter reader enters a stack of readings in one sitting, all stamped today). No wrong data is produced, but affected accounts can never receive their adjustment → persistent under/over-billing.
- **Evidence**: live reproduction twice (script `/tmp/audit-recon.mjs` run 2; `/tmp/recon-confirm.mjs` deterministic replay → `404 ANCHOR_NOT_FOUND` both via implicit and explicit actual); counter-example account reconciled `ABSORBED` in the same batch proving the only variable is UUID ordering; `meter_reading` rows verified PASSED/ACTUAL/non-superseded in SQL.
- **Suggested direction**: compare `(readDate, createdAt)` or `(period, createdAt)` tuples instead of `id`, or use a monotonic sequence column for intra-day ordering.
- **Confidence**: High.

### I-2 — `removeTx` accepts meter removal dated into a FINAL/billed period → billable usage permanently lost

- **Severity**: Important
- **Location**: `apps/api/src/modules/customer/meter-installation.service.ts`, `removeTx()`, lines 157–203.
- **Trigger**: `POST /meter-installations/:id/remove` with `removedAt` inside a period whose `consumption_settlement` is already `FINAL` (or covered by posted bills).
- **Observed**: account with `FINAL` settlement for 203403 (estimate 60). `remove {finalReading: '999', removedAt: '2034-03-15'}` → **201 accepted, no warning**. The `999 − 60 = 939` unit delta is then unreachable: re-settling 203403 → `409 SETTLEMENT_ALREADY_EXISTS`; the next period has no installation → `400 NO_INSTALLATION_IN_PERIOD`. Nothing ever bills the 939 units.
- **Expected**: refuse (fail closed) when the removal's attribution period is already settled/billed — the same posture every other write in the codebase takes (`ACCOUNT_CLOSED`, `SETTLEMENT_ALREADY_EXISTS`, `TARIFF_FROZEN`), or at minimum flag the removal for manual review.
- **Business impact**: silent, permanent revenue loss. The books stay internally consistent (nothing wrong is recorded — something is simply *missing*), so it will not show up in any reconciliation report. A back-dated or delayed 拆表 entry is a realistic operator action.
- **Evidence**: `/tmp/audit-swap2.mjs` case (b) — removal 201, re-settle 409, next-period settle 400; `removeTx` source shows no period/settlement probe at all (only `status='ACTIVE'` guard + final≥initial).
- **Suggested direction**: in `removeTx`, resolve which settlement period `removedAt` falls into and 409 when that period's settlement is `FINAL` or has posted bills (same guard family as `postOneBill`'s CLOSED check).
- **Confidence**: High.

### I-3 — Init migration hardcodes `GRANT CONNECT ON DATABASE watersaas` → fresh deploy fails on differently-named databases

- **Severity**: Important
- **Location**: `apps/api/prisma/migrations/20260918045712_init/migration.sql`, line 945 (`GRANT CONNECT ON DATABASE watersaas TO ws_app;`), guarded variant at 952–957 only covers `watersaas_test`.
- **Trigger**: `prisma migrate deploy` against a cluster where a database literally named `watersaas` does not exist (i.e. any production database named `watersaas_prod`, `water`, etc.), or a hardened cluster where `PUBLIC` `CONNECT` has been revoked.
- **Observed**: `GRANT CONNECT ON DATABASE watersaas_prod TO ws_app` → `ERROR: database "watersaas_prod" does not exist` — the init migration aborts at line 945, deploy hard-blocked. On this dev cluster `watersaas` exists so the statement is a no-op *on the wrong database*; `ws_app` still connects to fresh databases only because PostgreSQL's default `PUBLIC` `CONNECT` grant covers it (verified: fresh `watersaas_fresh` had default `datacl`, ws_app connected and queried successfully).
- **Expected**: guard the grant with `IF EXISTS (SELECT FROM pg_database WHERE datname='watersaas')` (the same pattern used two statements later for the test DB), or document the manual `GRANT CONNECT` as a required deploy step.
- **Business impact**: fresh production deployment fails at the first migration on any environment that doesn't reuse the literal dev database name — exactly the "new production database" case the RC gate is meant to prove. It silently works today only by accident of Postgres defaults.
- **Evidence**: `migration.sql:945` unconditional `GRANT` vs `952–957` guarded `EXECUTE`; live `ERROR: database "watersaas_prod" does not exist`; `datacl` inspection on `watersaas_fresh` (no explicit ws_app grant — default PUBLIC covers it).
- **Suggested direction**: make the grant conditional on the target database existing, or replace with a documented post-deploy `GRANT CONNECT` step keyed off `DATABASE_URL`.
- **Confidence**: High (code path); Medium that a given production cluster trips it (depends on naming + PUBLIC hardening).

## Minor findings

### M-1 — Settlement can be created and finalized on a CLOSED water account

- **Severity**: Minor
- **Location**: `consumption_settlement` generate path (lacks the `ACCOUNT_CLOSED` guard that `reconciliation.createTx` and `postOneBill` both have).
- **Trigger/Observed**: `POST /consumption-settlements` on CLOSED account `0974e7b8` → 201 → `finalize` → 201 FINAL → billing run `post` → run `FAILED`, bill stuck `DRAFT` permanently (unpostable, unpayable, undeletable). Money boundary stays closed — DRAFT is not payable and `postOneBill` re-checks CLOSED — but the residue can never be cleaned up.
- **Expected**: `409 ACCOUNT_CLOSED` at create (and finalize), matching the sibling guards.
- **Impact**: inconsistent residue only; no funds move.
- **Confidence**: High (reproduced end-to-end).

### M-2 — `POST /cashier-day-close/close` accepts future `closeDate`

- **Severity**: Minor
- **Location**: `apps/api/src/modules/payment/day-close.service.ts` close path — no `closeDate ≤ today` validation.
- **Trigger/Observed**: on 2026-09-19, `POST /cashier-day-close/close {closeDate:'2026-09-20'}` → 201, sweeping all `RECEIVED` payments `≤ 2026-09-20` into a signed close dated tomorrow. This is incidentally the only recovery path for payments stranded after a same-day close (see N-2), but as a control it is loose — a cashier can sign a close for a day that hasn't happened.
- **Expected**: reject `closeDate > today` (or document future-dating as the intended straggler sweep).
- **Confidence**: High (reproduced).

## Nit findings

- **N-1**: `payment.status` enum retains vestigial `REVERSED` — never written (append-only semantics keep the original `RECEIVED`/`DAY_CLOSED`); the web UI already hides the option. Dead value in API filters/docs.
- **N-2**: Payments received *after* their cashier's same-date close stay `RECEIVED` until a later-dated close sweeps them — correct next-day-sweep semantics, but nothing in `GET /payments` or the day-close response signals "stranded, will land in a future close"; discoverable only via M-2's workaround.
- **N-3**: `latestTrusted`/`anchorBefore` order same-period same-day candidates by `id desc` — arbitrary but deterministic; harmless only because the visible failure is already reported as I-1.

## Existing accepted risks (unchanged — verified, not re-reported as findings)

1. Parallel e2e shared-DB flake — each spec passes standalone; infrastructure issue.
2. REPLACE-of-REPLACEMENT → conservative 422 (fail-closed direction).
3. JWT scope/disable frozen window ≤15 min — reproduced live: a disabled staff token still read `/customers` immediately after disable. Matches the documented bound.
4. Optional idempotency contract: a `POST` without `Idempotency-Key` can legitimately create duplicates — the web client always sends a per-form-open key (`Cashier.tsx:212`, `common.ts:84`), and key replay/mismatch semantics were verified live.
5. Account with zero plan-item bindings has no org anchor → permissive scope carve-out (in-code documented; write-path `orgInScope` guards verified live).

## Financial reconciliation result

**PASS — money conserved on every tested path.**

| Scenario | Result |
|---|---|
| Full payment of one bill | exact; outstanding → 0, PAID |
| Partial payment | outstanding reduced exactly; PARTIAL_PAID |
| One payment → multiple bills | allocates each, `amount == Σ allocs` enforced (mismatch → 400) |
| Multiple payments → one bill | serialized, status transitions correct |
| Over-allocation | 409 `BILL_NOT_PAYABLE` (locked remaining-outstanding check) |
| `amount ≠ Σ allocs` | 400 |
| Bill reversal | REVERSED original + POSTED REVERSAL bill; ADJUSTMENT(-3000) reversal → +3000 REVERSAL, debt correctly resurrected |
| Payment reversal | append-only negative payment + mirror allocs + receipt void; original keeps `RECEIVED`/`DAY_CLOSED` + close membership |
| Reversal after day-close | Day1 close immutable (total/membership unchanged), reversal swept into next close — verified cross-day via backdated `received_at` |
| Ledger check | `Σ payment_alloc` per bill nets to 0 after reversal (SQL) |
| collected-monthly vs SQL | exact: CASH 6 rows / 7000 incl. −1500 reversal netted; POS +1600/−1600 → 0 |
| cashier-daily | counts `RECEIVED`+`DAY_CLOSED`, negative reversal rows net in-channel |
| ar-monthly / recovery-rate | `REVERSED`/`DRAFT`/`REVERSAL`-kind excluded per documented predicates, verified against source tables |
| Reconciliation Case 1 (1000→30→35→1080) | `ABSORBED` 80/65/+15 — DRAFT settlement SET to 15, component rewired to real dial 1080, no adjustment bill, no double charge |
| Case 2 (…→1055) | `APPLIED` remainder −10 → credit ADJUSTMENT bill **−3000** (−10×3.00), proportional per-period deltas, FINAL settlements untouched |
| Case 3 (+10, span fully billed) | `APPLIED` → debit ADJUSTMENT **+3000** |
| Unbilled span | 422 `RECONCILIATION_UNBILLED_SPAN` (double-charge guard) |

## Tenant isolation result

**PASS — no cross-tenant read or write found.**

- API attack (Tenant A token vs real Tenant B objects): every probe returned tenant-scoped 404 — bill read/reverse/replace, payment allocation onto B's bill, settlement read/finalize, billing-run read/discard, outstanding probe, payment read/reverse, receipt print, day-close read, staff PATCH, role delete, role-permission read, org PATCH (22 checks).
- Direct RLS (runtime role `ws_app`): no `app.tenant_id` → 0 rows; B context → exactly B's row; `relrowsecurity` + `relforcerowsecurity` true on `bill`, `meter_reading`, `payment`, `staff`.
- Runtime role is non-owner, `NOINHERIT`, no `BYPASSRLS`; `audit_log` has UPDATE/DELETE/TRUNCATE revoked from ws_app.
- `set_config(..., true)` is transaction-local → safe under pooling.
- `x-tenant-code` header spoof → **ignored entirely** (request still served the JWT's own tenant; verified same first row as un-spoofed). Forged/malformed JWT → 401; refresh-as-access → 401.
- Org scope (`ORG_SUBTREE` role in 抄表一班): write to a 第一营业所 book's plan item → `403 ORG_OUT_OF_SCOPE`; own subtree → 201.

## Fresh deployment result

**PASS with I-3 noted.**

- `prisma migrate deploy` + seed on empty `watersaas_rc`: 7 migrations clean, 2 tenants, 22 permission codes, 36 RLS policies.
- Production `node dist/main` + `vite preview` + `/api` proxy: full happy path verified end-to-end (login → tariff → onboard → book → plan → read → QC → settlement → run → bill → payment → receipt → day close → 4 reports).
- **Defect**: deploy to a cluster lacking a literal `watersaas` database fails at migration line 945 (I-3); on default clusters it works only via `PUBLIC` CONNECT.

## Test matrix (executed, not code-read)

| Area | Probes | Outcome |
|---|---|---|
| Tenant isolation | 22 cross-tenant API calls + direct RLS SQL + FORCE check + role attrs | all fail-closed |
| Payment concurrency | 2×alloc same bill, 2×reverse payment, 2×reverse bill, 2×day-close | exactly one winner each (201/409) |
| Reconcile concurrency | 2×POST same account | 201 + 409 `RECONCILIATION_EXISTS`, one row |
| Reading concurrency | 2×reading same plan item | 201 + 409 `ITEM_ALREADY_DONE` |
| Billing-run concurrency | 2×post same run | 201 + 409 |
| Idempotency | same key replay → stored response; same key different body → 409 | pass |
| Input validation | negative/zero/float/string amounts, mismatched allocs, dup billIds, empty allocs, bad channel, DRAFT-bill payment, reversed-bill payment, malformed uuid/enum/period/date, `take`/`skip` edges, unknown fields, SQL-injection string, missing fields | all rejected or safely handled |
| Tariff | boundary qty=10→2000, cross-tier 15→4500, 0→0, 100000→49997000, 3.1415×7.5→2356 (HALF_UP), all malformed ladders rejected, ACTIVE edits → `TARIFF_FROZEN`, shrink-only `effectiveTo`, window overlap 409, retire/new-version flow, bill→plan snapshot | all pass |
| Billing run | partial failure → PARTIAL + exact counts + `failedSettlementIds`; fix cause → retry → POSTED, no dup bills | pass |
| Day close | immutable across reversal, re-close 409, cross-day netting, future-date accepted (M-2), stragglers swept next close | pass + M-2 |
| Meter/reading | mid-period swap = old(100−50)+new(35−0)=85 total, 2 components; plan-item snapshot ignores later book adds; supersede keeps original + child link, double-supersede 409; QC-reject → estimate path; removal into FINAL period → I-2 | pass + I-2 |
| RBAC | reader/cashier perm matrix, `ORG_OUT_OF_SCOPE` write, disabled-staff window, forged/malformed JWT 401, tenant-spoof ignored | pass |
| Reports | all five report predicates verified against direct SQL on live data | pass |
| Deploy | fresh DB migrate+seed, prod startup, preview proxy | pass + I-3 |
| Failure paths | crash-after-commit → idem-key replay returns stored response; mid-tx failure → single-tx rollback; no Redis runtime dependency (sync batch semantics); guarded transitions absorb stale UI/double-click/two tabs; receipt printer is read-side only | pass |

## Recommendation

**`SHIP-WITH-FIXES`**

Critical = 0, Important = 3. The RC does not leak tenants, lose recorded money,
double-charge, or corrupt state under any tested concurrency — but the three
Important defects are each one focused fix away from resolution and should not
ride along silently:

- **I-1** blocks the core 补差 workflow in the most common entry pattern.
- **I-2** silently loses billable usage on a realistic operator action.
- **I-3** breaks fresh deploy on non-default database naming.

Audit produced by independent review of `feat/mvp` (merged as `7b4a8c3`, tag `v0.1.0-mvp`).
