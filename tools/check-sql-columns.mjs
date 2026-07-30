#!/usr/bin/env node
// tools/check-sql-columns.mjs
//
// Cross-checks every column referenced by the migration chain's SQL against the columns that
// actually exist in a live database built from that chain.
//
// WHY THIS EXISTS. PL/pgSQL does not resolve identifiers in a function body at CREATE time — the
// body is parsed, not bound. A migration containing `UPDATE bookings SET refund_id = ...` applies
// cleanly and reports success even when bookings has no refund_id column. The error (42703) only
// appears when that specific BRANCH executes, which may be months later, on the refund path, in
// production.
//
// Two such defects reached this codebase:
//   settings.billing_tier   in enforce_venue_limit()  — broke ALL venue creation
//   bookings.refund_id      in apply_refund_event()   — broke refund application
// Neither was visible to: migration success, the clean-build manifest comparison (both builds were
// identically broken), the mocked route tests, or a probe that called each function once (the bad
// column sat in a branch dummy arguments never reached).
//
// Static analysis catches what execution coverage misses, and vice versa. This is the static half.
//
// Usage: SB_URL=... SB_KEY=... node tools/check-sql-columns.mjs
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SB_URL = process.env.SB_URL, SB_KEY = process.env.SB_KEY;
if (!SB_URL || !SB_KEY) { console.error('SB_URL and SB_KEY required (a database built from this chain)'); process.exit(2); }

// ---- live schema ----
const spec = await (await fetch(`${SB_URL}/rest/v1/`, { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY } })).json();
const schema = {};
for (const [t, def] of Object.entries(spec.definitions || {})) schema[t] = new Set(Object.keys(def.properties || {}));
const tables = new Set(Object.keys(schema));

// ---- migration SQL ----
const dir = resolve('supabase/migrations');
const files = readdirSync(dir).filter(f => /^\d+_.*\.sql$/.test(f)).sort();

// Strip strings, dollar-quoted bodies are KEPT (that is the whole point — the bugs live in them),
// but SQL line/block comments are removed so commentary cannot create false positives.
function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/--.*$/, '')).join('\n');
}

const problems = [];
// `UPDATE <table> SET a = .., b = ..` — the shape that produced both real defects.
const UPDATE_RE = /\bupdate\s+(?:public\.)?([a-z_][a-z0-9_]*)\s+set\s+([\s\S]*?)(?=\bwhere\b|\breturning\b|;)/gi;
// `INSERT INTO <table> (cols)`
const INSERT_RE = /\binsert\s+into\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*\(([^)]*)\)/gi;

for (const f of files) {
  const sql = stripComments(readFileSync(resolve(dir, f), 'utf8'));

  for (const m of sql.matchAll(UPDATE_RE)) {
    const table = m[1].toLowerCase();
    if (!tables.has(table)) continue;               // not a PostgREST-visible table; skip
    for (const assign of m[2].split(',')) {
      const col = (assign.split('=')[0] || '').trim().toLowerCase().replace(/^"|"$/g, '');
      if (!/^[a-z_][a-z0-9_]*$/.test(col)) continue;
      if (!schema[table].has(col)) problems.push(`${f}: UPDATE ${table} SET ${col}  <- column does not exist`);
    }
  }

  for (const m of sql.matchAll(INSERT_RE)) {
    const table = m[1].toLowerCase();
    if (!tables.has(table)) continue;
    for (const raw of m[2].split(',')) {
      const col = raw.trim().toLowerCase().replace(/^"|"$/g, '');
      if (!/^[a-z_][a-z0-9_]*$/.test(col)) continue;
      if (!schema[table].has(col)) problems.push(`${f}: INSERT INTO ${table} (${col})  <- column does not exist`);
    }
  }
}

// Qualified references: `table.column` or `alias.column` where the alias was bound to a known
// table in the same statement. Only fully-qualified `<known table>.<col>` forms are judged, because
// resolving arbitrary aliases correctly needs a real parser and a wrong guess here would produce
// false positives that train people to ignore this check.
const QUAL_RE = /\b(?:public\.)?([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/gi;
const SQL_NOISE = new Set(['sql','pg_catalog','information_schema','storage','auth','supabase_migrations','excluded','new','old','tg','v','e','j','p','r','s','t','c','n','con','x']);
for (const f of files) {
  const sql = stripComments(readFileSync(resolve(dir, f), 'utf8'));
  for (const m of sql.matchAll(QUAL_RE)) {
    const table = m[1].toLowerCase(), col = m[2].toLowerCase();
    if (SQL_NOISE.has(table) || !tables.has(table)) continue;
    if (!schema[table].has(col)) problems.push(`${f}: reference ${table}.${col}  <- column does not exist`);
  }
}

// Deduplicate: the same bad reference is usually rewritten across several migrations.
const uniq = [...new Set(problems)];
console.log(`sql-column check: ${files.length} migrations against ${tables.size} live tables`);
if (uniq.length) {
  console.log(`\n${uniq.length} reference(s) to columns that DO NOT EXIST:\n`);
  uniq.forEach(p => console.log('  ' + p));
  process.exit(1);
}
console.log('  ✓ every column written by the migration chain exists in the built database');
