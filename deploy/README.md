# Water SaaS Pilot deployment

Dedicated Docker Compose project `water_saas` on `stock-prod` (192.168.3.185). This uses the stock platform's container/reverse-proxy pattern, but separate services, network and PostgreSQL15 volume. API and DB have no host ports. Web binds192.168.3.185:5185 for the outer gateway. Never change stock's containers or Compose files.

## Paths and secrets

Release archives: `/home/jqz/code/water-saas/releases/<git-sha>`.
Persistent configuration: `/home/jqz/code/water-saas/shared/`, directory0700 and env files0600.
Compose volume: `water_saas_pilot_data`. After the2026-09-20 data migration, the active database is `water_pilot_v012`; the original empty `water_pilot` is retained for rollback. First bootstrap below creates `water_pilot`; do not rerun it on the active deployment.
Backups: `/home/jqz/code/water-saas/backups/` (0700).

`shared/compose.env`: WATER_RELEASE_SHA, WATER_SHARED_DIR, WATER_BIND_IP, WATER_BIND_PORT.
`shared/db.env`: POSTGRES_DB=water_pilot, POSTGRES_USER=postgres, random POSTGRES_PASSWORD.
`shared/runtime.env`: NODE_ENV=production, PORT=3000, independent JWT_SECRET, DATABASE_URL (ws_app), WATER_EXPECTED_DATABASE=water_pilot_v012. MIGRATION_DATABASE_URL points at the **same restricted ws_app URL** in runtime, so owner credentials are absent from the long-lived API.
`shared/migration.env`: owner MIGRATION_DATABASE_URL, runtime DATABASE_URL, WATER_BOOTSTRAP=1 and independent WATER_ADMIN_CD_PASSWORD/WATER_ADMIN_XH_PASSWORD (at least20 chars). Mount this env only into one-shot migration/bootstrap containers.
Never commit credentials, synchronize local `.env`, publish seed passwords, or run seed on an existing deployment.

## First deployment

From a clean committed source archive on the server, export WATER_RELEASE_SHA, WATER_SHARED_DIR and WATER_BIND_IP before Compose commands (or supply `--env-file shared/compose.env`).

```sh
docker compose -f deploy/compose.yml build api web
docker compose -f deploy/compose.yml up -d db
docker compose -f deploy/compose.yml run --rm --no-deps --env-from-file "$WATER_SHARED_DIR/migration.env" api pnpm exec prisma migrate deploy
docker compose -f deploy/compose.yml run --rm --no-deps --env-from-file "$WATER_SHARED_DIR/migration.env" api node /app/deploy/bootstrap.mjs
docker compose -f deploy/compose.yml run --rm --no-deps api node /app/deploy/verify.mjs
docker compose -f deploy/compose.yml up -d api web
```

Bootstrap rejects an existing tenant database. If a first-run seed is interrupted, keep Web unpublished and inspect the new dedicated DB; do not bypass the existing-tenant check or reset other databases. The initial migrate creates ws_app with the historical migration password; bootstrap rotates it before API/Web start.

Check Nginx `/api/auth/login` reaches root API `/auth/login`. Check both tenants' admin logins, reject admin123, verify release.json's commit, and run Chrome navigation against the real origin. Stock HTTP200 must remain unchanged. Then configure the confirmed outer HTTPS virtual host to192.168.3.185:5185. A wildcard DNS record or another application's401 is not a successful release.

## Upgrade, backup and rollback

Before upgrades, create a protected logical backup using `docker compose -f deploy/compose.yml exec -T db pg_dump -U postgres -d water_pilot_v012 -Fc` redirected to a timestamped file. Check it with pg_restore --list and retain the previous release archive/images. Upgrade by changing only release SHA, building, running migrate, and recreating api/web. **Do not rerun bootstrap or seed.**

For an application-only rollback with compatible schema, set the prior SHA/release directory and recreate api/web from its retained images, keeping the same project/network/volume. For incompatible migrations, stop writes and plan a separate database restore; never automatically downgrade schema or discard newer transactions. Never use compose down -v or prune this volume.

Existing v0.1.2-mvp tag is unchanged. Deployed pilot code includes the later validated fixes; identify it by exact commit, not a fabricated release tag.

## Browser verification from the local checkout

Use the protected login JSON generated for this deployment. The browser smoke checks release.json **before** sending credentials, checks both seeded passwords are rejected, logs in via the real UI, and visits all28 application routes. It does not create customer/billing/payment records.

```sh
WATER_LOGIN_FILE=/Users/xiwei/.config/water-saas/credentials.json \
apps/api/node_modules/.bin/tsx deploy/smoke.mts
```

After the external route is connected, rerun with `WATER_SMOKE_URL=https://water.manqiaotechnology.com`. Results/screenshots are ignored under `artifacts/pilot/deploy/{lan,public}`. An unrecognized origin or a mismatched release SHA blocks login rather than sending deployment credentials to another service.

## Restored Pilot data (2026-09-20)

Current runtime and migration URLs both name `water_pilot_v012` on the dedicated database container. The ws_app password and JWT secret remain deployment-specific. Both current server administrator password hashes were retained by tenant code/login when restoring the local data. All local Pilot business rows were copied; local services/data remain separate afterward.

Before switching back, stop API writes and back up **the active water_pilot_v012**, then restore runtime.env and migration.env from `/home/jqz/code/water-saas/backups/migration-20260920/`. Recreate api and web together (Nginx must resolve the new API container address). The old water_pilot database has no Pilot business records; rollback does not merge transactions created after this migration. Never delete either database as an automatic rollback action.

Detailed row counts, hash comparisons and browser verification: `docs/PILOT_DATA_MIGRATION_20260920.md`.
