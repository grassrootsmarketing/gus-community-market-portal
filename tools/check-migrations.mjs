#!/usr/bin/env node
// tools/check-migrations.mjs — Codex §4.9: reject migration-source defects before
// they reach a database. Every rule here corresponds to a defect that actually
// occurred in this chain, not a hypothetical.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'supabase/migrations';
// EVERY entry in this directory is read, not only the .sql ones. The previous version
// globbed *.sql and then skipped one file BY NAME (see below), so a file that violated
// the rules sat in the migration directory while this checker printed green.
const entries = readdirSync(DIR).sort();
const files = entries.filter(f => f.endsWith('.sql'));
const problems = [];

// R1: `0025a` executed fine in a hand-ordered batch but is not a version the
// official Supabase runner accepts — it could be skipped silently.
const VERSION = /^(\d{4,})_[a-z0-9._-]+\.sql$/i;
const versions = new Map();
let baselines = 0;

// R1b: NOTHING may live in supabase/migrations except numbered migrations and README.md.
// This rule exists because audit_orphan_sessions_and_prod_preflight.sql — a read-only
// runbook script consisting entirely of bare SELECTs — sat in this directory for the whole
// project. It was invisible because this checker carried a hardcoded exemption for it by
// filename, so the "no interactive SELECTs" rule reported green while the directory held a
// file that was nothing but interactive SELECTs. An exemption inside a control is a hole in
// the control. The file has been moved to supabase/audits/; the rule below makes the class
// of mistake impossible rather than making this one instance quiet.
//
// It also matters operationally: `supabase db reset` reads this directory, not this
// checker's opinion of it. Anything here is the CLI's problem whether or not we count it.
const ALLOWED_NON_MIGRATION = new Set(['README.md']);
for (const e of entries) {
  if (ALLOWED_NON_MIGRATION.has(e)) continue;
  if (!e.endsWith('.sql')) {
    problems.push(`STRAY FILE in ${DIR}: ${e} — only numbered migrations and README.md belong here`);
  }
}

for (const f of files) {
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
