# Pilot Cycle 1A — G6 Final Report

Cycle 1A end-to-end validation: full configured synthetic profile +
detector evaluation + episode evaluation + operator pilot →
Pilot Decision Gate.

**Scope note**: all detector numbers below are *synthetic Ground-Truth
validation* — the GT is the generator's own independent oracle. They
prove construction + evaluator correctness at scale, **not** real-world
production precision/recall. Real-distribution calibration is Cycle 1B.

## Frozen baseline

```text
branch: feat/pilot-generator
G1–G5: PASS (G5 RC1 at 2b7f789)
```

## Profile

```text
total accounts:   4000
clean accounts:   3440   (baseline allocation)
fault scenarios:  600    (13 primary × 40 + 2 composites × 40)
periods:          2      (202608, 202609)
branches:         3      books: 12 + 6 fault books   remote ≈ 30%
profile file:     scripts/pilot/profiles/full.json
```

Per-instance scenario identity: `NO_BOOK:000001..000040` etc., with
deterministic business keys (`P0042-NBK-0060xx`). Allocator namespaces:
6000–6999 scenario accounts/meters, 7000–7999 extra meters, 8000–8999
devices, 9000+ fault books/events — centrally allocated, zero collisions
(unit-tested).

## Runs

```text
concurrency: 6 (500-account and 1000-account scale smokes PASS first)

Run A  run-s42-2026-09-23T09-40-09-273Z   193.2s
Run B  run-s42-2026-09-23T09-43-46-078Z   191.3s (after reset, residual=0)

both: 3440 clean accts, 4586 actual + 2294 remote readings,
      6880 settlements, 6880 bills, 5848 payments + 1892 top-ups
      financial PASS — bill=21,156,000 pay=16,666,800 prepay=4,489,200
      topUp=4,489,200 apply=-4,489,200 net=0 open=0
```

### A/B semantic determinism

```text
GT entries:              4040 / 4040 — set-equal
scenarioKeys:            identical sets (4040 unique)
businessKeys:            16,299 — identical sets
anomaly distribution:    identical (per-type counts equal)
errors:                  0 / 0    clockDrift: false / false
UUIDs:                   differ by design (allowed)
```

## Detector evaluation (evaluate.ts — unchanged G5 evaluator)

Both runs:

```text
expected=600  detected=600  TP=600  FP=0  FN=0
anchorMismatch=0  ownershipMismatch=0
cleanBackgroundFP=0  faultUnexpectedFP=0  unattributedFP=0
per-type: all 13 types — 40 expected / 40 detected each
          (MULTI_BOOK 80, REMOTE_EVENT_KEY_CONFLICT 80 incl. composites)
```

## Episode scale smoke (evaluate.ts --episodes)

Both runs:

```text
initial OPEN:        600 active episodes, 1 per anomalyKey
idempotent refresh:  created=0 resolved=0 cleared=0, ids stable
duplicate active:    0
```

(Lifecycle state machine — MANUAL/ACK→AUTO/IGNORED/recurrence —
was verified at G5 on the same evaluator; G6 validates scale only,
per spec §14.)

## Candidate E10 semantics (evidence.ts — observational only)

From `pilot-evidence.json` (Run B). These are *candidate semantics*,
not metric decisions — E10 stays PILOT HOLD:

```text
ESTIMATE_RATE denominators (period 202608/202609):
  estimated/settled ≈ 0.0115, estimated/due ≈ 0.0098–0.0116

RECOVERY_RATE numerators:
  202608: billed 18,180,000  cash_recovery 14,155,200 (0.7786)
          debt_extinguished 18,180,000 (1.0000)
  202609: billed 3,216,000   cash_recovery 2,751,600 (0.8556)
          debt_extinguished 3,216,000 (1.0000)

shared-settle: 3520 settle accounts, 1 covering org each (no
  multi-org settle distribution observed in this profile)

work_item: 600 OPEN episodes across 13 anomaly types
```

## Phase durations (diagnostic, not a gate)

```text
billing ~68s (dominant — single-tx createTx + per-bill execute)
reading ~26s/period   settlement ~25s   payment ~21s
accounts ~8s   remote ~5s   fault-inject ~10s   verify <1s
```

## Operator pilot — STAGED, awaiting human execution

```text
sample:    65 episodes (5 × 13 anomaly types), deterministic
artifact:  operator-observations.json (template, per-episode fields)
report:    operator-report.ts → operator-report.json (0/65 filled)
```

Procedure for the human operator:

1. Start API + web against `watersaas_pilot`, tenant PILOT-0042.
2. Open the Exception Center queue; work each episode listed in
   `operator-observations.json` (anomalyKey/episodeId fixed).
3. For each: identify anomaly → open detail → judge object + owning
   branch → choose ACK / ASSIGN / IGNORE / repair → resolve where
   applicable. Fill the observation fields as you go.
4. Any P0 safety issue → stop the pilot immediately.
   P1/P2 UX friction → record only, do not change the product mid-pilot.
5. Afterwards run:
   `node ../../scripts/pilot/operator-report.ts --run artifacts/pilot/<runId>`
   to produce `operator-report.json` (completion, understanding,
   ownership accuracy, median/p90 handling, confusion count).

## Hardening findings

```text
P0: none

P1: BillingRunService.createTx generates ALL draft bills of a period
    in ONE Prisma interactive transaction (5s default timeout).
    Fails deterministically beyond ~800 settlements (observed at
    1000 accounts; 500 fits). A real >~800-account tenant cannot
    create a billing run. G6 evidence collected via pilot-harness
    tx timeout (same set_config semantics, no production change).
    Follow-up: chunk bill generation or raise the tx budget in
    TenantPrismaService — product decision, NOT made here.

P2: evidence.ts used transaction-local set_config (no-op outside a
    tx) → RLS hid all rows; fixed to session-local (pilot tool only).
    scripts/pilot/*.ts must run under plain `node` (type-stripping);
    under tsx, dist ESM + apiRequire CJS produce duplicate
    @nestjs/core instances → DI failure. Usage comment updated only
    implicitly — keep `node`, never `tsx`, for live runs.
```

## Verification matrix

```text
targeted tests:  70/70 (baseline 9, generator 18, fault 18, evaluate 25)
build:           PASS (pnpm --filter api build)
lint:            0 errors (3 pre-existing warnings, unchanged)
diff-check:      clean
production code/schema changes: NONE
```

## Pilot Cycle 1A verdict

```text
HARDENING REQUIRED (interim) — synthetic evidence complete and green;
operator pilot staged but not yet executed by a human operator.
```

Synthetic gates: PASS (generation stability, determinism, financial
closure, detector 600/600 TP with FP=FN=0, exact anchors/ownership,
episode scale, reset/regenerate). One P1 product limitation recorded
(billing single-tx timeout). Final PASS requires completing the 65
sampled operator episodes and a clean `operator-report.json`.

**STOP — E11 not started.**
