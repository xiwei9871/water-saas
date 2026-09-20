# Pilot finding regressions

These 13 Chrome tests cover PILOT-001–004 on the fix branch. They use production Web4173 → `/api` → API3000, not mocked responses. Run one suite/environment at a time.

## Data prerequisites

- Preserve the completed original Pilot checkpoint at `artifacts/pilot/p20260919a/state.json` and its `post-run.dump`; both are intentionally local/ignored.
- Restore that snapshot into a separate `water_pilot_fix_v012` database. Never reset `water_pilot_v012` to run these tests.
- Build the current branch. Start API3000 in production with runtime `ws_app` and owner URLs both explicitly targeting `water_pilot_fix_v012`, plus an independent JWT secret. Run built Web with Vite preview4173.
- Apply `apps/api/scripts/upgrade-reviewer-qc.ts cd-water` with `MIGRATION_DATABASE_URL` explicitly set to the clone owner URL. The fixture adds pending readings and a scope-limited reviewer only to this clone.

```sh
pnpm -r build
pnpm exec playwright test --config playwright.pilot-fixes.config.ts
pnpm exec playwright show-report artifacts/pilot/fixes/html-report
```

Outputs: `artifacts/pilot/fixes/{results.json,html-report,test-results}`. Archive prior outputs before reruns. The tests deliberately deny reviewer general writes, cashier QC, out-of-scope QC and cross-tenant QC; only their exact method/path/status responses are classified as expected errors. All other browser/network errors fail the test.

## Full compatibility runs

Original77: a fresh migrated/seeded `water_pilot_fix_uat_v012`, with API connected to that DB, then `UAT_DATABASE_NAME=water_pilot_fix_uat_v012 pnpm exec playwright test`.

Pilot16: restore the original post-run backup into `water_pilot_fix_replay_v012` and apply the additive reviewer grant. Copy the original state to a separate artifact folder, e.g. `artifacts/pilot/p20260919a-fix-replay/state.json`, **without changing its internal runId, roles or IDs**. Point API at that clone and run:

```sh
PILOT_RUN_ID=p20260919a-fix-replay PILOT_DATABASE_NAME=water_pilot_fix_replay_v012 pnpm exec playwright test --config playwright.pilot.config.ts
```

The environment run ID selects the output directory; the copied checkpoint retains the business identity. Changing the internal runId would provision different staff and invalidate historic cashier assertions. Completed steps verify persisted records; they do not replay payments or claim a new empty-database Pilot execution.

After testing, restore API3000 to `water_pilot_v012`. Existing users must log in again after a role grant to refresh their JWT permissions.
