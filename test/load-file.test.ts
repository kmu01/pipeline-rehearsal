import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminPool as pool } from '../src/db/client';
import { migrate } from '../src/db/migrate';
import { loadFile, SimulatedCrash } from '../src/ingest/load-file';

// Throwaway tenant. A fresh temp file per test, so tests never share state through the filesystem.
const TENANT = 'load_test_a';
let dir: string;

function writeOrders(rowCount: number): string {
  const header = 'order_id,created_at,channel,gross,currency,customer_email';
  const rows = Array.from({ length: rowCount }, (_, i) => `LU-${i + 1},2026-01-06T10:00:00Z,Meta,10.00,EUR,a@example.invalid`);
  const file = path.join(dir, 'orders.csv');
  fs.writeFileSync(file, [header, ...rows].join('\n') + '\n');
  return file;
}

const rawCount = async () => (await pool.query('SELECT count(*)::int AS n FROM raw_records WHERE tenant_id = $1', [TENANT])).rows[0].n as number;
const ledgerCount = async () => (await pool.query('SELECT count(*)::int AS n FROM file_ledger WHERE tenant_id = $1', [TENANT])).rows[0].n as number;

beforeAll(async () => {
  await migrate();
});
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'load-file-'));
  await pool.query('DELETE FROM raw_records WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM file_ledger WHERE tenant_id = $1', [TENANT]);
});
afterAll(async () => {
  await pool.query('DELETE FROM raw_records WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM file_ledger WHERE tenant_id = $1', [TENANT]);
  await pool.end();
});

describe('loadFile', () => {
  it('loads every row and one ledger row for a normal file', async () => {
    const file = writeOrders(3);
    const result = await loadFile({ tenantId: TENANT, source: 'orders', fileId: 'orders/batch_01.csv', absolutePath: file });
    expect(result).toEqual({ outcome: 'LOADED', rows: 3 });
    expect(await rawCount()).toBe(3);
    expect(await ledgerCount()).toBe(1);
  });

  it('THE central guarantee: a crash part way through leaves NOTHING behind', async () => {
    const file = writeOrders(10);
    await expect(
      loadFile({ tenantId: TENANT, source: 'orders', fileId: 'orders/batch_01.csv', absolutePath: file }, 6), // crash after row 6 of 10
    ).rejects.toThrow(SimulatedCrash);

    expect(await rawCount()).toBe(0);
    expect(await ledgerCount()).toBe(0);
  });

  it('after a crash, loading the SAME file again succeeds and inserts every row exactly once', async () => {
    const file = writeOrders(10);
    await expect(loadFile({ tenantId: TENANT, source: 'orders', fileId: 'orders/batch_01.csv', absolutePath: file }, 6)).rejects.toThrow(SimulatedCrash);

    const result = await loadFile({ tenantId: TENANT, source: 'orders', fileId: 'orders/batch_01.csv', absolutePath: file });
    expect(result).toEqual({ outcome: 'LOADED', rows: 10 });
    expect(await rawCount()).toBe(10); // not 16: nothing from the crashed attempt should have survived to double up.
    expect(await ledgerCount()).toBe(1);
  });
});

describe('loadFile: replay safety', () => {
  it('loading the same file a second time is a no-op, not a re-load', async () => {
    const file = writeOrders(3);
    const first = await loadFile({ tenantId: TENANT, source: 'orders', fileId: 'orders/batch_01.csv', absolutePath: file });
    expect(first).toEqual({ outcome: 'LOADED', rows: 3 });

    const second = await loadFile({ tenantId: TENANT, source: 'orders', fileId: 'orders/batch_01.csv', absolutePath: file });
    expect(second).toEqual({ outcome: 'ALREADY_LOADED' });
    expect(await rawCount()).toBe(3); // still 3, not 6
    expect(await ledgerCount()).toBe(1);
  });

  it('the SAME file_id with DIFFERENT bytes is refused, not silently reloaded', async () => {
    const file = writeOrders(3);
    await loadFile({ tenantId: TENANT, source: 'orders', fileId: 'orders/batch_01.csv', absolutePath: file });

    const changedFile = writeOrders(5); // a different file, same path we will claim as the SAME file_id
    const result = await loadFile({ tenantId: TENANT, source: 'orders', fileId: 'orders/batch_01.csv', absolutePath: changedFile });

    expect(result.outcome).toBe('REFUSED_CHANGED_FILE');
    expect(await rawCount()).toBe(3); // unchanged: the 5-row version never got in
  });

  it('two tenants loading a file with the SAME name do not interfere with each other', async () => {
    const OTHER_TENANT = 'load_test_b';
    await pool.query('DELETE FROM raw_records WHERE tenant_id = $1', [OTHER_TENANT]);
    await pool.query('DELETE FROM file_ledger WHERE tenant_id = $1', [OTHER_TENANT]);

    const file = writeOrders(3);
    await loadFile({ tenantId: TENANT, source: 'orders', fileId: 'orders/batch_01.csv', absolutePath: file });
    const otherResult = await loadFile({ tenantId: OTHER_TENANT, source: 'orders', fileId: 'orders/batch_01.csv', absolutePath: file });

    expect(otherResult).toEqual({ outcome: 'LOADED', rows: 3 }); // NOT "already loaded": that was a different tenant
    await pool.query('DELETE FROM raw_records WHERE tenant_id = $1', [OTHER_TENANT]);
    await pool.query('DELETE FROM file_ledger WHERE tenant_id = $1', [OTHER_TENANT]);
  });

  it('a crash still leaves nothing behind, even with the replay check in place', async () => {
    const file = writeOrders(10);
    await expect(loadFile({ tenantId: TENANT, source: 'orders', fileId: 'orders/batch_01.csv', absolutePath: file }, 6)).rejects.toThrow(SimulatedCrash);
    expect(await rawCount()).toBe(0);
    expect(await ledgerCount()).toBe(0);
  });
});