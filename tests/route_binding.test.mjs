// tests/route_binding.test.mjs — Codex §6.7: route-level zero-side-effect binding matrix.
//
// The unit tests in binding.test.mjs prove _env.js rejects bad configuration. They do NOT prove
// that a ROUTE consults it before doing anything. That gap is where the original incident lived:
// a control existed and nothing called it.
//
// This drives every production handler with an invalid binding and asserts two things per route:
//   1. it returns a controlled failure (503 binding_invalid, or a pure pre-binding rejection)
//   2. it makes ZERO outbound calls — no Supabase, no Storage, no Stripe, no email
//
// The matrix is generated mechanically from the api/ directory, so a new route cannot be added
// without appearing here. That is deliberate: a hand-maintained list is a list someone forgets.

import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; }
  else { fail++; failures.push(`${name} ${extra}`); }
}

// ---------------------------------------------------------------------------
// Deliberately invalid configuration: a well-formed URL for a project that is
// NOT in the target map, so assembleBinding rejects before any network use.
// ---------------------------------------------------------------------------
const INVALID_ENV = {
  VERCEL_ENV: 'preview',
  SUPABASE_URL: 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co',
  SUPABASE_SERVICE_KEY: 'fake-service-key-not-real',
  SUPABASE_ANON_KEY: 'fake-anon-key-not-real',
  SITE_ORIGIN: 'https://staging.example.test',
  STRIPE_SECRET_KEY: 'sk_test_fake',
  STRIPE_WEBHOOK_SECRET: 'whsec_fake',
  RESEND_API_KEY: 'fake-resend',
  EMAIL_ALLOWLIST: 'qa@example.test',
  CRON_SECRET: 'fake-cron-secret',
  SEED_SECRET: 'fake-seed-secret',
  ANTHROPIC_API_KEY: 'fake-anthropic',
};

// Any outbound call at all is a failure. We record the host so a violation names the provider.
function installNetworkSpy() {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    let host = 'unknown';
    try { host = new URL(String(url)).host; } catch { host = String(url).slice(0, 60); }
    calls.push({ host, method: (opts && opts.method) || 'GET' });
    throw new Error(`NETWORK CALL ESCAPED THE BINDING GUARD: ${host}`);
  };
  return calls;
}

function mockRes() {
  const r = {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    send(b) { this.body = b; return this; },
    end() { return this; },
  };
  return r;
}

// Routes that must NOT be treated as side-effecting handlers.
const SKIP = new Set([
  '_env.js',                    // the binding layer itself
  '_coi-lib.js', '_coi-lib.test.js',   // pure functions
  'apply-migrations.js',        // retired 410 stub, no binding
  'checkout-session.js',        // retired 410 stub
  'version.js',                 // diagnostic: intentionally answers when the binding is broken
]);

// Every handler gets a POST with a plausible-but-fake body. Routes that reject on method or
// missing auth BEFORE binding are also acceptable — the assertion is "controlled + zero calls",
// not "always 503".
function mockReq() {
  return {
    method: 'POST',
    url: '/api/test',
    query: { action: 'data', session_id: '00000000-0000-4000-8000-000000000000' },
    headers: { 'content-type': 'application/json', authorization: 'Bearer fake-cron-secret' },
    body: {
      session_id: '00000000-0000-4000-8000-000000000000',
      booking_id: '00000000-0000-4000-8000-000000000001',
      retailer_id: '00000000-0000-4000-8000-000000000002',
      brand_id: '00000000-0000-4000-8000-000000000003',
      owner: 'test-owner', email: 'qa@example.test', slug: 'test-retailer',
      action: 'data', secret: 'fake-seed-secret',
    },
  };
}

console.log('\n=== Codex §6.7 route-level binding matrix ===\n');

const files = readdirSync('api').filter(f => f.endsWith('.js') && !SKIP.has(f) && !f.endsWith('.test.js'));
const realEnv = process.env;
const realFetch = globalThis.fetch;

for (const f of files) {
  process.env = { ...INVALID_ENV };
  const calls = installNetworkSpy();

  let mod;
  try {
    // cache-bust so each route re-reads the poisoned env at module scope if it does that
    mod = await import(pathToFileURL(resolve('api', f)).href + `?t=${Date.now()}${Math.random()}`);
  } catch (e) {
    ok(`${f} imports`, false, `— import threw: ${e.message.split('\n')[0]}`);
    continue;
  }
  if (typeof mod.default !== 'function') { continue; }   // helper module, not a route

  const res = mockRes();
  let threw = null;
  try { await mod.default(mockReq(), res); } catch (e) { threw = e; }

  // 1. ZERO outbound calls is the load-bearing assertion.
  ok(`${f}: zero outbound calls`, calls.length === 0,
     `— made ${calls.length}: ${calls.map(c => c.method + ' ' + c.host).join(', ')}`);

  // 2. A controlled outcome.
  //
  // JUSTIFIED EXCEPTION — a route whose feature flag is OFF may return 200 saying so, provided it
  // made zero outbound calls. coi-enforcement.js is the case: its launch-flag gate short-circuits
  // before the binding guard, which is correct. A disabled scheduled job should report success to
  // the cron scheduler, not a 503 that looks like breakage. The safety property Codex asked for is
  // "zero side effects", and that is asserted above independently — this exception cannot hide a
  // side effect, only a status code.
  const disabledOk = res.statusCode === 200
    && res.body && (res.body.mode === 'off' || res.body.effective === 'off')
    && calls.length === 0;

  const controlled = disabledOk || (res.statusCode !== null && res.statusCode >= 400);
  ok(`${f}: controlled outcome (got ${res.statusCode ?? (threw ? 'threw' : 'no status')}${disabledOk ? ', flag-disabled' : ''})`,
     controlled, threw ? `— threw ${threw.message.split('\n')[0]}` : '');

  // 3. Never acknowledge WORK on an invalid binding.
  ok(`${f}: no successful work`, disabledOk || !(res.statusCode >= 200 && res.statusCode < 300),
     `— returned ${res.statusCode}`);
}

process.env = realEnv;
globalThis.fetch = realFetch;

console.log(`  routes exercised: ${files.length}`);
if (failures.length) {
  console.log(`\n${failures.length} FAILURE(S):`);
  for (const f of failures) console.log('  ✗ ' + f);
}
console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);
