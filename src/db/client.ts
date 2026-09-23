import { Pool, type PoolClient } from 'pg';

const ADMIN_URL = process.env.DATABASE_URL_ADMIN ?? 'postgres://pipeline_admin:pipeline_password@localhost:5432/pipeline';
const APP_URL = process.env.DATABASE_URL ?? 'postgres://pipeline_app:pipeline_app_password@localhost:5432/pipeline';

/**
 * The owner/superuser connection. Used ONLY by the migration runner. Superusers bypass row-level
 * security entirely (we prove this below), so nothing that touches client data should ever use it.
 */
export const adminPool = new Pool({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3000 });

/**
 * The connection every part of the program that touches tenant data uses. This role has row-level
 * security enforced against it, so a query on this pool with no
 * tenant selected sees nothing, and a query scoped to tenant A cannot see tenant B's rows.
 */
export const appPool = new Pool({ connectionString: APP_URL, connectionTimeoutMillis: 3000 });

for (const p of [adminPool, appPool]) p.on('error', (err) => console.error('Idle database connection error:', err.message));

export interface RetryOptions {
  maxAttempts?: number;
  delayMs?: number;
}

/** Wait until a pool's target accepts connections. */
export async function connectWithRetry(p: Pool, { maxAttempts = 15, delayMs = 1000 }: RetryOptions = {}): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const client = await p.connect();
      client.release();
      return;
    } catch (err) {
      if (attempt === maxAttempts) throw new Error(`Could not connect to Postgres after ${maxAttempts} attempts: ${(err as Error).message}`);
      console.log(`Waiting for Postgres (attempt ${attempt}/${maxAttempts})...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/**
 * The ONLY way production code should talk to tenant data. It opens one transaction on the
 * appPool, tells Postgres which tenant this transaction is allowed to see (`app.current_tenant`),
 * runs your callback, then commits (or rolls back on error). Because the setting is applied with
 * `set_config(..., true)`, it is local to this one transaction: it cannot leak into whatever the
 * next borrower of this pooled connection does.
 */
export async function withTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}