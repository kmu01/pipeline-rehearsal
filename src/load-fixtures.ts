// One-off script for trying the manifest check by hand. Not part of the pipeline, but useful for debugging.
import fs from 'node:fs';
import path from 'node:path';
import { readManifest } from './audit/manifest';
import { appPool } from './db/client';
import { loadFile } from './ingest/load-file';

async function main() {
  const root = process.argv[2] ?? './fixtures';
  for (const batch of readManifest(root)) {
    const absolutePath = path.resolve(root, batch.path);
    if (!fs.existsSync(absolutePath)) {
      console.log('skip (not on disk):', batch.path);
      continue;
    }
    const result = await loadFile({ tenantId: batch.tenant, source: batch.source, fileId: batch.path, absolutePath });
    console.log(result, batch.path);
  }
  await appPool.end();
}

main();