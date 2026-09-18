-- tenant_directory: minimal tenant lookup for the pre-auth login path.
--
-- The `tenant` table is behind FORCE row-level security, so ws_app cannot
-- resolve tenant_code -> tenant_id before `set_config('app.tenant_id')` has
-- run — but login needs exactly that lookup to know which tenant context to
-- establish. A view owned by `postgres` (the migration role, a superuser)
-- bypasses RLS when queried, exposing only the columns the login flow needs:
-- id / code / name / status. Secrets and tenant params stay behind RLS.
CREATE OR REPLACE VIEW tenant_directory AS
SELECT id, code, name, status FROM tenant;

GRANT SELECT ON tenant_directory TO ws_app;
