/**
 * Seed — one-off ops script, NOT part of the runtime code path.
 * Uses its own PrismaClient bound to MIGRATION_DATABASE_URL (postgres owner),
 * which bypasses RLS; the runtime client (ws_app) is never used here.
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient({
  datasourceUrl:
    process.env.MIGRATION_DATABASE_URL ??
    'postgresql://postgres:postgres@localhost:5432/watersaas',
});

const ADMIN_PASSWORD = 'admin123';

interface TenantSeed {
  code: string;
  name: string;
}

async function seedTenant({ code, name }: TenantSeed) {
  const tenant = await prisma.tenant.upsert({
    where: { code },
    update: { name },
    create: { code, name, status: 'ACTIVE', params: {} },
  });
  const tenantId = tenant.id;

  // org tree: 公司 → 营业所 → 部门
  const company = await upsertOrgUnit(tenantId, null, `${name}公司`, 'COMPANY');
  const branch = await upsertOrgUnit(tenantId, company.id, '第一营业所', 'BRANCH');
  await upsertOrgUnit(tenantId, branch.id, '抄表一班', 'DEPT');

  // roles
  const roleDefs = [
    { code: 'admin', name: '系统管理员', dataScope: 'ALL' as const },
    { code: 'reader', name: '抄表员', dataScope: 'ORG_SUBTREE' as const },
    { code: 'cashier', name: '收费员', dataScope: 'ORG_SUBTREE' as const },
    { code: 'reviewer', name: '复核员', dataScope: 'ORG_SUBTREE' as const },
  ];
  const roles: Record<string, string> = {};
  for (const r of roleDefs) {
    const role = await prisma.role.upsert({
      where: { tenantId_code: { tenantId, code: r.code } },
      update: { name: r.name, dataScope: r.dataScope },
      create: { tenantId, ...r },
    });
    roles[r.code] = role.id;
  }

  // Standard permission codes — must exist for non-admin roles to be bindable
  // via PUT /iam/roles/:id/permissions (the codes themselves are only enforced
  // as string literals in @Permissions decorators; a missing row here leaves a
  // freshly-seeded tenant's non-admin roles unbindable until hand-minted).
  const permCodes = [
    'customer:read',
    'customer:write',
    'metering:read',
    'metering:write',
    'metering:qc',
    'metering:remote:manage',
    'billing:read',
    'billing:write',
    'payment:read',
    'payment:write',
    'iam:read',
    'iam:write',
    'report:read',
  ];
  const perms: Record<string, string> = {};
  for (const code of permCodes) {
    const p = await prisma.permission.upsert({
      where: { tenantId_code: { tenantId, code } },
      update: {},
      create: { tenantId, code, type: 'ACTION' },
    });
    perms[code] = p.id;
  }
  // Sensible starter bindings for the seeded roles (admin has '*' implicitly).
  const rolePermBindings: Record<string, string[]> = {
    reader: ['customer:read', 'metering:read', 'metering:write'],
    cashier: ['customer:read', 'billing:read', 'payment:read', 'payment:write'],
    reviewer: ['metering:qc', 'metering:read', 'billing:read', 'report:read'],
  };
  for (const [roleCode, codes] of Object.entries(rolePermBindings)) {
    for (const code of codes) {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: roles[roleCode], permissionId: perms[code] } },
        update: { tenantId },
        create: { tenantId, roleId: roles[roleCode], permissionId: perms[code] },
      });
    }
  }

  // admin account
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  const admin = await prisma.staff.upsert({
    where: { tenantId_login: { tenantId, login: 'admin' } },
    update: { passwordHash, name: '管理员', orgUnitId: company.id },
    create: {
      tenantId,
      login: 'admin',
      passwordHash,
      name: '管理员',
      orgUnitId: company.id,
      status: 'ACTIVE',
    },
  });
  await prisma.staffRole.upsert({
    where: { staffId_roleId: { staffId: admin.id, roleId: roles['admin'] } },
    update: { tenantId },
    create: { tenantId, staffId: admin.id, roleId: roles['admin'] },
  });

  // fee items: 水费/污水费/水资源费
  const feeItems = [
    { code: 'WATER', name: '水费', calcType: 'PER_QTY' as const },
    { code: 'SEWAGE', name: '污水费', calcType: 'PER_QTY' as const },
    { code: 'WATER_RESOURCE', name: '水资源费', calcType: 'PER_QTY' as const },
  ];
  for (const f of feeItems) {
    await prisma.feeItem.upsert({
      where: { tenantId_code: { tenantId, code: f.code } },
      update: { name: f.name, calcType: f.calcType },
      create: { tenantId, ...f },
    });
  }

  // estimate rule + default tenant params
  await prisma.estimateRule.upsert({
    where: { tenantId_method: { tenantId, method: 'AUTO_AVG3' } },
    update: { enabled: true },
    create: { tenantId, method: 'AUTO_AVG3', params: { window: 3 }, enabled: true },
  });
  const params: Record<string, unknown> = {
    max_consecutive_estimates: 3,
    reconcile_alloc_policy: 'PROPORTIONAL_TO_SETTLED',
    negative_usage_policy: 'CLAMP_REVIEW',
  };
  for (const [key, value] of Object.entries(params)) {
    await prisma.tenantParam.upsert({
      where: { tenantId_key: { tenantId, key } },
      update: { value: value as never },
      create: { tenantId, key, value: value as never },
    });
  }

  return tenantId;
}

async function upsertOrgUnit(
  tenantId: string,
  parentId: string | null,
  name: string,
  type: 'COMPANY' | 'BRANCH' | 'DEPT',
) {
  const existing = await prisma.orgUnit.findFirst({
    where: { tenantId, parentId, name, type },
  });
  if (existing) return existing;
  return prisma.orgUnit.create({ data: { tenantId, parentId, name, type } });
}

async function main() {
  const cd = await seedTenant({ code: 'cd-water', name: '成都水务' });
  const xh = await seedTenant({ code: 'xh-water', name: '西湖水务' });
  console.log(`seeded tenants: cd-water=${cd} xh-water=${xh}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
