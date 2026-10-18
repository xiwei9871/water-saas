#!/usr/bin/env bash
# Controlled reset for the Cycle-1A operational-flow gate database.
# FAIL CLOSED: refuses to touch anything but watersaas_system_flow.
# Drops + recreates the DB, then applies every Prisma migration SQL in
# order (test DBs use SQL apply, not migrate deploy bookkeeping).
set -euo pipefail
DB="watersaas_system_flow"
if [ "${SF_DATABASE_NAME:-$DB}" != "$DB" ]; then
  echo "ABORT: SF_DATABASE_NAME=${SF_DATABASE_NAME} is not $DB" >&2
  exit 1
fi
cd "$(dirname "$0")/../../.."   # repo root
ADMIN="postgresql://postgres:postgres@localhost:5432/postgres"
psql "$ADMIN" -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)"
psql "$ADMIN" -c "CREATE DATABASE $DB"
for f in apps/api/prisma/migrations/*/migration.sql; do
  psql -v ON_ERROR_STOP=1 "postgresql://postgres:postgres@localhost:5432/$DB" -f "$f" >/dev/null
done
n=$(psql -tA "postgresql://postgres:postgres@localhost:5432/$DB" -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
echo "reset OK: $DB recreated with $n tables"
