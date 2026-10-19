// One-time fresh database bootstrap. Never run against an existing tenant DB.
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const {PrismaClient} = require('@prisma/client');
const {Client} = require('pg');
const bcrypt = require('bcrypt');
const ownerUrl = process.env.MIGRATION_DATABASE_URL;
const runtimeUrl = process.env.DATABASE_URL;
const passwords = {'cd-water': process.env.WATER_ADMIN_CD_PASSWORD, 'xh-water': process.env.WATER_ADMIN_XH_PASSWORD};
if (process.env.WATER_BOOTSTRAP !== '1' || !ownerUrl || !runtimeUrl ||
    Object.values(passwords).some(p => !p || p.length < 20)) throw Error('Explicit fresh bootstrap and strong passwords required');
const runtime = new URL(runtimeUrl);
if (runtime.username !== 'ws_app' || runtime.pathname !== '/water_pilot' ||
    new URL(ownerUrl).pathname !== runtime.pathname || decodeURIComponent(runtime.password).length < 32) {
  throw Error('Unexpected runtime database identity');
}
const prisma = new PrismaClient({datasourceUrl: ownerUrl});
const pg = new Client({connectionString: ownerUrl});
try {
  if (await prisma.tenant.count() !== 0) throw Error('Refusing to seed or reset existing tenants');
  const seed = spawnSync('pnpm', ['exec', 'prisma', 'db', 'seed'], {
    cwd: new URL('../apps/api/', import.meta.url), env: process.env, stdio: 'inherit',
  });
  if (seed.status !== 0) throw Error('Seed failed; application must remain unpublished');
  for (const [code, password] of Object.entries(passwords)) {
    const tenant = await prisma.tenant.findUniqueOrThrow({where: {code}});
    await prisma.staff.update({where: {tenantId_login: {tenantId: tenant.id, login: 'admin'}},
      data: {passwordHash: await bcrypt.hash(password, 12)}});
  }
  await pg.connect();
  const {rows} = await pg.query("SELECT format('ALTER ROLE ws_app PASSWORD %L NOSUPERUSER NOBYPASSRLS NOINHERIT', $1::text) AS statement", [decodeURIComponent(runtime.password)]);
  await pg.query(rows[0].statement);
  console.log('Fresh tenant configuration initialized; both admin and runtime credentials rotated.');
} finally { await prisma.$disconnect(); await pg.end(); }
