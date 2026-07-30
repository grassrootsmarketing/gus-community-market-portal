#!/usr/bin/env node
// tools/check-js-columns.mjs
//
// Cross-checks every column name the JavaScript sends to PostgREST against the columns that
// actually exist in a database built from the migration chain.
//
// WHY. tools/check-sql-columns.mjs reads .sql files. It is blind to this, because these column
// names live only inside JS string literals:
//
//   sb(`retailers?verification_status=eq.${s}&select=id,verified_at,verified_by,...`)
//   sb(`retailers?id=eq.${id}`, { method:'PATCH', body: JSON.stringify({ verification_status, ... }) })
//
// retailers had none of those four columns. Both handlers wrap the call in try/catch and return
// HTTP 500 "Query failed", so the owner approval workflow did not merely break — it broke while
// reporting a generic server error that pointed nowhere near the schema.
//
// Checks three shapes:
//   1. select= lists in a PostgREST path
//   2. filter columns:  <col>=eq. / gt. / is. / like. / in. ...
//   3. order= columns
// PATCH/POST bodies are NOT checked: they are built from variables far more often than literals,
// so the false-positive rate would be high enough to make the check ignorable. Filters and selects
// are where the literals are, and they caught this defect.
//
// Usage: SB_URL=... SB_KEY=... node tools/check-js-columns.mjs
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SB_URL = process.env.SB_URL, SB_KEY = process.env.SB_KEY;
if (!SB_URL || !SB_KEY) { console.error('SB_URL and SB_KEY required (a database built from this chain)'); process.exit(2); }

const spec = await (await fetch(`${SB_URL}/rest/v1/`, { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY } })).json();
const schema = {};
for (const [t, def] of Object.entries(spec.definitions || {})) schema[t] = new Set(Object.keys(def.properties || {}));

// PostgREST reserved words and embedded-resource syntax that are not columns.
const RESERVED = new Set(['select','order','limit','offset','and','or','not','count','on_conflict','columns']);
const OPS = 'eq|neq|gt|gte|lt|lte|like|ilike|is|in|cs|cd|sl|sr|nxr|nxl|adj|ov|fts|plfts|phfts|wfts|not';

const files = readdirSync(resolve('api')).filter(f => f.endsWith('.js'));
const problems = [];

for (const f of files) {
  const src = readFileSync(resolve('api', f), 'utf8');
  // A PostgREST path begins with a known table name followed by ? or end-of-template.
  for (const m of src.matchAll(/[`'"]([a-z_][a-z0-9_]*)\?([^`'"]*)[`'"]/gi)) {
    const table = m[1].toLowerCase();
    if (!schema[table]) continue;
    const qs = m[2];

    // 1. select= list. Strip embedded resources (`brands(...)`) and aliases (`x:col`).
    const sel = /(?:^|&)select=([^&]*)/.exec(qs);
    if (sel) {
      const cleaned = sel[1].replace(/\$\{[^}]*\}/g, '').replace(/\w+\([^)]*\)/g, '');
      for (const raw of cleaned.split(',')) {
        const col = raw.trim().split(':').pop().trim().toLowerCase();
        if (!col || col === '*' || !/^[a-z_][a-z0-9_]*$/.test(col)) continue;
        if (!schema[table].has(col)) problems.push(`api/${f}: ${table}?select=...${col}  <- column does not exist`);
      }
    }

    // 2. filters: <col>=<op>.
    for (const fm of qs.matchAll(new RegExp(`(?:^|&)([a-z_][a-z0-9_]*)=(?:${OPS})\\.`, 'gi'))) {
      const col = fm[1].toLowerCase();
      if (RESERVED.has(col)) continue;
      if (!schema[table].has(col)) problems.push(`api/${f}: ${table}?${col}=eq...  <- column does not exist`);
    }

    // 3. order=
    const ord = /(?:^|&)order=([^&]*)/.exec(qs);
    if (ord) {
      for (const raw of ord[1].replace(/\$\{[^}]*\}/g, '').split(',')) {
        const col = raw.trim().split('.')[0].toLowerCase();
        if (!col || !/^[a-z_][a-z0-9_]*$/.test(col)) continue;
        if (!schema[table].has(col)) problems.push(`api/${f}: ${table}?order=${col}  <- column does not exist`);
      }
    }
  }
}

const uniq = [...new Set(problems)];
console.log(`js-column check: ${files.length} api files against ${Object.keys(schema).length} live tables`);
if (uniq.length) {
  console.log(`\n${uniq.length} reference(s) to columns that DO NOT EXIST:\n`);
  uniq.forEach(p => console.log('  ' + p));
  process.exit(1);
}
console.log('  ✓ every column the JS selects, filters or orders by exists in the built database');
