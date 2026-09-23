import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminPool } from './client';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));
const LOCK_ID = 727272;
const APP_ROLE = 'pipeline_app';

/**
 * Apply every unapplied migration, in name order, then (re)create the restricted app role and make
 * sure it can use whatever tables exist. Uses adminPool: creating a role and altering permissions
 * needs owner privileges that the app role itself must never have.
 */
export async function migrate(dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const client = await adminPool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);

    // The app role's password comes from the environment, never from a committed SQL file.
    const password = client.escapeLiteral(process.env.APP_DB_PASSWORD ?? 'pipeline_app_password');
    const exists = (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APP_ROLE])).rowCount! > 0;
    // NOSUPERUSER and NOBYPASSRLS are the two flags that actually matter: without them, this role
    // would ignore row-level security exactly like the admin role does.
    await client.query(`${exists ? 'ALTER' : 'CREATE'} ROLE ${APP_ROLE} LOGIN PASSWORD ${password} NOSUPERUSER NOBYPASSRLS`);

    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map((r: { version: string }) => r.version));

    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed and was rolled back: ${(err as Error).message}`);
      }
    }

    // Grants run every time, not just on first create, so a table added by a LATER migration is
    // still reachable by the app role without a separate manual step.
    await client.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await client.query(`GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`);
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    client.release();
  }
}