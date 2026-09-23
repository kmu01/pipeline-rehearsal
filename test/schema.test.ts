import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminPool as pool } from '../src/db/client';
import { migrate } from '../src/db/migrate';

// Needs the database running (`podman compose up -d`). Uses throwaway tenants named sch_test_*.
const A = 'sch_test_a';
const B = 'sch_test_b';

const addLedger = (tenant: string, file = 'orders/batch_01.csv') =>
  pool.query(`INSERT INTO file_ledger (tenant_id, file_id, source, file_hash, row_count) VALUES ($1, $2, 'orders', 'abc123', 3)`, [tenant, file]);
const addRaw = (tenant: string, file = 'orders/batch_01.csv', line = 1) =>
  pool.query(`INSERT INTO raw_records (tenant_id, file_id, line_no, source, payload) VALUES ($1, $2, $3, 'orders', '{}')`, [tenant, file, line]);

/** Run something that should fail and return Postgres's error code (23505 = duplicate key, 23503 = foreign key violation). */
async function errorCode(work: Promise<unknown>): Promise<string | null> {
  try {
    await work;
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
}

const cleanup = async () => {
  await pool.query(`DELETE FROM raw_records WHERE tenant_id LIKE 'sch_test_%'`); // raw first: it points at the ledger
  await pool.query(`DELETE FROM file_ledger WHERE tenant_id LIKE 'sch_test_%'`);
};

beforeAll(async () => {
  await migrate();
});
beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe('migrations', () => {
  it('are repeatable: running them again applies nothing', async () => {
    expect(await migrate()).toEqual([]);
  });

  it('a migration that fails half way leaves nothing behind', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bad-migration-'));
    fs.writeFileSync(path.join(dir, '900_broken.sql'), 'CREATE TABLE should_not_survive (x int); SELECT * FROM a_table_that_does_not_exist;');

    await expect(migrate(dir)).rejects.toThrow(/900_broken\.sql failed and was rolled back/);

    const table = await pool.query(`SELECT to_regclass('public.should_not_survive') AS t`);
    expect(table.rows[0].t).toBeNull(); // the CREATE TABLE before the error was undone
    const noted = await pool.query(`SELECT 1 FROM schema_migrations WHERE version = '900_broken.sql'`);
    expect(noted.rowCount).toBe(0); // and it was not recorded as applied
  });

  it('the file’s changes and its "applied" note are all-or-nothing together', async () => {
    // This file succeeds by itself, but it writes its OWN "applied" note first, so the runner's note
    // afterwards fails (duplicate key). If the runner did not wrap both in one transaction, the file's
    // changes would already be committed by then, and we would be left with a half-applied migration.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sneaky-migration-'));
    fs.writeFileSync(path.join(dir, '902_sneaky.sql'), `INSERT INTO schema_migrations (version) VALUES ('902_sneaky.sql'); CREATE TABLE should_not_survive_2 (x int);`);
    try {
      await expect(migrate(dir)).rejects.toThrow(/902_sneaky\.sql failed and was rolled back/);
      const table = await pool.query(`SELECT to_regclass('public.should_not_survive_2') AS t`);
      expect(table.rows[0].t).toBeNull();
      expect((await pool.query(`SELECT 1 FROM schema_migrations WHERE version = '902_sneaky.sql'`)).rowCount).toBe(0);
    } finally {
      await pool.query('DROP TABLE IF EXISTS should_not_survive_2'); // only matters if the code above is broken
      await pool.query(`DELETE FROM schema_migrations WHERE version = '902_sneaky.sql'`);
    }
  });
});

describe('every key starts with tenant_id, so clients cannot collide', () => {
  it('two tenants may have a file with the same path', async () => {
    await addLedger(A);
    await addLedger(B);
    const r = await pool.query(`SELECT count(*)::int AS n FROM file_ledger WHERE file_id = 'orders/batch_01.csv' AND tenant_id LIKE 'sch_test_%'`);
    expect(r.rows[0].n).toBe(2);
  });

  it('one tenant cannot load the same path twice', async () => {
    await addLedger(A);
    expect(await errorCode(addLedger(A))).toBe('23505');
  });

  it('a record position in a file can only be used once', async () => {
    await addLedger(A);
    await addRaw(A, 'orders/batch_01.csv', 1);
    expect(await errorCode(addRaw(A, 'orders/batch_01.csv', 1))).toBe('23505');
  });
});

describe('the database refuses rows that point at the wrong place', () => {
  it('a raw record needs a ledger row for its file', async () => {
    expect(await errorCode(addRaw(A, 'orders/never_loaded.csv'))).toBe('23503');
  });

  it('a raw record cannot borrow ANOTHER tenant’s ledger row', async () => {
    await addLedger(A, 'orders/batch_01.csv');
    // tenant B tries to attach a record to a file that only tenant A has
    expect(await errorCode(addRaw(B, 'orders/batch_01.csv'))).toBe('23503');
  });
});