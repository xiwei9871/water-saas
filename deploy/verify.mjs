// Read-only runtime/RLS verification; no owner URL or login secret is printed.
import {createRequire} from 'node:module';
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const {Client} = require('pg');
const expectedDatabase = process.env.WATER_EXPECTED_DATABASE ?? 'water_pilot';
const db = new Client({connectionString: process.env.DATABASE_URL});
try {
  await db.connect();
  const {rows: [role]} = await db.query(`SELECT current_user AS name, current_database() AS database,
    rolsuper, rolbypassrls, rolinherit FROM pg_roles WHERE rolname=current_user`);
  if (role.name !== 'ws_app' || role.database !== expectedDatabase || role.rolsuper || role.rolbypassrls || role.rolinherit) throw Error('Unsafe runtime role');
  const {rows: [ownership]} = await db.query(`SELECT count(*)::int AS owned FROM pg_class
    WHERE relnamespace='public'::regnamespace AND relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)`);
  if (ownership.owned !== 0) throw Error('Runtime role owns schema objects');
  const {rows: [scope]} = await db.query('SELECT count(*)::int AS visible FROM customer');
  if (scope.visible !== 0) throw Error('Rows visible without tenant context');
  const {rows: [rls]} = await db.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid='customer'::regclass`);
  if (!rls.relrowsecurity || !rls.relforcerowsecurity) throw Error('Customer RLS is not forced');
  console.log(JSON.stringify({runtimeRole: role.name, database: role.database, owner:false, bypassRLS:false, forcedRLS:true}));
} finally { await db.end(); }
