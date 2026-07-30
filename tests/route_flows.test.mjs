// tests/route_flows.test.mjs — Codex finding 2: VALID-BOUND ACTUAL-ROUTE flows.
//
// Every assertion here goes through a real exported handler with a canonical request: real method,
// real body, real role cookie, real CSRF evidence, valid binding against the rebuilt staging
// database. Stripe and Resend are spied; Supabase is real.
//
// tests/live_flows.test.mjs remains as the second layer — it proves the database contract under
// concurrency. This file proves the ROUTE: binding, cookie, CSRF, parsing, authorization,
// and email containment, which direct PostgREST calls cannot exercise.
import { installSpy, callRoute, req, rawReq, ok, summary, uniq, ORIGIN } from './_route.mjs';

const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  return { ok: r.ok, status: r.status, body: j };
};
const bin = [];
const track = (t, id) => { if (id) bin.push([t, id]); return id; };
const OWNER_EMAIL = 'david@demohubhq.com';

const spy = installSpy();

// ---------------------------------------------------------------------------
// SETUP: a system owner retailer, a normal retailer with staff, a venue, a brand.
// Created directly because they are fixtures, not the thing under test.
// ---------------------------------------------------------------------------
let ownerRetailerId, retailerId, venueId, brandId, retailerSlug;
{
  const ex = await db('retailers?slug=eq.__owner__&select=id');
  ownerRetailerId = (ex.body && ex.body[0] && ex.body[0].id) ||
    (await db('retailers', { method: 'POST', body: JSON.stringify({
      slug: '__owner__', name: 'Demohub Owner (system)', billing_email: OWNER_EMAIL }) })).body[0].id;

  retailerSlug = uniq('rt');
  retailerId = track('retailers', (await db('retailers', { method: 'POST', body: JSON.stringify({
    slug: retailerSlug, name: 'Route Fixture', billing_email: `${retailerSlug}@fixture.test`,
    billing_tier: 'pro', billing_status: 'active', platform_keeps_all: true }) })).body[0].id);

  venueId = track('venues', (await db('venues', { method: 'POST', body: JSON.stringify({
    retailer_id: retailerId, name: 'Route Main', address: '1 Route St', demo_fee: 30 }) })).body[0].id);

  await db('retailer_admins', { method: 'POST', body: JSON.stringify({
    retailer_id: retailerId, email: `staff-${retailerSlug}@fixture.test`,
    email_normalized: `staff-${retailerSlug}@fixture.test`, name: 'Route Staff', role: 'admin' }) });

  brandId = track('brands', (await db('brands', { method: 'POST', body: JSON.stringify({
    email: `${uniq('brand')}@fixture.test`, company_name: 'Route Brand', is_verified: true }) })).body[0].id);
}

// ---------------------------------------------------------------------------
// 1. CSRF is enforced BY THE ROUTE, not merely by a helper that exists
// ---------------------------------------------------------------------------
console.log('\n— 1: CSRF on a real route —');
{
  const denied = await callRoute('admin-auth.js', req({ body: { action: 'data', retailer_slug: retailerSlug }, csrf: false, headers: { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' } }));
  ok('cross-origin POST to a real route is refused 403', denied.statusCode === 403, `${denied.statusCode} ${JSON.stringify(denied.body)}`);
  ok('refusal is the generic code, not a leak', denied.body && denied.body.error === 'cross_origin_denied', JSON.stringify(denied.body));

  const sibling = await callRoute('admin-auth.js', req({ body: { action: 'data', retailer_slug: retailerSlug }, csrf: false, headers: { origin: 'https://preview.demohubhq.test', 'sec-fetch-site': 'same-site' } }));
  ok('same-SITE sibling origin is refused by the route', sibling.statusCode === 403, `${sibling.statusCode}`);

  const noEvidence = await callRoute('admin-auth.js', req({ body: { action: 'data', retailer_slug: retailerSlug }, csrf: false, headers: { origin: '' } }));
  ok('a POST with no origin evidence is refused', noEvidence.statusCode === 403, `${noEvidence.statusCode}`);
}

// ---------------------------------------------------------------------------
// 2. OWNER: magic-link verify through the route -> cookie -> queue/approve/reject/suspend
// ---------------------------------------------------------------------------
console.log('\n— 2: owner verification lifecycle through the owner API —');
let ownerCookie = null;
{
  const tok = (await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: OWNER_EMAIL, retailer_id: ownerRetailerId }) })).body[0];
  const verified = await callRoute('admin-auth.js', req({ body: { action: 'owner-verify', token: tok.token } }));
  ok('owner-verify succeeds through the route', verified.statusCode === 200, `${verified.statusCode} ${JSON.stringify(verified.body)}`);
  ok('owner-verify returns NO session secret in the body',
     !/session_id|session_token/.test(JSON.stringify(verified.body || {})), JSON.stringify(verified.body));
  ownerCookie = verified.cookie('dh_owner_session');
  ok('owner-verify sets the dh_owner_session cookie', !!ownerCookie);
  const raw = verified.cookies().find(c => c.startsWith('dh_owner_session=')) || '';
  ok('owner cookie is HttpOnly + Secure + SameSite=Lax + host-only',
     /HttpOnly/.test(raw) && /Secure/.test(raw) && /SameSite=Lax/.test(raw) && !/Domain=/i.test(raw), raw.slice(0, 120));

  const queue = await callRoute('admin-auth.js', req({ body: { action: 'owner-verification-queue', status: 'pending' }, cookies: { dh_owner_session: ownerCookie } }));
  ok('owner-verification-queue returns 200 through the route', queue.statusCode === 200, `${queue.statusCode} ${JSON.stringify(queue.body).slice(0, 160)}`);
  ok('the queue contains the new retailer',
     queue.body && Array.isArray(queue.body.retailers) && queue.body.retailers.some(r => r.id === retailerId),
     `${queue.body && queue.body.retailers ? queue.body.retailers.length : '?'} rows`);

  for (const st of ['approved', 'rejected', 'suspended', 'pending']) {
    const r = await callRoute('admin-auth.js', req({ body: { action: 'owner-verify-retailer', retailer_id: retailerId, new_status: st, notes: 'route test' }, cookies: { dh_owner_session: ownerCookie } }));
    ok(`owner can set status ${st}`, r.statusCode === 200, `${r.statusCode} ${JSON.stringify(r.body)}`);
  }
  const bad = await callRoute('admin-auth.js', req({ body: { action: 'owner-verify-retailer', retailer_id: retailerId, new_status: 'nonsense' }, cookies: { dh_owner_session: ownerCookie } }));
  ok('an unknown status is refused by the route', bad.statusCode === 400, `${bad.statusCode}`);

  const noCookie = await callRoute('admin-auth.js', req({ body: { action: 'owner-verification-queue' } }));
  ok('the owner queue without a cookie is 401', noCookie.statusCode === 401, `${noCookie.statusCode}`);

  // A RETAILER cookie must not authenticate an OWNER action.
  const wrongRole = await callRoute('admin-auth.js', req({ body: { action: 'owner-verification-queue' }, cookies: { dh_retailer_session: ownerCookie } }));
  ok('a retailer cookie cannot drive an owner action', wrongRole.statusCode === 401, `${wrongRole.statusCode}`);
}

// ---------------------------------------------------------------------------
// 3. EMAIL CONTAINMENT through a real route
// ---------------------------------------------------------------------------
console.log('\n— 3: email containment on a real route —');
{
  const before = spy.calls.resend.length;
  await callRoute('admin-auth.js', req({ body: { action: 'owner-login', email: OWNER_EMAIL } }));
  const sent = spy.calls.resend.slice(before);
  ok('owner-login attempted exactly one mail', sent.length === 1, `${sent.length}`);
  if (sent.length) {
    const to = [].concat(sent[0].to || []);
    ok('mail was redirected to the sink, not the real owner address',
       to.every(a => a === 'sink@fixture.test'), JSON.stringify(to));
    ok('subject is marked as sink-redirected', /^\[SINK\]/.test(sent[0].subject || ''), sent[0].subject);
    ok('the body names the intended recipient rather than silently dropping it',
       (sent[0].html || '').includes(OWNER_EMAIL));
  }
  ok('no Stripe call occurred on a login route', spy.calls.stripe.length === 0, `${spy.calls.stripe.length}`);
}

// ---------------------------------------------------------------------------
// 4. RETAILER STAFF session through the route
// ---------------------------------------------------------------------------
console.log('\n— 4: retailer staff session through the route —');
let staffCookie = null;
{
  const tok = (await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: `staff-${retailerSlug}@fixture.test`, retailer_id: retailerId }) })).body[0];
  const v = await callRoute('admin-auth.js', req({ body: { action: 'verify', token: tok.token } }));
  ok('staff magic-link verify succeeds', v.statusCode === 200, `${v.statusCode} ${JSON.stringify(v.body)}`);
  ok('verify returns no session secret in the body', !/session_id|session_token/.test(JSON.stringify(v.body || {})));
  staffCookie = v.cookie('dh_retailer_session');
  ok('verify sets dh_retailer_session', !!staffCookie);

  const data = await callRoute('admin-auth.js', req({ body: { action: 'data', retailer_slug: retailerSlug }, cookies: { dh_retailer_session: staffCookie } }));
  ok('action=data works with the cookie alone', data.statusCode === 200, `${data.statusCode} ${JSON.stringify(data.body).slice(0, 140)}`);

  const bodySession = await callRoute('admin-auth.js', req({ body: { action: 'data', retailer_slug: retailerSlug, session_id: staffCookie } }));
  ok('the same session in the BODY is ignored (401)', bodySession.statusCode === 401, `${bodySession.statusCode}`);

  const out = await callRoute('admin-auth.js', req({ body: { action: 'logout' }, cookies: { dh_retailer_session: staffCookie } }));
  ok('logout clears all three role cookies', out.cookies().length === 3 && out.cookies().every(c => /Max-Age=0/.test(c)), JSON.stringify(out.cookies()));
  const after = await callRoute('admin-auth.js', req({ body: { action: 'data', retailer_slug: retailerSlug }, cookies: { dh_retailer_session: staffCookie } }));
  ok('the session is dead server-side after logout', after.statusCode === 401, `${after.statusCode}`);
}


// ---------------------------------------------------------------------------
// 5. BRAND: verify -> profile read/update -> logout -> re-login, all through the route
// ---------------------------------------------------------------------------
console.log('\n— 5: brand session + profile round-trip through the brand API —');
let brandCookie = null, brandEmail = null;
{
  const b = (await db(`brands?id=eq.${brandId}&select=email`)).body[0];
  brandEmail = b.email;
  // token and expires_at are NOT NULL with no defaults — the route mints them itself in the
  // login flow; here the fixture supplies them so the VERIFY path is what is under test.
  const mkTok = async () => (await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({
    brand_id: brandId, email: brandEmail, token: 'tk-' + uniq('b'),
    expires_at: new Date(Date.now() + 3600e3).toISOString() }) })).body[0];
  const tok = await mkTok();
  const v = await callRoute('brand-account.js', req({ body: { action: 'verify', token: tok.token } }));
  ok('brand verify succeeds through the route', v.statusCode === 200, `${v.statusCode} ${JSON.stringify(v.body).slice(0,140)}`);
  ok('brand verify returns NO session token in the body',
     !/session_token|session_id/.test(JSON.stringify(v.body || {})), JSON.stringify(v.body));
  brandCookie = v.cookie('dh_brand_session');
  ok('brand verify sets dh_brand_session', !!brandCookie);

  const read = await callRoute('brand-account.js', req({ body: { action: 'data' }, cookies: { dh_brand_session: brandCookie } }));
  ok('brand profile reads with the cookie alone', read.statusCode === 200, `${read.statusCode}`);

  const NEWPHONE = '555-' + Math.floor(Math.random() * 9000 + 1000);
  const upd = await callRoute('brand-account.js', req({ body: { action: 'profile-update', phone: NEWPHONE, website: 'https://example.test' }, cookies: { dh_brand_session: brandCookie } }));
  ok('brand profile-update succeeds', upd.statusCode === 200, `${upd.statusCode} ${JSON.stringify(upd.body).slice(0,140)}`);
  const after = (await db(`brands?id=eq.${brandId}&select=phone,website`)).body[0];
  ok('the update actually persisted to the database', after && after.phone === NEWPHONE, JSON.stringify(after));

  // A cross-tenant write must not be possible by naming another brand in the body.
  const other = track('brands', (await db('brands', { method: 'POST', body: JSON.stringify({ email: `${uniq('other')}@fixture.test`, company_name: 'Other Brand' }) })).body[0].id);
  await callRoute('brand-account.js', req({ body: { action: 'profile-update', brand_id: other, company_name: 'HIJACKED' }, cookies: { dh_brand_session: brandCookie } }));
  const otherAfter = (await db(`brands?id=eq.${other}&select=company_name`)).body[0];
  ok('naming another brand_id in the body does NOT edit that brand',
     otherAfter && otherAfter.company_name !== 'HIJACKED', JSON.stringify(otherAfter));

  const out = await callRoute('brand-account.js', req({ body: { action: 'logout' }, cookies: { dh_brand_session: brandCookie } }));
  ok('brand logout returns 200', out.statusCode === 200, `${out.statusCode}`);
  const dead = await callRoute('brand-account.js', req({ body: { action: 'data' }, cookies: { dh_brand_session: brandCookie } }));
  ok('the brand session is dead after logout', dead.statusCode === 401, `${dead.statusCode}`);

  const tok2 = await mkTok();
  const v2 = await callRoute('brand-account.js', req({ body: { action: 'verify', token: tok2.token } }));
  brandCookie = v2.cookie('dh_brand_session');
  ok('the brand can re-login and gets a fresh cookie', v2.statusCode === 200 && !!brandCookie, `${v2.statusCode}`);
}

// ---------------------------------------------------------------------------
// 6. FIRST BOOKING through the canonical booking API, including the COI gate
// ---------------------------------------------------------------------------
console.log('\n— 6: first booking through /api/book, COI gate enforced —');
let bookingId = null;
{
  const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 60 + n); return d.toISOString().slice(0, 10); };

  // No COI yet: the route must refuse before creating anything.
  const before = (await db(`bookings?retailer_id=eq.${retailerId}&select=id`)).body.length;
  const noCoi = await callRoute('book.js', req({ body: { retailer_slug: retailerSlug, venue_id: venueId, demo_date: day(1), demo_time: '10:00' }, cookies: { dh_brand_session: brandCookie } }));
  ok('booking without a verified COI is refused', noCoi.statusCode === 400 && noCoi.body && noCoi.body.error === 'coi_required',
     `${noCoi.statusCode} ${JSON.stringify(noCoi.body)}`);
  const mid = (await db(`bookings?retailer_id=eq.${retailerId}&select=id`)).body.length;
  ok('the refused booking created NO row', mid === before, `${before} -> ${mid}`);

  // Give the brand a valid COI, then book.
  const future = new Date(); future.setUTCFullYear(future.getUTCFullYear() + 1);
  await db(`brands?id=eq.${brandId}`, { method: 'PATCH', body: JSON.stringify({
    default_coi_url: 'coi-docs/probe.pdf', default_coi_expires: future.toISOString().slice(0, 10),
    // 'passed' is what api/brand-account.js writes after verification. api/_coi-coverage.js
    // accepts only 'passed' or 'approved' — 'verified' is NOT in that set, and an earlier draft of
    // this test used it and was correctly refused. Recorded because the strictness is the point:
    // pending / flagged / unknown must never silently count as covered.
    coi_verification_status: 'passed' }) });

  const okBooking = await callRoute('book.js', req({ body: { retailer_slug: retailerSlug, venue_id: venueId, demo_date: day(1), demo_time: '10:00' }, cookies: { dh_brand_session: brandCookie } }));
  ok('booking with a verified COI succeeds', okBooking.statusCode === 200 || okBooking.statusCode === 201,
     `${okBooking.statusCode} ${JSON.stringify(okBooking.body).slice(0, 200)}`);
  bookingId = okBooking.body && (okBooking.body.booking_id || okBooking.body.id || (okBooking.body.booking && okBooking.body.booking.id));
  if (bookingId) track('bookings', bookingId);
  ok('the booking row exists and is owned by the authenticated brand', !!bookingId, JSON.stringify(okBooking.body).slice(0, 200));
  if (bookingId) {
    const row = (await db(`bookings?id=eq.${bookingId}&select=brand_id,retailer_id,venue_id`)).body[0];
    ok('server set brand_id from the SESSION, not from the request body',
       row && row.brand_id === brandId && row.retailer_id === retailerId, JSON.stringify(row));
  }

  // A venue belonging to a different retailer must be refused by the route.
  const otherR = track('retailers', (await db('retailers', { method: 'POST', body: JSON.stringify({ slug: uniq('oth'), name: 'Other', billing_email: `${uniq('o')}@fixture.test`, billing_tier: 'pro', billing_status: 'active' }) })).body[0].id);
  const otherV = track('venues', (await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: otherR, name: 'Other Main', address: '9 Other St', demo_fee: 30 }) })).body[0].id);
  const crossed = await callRoute('book.js', req({ body: { retailer_slug: retailerSlug, venue_id: otherV, demo_date: day(2), demo_time: '11:00' }, cookies: { dh_brand_session: brandCookie } }));
  ok('a venue from another retailer is refused by the route', crossed.statusCode === 400 && crossed.body.error === 'invalid_venue', `${crossed.statusCode} ${JSON.stringify(crossed.body)}`);

  const noSession = await callRoute('book.js', req({ body: { retailer_slug: retailerSlug, venue_id: venueId, demo_date: day(3), demo_time: '12:00' } }));
  ok('booking without a brand session is refused', noSession.statusCode === 401 || noSession.statusCode === 403, `${noSession.statusCode}`);
}

// ---------------------------------------------------------------------------
// 7. CHECKOUT through the route, including stripe_session_id reuse
// ---------------------------------------------------------------------------
console.log('\n— 7: checkout route + session reuse —');
{
  if (bookingId) {
    const stripeBefore = spy.calls.stripe.length;
    const c1 = await callRoute('checkout.js', req({ body: { booking_ids: [bookingId] }, cookies: { dh_brand_session: brandCookie } }));
    ok('checkout succeeds through the route', c1.statusCode === 200, `${c1.statusCode} ${JSON.stringify(c1.body).slice(0, 180)}`);
    ok('checkout opened exactly one Stripe session', spy.calls.stripe.length - stripeBefore === 1, `${spy.calls.stripe.length - stripeBefore}`);
    const row = (await db(`bookings?id=eq.${bookingId}&select=stripe_session_id`)).body[0];
    ok('stripe_session_id was persisted on the booking (0057)', row && !!row.stripe_session_id, JSON.stringify(row));

    // A second checkout while the first attempt is still in flight is REFUSED 409, not reused.
    // That is the R11 attempt-authoritative binding, and it is stricter than session reuse: two
    // concurrent attempts against one payment group can never both be live.
    const stripeMid = spy.calls.stripe.length;
    const c2 = await callRoute('checkout.js', req({ body: { booking_ids: [bookingId] }, cookies: { dh_brand_session: brandCookie } }));
    ok('a second checkout while an attempt is in flight is refused 409',
       c2.statusCode === 409 && c2.body && c2.body.error === 'attempt_in_progress',
       `${c2.statusCode} ${JSON.stringify(c2.body).slice(0, 140)}`);
    ok('the refused retry does not hand the caller a payment URL',
       !c2.body || !c2.body.url, JSON.stringify(c2.body).slice(0, 140));

    // OBSERVATION, recorded rather than silently accepted. api/checkout.js creates the Stripe
    // Checkout Session at line 166 and only registers the attempt at line 183, so the rejected
    // retry leaves an orphaned session at Stripe. No money moves and the URL is not returned, and
    // R11's quarantine catches the dangerous case if such a session were ever paid — so this is
    // noise, not a blocker. Asserted as the CURRENT behaviour so that reordering the two calls
    // shows up here as a deliberate change rather than passing unnoticed.
    ok('KNOWN: the refused retry still created a Stripe session (create precedes attempt registration)',
       spy.calls.stripe.length - stripeMid === 1, `created ${spy.calls.stripe.length - stripeMid}`);
  } else {
    ok('checkout: skipped, no booking id from step 6', false, 'booking creation did not return an id');
  }
}

// ---------------------------------------------------------------------------
// 8. WEBHOOK: an UNSIGNED replay must be refused by the handler
// ---------------------------------------------------------------------------
console.log('\n— 8: signed webhook handler —');
{
  const evt = JSON.stringify({ id: 'evt_' + uniq('x'), type: 'checkout.session.completed', data: { object: { id: 'cs_test_x' } } });
  const unsigned = await callRoute('stripe-webhook.js', rawReq(evt));
  ok('a webhook with NO signature is refused', unsigned.statusCode >= 400, `${unsigned.statusCode} ${JSON.stringify(unsigned.body)}`);
  const badsig = await callRoute('stripe-webhook.js', rawReq(evt, { signature: 't=1,v1=deadbeef' }));
  ok('a webhook with a FORGED signature is refused', badsig.statusCode >= 400, `${badsig.statusCode} ${JSON.stringify(badsig.body)}`);
  ok('the webhook route is exempt from CSRF by design (no cookie, signature-authenticated)',
     unsigned.statusCode !== 403 || (unsigned.body && unsigned.body.error !== 'cross_origin_denied'),
     JSON.stringify(unsigned.body));
}

// ---------------------------------------------------------------------------
// 9. COI retrieval: authorised vs unauthorised, through the route
// ---------------------------------------------------------------------------
console.log('\n— 9: COI retrieval authorisation through /api/coi-file —');
{
  const mine = await callRoute('coi-file.js', { method: 'GET', query: { brand_id: brandId }, socket: {}, headers: { cookie: `dh_brand_session=${encodeURIComponent(brandCookie)}`, origin: ORIGIN } });
  ok('the brand can reach its OWN certificate route', mine.statusCode !== 403, `${mine.statusCode} ${JSON.stringify(mine.body).slice(0,140)}`);

  const anon = await callRoute('coi-file.js', { method: 'GET', query: { brand_id: brandId }, socket: {}, headers: { origin: ORIGIN } });
  ok('an unauthenticated caller is DENIED the certificate', anon.statusCode === 401 || anon.statusCode === 403, `${anon.statusCode} ${JSON.stringify(anon.body)}`);

  const otherBrand = track('brands', (await db('brands', { method: 'POST', body: JSON.stringify({ email: `${uniq('x')}@fixture.test`, company_name: 'Not Yours' }) })).body[0].id);
  const cross = await callRoute('coi-file.js', { method: 'GET', query: { brand_id: otherBrand }, socket: {}, headers: { cookie: `dh_brand_session=${encodeURIComponent(brandCookie)}`, origin: ORIGIN } });
  ok("one brand's session cannot fetch ANOTHER brand's certificate", cross.statusCode === 401 || cross.statusCode === 403, `${cross.statusCode} ${JSON.stringify(cross.body)}`);
}

console.log('\n— teardown —');
for (const [t, id] of bin.reverse()) await db(`${t}?id=eq.${id}`, { method: 'DELETE' });
spy.restore();
process.exit(summary('route flows') ? 0 : 1);
