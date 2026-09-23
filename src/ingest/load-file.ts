import crypto from 'node:crypto';
import fs from 'node:fs';
import { parse } from 'csv-parse/sync';
import type { PoolClient } from 'pg';
import type { SourceType } from '../config/loader';
import { pool } from '../db/client';

export interface FileToLoad {
  tenantId: string;
  source: SourceType;
  fileId: string; // the file's path, used as its identity in the ledger
  absolutePath: string; // where to actually read the bytes from
}

export type LoadResult = { outcome: 'LOADED'; rows: number } | { outcome: 'ALREADY_LOADED' };

/** Thrown on purpose to prove that a crash mid-file leaves nothing behind. Not a real error case. */
export class SimulatedCrash extends Error {}

/**
 * Load one CSV file: every row and the ledger row are written on ONE connection, inside ONE
 * transaction. If anything after BEGIN throws the ROLLBACK undoes all of it.
 */
export async function loadFile(file: FileToLoad, crashAfterRows?: number): Promise<LoadResult> {
  const bytes = fs.readFileSync(file.absolutePath);
  const fileHash = crypto.createHash('sha256').update(bytes).digest('hex');
  const records: Record<string, string>[] = parse(bytes, { columns: true, skip_empty_lines: true });

  // pool.connect() gives us ONE connection to hold for the whole file. Every query below runs on
  // it, so BEGIN/COMMIT/ROLLBACK all apply to the same session. 
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');

    // Written FIRST: raw_records' foreign key requires this row to already exist.
    await client.query(
      `INSERT INTO file_ledger (tenant_id, file_id, source, file_hash, row_count) VALUES ($1, $2, $3, $4, $5)`,
      [file.tenantId, file.fileId, file.source, fileHash, records.length],
    );

    for (let i = 0; i < records.length; i++) {
      await client.query(
        `INSERT INTO raw_records (tenant_id, file_id, line_no, source, payload) VALUES ($1, $2, $3, $4, $5)`,
        [file.tenantId, file.fileId, i + 1, file.source, JSON.stringify(records[i])],
      );
      // Test-only hook: pretend the process died partway through the file.
      if (crashAfterRows !== undefined && i + 1 >= crashAfterRows) {
        throw new SimulatedCrash(`simulated crash after ${i + 1} of ${records.length} rows`);
      }
    }

    await client.query('COMMIT');
    return { outcome: 'LOADED', rows: records.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}