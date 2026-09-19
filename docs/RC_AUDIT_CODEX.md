# Independent Release Candidate Audit — `feat/mvp` vs `main`

**Status**: updated after RC Fix Cycle 1 (`review/codex-rc-fixes`, 4 commits).
Original audit findings reproduced on the unfixed RC; post-fix results
verified on a fresh arbitrary-name database (`watersaas_rc_8100`) with a
production build.

---

## Executive Summary

The original audit (SHIP-WITH-FIXES: Critical 0 / Important 3 / Minor 2 /
Nit 3) found zero tenant-isolation or money-conservation breaches, plus
three real workflow defects. All three Important findings — and Minor M-1
— are now **FIXED** on `review/codex-rc-fixes` with dedicated regression
tests and re-run release gates. M-2 and the nits remain **DEFERRED** by
explicit scope freeze.

| # | Finding | Status |
|---|---------|--------|
| I-1 | Same-day reconciliation anchor used UUID as chronology → `ANCHOR_NOT_FOUND` | **FIXED** (`1030c1e`) |
| I-2 | Meter removal into FINAL/POSTED period silently lost billable usage | **FIXED** (`87d879c`) |
| I-3 | Init migration hardcoded `GRANT CONNECT ON DATABASE watersaas` | **FIXED** (`9358c88`) |
| M-1 | Settlement could be created/finalized on a CLOSED account | **FIXED** (`2e6606c`) |
| M-2 | Day-close accepts future dates | **DEFERRED** (accepted) |
| N-1..3 | Dead enum / stranded-payment signal / latestTrusted tie-break | **DEFERRED** (N-3 subsumed by I-1 fix) |

**Recommendation: `READY-FOR-RC-MERGE`** (post-fix: Critical = 0, Important = 0)

---

## Findings — post-fix status

### I-1 — FIXED: reconciliation anchors now order by real chronology

- **Original defect**: `anchorBefore`/`latestTrusted` tie-broke same-`read_date`
  candidates on random UUIDv4 → ~50% of same-day pairs permanently
  `ANCHOR_NOT_FOUND`.
- **Fix**: ordering is now `(readDate, createdAt, id)` — `id` survives only
  as a deterministic final tie-break, never carrying time semantics
  (`reconciliation.service.ts`, `anchorBefore` + `latestTrusted`).
- **Regression** (`reconciliation.e2e-spec.ts` RC-fix describe): deterministic
  adverse fixture — anchor gets the LARGER uuid + EARLIER created_at,
  actual the smaller uuid + later created_at, same read_date, cross-period
  span. Explicit `actualReadingId` → 201 ABSORBED with the correct anchor;
  implicit `latestTrusted` path → same. Verified fail-first on the unfixed
  code (404), pass after.
- **Post-fix evidence**: 24/24 spec standalone; Gate-4 live probe on
  `watersaas_rc_8100` → ABSORBED, anchor = larger-uuid row.
- **Review check**: ordering change only re-picks candidates among
  same-day readings; it cannot mint a different anchor outside the true
  chronological predecessor. No charge-path changes.

### I-2 — FIXED: meter removal into a finalized period fails closed

- **Original defect**: `removeTx` accepted `removedAt` inside a period with
  a FINAL settlement or posted bills → `final_reading` delta above the
  settled chain-end was permanently unbillable (939 m³ observed).
- **Fix**: before ANY mutation, `removeTx` resolves the removal date's
  period using the settlement convention (UTC `YYYYMM`, same as
  `periodBounds`) and rejects with
  `409 SETTLEMENT_PERIOD_ALREADY_FINALIZED` when that period has a FINAL
  `consumption_settlement` or a POSTED-side bill (`POSTED`/`PARTIAL_PAID`/
  `PAID`). No auto-reopen, no settlement mutation.
- **Regression** (`settlement.e2e-spec.ts` RC-fix describe): FINAL-period
  removal → 409 + installation/meter provably untouched; POSTED-billed
  period → 409; OPEN period → 201 REMOVED + meter AVAILABLE.
- **Post-fix evidence**: 26/26 spec standalone; Gate-4 live probe — all
  three cases including the untouched-row assertion.
- **Review check**: pure fail-closed; mid-period swap path (remove inside
  the open period) unchanged — the existing swap spec still passes.

### I-3 — FIXED: runtime DB grant follows `current_database()`

- **Original defect**: `GRANT CONNECT ON DATABASE watersaas TO ws_app`
  literal — deploy fails on clusters without that database; silently
  grants the wrong one where it exists (default PUBLIC CONNECT masked it).
- **Fix**: `EXECUTE format('GRANT CONNECT ON DATABASE %I TO ws_app',
  current_database())` — same guarded `DO` style as the adjacent
  test-database block; `%I` identifier quoting.
- **Post-fix evidence**: fresh `watersaas_rc_8100` → `migrate deploy`
  (7 migrations) + `db seed` clean; `datacl` shows explicit
  `ws_app=c/postgres`; `ws_app` connects directly; 36 RLS policies;
  `ws_app` non-superuser/no-BYPASSRLS, `ws_owner` NOLOGIN.
- **Review check**: privilege model unchanged — same role, same grant
  type, now targeting the database actually being migrated.

### M-1 — FIXED: closed accounts gain no settlement activity

- **Original defect**: CLOSED account → settlement create 201 → finalize
  201 → billing FAILED, leaving FINAL settlement + unpostable DRAFT bill.
- **Fix**: `generateTx` rejects `409 WATER_ACCOUNT_CLOSED` right after the
  account lookup (same convention as reconciliation's CLOSED check);
  `finalizeTx` rejects the orphaned-DRAFT case AFTER the DRAFT-status
  check, so historical FINALs keep their existing transition error.
- **Regression**: ACTIVE→create→close→finalize → 409; CLOSED→create → 409.
- **Post-fix evidence**: spec + Gate-4 live probes, both legs.

## Existing accepted risks / deferred items

- **M-2 (DEFERRED)**: `POST /cashier-day-close/close` accepts a future
  `closeDate` — sweeps stragglers but loosely controlled. Deferred per
  scope freeze.
- **N-1 (DEFERRED)**: vestigial `payment.status = REVERSED` enum value.
- **N-2 (DEFERRED)**: post-close same-day payments stay `RECEIVED` until a
  later close — correct sweep semantics, no UI signal.
- **N-3 (subsumed)**: `latestTrusted` same-day tie-break — resolved by the
  I-1 ordering fix.
- **Accepted risks (unchanged)**: parallel e2e shared-DB flake; REPLACE-of-
  REPLACEMENT conservative 422; JWT scope/disable ≤15-min frozen window;
  optional idempotency (keyless POST can duplicate — web always sends a
  key); no-org-anchor scope carve-out (in-code documented).

## Verification matrix — post-fix

| Gate | Result |
|---|---|
| Targeted regression (fail-first → pass) | I-1: 404→201 ABSORBED both paths; I-2: 201→409 untouched; M-1: 201→409 both legs |
| e2e per spec (serial) | **225/225** (219 + 6 new) |
| billing-core unit | 63/63 |
| api unit | 5/5 |
| `pnpm -r build` / lint | green / 0-0 |
| Gate 1 fresh deploy (arbitrary name `watersaas_rc_8100`) | migrate deploy + seed clean, explicit `ws_app` CONNECT, 36 policies |
| Gate 2 prod startup | `node dist/main` + `vite preview` + `/api` proxy |
| Gate 3 business loop | login→tariff→onboard→book→plan→read→QC→settle→run→bill→pay→receipt→close→4 reports; 3600-cent chain exact |
| Gate 4 negatives | 14/14 — I-2 FINAL 409 + untouched, I-2 open 201, M-1 both 409s, I-1 adverse ABSORBED, x-tenant 404, idem replay same row, parallel payment 201/409, PAID-bill reverse 409, POSTED reverse → REVERSAL −6000, payment reverse + double-reverse 409 |

## Post-fix review notes (read-only pass over `feat/mvp...review/codex-rc-fixes`)

- No RLS/policy weakening; the grant change is name-indirection only.
- No financial-history mutation; every change is a guard or an ordering.
- No new double-charge / lost-usage path introduced.
- `removeTx` hoists `removedAt` so the guard and the write share one value.
- `finalizeTx` CLOSED check sits after the DRAFT check → historical FINAL
  rows keep `INVALID_SETTLEMENT_STATUS_TRANSITION`, unchanged semantics.
- Two new UI labels (`WATER_ACCOUNT_CLOSED`,
  `SETTLEMENT_PERIOD_ALREADY_FINALIZED`) follow the existing dictionary.

## Recommendation

**`READY-FOR-RC-MERGE`**

Critical = 0, Important = 0 after Fix Cycle 1. The four targeted fixes are
minimal, fail-closed, individually committed, and re-gated end-to-end.
Per the release protocol: no merge and no tag from this cycle — the
decision rests with human review.
