#!/usr/bin/env node
/**
 * profile.mjs - fixture profiler for the ingestion take-home.
 *
 * Usage:   node profile.mjs [fixtures_root=.] [report_file=profile_report.txt]
 * Needs:   Node 18+. No npm install. Read-only: it never modifies fixtures.
 *
 * It finds the failure cases the brief promises (dupes, overlap, drift, late
 * arrivals, truncation, missing batches, tenant contamination) and checks the
 * client's finance_summary against the raw data. It prints a report and writes
 * the same text to report_file. Paste the report back; it contains no emails.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(process.argv[2] ?? '.');
const OUT = path.resolve(process.argv[3] ?? 'profile_report.txt');

// ---------------------------------------------------------------- vocabulary
const SOURCES = ['orders', 'refunds', 'email_events', 'ad_spend'];
const DIR_ALIAS = { ad_spent: 'ad_spend', adspend: 'ad_spend', 'ad-spend': 'ad_spend', ads: 'ad_spend',
  emailevents: 'email_events', 'email-events': 'email_events', email: 'email_events', emails: 'email_events' };
const normSource = (s) => { const k = String(s).toLowerCase(); return SOURCES.includes(k) ? k : DIR_ALIAS[k] ?? null; };
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// column roles per source; matched by normalised name, then guessed by value
const ALIASES = {
  orders: {
    key: ['orderid', 'id', 'ordernumber', 'orderno', 'ordernum', 'orderref'],
    ts: ['createdat', 'orderedat', 'orderdate', 'placedat', 'createdon', 'ordertime', 'timestamp', 'datetime', 'date'],
    amt: ['gross', 'grossamount', 'grosstotal', 'totalprice', 'total', 'grossrevenue', 'revenue', 'amount', 'price'],
    cur: ['currency', 'currencycode', 'ccy'],
    cat: ['channel', 'marketingchannel', 'utmsource', 'source', 'platform'],
    email: ['customeremail', 'email', 'buyeremail', 'emailaddress'],
  },
  refunds: {
    key: ['refundid', 'id'],
    ref: ['orderid', 'ordernumber', 'orderno', 'orderref', 'order'],
    ts: ['refundedat', 'refunddate', 'processedat', 'createdat', 'timestamp', 'date'],
    amt: ['amount', 'refundamount', 'refunded', 'value', 'total'],
    cur: ['currency', 'currencycode', 'ccy'],
  },
  email_events: {
    key: ['eventid', 'id', 'messageid', 'uid'],
    ts: ['occurredat', 'eventtime', 'timestamp', 'sentat', 'createdat', 'time', 'ts', 'date'],
    cat: ['type', 'eventtype', 'event', 'kind', 'action'],
    email: ['email', 'recipient', 'emailaddress', 'customeremail', 'to'],
    camp: ['campaignid', 'campaign', 'cmp', 'cid'],
  },
  ad_spend: {
    ts: ['date', 'day', 'reportdate', 'spenddate', 'statdate'],
    camp: ['campaignid', 'campaign', 'cmp', 'id'],
    cat: ['platform', 'network', 'channel', 'source'],
    amt: ['spend', 'cost', 'adspend', 'totalspend', 'amount'],
  },
};
const DENSE = new Set(['orders', 'email_events', 'ad_spend']); // refunds are sparse: gap/thin-day checks would be noise
const REQUIRED = { orders: ['key', 'ts', 'amt'], refunds: ['key', 'ref', 'ts', 'amt'], email_events: ['key', 'ts', 'cat'], ad_spend: ['ts', 'camp', 'amt'] };
const FINANCE_ALIASES = { date: ['date', 'day'], gross: ['grossreported', 'gross'], net: ['netreported', 'net'], cur: ['currency', 'ccy'] };

// ---------------------------------------------------------------- report plumbing
const findings = [];
const flag = (scope, msg) => findings.push({ scope, msg });
const sections = [];
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const fx = (n, d = 2) => (n == null || !Number.isFinite(n) ? '-' : Number(n).toFixed(d));
const S = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v).trim());
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const cnt = (m, k, n = 1) => m.set(k, (m.get(k) || 0) + n);
const top = (m, n = 4) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k}=${v}`).join(', ');
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const list = (a, n = 8) => a.slice(0, n).join(', ') + (a.length > n ? ` ...(+${a.length - n})` : '');
const daysBetween = (from, to) => { const out = []; for (let t = Date.parse(from + 'T00:00:00Z'); t <= Date.parse(to + 'T00:00:00Z'); t += 864e5) out.push(dayOf(t)); return out; };

// ---------------------------------------------------------------- parsing
function parseCsv(text, delim) {
  const rows = []; let row = []; let field = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; } else field += c;
      continue;
    }
    if (c === '"' && field === '') inQ = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  const unterminated = inQ;
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return { rows, unterminated };
}

function readRecords(abs) {
  const buf = fs.readFileSync(abs);
  const info = { bytes: buf.length, sha: crypto.createHash('sha256').update(buf).digest('hex'), flags: [],
    badLines: 0, badWidth: 0, blank: 0, unterminated: false, lastLineBad: false, shapes: null, header: [], records: [] };
  let text = buf.toString('utf8');
  info.bom = text.charCodeAt(0) === 0xfeff; if (info.bom) text = text.slice(1);
  info.repl = (text.match(/\uFFFD/g) || []).length;
  info.crlf = text.includes('\r\n');
  info.endsNL = text.length === 0 || text.endsWith('\n');
  const first = text.trimStart()[0];
  if (!text.trim()) { info.format = 'empty'; return info; }

  if (first === '{') {
    info.format = 'ndjson';
    const shapes = new Map(); const seen = new Set(); const lines = text.split(/\r?\n/);
    lines.forEach((l, i) => {
      if (!l.trim()) { if (i < lines.length - 1) info.blank++; return; }
      try {
        const o = JSON.parse(l);
        if (o === null || typeof o !== 'object' || Array.isArray(o)) throw new Error('not an object');
        info.records.push(o);
        const ks = Object.keys(o); cnt(shapes, [...ks].sort().join('|'));
        for (const k of ks) if (!seen.has(k)) { seen.add(k); info.header.push(k); }
      } catch { info.badLines++; if (i >= lines.length - 2) info.lastLineBad = true; }
    });
    info.shapes = [...shapes.entries()].sort((a, b) => b[1] - a[1]);
  } else if (first === '[') {
    info.format = 'jsonarray';
    try { info.records = JSON.parse(text); info.header = [...new Set(info.records.flatMap((o) => Object.keys(o)))]; }
    catch { info.badLines = 1; info.lastLineBad = true; }
  } else {
    info.format = 'csv';
    const firstLine = text.split(/\r?\n/, 1)[0];
    const delim = [',', ';', '\t', '|'].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    info.delim = delim;
    const { rows, unterminated } = parseCsv(text, delim);
    info.unterminated = unterminated;
    info.header = rows[0].map((h) => h.trim());
    if (new Set(info.header.map(norm)).size !== info.header.length) info.flags.push('DUP-HEADER');
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (r.length === 1 && r[0] === '') { info.blank++; continue; }
      if (r.length === info.header.length && r.every((v, j) => norm(v) === norm(info.header[j]))) { info.repeatedHeader = (info.repeatedHeader || 0) + 1; continue; }
      if (r.length !== info.header.length) { info.badWidth++; if (i === rows.length - 1) info.lastLineBad = true; }
      const o = {}; info.header.forEach((h, j) => { o[h] = r[j] ?? ''; });
      info.records.push(o);
    }
  }
  return info;
}

function parseTs(v) {
  if (v == null || S(v) === '') return { shape: '(blank)', bad: true };
  const s = S(v);
  if (/^\d{9,13}(\.\d+)?$/.test(s)) { const n = Number(s); return n > 1e11 ? { ms: n, shape: 'epoch_ms' } : { ms: n * 1000, shape: 'epoch_s' }; }
  const shape = s.replace(/\d/g, '9').replace(/[A-Za-z]/g, 'a');
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (!m) return { shape, bad: true };
  const hasTime = m[4] !== undefined; const zone = m[7];
  let iso = hasTime ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}` : `${m[1]}-${m[2]}-${m[3]}T00:00:00`;
  iso += zone ? (zone.toUpperCase() === 'Z' ? 'Z' : zone.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')) : 'Z';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return { shape, bad: true };
  return { ms, shape, naive: hasTime && !zone, dateOnly: !hasTime };
}

function parseNum(v) {
  if (typeof v === 'number') return { v, kind: 'plain' };
  const s = S(v); if (s === '') return { kind: 'blank' };
  if (/^-?\d+(\.\d+)?$/.test(s)) return { v: parseFloat(s), kind: 'plain' };
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return { v: parseFloat(s.replace(/,/g, '')), kind: 'thousands-sep' };
  if (/^-?\d{1,3}(\.\d{3})+,\d+$/.test(s)) return { v: parseFloat(s.replace(/\./g, '').replace(',', '.')), kind: 'eu-format' };
  if (/^-?\d+,\d{1,2}$/.test(s)) return { v: parseFloat(s.replace(',', '.')), kind: 'comma-decimal' };
  const t = s.replace(/[€$£\s]|EUR|USD|GBP/gi, '');
  if (t !== s && t !== '') { const r = parseNum(t); if (r.v !== undefined) return { v: r.v, kind: 'symbol' }; }
  return { kind: 'bad' };
}

function assignRoles(header, records, src) {
  const nh = header.map((h) => ({ h, n: norm(h) })); const map = {}; const how = {}; const used = new Set();
  for (const [role, al] of Object.entries(ALIASES[src])) {
    let hit = null;
    for (const a of al) { hit = nh.find((x) => x.n === a && !used.has(x.h)); if (hit) break; }
    if (hit) { map[role] = hit.h; how[role] = 'name'; used.add(hit.h); } else { map[role] = null; how[role] = null; }
  }
  const sample = records.slice(0, 300);
  const frac = (col, fn) => { const vals = sample.map((r) => S(r[col])).filter((v) => v !== ''); return vals.length ? vals.filter(fn).length / vals.length : 0; };
  if ('ts' in map && !map.ts) {
    const c = header.find((h) => !used.has(h) && frac(h, (v) => parseTs(v).ms != null) >= 0.8);
    if (c) { map.ts = c; how.ts = 'value-guess'; used.add(c); }
  }
  if ('amt' in map && !map.amt) {
    const c = header.find((h) => !used.has(h) && frac(h, (v) => parseNum(v).v !== undefined) >= 0.8);
    if (c) { map.amt = c; how.amt = 'value-guess'; used.add(c); }
  }
  return { map, how };
}

// ---------------------------------------------------------------- discovery
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const DATA_EXT = /\.(csv|tsv|ndjson|jsonl|json|txt)$/i;
const SKIP = /^(manifest\.json|package(-lock)?\.json|tsconfig.*\.json|profile_report.*|readme.*|.*\.md)$/i;

function classify(rel) {
  const parts = rel.split('/'); const file = parts.at(-1); const dirs = parts.slice(0, -1);
  const bm = file.match(/batch[_-]?(\d+)/i); const batch = bm ? parseInt(bm[1], 10) : null;
  if (/finance/i.test(file)) return { kind: 'finance', tenant: dirs.at(-1) ?? '(root)', rel, batch: null };
  let si = -1; let source = null;
  for (let i = dirs.length - 1; i >= 0; i--) { const s = normSource(dirs[i]); if (s) { si = i; source = s; break; } }
  if (!source) {
    const fm = file.toLowerCase().replace(/-/g, '_').match(/^(orders|refunds|email_events|ad_spend|ad_spent)/);
    if (fm) source = normSource(fm[1]);
  }
  if (!source) return { kind: 'unknown', rel };
  const tenant = si > 0 ? dirs[si - 1] : si === 0 ? '(root)' : dirs.at(-1) ?? '(root)';
  return { kind: 'data', tenant, source, batch, rel };
}

const manifest = fs.existsSync(path.join(ROOT, 'manifest.json')) ? JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')) : null;
const discovered = walk(ROOT)
  .map((abs) => ({ abs, rel: path.relative(ROOT, abs).split(path.sep).join('/') }))
  .filter((f) => DATA_EXT.test(f.rel) && !SKIP.test(path.basename(f.rel)) && path.resolve(f.abs) !== OUT)
  .map((f) => ({ ...f, ...classify(f.rel) }));

const inventory = [];
const dataFiles = discovered.filter((f) => f.kind === 'data');
const financeFiles = discovered.filter((f) => f.kind === 'finance');
const unknownFiles = discovered.filter((f) => f.kind === 'unknown');
const bkey = (t, s, b) => `${t}|${s}|${b}`;
const idx = new Map();
for (const f of dataFiles) { const k = bkey(f.tenant, f.source, f.batch); if (!idx.has(k)) idx.set(k, []); idx.get(k).push(f); }

const entries = []; const used = new Set(); const windowByKey = new Map(); const missing = [];
if (manifest) {
  for (const b of manifest.batches) {
    const src = normSource(b.source) ?? b.source; const k = bkey(b.tenant, src, b.batch);
    const window = { from: b.covers_from, to: b.covers_to }; windowByKey.set(k, window);
    const cand = (idx.get(k) || []).find((f) => !used.has(f));
    if (cand) {
      used.add(cand); entries.push({ ...cand, tenant: b.tenant, source: src, window, listed: true });
      if (cand.rel !== b.path) inventory.push(`path differs from manifest: ${b.path}  ->  found ${cand.rel}`);
    } else missing.push(b);
  }
}
for (const f of dataFiles) {
  if (used.has(f)) continue;
  const w = windowByKey.get(bkey(f.tenant, f.source, f.batch)) ?? null;
  entries.push({ ...f, window: w, listed: false });
}
entries.sort((a, b) => a.tenant.localeCompare(b.tenant) || a.source.localeCompare(b.source) || (a.batch ?? 1e9) - (b.batch ?? 1e9) || a.rel.localeCompare(b.rel));

// ---------------------------------------------------------------- per-file profile
const FIELDS = ['ref', 'ms', 'amt', 'cur', 'cat', 'email', 'camp'];
function profileFile(e) {
  const fp = { ...e, ...readRecords(path.join(ROOT, e.rel)) };
  const base = path.basename(e.rel);
  fp.label = e.batch != null ? `b${String(e.batch).padStart(2, '0')}${e.listed ? '' : '+'}` : base;
  fp.roles = assignRoles(fp.header, fp.records, e.source);
  const R = fp.roles.map;
  fp.tsShapes = new Map(); fp.akinds = new Map(); fp.cat = new Map(); fp.cur = new Map(); fp.dayCounts = new Map();
  fp.naive = 0; fp.tsBad = 0; fp.keyNull = 0; fp.inversions = 0;
  let prev = null;
  fp.rows = fp.records.map((rec, i) => {
    const g = (role) => (R[role] ? S(rec[R[role]]) : '');
    const t = R.ts ? parseTs(rec[R.ts]) : { shape: '(no ts column)', bad: true };
    const a = R.amt ? parseNum(rec[R.amt]) : { kind: 'blank' };
    const row = { i, ms: t.ms ?? null, day: t.ms != null ? dayOf(t.ms) : null, amt: a.v ?? null, cur: g('cur'), cat: g('cat'),
      email: g('email'), camp: g('camp'), ref: g('ref'), file: fp.label, batch: e.batch };
    const rawKey = g('key');
    row.key = e.source === 'ad_spend' ? `${row.day ?? g('ts')}|${row.camp}` : rawKey || null;
    row.sig = [row.ref, row.ms ?? '', row.amt != null ? row.amt.toFixed(2) : '', row.cur, row.cat, row.email, row.camp].join('\u00a6');
    cnt(fp.tsShapes, t.shape); if (t.naive) fp.naive++; if (t.ms == null) fp.tsBad++;
    cnt(fp.akinds, a.kind);
    if (row.cat) cnt(fp.cat, row.cat); if (row.cur) cnt(fp.cur, row.cur);
    if (row.day) cnt(fp.dayCounts, row.day);
    if (!row.key) fp.keyNull++;
    if (row.ms != null) { if (prev != null && row.ms < prev) fp.inversions++; prev = row.ms; }
    return row;
  });
  const days = [...fp.dayCounts.keys()].sort();
  fp.minDay = days[0] ?? null; fp.maxDay = days.at(-1) ?? null;
  fp.pre = 0; fp.post = 0;
  if (e.window) for (const r of fp.rows) if (r.day) { if (r.day < e.window.from) fp.pre++; else if (r.day > e.window.to) fp.post++; }
  fp.gapDays = e.window ? daysBetween(e.window.from, e.window.to).filter((d) => !fp.dayCounts.has(d)) : [];
  if (fp.bom) fp.flags.push('BOM'); if (fp.crlf) fp.flags.push('CRLF'); if (!fp.endsNL) fp.flags.push('NO-EOL');
  if (fp.repl) fp.flags.push(`BAD-UTF8(${fp.repl})`); if (fp.badLines) fp.flags.push(`BAD-LINES(${fp.badLines})`);
  if (fp.badWidth) fp.flags.push(`BAD-WIDTH(${fp.badWidth})`); if (fp.blank) fp.flags.push(`BLANK(${fp.blank})`);
  if (fp.repeatedHeader) fp.flags.push(`REPEATED-HEADER(${fp.repeatedHeader})`);
  if (fp.unterminated) fp.flags.push('UNTERMINATED-QUOTE'); if (fp.lastLineBad) fp.flags.push('LAST-LINE-BAD');
  if (fp.delim && fp.delim !== ',') fp.flags.push(`DELIM(${JSON.stringify(fp.delim)})`);
  if (fp.format === 'empty') fp.flags.push('EMPTY');
  return fp;
}
const files = entries.map(profileFile);

// identical bytes
const bySha = new Map();
for (const f of files) { if (!bySha.has(f.sha)) bySha.set(f.sha, []); bySha.get(f.sha).push(f); }
for (const grp of bySha.values()) if (grp.length > 1) {
  const names = grp.map((f) => f.rel);
  inventory.push(`IDENTICAL BYTES: ${names.join('  ==  ')}`);
  flag('inventory', `identical file content: ${names.join(' == ')}`);
}

// ---------------------------------------------------------------- group analysis
const groups = new Map();
for (const f of files) { const k = `${f.tenant}|${f.source}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(f); }
const G = {}; // G[tenant][source] = { files, keyMap, latest, firstBatch }

function analyzeGroup(tenant, source, fs_) {
  const scope = `${tenant}/${source}`; const out = [];
  const labelCount = new Map(); for (const f of fs_) { cnt(labelCount, f.label); if (labelCount.get(f.label) > 1) f.label += '#'; }
  out.push(`## ${tenant} / ${source}   (${fs_.length} files)`);

  // key occurrences
  const keyMap = new Map();
  for (const f of fs_) for (const r of f.rows) { if (!r.key) continue; if (!keyMap.has(r.key)) keyMap.set(r.key, []); keyMap.get(r.key).push(r); }
  const latest = new Map(); const firstBatch = new Map();
  for (const [k, occ] of keyMap) { latest.set(k, occ.at(-1)); firstBatch.set(k, occ[0].batch); }
  G[tenant] ??= {}; G[tenant][source] = { files: fs_, keyMap, latest, firstBatch };
  for (const f of fs_) {
    const seen = new Map(); f.dupIn = 0; f.dupInConflict = 0;
    for (const r of f.rows) if (r.key) { if (seen.has(r.key)) { f.dupIn++; if (seen.get(r.key).sig !== r.sig) f.dupInConflict++; } else seen.set(r.key, r); }
  }

  // table
  out.push(`${pad('file', 8)}${padL('rows', 6)}${padL('kB', 6)}  ${pad('manifest window', 23)}${pad('data range', 23)}${padL('pre', 5)}${padL('post', 5)}${padL('gap', 4)}${padL('dupIn', 6)}${padL('inv', 5)}  flags`);
  for (const f of fs_) {
    const w = f.window ? `${f.window.from}..${f.window.to}` : '(none)';
    const d = f.minDay ? `${f.minDay}..${f.maxDay}` : '-';
    out.push(`${pad(f.label, 8)}${padL(f.rows.length, 6)}${padL((f.bytes / 1024).toFixed(1), 6)}  ${pad(w, 23)}${pad(d, 23)}${padL(f.pre, 5)}${padL(f.post, 5)}${padL(f.gapDays.length, 4)}${padL(f.dupIn, 6)}${padL(f.inversions, 5)}  ${f.flags.join(' ')}`);
  }
  out.push('  pre/post = rows dated before/after the manifest window | gap = window days with no rows | dupIn = extra rows for a key already in the same file | inv = timestamp order inversions');
  for (const f of fs_) {
    if (f.pre || f.post) flag(scope, `${f.label}: ${f.pre} rows dated BEFORE and ${f.post} AFTER its manifest window`);
    if (f.dupIn) flag(scope, `${f.label}: ${f.dupIn} duplicate-key rows inside the file (${f.dupInConflict} with different values)`);
    if (f.gapDays.length && DENSE.has(source)) flag(scope, `${f.label}: no rows for window day(s) ${list(f.gapDays, 4)}`);
    const sortedPeers = fs_.filter((x) => x.inversions === 0).length > fs_.length / 2;
    if (f.inversions > 0 && sortedPeers) flag(scope, `${f.label}: ${f.inversions} out-of-order timestamps (rows appended/merged after the fact?)`);
    if (f.flags.some((x) => /BAD-|UNTERM|LAST-LINE|EMPTY|NO-EOL|REPEATED/.test(x))) flag(scope, `${f.label}: file integrity flags ${f.flags.filter((x) => /BAD-|UNTERM|LAST-LINE|EMPTY|NO-EOL|REPEATED/.test(x)).join(' ')} (truncated/corrupt?)`);
    if (f.keyNull) flag(scope, `${f.label}: ${f.keyNull} rows with no usable key`);
    if (f.tsBad) flag(scope, `${f.label}: ${f.tsBad} rows with unparseable/missing timestamp`);
    if (f.naive) flag(scope, `${f.label}: ${f.naive} timestamps with no timezone`);
  }

  // schema drift
  out.push('', 'schema:');
  const hs = new Map();
  for (const f of fs_) { const k = f.header.join(' | '); if (!hs.has(k)) hs.set(k, []); hs.get(k).push(f.label); }
  for (const [h, ls] of hs) out.push(`  [${ls.join(',')}]  ${h}`);
  if (hs.size > 1) {
    const [base, ...rest] = [...hs.keys()]; const bset = new Set(base.split(' | '));
    for (const r of rest) {
      const rset = new Set(r.split(' | '));
      const removed = [...bset].filter((x) => !rset.has(x)); const added = [...rset].filter((x) => !bset.has(x));
      flag(scope, `SCHEMA DRIFT in [${hs.get(r).join(',')}] vs [${hs.get(base).join(',')}]: removed {${removed.join(',')}} added {${added.join(',')}}`);
    }
  }
  for (const f of fs_) {
    if (f.shapes && f.shapes.length > 1) flag(scope, `${f.label}: ${f.shapes.length} different key-sets inside one file: ${f.shapes.map(([k, n]) => `${n}x{${k}}`).join(' ; ').slice(0, 300)}`);
    for (const [role, how] of Object.entries(f.roles.how)) if (how === 'value-guess') flag(scope, `${f.label}: column for role "${role}" not found by name; guessed "${f.roles.map[role]}" from values (renamed?)`);
    for (const role of REQUIRED[source]) if (!f.roles.map[role]) flag(scope, `${f.label}: NO column found for required role "${role}"`);
  }
  const rmaps = new Map();
  for (const f of fs_) { const k = Object.entries(f.roles.map).map(([r, c]) => `${r}=${c}`).join(' '); if (!rmaps.has(k)) rmaps.set(k, []); rmaps.get(k).push(f.label); }
  for (const [k, ls] of rmaps) out.push(`  roles [${ls.join(',')}]: ${k}`);

  // value formats
  out.push('', 'timestamp shapes / number formats / amounts:');
  const meanByFile = [];
  const shapeSets = new Set(); const kindSets = new Set();
  for (const f of fs_) {
    if (!('amt' in ALIASES[source])) { out.push(`  ${pad(f.label, 8)} ts:${top(f.tsShapes, 2)}`); shapeSets.add([...f.tsShapes.keys()].sort().join('/')); continue; }
    const amts = f.rows.map((r) => r.amt).filter((x) => x != null);
    const mean = amts.length ? amts.reduce((a, b) => a + b, 0) / amts.length : null; if (mean != null) meanByFile.push([f, mean]);
    const neg = amts.filter((x) => x < 0).length; const zero = amts.filter((x) => x === 0).length;
    out.push(`  ${pad(f.label, 8)} ts:${top(f.tsShapes, 2)} | num:${top(f.akinds, 3)} | n=${amts.length} min=${fx(Math.min(...amts))} mean=${fx(mean)} max=${fx(Math.max(...amts))} neg=${neg} zero=${zero}`);
    shapeSets.add([...f.tsShapes.keys()].sort().join('/')); kindSets.add([...f.akinds.keys()].sort().join('/'));
    if (neg) flag(scope, `${f.label}: ${neg} negative amounts`);
    if ([...f.akinds.keys()].some((k) => ['comma-decimal', 'eu-format', 'symbol', 'thousands-sep', 'bad'].includes(k))) flag(scope, `${f.label}: non-plain number formats ${top(f.akinds, 5)}`);
  }
  if (shapeSets.size > 1) flag(scope, `timestamp format differs between batches: ${[...shapeSets].join('  vs  ')}`);
  const mm = median(meanByFile.map(([, m]) => m));
  for (const [f, m] of meanByFile) if (mm && (m / mm > 3 || m / mm < 1 / 3)) flag(scope, `${f.label}: mean amount ${fx(m)} vs median-of-batches ${fx(mm)} (unit change? cents vs units?)`);

  // categorical drift
  for (const [label, sel] of [['category', 'cat'], ['currency', 'cur']]) {
    const per = fs_.map((f) => [f, f[sel]]).filter(([, m]) => m.size);
    if (!per.length) continue;
    out.push('', `${label} values per batch:`);
    const union = new Map();
    for (const [f, m] of per) { out.push(`  ${pad(f.label, 8)} ${top(m, 8)}`); for (const [k, v] of m) cnt(union, k, v); }
    const byLower = new Map(); for (const k of union.keys()) { const n = k.toLowerCase().trim(); if (!byLower.has(n)) byLower.set(n, []); byLower.get(n).push(k); }
    for (const v of byLower.values()) if (v.length > 1) flag(scope, `${label} values differing only by case/whitespace: ${v.map((x) => JSON.stringify(x)).join(' vs ')}`);
    const first = new Set(per[0][1].keys());
    for (const [f, m] of per.slice(1)) { const novel = [...m.keys()].filter((k) => !first.has(k)); if (novel.length) flag(scope, `${f.label}: ${label} value(s) not in first batch: ${novel.slice(0, 6).join(', ')}`); }
    if (sel === 'cur' && union.size > 1) flag(scope, `multiple currencies present: ${top(union, 5)}`);
  }

  // overlap / duplicates across files
  out.push('', 'overlap between files (same key in >1 file):');
  const pairs = new Map(); const examples = []; let conflictKeys = 0;
  for (const [k, occ] of keyMap) {
    const perFile = new Map(); for (const r of occ) if (!perFile.has(r.file)) perFile.set(r.file, r);
    const rs = [...perFile.values()];
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      const pk = `${rs[i].file} ∩ ${rs[j].file}`; const p = pairs.get(pk) || { n: 0, same: 0, diff: 0 }; p.n++;
      if (rs[i].sig === rs[j].sig) p.same++; else {
        p.diff++; conflictKeys++;
        if (examples.length < 5) examples.push(`${k}: ${FIELDS.filter((x) => rs[i][x] !== rs[j][x]).map((x) => x === 'email' ? 'email differs (redacted)' : `${x} ${rs[i].file}=${x === 'ms' ? (rs[i].ms && dayOf(rs[i].ms)) : rs[i][x]} vs ${rs[j].file}=${x === 'ms' ? (rs[j].ms && dayOf(rs[j].ms)) : rs[j][x]}`).join('; ')}`);
      }
      pairs.set(pk, p);
    }
  }
  if (!pairs.size) out.push('  none');
  for (const [pk, p] of pairs) { out.push(`  ${pk}: ${p.n} keys (${p.same} identical, ${p.diff} with changed values)`); flag(scope, `OVERLAP ${pk}: ${p.n} shared keys, ${p.diff} with changed values`); }
  for (const x of examples) out.push(`    e.g. ${x}`);
  const unique = keyMap.size; const total = fs_.reduce((a, f) => a + f.rows.filter((r) => r.key).length, 0);
  out.push(`  total keyed rows ${total}, distinct keys ${unique}, surplus ${total - unique}`);

  // days spanning files & late arrivals
  const dayFiles = new Map();
  for (const f of fs_) for (const [d, n] of f.dayCounts) { if (!dayFiles.has(d)) dayFiles.set(d, []); dayFiles.get(d).push(`${f.label}=${n}`); }
  const multi = [...dayFiles.entries()].filter(([, v]) => v.length > 1).sort();
  out.push('', 'days present in more than one file:');
  if (!multi.length) out.push('  none'); else out.push(...multi.slice(0, 12).map(([d, v]) => `  ${d}: ${v.join(' ')}`), ...(multi.length > 12 ? [`  ...(+${multi.length - 12} more)`] : []));
  const wins = fs_.filter((f) => f.window && f.listed).map((f) => ({ label: f.label, ...f.window }));
  const late = [];
  for (const f of fs_) {
    if (!f.window) continue; const owners = new Map();
    for (const r of f.rows) if (r.day && (r.day < f.window.from || r.day > f.window.to)) { const w = wins.find((x) => r.day >= x.from && r.day <= x.to); cnt(owners, w ? `${w.label} window` : 'no window'); }
    if (owners.size) late.push(`  ${f.label} carries rows belonging to: ${top(owners, 6)}`);
  }
  if (late.length) { out.push('', 'late / early arrivals (rows outside their own batch window):', ...late); }

  // coverage
  const expectedDays = wins.length ? [...new Set(wins.flatMap((w) => daysBetween(w.from, w.to)))].sort() : [];
  const missingDays = DENSE.has(source) ? expectedDays.filter((d) => !dayFiles.has(d)) : [];
  if (missingDays.length) flag(scope, `no data at all for ${missingDays.length} expected day(s): ${list(missingDays, 6)}`);
  const dedupDay = new Map(); for (const r of latest.values()) if (r.day) cnt(dedupDay, r.day);
  const med = median([...dedupDay.values()]);
  const lowDays = [...dedupDay.entries()].filter(([, n]) => med && n < 0.5 * med).map(([d, n]) => `${d}(${n})`).sort();
  out.push('', `distinct keys per day: median ${med}; low days (<50% of median): ${lowDays.length ? list(lowDays, 8) : 'none'}`);
  if (lowDays.length && DENSE.has(source)) flag(scope, `unusually thin days (possible partial batch): ${list(lowDays, 6)}`);
  const rowsMed = median(fs_.map((f) => f.rows.length));
  for (const f of fs_) if (DENSE.has(source) && fs_.length >= 3 && rowsMed && (f.rows.length < 0.6 * rowsMed || f.rows.length > 1.6 * rowsMed)) flag(scope, `${f.label}: ${f.rows.length} rows vs median ${rowsMed} per batch`);

  // source-specific
  if (source === 'email_events') {
    let mism = 0; let checked = 0;
    for (const f of fs_) for (const r of f.rows) { const m = r.key && r.key.match(/-(\d{9,10})-/); if (m && r.ms != null) { checked++; if (Number(m[1]) * 1000 !== r.ms) mism++; } }
    out.push('', `event_id embedded epoch vs occurred_at: ${checked} checked, ${mism} mismatches`);
    if (mism) flag(scope, `${mism} events whose id-embedded epoch disagrees with occurred_at (timestamp rewritten?)`);
  }
  const ids = new Map();
  for (const f of fs_) for (const r of f.rows) { const k = source === 'ad_spend' ? r.camp : r.key; if (k) cnt(ids, (k.match(/^[^0-9]*/)?.[0] || '') + '#'); }
  out.push('', `id prefixes: ${top(ids, 6)}`);
  if (ids.size > 1) flag(scope, `more than one id prefix: ${top(ids, 6)} (mixed tenants or id format change?)`);
  return out.join('\n');
}

const tenants = [...new Set(files.map((f) => f.tenant))].sort();
for (const [k, fs_] of groups) { const [t, s] = k.split('|'); sections.push(analyzeGroup(t, s, fs_)); }

// ---------------------------------------------------------------- finance & cross-source
function readFinance(f) {
  const rec = readRecords(path.join(ROOT, f.rel)); const nh = rec.header.map((h) => ({ h, n: norm(h) })); const col = {};
  for (const [role, al] of Object.entries(FINANCE_ALIASES)) { col[role] = null; for (const a of al) { const hit = nh.find((x) => x.n === a); if (hit) { col[role] = hit.h; break; } } }
  const rows = rec.records.map((r) => ({ date: col.date ? S(r[col.date]).slice(0, 10) : null, gross: col.gross ? parseNum(r[col.gross]).v ?? null : null,
    net: col.net ? parseNum(r[col.net]).v ?? null : null, cur: col.cur ? S(r[col.cur]) : '' }));
  return { rec, col, rows };
}
const dailySums = (rows, off = 0) => { const m = new Map(); for (const r of rows) if (r.ms != null && r.amt != null) cnt(m, dayOf(r.ms + off * 36e5), r.amt); return m; };
const close = (a, b) => a != null && b != null && Math.abs(a - b) < 0.006;
const matchCount = (fin, sums) => fin.filter((r) => close(r.gross, sums.get(r.date) ?? null)).length;

const finByTenant = new Map();
for (const f of financeFiles) {
  const fin = readFinance(f);
  let tenant = f.tenant;
  if (!G[tenant]) {
    let best = null;
    for (const t of tenants) { const o = G[t]?.orders; if (!o) continue; const n = matchCount(fin.rows, dailySums([...o.latest.values()])); if (!best || n > best.n) best = { t, n }; }
    if (best && best.n > 0) { inventory.push(`finance file ${f.rel}: no tenant in path; attributed to "${best.t}" (${best.n} days match its orders)`); tenant = best.t; }
    else inventory.push(`finance file ${f.rel}: could not attribute to a tenant`);
  }
  finByTenant.set(tenant, { f, ...fin });
}

for (const tenant of tenants) {
  const scope = `${tenant}/cross`; const out = [`## ${tenant} / cross-source checks`]; const g = G[tenant];
  const O = g.orders; const Rf = g.refunds; const E = g.email_events; const A = g.ad_spend;
  for (const s of SOURCES) if (!g[s]) flag(scope, `no files at all for source ${s}`);

  // refunds vs orders
  if (O && Rf) {
    let orphan = []; let before = 0; let over = 0; let loadedEarly = 0; let curMis = 0; const perOrder = new Map(); let ok = 0;
    for (const r of Rf.latest.values()) {
      const o = O.latest.get(r.ref);
      cnt(perOrder, r.ref);
      if (!o) { orphan.push(`${r.key}->${r.ref}`); continue; }
      ok++;
      if (r.ms != null && o.ms != null && r.ms < o.ms) before++;
      if (r.amt != null && o.amt != null && r.amt > o.amt + 0.005) over++;
      if (r.cur && o.cur && r.cur !== o.cur) curMis++;
      if (r.batch != null && O.firstBatch.get(r.ref) != null && r.batch < O.firstBatch.get(r.ref)) loadedEarly++;
    }
    const multiRef = [...perOrder.values()].filter((n) => n > 1).length;
    out.push(`refunds: ${Rf.latest.size} distinct; ${ok} match an order; ${orphan.length} orphan; ${before} dated before their order; ${over} larger than order gross; ${multiRef} orders refunded more than once; ${curMis} currency mismatch; ${loadedEarly} arrive in an earlier batch number than their order`);
    if (orphan.length) { out.push(`  orphans: ${list(orphan, 5)}`); flag(scope, `${orphan.length} refund(s) reference an order that exists in no orders file: ${list(orphan, 3)}`); }
    if (before) flag(scope, `${before} refund(s) dated before the order they refund`);
    if (over) flag(scope, `${over} refund(s) exceed the order's gross`);
    if (multiRef) flag(scope, `${multiRef} order(s) refunded more than once`);
    if (loadedEarly) flag(scope, `${loadedEarly} refund(s) sit in an earlier batch number than their order -> no FK possible at load time`);
    if (curMis) flag(scope, `${curMis} refund(s) in a different currency than the order`);
    const rFiles = Rf.files.filter((f) => f.window);
    const outside = rFiles.reduce((a, f) => a + f.pre + f.post, 0);
    if (outside) out.push(`  NOTE: ${outside} refund rows fall outside their batch window by refunded_at; manifest windows may describe order dates, not refund dates`);
  }

  // finance reconciliation
  const fin = finByTenant.get(tenant);
  if (!fin) { out.push('finance_summary: none found'); flag(scope, 'no finance_summary file'); }
  else if (O) {
    const rows = fin.rows; const dates = rows.map((r) => r.date);
    out.push(`finance_summary (${fin.f.rel}): ${rows.length} days ${dates[0]}..${dates.at(-1)}, currency ${[...new Set(rows.map((r) => r.cur))].join('/')}, columns ${JSON.stringify(fin.col)}`);
    if (new Set(dates).size !== dates.length) flag(scope, 'finance_summary has duplicate dates');
    const allRows = O.files.flatMap((f) => f.rows);
    const first = new Map(); for (const [k, occ] of O.keyMap) first.set(k, occ[0]);
    const pol = { 'all rows (no dedupe)': dailySums(allRows), 'dedupe, first seen wins': dailySums([...first.values()]), 'dedupe, latest wins': dailySums([...O.latest.values()]) };
    out.push('  daily gross_reported vs orders summed by UTC day:');
    for (const [name, sums] of Object.entries(pol)) out.push(`    ${pad(name, 26)} ${matchCount(rows, sums)}/${rows.length} days match`);
    const offs = []; for (let h = -12; h <= 14; h++) offs.push([h, matchCount(rows, dailySums([...O.latest.values()], h))]);
    offs.sort((a, b) => b[1] - a[1]); out.push(`  best day-boundary offsets (hours vs UTC): ${offs.slice(0, 3).map(([h, n]) => `${h >= 0 ? '+' : ''}${h}h=${n}`).join('  ')}`);
    const dl = pol['dedupe, latest wins']; const bad = rows.filter((r) => !close(r.gross, dl.get(r.date) ?? null));
    if (bad.length) {
      out.push(`  days where finance gross != deduped orders (${bad.length}):`);
      for (const r of bad.slice(0, 10)) out.push(`    ${r.date} finance=${fx(r.gross)} deduped=${fx(dl.get(r.date))} all-rows=${fx(pol['all rows (no dedupe)'].get(r.date))} first-wins=${fx(pol['dedupe, first seen wins'].get(r.date))}`);
      flag(scope, `finance gross_reported disagrees with deduped orders on ${bad.length}/${rows.length} days (see cross-source section)`);
    }
    const oc = new Set(O.files.flatMap((f) => [...f.cur.keys()])); const fc = new Set(rows.map((r) => r.cur));
    if ([...fc].some((c) => oc.size && !oc.has(c))) flag(scope, `currency label mismatch: finance says ${[...fc].join('/')} but orders say ${[...oc].join('/')}`);
    // net analysis
    const netGt = rows.filter((r) => r.net != null && r.gross != null && r.net > r.gross + 0.005).length;
    const refs = Rf ? [...Rf.latest.values()] : [];
    const refDay = new Map(); for (const r of refs) if (r.ms != null) cnt(refDay, dayOf(r.ms), r.amt ?? 0);
    const refOrderDay = new Map(); for (const r of refs) { const o = O.latest.get(r.ref); if (o?.ms != null) cnt(refOrderDay, dayOf(o.ms), r.amt ?? 0); }
    const nm = (fn) => rows.filter((r) => close(r.net, fn(r))).length;
    out.push(`  net_reported: net>gross on ${netGt}/${rows.length} days (impossible if net = gross - refunds)`);
    out.push(`    net == gross                                : ${nm((r) => r.gross)}/${rows.length}`);
    out.push(`    net == gross - refunds (by refunded_at day) : ${nm((r) => r.gross - (refDay.get(r.date) || 0))}/${rows.length}`);
    out.push(`    net == gross - refunds (by order created day): ${nm((r) => r.gross - (refOrderDay.get(r.date) || 0))}/${rows.length}`);
    const sumDiff = rows.reduce((a, r) => a + (r.gross - r.net), 0); const sumRef = refs.reduce((a, r) => a + (r.amt || 0), 0);
    out.push(`    sum(gross-net)=${fx(sumDiff)} vs sum(refund amounts)=${fx(sumRef)}`);
    if (netGt) flag(scope, `net_reported exceeds gross_reported on ${netGt} days; net cannot be reproduced from refunds (sum gross-net ${fx(sumDiff)} vs refunds ${fx(sumRef)})`);
  }

  // email vs orders, ads vs orders
  if (O && E) {
    const oe = new Set(O.files.flatMap((f) => f.rows.map((r) => r.email.toLowerCase()).filter(Boolean)));
    const ee = new Set(E.files.flatMap((f) => f.rows.map((r) => r.email.toLowerCase()).filter(Boolean)));
    const both = [...oe].filter((x) => ee.has(x)).length;
    out.push(`emails: ${oe.size} distinct order emails, ${ee.size} distinct event emails, ${both} in both (${oe.size ? ((100 * both) / oe.size).toFixed(1) : 0}% of buyers ever appear in events)`);
    const dirty = [...oe, ...ee].filter((x) => !/^[^@\s]+@[^@\s]+$/.test(x)).length;
    if (dirty) flag(scope, `${dirty} malformed email addresses`);
    const rawUpper = O.files.some((f) => f.rows.some((r) => r.email && r.email !== r.email.toLowerCase())) || E.files.some((f) => f.rows.some((r) => r.email && r.email !== r.email.toLowerCase()));
    if (rawUpper) flag(scope, 'emails with upper-case characters (case-normalise before joining)');
  }
  if (O && A) {
    const ch = new Set(O.files.flatMap((f) => [...f.cat.keys()])); const pl = new Set(A.files.flatMap((f) => [...f.cat.keys()]));
    const camps = new Set(A.files.flatMap((f) => f.rows.map((r) => r.camp)));
    out.push(`order channels {${[...ch].join(', ')}} vs ad platforms {${[...pl].join(', ')}}; ad campaigns {${list([...camps], 6)}}`);
    const unmatched = [...pl].filter((p) => ![...ch].some((c) => c.toLowerCase() === p.toLowerCase()));
    if (unmatched.length) flag(scope, `ad platform(s) with no matching order channel: ${unmatched.join(', ')}`);
  }
  if (E && A) {
    const ec = new Set(E.files.flatMap((f) => f.rows.map((r) => r.camp))); const ac = new Set(A.files.flatMap((f) => f.rows.map((r) => r.camp)));
    const shared = [...ec].filter((x) => ac.has(x)).length;
    out.push(`campaign ids: ${ec.size} in email events (${list([...ec], 3)}), ${ac.size} in ad spend (${list([...ac], 3)}), ${shared} shared`);
    if (!shared) flag(scope, 'email campaign ids and ad-spend campaign ids share no values (no join key)');
  }
  sections.push(out.join('\n'));
}

// ---------------------------------------------------------------- cross-tenant
{
  const out = ['## cross-tenant checks'];
  for (const s of SOURCES) {
    const sets = tenants.map((t) => [t, G[t]?.[s]?.keyMap]).filter(([, m]) => m);
    for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) {
      const shared = [...sets[i][1].keys()].filter((k) => sets[j][1].has(k));
      out.push(`${s}: ${sets[i][0]} ∩ ${sets[j][0]} = ${shared.length} shared keys`);
      if (shared.length) flag('cross-tenant', `${shared.length} ${s} keys appear in BOTH ${sets[i][0]} and ${sets[j][0]} (e.g. ${list(shared, 3)}) -> natural keys are NOT globally unique; tenant_id must be part of every key`);
    }
    const hdrs = tenants.map((t) => [t, G[t]?.[s]?.files[0]?.header.join('|')]).filter(([, h]) => h);
    if (new Set(hdrs.map(([, h]) => h)).size > 1) { out.push(`${s}: first-batch headers differ between tenants: ${hdrs.map(([t, h]) => `${t}=[${h}]`).join(' ')}`); flag('cross-tenant', `${s}: tenants use different first-batch headers`); }
  }
  const cur = tenants.map((t) => [t, [...new Set(Object.values(G[t] ?? {}).flatMap((x) => x.files.flatMap((f) => [...f.cur.keys()])))].join('/')]);
  out.push(`currencies by tenant: ${cur.map(([t, c]) => `${t}=${c || '-'}`).join('  ')}`);
  const tz = tenants.map((t) => [t, G[t]?.orders?.files.flatMap((f) => [...f.tsShapes.keys()]).join('/')]);
  out.push(`timestamp shapes in orders by tenant: ${tz.map(([t, c]) => `${t}=${[...new Set((c || '').split('/'))].join('+')}`).join('  ')}`);
  sections.push(out.join('\n'));
}

// ---------------------------------------------------------------- inventory & assembly
for (const m of missing) { inventory.push(`MISSING from disk: ${m.path} (${m.tenant}/${m.source} batch ${m.batch}, ${m.covers_from}..${m.covers_to})`); flag('inventory', `manifest batch missing on disk: ${m.tenant}/${m.source} batch ${m.batch} (${m.path})`); }
for (const f of files) if (!f.listed && manifest) { inventory.push(`NOT IN MANIFEST: ${f.rel}`); flag('inventory', `file not in manifest: ${f.rel}`); }
for (const f of unknownFiles) inventory.push(`unrecognised file (skipped): ${f.rel}`);
for (const f of files) {
  const ext = path.extname(f.rel).toLowerCase().slice(1);
  const want = { csv: ['csv'], ndjson: ['ndjson', 'jsonl'] }[f.format];
  if (want && !want.includes(ext) && ext !== 'txt') inventory.push(`extension/content mismatch: ${f.rel} is .${ext} but contains ${f.format}`);
}
const fmts = new Map(); for (const f of files) { const k = `${f.tenant}/${f.source}`; if (!fmts.has(k)) fmts.set(k, new Set()); fmts.get(k).add(f.format); }
for (const [k, v] of fmts) if (v.size > 1) flag(k, `file format changes between batches: ${[...v].join(' vs ')}`);

const head = [
  `FIXTURE PROFILE   root=${ROOT}   node=${process.version}`,
  `manifest: ${manifest ? `${manifest.batches.length} batches listed` : 'NOT FOUND'} | data files found: ${dataFiles.length} | finance files: ${financeFiles.length} | tenants: ${tenants.join(', ')}`,
  '',
  '## inventory',
  ...(inventory.length ? inventory.map((x) => '  ' + x) : [manifest ? '  all manifest files present, no extras, no identical files' : '  no manifest.json found: cannot check for missing or extra batches']),
];
if (manifest && missing.length === manifest.batches.length) head.splice(4, 0, '  !! NONE of the manifest batches were found under this root. Check the path argument (root should contain manifest.json and the tenant folders).');
const byScope = new Map(); for (const f of findings) { if (!byScope.has(f.scope)) byScope.set(f.scope, []); byScope.get(f.scope).push(f.msg); }
const summary = ['', `## FINDINGS (${findings.length})   [details in sections below]`];
if (!findings.length) summary.push('  (none)');
for (const [scope, msgs] of [...byScope.entries()].sort()) { summary.push(`  ${scope}`); for (const m of msgs) summary.push(`    ! ${m}`); }
const report = [...head, ...summary, '', ...sections.map((s) => s + '\n')].join('\n');
fs.writeFileSync(OUT, report);
console.log(report);
console.log(`\n(report also written to ${OUT})`);
