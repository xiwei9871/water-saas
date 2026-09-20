import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
export const runId = process.env.PILOT_RUN_ID || 'p20260919a';
if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('Invalid PILOT_RUN_ID');
export const runDir = resolve('artifacts/pilot',runId);
mkdirSync(runDir,{recursive:true});
export interface PilotState { runId:string; prefix:string; periods:string[]; stages:Record<string,boolean>; people:any[]; books:any[]; tariffs:any[]; plans:Record<string,any>; readings:Record<string,any>; settlements:Record<string,any>; bills:any[]; payments:any[]; roles:Record<string,any>; [key:string]:any }
const file=resolve(runDir,'state.json');
export function load():PilotState { return existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{runId,prefix:'P-'+runId,periods:['202607','202608','202609'],stages:{},people:[],books:[],tariffs:[],plans:{},readings:{},settlements:{},bills:[],payments:[],roles:{}}; }
export function save(s:PilotState) { writeFileSync(file+'.tmp',JSON.stringify(s,null,2));renameSync(file+'.tmp',file); }
export function record(kind:string,value:unknown) { const f=resolve(runDir,kind+'.json');const rows=existsSync(f)?JSON.parse(readFileSync(f,'utf8')):[];rows.push(value);writeFileSync(f,JSON.stringify(rows,null,2)); }
