import fs from 'node:fs';
import path from 'node:path';
import { pool } from '../db/client';
import { readManifest, type ManifestBatch } from './manifest';

export interface ArrivalReport {
  batch: ManifestBatch;
  status: 'ARRIVED' | 'MISSING';
}

/**
 * For every batch the manifest promises: has it actually been loaded? "Loaded" means there is a
 * file_ledger row for it, which only exists once loadFile has committed. 
 * A file sitting on disk but never loaded still counts as MISSING.
 */
export async function checkArrivals(fixturesRoot: string): Promise<ArrivalReport[]> {
  const batches = readManifest(fixturesRoot);
  const loaded = await pool.query<{ tenant_id: string; file_id: string }>('SELECT tenant_id, file_id FROM file_ledger');
  const loadedSet = new Set(loaded.rows.map((r) => `${r.tenant_id}\u0000${r.file_id}`));

  return batches.map((batch) => ({
    batch,
    status: loadedSet.has(`${batch.tenant}\u0000${batch.path}`) ? 'ARRIVED' : 'MISSING',
  }));
}

export function describeArrivals(reports: ArrivalReport[]): string[] {
  const missing = reports.filter((r) => r.status === 'MISSING');
  const lines = [`${reports.length} expected batch(es): ${reports.length - missing.length} arrived, ${missing.length} missing`];
  for (const r of missing) lines.push(`  MISSING  ${r.batch.path}  (${r.batch.tenant}, ${r.batch.source}, batch ${r.batch.batch})`);
  return lines;
}

/** 0 = every expected batch has arrived. 2 = at least one is missing and a human should look. */
export const exitCodeFor = (reports: ArrivalReport[]): number => (reports.some((r) => r.status === 'MISSING') ? 2 : 0);