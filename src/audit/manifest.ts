import fs from 'node:fs';
import path from 'node:path';
import type { SourceType } from '../config/loader';

export interface ManifestBatch {
  tenant: string;
  source: SourceType;
  batch: number;
  path: string; // relative to the fixtures root
}

/** Every batch, for every tenant and source, that should exist. */
export function readManifest(fixturesRoot: string): ManifestBatch[] {
  const raw = JSON.parse(fs.readFileSync(path.join(fixturesRoot, 'manifest.json'), 'utf8')) as { batches: ManifestBatch[] };
  return raw.batches;
}