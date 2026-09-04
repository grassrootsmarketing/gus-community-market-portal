// tests/support_access.test.mjs — Codex F-06: the retailer "support access" toggle is ENFORCED.
//
// The retailer Settings UI says "OFF. Demohub cannot sign in to your account." Before this fix,
// owner-impersonate ignored allow_support_access / support_access_expires_at, minted the
// impersonation session anyway, and treated the support_sessions audit insert as best-effort.
// Every assertion here goes through the real exported handler with a canonical request (real
// owner cookie, real CSRF evidence, valid binding) against the staging database.
import { installSpy, callRoute, req, ok, summary, uniq } from './_route.mjs';
import { supportAccessExpiryMs, impersonationWindow } from '../api/admin-auth.js';

const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  return { ok: r.ok, status: r.status, body: j };
};
// Teardown list of exact PostgREST filter paths (admin_sessions keys on session_id, not id).
const bin = [];
const track = (path) => { bin.push(path); return path; };
const OWNER_EMAIL = 'david@demohubhq.com';
const hrs = (n) => new Date(Date.now() + n * 3600 * 1000).toISOString();
const within = (iso, targetMs, tolMs) => Math.abs(Date.parse(iso) - targetMs) <= tolMs;
const TOL = 90 * 1000; // network + clock slack

const spy = installSpy();

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
  const verified = await callRoute('admin-auth.js', req({ body: { action: 'owner-verify', token: tok.token } }));
  ownerCookie = verified.cookie('dh_owner_session');
  ok('setup: owner-verify through the route yields dh_owner_session', verified.statusCode === 200 && !!ownerCookie, `${verified.statusCode} ${JSON.stringify(verified.body)}`);
  if (ownerCookie) track(`admin_sessions?session_id=eq.${ownerCookie}`);
}

const impersonate = (rid = retailerId, extra = {}) => callRoute('admin-auth.js', req({
  body: { action: 'owner-impersonate', retailer_id: rid },
  cookies: { dh_owner_session: ownerCookie },
  headers: { 'user-agent': 'support-access-test' },
  ...extra,
}));
const setConsent = (patch) => db(`retailers?id=eq.${retailerId}`, { method: 'PATCH', body: JSON.stringify(patch) });
const sessionsFor = async () => (await db(`admin_sessions?retailer_id=eq.${retailerId}&select=session_id,expires_at,email`)).body || [];
const auditsFor = async () => (await db(`support_sessions?target_retailer_id=eq.${retailerId}&select=id,target_session_id,owner_email,ended_at,user_agent`)).body || [];
const denied = (res, label) => {
  ok(`${label}: 403`, res.statusCode === 403, `${res.statusCode} ${JSON.stringify(res.body)}`);
  ok(`${label}: opaque body support_access_disabled`, res.body && res.body.error === 'support_access_disabled', JSON.stringify(res.body));
  ok(`${label}: NO retailer cookie`, res.cookie('dh_retailer_session') === null, JSON.stringify(res.cookies()));
  ok(`${label}: NO dh_support marker cookie`, res.cookie('dh_support') === null, JSON.stringify(res.cookies()));
};

// ---------------------------------------------------------------------------
// 0. Unit: the rule itself, pinned independently of the database.
// ---------------------------------------------------------------------------
console.log('\n— 0: the consent rule (pure) —');
{
  const now = Date.UTC(2026, 8, 3, 12, 0, 0);
  ok('OFF -> null', supportAccessExpiryMs({ allow_support_access: false, support_access_expires_at: new Date(now + 3600e3).toISOString() }, now) === null);
  ok('ON but expires_at null -> null', supportAccessExpiryMs({ allow_support_access: true, support_access_expires_at: null }, now) === null);
  ok('ON but expires_at garbage -> null', supportAccessExpiryMs({ allow_support_access: true, support_access_expires_at: 'soon' }, now) === null);
  ok('ON but expires_at in the past -> null', supportAccessExpiryMs({ allow_support_access: true, support_access_expires_at: new Date(now - 1).toISOString() }, now) === null);
  ok('ON but expires_at == now -> null (strictly future)', supportAccessExpiryMs({ allow_support_access: true, support_access_expires_at: new Date(now).toISOString() }, now) === null);
  ok('truthy-but-not-true flag -> null', supportAccessExpiryMs({ allow_support_access: 'true', support_access_expires_at: new Date(now + 3600e3).toISOString() }, now) === null);
  ok('no retailer -> null', supportAccessExpiryMs(null, now) === null);
  ok('ON + future -> that expiry', supportAccessExpiryMs({ allow_support_access: true, support_access_expires_at: new Date(now + 3600e3).toISOString() }, now) === now + 3600e3);
  const w2 = impersonationWindow(now + 2 * 3600e3, now);
  ok('window: consent 2h ahead -> 2h', w2.maxAgeSeconds === 7200 && Date.parse(w2.expiresAtIso) === now + 7200e3, JSON.stringify(w2));
  const w10 = impersonationWindow(now + 10 * 3600e3, now);
  ok('window: consent 10h ahead -> capped at 4h', w10.maxAgeSeconds === 14400 && Date.parse(w10.expiresAtIso) === now + 14400e3, JSON.stringify(w10));
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
  const row = (await sessionsFor()).find(x => x.session_id === sid);
  ok('ON/10h: admin_sessions.expires_at ≈ now + 4h', row && within(row.expires_at, before + 4 * 3600e3, TOL), `${row && row.expires_at}`);
  const rc = res.cookies().find(c => c.startsWith('dh_retailer_session=')) || '';
  const ma = Number((rc.match(/Max-Age=(\d+)/) || [])[1]);
  ok('ON/10h: cookie Max-Age ≈ 4h (14400s)', Math.abs(ma - 14400) <= 90, rc);
  if (sid) track(`admin_sessions?session_id=eq.${sid}`);
}

// ---------------------------------------------------------------------------
// 6. Audit failure is FAIL-CLOSED: the fault is injected on the real support_sessions POST via
//    the harness spy. No cookie, 500 audit_unavailable, and the admin_sessions row is gone.
// ---------------------------------------------------------------------------
console.log('\n— 6: audit insert fails —');
{
  await setConsent({ allow_support_access: true, support_access_expires_at: hrs(3) });
  const sessionsBefore = (await sessionsFor()).map(x => x.session_id).sort();
  const auditsBefore = (await auditsFor()).length;
  const fault = { url: 'support_sessions', method: 'POST', status: 503, message: 'injected_audit_outage' };
  spy.faults.push(fault);
  let res;
  try { res = await impersonate(); }
  finally { spy.faults.splice(spy.faults.indexOf(fault), 1); }
  ok('audit down: 500', res.statusCode === 500, `${res.statusCode} ${JSON.stringify(res.body)}`);
  ok('audit down: body is audit_unavailable', res.body && res.body.error === 'audit_unavailable', JSON.stringify(res.body));
  ok('audit down: NO retailer cookie', res.cookie('dh_retailer_session') === null, JSON.stringify(res.cookies()));
  ok('audit down: NO dh_support marker cookie', res.cookie('dh_support') === null, JSON.stringify(res.cookies()));
  const sessionsAfter = (await sessionsFor()).map(x => x.session_id).sort();
  ok('audit down: the just-created admin_sessions row was deleted (set unchanged)',
     JSON.stringify(sessionsAfter) === JSON.stringify(sessionsBefore), `${sessionsBefore.length} -> ${sessionsAfter.length}`);
  ok('audit down: no support_sessions row appeared', (await auditsFor()).length === auditsBefore);
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
  const noCookie = await callRoute('admin-auth.js', req({ body: { action: 'owner-impersonate', retailer_id: retailerId } }));
  ok('no owner cookie: 401 before any consent check', noCookie.statusCode === 401, `${noCookie.statusCode}`);
  const asRetailer = await callRoute('admin-auth.js', req({ body: { action: 'owner-impersonate', retailer_id: retailerId }, cookies: { dh_retailer_session: ownerCookie } }));
  ok('owner secret in the RETAILER cookie cannot impersonate', asRetailer.statusCode === 401, `${asRetailer.statusCode}`);
}

// ---------------------------------------------------------------------------
// 8. owner-end-impersonation still works for the valid session from step 4.
// ---------------------------------------------------------------------------
console.log('\n— 8: end impersonation —');
{
  const res = await callRoute('admin-auth.js', req({
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

console.log('\n— teardown —');
// support_sessions + remaining admin_sessions for the fixture retailer cascade with the retailer;
// the owner session, token and any tracked session ids are removed explicitly.
await db(`support_sessions?target_retailer_id=eq.${retailerId}`, { method: 'DELETE' });
await db(`admin_sessions?retailer_id=eq.${retailerId}`, { method: 'DELETE' });
for (const path of bin.reverse()) await db(path, { method: 'DELETE' });
spy.restore();
process.exit(summary('support access') ? 0 : 1);
