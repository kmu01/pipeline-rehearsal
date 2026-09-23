import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';

export const SOURCE_TYPES = ['orders', 'refunds', 'email_events', 'ad_spend'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

const SourceConfig = z
  .strictObject({
    // the column names this source's files are expected to have
    columns: z.array(z.string().min(1)).min(1),
    // known renames: expected column -> other names we accept for it. Anything else is drift.
    aliases: z.record(z.string(), z.array(z.string().min(1))).default({}),
  })
  .superRefine((src, ctx) => {
    const expected = new Set(src.columns);
    if (expected.size !== src.columns.length) ctx.addIssue({ code: 'custom', path: ['columns'], message: 'a column is listed twice' });

    const claimedBy = new Map<string, string>(); // alias -> the column that claimed it first
    for (const [column, alternatives] of Object.entries(src.aliases)) {
      if (!expected.has(column)) ctx.addIssue({ code: 'custom', path: ['aliases', column], message: `"${column}" has aliases but is not one of the expected columns` });
      for (const alias of alternatives) {
        if (expected.has(alias)) ctx.addIssue({ code: 'custom', path: ['aliases', column], message: `alias "${alias}" is already an expected column` });
        const owner = claimedBy.get(alias);
        if (owner !== undefined && owner !== column) ctx.addIssue({ code: 'custom', path: ['aliases', column], message: `alias "${alias}" is claimed by both "${owner}" and "${column}"` });
        claimedBy.set(alias, column);
      }
    }
  });

const TenantConfig = z.strictObject({
  id: z.string().regex(/^[a-z0-9_]+$/, 'must be lowercase letters, digits or underscores'),
  name: z.string().min(1),
  sources: z.strictObject({
    orders: SourceConfig,
    refunds: SourceConfig,
    email_events: SourceConfig,
    ad_spend: SourceConfig,
  }),
});

export type SourceConfig = z.infer<typeof SourceConfig>;
export type TenantConfig = z.infer<typeof TenantConfig>;

const DEFAULT_DIR = fileURLToPath(new URL('../../config/tenants', import.meta.url));

/**
 * Read and check every *.yaml file in the tenants folder. Adding a client means adding a file here and
 * nothing else. A mistake stops the program at startup, naming the file and every problem in it.
 */
export function loadTenants(dir: string = DEFAULT_DIR): TenantConfig[] {
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  if (files.length === 0) throw new Error(`No tenant configs found in ${dir}`);

  const tenants: TenantConfig[] = [];
  for (const file of files) {
    const parsed = TenantConfig.safeParse(parse(fs.readFileSync(path.join(dir, file), 'utf8')));
    if (!parsed.success) {
      const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(top level)'}: ${i.message}`).join('\n');
      throw new Error(`Invalid tenant config ${file}:\n${problems}`);
    }
    const expectedId = file.replace(/\.ya?ml$/, '');
    if (parsed.data.id !== expectedId) throw new Error(`Invalid tenant config ${file}: id "${parsed.data.id}" must match the file name ("${expectedId}")`);
    if (tenants.some((t) => t.id === parsed.data.id)) throw new Error(`Invalid tenant config ${file}: id "${parsed.data.id}" is defined by two files`);
    tenants.push(parsed.data);
  }
  return tenants;
}