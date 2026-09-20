# Frozen v0.1.2 business Pilot

Production baseline: `v0.1.2-mvp` (`f3641013e2c8f1204db84273072ea068864cef64`).
Chrome installed locally, production Web4173 → `/api` proxy → production API3000, persistent PostgreSQL `water_pilot_v012`.

```sh
pnpm exec playwright test --config playwright.pilot.config.ts
pnpm exec playwright show-report artifacts/pilot/p20260919a/html-report
```

Default run ID `p20260919a`. State and all evidence reside in ignored local `artifacts/pilot/<runId>/`. Tests run sequentially, no retries. Every successful write is checkpointed. Resume the same run; do not erase state or rebuild the database. Preserve the pre-existing `Pilot-A01` account.

Before another invocation replaces the HTML/trace/video output, archive the current attempt:

```sh
python3 tests/pilot/scripts/archive.py unique-attempt-name
```

`PILOT_RUN_ID` may name a *new* batch only after selecting suitable periods and confirming tenant-wide report expectations. It is not a daily reset mechanism. Financial writes with an ambiguous response must be reconciled against the DB read-only before resuming; never clear a pending operation blindly. Checkpoint loss after other writes also requires read-only reconciliation, not blind replay.

Fixtures: five role-bound staff (password `Pilot12345`), three historical trusted actual readings at 1000. These are explicitly not UI coverage. All tariffs, onboarding, book membership, plans, subsequent readings/QC, settlements/final review, billing, payments/printing/reversals/closes and meter removal/installation are UI operations. SQL report checks are read-only crosschecks.

This simulates July/August plus September recovery, not passage of actual calendar days. Next-day reversal after a prior day close remains unverified. Automation wall time/click counts are diagnostic and must not be described as human teller performance.

Use existing `playwright.config.ts` separately for the original UAT environment. Do not run that suite against this Pilot database.
