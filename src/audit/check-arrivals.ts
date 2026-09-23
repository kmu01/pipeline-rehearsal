import { withTenant } from '../db/client';
import { readManifest, type ManifestBatch } from './manifest';

export interface ArrivalReport {
  batch: ManifestBatch;
  status: 'ARRIVED' | 'MISSING';
}

/**
 * For every batch the manifest promises: has it actually been loaded? "Loaded" means there is a
 * file_ledger row for it, which only exists once loadFile has committed (step 4).
 *
 * Because row-level security (step 7) only lets a query see ONE tenant's rows at a time, this
 * groups the manifest by tenant and asks the question once per tenant, each time inside
 * withTenant. There is no single query that can see every tenant's ledger rows at once -- and
 * that is the point: the same rule that protects a client's data from a coding mistake also
 * shapes how this code has to be written.
 */
export async function checkArrivals(fixturesRoot: string): Promise<ArrivalReport[]> {
  const batches = readManifest(fixturesRoot);
  const byTenant = new Map<string, ManifestBatch[]>();
  for (const batch of batches) {
    if (!byTenant.has(batch.tenant)) byTenant.set(batch.tenant, []);
    byTenant.get(batch.tenant)!.push(batch);
  }

  const reports: ArrivalReport[] = [];
  for (const [tenantId, tenantBatches] of byTenant) {
    const loadedIds = await withTenant(tenantId, async (client) => {
      const rows = await client.query<{ file_id: string }>('SELECT file_id FROM file_ledger');
      return new Set(rows.rows.map((r) => r.file_id));
    });
    for (const batch of tenantBatches) reports.push({ batch, status: loadedIds.has(batch.path) ? 'ARRIVED' : 'MISSING' });
  }
  return reports;
}

export function describeArrivals(reports: ArrivalReport[]): string[] {
  const missing = reports.filter((r) => r.status === 'MISSING');
  const lines = [`${reports.length} expected batch(es): ${reports.length - missing.length} arrived, ${missing.length} missing`];
  for (const r of missing) lines.push(`  MISSING  ${r.batch.path}  (${r.batch.tenant}, ${r.batch.source}, batch ${r.batch.batch})`);
  return lines;
}

/** 0 = every expected batch has arrived. 2 = at least one is missing and a human should look. */
export const exitCodeFor = (reports: ArrivalReport[]): number => (reports.some((r) => r.status === 'MISSING') ? 2 : 0);