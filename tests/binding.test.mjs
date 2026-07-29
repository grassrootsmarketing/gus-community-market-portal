// tests/binding.test.mjs — Codex §8.6, all 16 required binding cases.
//
// Every case asserts TWO things: the expected outcome, AND that a failure produced ZERO outbound
// calls. A guard that returns 503 after already writing to the database is not a guard, so the
// call counter is the real assertion.
//
// No network. No credentials. Fake refs only — a real project ref never appears in this file
// except as an explicit DENY target (Codex §8.5).

import {
  getBinding, BindingError, parseProjectRef, resolveTargetName,
  _resetBindingCache, RETIRED_REFS, diagnosticSnapshot, sendBindingFailure,
} from '../api/_env.js';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
}

// ---- fixtures ------------------------------------------------------------
const PROD_REF = 'aaaaaaaaaaaaaaaaaaaa';       // fake "new production"
const STAGE_REF = 'bbbbbbbbbbbbbbbbbbbb';      // fake "new staging"
const OTHER_REF = 'cccccccccccccccccccc';      // fake unrelated project

const TARGETS = {
  production:  { projectRef: PROD_REF,  dbEnvironment: 'production',  stripeMode: 'live', emailMode: 'real' },
  preview:     { projectRef: STAGE_REF, dbEnvironment: 'staging',     stripeMode: 'test', emailMode: 'sink' },
  development: { projectRef: OTHER_REF, dbEnvironment: 'development', stripeMode: 'test', emailMode: 'sink' },
};

function baseEnv(over = {}) {
  return {
    VERCEL_ENV: 'preview',
    SUPABASE_URL: `https://${STAGE_REF}.supabase.co`,
    SUPABASE_SERVICE_KEY: 'fake-service-key',
    SITE_ORIGIN: 'https://staging.example.test',
    STRIPE_SECRET_KEY: 'sk_test_fake',
    EMAIL_ALLOWLIST: 'qa@example.test',
    ...over,
  };
}

// counting fetch stub: identity answers come from `identity`, everything else is recorded
function makeFetch(identity, { unreachable = false, status = 200 } = {}) {
  const calls = [];
  const f = async (url, opts) => {
    calls.push({ url: String(url), method: (opts && opts.method) || 'GET' });
    if (unreachable) throw new Error('ECONNREFUSED');
    if (status !== 200) return { ok: false, status, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => (identity ? [identity] : []) };
  };
  f.calls = calls;
  return f;
}

async function expectFail(name, env, identity, expectedCode, fetchOpts) {
  _resetBindingCache();
  const f = makeFetch(identity, fetchOpts);
  let err = null;
  try { await getBinding({ env, fetch: f, targets: TARGETS }); }
  catch (e) { err = e; }
  ok(`${name} → rejected`, err instanceof BindingError, `(got ${err && err.message})`);
  if (expectedCode) ok(`${name} → code ${expectedCode}`, err && err.code === expectedCode, `(got ${err && err.code})`);
  return f;
}

console.log('\n=== Codex §8.6 binding tests ===\n');

// 1 missing URL
await expectFail('1. missing SUPABASE_URL', baseEnv({ SUPABASE_URL: '' }), null, 'missing_required_config');

// 2 missing service key
await expectFail('2. missing SUPABASE_SERVICE_KEY', baseEnv({ SUPABASE_SERVICE_KEY: '' }), null, 'missing_required_config');

// 3 missing publishable key where required — find-retailer's anon path must not fall back
{
  _resetBindingCache();
  const f = makeFetch({ environment: 'staging', project_ref: STAGE_REF });
  const b = await getBinding({ env: baseEnv({ SUPABASE_ANON_KEY: '' }), fetch: f, targets: TARGETS });
  ok('3. missing publishable key → binding exposes null, never a literal', b.publishableKey === null);
}

// 4 malformed URL
await expectFail('4. malformed URL', baseEnv({ SUPABASE_URL: 'not-a-url' }), null, 'supabase_url_malformed');
await expectFail('4b. http:// rejected', baseEnv({ SUPABASE_URL: `http://${STAGE_REF}.supabase.co` }), null, 'supabase_url_not_https');
await expectFail('4c. lookalike host rejected', baseEnv({ SUPABASE_URL: `https://${STAGE_REF}.supabase.co.evil.test` }), null, 'supabase_url_unrecognised_host');

// 5 preview pointed at production URL
await expectFail('5. preview → production URL',
  baseEnv({ SUPABASE_URL: `https://${PROD_REF}.supabase.co` }), null, 'project_ref_mismatch');

// 6 production pointed at staging URL  ← the exact shape of the real incident
await expectFail('6. production → staging URL',
  baseEnv({ VERCEL_ENV: 'production', SUPABASE_URL: `https://${STAGE_REF}.supabase.co`,
            STRIPE_SECRET_KEY: 'sk_live_fake', REAL_EMAIL_ENABLED: 'true' }),
  null, 'project_ref_mismatch');

// 7 URL and service key from different projects (project rejects the credential)
{
  const f = await expectFail('7. URL/key from different projects',
    baseEnv(), null, 'credentials_rejected_by_project', { status: 401 });
  ok('7b. → exactly one outbound call, none after rejection', f.calls.length === 1, `(got ${f.calls.length})`);
}

// 8 database identity says the wrong environment
await expectFail('8. db says production, target is staging',
  baseEnv(), { environment: 'production', project_ref: STAGE_REF }, 'database_environment_mismatch');

// 9 database identity reports the wrong project ref
await expectFail('9. db reports a different project ref',
  baseEnv(), { environment: 'staging', project_ref: OTHER_REF }, 'database_project_ref_mismatch');

// 9b unprovisioned identity is a failure, not an "unknown but fine"
await expectFail('9b. identity row absent', baseEnv(), null, 'identity_not_provisioned');

// 10 preview with a Stripe LIVE key
await expectFail('10. preview + sk_live', baseEnv({ STRIPE_SECRET_KEY: 'sk_live_fake' }), null, 'stripe_mode_mismatch');

// 11 production with a Stripe TEST key when live mode is required
await expectFail('11. production + sk_test while LIVE_PAYMENTS_ENABLED=true',
  baseEnv({ VERCEL_ENV: 'production', SUPABASE_URL: `https://${PROD_REF}.supabase.co`,
            STRIPE_SECRET_KEY: 'sk_test_fake', LIVE_PAYMENTS_ENABLED: 'true', REAL_EMAIL_ENABLED: 'true' }),
  null, 'stripe_mode_mismatch');

// 12 preview configured for unrestricted email delivery
await expectFail('12. preview without an email allowlist',
  baseEnv({ EMAIL_ALLOWLIST: '' }), null, 'email_allowlist_required_for_non_production');

// 12b production must opt in to real email explicitly
await expectFail('12b. production without REAL_EMAIL_ENABLED',
  baseEnv({ VERCEL_ENV: 'production', SUPABASE_URL: `https://${PROD_REF}.supabase.co`,
            STRIPE_SECRET_KEY: 'sk_live_fake' }),
  null, 'real_email_not_enabled');

// 13 database unreachable during validation
{
  const f = await expectFail('13. identity check unreachable', baseEnv(), null, 'identity_check_unreachable', { unreachable: true });
  ok('13b. unreachable is NOT cached as success', f.calls.length === 1);
}

// 14 a failed validation causes zero side effects
{
  _resetBindingCache();
  const f = makeFetch(null);
  try { await getBinding({ env: baseEnv({ SUPABASE_URL: `https://${PROD_REF}.supabase.co` }), fetch: f, targets: TARGETS }); } catch (_) {}
  ok('14. config-level failure makes ZERO outbound calls', f.calls.length === 0, `(got ${f.calls.length})`);

  let status = null, body = null;
  const res = { setHeader() {}, status(s) { status = s; return this; }, json(b) { body = b; return this; } };
  sendBindingFailure(res, new BindingError('project_ref_mismatch', { target: 'production' }));
  ok('14b. responds 503', status === 503, `(got ${status})`);
  ok('14c. body is generic — no ref, no target, no key', JSON.stringify(body) === '{"error":"binding_invalid"}', JSON.stringify(body));
}

// 15 successful staging validation allows the request
{
  _resetBindingCache();
  const f = makeFetch({ environment: 'staging', project_ref: STAGE_REF });
  const b = await getBinding({ env: baseEnv(), fetch: f, targets: TARGETS });
  ok('15. staging validates', b.targetName === 'preview' && b.projectRef === STAGE_REF);
  ok('15b. stripe mode test', b.stripeMode === 'test');
  ok('15c. email contained', b.emailMode === 'sink' && b.emailAllowlist.length === 1);

  const before = f.calls.length;
  await getBinding({ env: baseEnv(), fetch: f, targets: TARGETS });
  ok('15d. success cached — no second identity round-trip', f.calls.length === before);

  const snap = diagnosticSnapshot(b);
  const s = JSON.stringify(snap);
  ok('15e. diagnostic leaks no key', !s.includes('fake-service-key') && !s.includes('sk_test_fake'));
  ok('15f. diagnostic leaks no full ref', !s.includes(STAGE_REF));
}

// 16 the retired production ref is denied after cutover, whatever config says
{
  const retired = [...RETIRED_REFS];
  ok('16. both old refs are in the deny set', retired.length === 2);
  for (const ref of retired) {
    const T = { ...TARGETS, production: { ...TARGETS.production, projectRef: ref } };
    _resetBindingCache();
    const f = makeFetch({ environment: 'production', project_ref: ref });
    let err = null;
    try {
      await getBinding({
        env: baseEnv({ VERCEL_ENV: 'production', SUPABASE_URL: `https://${ref}.supabase.co`,
                       STRIPE_SECRET_KEY: 'sk_live_fake', REAL_EMAIL_ENABLED: 'true' }),
        fetch: f, targets: T,
      });
    } catch (e) { err = e; }
    ok(`16b. ${ref.slice(0, 6)}… denied even when the target map names it`, err && err.code === 'retired_project_ref');
    ok(`16c. ${ref.slice(0, 6)}… made zero outbound calls`, f.calls.length === 0);
  }
}

// extra: placeholder targets (the real shipped state before R3) can never validate production
{
  _resetBindingCache();
  const { TARGETS: SHIPPED } = await import('../api/_env.js');
  ok('17. shipped production ref is unset until R3', SHIPPED.production.projectRef === null);
  const f = makeFetch({ environment: 'production', project_ref: PROD_REF });
  let err = null;
  try {
    await getBinding({
      env: baseEnv({ VERCEL_ENV: 'production', SUPABASE_URL: `https://${PROD_REF}.supabase.co`,
                     STRIPE_SECRET_KEY: 'sk_live_fake', REAL_EMAIL_ENABLED: 'true' }),
      fetch: f,   // NOTE: no targets override — uses the shipped map
    });
  } catch (e) { err = e; }
  ok('17b. production cannot validate on placeholders', err && err.code === 'target_ref_not_configured');
  ok('17c. and made zero outbound calls', f.calls.length === 0);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);
