import { Pool } from 'pg';

const DEFAULT_URL = 'postgres://pipeline_admin:pipeline_password@localhost:5432/pipeline';

/** One shared pool of database connections for the whole program. */
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? DEFAULT_URL,
  connectionTimeoutMillis: 3000, // give up on a single attempt after 3s instead of hanging
});

// Handle dropped connections gracefully.
pool.on('error', (err) => console.error('Idle database connection error:', err.message));

export interface RetryOptions {
  maxAttempts?: number;
  delayMs?: number;
}

/**
 * Wait until Postgres accepts connections. A container is "started" a few seconds before the
 * database inside it is ready, so the first attempt often fails. That is normal, not an error.
 */
export async function connectWithRetry(p: typeof pool, { maxAttempts = 15, delayMs = 1000 }: RetryOptions = {}): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const client = await p.connect();
      client.release(); // give the connection back to the pool; we only wanted to know it works
      return;
    } catch (err) {
      if (attempt === maxAttempts) {
        throw new Error(`Could not connect to Postgres after ${maxAttempts} attempts: ${(err as Error).message}`);
      }
      console.log(`Waiting for Postgres (attempt ${attempt}/${maxAttempts})...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}