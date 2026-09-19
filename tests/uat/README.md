# v0.1.1 Frontend UAT

Run from the repository root after verifying that `v0.1.1-mvp` is an ancestor.
Round one is preserved at `e8781a86181529ea3f4762d67eccb58a578bb5fd` on
`uat/playwright-v0.1.1`. The UI fix cycle runs on `fix/uat-v0.1.1`: the original
65 tests remain, with 12 regressions in `uat-fixes.spec.ts`. The original
permission tests now expect a Chinese Forbidden page; date/drawer selectors
use the globally configured Chinese labels.

## Environment

Use only the dedicated `water_uat_v011` PostgreSQL database. Both migration and
seed commands must receive explicit URLs; seed uses the owner URL.

```sh
DATABASE_URL=postgresql://ws_app:ws_app_pw@localhost:5432/water_uat_v011 \
MIGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/water_uat_v011 \
pnpm -C apps/api exec prisma migrate deploy
DATABASE_URL=postgresql://ws_app:ws_app_pw@localhost:5432/water_uat_v011 \
MIGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/water_uat_v011 \
pnpm -C apps/api exec prisma db seed
pnpm build
```

Start API from `apps/api` with `NODE_ENV=production`, the two URLs above,
a UAT-only `JWT_SECRET`, and `node dist/main` on port 3000.
Start Web from `apps/web` with:

```sh
pnpm exec vite preview --host 127.0.0.1 --port 4173 --strictPort
```

The application request route is always Chromium → 127.0.0.1:4173 → `/api`
proxy → :3000. The audit fixture fails on fetch/XHR outside that origin/path.
No API is mocked. SQL only prepares role accounts, selects a clean period and
verifies duplicate-document counts. The fix regressions also upsert one DRAFT
tariff for deterministic column-width checks; it never participates in billing. The NO_READ test uses explicitly marked
browser `/api` calls for its independent prerequisites. All happy path business
creation and mutations happen through UI controls.

## Run and evidence

```sh
pnpm exec playwright install chromium
pnpm exec playwright test
pnpm exec playwright show-report artifacts/uat/html-report
```

One Chromium worker; viewport 1440×900; additional 1280×800 and 1024×768 checks.
Retries = 1. HTML and JSON contain each attempt, including a first failure that
passes on retry. Do not treat flaky as an ordinary pass. Failure screenshot,
trace and video are retained. Additional milestone/layout screenshots are
intentional evidence. `browser-network` classifies expected 401/403 only for
explicit endpoint + method + status rules; other 4xx/5xx, page errors, failed
requests and console errors fail the suite. Evidence and local JWT secret are
ignored by Git; traces can contain UAT tokens and must not be published.

## Database state and repeated runs

The happy path consumes a clean current-month period (next month only if the
current month is occupied). It also creates a cash payment and today's admin
day-close, so full acceptance runs require a newly initialized UAT database.
Do not rerun the whole suite over an already completed day-close and call its
result fresh. Archive evidence and recreate **only** `water_uat_v011`, after
confirming it is the database created for this UAT session. Never reset other
smoke, RC or production databases. No automatic destructive reset is wired
into Playwright. A retry uses new unique names; first-attempt state remains
visible in the report. If a late retry is contaminated by earlier accounting
state, report that explicitly and rerun on a fresh dedicated database.

`happy-path-state` records completed milestones and UI-created business IDs.
If a milestone fails, downstream milestones are BLOCKED, never PASS. The JSON
summary script below produces test-level counts; milestone blocks are reported
separately in the UAT report.

```sh
python3 tests/uat/summarize.py
```
