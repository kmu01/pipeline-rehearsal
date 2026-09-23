import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkArrivals, describeArrivals, exitCodeFor } from '../src/audit/check-arrivals';
import { adminPool as pool } from '../src/db/client';
import { migrate } from '../src/db/migrate';
import { loadFile } from '../src/ingest/load-file';

const TENANT = 'check_test_a';
let dir: string;

function manifest(batches: { tenant: string; source: string; batch: number; path: string }[]): string {
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ batches }));
  return dir;
}
function csv(relPath: string): string {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'order_id,created_at,channel,gross,currency,customer_email\nLU-1,2026-01-06T10:00:00Z,Meta,10.00,EUR,a@example.invalid\n');
  return abs;
}

beforeAll(async () => {
  await migrate();
});
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-'));
  await pool.query('DELETE FROM raw_records WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM file_ledger WHERE tenant_id = $1', [TENANT]);
});
afterAll(async () => {
  await pool.query('DELETE FROM raw_records WHERE tenant_id = $1', [TENANT]);
  await pool.query('DELETE FROM file_ledger WHERE tenant_id = $1', [TENANT]);
  await pool.end();
});

describe('checkArrivals', () => {
  it('a batch that was never loaded is MISSING, even if its file sits on disk', async () => {
    csv('orders/batch_01.csv'); // on disk, but never loaded
    const root = manifest([{ tenant: TENANT, source: 'orders', batch: 1, path: 'orders/batch_01.csv' }]);

    const reports = await checkArrivals(root);
    expect(reports).toEqual([{ batch: { tenant: TENANT, source: 'orders', batch: 1, path: 'orders/batch_01.csv' }, status: 'MISSING' }]);
    expect(exitCodeFor(reports)).toBe(2);
  });

  it('a batch that WAS loaded is ARRIVED', async () => {
    const abs = csv('orders/batch_01.csv');
    const root = manifest([{ tenant: TENANT, source: 'orders', batch: 1, path: 'orders/batch_01.csv' }]);
    await loadFile({ tenantId: TENANT, source: 'orders', fileId: 'orders/batch_01.csv', absolutePath: abs });

    const reports = await checkArrivals(root);
    expect(reports[0]!.status).toBe('ARRIVED');
    expect(exitCodeFor(reports)).toBe(0);
  });

  it('one missing batch among several is still reported by name, and still exits non-zero', async () => {
    const abs1 = csv('orders/batch_01.csv');
    csv('orders/batch_02.csv'); // on disk but never loaded: the missing one
    const root = manifest([
      { tenant: TENANT, source: 'orders', batch: 1, path: 'orders/batch_01.csv' },
      { tenant: TENANT, source: 'orders', batch: 2, path: 'orders/batch_02.csv' },
    ]);
    await loadFile({ tenantId: TENANT, source: 'orders', fileId: 'orders/batch_01.csv', absolutePath: abs1 });

    const reports = await checkArrivals(root);
    const lines = describeArrivals(reports);
    expect(lines[0]).toBe('2 expected batch(es): 1 arrived, 1 missing');
    expect(lines).toContainEqual(expect.stringContaining('orders/batch_02.csv'));
    expect(exitCodeFor(reports)).toBe(2);
  });

  it('a file loaded for a DIFFERENT tenant does not count as this tenant’s arrival', async () => {
    const OTHER = 'check_test_b';
    await pool.query('DELETE FROM raw_records WHERE tenant_id = $1', [OTHER]);
    await pool.query('DELETE FROM file_ledger WHERE tenant_id = $1', [OTHER]);
    const abs = csv('orders/batch_01.csv');
    const root = manifest([{ tenant: TENANT, source: 'orders', batch: 1, path: 'orders/batch_01.csv' }]);
    await loadFile({ tenantId: OTHER, source: 'orders', fileId: 'orders/batch_01.csv', absolutePath: abs }); // wrong tenant

    const reports = await checkArrivals(root);
    expect(reports[0]!.status).toBe('MISSING');
    await pool.query('DELETE FROM raw_records WHERE tenant_id = $1', [OTHER]);
    await pool.query('DELETE FROM file_ledger WHERE tenant_id = $1', [OTHER]);
  });
});