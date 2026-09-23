import crypto from 'node:crypto';
import fs from 'node:fs';
import { parse } from 'csv-parse/sync';
import type { PoolClient } from 'pg';
import type { SourceConfig, SourceType } from '../config/loader';
import { withTenant } from '../db/client';
import { checkHeader, readHeader, type DriftEvent } from './check-header';

export interface FileToLoad {
  tenantId: string;
  source: SourceType;
  sourceConfig: SourceConfig; // this tenant's expected columns and declared aliases for `source`
  fileId: string;
  absolutePath: string;
}

export type LoadResult =
  | { outcome: 'LOADED'; rows: number }
  | { outcome: 'ALREADY_LOADED' }
  | { outcome: 'REFUSED_CHANGED_FILE'; message: string }
  | { outcome: 'QUARANTINED'; rows: number; message: string };

export class SimulatedCrash extends Error {}

/**
 * Load one CSV file. If the header matches what the tenant's config expects (directly, or
 * through a declared alias), everything commits together in one transaction, as before. If the
 * header does NOT match, the file is QUARANTINED: raw rows are still kept as evidence, but the
 * ledger says so, with a reason a human can act on.
 */
export async function loadFile(file: FileToLoad, crashAfterRows?: number): Promise<LoadResult> {
  const bytes = fs.readFileSync(file.absolutePath);
  const fileHash = crypto.createHash('sha256').update(bytes).digest('hex');

  return withTenant(file.tenantId, async (client) => {
    const prior = (await client.query(`SELECT file_hash, status FROM file_ledger WHERE file_id = $1`, [file.fileId])).rows[0] as
      | { file_hash: string; status: 'LOADED' | 'QUARANTINED' }
      | undefined;

    if (prior && prior.file_hash !== fileHash) {
      return {
        outcome: 'REFUSED_CHANGED_FILE',
        message: `${file.fileId} was already loaded with different content (recorded hash ${prior.file_hash.slice(0, 12)}, this file's hash is ${fileHash.slice(0, 12)}). Investigate before re-running.`,
      };
    }
    if (prior && prior.status === 'LOADED') {
      return { outcome: 'ALREADY_LOADED' };
    }
    // Never seen before, OR quarantined last time with these same bytes: re-check the header
    // either way, in case the tenant's config was fixed since the last attempt.

    const header = readHeader(bytes);
    const check = checkHeader(file.sourceConfig, header);
    const status = check.ok ? 'LOADED' : 'QUARANTINED';

    let rowCount: number;
    if (!prior) {
      // GOTCHA 1: ledger row must be written BEFORE raw rows (the foreign key requires it).
      const records: Record<string, string>[] = parse(bytes, { columns: true, skip_empty_lines: true });
      rowCount = records.length;
      await upsertLedger(client, file, fileHash, status, rowCount, check.problem ?? null);
      for (let i = 0; i < records.length; i++) {
        await client.query(
          `INSERT INTO raw_records (tenant_id, file_id, line_no, source, payload) VALUES ($1, $2, $3, $4, $5)`,
          [file.tenantId, file.fileId, i + 1, file.source, JSON.stringify(records[i])],
        );
        if (crashAfterRows !== undefined && i + 1 >= crashAfterRows) {
          throw new SimulatedCrash(`simulated crash after ${i + 1} of ${records.length} rows`);
        }
      }
    } else {
      // Retrying a quarantined file, same bytes: raw rows are already there from the first attempt.
      rowCount = (await client.query(`SELECT count(*)::int AS n FROM raw_records WHERE tenant_id = $1 AND file_id = $2`, [file.tenantId, file.fileId])).rows[0].n;
      await upsertLedger(client, file, fileHash, status, rowCount, check.problem ?? null);
    }

    // Record every attempt, not just the final one: the history should show "quarantined, then
    // fixed", not just the happy ending.
    await insertDriftEvents(client, file, check.events);

    return check.ok ? { outcome: 'LOADED', rows: rowCount } : { outcome: 'QUARANTINED', rows: rowCount, message: check.problem! };
  });
}

async function insertDriftEvents(client: PoolClient, file: FileToLoad, events: DriftEvent[]): Promise<void> {
  for (const e of events) {
    await client.query(
      `INSERT INTO schema_drift_events (tenant_id, file_id, source, original_column, canonical_column, action) VALUES ($1, $2, $3, $4, $5, $6)`,
      [file.tenantId, file.fileId, file.source, e.originalColumn, e.canonicalColumn, e.action],
    );
  }
}

async function upsertLedger(client: PoolClient, file: FileToLoad, fileHash: string, status: 'LOADED' | 'QUARANTINED', rowCount: number, detail: string | null): Promise<void> {
  await client.query(
    `INSERT INTO file_ledger (tenant_id, file_id, source, file_hash, row_count, status, detail) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id, file_id) DO UPDATE SET status = EXCLUDED.status, detail = EXCLUDED.detail, row_count = EXCLUDED.row_count`,
    [file.tenantId, file.fileId, file.source, fileHash, rowCount, status, detail],
  );
}