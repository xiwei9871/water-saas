import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * System-flow run state — checkpoints live under
 * artifacts/system-flow/<runId>/ (gitignored evidence). Same contract as
 * the frozen pilot suite: a write that lands is recorded IMMEDIATELY so a
 * rerun never replays an ambiguous financial/billing mutation.
 */
export const runId = process.env.SF_RUN_ID || 'sf-local';
if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('Invalid SF_RUN_ID');
export const runDir = resolve('artifacts/system-flow', runId);
mkdirSync(runDir, { recursive: true });

export interface FlowState {
  runId: string;
  tenantId?: string;
  companyOrgId?: string;
  branches: { id: string; name: string }[];
  roles: Record<string, { id: string; login: string; name: string }>;
  periods: string[];
  people: any[];           // onboard results: customer/settleAccount/waterAccount/meter/installation
  books: any[];            // {id, name, bookNo, orgUnitId}
  plans: Record<string, any>;
  readings: Record<string, any>;
  settlements: Record<string, any>;
  bills: any[];            // {id, waterAccountId, settleAccountId, period, totalAmount, status}
  payments: any[];         // {id, settleAccountId, amount, allocs[], channel, cashier}
  reversals: any[];
  dayCloses: Record<string, any>;
  exceptions: Record<string, any>;
  stages: Record<string, boolean>;
  [key: string]: any;
}

const file = resolve(runDir, 'state.json');
export function load(): FlowState {
  return existsSync(file)
    ? JSON.parse(readFileSync(file, 'utf8'))
    : { runId, branches: [], roles: {}, periods: ['202607', '202608'], people: [], books: [], plans: {}, readings: {}, settlements: {}, bills: [], payments: [], reversals: [], dayCloses: {}, exceptions: {}, stages: {} };
}
export function save(s: FlowState) {
  writeFileSync(file + '.tmp', JSON.stringify(s, null, 2));
  renameSync(file + '.tmp', file);
}
export function record(kind: string, value: unknown) {
  const f = resolve(runDir, kind + '.json');
  const rows = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [];
  rows.push(value);
  writeFileSync(f, JSON.stringify(rows, null, 2));
}
