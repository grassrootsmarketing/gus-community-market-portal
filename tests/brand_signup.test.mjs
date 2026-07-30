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
  await mod.default({ method: 'POST', headers: { 'x-forwarded-for': '203.0.113.9' },
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
  await mod.default({ method: 'POST', headers: { 'x-forwarded-for': '203.0.113.9' },
    body: { action: 'verify', email: 'attacker@evil.test', code: '000000' } }, res);

  ok('verify: uses the atomic redeem RPC', f.rpcs.includes('redeem'));
  ok('verify: no direct provisioning writes',
     f.writes.filter(w => /brands|brand_members|brand_account_sessions/.test(w)).length === 0,
     `— saw ${JSON.stringify(f.writes)}`);
  ok('verify: wrong code -> 400 with an undifferentiated error',
     res.statusCode === 400 && res.body?.error === 'verification_failed', JSON.stringify(res.body));
  ok('verify: no session token in the body', !/session_token/.test(JSON.stringify(res.body || {})));
}

// ---- the retired path must be gone, not merely discouraged ----
{
  process.env = { ...ENV }; _resetBindingCache();
  const f = spyFetch(); globalThis.fetch = f;
  const mod = await import(pathToFileURL(resolve('api', 'brand-account.js')).href + '?t=' + Math.random());
  const res = mockRes();
  await mod.default({ method: 'POST', url: '/api/brand-account?action=signup', query: { action: 'signup' },
    headers: {}, body: { action: 'signup', email: 'attacker@evil.test', company_name: 'TAKEOVER' } }, res);
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
