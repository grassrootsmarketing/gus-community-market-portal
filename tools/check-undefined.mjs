#!/usr/bin/env node
// tools/check-undefined.mjs — Codex §4: parser-based no-undef over api/.
//
// WHY A PARSER, NOT A REGEX: the api/brand-account.js SERVICE_KEY defect was a valid
// JavaScript program that referenced a name nobody declared. It was invisible to
// `node --check`, invisible to an import test (the throw is inside a handler), and a
// regex could not have distinguished it from a legitimate identifier. Only a real
// scope analysis finds this class. Running it found five MORE instances immediately.
//
// Reports every violation in one pass; exits nonzero if any remain.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';

// Resolve ESLint's CLI from this repository's own node_modules. If it is absent the check must
// FAIL LOUDLY rather than pass: a linter that cannot run is not a linter that found nothing.
const require = createRequire(import.meta.url);
let eslintBin;
try {
  eslintBin = resolve(dirname(require.resolve('eslint/package.json')), 'bin', 'eslint.js');
} catch {
  console.error('eslint is not installed. Run `npm install` — it is pinned in devDependencies.');
  process.exit(2);
}
import { relative, sep } from 'node:path';   // POSIX-only string surgery on cwd broke the
                                            // relative-path display on Windows (no match, so absolute paths leaked).

let out = '';
try {
  // Codex finding 1: execFileSync('npx', ...) cannot launch on Windows, where the executable is
  // npx.cmd and there is no shell to resolve it. Resolving ESLint's own bin through Node and
  // running it with process.execPath removes the platform dependency entirely — no shell, no
  // .cmd/.exe extension guessing, and it uses the exact ESLint pinned in devDependencies.
  out = execFileSync(process.execPath, [eslintBin, 'api', 'tools', 'tests', '--format', 'json'],
                     { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
} catch (e) {
  out = e.stdout || '';   // eslint exits nonzero when it finds problems
}
if (!out.trim()) { console.error('eslint produced no output — refusing to report success'); process.exit(2); }

const results = JSON.parse(out);
const undef = [];
for (const r of results) {
  for (const m of r.messages) {
    if (m.ruleId === 'no-undef') {
      undef.push(`${relative(process.cwd(), r.filePath).split(sep).join('/')}:${m.line}  ${m.message}`);
    }
  }
}

console.log(`no-undef checked ${results.length} files`);
if (undef.length) {
  console.log(`\n${undef.length} UNDEFINED IDENTIFIER(S) — each is a ReferenceError at runtime:`);
  for (const u of undef) console.log('  ✗ ' + u);
  process.exit(1);
}
console.log('  ✓ no undefined identifiers');
