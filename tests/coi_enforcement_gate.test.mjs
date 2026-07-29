// tests/coi_enforcement_gate.test.mjs — Gate 0 / G0-v2-4.
//
// Route-level proof that the money-moving COI worker returns BEFORE any operational work when the
// launch flag does not explicitly permit it — even with COI_ENFORCEMENT_MODE=live.
//
// Method: stub global.fetch and count every outbound call the handler attempts (Supabase, Resend,
// Stripe). After authorization succeeds, a gated run must make ZERO outbound calls.
//
// Run from the repository root:   node tests/coi_enforcement_gate.test.mjs

const CRON = 'test-cron-secret';
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, detail === undefined ? '' : `-> ${JSON.stringify(detail)}`); }
}

function mockRes() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

async function runCase(label, env, { expectWork }) {
  for (const k of ['COI_AUTO_ENFORCEMENT_ENABLED', 'COI_ENFORCEMENT_MODE']) delete process.env[k];
  Object.assign(process.env, env);
  process.env.CRON_SECRET = CRON;
  // No Supabase fixtures: the route no longer reads process.env for its target — it goes through
  // api/_env.js. A gated run must return before the binding is ever resolved, and an ungated
  // regression now fails loudly (unresolvable binding -> 503) instead of silently reaching a DB.

  // record every outbound request the handler tries to make
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push(String(url).split('?')[0]);
    return { ok: true, status: 200, text: async () => '[]', json: async () => [] };
  };

  let res = mockRes();
  try {
    const mod = await import(`../api/coi-enforcement.js?case=${Math.random()}`);
    const handler = mod.default;
    await handler({ method: 'POST', headers: { authorization: 'Bearer ' + CRON }, query: {}, body: {} }, res);
  } catch (e) {
    res.body = { error: String((e && e.message) || e) };
  } finally {
    global.fetch = realFetch;
  }

  const outbound = calls.length;
  if (!expectWork) {
    check(`${label}: response reports effective off`,
      res.body && (res.body.effective === 'off' || res.body.mode === 'off'), res.body);
    check(`${label}: ZERO outbound calls after auth (no DB / email / Stripe)`, outbound === 0, calls.slice(0, 4));
  } else {
    check(`${label}: gate permits work (outbound attempted)`, outbound > 0, outbound);
  }
  return { outbound, body: res.body };
}

console.log('\n--- COI worker must NOT act unless the launch flag literally permits it ---');
await runCase('flag unset + mode=live', { COI_ENFORCEMENT_MODE: 'live' }, { expectWork: false });
await runCase('flag false + mode=live', { COI_AUTO_ENFORCEMENT_ENABLED: 'false', COI_ENFORCEMENT_MODE: 'live' }, { expectWork: false });
await runCase('flag malformed + mode=live', { COI_AUTO_ENFORCEMENT_ENABLED: 'yes', COI_ENFORCEMENT_MODE: 'live' }, { expectWork: false });
await runCase('flag TRUE uppercase + mode=live', { COI_AUTO_ENFORCEMENT_ENABLED: 'TRUE', COI_ENFORCEMENT_MODE: 'live' }, { expectWork: false });
await runCase('flag true + mode unset', { COI_AUTO_ENFORCEMENT_ENABLED: 'true' }, { expectWork: false });
await runCase('flag true + mode=off', { COI_AUTO_ENFORCEMENT_ENABLED: 'true', COI_ENFORCEMENT_MODE: 'off' }, { expectWork: false });

console.log('\n--- unauthorized callers are rejected before anything else ---');
{
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (u) => { calls.push(String(u)); return { ok: true, status: 200, text: async () => '[]', json: async () => [] }; };
  process.env.CRON_SECRET = CRON;
  const res = mockRes();
  const mod = await import(`../api/coi-enforcement.js?case=${Math.random()}`);
  await mod.default({ method: 'POST', headers: { authorization: 'Bearer WRONG' }, query: {}, body: {} }, res);
  global.fetch = realFetch;
  check('wrong cron secret -> 401', res.statusCode === 401, res.statusCode);
  check('wrong cron secret -> zero outbound calls', calls.length === 0, calls.length);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
