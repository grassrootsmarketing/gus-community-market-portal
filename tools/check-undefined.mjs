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
import { relative, sep } from 'node:path';   // POSIX-only string surgery on cwd broke the
                                            // relative-path display on Windows (no match, so absolute paths leaked).

let out = '';
try {
  out = execFileSync('npx', ['--no-install', 'eslint', 'api', 'tools', 'tests', '--format', 'json'],
                     { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
} catch (e) {
  out = e.stdout || '';   // eslint exits nonzero when it finds problems
}
if (!out.trim()) { console.error('could not run eslint — is it installed? (npm i -D eslint)'); process.exit(2); }

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
