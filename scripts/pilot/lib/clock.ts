/**
 * D1 — PilotClock. Generator-only logical time; never touches
 * production detector behavior (CURRENT_DATE stays the DB's).
 */

import type { Client } from './pg.js';

export interface PilotClock {
  /** Logical date all generated timestamps are relative to. */
  asOf: string;
  /** SELECT CURRENT_DATE at generation start. */
  databaseCurrentDate: string;
  generatedAt: string;
  /**
   * true when asOf !== databaseCurrentDate → results are
   * NOT ELIGIBLE FOR PILOT GATE EVIDENCE (hardening-only).
   */
  clockDrift: boolean;
}

const isoDate = (d: Date | string): string =>
  typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);

export async function loadPilotClock(
  client: Client,
  asOfArg?: string,
): Promise<PilotClock> {
  const { rows } = await client.query<{ current_date: Date | string }>(
    'SELECT CURRENT_DATE',
  );
  const databaseCurrentDate = isoDate(rows[0].current_date);
  const asOf = asOfArg ?? databaseCurrentDate;
  return {
    asOf,
    databaseCurrentDate,
    generatedAt: new Date().toISOString(),
    clockDrift: asOf !== databaseCurrentDate,
  };
}
