import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './client';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));
const LOCK_ID = 727272; // any number; everyone running migrations must use the same one

/**
 * Apply every .sql file in the migrations folder that has not been applied yet, in name order.
 * Returns the names it applied (an empty list means "already up to date"). Safe to run repeatedly.
 */
export async function migrate(dir: string = MIGRATIONS_DIR): Promise<string[]> {
  // pool.connect() hands us ONE connection and keeps it until release(). The lock and the
  // BEGIN/COMMIT below only make sense if every statement runs on that same connection.
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    // If two people run migrate at once, the second waits here instead of racing the first.
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);

    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version as string));

    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT'); // the file's changes and the "applied" note appear together, or not at all
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed and was rolled back: ${(err as Error).message}`);
      }
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    client.release();
  }
}