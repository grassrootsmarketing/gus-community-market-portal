#!/usr/bin/env node
// tools/check-binding.mjs — Codex §8.5 static check.
// Fails the build when application code can reach a database without going
// through the one validated binding module.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BINDING = 'api/_env.js';
const problems = [];

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (['node_modules', '.git', 'supabase'].includes(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|mjs|ts|html)$/.test(e)) out.push(p);
  }
  return out;
}

const files = walk('.');
const isTest = f => /(^|\/)(tests?)\//.test(f);
// The audit tools necessarily contain the very patterns they search for.
const isTool = f => /(^|\/)tools\//.test(f);

for (const f of files) {
  const rel = f.replace(/^\.\//, '');
  if (isTool(rel)) continue;
  const src = readFileSync(f, 'utf8');

  // 1. SUPABASE_* env reads outside the binding module.
  //    Binding tests may set fixtures; they may not build real clients.
  if (rel !== BINDING && /process\.env\.SUPABASE_/.test(src)) {
    if (!(isTest(rel) && /_env\.js/.test(src))) {
      problems.push(`${rel}: reads process.env.SUPABASE_* outside ${BINDING}`);
    }
  }

  // 2. Concrete project refs. Comments are fine; code is not.
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
  const refs = code.match(/\b[a-z]{20}\.supabase\.(co|in)\b/g) || [];
  if (refs.length) {
    // the binding module's RETIRED_REFS deny-list and negative test fixtures are allowed
    const allowed = rel === BINDING || (isTest(rel) && /RETIRED_REFS|deny/i.test(src));
    if (!allowed) problems.push(`${rel}: hardcoded Supabase host (${[...new Set(refs)].join(', ')})`);
  }

  // 3. Committed key literals, any class.
  if (/sb_secret_[A-Za-z0-9_-]{8,}/.test(code)) problems.push(`${rel}: *** SUPABASE SECRET KEY LITERAL ***`);
  if (/sb_publishable_[A-Za-z0-9_-]{8,}/.test(code)) problems.push(`${rel}: publishable key literal`);
  if (/eyJhbGciOiJIUzI1NiI[A-Za-z0-9_.-]{20,}/.test(code)) problems.push(`${rel}: JWT literal`);
  if (/sk_(live|test)_[A-Za-z0-9]{16,}/.test(code)) problems.push(`${rel}: *** STRIPE SECRET KEY LITERAL ***`);

  // 4. Fallback expressions that select a real host/key when config is missing.
  //    This is the shape that made production silently follow a retired project.
  if (/process\.env\.SUPABASE_[A-Z_]+\s*\|\|/.test(code)) {
    problems.push(`${rel}: fallback on missing SUPABASE_* config — must fail closed, never default`);
  }

  // 5. Browser-side Supabase clients. All client DB access goes via /api.
  if (/@supabase\/supabase-js|createClient\s*\(/.test(code) && /\.html$/.test(rel)) {
    problems.push(`${rel}: browser Supabase client — client DB access must go through /api`);
  }

  // 6. Runtime migration endpoints.
  if (/require\(['"]pg['"]\)|from ['"]pg['"]/.test(code) && !isTest(rel)) {
    problems.push(`${rel}: direct PostgreSQL connection in application code`);
  }

  // 7. Test harnesses must never allowlist a real project.
  if (isTest(rel) && /ALLOWED_PROJECT_REFS/.test(code)) {
    const m = code.match(/ALLOWED_PROJECT_REFS\s*=\s*\[([^\]]*)\]/);
    if (m && /[a-z]{20}/.test(m[1])) {
      problems.push(`${rel}: ALLOWED_PROJECT_REFS names a real project ref — deny targets only`);
    }
  }
}

console.log(`scanned ${files.length} files`);
if (problems.length) {
  console.log(`\n${problems.length} FAILURE(S):`);
  const grouped = {};
  for (const p of problems) { const k = p.split(':')[1].trim(); (grouped[k] ||= []).push(p.split(':')[0]); }
  for (const [kind, fs] of Object.entries(grouped)) {
    console.log(`\n  ✗ ${kind}  (${fs.length})`);
    for (const f of fs.slice(0, 8)) console.log(`      ${f}`);
    if (fs.length > 8) console.log(`      … and ${fs.length - 8} more`);
  }
  process.exit(1);
}
console.log('  ✓ all database access flows through the validated binding module');
