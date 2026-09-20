# Paid estimated-reading recovery regression

This suite reproduces the user's 0→250→estimated275→actual265 scenario using illustrative 2026/2027 periods. Tariffs are **synthetic**, not Chengdu policy. No household-size entitlement is inferred.

## API gate and historical fixture

Use a dedicated migrated database `water_recovery_fix_20260920`. Explicitly point migrations at that database; never run these tests against the persistent Pilot database. Tests create a unique `recovery-*` tenant per invocation and retain it for the browser scenario. Existing API suites clean only their own named test tenants.

```sh
DATABASE_URL_TEST=postgresql://ws_app:ws_app_pw@localhost:5432/water_recovery_fix_20260920 \
MIGRATION_DATABASE_URL_TEST=postgresql://postgres:postgres@localhost:5432/water_recovery_fix_20260920 \
pnpm --dir apps/api exec vitest run --config vitest.config.e2e.ts --no-file-parallelism \
  test/estimated-recovery.e2e-spec.ts test/settlement.e2e-spec.ts \
  test/billing.e2e-spec.ts test/reconciliation.e2e-spec.ts test/payment.e2e-spec.ts
```

The new API file has ten cases: pre-correction blocking with/without maxDial, same-year tier restoration, successive corrections, skipped recovery month, later same-month actual, zero-money quantity correction, zero-money restoration, and paid flat/tiered year-boundary chains. Original settlement components and paid bills must stay unchanged.

## Chrome workflow

Build production code. Run `node dist/main` on3000 with an independent JWT secret, production NODE_ENV, ws_app DATABASE_URL and owner MIGRATION_DATABASE_URL both pointing explicitly at `water_recovery_fix_20260920`. Serve Web with Vite preview on4173. The browser uses Chrome and all business requests go through4173 `/api`; no mocks.

```sh
pnpm exec playwright test --config playwright.recovery.config.ts
```

Run the **whole new API file first**, not just a filtered case: the browser chooses the latest recovery tenant's unused paid-estimate account. It adds only a future reading as SQL fixture. The browser performs the failed generation, reconciliation, current settlement/finalization, zero bill/posting, next settlement and credit display checks. This test writes business state; rerun the API fixture before another browser run.

Artifacts (ignored): `artifacts/pilot/recovery/` — HTML/JSON reports, screenshots and retained failure traces/videos. Browser auditing distinguishes the expected409 from unexpected errors and rejects proxy bypass. Chrome test retries are0.

For the independent original77 UAT gate, migrate/seed a fresh `water_recovery_uat_20260920`, point the production API at it, and run `UAT_DATABASE_NAME=water_recovery_uat_20260920 pnpm exec playwright test`. That suite retains its existing retry1 policy; inspect attempt counts and flaky results. Restore the API to `water_pilot_v012` afterward.
