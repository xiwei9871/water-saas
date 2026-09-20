/** Add only the QC grant for one explicitly selected tenant; never rerun seed on live data. */
import { PrismaClient } from '@prisma/client';
const url = process.env.MIGRATION_DATABASE_URL;
const tenantCode = process.argv[2];
if (!url || !tenantCode)
  throw new Error('Set MIGRATION_DATABASE_URL and pass the tenant code');
const prisma = new PrismaClient({ datasourceUrl: url });
try {
  await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { code: tenantCode },
    });
    const role = await tx.role.findUniqueOrThrow({
      where: { tenantId_code: { tenantId: tenant.id, code: 'reviewer' } },
    });
    const permission = await tx.permission.upsert({
      where: { tenantId_code: { tenantId: tenant.id, code: 'metering:qc' } },
      update: {},
      create: { tenantId: tenant.id, code: 'metering:qc', type: 'ACTION' },
    });
    await tx.rolePermission.upsert({
      where: {
        roleId_permissionId: { roleId: role.id, permissionId: permission.id },
      },
      update: {},
      create: {
        tenantId: tenant.id,
        roleId: role.id,
        permissionId: permission.id,
      },
    });
  });
  console.log(
    `QC permission ready for ${tenantCode}/reviewer; sign in again to refresh permissions.`,
  );
} finally {
  await prisma.$disconnect();
}
