-- E10 hotfix: backfill the permission catalog for already-provisioned
-- tenants. Codes minted after their initial seed (exception:read /
-- exception:manage / metering:remote:manage / prepayment:reverse) never
-- existed in older tenants' permission table, so non-admin roles could
-- never be granted them and the exception center was unreachable for
-- scoped staff. admin '*' is unaffected by definition.
INSERT INTO permission (id, tenant_id, code, type, created_at, updated_at)
SELECT gen_random_uuid(), t.id, c.code, 'ACTION', now(), now()
FROM tenant t
CROSS JOIN (VALUES
  ('metering:remote:manage'),
  ('prepayment:reverse'),
  ('exception:read'),
  ('exception:manage')
) AS c(code)
ON CONFLICT (tenant_id, code) DO NOTHING;

-- Bind the exception codes to the seeded default roles where they exist,
-- same matrix as prisma/seed.ts rolePermBindings. Only the new codes are
-- bound — re-binding the older ones would silently restore permissions an
-- admin may have deliberately revoked.
INSERT INTO role_permission (tenant_id, role_id, permission_id, created_at, updated_at)
SELECT r.tenant_id, r.id, p.id, now(), now()
FROM role r
JOIN permission p ON p.tenant_id = r.tenant_id
WHERE (r.code, p.code) IN (
  ('reader',   'exception:read'),
  ('cashier',  'exception:read'),
  ('reviewer', 'exception:read'),
  ('reviewer', 'exception:manage')
)
ON CONFLICT (role_id, permission_id) DO NOTHING;
