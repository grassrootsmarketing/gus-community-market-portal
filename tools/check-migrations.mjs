#!/usr/bin/env node
// tools/check-migrations.mjs — Codex §4.9: reject migration-source defects before
// they reach a database. Every rule here corresponds to a defect that actually
// occurred in this chain, not a hypothetical.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'supabase/migrations';
const files = readdirSync(DIR).filter(f => f.endsWith('.sql')).sort();
const problems = [];

// R1: `0025a` executed fine in a hand-ordered batch but is not a version the
// official Supabase runner accepts — it could be skipped silently.
const VERSION = /^(\d{4,})_[a-z0-9._-]+\.sql$/i;
const versions = new Map();
let baselines = 0;

for (const f of files) {
  if (f === 'audit_orphan_sessions_and_prod_preflight.sql') continue;   // not a migration
  const m = VERSION.exec(f);
  if (!m) { problems.push(`INVALID FILENAME: ${f} — expected <numeric-version>_<name>.sql`); continue; }
  const v = m[1];
  if (versions.has(v)) problems.push(`DUPLICATE VERSION ${v}: ${versions.get(v)} and ${f}`);
  versions.set(v, f);
  if (Number(v) === 0) baselines++;

  const raw = readFileSync(join(DIR, f), 'utf8');
  const sql = raw.replace(/\$\$[\s\S]*?\$\$/g, '').replace(/--[^\n]*/g, '');
  for (const stmt of sql.split(';')) {
    const t = stmt.trim();
    if (/^select\b/i.test(t) && !/\binto\b/i.test(t.slice(0, 200))) {
      problems.push(`INTERACTIVE SELECT in ${f}: a bare SELECT is a runbook step, not a migration statement — it aborts an automated chain`);
      break;
    }
  }
  if (/alter\s+table\s+storage\.objects/i.test(sql)) {
    problems.push(`${f} alters storage.objects — owned by supabase_storage_admin, fails with 42501`);
  }
  if (/create\s+policy/i.test(sql) && /storage\.objects/i.test(sql)) {
    problems.push(`${f} creates a storage.objects policy — Demohub's design is zero custom object policies (service-key writes, signed reads)`);
  }
}

if (baselines !== 1) problems.push(`Expected exactly one 0000 baseline, found ${baselines}`);

const refs = /ecapmcyumpjjgjwuokyv|eubbgurdwqmwqduamwhn/;
for (const f of files) {
  const raw = readFileSync(join(DIR, f), 'utf8');
  const code = raw.replace(/--[^\n]*/g, '');   // comments may reference retired refs
  if (refs.test(code)) problems.push(`${f} contains a retired project ref outside a comment`);
}

console.log(`checked ${versions.size} migrations in ${DIR}`);
if (problems.length) {
  console.log('\nFAILURES:');
  for (const p of problems) console.log('  ✗ ' + p);
  process.exit(1);
}
console.log('  ✓ filenames valid, versions unique, one baseline, no interactive SELECTs, no storage.objects ALTER/POLICY, no retired refs');
