# Pilot Findings Fix Implementation Plan

> Execute inline in fix/pilot-v0.1.2 using executing-plans and test-driven-development. User authorized implementation; no additional approval checkpoint is needed for routine fixes.

**Goal:** Close PILOT-001–004 with bounded UI and permission changes.
**Architecture:** Add tenant-scoped display/read models and a QC-only permission; retain existing financial computation and data model.
**Tech Stack:** NestJS, Prisma/PostgreSQL, React/AntD, Chrome Playwright, Vitest.

## Tasks

- [x] Preserve original Pilot test/report commit and create a backup-derived isolated fix DB.
- [x] Add tests/pilot-fixes UI regressions: choose exact existing category + custom input; reviewer pass/reject/review with forbidden create/import/supersede/payment/IAM; business search across pagination; staff names; negative/zero/positive recovery display; tenant isolation.
- [x] Run against frozen build and save expected red failures.
- [x] apps/api/src/common/permissions*: introduce explicit any-permission metadata in addition to unchanged ALL behavior. Add guard unit truth-table tests.
- [x] apps/api/src/modules/metering/meter-reading.controller.ts: QC accepts qc OR existing write, q passes to service. Service list applies relation OR search before pagination; attach small account/staff display fields to reads.
- [x] apps/api/prisma/seed.ts + scripts/upgrade-reviewer-qc.ts: register and add QC permission idempotently for selected tenant. Existing passwords, parameters and other role bindings remain intact.
- [x] customer/water-account controller/service: add static usage-categories GET ahead of :id, customer:read, tenant-scoped distinct ACTIVE tariff + account values.
- [x] web UsageCategoryInput.tsx + Onboard.tsx: autocomplete with form id/value/onChange forwarded. MeterReadings.tsx + api/types.ts: named business columns, q search, canQc separate from canWrite, bounded internal horizontal scroll.
- [x] Reports.tsx: negative billed display —, warning and collection-date explanation, keep original amount rendering and rate for positive values.
- [x] Build API/Web, restart production on clone, run targeted Chrome regressions and permissions guard tests until green; do not weaken assertions to conceal defects.
- [x] Run full 77 UAT on isolated fresh UAT DB, API metering e2e on isolated DB, and Pilot16 against cloned historical state with updated intended reviewer/report assertions.
- [x] Review actual diff, update report with before/after evidence, commit changes. Restore local4173 to originalPilot DB with additive reviewer grant; no merge/tag/push without task need.
