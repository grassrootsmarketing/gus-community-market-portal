// tests/version_probe.test.mjs
//
// CL-02 (Codex final work order): /api/version must (a) expose the effective provisional-holds flag in
// the OPERATOR-authenticated view so launch state is provable in fact, and (b) keep the PUBLIC view
// coarse — build id + health only, no configuration footprint. The flag VALUE matrix
// (unset/empty/false/malformed/uppercase/padded/"true") lives in launch_flags.test.mjs; this file
// proves the version PROBE's public/operator split. Offline: the public branch returns before any
// binding call, and getBinding() fails fast on unconfigured env (caught -> binding_error), so no
// network is touched.

// Env must be set BEFORE importing the handler (both version.js and _flags.js read env at load).
process.env.CRON_SECRET = 'test-cron-secret-value';
delete process.env.PROVISIONAL_HOLDS_ENABLED;   // unset -> effective false
for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'VERCEL_ENV']) delete process.env[k];

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, detail === undefined ? '' : `-> ${JSON.stringify(detail)}`); }
};

function mockRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

const { default: handler } = await import('../api/version.js');

console.log('\n--- CL-02: /api/version public/operator split ---');

// PUBLIC (no auth): coarse only.
{
  const res = mockRes();
  await handler({ headers: {} }, res);
  const keys = Object.keys(res.body || {}).sort();
  check('public response is 200', res.statusCode === 200, res.statusCode);
  check('public keys are exactly ok/build/now', JSON.stringify(keys) === JSON.stringify(['build', 'now', 'ok']), keys);
  const leaked = ['flags', 'binding', 'commit', 'branch', 'env', 'has_cron_secret', 'provisionalHolds']
    .filter(k => k in (res.body || {}));
  check('public response leaks no config/identity footprint', leaked.length === 0, leaked);
  check('public response has no flags object', !('flags' in (res.body || {})));
}

// OPERATOR (correct secret): full snapshot including provisionalHolds.
{
  const res = mockRes();
  await handler({ headers: { authorization: 'Bearer test-cron-secret-value' } }, res);
  check('operator response is 200', res.statusCode === 200, res.statusCode);
  const flags = (res.body && res.body.flags) || null;
  check('operator response includes flags snapshot', !!flags);
  check('operator snapshot INCLUDES provisionalHolds', flags && ('provisionalHolds' in flags), flags && Object.keys(flags));
  check('provisionalHolds is false when the env var is unset', flags && flags.provisionalHolds === false, flags && flags.provisionalHolds);
  check('connected checkout still reported hard_disabled', flags && flags.connectedCheckout === 'hard_disabled', flags && flags.connectedCheckout);
}

// OPERATOR with a WRONG secret must fall back to the public (coarse) view.
{
  const res = mockRes();
  await handler({ headers: { authorization: 'Bearer wrong-secret' } }, res);
  check('wrong secret does NOT expose flags', !('flags' in (res.body || {})), Object.keys(res.body || {}));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
