import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const requireApi = createRequire(resolve('apps/api/package.json'));
const { PrismaClient } = requireApi('@prisma/client');
const bcrypt = requireApi('bcrypt');
const databaseName = process.env.UAT_DATABASE_NAME ?? 'water_uat_v011';
if (!['water_uat_v011', 'water_pilot_fix_uat_v012', 'water_recovery_uat_20260920', 'water_uat_v02', 'water_uat_e5', 'water_uat_e6', 'water_uat_e7', 'water_uat_e8'].includes(databaseName)) throw new Error('Refusing non-UAT database');
export const ownerUrl = `postgresql://postgres:postgres@localhost:5432/${databaseName}`;
export async function db<T>(run: (prisma: any) => Promise<T>): Promise<T> {
  const prisma = new PrismaClient({ datasourceUrl: ownerUrl });
  try {
    const [identity] = await prisma.$queryRawUnsafe('SELECT current_database() AS name');
    if (identity.name !== databaseName) throw new Error('Refusing non-UAT database');
    return await run(prisma);
  } finally { await prisma.$disconnect(); }
}
export async function roleFixtures() {
  return db(async p => {
    const tenant = await p.tenant.findUniqueOrThrow({ where: { code: 'cd-water' } });
    const org = await p.orgUnit.findFirstOrThrow({ where: { tenantId: tenant.id, type: 'COMPANY' } });
    const passwordHash = await bcrypt.hash('uat12345', 10);
    for (const code of ['reader', 'cashier', 'reviewer']) {
      const role = await p.role.findUniqueOrThrow({ where: { tenantId_code: { tenantId: tenant.id, code } } });
      const data = { tenantId: tenant.id, orgUnitId: org.id, login: 'uat-' + code, name: 'UAT ' + code, passwordHash, status: 'ACTIVE' };
      const staff = await p.staff.upsert({ where: { tenantId_login: { tenantId: tenant.id, login: data.login } }, create: data, update: data });
      await p.staffRole.upsert({ where: { staffId_roleId: { staffId: staff.id, roleId: role.id } }, create: { tenantId: tenant.id, staffId: staff.id, roleId: role.id }, update: {} });
    }
  });
}
export async function cleanPeriod() {
  return db(async p => {
    const now = new Date();
    for (let n = 0; n < 2; n++) {
      const d = new Date(now.getFullYear(), now.getMonth() + n, 1);
      const period = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
      const counts = await Promise.all([p.readingPlan.count({ where: { period } }), p.consumptionSettlement.count({ where: { period } }), p.billingRun.count({ where: { period } })]);
      if (counts.every(x => x === 0)) return period;
    }
    throw new Error('Current and next month both used; reset only this session-owned UAT DB before rerun');
  });
}
