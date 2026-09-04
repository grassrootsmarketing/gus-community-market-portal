// tests/session_transport.test.mjs — Codex finding B.
//
// The claim under test is not "a CSRF helper exists". One did: api/_session.js exported
// checkOrigin() and no route called it. So this suite is built to fail if the control is present
// but unwired, which is the failure mode this project keeps producing.
//
// Structure:
//   PART 1  unit — api/_cookies.js attributes and role separation
//   PART 2  unit — api/_csrf.js decision table, including the same-site sibling case
//   PART 3  route — a real handler, valid binding, spied network: the seven scenarios Codex named
//   PART 4  static — leak scans across api/ and the HTML pages, so a regression anywhere in the
//           repo fails here rather than in a review months later
//
// PART 4 matters as much as PART 3. Parts 1-3 prove the new path is correct; Part 4 proves the old
// paths are gone and cannot be reintroduced quietly.

import { readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve, join, sep } from 'node:path';

// Every path this suite builds is normalised to forward slashes at construction. Rules and
// exclusion lists are written with '/', and a Windows '\\' would silently stop matching them.
const norm = p => p.split(sep).join('/');

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, x = '') => c ? pass++ : (fail++, fails.push(`${n} ${x}`));

// ===========================================================================
// PART 1 — api/_cookies.js
// ===========================================================================
import {
  COOKIE, setSessionCookie, clearSessionCookie, clearAllSessionCookies,
  readCookies, getSessionToken, sessionSecretInWrongPlace,
} from '../api/_cookies.js';

function mockRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    getHeader(k) { return this.headers[k]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    send(b) { this.body = b; return this; },
    end() { return this; },
  };
}
const setCookies = res => {
  const h = res.headers['Set-Cookie'];
  return !h ? [] : (Array.isArray(h) ? h : [h]);
};

{
  ok('cookies: three distinct role names', new Set(Object.values(COOKIE)).size === 3);
  ok('cookies: owner and retailer are NOT the same cookie', COOKIE.owner !== COOKIE.retailer);

  const res = mockRes();
  setSessionCookie(res, 'retailer', 'sid-1');
  const c = setCookies(res)[0];
  ok('cookies: HttpOnly', /;\s*HttpOnly/.test(c), c);
  ok('cookies: Secure', /;\s*Secure/.test(c), c);
  ok('cookies: SameSite=Lax', /;\s*SameSite=Lax/.test(c), c);
  ok('cookies: Path=/', /;\s*Path=\//.test(c), c);
  // Host-only: a Domain attribute would send the session to every subdomain, so a compromised
  // or third-party subdomain could harvest it.
  ok('cookies: NO Domain attribute (host-only)', !/;\s*Domain=/i.test(c), c);

  const res2 = mockRes();
  setSessionCookie(res2, 'owner', 'sid-owner');
  setSessionCookie(res2, 'retailer', 'sid-retailer');
  ok('cookies: two roles produce two Set-Cookie headers, neither overwritten',
     setCookies(res2).length === 2
     && setCookies(res2).some(x => x.startsWith(COOKIE.owner + '='))
     && setCookies(res2).some(x => x.startsWith(COOKIE.retailer + '=')));

  const res3 = mockRes();
  clearAllSessionCookies(res3);
  ok('cookies: clearAll expires every role', setCookies(res3).length === 3
     && setCookies(res3).every(x => /Max-Age=0/.test(x)));

  const res4 = mockRes();
  clearSessionCookie(res4, 'retailer');
  ok('cookies: clearing retailer does not touch owner',
     setCookies(res4).length === 1 && setCookies(res4)[0].startsWith(COOKIE.retailer + '='));

  // Role isolation on READ. This is the assertion that would have caught the old design, where
  // impersonation wrote the single dh_session cookie and owner code then read it back.
  const req = { headers: { cookie: `${COOKIE.owner}=OWNER; ${COOKIE.retailer}=RETAILER; ${COOKIE.brand}=BRAND` } };
  ok('cookies: retailer read returns the retailer value', getSessionToken(req, 'retailer') === 'RETAILER');
  ok('cookies: owner read returns the owner value', getSessionToken(req, 'owner') === 'OWNER');
  ok('cookies: brand read returns the brand value', getSessionToken(req, 'brand') === 'BRAND');
  ok('cookies: a retailer-only jar yields NO owner session',
     getSessionToken({ headers: { cookie: `${COOKIE.retailer}=R` } }, 'owner') === null);

  // No fallback. A body or query credential must be invisible to the reader, not merely deprioritised.
  ok('cookies: body session is NOT accepted',
     getSessionToken({ headers: {}, body: { session_id: 'X', session_token: 'X' } }, 'retailer') === null);
  ok('cookies: query session is NOT accepted',
     getSessionToken({ headers: {}, query: { session_id: 'X', session_token: 'X' } }, 'retailer') === null);

  // Unanchored cookie matching was a real defect in api/refund-booking.js: /dh_session=([^;]+)/
  // also matched a cookie whose NAME merely ended in the session name.
  ok('cookies: a cookie whose name merely ends in the session name is not accepted',
     getSessionToken({ headers: { cookie: `evil_${COOKIE.retailer}=ATTACK` } }, 'retailer') === null);

  ok('cookies: unknown role throws rather than silently reading nothing',
     (() => { try { getSessionToken(req, 'admin'); return false; } catch { return true; } })());

  ok('cookies: sessionSecretInWrongPlace flags a body credential',
     sessionSecretInWrongPlace({ body: { session_token: 'x' } }).includes('body.session_token'));
  ok('cookies: sessionSecretInWrongPlace flags a query credential',
     sessionSecretInWrongPlace({ query: { session_id: 'x' } }).includes('query.session_id'));
  ok('cookies: sessionSecretInWrongPlace is silent on a clean request',
     sessionSecretInWrongPlace({ body: { action: 'data' }, query: {} }).length === 0);
}

// ===========================================================================
// PART 2 — api/_csrf.js
// ===========================================================================
import { checkSameOrigin, CSRF_EXEMPT_REASONS, noteCsrfExemption } from '../api/_csrf.js';

{
  const BOUND = { siteOrigin: 'https://demohubhq.com', targetName: 'production' };
  const at = (method, headers) => checkSameOrigin({ method, headers }, BOUND);

  ok('csrf: GET is exempt (safe method)', at('GET', {}).ok);
  ok('csrf: HEAD is exempt', at('HEAD', {}).ok);
  ok('csrf: OPTIONS is exempt', at('OPTIONS', {}).ok);

  ok('csrf: POST with Sec-Fetch-Site: same-origin passes',
     at('POST', { 'sec-fetch-site': 'same-origin' }).ok);

  ok('csrf: POST from a cross-site page is denied',
     at('POST', { 'sec-fetch-site': 'cross-site' }).ok === false);

  // THE SIBLING CASE. A different subdomain is same-site, so SameSite=Lax still sends the cookie.
  // Accepting 'same-site' here would leave every sibling origin — including a preview deployment
  // on the same registrable domain — able to drive authenticated mutations.
  const sib = at('POST', { 'sec-fetch-site': 'same-site' });
  ok('csrf: POST from a same-SITE sibling origin is DENIED', sib.ok === false, JSON.stringify(sib));

  ok('csrf: fetch metadata outranks a forged Origin header',
     at('POST', { 'sec-fetch-site': 'cross-site', origin: 'https://demohubhq.com' }).ok === false);

  ok('csrf: matching Origin passes when fetch metadata is absent',
     at('POST', { origin: 'https://demohubhq.com' }).ok);
  ok('csrf: mismatched Origin is denied',
     at('POST', { origin: 'https://evil.test' }).ok === false);
  ok('csrf: a sibling subdomain in Origin is denied',
     at('POST', { origin: 'https://staging.demohubhq.com' }).ok === false);
  ok('csrf: Origin differing only by scheme is denied',
     at('POST', { origin: 'http://demohubhq.com' }).ok === false);
  ok('csrf: Origin differing only by port is denied',
     at('POST', { origin: 'https://demohubhq.com:8443' }).ok === false);

  ok('csrf: Referer is accepted only as a last resort and only when it matches',
     at('POST', { referer: 'https://demohubhq.com/r/gus/admin' }).ok);
  ok('csrf: mismatched Referer is denied',
     at('POST', { referer: 'https://evil.test/x' }).ok === false);

  // Fail closed. A mutation that says nothing about its provenance is not a mutation we serve.
  ok('csrf: POST with no Origin, Referer or fetch metadata is DENIED',
     at('POST', {}).ok === false);
  ok('csrf: denial reason is no_origin_evidence', at('POST', {}).reason === 'no_origin_evidence');

  ok('csrf: a garbage Origin is denied, not crashed on',
     at('POST', { origin: 'not-a-url' }).ok === false);
  ok('csrf: an unconfigured site origin denies rather than defaults',
     checkSameOrigin({ method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } }, {}).ok === false);

  ok('csrf: PUT/PATCH/DELETE are all judged, not just POST',
     ['PUT', 'PATCH', 'DELETE'].every(m => at(m, {}).ok === false));

  // Exemptions must be a closed, named set — an unrecognised reason cannot be waved through.
  ok('csrf: exactly two exemptions are defined', Object.keys(CSRF_EXEMPT_REASONS).length === 2);
  ok('csrf: a named exemption is accepted', noteCsrfExemption(CSRF_EXEMPT_REASONS.STRIPE_WEBHOOK));
  ok('csrf: an invented exemption throws',
     (() => { try { noteCsrfExemption('because_i_said_so'); return false; } catch { return true; } })());
}

// ===========================================================================
// PART 3 — route level, valid binding, spied network
// ===========================================================================
import { TARGETS, _resetBindingCache } from '../api/_env.js';
const REF = 'bbbbbbbbbbbbbbbbbbbb';
const savedRef = TARGETS.preview.projectRef;
TARGETS.preview.projectRef = REF;

const ORIGIN = 'https://staging.example.test';
const ENV = {
  VERCEL_ENV: 'preview',
  SUPABASE_URL: `https://${REF}.supabase.co`,
  SUPABASE_SERVICE_KEY: 'fake', SUPABASE_ANON_KEY: 'fake',
  SITE_ORIGIN: ORIGIN,
  STRIPE_SECRET_KEY: 'sk_test_fake', EMAIL_ALLOWLIST: 'qa@example.test',
  RESEND_API_KEY: 'fake', VERIFY_PEPPER: 'x'.repeat(40), CRON_SECRET: 'fake-cron',
};

const SID = '11111111-1111-4111-8111-111111111111';
const OWNER_SID = '22222222-2222-4222-8222-222222222222';
const RID = '33333333-3333-4333-8333-333333333333';
const FUTURE = new Date(Date.now() + 36e5).toISOString();

// The deployment-identity RPC is NOT a side effect: verifying the binding must happen before
// anything else, including the CSRF check, because a request against the wrong database must fail
// as binding_invalid rather than be judged on its origin. So it is excluded from the
// "touched nothing" assertions below, which are about application reads and writes.
const isBindingProbe = c => c.includes('get_deployment_identity');

// membership:'live' | 'removed' — the removed case is how P0-1 revocation is proven.
function spyFetch({ membership = 'live', sessionRow = null } = {}) {
  const calls = [], writes = [];
  const f = async (url, opts = {}) => {
    const u = String(url), method = opts.method || 'GET';
    calls.push(`${method} ${u.replace(/^https?:\/\/[^/]+/, '')}`);
    if (method !== 'GET') writes.push(`${method} ${u.split('/rest/v1/')[1] || u}`);
    const J = rows => ({ ok: true, status: 200, text: async () => JSON.stringify(rows), json: async () => rows });

    if (u.includes('/rpc/get_deployment_identity')) {
      return J([{ environment: 'staging', project_ref: REF }]);
    }
    // FC-02: impersonation is minted by support_session_create() (0072). The stubbed retailer has
    // no consent, so the function refuses exactly as PostgREST would relay it: a 400 carrying the
    // P0001 message. The route maps that to the opaque 403 asserted in section 4.
    if (u.includes('/rpc/support_session_create')) {
      const body = { code: 'P0001', message: 'support_access_disabled', details: null, hint: null };
      return { ok: false, status: 400, text: async () => JSON.stringify(body), json: async () => body };
    }
    if (u.includes('/rest/v1/admin_sessions')) {
      if (method !== 'GET') return J([{ session_id: SID }]);
      const wantOwner = u.includes(OWNER_SID);
      const row = sessionRow !== null ? sessionRow
        : wantOwner
          ? { session_id: OWNER_SID, email: 'david@demohubhq.com', retailer_id: null, expires_at: FUTURE }
          : { session_id: SID, email: 'staff@example.test', retailer_id: RID, expires_at: FUTURE };
      return J(row ? [row] : []);
    }
    if (u.includes('/rest/v1/retailer_admins')) {
      return J(membership === 'live' ? [{ id: 'm1', role: 'admin', venue_ids: null }] : []);
    }
    if (u.includes('/rest/v1/retailers')) return J([{ id: RID, name: 'Gus', slug: 'gus' }]);
    if (u.includes('/rest/v1/rate_limit')) return J([]);
    if (u.includes('api.resend.com')) return { ok: true, status: 200, json: async () => ({}) };
    return J([]);
  };
  f.calls = calls; f.writes = writes;
  return f;
}

const realEnv = process.env, realFetch = globalThis.fetch;

async function callAdminAuth({ headers = {}, body = {}, spyOpts = {} } = {}) {
  process.env = { ...ENV }; _resetBindingCache();
  const f = spyFetch(spyOpts); globalThis.fetch = f;
  const mod = await import(pathToFileURL(resolve('api', 'admin-auth.js')).href + '?t=' + Math.random());
  const res = mockRes();
  await mod.default({ method: 'POST', headers, body, query: {} }, res);
  return { res, f };
}

const jar = o => ({ cookie: Object.entries(o).map(([k, v]) => `${k}=${v}`).join('; ') });
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' };

// ---- 1. same-origin success ----
{
  const { res } = await callAdminAuth({
    headers: { ...SAME_ORIGIN, ...jar({ [COOKIE.retailer]: SID }) },
    body: { action: 'data', retailer_slug: 'gus' },
  });
  ok('route: same-origin request with a valid cookie succeeds', res.statusCode === 200,
     `— got ${res.statusCode} ${JSON.stringify(res.body)}`);
  // The response must carry identity, never the credential.
  ok('route: success response contains NO session secret',
     !/session_id|session_token/.test(JSON.stringify(res.body || {})), JSON.stringify(res.body));
}

// ---- 2. cross-origin denial, with ZERO side effects ----
{
  const { res, f } = await callAdminAuth({
    headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.test', ...jar({ [COOKIE.retailer]: SID }) },
    body: { action: 'data', retailer_slug: 'gus' },
  });
  ok('route: cross-origin POST is denied 403', res.statusCode === 403, `— got ${res.statusCode}`);
  ok('route: denial is generic (no reason leaked to the caller)',
     res.body && res.body.error === 'cross_origin_denied', JSON.stringify(res.body));
  // The guard has to run BEFORE the session is read, or a denied request still costs a DB lookup
  // and still reveals timing. Zero reads is the assertion, not just zero writes.
  const appCalls = f.calls.filter(c => c.includes('/rest/v1/') && !isBindingProbe(c));
  ok('route: denied request performs NO application database read',
     appCalls.length === 0, JSON.stringify(f.calls));
  ok('route: denied request performs no write',
     f.writes.filter(w => !isBindingProbe(w)).length === 0, JSON.stringify(f.writes));
}

// ---- 3. same-site sibling denial ----
{
  const { res, f } = await callAdminAuth({
    headers: { 'sec-fetch-site': 'same-site', origin: 'https://preview.example.test', ...jar({ [COOKIE.retailer]: SID }) },
    body: { action: 'data', retailer_slug: 'gus' },
  });
  ok('route: same-site SIBLING origin is denied 403', res.statusCode === 403, `— got ${res.statusCode}`);
  ok('route: sibling denial touches nothing',
     f.calls.filter(c => c.includes('/rest/v1/') && !isBindingProbe(c)).length === 0,
     JSON.stringify(f.calls));
}

// ---- 4. cookie-role separation ----
{
  // An owner action presented with a RETAILER cookie must not authenticate. Under the old single
  // dh_session design this was not expressible: there was one cookie, and impersonation had just
  // overwritten it with a retailer-scoped session.
  const { res } = await callAdminAuth({
    headers: { ...SAME_ORIGIN, ...jar({ [COOKIE.retailer]: SID }) },
    body: { action: 'owner-data' },
  });
  ok('route: owner action with only a retailer cookie is NOT authenticated',
     res.statusCode === 401, `— got ${res.statusCode} ${JSON.stringify(res.body)}`);

  // And the reverse: a retailer action must not accept the owner cookie as a retailer session.
  const r2 = await callAdminAuth({
    headers: { ...SAME_ORIGIN, ...jar({ [COOKIE.owner]: OWNER_SID }) },
    body: { action: 'data', retailer_slug: 'gus' },
  });
  ok('route: retailer action with only an owner cookie is NOT authenticated',
     r2.res.statusCode === 401, `— got ${r2.res.statusCode} ${JSON.stringify(r2.res.body)}`);

  // Impersonation must leave the owner's own session intact. It writes the retailer cookie only,
  // so exactly one Set-Cookie may name a session role, and it must not be the owner's.
  const imp = await callAdminAuth({
    headers: { ...SAME_ORIGIN, ...jar({ [COOKIE.owner]: OWNER_SID }) },
    body: { action: 'owner-impersonate', retailer_id: RID },
  });
  const impCookies = setCookies(imp.res);
  ok('route: impersonation does not overwrite or clear the owner cookie',
     !impCookies.some(c => c.startsWith(COOKIE.owner + '=')), JSON.stringify(impCookies));
  if (imp.res.statusCode === 200) {
    ok('route: impersonation sets the retailer cookie',
       impCookies.some(c => c.startsWith(COOKIE.retailer + '=')), JSON.stringify(impCookies));
  } else {
    // Codex F-06: the stubbed retailer row carries no allow_support_access consent, so a VALID
    // owner session is now refused fail-closed with the opaque 403 support_access_disabled.
    // (401/404 remain the refusals for a missing owner session / unknown retailer.) The negative
    // assertion above is the one that matters for cookie separation and it holds either way.
    ok('route: impersonation is refused (no consent, no owner session, or no retailer)',
       (imp.res.statusCode === 403 && imp.res.body && imp.res.body.error === 'support_access_disabled')
         || imp.res.statusCode === 401 || imp.res.statusCode === 404,
       `— got ${imp.res.statusCode} ${JSON.stringify(imp.res.body)}`);
    ok('route: a refused impersonation sets NO retailer cookie',
       !impCookies.some(c => c.startsWith(COOKIE.retailer + '=')), JSON.stringify(impCookies));
  }
}

// ---- 5. logout invalidation ----
{
  const { res, f } = await callAdminAuth({
    headers: { ...SAME_ORIGIN, ...jar({ [COOKIE.retailer]: SID }) },
    body: { action: 'logout' },
  });
  ok('route: logout succeeds', res.statusCode === 200, `— got ${res.statusCode}`);
  const c = setCookies(res);
  ok('route: logout expires ALL THREE role cookies', c.length === 3 && c.every(x => /Max-Age=0/.test(x)),
     JSON.stringify(c));
  ok('route: logout expires the owner cookie too (an impersonating owner must not survive it)',
     c.some(x => x.startsWith(COOKIE.owner + '=') && /Max-Age=0/.test(x)));
  ok('route: logout deletes the session row server-side, not just the cookie',
     f.writes.some(w => /^DELETE admin_sessions/.test(w)), JSON.stringify(f.writes));
}

// ---- 6. removed-staff denial ----
{
  const { res } = await callAdminAuth({
    headers: { ...SAME_ORIGIN, ...jar({ [COOKIE.retailer]: SID }) },
    body: { action: 'data', retailer_slug: 'gus' },
    spyOpts: { membership: 'removed' },
  });
  ok('route: a valid cookie whose membership was revoked is denied',
     res.statusCode === 403, `— got ${res.statusCode} ${JSON.stringify(res.body)}`);
}

// ---- 6b. no cookie at all ----
{
  const { res } = await callAdminAuth({ headers: SAME_ORIGIN, body: { action: 'data', retailer_slug: 'gus' } });
  ok('route: no cookie is 401, and the 400 "session_id required" path is gone',
     res.statusCode === 401, `— got ${res.statusCode} ${JSON.stringify(res.body)}`);
}

// ---- 6c. a body/query credential must buy nothing ----
{
  const { res } = await callAdminAuth({
    headers: SAME_ORIGIN,
    body: { action: 'data', retailer_slug: 'gus', session_id: SID, session_token: SID },
  });
  ok('route: a session in the request body is ignored (401, not 200)',
     res.statusCode === 401, `— got ${res.statusCode} ${JSON.stringify(res.body)}`);
}

// ---- 6d. the retired cookie-migrate action is gone ----
{
  const { res, f } = await callAdminAuth({
    headers: SAME_ORIGIN, body: { action: 'cookie-migrate', session_id: SID },
  });
  ok('route: cookie-migrate no longer exists',
     res.statusCode >= 400 && !setCookies(res).length,
     `— got ${res.statusCode}, cookies ${JSON.stringify(setCookies(res))}`);
  ok('route: cookie-migrate issues no cookie and writes nothing',
     f.writes.filter(w => !isBindingProbe(w)).length === 0, JSON.stringify(f.writes));
}

process.env = realEnv; globalThis.fetch = realFetch; TARGETS.preview.projectRef = savedRef;

// ===========================================================================
// PART 4 — static leak scans
// ===========================================================================
const apiFiles = readdirSync('api').filter(f => f.endsWith('.js') && !f.endsWith('.test.js'));
const readApi = f => readFileSync(resolve('api', f), 'utf8');

// Strip comments so an explanatory note about a removed defect is not mistaken for the defect.
// Masks the scheme first: a naive //-stripper eats every line containing "https://" — the exact
// bug that made tools/check-binding.mjs blind earlier in this project.
function stripComments(src) {
  // Codex finding 1: on a Windows CRLF checkout this stripper left every `//` comment intact.
  // It split on '\n', so each line still ended with '\r', and `/\/\/.*$/` does not match past
  // a '\r' in non-multiline mode — the comment survived and the static scans then reported the
  // COMMENTS DESCRIBING removed defects as if they were the defects. Two false failures.
  // Normalising newlines first makes the rest of the function line-ending agnostic.
  const unix = src.replace(/\r\n?/g, '\n');
  const masked = unix.replace(/https?:\/\//g, 'SCHEME_');
  return masked
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
}

// --- 4a. no route may accept a session from a body or query string ---
{
  const bad = [];
  for (const f of apiFiles) {
    const src = stripComments(readApi(f));
    for (const re of [/body\s*\.\s*session_id/, /body\s*\.\s*session_token/,
                      /query\s*\.\s*session_id/, /query\s*\.\s*session_token/,
                      /body\s*&&\s*body\s*\.\s*session/]) {
      if (re.test(src)) bad.push(`${f}: ${re}`);
    }
  }
  ok('static: no api/ file reads a session from a body or query string', bad.length === 0, JSON.stringify(bad));
}

// --- 4b. the retired cookie name is gone ---
{
  const bad = apiFiles.filter(f => /['"`]dh_session['"`]|dh_session=/.test(stripComments(readApi(f))));
  ok('static: the retired dh_session cookie name appears in no live code', bad.length === 0, JSON.stringify(bad));
}

// --- 4c. no hand-rolled Set-Cookie for a session outside api/_cookies.js ---
// Four files each kept their own copy of the attribute string, plus two inline regexes. One
// implementation is the point; six is six chances for one to drift.
{
  const bad = [];
  for (const f of apiFiles) {
    if (f === '_cookies.js') continue;
    const src = stripComments(readApi(f));
    if (/Set-Cookie/i.test(src) && /(dh_[a-z_]*session)\s*=\s*\$\{|HttpOnly;\s*Secure/.test(src)) {
      // The dh_support marker cookie is deliberately non-HttpOnly and carries no secret.
      if (!/dh_support/.test(src)) bad.push(f);
    }
  }
  ok('static: session cookies are built only in api/_cookies.js', bad.length === 0, JSON.stringify(bad));
}

// --- 4d. no session secret in any JSON response ---
{
  const bad = [];
  for (const f of apiFiles) {
    for (const line of stripComments(readApi(f)).split('\n')) {
      // Match a session key being placed into an object literal that is being returned/sent.
      if (!/session_id\s*:|session_token\s*:/.test(line)) continue;
      if (!/\.json\(|jsonResp\(|res\.send\(|return\s+res\./.test(line)) continue;
      // A Stripe Checkout Session id is a different object that legitimately goes to the client.
      if (/checkout\.id|session\.url|stripe_session_id|checkout_session/.test(line)) continue;
      bad.push(`${f}: ${line.trim().slice(0, 100)}`);
    }
  }
  ok('static: no handler returns a session secret in a response body', bad.length === 0, JSON.stringify(bad, null, 1));
}

// Routes that are NOT cookie-authenticated. Each entry names the mechanism that authenticates it
// instead, because "it is exempt" is not a reason — the mechanism is. Used by 4e and 4f.
const EXEMPT = new Map([
  ['stripe-webhook.js', 'authenticated by Stripe signature; carries no cookie'],
  ['fulfill-booking.js', 'authenticated by CRON_SECRET'],
  ['coi-enforcement.js', 'authenticated by CRON_SECRET'],
  ['refund-worker.js', 'authenticated by CRON_SECRET'],
  ['provisional-sweep.js', 'authenticated by CRON_SECRET'],
  ['seed-demo.js', 'authenticated by SEED_SECRET'],
  ['cal.js', 'public ICS feed authenticated by an opaque per-brand calendar token'],
  ['version.js', 'diagnostic, no session'],
  ['apply-migrations.js', 'retired 410 stub'],
  ['checkout-session.js', 'retired 410 stub'],
  ['find-retailer.js', 'unauthenticated public lookup'],
  ['signup.js', 'unauthenticated public signup'],
]);

// --- 4e. every cookie-authenticated route wires the CSRF guard ---
{
  const missing = [];
  for (const f of apiFiles) {
    if (f.startsWith('_')) continue;              // helper modules are not entry points
    const src = readApi(f);
    if (!/export default/.test(src)) continue;
    if (EXEMPT.has(f)) continue;
    if (!/requireSameOrigin\s*\(/.test(src)) missing.push(f);
  }
  ok('static: every non-exempt route with a handler wires requireSameOrigin', missing.length === 0,
     JSON.stringify(missing));

  // The exemption list itself must stay honest: an exempt route must not be quietly
  // cookie-authenticated. If one starts reading a session cookie, it is no longer exempt.
  const wrong = [];
  for (const [f, why] of EXEMPT) {
    if (!apiFiles.includes(f)) continue;
    const src = stripComments(readApi(f));
    if (/getSessionToken\s*\(/.test(src)) wrong.push(`${f} (claimed: ${why})`);
  }
  ok('static: no CSRF-exempt route reads a session cookie', wrong.length === 0, JSON.stringify(wrong));
}

// --- 4f. a mutating route must reject safe methods ---
// requireSameOrigin exempts GET/HEAD/OPTIONS by design, so a mutation reachable by GET is
// reachable cross-site with the Lax cookie attached. Any route that writes must therefore gate on
// method somewhere. This was a real hole in api/brand-account.js (logout, cal_token, cal_revoke).
{
  const bad = [];
  for (const f of apiFiles) {
    if (f.startsWith('_')) continue;
    const src = readApi(f);
    if (!/export default/.test(src)) continue;
    // A route authenticated by a secret in a request HEADER cannot be driven cross-site at all:
    // page script cannot set Authorization on a cross-origin request, so there is nothing for a
    // method gate to add. Those are listed in EXEMPT above with their mechanism.
    if (EXEMPT.has(f)) continue;
    const mutates = /method:\s*['"](POST|PATCH|PUT|DELETE)['"]/.test(src);
    if (!mutates) continue;
    const gated = /req\.method\s*!==?\s*['"]POST['"]/.test(src)
      || /\[\s*['"]POST['"][^\]]*\]\s*\.includes\(\s*req\.method/.test(src)
      || /req\.method\s*===?\s*['"]POST['"]\s*&&/.test(src)
      || /MUTATING_ACTIONS/.test(src)
      // A GET-only route that reaches Supabase with method:'POST' is issuing a READ expressed as
      // a POST (a storage sign-url call, or an RPC). api/coi-file.js is the case: it returns 405
      // for anything but GET, so it has no mutating surface for CSRF to protect.
      || /req\.method\s*!==?\s*['"]GET['"]/.test(src);
    if (!gated) bad.push(f);
  }
  ok('static: every route that writes gates on HTTP method', bad.length === 0, JSON.stringify(bad));
}

// --- 4g. no page stores a session in the browser ---
{
  const html = [];
  const walk = d => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.html')) html.push(norm(p));
    }
  };
  walk('.');
  ok('static: HTML pages were found to scan', html.length > 0, `${html.length}`);

  const bad = [];
  for (const p of html) {
    const src = stripComments(readFileSync(p, 'utf8'));
    // localStorage/sessionStorage touching anything session- or token-shaped.
    const re = /(local|session)Storage\s*\.\s*(get|set|remove)Item\s*\(\s*[^)]*?(session|token|sid|auth)/gi;
    let m; while ((m = re.exec(src))) {
      // Deliberately-kept UI state whose key merely contains a matched word.
      if (/demohub_admin_demo_filters|tour_seen|tour_complete|signin_last/i.test(m[0])) continue;
      bad.push(`${p}: ${m[0].slice(0, 80)}`);
    }
    if (/cookie-migrate/.test(src)) bad.push(`${p}: still calls cookie-migrate`);
    if (/session_id\s*:|session_token\s*:/.test(src)) bad.push(`${p}: sends a session in a request`);
    if (/[?&]session_id=|[?&]session_token=/.test(src)) bad.push(`${p}: session in a query string`);
  }
  ok('static: no page reads, writes or sends a session secret', bad.length === 0, JSON.stringify(bad, null, 1));
}

// --- 4h. every page that reads a token from the URL strips it from history ---
{
  const bad = [];
  const walk = d => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.html')) {
        const src = readFileSync(p, 'utf8');
        const readsToken = /(searchParams|params)\s*\.\s*get\s*\(\s*['"](token|t|code|sid|session)['"]\s*\)/.test(src);
        if (readsToken && !/history\.replaceState/.test(src)) bad.push(norm(p));
      }
    }
  };
  walk('.');
  ok('static: every page reading a credential from the URL strips it from history',
     bad.length === 0, JSON.stringify(bad));
}

// --- 4i. the unwired predecessor must be gone ---
// api/_session.js exported checkOrigin() and nothing called it. Leaving a second, unused CSRF
// helper in the tree invites a future caller to reach for the one that protects nothing.
{
  const sess = readFileSync(resolve('api', '_session.js'), 'utf8');
  const declared = /export\s+function\s+checkOrigin/.test(sess);
  const callers = apiFiles.filter(f => f !== '_session.js' && /\bcheckOrigin\s*\(/.test(stripComments(readApi(f))));
  ok('static: the unwired checkOrigin() helper is removed (or has real callers)',
     !declared || callers.length > 0,
     declared ? 'still declared in api/_session.js with zero callers' : '');
}

// ===========================================================================
console.log(`\nsession transport: ${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILURES:'); for (const f of fails) console.log('  ✗ ' + f); process.exit(1); }
