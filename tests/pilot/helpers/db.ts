import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const req=createRequire(resolve('apps/api/package.json'));
const { PrismaClient }=req('@prisma/client');
const databaseName=process.env.PILOT_DATABASE_NAME??'water_pilot_v012';
if(!['water_pilot_v012','water_pilot_fix_replay_v012'].includes(databaseName))throw new Error('Refusing non-Pilot database');
export const bcrypt=req('bcrypt');
export async function db<T>(fn:(p:any)=>Promise<T>):Promise<T>{
 const p=new PrismaClient({datasourceUrl:`postgresql://postgres:postgres@localhost:5432/${databaseName}`});
 try { const [r]=await p.$queryRawUnsafe('SELECT current_database() AS name'); if(r.name!==databaseName)throw new Error('Refusing non-Pilot database');return await fn(p); }finally{await p.$disconnect();}
}
