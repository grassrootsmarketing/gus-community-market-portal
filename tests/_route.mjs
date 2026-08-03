// tests/_route.mjs — VALID-BINDING route harness.
//
// Codex finding 2. tests/live_flows.test.mjs calls PostgREST and RPCs directly with a
// service-role key. That is real database-contract evidence and it found five defects, but it
// proves nothing about the API ROUTE: not the binding guard, not the role cookie, not CSRF, not
// request parsing, not authorization, not email containment. Claiming Step 4 complete on that
// basis was the same mistake this project keeps making — a control exercised in principle rather
// than in fact.
//
// This harness invokes the ACTUAL exported handler with a canonical request:
//   * real HTTP method
//   * real JSON body
//   * real role cookie (dh_owner_session / dh_retailer_session / dh_brand_session)
//   * real CSRF evidence (sec-fetch-site: same-origin) unless a test is asserting denial
//   * a VALID binding against the rebuilt staging database
//
// Supabase is REAL — the handler reads and writes staging. Stripe and Resend are spied, because
// a route test must not reach a payment provider or send mail. Every spied call is recorded so a
// test can assert that mail was contained or that no provider call happened at all.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { TARGETS, _resetBindingCache } from '../api/_env.js';

const { SB_URL, SB_KEY, SB_REF } = process.env;
if (!SB_URL || !SB_KEY || !SB_REF) { console.error('SB_URL, SB_KEY, SB_REF required'); process.exit(2); }
if (['ecapmcyumpjjgjwuokyv', 'eubbgurdwqmwqduamwhn'].includes(SB_REF)) {
  console.error(`REFUSING: ${SB_REF} is production or a retired project.`); process.exit(2);
}

export const ORIGIN = 'https://staging.demohubhq.test';

// The shipped TARGETS map has projectRef: null so production cannot validate on a placeholder.
// A valid-binding test has to stand in for that, so the ref is set on the live object at run time
// and never committed. This is the same technique brand_signup.test.mjs uses.
TARGETS.preview.projectRef = SB_REF;

export const ENV = {
  VERCEL_ENV: 'preview',
  SUPABASE_URL: SB_URL,
  SUPABASE_SERVICE_KEY: SB_KEY,
  SUPABASE_ANON_KEY: 'anon-not-used-by-these-routes',
  SITE_ORIGIN: ORIGIN,
  STRIPE_SECRET_KEY: 'sk_test_harness',
  STRIPE_WEBHOOK_SECRET: 'whsec_harness',
  RESEND_API_KEY: 'harness-resend-key',
  EMAIL_ALLOWLIST: 'sink@fixture.test',
  VERIFY_PEPPER: 'x'.repeat(40),
  CRON_SECRET: 'harness-cron-secret',
  SEED_SECRET: 'harness-seed-secret',
  ANTHROPIC_API_KEY: 'harness-anthropic',
  // Checkout ships behind a launch flag and is OFF by default — api/checkout.js returns
  // 503 checkout_disabled before it reads a session. Route tests must turn it on explicitly,
  // and tests/launch_flags.test.mjs separately proves the default-off behaviour, so enabling it
  // here does not erase that guarantee.
  CHECKOUT_ENABLED: 'true',
  // Codex v6 requires the COI proof to run with upload ON and AI verification OFF -- the
  // exact closed-launch configuration in which an upload lands 'pending' and therefore
  // needs a human reviewer. COI_AI_VERIFICATION_ENABLED is deliberately ABSENT, so it
  // takes its default-off value rather than being set to a string that happens to be false.
  COI_UPLOAD_ENABLED: 'true',
};

// ---------------------------------------------------------------------------
// Provider spy. Supabase passes through to the real staging database; Stripe and
// Resend are intercepted so a route test can never charge a card or send an email.
// ---------------------------------------------------------------------------
export function installSpy() {
  const real = globalThis.fetch;
  const calls = { stripe: [], resend: [], supabase: 0, other: [] };
  const fixtures = { paymentIntents: {}, checkoutSessions: {} };
  // Test-only fault injection on the REAL staging passthrough. A test can force a specific Supabase
  // request (matched by url substring + optional method) to fail, so failure/reconciliation paths are
  // exercised deterministically WITHOUT any production code seam. Never touched by production.
  const faults = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('api.stripe.com')) {
      calls.stripe.push({ url: u, method: (opts.method || 'GET'), body: String(opts.body || '').slice(0, 300) });
      // Shapes the handlers actually consume.
      // TEST-CONTROLLED FIXTURES — Codex v6.
      // The previous spy returned an invented shape for every Stripe GET, which is fine for
      // proving a route does not call Stripe but useless for proving it handles a PAID
      // outcome: api/stripe-webhook.js retrieves the PaymentIntent with
      //     GET /v1/payment_intents/{id}?expand[]=latest_charge
      // and applies the ledger from the CHARGE it finds there. A test that cannot control
      // that object cannot drive a real payment through the handler.
      //
      // Fixtures are keyed by id and set by the test. An unregistered id falls through to
      // the generic shape below, so nothing that does not opt in changes behaviour.
      const piMatch = u.match(/\/v1\/payment_intents\/([^?\/]+)/);
      if (piMatch && fixtures.paymentIntents[decodeURIComponent(piMatch[1])]) {
        return jsonRes(fixtures.paymentIntents[decodeURIComponent(piMatch[1])]);
      }
      const csMatch = u.match(/\/v1\/checkout\/sessions\/([^?\/]+)/);
      if (csMatch && fixtures.checkoutSessions[decodeURIComponent(csMatch[1])]) {
        return jsonRes(fixtures.checkoutSessions[decodeURIComponent(csMatch[1])]);
      }
      if (u.includes('/checkout/sessions')) {
        return jsonRes({ id: 'cs_test_' + Math.random().toString(36).slice(2, 10), url: 'https://checkout.stripe.test/x' });
      }
      if (u.includes('/refunds')) return jsonRes({ id: 're_test_' + Math.random().toString(36).slice(2, 10), amount: 3000, status: 'succeeded' });
      return jsonRes({ id: 'obj_test', object: 'unknown' });
    }
    if (u.includes('api.resend.com')) {
      let parsed = null; try { parsed = JSON.parse(opts.body); } catch (_) {}
      calls.resend.push({ to: parsed && parsed.to, subject: parsed && parsed.subject, html: (parsed && parsed.html) || '' });
      return jsonRes({ id: 'email_test' });
    }
    if (u.includes(SB_REF)) {
      calls.supabase++;
      const fault = faults.find(f => u.includes(f.url) && (!f.method || String(opts.method || 'GET').toUpperCase() === f.method));
      if (fault) return { ok: false, status: fault.status || 500, json: async () => ({ message: fault.message || 'injected_fault' }), text: async () => JSON.stringify({ message: fault.message || 'injected_fault' }) };
      return real(url, opts);
    }
    calls.other.push(u.slice(0, 120));
    return real(url, opts);
  };
  return { calls, fixtures, faults, restore: () => { globalThis.fetch = real; } };
}
const jsonRes = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });

// ---------------------------------------------------------------------------
// Canonical request / response
// ---------------------------------------------------------------------------
export function mockRes() {
  return {
    statusCode: null, body: null, headers: {}, ended: false,
    setHeader(k, v) { this.headers[k] = v; return this; },
    getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.ended = true; return this; },
    send(b) { this.body = b; this.ended = true; return this; },
    end() { this.ended = true; return this; },
    cookies() { const h = this.headers['Set-Cookie']; return !h ? [] : (Array.isArray(h) ? h : [h]); },
    cookie(name) {
      const c = this.cookies().find(x => x.startsWith(name + '='));
      if (!c) return null;
      const v = c.slice(name.length + 1).split(';')[0];
      return v === '' ? '' : decodeURIComponent(v);
    },
  };
}

// A canonical same-origin browser POST. Pass csrf:false to assert denial instead.
export function req({ method = 'POST', body = {}, cookies = {}, query = {}, csrf = true, headers = {} } = {}) {
  const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
  return {
    method,
    body,
    query,
    socket: { remoteAddress: '203.0.113.7' },
    headers: {
      'content-type': 'application/json',
      'x-real-ip': '203.0.113.7',
      origin: ORIGIN,
      ...(csrf ? { 'sec-fetch-site': 'same-origin' } : {}),
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
      ...headers,
    },
  };
}

// Import the handler fresh each call so module-level binding cache cannot leak between tests.
export async function callRoute(file, request) {
  process.env = { ...ENV };
  _resetBindingCache();
  const mod = await import(pathToFileURL(resolve('api', file)).href + '?t=' + Date.now() + Math.random());
  const res = mockRes();
  await mod.default(request, res);
  return res;
}

// api/stripe-webhook.js reads the RAW body off the request stream, because a signature must be
// verified against the exact bytes Stripe sent — not a re-serialised parse of them. So a webhook
// request cannot be the plain object the other routes accept; it has to be a readable stream.
export function rawReq(rawBody, { signature = null, headers = {} } = {}) {
  const { Readable } = require_stream();
  const stream = Readable.from([Buffer.from(rawBody)]);
  stream.method = 'POST';
  stream.query = {};
  stream.socket = { remoteAddress: '203.0.113.7' };
  stream.headers = {
    'content-type': 'application/json',
    ...(signature ? { 'stripe-signature': signature } : {}),
    ...headers,
  };
  return stream;
}
function require_stream() { return streamMod; }
import * as streamMod from 'node:stream';

export const state = { pass: 0, fail: 0, fails: [] };
export function ok(name, cond, extra = '') {
  if (cond) { state.pass++; console.log(`  ok   ${name}`); }
  else { state.fail++; state.fails.push(`${name} ${extra}`); console.log(`  FAIL ${name} ${extra}`); }
}
export function summary(label) {
  console.log(`\n${label}: ${state.pass} passed, ${state.fail} failed`);
  if (state.fail) { console.log('FAILURES:'); state.fails.forEach(f => console.log('  x ' + f)); }
  return state.fail === 0;
}
export const uniq = (p) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
