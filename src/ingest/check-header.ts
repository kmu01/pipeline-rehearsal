import { parse } from 'csv-parse/sync';
import type { SourceConfig } from '../config/loader';

export interface DriftEvent {
  originalColumn: string; // the name actually found in the file
  canonicalColumn: string | null; // what we mapped it to; null when we couldn't map it
  action: 'ALIASED' | 'QUARANTINED';
}

export interface HeaderCheck {
  ok: boolean;
  events: DriftEvent[];
  problem?: string; // set when ok is false: why, in a form a human can act on
}

/** The file's header row, in order, without parsing the rest of the file. */
export function readHeader(bytes: Buffer): string[] {
  const [firstRow] = parse(bytes, { to: 1 }) as string[][];
  return firstRow?.map((h) => h.trim()) ?? [];
}

/**
 * Compare a file's header against what the tenant's config says this source should look like.
 *  - the expected name is present               -> fine, no event
 *  - the expected name is absent, a DECLARED alias is present -> adapt, and RECORD that it happened
 *  - the expected name is absent, nothing declared covers it  -> QUARANTINE the file
 * Matching is exact on purpose: a column present under a different capitalisation is treated the
 * same as a missing column, not silently accepted. Silent acceptance is how a real problem hides.
 */
export function checkHeader(sourceConfig: SourceConfig, header: string[]): HeaderCheck {
  const present = new Set(header);
  const events: DriftEvent[] = [];
  const missing: string[] = [];

  for (const expected of sourceConfig.columns) {
    if (present.has(expected)) continue;
    const alias = (sourceConfig.aliases[expected] ?? []).find((a) => present.has(a));
    if (alias) events.push({ originalColumn: alias, canonicalColumn: expected, action: 'ALIASED' });
    else missing.push(expected);
  }
  if (missing.length === 0) return { ok: true, events };

  // Columns in the file that are neither an expected name nor a declared alias for one: these are
  // the best clue to WHAT a column was renamed to, when the rename itself was never declared.
  const accountedFor = new Set([...sourceConfig.columns, ...events.map((e) => e.originalColumn)]);
  const unexplained = header.filter((h) => !accountedFor.has(h));

  const quarantineEvents: DriftEvent[] = unexplained.length
    ? unexplained.map((h) => ({ originalColumn: h, canonicalColumn: null, action: 'QUARANTINED' as const }))
    : missing.map((m) => ({ originalColumn: `(absent: ${m})`, canonicalColumn: null, action: 'QUARANTINED' as const }));

  const hint =
    missing.length === 1 && unexplained.length === 1
      ? ` Likely rename of "${missing[0]}" to "${unexplained[0]}": declare it under this source's "aliases" in the tenant's config, then re-run.`
      : ' Fix the file, or declare the new name(s) under this source\'s "aliases" in the tenant\'s config, then re-run.';

  return {
    ok: false,
    events: [...events, ...quarantineEvents], // any aliases we DID resolve are still worth recording
    problem: `missing expected column(s): ${missing.join(', ')}.${hint}`,
  };
}