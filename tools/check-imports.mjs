#!/usr/bin/env node
// tools/check-imports.mjs — every api/ module must actually LOAD.
//
// WHY THIS EXISTS: api/booking.js has a stray `}` that `node --check` accepts but
// ESM module evaluation rejects. The route has been unloadable on the launch
// branch and nothing caught it, because the obvious syntax check is precisely the
// one that passes. A file that cannot be imported is a dead route.
import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Codex §5.5-5.7: deterministic fake configuration, and any network call during import is a
// failure. Real refs are never supplied — a module must not need a live project to load, and
// supplying one would mask binding_invalid instead of proving the module is structurally sound.
process.env = {
  VERCEL_ENV: 'preview',
  SUPABASE_URL: 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co',
  SUPABASE_SERVICE_KEY: 'fake-service-key',
  SUPABASE_ANON_KEY: 'fake-anon-key',
  SITE_ORIGIN: 'https://staging.example.test',
  STRIPE_SECRET_KEY: 'sk_test_fake',
  STRIPE_WEBHOOK_SECRET: 'whsec_fake',
  RESEND_API_KEY: 'fake-resend',
  EMAIL_ALLOWLIST: 'qa@example.test',
  CRON_SECRET: 'fake-cron', SEED_SECRET: 'fake-seed', ANTHROPIC_API_KEY: 'fake-anthropic',
};

const networkCalls = [];
globalThis.fetch = async (url) => {
  let host = 'unknown';
  try { host = new URL(String(url)).host; } catch { host = String(url).slice(0, 60); }
  networkCalls.push(host);
  throw new Error(`network call at import time: ${host}`);
};

const files = readdirSync('api').filter(f => f.endsWith('.js') && !f.endsWith('.test.js'));
const failures = [];

for (const f of files) {
  try {
    await import(pathToFileURL(resolve('api', f)).href);
  } catch (e) {
    // Only structural failures matter here. A module that throws because config is
    // absent is behaving correctly — that is the binding layer failing closed.
    const msg = String(e && e.message || e);
    if (e instanceof SyntaxError || /Unexpected token|Cannot find module|is not defined/.test(msg)) {
      failures.push(`${f}: ${e.name}: ${msg.split('\n')[0]}`);
    }
  }
}

// §5.7: a module that reaches the network merely by being imported is doing work at load time.
if (networkCalls.length) {
  for (const h of [...new Set(networkCalls)]) {
    failures.push(`IMPORT-TIME NETWORK CALL to ${h} — modules must not perform I/O on load`);
  }
}

console.log(`import-checked ${files.length} modules under api/  (network calls during import: ${networkCalls.length})`);
if (failures.length) {
  console.log(`\n${failures.length} MODULE(S) CANNOT LOAD:`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('  ✓ every api/ module loads');
