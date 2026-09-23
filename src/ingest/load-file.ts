import crypto from 'node:crypto';
import fs from 'node:fs';
import { parse } from 'csv-parse/sync';
import type { SourceType } from '../config/loader';
import { withTenant } from '../db/client';

export interface FileToLoad {
  tenantId: string;
  source: SourceType;
  fileId: string; // the file's path, used as its identity in the ledger.
  absolutePath: string; // where to actually read the bytes from
}

export type LoadResult =
  | { outcome: 'LOADED'; rows: number }
  | { outcome: 'ALREADY_LOADED' }
  | { outcome: 'REFUSED_CHANGED_FILE'; message: string };

/** Thrown on purpose to prove that a crash mid-file leaves nothing behind. Not a real error case. */
export class SimulatedCrash extends Error {}

/**
 * Load one CSV file: every row and the ledger row are written on ONE connection, inside ONE
 * transaction. If anything after BEGIN throws the ROLLBACK undoes all of it.
 */
export async function loadFile(file: FileToLoad, crashAfterRows?: number): Promise<LoadResult> {
  const bytes = fs.readFileSync(file.absolutePath);
  const fileHash = crypto.createHash('sha256').update(bytes).digest('hex');

  // withTenant opens ONE connection, tells Postgres which tenant this transaction may touch, and
  // runs everything below inside that one transaction. Row-level security
  // then makes it IMPOSSIBLE for any query in here to read or write another tenant's rows, even by
  // mistake -- not because our code remembers to filter, but because the database refuses to.
  return withTenant(file.tenantId, async (client) => {
    // Decide what to do BEFORE parsing or inserting anything. This is the replay-safety check:
    // ask the ledger what it already knows about this file_id.
    const prior = (await client.query(`SELECT file_hash FROM file_ledger WHERE file_id = $1`, [file.fileId])).rows[0] as
      | { file_hash: string }
      | undefined;

    if (prior) {
      if (prior.file_hash === fileHash) {
        return { outcome: 'ALREADY_LOADED' }; // same file, seen before: re-running is a no-op, not a re-load
      }
      // Same file_id, different bytes. NOT a replay, could be a correction or a mistake.
      // A human should look, so we refuse instead of guessing.
      return {
        outcome: 'REFUSED_CHANGED_FILE',
        message: `${file.fileId} was already loaded with different content (recorded hash ${prior.file_hash.slice(0, 12)}, this file's hash is ${fileHash.slice(0, 12)}). Investigate before re-running.`,
      };
    }

    const records: Record<string, string>[] = parse(bytes, { columns: true, skip_empty_lines: true });

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

    return { outcome: 'LOADED', rows: records.length };
  });
}