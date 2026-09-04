// tests/support_access.test.mjs — Codex F-06 + FC-02: the retailer "support access" toggle is
// ENFORCED, ATOMIC, and REVOKING.
//
// The retailer Settings UI says "OFF. Demohub cannot sign in to your account." Before F-06,
// owner-impersonate ignored allow_support_access / support_access_expires_at, minted the
// impersonation session anyway, and treated the support_sessions audit insert as best-effort.
// F-06 added the gate in JS, as three PostgREST requests with a compensating delete. FC-02 moves
// consent check + session + audit into ONE database transaction (support_session_create, 0072) and
// makes OFF end the sessions it previously authorised (support_access_set, 0072).
//
// Every route assertion here goes through the real exported handler with a canonical request (real
// cookies minted through the real verify routes, real CSRF evidence, valid binding) against the
// staging database. Section 0 and 6b call the 0072 functions directly over REST rpc/ to pin the
// database-layer contract the route relies on.
import { readFileSync } from 'node:fs';
import { installSpy, callRoute, req, ok, summary, uniq } from './_route.mjs';
import { cookieMaxAgeUntil } from '../api/admin-auth.js';

const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  return { ok: r.ok, status: r.status, body: j };
};
const rpc = (fn, args) => db(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });
// Teardown list of exact PostgREST filter paths (admin_sessions keys on session_id, not id).
const bin = [];
const track = (path) => { bin.push(path); return path; };
const OWNER_EMAIL = 'david@demohubhq.com';
const hrs = (n) => new Date(Date.now() + n * 3600 * 1000).toISOString();
const within = (iso, targetMs, tolMs) => Math.abs(Date.parse(iso) - targetMs) <= tolMs;
const TOL = 90 * 1000; // network + clock slack

const spy = installSpy();

// Every route response body is collected so the final section can prove that no session secret
// (owner cookie, retailer cookie, impersonation session id) ever appears in a body.
const responseBodies = [];
const secrets = new Set();
const noteSecret = (s) => { if (s) secrets.add(String(s)); };
const call = async (file, request) => {
  const res = await callRoute(file, request);
  responseBodies.push(typeof res.body === 'string' ? res.body : JSON.stringify(res.body || {}));
  return res;
};

// ---------------------------------------------------------------------------
// SETUP: the system owner retailer, a target retailer, and an OWNER SESSION minted the way the
// product mints it — an admin_tokens row (the magic link) redeemed through owner-verify on the
// real route, yielding the dh_owner_session cookie.
// ---------------------------------------------------------------------------
let ownerRetailerId, retailerId, ownerCookie;
{
  const ex = await db('retailers?slug=eq.__owner__&select=id');
  ownerRetailerId = (ex.body && ex.body[0] && ex.body[0].id) ||
    (await db('retailers', { method: 'POST', body: JSON.stringify({
      slug: '__owner__', name: 'Demohub Owner (system)', billing_email: OWNER_EMAIL }) })).body[0].id;

  const slug = uniq('sa');
  const created = await db('retailers', { method: 'POST', body: JSON.stringify({
    slug, name: 'Support Access Fixture', billing_email: `${slug}@fixture.test`,
    billing_tier: 'pro', billing_status: 'active', allow_support_access: false, support_access_expires_at: null }) });
  retailerId = created.body[0].id;
  track(`retailers?id=eq.${retailerId}`);

  const tok = (await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: OWNER_EMAIL, retailer_id: ownerRetailerId }) })).body[0];
  track(`admin_tokens?token=eq.${tok.token}`);
  const verified = await call('admin-auth.js', req({ body: { action: 'owner-verify', token: tok.token } }));
  ownerCookie = verified.cookie('dh_owner_session');
  noteSecret(ownerCookie);
  ok('setup: owner-verify through the route yields dh_owner_session', verified.statusCode === 200 && !!ownerCookie, `${verified.statusCode} ${JSON.stringify(verified.body)}`);
  if (ownerCookie) track(`admin_sessions?session_id=eq.${ownerCookie}`);
}

// Retailer-side staff for the fixture retailer (FC-02, section 9): the billing contact as owner (so
// an impersonated session — which carries billing_email — is a real member for api/admin.js), an
// admin who may flip consent, and a viewer who may not. Cookies are minted through the real verify
// route, the way isolation_matrix.test.mjs does it.
const BILLING_EMAIL = `${(await db(`retailers?id=eq.${retailerId}&select=slug`)).body[0].slug}@fixture.test`;
const ADMIN_EMAIL = `admin-${uniq('sa')}@fixture.test`, VIEWER_EMAIL = `viewer-${uniq('sa')}@fixture.test`;
const mkMember = async (email, role) => {
  const row = (await db('retailer_admins', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, email, email_normalized: email, name: role + ' fixture', role }) })).body[0];
  track(`retailer_admins?id=eq.${row.id}`);
};
const mintRetailerCookie = async (email) => {
  const tok = (await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email, retailer_id: retailerId }) })).body[0];
  track(`admin_tokens?token=eq.${tok.token}`);
  const v = await call('admin-auth.js', req({ body: { action: 'verify', token: tok.token } }));
  const c = v.cookie('dh_retailer_session');
  noteSecret(c);
  if (c) track(`admin_sessions?session_id=eq.${c}`);
  return c;
};
await mkMember(BILLING_EMAIL, 'owner');
await mkMember(ADMIN_EMAIL, 'admin');
await mkMember(VIEWER_EMAIL, 'viewer');
const adminCookie = await mintRetailerCookie(ADMIN_EMAIL);
const viewerCookie = await mintRetailerCookie(VIEWER_EMAIL);
ok('setup: admin and viewer cookies minted through the route', !!adminCookie && !!viewerCookie);

const impersonate = (rid = retailerId, extra = {}) => call('admin-auth.js', req({
  body: { action: 'owner-impersonate', retailer_id: rid },
  cookies: { dh_owner_session: ownerCookie },
  headers: { 'user-agent': 'support-access-test' },
  ...extra,
}));
const retailerAction = (cookie, body) => call('admin-auth.js', req({ body, cookies: cookie ? { dh_retailer_session: cookie } : {} }));
const setConsent = (patch) => db(`retailers?id=eq.${retailerId}`, { method: 'PATCH', body: JSON.stringify(patch) });
const readConsent = async () => (await db(`retailers?id=eq.${retailerId}&select=allow_support_access,support_access_expires_at`)).body[0];
// The fixture's OWN sessions only — staff cookies minted above are excluded, so "zero rows" means
// zero impersonation sessions.
const staffSessions = () => [adminCookie, viewerCookie].filter(Boolean);
const sessionsFor = async () => ((await db(`admin_sessions?retailer_id=eq.${retailerId}&select=session_id,expires_at,email`)).body || []).filter(s => !staffSessions().includes(s.session_id));
const auditsFor = async () => (await db(`support_sessions?target_retailer_id=eq.${retailerId}&select=id,target_session_id,owner_email,ended_at,user_agent,started_at,writes_count`)).body || [];
const denied = (res, label) => {
  ok(`${label}: 403`, res.statusCode === 403, `${res.statusCode} ${JSON.stringify(res.body)}`);
  ok(`${label}: opaque body support_access_disabled`, res.body && res.body.error === 'support_access_disabled', JSON.stringify(res.body));
  ok(`${label}: NO retailer cookie`, res.cookie('dh_retailer_session') === null, JSON.stringify(res.cookies()));
  ok(`${label}: NO dh_support marker cookie`, res.cookie('dh_support') === null, JSON.stringify(res.cookies()));
};

// ---------------------------------------------------------------------------
// 0. The rule itself, pinned at the DATABASE layer (FC-02). The consent rule used to be a pure JS
//    helper (supportAccessExpiryMs / impersonationWindow) unit-tested here; those helpers are gone
//    because the rule now lives in support_session_create() (0072), so it is pinned by calling the
//    function directly over rpc/ — bypassing the route — for every refusal shape. The ONLY JS left
//    is the cookie Max-Age derivation from the RPC's expires_at, unit-tested below.
// ---------------------------------------------------------------------------
console.log('\n— 0: the consent rule (database function, called directly) —');
{
  const createArgs = { p_retailer_id: retailerId, p_owner_email: OWNER_EMAIL, p_session_email: BILLING_EMAIL, p_ip_address: null, p_user_agent: 'rpc-direct' };
  const refused = (r, label) => {
    ok(`rpc/${label}: refused (4xx)`, !r.ok && r.status >= 400 && r.status < 500, `${r.status} ${JSON.stringify(r.body)}`);
    ok(`rpc/${label}: message is exactly support_access_disabled (P0001)`, r.body && r.body.message === 'support_access_disabled' && r.body.code === 'P0001', JSON.stringify(r.body));
  };
  await setConsent({ allow_support_access: false, support_access_expires_at: hrs(2) });
  refused(await rpc('support_session_create', createArgs), 'OFF with a future expiry');
  await setConsent({ allow_support_access: true, support_access_expires_at: null });
  refused(await rpc('support_session_create', createArgs), 'ON but expires_at null');
  await setConsent({ allow_support_access: true, support_access_expires_at: hrs(-0.01) });
  refused(await rpc('support_session_create', createArgs), 'ON but expires_at in the past');
  refused(await rpc('support_session_create', { ...createArgs, p_retailer_id: '00000000-0000-4000-8000-00000000dead' }), 'unknown retailer (same opaque message)');
  ok('rpc: no admin_sessions row from any refusal', (await sessionsFor()).length === 0);
  ok('rpc: no support_sessions row from any refusal', (await auditsFor()).length === 0);

  // (The service_role-only grant is asserted by the migration's post-condition and, from the
  // catalog, by tests/support_access_race.test.mjs — the anon key is not in this environment.)
  const priv = await rpc('support_session_create', { ...createArgs, p_retailer_id: 'not-a-uuid' });
  ok('rpc: a malformed retailer id is a type error, never a session', !priv.ok && (await sessionsFor()).length === 0, `${priv.status}`);

  const now = Date.UTC(2026, 8, 3, 12, 0, 0);
  ok('cookieMaxAgeUntil: 2h ahead -> 7200s', cookieMaxAgeUntil(new Date(now + 7200e3).toISOString(), now) === 7200);
  ok('cookieMaxAgeUntil: 4h ahead -> 14400s', cookieMaxAgeUntil(new Date(now + 14400e3).toISOString(), now) === 14400);
  ok('cookieMaxAgeUntil: already past -> clamps to 1s, never 0 or negative', cookieMaxAgeUntil(new Date(now - 5000).toISOString(), now) === 1);
  ok('cookieMaxAgeUntil: garbage -> null (route answers 500, sets no cookie)', cookieMaxAgeUntil('soon', now) === null && cookieMaxAgeUntil(null, now) === null);
}

// ---------------------------------------------------------------------------
// 1. Toggle OFF: refused, and nothing is created.
// ---------------------------------------------------------------------------
console.log('\n— 1: toggle OFF —');
{
  await setConsent({ allow_support_access: false, support_access_expires_at: null });
  const res = await impersonate();
  denied(res, 'OFF');
  ok('OFF: no admin_sessions row created', (await sessionsFor()).length === 0);
  ok('OFF: no support_sessions row created', (await auditsFor()).length === 0);
}

// ---------------------------------------------------------------------------
// 2. Toggle ON but the consent window has lapsed.
// ---------------------------------------------------------------------------
console.log('\n— 2: expires_at in the past —');
{
  await setConsent({ allow_support_access: true, support_access_expires_at: hrs(-1) });
  const res = await impersonate();
  denied(res, 'expired');
  ok('expired: no admin_sessions row created', (await sessionsFor()).length === 0);
}

// ---------------------------------------------------------------------------
// 3. Toggle ON but no expiry recorded at all.
// ---------------------------------------------------------------------------
console.log('\n— 3: allow=true, expires_at null —');
{
  await setConsent({ allow_support_access: true, support_access_expires_at: null });
  const res = await impersonate();
  denied(res, 'null expiry');
  ok('null expiry: no admin_sessions row created', (await sessionsFor()).length === 0);
}

// ---------------------------------------------------------------------------
// 4. Valid ON, consent 2h ahead: session capped to the CONSENT window, audited.
// ---------------------------------------------------------------------------
console.log('\n— 4: ON, consent expires in 2h —');
let firstSession = null;
{
  const consent = hrs(2);
  await setConsent({ allow_support_access: true, support_access_expires_at: consent });
  const before = Date.now();
  const res = await impersonate();
  ok('ON/2h: 200', res.statusCode === 200, `${res.statusCode} ${JSON.stringify(res.body)}`);
  firstSession = res.cookie('dh_retailer_session');
  noteSecret(firstSession);
  ok('ON/2h: dh_retailer_session cookie set', !!firstSession);
  ok('ON/2h: dh_support marker cookie set', !!res.cookie('dh_support'));
  ok('ON/2h: session secret NOT in the body', !JSON.stringify(res.body || {}).includes(String(firstSession)));
  const rows = await sessionsFor();
  ok('ON/2h: exactly one admin_sessions row', rows.length === 1, JSON.stringify(rows));
  const row = rows[0];
  ok('ON/2h: admin_sessions.expires_at ≈ consent expiry (2h), not the 4h cap',
     row && within(row.expires_at, Date.parse(consent), TOL), `${row && row.expires_at} vs ${consent}`);
  const rc = res.cookies().find(c => c.startsWith('dh_retailer_session=')) || '';
  const ma = Number((rc.match(/Max-Age=(\d+)/) || [])[1]);
  ok('ON/2h: cookie Max-Age ≈ 2h (7200s)', Math.abs(ma - 7200) <= 90, rc);
  const mc = res.cookies().find(c => c.startsWith('dh_support=')) || '';
  const mma = Number((mc.match(/Max-Age=(\d+)/) || [])[1]);
  ok('ON/2h: marker cookie Max-Age matches the session, not a hard-coded 14400', Math.abs(mma - 7200) <= 90, mc);
  ok('ON/2h: cookie Max-Age never exceeds DB expiry', row && (before + ma * 1000) <= Date.parse(row.expires_at) + TOL);
  const audits = await auditsFor();
  ok('ON/2h: support_sessions row exists with target_retailer_id', audits.length === 1, JSON.stringify(audits));
  ok('ON/2h: audit row points at the minted session', audits[0] && audits[0].target_session_id === firstSession);
  ok('ON/2h: audit row carries owner_email + user agent', audits[0] && audits[0].owner_email === OWNER_EMAIL && audits[0].user_agent === 'support-access-test');
}

// ---------------------------------------------------------------------------
// 5. Consent 10h ahead: the 4h cap wins.
// ---------------------------------------------------------------------------
console.log('\n— 5: ON, consent expires in 10h —');
{
  await setConsent({ allow_support_access: true, support_access_expires_at: hrs(10) });
  const before = Date.now();
  const res = await impersonate();
  ok('ON/10h: 200', res.statusCode === 200, `${res.statusCode} ${JSON.stringify(res.body)}`);
  const sid = res.cookie('dh_retailer_session');
  noteSecret(sid);
  const row = (await sessionsFor()).find(x => x.session_id === sid);
  ok('ON/10h: admin_sessions.expires_at ≈ now + 4h', row && within(row.expires_at, before + 4 * 3600e3, TOL), `${row && row.expires_at}`);
  const rc = res.cookies().find(c => c.startsWith('dh_retailer_session=')) || '';
  const ma = Number((rc.match(/Max-Age=(\d+)/) || [])[1]);
  ok('ON/10h: cookie Max-Age ≈ 4h (14400s)', Math.abs(ma - 14400) <= 90, rc);
  if (sid) track(`admin_sessions?session_id=eq.${sid}`);
}

// ---------------------------------------------------------------------------
// 6. Audit failure is FAIL-CLOSED, and now ATOMIC.
//    6a (route): the single RPC request fails (503 injected on rpc/support_session_create via the
//        harness spy). The route answers 500 audit_unavailable with NO cookie. SEMANTICS CHANGED
//        from F-06: the fault used to be injected on the support_sessions POST and the assertion was
//        that the compensating DELETE removed the admin_sessions row. There is no compensation any
//        more; the session set is unchanged because nothing was ever committed.
//    6b (database): atomicity proper. A fault on the network layer cannot reach INSIDE the function,
//        so the audit insert is made to fail for real: support_sessions.owner_email is NOT NULL, and
//        support_session_create() accepts a NULL p_owner_email as long as p_session_email is given
//        (admin_sessions.email is satisfied by the latter). The admin_sessions INSERT therefore
//        succeeds and the support_sessions INSERT raises 23502 — the exact "session minted, audit
//        failed" interleaving F-06 compensated for. The transaction must roll back both.
// ---------------------------------------------------------------------------
console.log('\n— 6a: the RPC request itself fails (route) —');
{
  await setConsent({ allow_support_access: true, support_access_expires_at: hrs(3) });
  const sessionsBefore = (await sessionsFor()).map(x => x.session_id).sort();
  const auditsBefore = (await auditsFor()).length;
  const fault = { url: 'rpc/support_session_create', method: 'POST', status: 503, message: 'injected_audit_outage' };
  spy.faults.push(fault);
  let res;
  try { res = await impersonate(); }
  finally { spy.faults.splice(spy.faults.indexOf(fault), 1); }
  ok('rpc down: 500', res.statusCode === 500, `${res.statusCode} ${JSON.stringify(res.body)}`);
  ok('rpc down: body is audit_unavailable', res.body && res.body.error === 'audit_unavailable', JSON.stringify(res.body));
  ok('rpc down: NO retailer cookie', res.cookie('dh_retailer_session') === null, JSON.stringify(res.cookies()));
  ok('rpc down: NO dh_support marker cookie', res.cookie('dh_support') === null, JSON.stringify(res.cookies()));
  const sessionsAfter = (await sessionsFor()).map(x => x.session_id).sort();
  ok('rpc down: admin_sessions set unchanged — nothing to compensate, nothing committed',
     JSON.stringify(sessionsAfter) === JSON.stringify(sessionsBefore), `${sessionsBefore.length} -> ${sessionsAfter.length}`);
  ok('rpc down: no support_sessions row appeared', (await auditsFor()).length === auditsBefore);
}

console.log('\n— 6b: audit INSERT fails inside the function (atomicity, rpc direct) —');
{
  await setConsent({ allow_support_access: true, support_access_expires_at: hrs(3) });
  const sessionsBefore = (await sessionsFor()).map(x => x.session_id).sort();
  const auditsBefore = (await auditsFor()).length;
  const r = await rpc('support_session_create', { p_retailer_id: retailerId, p_owner_email: null, p_session_email: BILLING_EMAIL, p_ip_address: null, p_user_agent: 'atomicity-probe' });
  ok('atomic: the function fails (consent was valid — the failure is the audit insert)', !r.ok, `${r.status} ${JSON.stringify(r.body)}`);
  ok('atomic: the failure is the NOT NULL on support_sessions.owner_email (23502)', r.body && r.body.code === '23502' && /owner_email/.test(String(r.body.message)), JSON.stringify(r.body));
  const sessionsAfter = (await sessionsFor()).map(x => x.session_id).sort();
  ok('atomic: ZERO admin_sessions rows created — rolled back with the audit insert, no compensation involved',
     JSON.stringify(sessionsAfter) === JSON.stringify(sessionsBefore), `${sessionsBefore.length} -> ${sessionsAfter.length}`);
  ok('atomic: no support_sessions row appeared', (await auditsFor()).length === auditsBefore);
  // And the same consent still mints normally right after — the failed call left no lock or state.
  const again = await impersonate();
  ok('atomic: a normal impersonation right after still succeeds', again.statusCode === 200, `${again.statusCode} ${JSON.stringify(again.body)}`);
  const sid = again.cookie('dh_retailer_session'); noteSecret(sid); if (sid) track(`admin_sessions?session_id=eq.${sid}`);
}

// ---------------------------------------------------------------------------
// 7. Target that does not exist: unchanged behaviour (404), no session.
// ---------------------------------------------------------------------------
console.log('\n— 7: unknown retailer target —');
{
  const ghost = '00000000-0000-4000-8000-00000000dead';
  const res = await impersonate(ghost);
  ok('ghost retailer: 404 (unchanged)', res.statusCode === 404, `${res.statusCode} ${JSON.stringify(res.body)}`);
  ok('ghost retailer: no cookie', res.cookie('dh_retailer_session') === null);
  ok('ghost retailer: no admin_sessions row for that id', ((await db(`admin_sessions?retailer_id=eq.${ghost}&select=session_id`)).body || []).length === 0);
  const noCookie = await call('admin-auth.js', req({ body: { action: 'owner-impersonate', retailer_id: retailerId } }));
  ok('no owner cookie: 401 before any consent check', noCookie.statusCode === 401, `${noCookie.statusCode}`);
  const asRetailer = await call('admin-auth.js', req({ body: { action: 'owner-impersonate', retailer_id: retailerId }, cookies: { dh_retailer_session: ownerCookie } }));
  ok('owner secret in the RETAILER cookie cannot impersonate', asRetailer.statusCode === 401, `${asRetailer.statusCode}`);
}

// ---------------------------------------------------------------------------
// 8. owner-end-impersonation still works for the valid session from step 4.
// ---------------------------------------------------------------------------
console.log('\n— 8: end impersonation —');
{
  const res = await call('admin-auth.js', req({
    body: { action: 'owner-end-impersonation' },
    cookies: { dh_owner_session: ownerCookie, dh_retailer_session: firstSession } }));
  ok('end: 200', res.statusCode === 200, `${res.statusCode} ${JSON.stringify(res.body)}`);
  const rc = res.cookies().find(c => c.startsWith('dh_retailer_session=')) || '';
  ok('end: retailer cookie cleared (Max-Age=0)', /Max-Age=0/.test(rc), rc);
  const mc = res.cookies().find(c => c.startsWith('dh_support=')) || '';
  ok('end: marker cookie cleared', /Max-Age=0/.test(mc), mc);
  ok('end: owner cookie left alone', !res.cookies().some(c => c.startsWith('dh_owner_session=')));
  ok('end: impersonation admin_sessions row deleted', !(await sessionsFor()).some(x => x.session_id === firstSession));
  const audit = (await auditsFor()).find(a => a.target_session_id === firstSession || a.target_session_id === null);
  ok('end: support_sessions row marked ended_at', !!(audit && audit.ended_at), JSON.stringify(audit));
  ok('end: summary mail went only to the sink (contained)', spy.calls.resend.every(m => String(m.to) === 'sink@fixture.test' || (Array.isArray(m.to) && m.to.every(t => t === 'sink@fixture.test'))), JSON.stringify(spy.calls.resend.map(m => m.to)));
  ok('end: no Stripe call anywhere in this file', spy.calls.stripe.length === 0);
}

// ---------------------------------------------------------------------------
// 9. FC-02: the retailer's toggle through the route — status passthrough, role gate, and OFF
//    revoking a live support session.
// ---------------------------------------------------------------------------
console.log('\n— 9: support-access-toggle (route) —');
{
  // Start from a known OFF state written by the previous sections' teardown-free flow.
  await setConsent({ allow_support_access: false, support_access_expires_at: null });

  // 9.1 no cookie -> 401 (unchanged)
  const anon = await retailerAction(null, { action: 'support-access-toggle', enabled: true });
  ok('toggle: no cookie -> 401', anon.statusCode === 401, `${anon.statusCode} ${JSON.stringify(anon.body)}`);

  // 9.2 viewer -> 403, consent untouched. (Previously every membership refusal was rewritten to
  //     401; a signed-in viewer was told to log in again.)
  const viewer = await retailerAction(viewerCookie, { action: 'support-access-toggle', enabled: true });
  ok('toggle: viewer -> 403 (not 401)', viewer.statusCode === 403, `${viewer.statusCode} ${JSON.stringify(viewer.body)}`);
  ok('toggle: viewer refusal names the role, not the session', viewer.body && viewer.body.error === 'read_only_role', JSON.stringify(viewer.body));
  const afterViewer = await readConsent();
  ok('toggle: viewer left consent OFF', afterViewer.allow_support_access === false && afterViewer.support_access_expires_at === null, JSON.stringify(afterViewer));
  const viewerStatus = await retailerAction(viewerCookie, { action: 'support-access-status' });
  ok('status: viewer may READ the state (200)', viewerStatus.statusCode === 200 && viewerStatus.body && viewerStatus.body.allow_support_access === false, `${viewerStatus.statusCode} ${JSON.stringify(viewerStatus.body)}`);

  // 9.3 membership lookup unavailable -> 503 passthrough (was 401)
  {
    const fault = { url: 'retailer_admins?', method: 'GET', status: 503, message: 'injected_membership_outage' };
    spy.faults.push(fault);
    let t, s;
    try {
      t = await retailerAction(adminCookie, { action: 'support-access-toggle', enabled: true });
      s = await retailerAction(adminCookie, { action: 'support-access-status' });
    } finally { spy.faults.splice(spy.faults.indexOf(fault), 1); }
    ok('toggle: membership backend down -> 503 passthrough', t.statusCode === 503 && t.body && t.body.error === 'membership_check_unavailable', `${t.statusCode} ${JSON.stringify(t.body)}`);
    ok('status: membership backend down -> 503 passthrough', s.statusCode === 503, `${s.statusCode} ${JSON.stringify(s.body)}`);
    const c = await readConsent();
    ok('toggle: a 503 changed nothing', c.allow_support_access === false && c.support_access_expires_at === null, JSON.stringify(c));
  }

  // 9.4 admin ON -> 24h window, state returned from the database
  const before = Date.now();
  const on = await retailerAction(adminCookie, { action: 'support-access-toggle', enabled: true });
  ok('toggle ON: 200', on.statusCode === 200, `${on.statusCode} ${JSON.stringify(on.body)}`);
  ok('toggle ON: body reports allow_support_access true', on.body && on.body.allow_support_access === true, JSON.stringify(on.body));
  ok('toggle ON: expires_at ≈ now + 24h', on.body && within(on.body.expires_at, before + 24 * 3600e3, TOL), JSON.stringify(on.body));
  const dbOn = await readConsent();
  ok('toggle ON: database row matches the response', dbOn.allow_support_access === true && dbOn.support_access_expires_at && Math.abs(Date.parse(dbOn.support_access_expires_at) - Date.parse(on.body.expires_at)) < 1000, JSON.stringify(dbOn));
  const st = await retailerAction(adminCookie, { action: 'support-access-status' });
  ok('status: reads ON with the same expiry', st.statusCode === 200 && st.body.allow_support_access === true && st.body.expires_at === dbOn.support_access_expires_at, JSON.stringify(st.body));

  // 9.5 a live support session under that consent
  const imp = await impersonate();
  ok('toggle flow: impersonation succeeds under fresh consent', imp.statusCode === 200, `${imp.statusCode} ${JSON.stringify(imp.body)}`);
  const live = imp.cookie('dh_retailer_session'); noteSecret(live);
  const ma = Number(((imp.cookies().find(c => c.startsWith('dh_retailer_session=')) || '').match(/Max-Age=(\d+)/) || [])[1]);
  ok('toggle flow: session cookie capped at 4h under a 24h consent', Math.abs(ma - 14400) <= 90, String(ma));
  const dataBefore = await call('admin.js', req({ method: 'GET', query: { action: 'data' }, cookies: { dh_retailer_session: live } }));
  ok('toggle flow: the support session can read admin data (200) while consent is ON', dataBefore.statusCode === 200, `${dataBefore.statusCode} ${String(dataBefore.body).slice(0, 120)}`);
  const openAudits = (await auditsFor()).filter(a => a.target_session_id === live);
  ok('toggle flow: the live session has an open audit row', openAudits.length === 1 && openAudits[0].ended_at === null, JSON.stringify(openAudits));

  // 9.6 admin OFF -> ends the audit row, deletes the session, cookie is dead
  const off = await retailerAction(adminCookie, { action: 'support-access-toggle', enabled: false });
  ok('toggle OFF: 200', off.statusCode === 200, `${off.statusCode} ${JSON.stringify(off.body)}`);
  ok('toggle OFF: body reports OFF with null expiry', off.body && off.body.allow_support_access === false && off.body.expires_at === null, JSON.stringify(off.body));
  ok('toggle OFF: reports the ended session count (>= 1)', off.body && off.body.ended_sessions >= 1, JSON.stringify(off.body));
  const dbOff = await readConsent();
  ok('toggle OFF: database row is OFF', dbOff.allow_support_access === false && dbOff.support_access_expires_at === null, JSON.stringify(dbOff));
  ok('toggle OFF: the admin_sessions row for the live support session is DELETED', !(await sessionsFor()).some(s => s.session_id === live));
  const endedAudit = (await auditsFor()).find(a => a.id === openAudits[0].id);
  ok('toggle OFF: the audit row has ended_at set', !!(endedAudit && endedAudit.ended_at), JSON.stringify(endedAudit));
  ok('toggle OFF: audit row keeps owner/started_at/writes_count after the pointer is nulled',
     endedAudit && endedAudit.owner_email === OWNER_EMAIL && !!endedAudit.started_at && endedAudit.writes_count === 0 && endedAudit.target_session_id === null, JSON.stringify(endedAudit));
  ok('toggle OFF: no open audit rows remain for the retailer', (await auditsFor()).every(a => a.ended_at !== null));
  const dataAfter = await call('admin.js', req({ method: 'GET', query: { action: 'data' }, cookies: { dh_retailer_session: live } }));
  ok('toggle OFF: the old dh_retailer_session cookie is refused (401) on the next protected request', dataAfter.statusCode === 401, `${dataAfter.statusCode}`);
  const authAfter = await retailerAction(live, { action: 'support-access-status' });
  ok('toggle OFF: the old cookie is refused by admin-auth too (401)', authAfter.statusCode === 401, `${authAfter.statusCode}`);
  const impAfter = await impersonate();
  denied(impAfter, 'impersonate after OFF');
  const adminStill = await retailerAction(adminCookie, { action: 'support-access-status' });
  ok('toggle OFF: the retailer admin\'s OWN session is untouched (200)', adminStill.statusCode === 200, `${adminStill.statusCode}`);

  // 9.7 the audit log the dashboard renders shows the ended session, without any session id
  const log = await retailerAction(adminCookie, { action: 'support-sessions' });
  ok('support-sessions: 200 with the ended session listed', log.statusCode === 200 && Array.isArray(log.body.sessions) && log.body.sessions.some(s => s.id === openAudits[0].id && s.ended_at), `${log.statusCode} ${JSON.stringify(log.body).slice(0, 200)}`);
  ok('support-sessions: rows carry no target_session_id', log.body.sessions.every(s => !('target_session_id' in s)));
  const logViewer = await retailerAction(viewerCookie, { action: 'support-sessions' });
  ok('support-sessions: a viewer may read the log (200)', logViewer.statusCode === 200, `${logViewer.statusCode}`);
}

// ---------------------------------------------------------------------------
// 10. The dashboard: the switch exists, is loaded at startup, is wired, and says what the system
//     does. Asserted on the HTML file — this suite has no browser, and the copy is the promise the
//     server-side sections above hold.
// ---------------------------------------------------------------------------
console.log('\n— 10: dashboard markup + copy —');
{
  const html = readFileSync(new URL('../r/gus/admin/index.html', import.meta.url), 'utf8');
  const card = html.slice(html.indexOf('id="supportActivityCard"'), html.indexOf('id="billingCard"'));
  ok('dashboard: the "Demohub support activity" card exists', card.includes('Demohub support activity'));
  ok('dashboard: #supportAccessToggle is a checkbox with role="switch" inside the card',
     /<input[^>]*type="checkbox"[^>]*id="supportAccessToggle"[^>]*role="switch"/.test(card) || /<input[^>]*id="supportAccessToggle"[^>]*type="checkbox"[^>]*role="switch"/.test(card), card.match(/<input[^>]*supportAccessToggle[^>]*>/)?.[0]);
  ok('dashboard: the switch has an aria-checked attribute', /id="supportAccessToggle"[^>]*aria-checked=/.test(card));
  ok('dashboard: a <label for="supportAccessToggle"> names the switch', /<label[^>]*for="supportAccessToggle"/.test(card));
  ok('dashboard: change event calls toggleSupportAccess(this.checked)', /id="supportAccessToggle"[^>]*onchange="toggleSupportAccess\(this\.checked\)"/.test(card));
  ok('dashboard: copy states ON = up to 24 hours', /24 hours/.test(card));
  ok('dashboard: copy states each session lasts at most four hours', /at most four hours/.test(card));
  ok('dashboard: copy states sessions never outlive consent', /never beyond/.test(card));
  ok('dashboard: copy states OFF immediately ends active sessions', /OFF immediately ends/.test(card));
  ok('dashboard: startup calls _loadSupportAccessStatus', /setTimeout\(_loadSupportAccessStatus/.test(html));
  ok('dashboard: the stale "toggle removed" comment is gone', !/support-access toggle removed/.test(html));
  const fnStart = html.indexOf('async function _loadSupportAccessStatus');
  const fnEnd = html.indexOf('async function resyncBillingTier');
  const fns = html.slice(fnStart, fnEnd);
  ok('dashboard: _loadSupportAccessStatus posts support-access-status', /action: 'support-access-status'/.test(fns));
  ok('dashboard: toggleSupportAccess posts support-access-toggle with a boolean', /action: 'support-access-toggle', enabled: enabled === true/.test(fns));
  ok('dashboard: toggleSupportAccess re-reads server state after saving', /await _loadSupportAccessStatus\(\)/.test(fns));
  ok('dashboard: the support-access JS never touches a session id or cookie value', !/session_id|dh_retailer_session|dh_owner_session|document\.cookie/.test(fns));
}

// ---------------------------------------------------------------------------
// 11. No secret in any response body this suite received.
// ---------------------------------------------------------------------------
console.log('\n— 11: response bodies carry no session secret —');
{
  ok('leak: at least one secret was minted to check against', secrets.size >= 4, String(secrets.size));
  const hits = [];
  for (const body of responseBodies) for (const s of secrets) if (body.includes(s)) hits.push(body.slice(0, 120));
  ok(`leak: none of ${responseBodies.length} response bodies contains any of ${secrets.size} session secrets`, hits.length === 0, JSON.stringify(hits));
  ok('leak: no response body carries a session_id key at all', !responseBodies.some(b => /"session_id"/.test(b)), responseBodies.filter(b => /"session_id"/.test(b)).map(b => b.slice(0, 120)).join(' | '));
}

console.log('\n— teardown —');
// FK order: support_sessions -> admin_sessions -> retailer_admins/tokens (tracked) -> retailer.
await db(`support_sessions?target_retailer_id=eq.${retailerId}`, { method: 'DELETE' });
await db(`admin_sessions?retailer_id=eq.${retailerId}`, { method: 'DELETE' });
for (const path of bin.reverse()) await db(path, { method: 'DELETE' });
spy.restore();
process.exit(summary('support access') ? 0 : 1);
