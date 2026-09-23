import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTenants } from '../src/config/loader';

const valid = (id: string) => `
id: ${id}
name: ${id}
sources:
  orders:       { columns: [order_id, created_at, gross] }
  refunds:      { columns: [refund_id, order_id, amount] }
  email_events: { columns: [event_id, type, occurred_at] }
  ad_spend:     { columns: [date, campaign_id, spend], aliases: { spend: [cost_usd] } }
`;

function folder(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenants-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

describe('the real tenant files', () => {
  it('load, and describe the source the way the fixtures behave', () => {
    const tenants = loadTenants();
    expect(tenants.map((t) => t.id).sort()).toEqual(['lumen', 'northwind']);
    for (const t of tenants) {
      expect(t.sources.ad_spend.columns).toContain('spend');
      expect(t.sources.ad_spend.aliases).toEqual({ spend: ['cost_usd'] });
    }
  });
});

describe('adding a client is adding a file', () => {
  it('a third client appears with no code change', () => {
    const dir = folder({ 'lumen.yaml': valid('lumen'), 'northwind.yaml': valid('northwind'), 'acme.yaml': valid('acme') });
    expect(loadTenants(dir).map((t) => t.id)).toEqual(['acme', 'lumen', 'northwind']);
  });

  it('the program code never mentions a client by name (no branching on who the client is)', () => {
    const names = loadTenants().map((t) => t.id);
    const files = fs.readdirSync('src', { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
    const offenders = files.filter((f) => names.some((n) => new RegExp(`\\b${n}\\b`, 'i').test(fs.readFileSync(path.join('src', f), 'utf8'))));
    expect(offenders).toEqual([]);
  });
});

describe('mistakes stop the program at startup, with a message that says what to fix', () => {
  it('reports every problem in a file at once, naming the file and the path', () => {
    const dir = folder({
      'acme.yaml': `
id: Acme Corp
name: Acme
sources:
  orders: { columns: [] }
  refunds: { columns: [refund_id] }
`,
    });
    expect(() => loadTenants(dir)).toThrow(/Invalid tenant config acme\.yaml:/);
    let message = '';
    try { loadTenants(dir); } catch (e) { message = (e as Error).message; }
    expect(message).toContain('id: must be lowercase letters, digits or underscores');
    expect(message).toContain('sources.orders.columns');
    expect(message).toContain('sources.email_events');
    expect(message).toContain('sources.ad_spend');
  });

  it('a typo in a key is an error, not silently ignored', () => {
    const dir = folder({ 'acme.yaml': valid('acme').replace('aliases:', 'alias:') });
    expect(() => loadTenants(dir)).toThrow(/alias/);
  });

  it('the id must match the file name', () => {
    const dir = folder({ 'acme.yaml': valid('someone_else') });
    expect(() => loadTenants(dir)).toThrow(/id "someone_else" must match the file name \("acme"\)/);
  });

  it('two files cannot define the same client', () => {
    const dir = folder({ 'acme.yaml': valid('acme'), 'acme.yml': valid('acme') });
    expect(() => loadTenants(dir)).toThrow(/id "acme" is defined by two files/);
  });

  it('an alias for a column that is not expected is rejected', () => {
    const dir = folder({ 'acme.yaml': valid('acme').replace('aliases: { spend: [cost_usd] }', 'aliases: { price: [cost_usd] }') });
    expect(() => loadTenants(dir)).toThrow(/"price" has aliases but is not one of the expected columns/);
  });

  it('an alias that is already an expected column is rejected', () => {
    const dir = folder({ 'acme.yaml': valid('acme').replace('spend: [cost_usd]', 'spend: [campaign_id]') });
    expect(() => loadTenants(dir)).toThrow(/alias "campaign_id" is already an expected column/);
  });

  it('the same alias for two columns is rejected (it would be ambiguous)', () => {
    const dir = folder({ 'acme.yaml': valid('acme').replace('aliases: { spend: [cost_usd] }', 'aliases: { spend: [cost_usd], date: [cost_usd] }') });
    expect(() => loadTenants(dir)).toThrow(/alias "cost_usd" is claimed by both "spend" and "date"/);
  });

  it('a folder with no configs is an error, not an empty pipeline', () => {
    expect(() => loadTenants(folder({}))).toThrow(/No tenant configs found/);
  });
});