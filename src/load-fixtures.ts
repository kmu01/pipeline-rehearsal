// Loads batches from fixtures/manifest.json.
// Usage: npx tsx src/load-fixtures.ts [path] [--only path/to/one/file.csv]
//                                            [--crash-at path/to/file.csv --crash-after N]
import fs from 'node:fs';
import path from 'node:path';
import { readManifest } from './audit/manifest';
import { loadTenants } from './config/loader';
import { connectWithRetry, appPool } from './db/client';
import { loadFile } from './ingest/load-file';

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const root = args[0] ?? './fixtures';
  const only = argValue('--only');
  const crashAt = argValue('--crash-at');
  const crashAfter = Number(argValue('--crash-after') ?? '5');

  await connectWithRetry(appPool);
  const tenants = new Map(loadTenants().map((t) => [t.id, t]));
  const batches = readManifest(root).filter((b) => !only || b.path === only);

  let loaded = 0, skipped = 0, missing = 0, refused = 0, quarantined = 0, failed = 0;
  for (const b of batches) {
    const abs = path.resolve(root, b.path);
    if (!fs.existsSync(abs)) { console.log('MISSING  ', b.path); missing++; continue; }
    const tenant = tenants.get(b.tenant);
    if (!tenant) { console.log('SKIP (no config for tenant)', b.tenant); continue; }
    try {
      const r = await loadFile(
        { tenantId: b.tenant, source: b.source, sourceConfig: tenant.sources[b.source], fileId: b.path, absolutePath: abs },
        crashAt && b.path === crashAt ? crashAfter : undefined,
      );
      const extra = 'rows' in r ? `(${r.rows} rows)` : '';
      const detail = 'message' in r ? `\n    -> ${r.message}` : '';
      console.log(r.outcome.padEnd(22), b.path, extra + detail);
      if (r.outcome === 'LOADED') loaded++;
      else if (r.outcome === 'ALREADY_LOADED') skipped++;
      else if (r.outcome === 'REFUSED_CHANGED_FILE') refused++;
      else if (r.outcome === 'QUARANTINED') quarantined++;
    } catch (err) {
      console.log('FAILED   '.padEnd(22), b.path, '->', (err as Error).message.split('\n')[0]);
      failed++;
    }
  }
  console.log(`\n${batches.length} expected: ${loaded} loaded, ${quarantined} quarantined, ${skipped} already loaded, ${missing} missing, ${refused} refused, ${failed} failed to parse`);
  await appPool.end();
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

main();