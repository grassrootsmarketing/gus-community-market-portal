// tests/brand_signup.test.mjs — Codex finding A.
// The claim under test: the REQUEST stage writes nothing. Previously the reachable handler
// PATCHed an existing brand's profile, inserted brands + brand_members, and issued a session,
// all before the caller proved they owned the email address.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, x = '') => c ? pass++ : (fail++, fails.push(`${n} ${x}`));

// The shipped TARGETS map has projectRef: null so production cannot validate on placeholders.
// A VALID-binding functional test has to stand in for R3 provisioning, so we set the preview ref
// on the live exported object and restore it afterwards. Mutating it here — rather than adding an
// env-var escape hatch to _env.js — keeps the production guarantee intact.
import { TARGETS, _resetBindingCache } from '../api/_env.js';
const REF = 'bbbbbbbbbbbbbbbbbbbb';
const savedRef = TARGETS.preview.projectRef;
TARGETS.preview.projectRef = REF;

const ENV = {
  VERCEL_ENV: 'preview',
  SUPABASE_URL: `https://${REF}.supabase.co`,
  SUPABASE_SERVICE_KEY: 'fake', SUPABASE_ANON_KEY: 'fake',
  SITE_ORIGIN: 'https://staging.example.test',
  STRIPE_SECRET_KEY: 'sk_test_fake', EMAIL_ALLOWLIST: 'qa@example.test',
  RESEND_API_KEY: 'fake', VERIFY_PEPPER: 'x'.repeat(40), CRON_SECRET: 'fake-cron',
};


// A legitimate caller here is the signup page on this origin, so the mock must carry the header a
// browser actually sends. Sec-Fetch-Site is the strongest evidence requireSameOrigin() accepts and
// is not settable by page script — which is exactly why the guard denies a POST that carries none.
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };

function mockRes() {
  return { statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; }, getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
}

// Records every Supabase write and every RPC so we can assert what the request stage touched.
function spyFetch({ identityOk = true } = {}) {
  const writes = [], rpcs = [], mail = [];
  const f = async (url, opts = {}) => {
    const u = String(url); const method = opts.method || 'GET';
    if (u.includes('/rpc/get_deployment_identity')) {
      return { ok: identityOk, status: identityOk ? 200 : 401,
               json: async () => [{ environment: 'staging', project_ref: 'bbbbbbbbbbbbbbbbbbbb' }] };
    }
    if (u.includes('/rpc/verification_throttle_hit')) { rpcs.push('throttle'); return { ok: true, status: 200, text: async () => JSON.stringify({ allowed: true }) }; }
    if (u.includes('/rpc/redeem_brand_signup')) { rpcs.push('redeem'); return { ok: true, status: 200, text: async () => JSON.stringify({ outcome: 'invalid' }) }; }
    if (u.includes('api.resend.com')) { mail.push(1); return { ok: true, status: 200, json: async () => ({}) }; }
    if (u.includes('/rest/v1/')) {
      const table = u.split('/rest/v1/')[1].split('?')[0];
      if (method !== 'GET') writes.push(`${method} ${table}`);
      // Return a realistic row for the challenge insert, otherwise createChallenge throws on
      // .id and the request path short-circuits before sendCode — which would make the
      // "only the challenge table is written" assertion pass for the wrong reason.
      if (table === 'email_verifications' && method === 'POST') {
        const row = [{ id: '00000000-0000-4000-8000-0000000000aa', email: 'attacker@evil.test',
                       purpose: 'brand_signup', attempts: 0 }];
        return { ok: true, status: 201, text: async () => JSON.stringify(row), json: async () => row };
      }
      return { ok: true, status: 200, text: async () => '[]', json: async () => [] };
    }
    return { ok: true, status: 200, text: async () => '[]', json: async () => [] };
  };
  f.writes = writes; f.rpcs = rpcs; f.mail = mail;
  return f;
}

const realEnv = process.env, realFetch = globalThis.fetch;

// ---- REQUEST stage must write nothing ----
{
  process.env = { ...ENV }; _resetBindingCache();
  const f = spyFetch(); globalThis.fetch = f;
  const mod = await import(pathToFileURL(resolve('api', 'brand-signup.js')).href + '?t=' + Math.random());
  const res = mockRes();
  await mod.default({ method: 'POST', headers: { ...SAME_ORIGIN, 'x-forwarded-for': '203.0.113.9' },
    body: { action: 'request', email: 'attacker@evil.test', company_name: 'TAKEOVER', contact_name: 'X', phone: '1' } }, res);

  const brandWrites = f.writes.filter(w => /brands|brand_members|brand_account_sessions/.test(w));
  ok('request: NO write to brands / brand_members / brand_account_sessions',
     brandWrites.length === 0, `— saw ${JSON.stringify(brandWrites)}`);
  ok('request: only the challenge table is written',
     f.writes.every(w => /email_verifications/.test(w)), `— saw ${JSON.stringify(f.writes)}`);
  ok('request: throttle consulted', f.rpcs.includes('throttle'));
  ok('request: generic 200 reply', res.statusCode === 200 && /code is on its way/i.test(res.body?.message || ''));
  ok('request: reply leaks no account existence', !/exists|already|unknown/i.test(JSON.stringify(res.body)));
}

// ---- VERIFY goes through the atomic RPC, and a wrong code reveals nothing ----
{
  process.env = { ...ENV }; _resetBindingCache();
  const f = spyFetch(); globalThis.fetch = f;
  const mod = await import(pathToFileURL(resolve('api', 'brand-signup.js')).href + '?t=' + Math.random());
  const res = mockRes();
  await mod.default({ method: 'POST', headers: { ...SAME_ORIGIN, 'x-forwarded-for': '203.0.113.9' },
    body: { action: 'verify', email: 'attacker@evil.test', code: '000000' } }, res);

  ok('verify: uses the atomic redeem RPC', f.rpcs.includes('redeem'));
  ok('verify: no direct provisioning writes',
     f.writes.filter(w => /brands|brand_members|brand_account_sessions/.test(w)).length === 0,
     `— saw ${JSON.stringify(f.writes)}`);
  ok('verify: wrong code -> 400 with an undifferentiated error',
     res.statusCode === 400 && res.body?.error === 'verification_failed', JSON.stringify(res.body));
  ok('verify: no session token in the body', !/session_token/.test(JSON.stringify(res.body || {})));
}

// ---- the signup category rides the challenge and is applied once at redeem (blank-only) ----
{
  process.env = { ...ENV }; _resetBindingCache();
  const base = spyFetch();
  const bodies = [];
  const scenario = { category: 'Protein, bars & energy' };
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url); const method = opts.method || 'GET';
    if (u.includes('/rpc/redeem_brand_signup')) { base.rpcs.push('redeem'); return { ok: true, status: 200, text: async () => JSON.stringify({ outcome: 'ok', brand_id: 'b-1', created: true, expires_at: '2027-01-01T00:00:00Z' }) }; }
    if (u.includes('/rest/v1/email_verifications') && method === 'GET' && u.includes('consumed_at=not.is.null')) {
      return { ok: true, status: 200, json: async () => [{ payload: { company_name: 'Cat Co', default_categories: scenario.category } }] };
    }
    if (u.includes('/rest/v1/') && method !== 'GET') bodies.push({ method, table: u.split('/rest/v1/')[1].split('?')[0], filter: u.split('?')[1] || '', body: String(opts.body || '') });
    return base(url, opts);
  };
  const mod = await import(pathToFileURL(resolve('api', 'brand-signup.js')).href + '?t=' + Math.random());

  // request: the category is part of the challenge payload (bounded, whitespace-normalised)
  let res = mockRes();
  await mod.default({ method: 'POST', headers: { ...SAME_ORIGIN, 'x-forwarded-for': '203.0.113.9' },
    body: { action: 'request', email: 'cat@brand.test', company_name: 'Cat Co', contact_name: 'C', phone: '1', default_categories: '  Protein,   bars & energy  ' } }, res);
  const chal = bodies.find(b => b.table === 'email_verifications' && b.method === 'POST');
  ok('request: the challenge payload carries the normalised category', !!chal && JSON.parse(chal.body).payload.default_categories === 'Protein, bars & energy', chal && chal.body.slice(0, 200));
  ok('request: still no brand writes', !bodies.some(b => /^brands|brand_members|brand_account_sessions/.test(b.table)));

  // verify (correct code): the category lands on the brand row, blank-only, after the atomic redeem
  bodies.length = 0; res = mockRes();
  await mod.default({ method: 'POST', headers: { ...SAME_ORIGIN, 'x-forwarded-for': '203.0.113.9' },
    body: { action: 'verify', email: 'cat@brand.test', code: '123456' } }, res);
  const patch = bodies.find(b => b.table === 'brands' && b.method === 'PATCH');
  ok('verify: 200 with the brand id', res.statusCode === 200 && res.body && res.body.brand_id === 'b-1', JSON.stringify(res.body));
  ok('verify: the category from the consumed challenge is written to the brand', !!patch && JSON.parse(patch.body).default_categories === 'Protein, bars & energy', patch && patch.body);
  ok('verify: the write is blank-only (filters on default_categories=is.null) and scoped to that brand', !!patch && /id=eq\.b-1/.test(patch.filter) && /default_categories=is\.null/.test(patch.filter), patch && patch.filter);
  ok('verify: no other provisioning writes (the RPC did those)', bodies.filter(b => /^brands$|brand_members|brand_account_sessions/.test(b.table)).length === 1, JSON.stringify(bodies.map(b => b.method + ' ' + b.table)));

  // verify with NO category on the challenge: nothing is written to brands
  scenario.category = null; bodies.length = 0; res = mockRes();
  await mod.default({ method: 'POST', headers: { ...SAME_ORIGIN, 'x-forwarded-for': '203.0.113.9' },
    body: { action: 'verify', email: 'cat@brand.test', code: '123456' } }, res);
  ok('verify without a category: 200 and no brands write at all', res.statusCode === 200 && !bodies.some(b => b.table === 'brands'), JSON.stringify(bodies));
  globalThis.fetch = realFetch;
}

// ---- the retired path must be gone, not merely discouraged ----
{
  process.env = { ...ENV }; _resetBindingCache();
  const f = spyFetch(); globalThis.fetch = f;
  const mod = await import(pathToFileURL(resolve('api', 'brand-account.js')).href + '?t=' + Math.random());
  const res = mockRes();
  await mod.default({ method: 'POST', url: '/api/brand-account?action=signup', query: { action: 'signup' },
    headers: { ...SAME_ORIGIN }, body: { action: 'signup', email: 'attacker@evil.test', company_name: 'TAKEOVER' } }, res);
  // Same-origin on purpose: the claim under test is that the retired path is GONE, so it must not
  // be able to pass for closed merely because the CSRF guard rejected the request first.
  ok('brand-account?action=signup returns 410', res.statusCode === 410, `— got ${res.statusCode}`);
  ok('retired path writes nothing',
     f.writes.filter(w => /brands|brand_members|brand_account_sessions/.test(w)).length === 0,
     `— saw ${JSON.stringify(f.writes)}`);
}

// ---- the pepper must be required, with no weak fallback ----
{
  process.env = { ...ENV, VERIFY_PEPPER: '' };
  const v = await import(pathToFileURL(resolve('api', '_verify.js')).href + '?t=' + Math.random());
  let err = null;
  try { v.hashCode('a@b.test', 'brand_signup', '123456'); } catch (e) { err = e; }
  ok('empty VERIFY_PEPPER throws', err && /verify_pepper_not_configured/.test(err.message));
}
{
  process.env = { ...ENV, VERIFY_PEPPER: 'short' };
  const v = await import(pathToFileURL(resolve('api', '_verify.js')).href + '?t=' + Math.random());
  let err = null;
  try { v.hashCode('a@b.test', 'brand_signup', '123456'); } catch (e) { err = e; }
  ok('too-short VERIFY_PEPPER throws', err && /verify_pepper_not_configured/.test(err.message));
}
{
  process.env = { ...ENV, VERIFY_PEPPER: '', CRON_SECRET: 'y'.repeat(60) };
  const v = await import(pathToFileURL(resolve('api', '_verify.js')).href + '?t=' + Math.random());
  let err = null;
  try { v.hashCode('a@b.test', 'brand_signup', '123456'); } catch (e) { err = e; }
  ok('CRON_SECRET is NOT accepted as the pepper', err && /verify_pepper_not_configured/.test(err.message));
}

TARGETS.preview.projectRef = savedRef;
process.env = realEnv; globalThis.fetch = realFetch;
console.log(`\n=== brand signup: ${pass} passed, ${fail} failed ===`);
if (fails.length) for (const x of fails) console.log('  ✗ ' + x);
process.exit(fail === 0 ? 0 : 1);
