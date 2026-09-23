import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SourceConfig } from '../src/config/loader';
import { adminPool } from '../src/db/client';
import { migrate } from '../src/db/migrate';
import { loadFile, type FileToLoad } from '../src/ingest/load-file';

const TENANT = 'drift_test_a';
let dir: string;

const AD_SPEND_CONFIG: SourceConfig = { columns: ['date', 'campaign_id', 'platform', 'spend'], aliases: { spend: ['cost_usd'] } };
const AD_SPEND_NO_ALIAS: SourceConfig = { columns: ['date', 'campaign_id', 'platform', 'spend'], aliases: {} };

function file(tenantId: string, sourceConfig: SourceConfig, header: string, rows: string[], fileId = 'ad_spend/batch_01.csv'): FileToLoad {
  const abs = path.join(dir, fileId.replace(/\//g, '_'));
  fs.writeFileSync(abs, [header, ...rows].join('\n') + '\n');
  return { tenantId, source: 'ad_spend', sourceConfig, fileId, absolutePath: abs };
}

const rawCount = async () => (await adminPool.query('SELECT count(*)::int AS n FROM raw_records WHERE tenant_id = $1', [TENANT])).rows[0].n as number;
const events = async () =>
  (await adminPool.query('SELECT original_column, canonical_column, action FROM schema_drift_events WHERE tenant_id = $1 ORDER BY id', [TENANT])).rows;
const ledger = async () => (await adminPool.query('SELECT status, detail FROM file_ledger WHERE tenant_id = $1', [TENANT])).rows[0];

beforeAll(async () => { await migrate(); });
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-'));
  await adminPool.query('DELETE FROM schema_drift_events WHERE tenant_id = $1', [TENANT]);
  await adminPool.query('DELETE FROM raw_records WHERE tenant_id = $1', [TENANT]);
  await adminPool.query('DELETE FROM file_ledger WHERE tenant_id = $1', [TENANT]);
});
afterAll(async () => {
  await adminPool.query('DELETE FROM schema_drift_events WHERE tenant_id = $1', [TENANT]);
  await adminPool.query('DELETE FROM raw_records WHERE tenant_id = $1', [TENANT]);
  await adminPool.query('DELETE FROM file_ledger WHERE tenant_id = $1', [TENANT]);
  await adminPool.end();
});

describe('a matching header', () => {
  it('loads normally, no drift events', async () => {
    const result = await loadFile(file(TENANT, AD_SPEND_CONFIG, 'date,campaign_id,platform,spend', ['2026-01-06,camp-400,Meta,10.50']));
    expect(result).toEqual({ outcome: 'LOADED', rows: 1 });
    expect(await events()).toEqual([]);
  });
});

describe('a declared alias', () => {
  it('adapts, and records exactly one ALIASED event', async () => {
    const result = await loadFile(file(TENANT, AD_SPEND_CONFIG, 'date,campaign_id,platform,cost_usd', ['2026-01-06,camp-400,Meta,10.50']));
    expect(result).toEqual({ outcome: 'LOADED', rows: 1 });
    expect(await events()).toEqual([{ original_column: 'cost_usd', canonical_column: 'spend', action: 'ALIASED' }]);
  });

  it('keeps the ORIGINAL column name in raw storage', async () => {
    await loadFile(file(TENANT, AD_SPEND_CONFIG, 'date,campaign_id,platform,cost_usd', ['2026-01-06,camp-400,Meta,10.50']));
    const raw = (await adminPool.query('SELECT payload FROM raw_records WHERE tenant_id = $1', [TENANT])).rows[0].payload;
    expect(raw).toHaveProperty('cost_usd', '10.50');
  });
});

describe('an undeclared rename', () => {
  it('is QUARANTINED with a helpful hint, and keeps the raw row', async () => {
    const result = await loadFile(file(TENANT, AD_SPEND_NO_ALIAS, 'date,campaign_id,platform,cost_usd', ['2026-01-06,camp-400,Meta,10.50']));
    expect(result.outcome).toBe('QUARANTINED');
    expect((result as { message: string }).message).toContain('Likely rename of "spend" to "cost_usd"');
    expect(await rawCount()).toBe(1);
    expect((await ledger()).status).toBe('QUARANTINED');
  });

  it('THE recovery path: quarantined, config fixed, same file reloads', async () => {
    const f = file(TENANT, AD_SPEND_NO_ALIAS, 'date,campaign_id,platform,cost_usd', ['2026-01-06,camp-400,Meta,10.50']);
    expect((await loadFile(f)).outcome).toBe('QUARANTINED');

    const fixed = await loadFile({ ...f, sourceConfig: AD_SPEND_CONFIG });
    expect(fixed).toEqual({ outcome: 'LOADED', rows: 1 });
    expect(await rawCount()).toBe(1); // not duplicated
    expect(await events()).toEqual([
      { original_column: 'cost_usd', canonical_column: null, action: 'QUARANTINED' },
      { original_column: 'cost_usd', canonical_column: 'spend', action: 'ALIASED' },
    ]);
  });
});

describe('a header that differs only in case', () => {
  it('is still drift, not silently accepted', async () => {
    const result = await loadFile(file(TENANT, AD_SPEND_NO_ALIAS, 'date,campaign_id,platform,Spend', ['2026-01-06,camp-400,Meta,10.50']));
    expect(result.outcome).toBe('QUARANTINED');
  });
});