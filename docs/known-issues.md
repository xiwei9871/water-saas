# Known Issues — MVP release candidate

Tracking items deliberately deferred out of the MVP merge gate. When a remote
tracker exists, mirror these as issues.

## 1. Parallel e2e suite flake (test infrastructure)

**Symptom:** `pnpm -C apps/api test:e2e` run as a whole (12 spec files,
vitest default parallelism) intermittently fails 1–4 tests per run —
different specs each time (observed: payment 403-vs-400, onboard 404,
socket hang-up, tariff 409, customer 501-vs-403). Every spec passes in
isolation (verified spec-by-spec: all 219/219).

**Root cause (hypothesis):** all e2e specs share the single
`watersaas_test` database and run concurrently. Cross-suite interference
on shared-DB reads (fixture inserts/updates visible mid-flight to other
suites) plus occasional worker restarts (socket hang-up).

**Not a product defect:** no production code path is implicated; each
spec is green standalone and the full suite has passed whole-run green
repeatedly.

**Suggested fix (post-MVP):** give each spec file its own database or
schema (e.g. `watersaas_test_<spec>`), or run DB-bound e2e serially
(`--no-file-parallelism` for the e2e config) accepting the slower run.

## 2. REPLACE-of-REPLACEMENT false-positive 422 (fail-closed)

A REPLACEMENT bill that is itself replaced again triggers a spurious
`422` from the reconciliation posted-side guard. Pathological case
(three replacements on one bill); failure direction is conservative —
it blocks rather than double-bills. Documented during T11 re-review.

## 3. JWT-frozen context — ≤15 min staleness window (accepted risk)

`scope`/`orgScope` and staff-disable/tenant-suspend status are embedded
in the 15-minute access JWT. A permission shrink or disable takes up to
15 min to take effect (refresh path does re-check). Documented accepted
risk in `auth.service.ts`; tightening = server-side session checks or
shorter access TTL.

## 4. Remote anomaly auto-classification not implemented (Pilot backlog)

Frozen E5 spec calls for vendor-quality / negative-delta / threshold anomalies
to auto-classify as QC `MANUAL_REVIEW`. V1 persists `vendorQuality` but leaves
every valid remote reading at `qcStatus=PENDING`. Safe by default — PENDING is
never a trusted reading — but vendor-specific code meanings
(`"1" / "异常" / "ERR" / "offline"` → NORMAL / SUSPECT / INVALID) need real
VendorX docs. Deferred to Pilot / Vendor Adapter refinement; see
`docs/product-map/E5_REMOTE_READING_V1.md` Not in Scope.
