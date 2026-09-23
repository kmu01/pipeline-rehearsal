import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { connectWithRetry, pool } from '../src/db/client';

// These tests need the database to be running: `podman compose up -d`.
afterAll(async () => {
  await pool.end();
});

describe('connectWithRetry', () => {
  it('succeeds when the database is reachable', async () => {
    await expect(connectWithRetry(pool, { maxAttempts: 3, delayMs: 100 })).resolves.toBeUndefined();
    const { rows } = await pool.query('SELECT 1 AS ok');
    expect(rows[0].ok).toBe(1);
  });

  it('gives up when the database is not there', async () => {
    const nobodyHome = new Pool({ connectionString: 'postgres://nobody@127.0.0.1:1/none', connectionTimeoutMillis: 200 });
    await expect(connectWithRetry(nobodyHome, { maxAttempts: 2, delayMs: 10 })).rejects.toThrow(/Could not connect to Postgres after 2 attempts/);
    await nobodyHome.end();
  });
});