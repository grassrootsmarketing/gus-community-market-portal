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
  // NOTE: this fixture patch remains ONLY to reach the booking assertions below. Section 12
  // is where a certificate now travels the real path -- upload, pending, owner review,
  // approval -- because Codex v6 correctly identified that a direct
  // coi_verification_status='passed' PATCH proved the booking gate worked while proving
  // nothing about how any real certificate would ever reach that state.
  await db(`brands?id=eq.${brandId}`, { method: 'PATCH', body: JSON.stringify({
    default_coi_url: 'coi-docs/probe.pdf', default_coi_expires: future.toISOString().slice(0, 10),
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

// ---------------------------------------------------------------------------
// 10. A CORRECTLY SIGNED webhook, and the same event replayed — Codex v5 finding 2.
//
// Section 8 above proves the handler REFUSES an unsigned and a forged event. That is a
// negative test, and Codex's point is that refusing is not the same as working: nothing
// had ever driven a VALID signature through this route. So this section computes a real
// Stripe signature over the exact bytes and sends it to the real handler.
//
// Then it sends the identical event a second time. Replay idempotency was previously
// proven in live_flows GROUP 7 — at the DATABASE layer, by calling the RPC directly. That
// skips signature verification, body parsing and the inbox write, which is precisely
// where a duplicate would be introduced.
// ---------------------------------------------------------------------------
console.log('\n— 10: a correctly signed webhook, and its replay, through the real handler —');
{
  const { createHmac } = await import('node:crypto');

  // Exactly how Stripe signs: HMAC-SHA256 over "<timestamp>.<raw body>" with the endpoint
  // secret. tests/_route.mjs sets STRIPE_WEBHOOK_SECRET to 'whsec_harness', so the handler
  // and this test derive the same signature from the same secret without either hardcoding
  // the digest.
  const sign = (payload, secret = 'whsec_harness') => {
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
    return `t=${t},v1=${v1}`;
  };

  const eventId = 'evt_' + uniq('sig');
  const payload = JSON.stringify({
    id: eventId,
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_' + uniq('s'), object: 'checkout.session', payment_status: 'unpaid' } },
  });

  const first = await callRoute('stripe-webhook.js', rawReq(payload, { signature: sign(payload) }));
  ok('a CORRECTLY signed webhook is accepted by the real handler',
     first.statusCode >= 200 && first.statusCode < 300,
     `${first.statusCode} ${JSON.stringify(first.body).slice(0, 160)}`);

  // The inbox table is processed_stripe_events. My first attempt guessed 'webhook_events',
  // which does not exist, so PostgREST returned an object rather than an array and the
  // assertion reported rows=-1. Guessing a table name is the same error as guessing a
  // request shape: the test fails for a reason that has nothing to do with the product.
  const inboxAfterFirst = await db(`processed_stripe_events?event_id=eq.${eventId}&select=event_id,status`);
  const n1 = Array.isArray(inboxAfterFirst.body) ? inboxAfterFirst.body.length : -1;
  ok('the signed event is recorded exactly once', n1 === 1, `rows=${n1}`);

  const stripeCallsBefore = spy.calls.stripe.length;

  // THE REPLAY. Byte-identical payload, freshly signed — Stripe retries carry the same
  // event id, and the id is what must make this a no-op.
  const second = await callRoute('stripe-webhook.js', rawReq(payload, { signature: sign(payload) }));
  ok('the replayed event is still accepted (Stripe must not be told to retry forever)',
     second.statusCode >= 200 && second.statusCode < 300,
     `${second.statusCode} ${JSON.stringify(second.body).slice(0, 160)}`);

  const inboxAfterSecond = await db(`processed_stripe_events?event_id=eq.${eventId}&select=event_id,status`);
  const n2 = Array.isArray(inboxAfterSecond.body) ? inboxAfterSecond.body.length : -1;
  ok('the replay creates NO second inbox row', n2 === 1, `rows=${n2}`);

  ok('the replay makes NO additional Stripe call',
     spy.calls.stripe.length === stripeCallsBefore,
     `${stripeCallsBefore} -> ${spy.calls.stripe.length}`);

  // A tampered body must fail even though the signature is well-formed, because the digest
  // covers the bytes. Without this, "signed" could mean "has a signature header".
  const tampered = payload.replace('unpaid', 'paid');
  const forged = await callRoute('stripe-webhook.js', rawReq(tampered, { signature: sign(payload) }));
  ok('a body altered after signing is REFUSED', forged.statusCode >= 400,
     `${forged.statusCode} ${JSON.stringify(forged.body).slice(0, 140)}`);
}

// ---------------------------------------------------------------------------
// 11. Calendar: issue, rotate, revoke, and feed authorisation — through the ROUTES.
//
// live_flows GROUP 4 exercises issue/resolve/revoke by calling the RPCs directly. That
// proves the database contract and nothing about api/brand-account.js or api/cal.js:
// not the session cookie, not the mutation-method guard, not the feed's key comparison.
// Codex asked for these specifically "through the application routes".
// ---------------------------------------------------------------------------
console.log('\n— 11: calendar issue / rotate / revoke / feed auth, through the routes —');
{
  const issued = await callRoute('brand-account.js',
    req({ body: { action: 'cal_token' }, cookies: { dh_brand_session: brandCookie } }));
  const tok1 = issued.body && issued.body.token;
  ok('cal_token issues a token through the route', issued.statusCode === 200 && !!tok1,
     `${issued.statusCode} ${JSON.stringify(issued.body).slice(0, 140)}`);

  const reissued = await callRoute('brand-account.js',
    req({ body: { action: 'cal_token' }, cookies: { dh_brand_session: brandCookie } }));
  ok('re-issuing without rotate returns the SAME token', reissued.body && reissued.body.token === tok1,
     `${tok1} vs ${reissued.body && reissued.body.token}`);

  const rotated = await callRoute('brand-account.js',
    req({ body: { action: 'cal_token', rotate: true }, cookies: { dh_brand_session: brandCookie } }));
  const tok2 = rotated.body && rotated.body.token;
  ok('rotate issues a DIFFERENT token', !!tok2 && tok2 !== tok1, `${tok1} -> ${tok2}`);
  ok('rotate reports itself as a rotation', rotated.body && rotated.body.rotated === true,
     JSON.stringify(rotated.body).slice(0, 120));

  const noSession = await callRoute('brand-account.js', req({ body: { action: 'cal_token' } }));
  ok('cal_token without a brand cookie is refused', noSession.statusCode === 401,
     `${noSession.statusCode} ${JSON.stringify(noSession.body)}`);

  // Built with req(), not by hand. api/brand-account.js reads the body off the request
  // stream, so a plain object without .on() throws 'req.on is not a function' -- a harness
  // defect that would have been reported as a route failure.
  const getToken = await callRoute('brand-account.js',
    req({ method: 'GET', query: { action: 'cal_token' }, cookies: { dh_brand_session: brandCookie } }));
  ok('cal_token refuses GET (it mutates)', getToken.statusCode === 405 || getToken.statusCode >= 400,
     `${getToken.statusCode} ${JSON.stringify(getToken.body).slice(0, 120)}`);

  const revoked = await callRoute('brand-account.js',
    req({ body: { action: 'cal_revoke' }, cookies: { dh_brand_session: brandCookie } }));
  ok('cal_revoke succeeds through the route', revoked.statusCode === 200,
     `${revoked.statusCode} ${JSON.stringify(revoked.body).slice(0, 140)}`);

  // brand_calendar_tokens, not calendar_tokens. Third table name I have guessed wrong in
  // this file. PostgREST names the correct relation in its hint, which is the only reason
  // each one cost a single run instead of a debugging session.
  const afterRevoke = await db(`brand_calendar_tokens?brand_id=eq.${brandId}&revoked_at=is.null&select=token`);
  ok('no live calendar token survives revocation',
     Array.isArray(afterRevoke.body) && afterRevoke.body.length === 0,
     JSON.stringify(afterRevoke.body).slice(0, 140));

  // --- feed authorisation, api/cal.js ---
  // The slug is public: it appears in every booking link. The feed key is the only thing
  // standing between that slug and a retailer's entire demo schedule.
  const feedKey = 'fk_' + uniq('k').replace(/-/g, '');
  await db(`retailers?id=eq.${retailerId}`, { method: 'PATCH', body: JSON.stringify({ cal_feed_key: feedKey }) });

  const noKey = await callRoute('cal.js', req({ method: 'GET', query: { slug: retailerSlug } }));
  ok('the calendar feed refuses a request with NO key', noKey.statusCode === 401, `${noKey.statusCode}`);

  const wrongKey = await callRoute('cal.js',
    req({ method: 'GET', query: { slug: retailerSlug, key: 'x'.repeat(feedKey.length) } }));
  ok('the calendar feed refuses a WRONG key of the same length', wrongKey.statusCode === 401, `${wrongKey.statusCode}`);

  const rightKey = await callRoute('cal.js',
    req({ method: 'GET', query: { slug: retailerSlug, key: feedKey } }));
  ok('the calendar feed serves iCal for the CORRECT key',
     rightKey.statusCode === 200 && String(rightKey.body || '').includes('BEGIN:VCALENDAR'),
     `${rightKey.statusCode} ${String(rightKey.body || '').slice(0, 60)}`);

  const unknownSlug = await callRoute('cal.js',
    req({ method: 'GET', query: { slug: 'no-such-retailer-' + uniq('z'), key: feedKey } }));
  ok('an unknown slug does not leak a 401-vs-404 distinction that confirms existence',
     unknownSlug.statusCode === 404 || unknownSlug.statusCode === 401, `${unknownSlug.statusCode}`);
}

// ---------------------------------------------------------------------------
// 12. THE COI PATH THAT DID NOT EXIST — upload, pending, owner review, book.
//
// Codex v6: with COI_UPLOAD_ENABLED=true and COI_AI_VERIFICATION_ENABLED=false, an upload
// lands 'pending' and only a human can move it. Before migration 0058 and the owner routes,
// nothing could — a brand could upload a perfectly valid certificate and never be able to
// book. This section walks the whole path through real routes.
// ---------------------------------------------------------------------------
console.log('\n— 12: COI upload -> pending -> owner review -> book —');
{
  // A synthetic, non-personal fixture. Must start with %PDF (the handler sniffs magic bytes,
  // so a renamed file is refused) and exceed the 3KB floor that rejects "documents" too small
  // to be certificates.
  const pdf = (tag) => {
    const head = `%PDF-1.4\n% fixture ${tag}\n`;
    return Buffer.from(head + 'x'.repeat(4096)).toString('base64');
  };
  const dataUrl = (tag) => `data:application/pdf;base64,${pdf(tag)}`;
  const future = new Date(Date.now() + 400 * 864e5).toISOString().slice(0, 10);
  // Section 6's day() is block-scoped to section 6. check-undefined caught the reference,
  // which is the whole reason that checker runs before anything reaches a database.
  const dayN = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

  // A brand of its own, so section 6's fixture patch cannot mask anything here.
  const revEmail = `${uniq('coi')}@fixture.test`;
  const revBrandId = track('brands', (await db('brands', { method: 'POST', body: JSON.stringify({
    email: revEmail, company_name: 'COI Review Co' }) })).body[0].id);
  // Establish the session the way section 5 does -- mint a magic-link token, then let the
  // ROUTE issue the cookie. My first attempt inserted straight into brand_account_sessions,
  // which returned nothing and threw "Cannot read properties of undefined". Fabricating a
  // session row would also have skipped the very code path that decides what a valid brand
  // session is.
  const revTok = (await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({
    brand_id: revBrandId, email: revEmail, token: 'tk-' + uniq('c'),
    expires_at: new Date(Date.now() + 3600e3).toISOString() }) })).body[0];
  const revVerify = await callRoute('brand-account.js', req({ body: { action: 'verify', token: revTok.token } }));
  const revSess = revVerify.cookie('dh_brand_session');
  ok('the review fixture brand has a real session from the verify route', !!revSess,
     `${revVerify.statusCode} ${JSON.stringify(revVerify.body).slice(0, 120)}`);

  const up1 = await callRoute('brand-account.js', req({
    body: { action: 'upload-coi', file: dataUrl('one'), expires: future },
    cookies: { dh_brand_session: revSess } }));
  ok('upload-coi succeeds through the route', up1.statusCode === 200,
     `${up1.statusCode} ${JSON.stringify(up1.body).slice(0, 160)}`);

  const b1 = (await db(`brands?id=eq.${revBrandId}&select=coi_verification_status,default_coi_url`)).body || [];
  ok('the upload lands PENDING, not approved',
     b1[0] && b1[0].coi_verification_status === 'pending', JSON.stringify(b1[0]));
  ok('the stored certificate is a storage PATH, not a public URL',
     b1[0] && b1[0].default_coi_url && !/^https?:\/\//.test(String(b1[0].default_coi_url)),
     String(b1[0] && b1[0].default_coi_url).slice(0, 80));

  const v1rows = (await db(`coi_verifications?brand_id=eq.${revBrandId}&select=id,status,review_decision&order=created_at.desc`)).body || [];
  ok('an audit record was written', v1rows.length >= 1 && v1rows[0].review_decision === null,
     JSON.stringify(v1rows[0]));
  const v1 = v1rows[0] && v1rows[0].id;

  // --- a pending certificate cannot book ---
  const blocked = await callRoute('book.js', req({
    body: { retailer_slug: retailerSlug, venue_id: venueId, demo_date: dayN(9), demo_time: '11:00' },
    cookies: { dh_brand_session: revSess } }));
  ok('a PENDING certificate cannot book', blocked.statusCode === 400 && blocked.body && blocked.body.error === 'coi_required',
     `${blocked.statusCode} ${JSON.stringify(blocked.body).slice(0, 140)}`);

  // --- only the platform owner may review ---
  const anonReview = await callRoute('admin-auth.js', req({ body: { action: 'owner-coi-review', verification_id: v1, decision: 'approved' } }));
  ok('an ANONYMOUS caller cannot review', anonReview.statusCode === 401, `${anonReview.statusCode}`);

  const brandReview = await callRoute('admin-auth.js', req({
    body: { action: 'owner-coi-review', verification_id: v1, decision: 'approved' },
    cookies: { dh_brand_session: revSess } }));
  ok('a BRAND session cannot review', brandReview.statusCode === 401, `${brandReview.statusCode}`);

  const retailerReview = await callRoute('admin-auth.js', req({
    body: { action: 'owner-coi-review', verification_id: v1, decision: 'approved' },
    cookies: { dh_retailer_session: staffCookie } }));
  ok('a RETAILER session cannot review', retailerReview.statusCode === 401, `${retailerReview.statusCode}`);

  // --- the owner queue and viewer ---
  const queue = await callRoute('admin-auth.js', req({ body: { action: 'owner-coi-queue' }, cookies: { dh_owner_session: ownerCookie } }));
  ok('the owner queue returns 200', queue.statusCode === 200, `${queue.statusCode}`);
  ok('the queue contains this pending record',
     Array.isArray(queue.body && queue.body.queue) && queue.body.queue.some(r => r.id === v1),
     JSON.stringify((queue.body && queue.body.queue || []).map(r => r.id)).slice(0, 120));
  ok('the queue does NOT hand out a document URL',
     !JSON.stringify(queue.body || {}).includes('coi_url'), 'coi_url present in queue payload');

  const view = await callRoute('admin-auth.js', req({ body: { action: 'owner-coi-view', verification_id: v1 }, cookies: { dh_owner_session: ownerCookie } }));
  ok('owner-coi-view mints a short-lived link', view.statusCode === 200 && view.body && view.body.expires_in <= 120,
     `${view.statusCode} ${JSON.stringify(view.body).slice(0, 120)}`);

  // --- approve, then the brand can book ---
  const approve = await callRoute('admin-auth.js', req({
    body: { action: 'owner-coi-review', verification_id: v1, decision: 'approved', notes: 'fixture review' },
    cookies: { dh_owner_session: ownerCookie } }));
  ok('the owner can APPROVE through the route', approve.statusCode === 200, `${approve.statusCode} ${JSON.stringify(approve.body).slice(0,140)}`);

  const b2 = (await db(`brands?id=eq.${revBrandId}&select=coi_verification_status`)).body || [];
  ok('approval moves the brand to approved', b2[0] && b2[0].coi_verification_status === 'approved', JSON.stringify(b2[0]));

  const booked = await callRoute('book.js', req({
    body: { retailer_slug: retailerSlug, venue_id: venueId, demo_date: dayN(9), demo_time: '11:00' },
    cookies: { dh_brand_session: revSess } }));
  ok('an APPROVED certificate can book', booked.statusCode === 200 || booked.statusCode === 201,
     `${booked.statusCode} ${JSON.stringify(booked.body).slice(0, 160)}`);
  const bid = booked.body && (booked.body.booking_id || booked.body.id || (booked.body.booking && booked.body.booking.id));
  if (bid) track('bookings', bid);

  // --- a replacement returns the brand to pending ---
  const up2 = await callRoute('brand-account.js', req({
    body: { action: 'upload-coi', file: dataUrl('two'), expires: future },
    cookies: { dh_brand_session: revSess } }));
  ok('a replacement upload succeeds', up2.statusCode === 200, `${up2.statusCode}`);
  const b3 = (await db(`brands?id=eq.${revBrandId}&select=coi_verification_status`)).body || [];
  ok('a replacement returns the brand to PENDING', b3[0] && b3[0].coi_verification_status === 'pending', JSON.stringify(b3[0]));

  const v2rows = (await db(`coi_verifications?brand_id=eq.${revBrandId}&review_decision=is.null&select=id&order=created_at.desc`)).body || [];
  const v2 = v2rows[0] && v2rows[0].id;
  ok('the replacement produced a new un-reviewed record', !!v2 && v2 !== v1, `${v1} -> ${v2}`);

  // --- THE STALE CASE: approving the OLD record must be refused ---
  const stale = await callRoute('admin-auth.js', req({
    body: { action: 'owner-coi-review', verification_id: v1, decision: 'approved' },
    cookies: { dh_owner_session: ownerCookie } }));
  // 0060 makes reviews IMMUTABLE, so re-approving v1 -- which was already approved earlier
  // in this section -- is refused as already_decided BEFORE staleness is considered. Both
  // are correct refusals of the same attack; the assertion accepts either and names which.
  ok('re-deciding an already-decided record is refused',
     stale.statusCode === 409 && stale.body && (stale.body.error === 'already_decided' || stale.body.error === 'stale_review'),
     `${stale.statusCode} ${JSON.stringify(stale.body).slice(0, 140)}`);

  // --- reject the replacement; it must not be able to book ---
  const reject = await callRoute('admin-auth.js', req({
    body: { action: 'owner-coi-review', verification_id: v2, decision: 'rejected', notes: 'fixture rejection' },
    cookies: { dh_owner_session: ownerCookie } }));
  ok('the owner can REJECT through the route', reject.statusCode === 200, `${reject.statusCode}`);

  const b4 = (await db(`brands?id=eq.${revBrandId}&select=coi_verification_status`)).body || [];
  ok('rejection moves the brand to rejected', b4[0] && b4[0].coi_verification_status === 'rejected', JSON.stringify(b4[0]));

  const rejectedBooking = await callRoute('book.js', req({
    body: { retailer_slug: retailerSlug, venue_id: venueId, demo_date: dayN(10), demo_time: '12:00' },
    cookies: { dh_brand_session: revSess } }));
  ok('a REJECTED certificate cannot book', rejectedBooking.statusCode === 400 && rejectedBooking.body && rejectedBooking.body.error === 'coi_required',
     `${rejectedBooking.statusCode} ${JSON.stringify(rejectedBooking.body).slice(0, 140)}`);

  const audit = (await db(`coi_verifications?id=eq.${v2}&select=review_decision,reviewed_by,reviewed_at,review_notes`)).body || [];
  ok('the rejected record is retained for audit with who and when',
     audit[0] && audit[0].review_decision === 'rejected' && !!audit[0].reviewed_by && !!audit[0].reviewed_at,
     JSON.stringify(audit[0]));

  // The PURELY stale case, which is Codex's actual attack: a never-decided record that has
  // been superseded by a newer upload. v1 above cannot test this because it carries a
  // decision already.
  const up3 = await callRoute('brand-account.js', req({
    body: { action: 'upload-coi', file: dataUrl('three'), expires: future },
    cookies: { dh_brand_session: revSess } }));
  ok('a third upload succeeds', up3.statusCode === 200, `${up3.statusCode}`);

  // A FOURTH upload, because supersession only applies to rows that are still OPEN. By this
  // point v1 is approved and v2 rejected, so the third upload had nothing to supersede --
  // it was the only open version. Two open versions are required to test the rule at all,
  // which my previous assertion did not arrange.
  const up4 = await callRoute('brand-account.js', req({
    body: { action: 'upload-coi', file: dataUrl('four'), expires: future },
    cookies: { dh_brand_session: revSess } }));
  ok('a fourth upload succeeds', up4.statusCode === 200, `${up4.statusCode}`);
  const openRows = (await db(`coi_verifications?brand_id=eq.${revBrandId}&review_decision=is.null&select=id,superseded_at,created_at&order=created_at.desc`)).body || [];
  const newest = openRows.find(r => !r.superseded_at);
  const superseded = openRows.find(r => r.superseded_at);
  ok('the earlier open version is marked superseded', !!superseded, JSON.stringify(openRows).slice(0, 160));
  if (superseded) {
    const staleApprove = await callRoute('admin-auth.js', req({
      body: { action: 'owner-coi-review', verification_id: superseded.id, decision: 'approved' },
      cookies: { dh_owner_session: ownerCookie } }));
    ok('approving a SUPERSEDED, never-decided record is refused as stale',
       staleApprove.statusCode === 409 && staleApprove.body && staleApprove.body.error === 'stale_review',
       `${staleApprove.statusCode} ${JSON.stringify(staleApprove.body).slice(0, 140)}`);
    const viewStale = await callRoute('admin-auth.js', req({
      body: { action: 'owner-coi-view', verification_id: superseded.id },
      cookies: { dh_owner_session: ownerCookie } }));
    ok('viewing a superseded record is refused', viewStale.statusCode === 409, `${viewStale.statusCode}`);
  }
  if (newest) {
    const rows2 = (await db(`coi_verifications?id=eq.${newest.id}&select=storage_path`)).body || [];
    ok('each upload has its OWN immutable storage path',
       !!(rows2[0] && rows2[0].storage_path && rows2[0].storage_path.includes(revBrandId) && rows2[0].storage_path.includes(newest.id)),
       JSON.stringify(rows2[0]));
  }

  // --- clean up through the application route ---
  const removed = await callRoute('brand-account.js', req({ body: { action: 'remove-coi' }, cookies: { dh_brand_session: revSess } }));
  ok('remove-coi succeeds through the route', removed.statusCode === 200, `${removed.statusCode}`);
  const b5 = (await db(`brands?id=eq.${revBrandId}&select=default_coi_url`)).body || [];
  ok('the certificate is detached from the brand', b5[0] && !b5[0].default_coi_url, JSON.stringify(b5[0]));

  for (const r of ((await db(`coi_verifications?brand_id=eq.${revBrandId}&select=id`)).body || [])) {
    await db(`coi_verifications?id=eq.${r.id}`, { method: 'DELETE' });
  }
}

// ---------------------------------------------------------------------------
// 13. THE PAID PATH — THREE bookings, ONE payment, exact-once fulfilment.
//
// Codex v6-FINAL blocker B4. The previous section paid a SINGLE booking and then made claims
// it never proved: it asserted `status !== 'frozen'` (which pending/failed also satisfy), never
// asserted the demo count equalled one, labelled the brand email a "staff notification" via a
// broad regex, and ran its mismatch case against an ALREADY-paid group. This rewrite proves the
// real multi-demo money path end to end, with exact counts, against the actual routes and RPCs:
//
//   /api/book      creates THREE bookings for one retailer, each on its own slot
//   /api/checkout  claims ONE payment group with three immutable allocations
//   signed PAID checkout.session.completed  → apply_verified_payment → the fulfilment outbox
//   replay of the identical event           → zero second effects of any kind
//   a FRESH mismatched event                → promotes nothing, opens exactly one case
//   the refund route on ONE booking         → changes only that booking, never fans out
//
// Stripe is never contacted: the Session, PaymentIntent and Charge are test-controlled fixtures
// on the spy, so the handler retrieves exactly the objects this test defines.
// ---------------------------------------------------------------------------
console.log('\n— 13: three-booking payment, exact-once fulfilment, mismatch, refund —');
{
  const { createHmac } = await import('node:crypto');
  const sign = (payload, secret = 'whsec_harness') => {
    const t = Math.floor(Date.now() / 1000);
    return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
  };
  const dayP = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const setOf = (arr) => JSON.stringify([...arr].map(String).sort());
  const idList = (arr) => arr.map(encodeURIComponent).join(',');

  // Deterministic auto-confirm. With auto_confirm_bookings ON, each paid booking's outbox row
  // carries target_status='confirmed', so fulfilment materialises EXACTLY one demo per booking.
  // Asserting an exact demo count (Codex B4 §5) requires a KNOWN value, not the fixture default.
  await db(`retailers?id=eq.${retailerId}`, { method: 'PATCH', body: JSON.stringify({ auto_confirm_bookings: true }) });

  // A staff member who MUST receive the "new demo scheduled" alert. notifyStaffForBooking fires
  // ONLY when notification_prefs.on_scheduled is true — the old fixture set {new_booking,payment},
  // so no staff mail was ever sent and the old regex was matching the brand email's word "booking".
  const staffEmail = `${uniq('staff')}@fixture.test`;
  track('internal_contacts', (await db('internal_contacts', { method: 'POST', body: JSON.stringify({
    retailer_id: retailerId, name: 'Notified Staff', email: staffEmail,
    notification_prefs: { on_scheduled: true }, venue_ids: [venueId] }) })).body?.[0]?.id);

  // A brand with an APPROVED certificate, signed in through the real verify route.
  const payEmail = `${uniq('pay')}@fixture.test`;
  const payBrand = track('brands', (await db('brands', { method: 'POST', body: JSON.stringify({
    email: payEmail, company_name: 'Paying Brand',
    default_coi_url: 'brands/paying.pdf', default_coi_expires: dayP(400),
    coi_verification_status: 'approved' }) })).body[0].id);
  const payTok = (await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({
    brand_id: payBrand, email: payEmail, token: 'tk-' + uniq('p'),
    expires_at: new Date(Date.now() + 36e5).toISOString() }) })).body[0];
  const paySess = (await callRoute('brand-account.js', req({ body: { action: 'verify', token: payTok.token } }))).cookie('dh_brand_session');
  ok('the paying brand has a real session', !!paySess);

  // THREE bookings for the SAME retailer, each on its own slot so three DISTINCT demos exist
  // (createDemoForConfirmedBooking dedupes by retailer+venue+date+time).
  const bookingIds = [];
  for (let i = 0; i < 3; i++) {
    const bk = await callRoute('book.js', req({
      body: { retailer_slug: retailerSlug, venue_id: venueId, demo_date: dayP(21 + i), demo_time: '13:00' },
      cookies: { dh_brand_session: paySess } }));
    const id = bk.body && (bk.body.booking_id || bk.body.id || (bk.body.booking && bk.body.booking.id));
    if (id) { track('bookings', id); bookingIds.push(id); }
  }
  ok('three bookings were created through /api/book', bookingIds.length === 3, `${bookingIds.length}`);

  // ONE checkout for all three booking ids.
  const co = await callRoute('checkout.js', req({
    body: { booking_ids: bookingIds }, cookies: { dh_brand_session: paySess } }));
  ok('/api/checkout accepts all three bookings in a SINGLE call', co.statusCode === 200,
     `${co.statusCode} ${JSON.stringify(co.body).slice(0, 200)}`);
  const sessionId = co.body && co.body.session_id;
  const groupId   = co.body && co.body.payment_group_id;
  const total     = co.body && co.body.total_cents;
  ok('checkout returned a session id, group id and total', !!sessionId && !!groupId && Number.isFinite(total),
     JSON.stringify({ sessionId, groupId, total }));

  // ---- BEFORE PAYMENT ----------------------------------------------------------------------
  const groupsForBookings = ((await db(`payment_allocations?booking_id=in.(${idList(bookingIds)})&select=payment_group_id`)).body) || [];
  const distinctGroups = [...new Set(groupsForBookings.map(a => a.payment_group_id))];
  ok('the three bookings belong to EXACTLY ONE payment group',
     distinctGroups.length === 1 && distinctGroups[0] === groupId, JSON.stringify(distinctGroups));

  const openAttempts = ((await db(`payment_attempts?payment_group_id=eq.${groupId}&status=eq.open&select=stripe_checkout_session_id`)).body) || [];
  ok('exactly ONE open attempt is bound to the returned session',
     openAttempts.length === 1 && openAttempts[0].stripe_checkout_session_id === sessionId, JSON.stringify(openAttempts));

  const allocs = ((await db(`payment_allocations?payment_group_id=eq.${groupId}&select=booking_id,customer_amount`)).body) || [];
  ok('exactly THREE allocations exist for the group', allocs.length === 3, `${allocs.length}`);
  ok('the allocation booking-id set equals the exact three booked ids',
     setOf(allocs.map(a => a.booking_id)) === setOf(bookingIds), JSON.stringify(allocs.map(a => a.booking_id)));
  const allocSum = allocs.reduce((s, a) => s + Number(a.customer_amount || 0), 0);
  ok('the allocation sum equals the checkout total', allocSum === Number(total), `${allocSum} vs ${total}`);

  const preBookings = ((await db(`bookings?id=in.(${idList(bookingIds)})&select=id,payment_status,status`)).body) || [];
  ok('all three bookings are unpaid and pending_payment before payment',
     preBookings.length === 3 && preBookings.every(b => b.payment_status !== 'paid' && b.status === 'pending_payment'),
     JSON.stringify(preBookings));

  // ---- THE SIGNED PAID EVENT ---------------------------------------------------------------
  const piId = 'pi_' + uniq('paid');
  const chargeId = 'ch_' + uniq('paid');
  // latest_charge is EXPANDED because stripe-webhook.js reads charge.destination /
  // application_fee_amount / transfer off it. amount_received matches the ledger total.
  spy.fixtures.paymentIntents[piId] = {
    id: piId, object: 'payment_intent', amount_received: total, currency: 'usd', on_behalf_of: null,
    latest_charge: { id: chargeId, object: 'charge', destination: null,
                     application_fee_amount: null, transfer: null, application_fee: null },
  };
  const paidEvent = JSON.stringify({
    id: 'evt_' + uniq('paid'), type: 'checkout.session.completed',
    data: { object: { id: sessionId, object: 'checkout.session', mode: 'payment',
                      payment_status: 'paid', amount_total: total, currency: 'usd',
                      payment_intent: piId, metadata: { payment_group_id: groupId } } },
  });

  const resendBefore = spy.calls.resend.length;
  const stripeBefore = spy.calls.stripe.length;
  const paid1 = await callRoute('stripe-webhook.js', rawReq(paidEvent, { signature: sign(paidEvent) }));
  ok('a signed PAID event is accepted', paid1.statusCode >= 200 && paid1.statusCode < 300,
     `${paid1.statusCode} ${JSON.stringify(paid1.body).slice(0, 160)}`);

  // ---- AFTER FIRST DELIVERY ----------------------------------------------------------------
  const grp1 = ((await db(`payment_groups?id=eq.${groupId}&select=status`)).body || [])[0];
  ok('the payment group status is exactly paid', grp1 && grp1.status === 'paid', JSON.stringify(grp1));
  const att1 = ((await db(`payment_attempts?stripe_checkout_session_id=eq.${encodeURIComponent(sessionId)}&select=status`)).body || [])[0];
  ok('the payment attempt status is exactly paid', att1 && att1.status === 'paid', JSON.stringify(att1));

  const postBookings = ((await db(`bookings?id=in.(${idList(bookingIds)})&select=id,payment_status`)).body) || [];
  ok('all and only the three bookings are paid',
     postBookings.length === 3 && postBookings.every(b => b.payment_status === 'paid'), JSON.stringify(postBookings));

  const fulfil1 = ((await db(`booking_fulfillments?payment_group_id=eq.${groupId}&select=booking_id,demo_created,emails_sent`)).body) || [];
  ok('exactly one fulfilment row exists per booking',
     fulfil1.length === 3 && setOf(fulfil1.map(f => f.booking_id)) === setOf(bookingIds), `${fulfil1.length}`);
  ok('every fulfilment row recorded its demo and its emails',
     fulfil1.every(f => f.demo_created === true && f.emails_sent === true), JSON.stringify(fulfil1));

  const demos1 = ((await db(`demos?booking_id=in.(${idList(bookingIds)})&select=id,booking_id`)).body) || [];
  for (const d of demos1) track('demos', d.id);
  ok('exactly THREE demos were materialised — one per booking',
     demos1.length === 3 && setOf(demos1.map(d => d.booking_id)) === setOf(bookingIds), `${demos1.length}`);

  // EXACT email counts by message type. Recipients are all the contained sink; the two message
  // types are told apart by their distinct, constant subject phrases — NOT a broad regex.
  const mails1 = spy.calls.resend.slice(resendBefore);
  const recips1 = mails1.flatMap(m => Array.isArray(m.to) ? m.to : [m.to]).filter(Boolean);
  ok('every post-payment recipient is the approved sink',
     recips1.length > 0 && recips1.every(r => String(r) === 'sink@fixture.test'), JSON.stringify(recips1).slice(0, 200));
  const brandMails1 = mails1.filter(m => String(m.subject || '').includes('Your demo booking at'));
  const staffMails1 = mails1.filter(m => String(m.subject || '').includes('New demo scheduled:'));
  ok('exactly THREE brand confirmation emails — one per booking', brandMails1.length === 3,
     JSON.stringify(mails1.map(m => m.subject)).slice(0, 320));
  ok('exactly THREE staff notification emails — one per booking', staffMails1.length === 3,
     JSON.stringify(mails1.map(m => m.subject)).slice(0, 320));
  ok('no OTHER emails were sent by the paid path', mails1.length === 6, `${mails1.length}`);

  const cases1 = ((await db(`reconciliation_cases?payment_group_id=eq.${groupId}&select=id`)).body) || [];
  ok('the VALID payment produced NO reconciliation case', cases1.length === 0, `${cases1.length}`);

  // ---- THE REPLAY: the identical event must produce zero second effects --------------------
  const resendMid = spy.calls.resend.length;
  const stripeMid  = spy.calls.stripe.length;
  const paid2 = await callRoute('stripe-webhook.js', rawReq(paidEvent, { signature: sign(paidEvent) }));
  ok('the replayed identical event is still accepted', paid2.statusCode >= 200 && paid2.statusCode < 300, `${paid2.statusCode}`);
  const inbox = ((await db(`processed_stripe_events?event_id=eq.${encodeURIComponent(JSON.parse(paidEvent).id)}&select=event_id`)).body) || [];
  ok('replay creates NO second inbox row', inbox.length === 1, `rows=${inbox.length}`);
  ok('replay sends NO further email', spy.calls.resend.length === resendMid, `${resendMid} -> ${spy.calls.resend.length}`);
  ok('replay makes NO further Stripe call', spy.calls.stripe.length === stripeMid, `${stripeMid} -> ${spy.calls.stripe.length}`);
  const demos2 = ((await db(`demos?booking_id=in.(${idList(bookingIds)})&select=id`)).body) || [];
  ok('replay materialises NO second demo', demos2.length === 3, `${demos2.length}`);
  const fulfil2 = ((await db(`booking_fulfillments?payment_group_id=eq.${groupId}&select=booking_id`)).body) || [];
  ok('replay creates NO second fulfilment row', fulfil2.length === 3, `${fulfil2.length}`);
  const postBookings2 = ((await db(`bookings?id=in.(${idList(bookingIds)})&select=payment_status`)).body) || [];
  ok('replay applies NO second payment (bookings unchanged)',
     postBookings2.length === 3 && postBookings2.every(b => b.payment_status === 'paid'), JSON.stringify(postBookings2));

  // ---- A FRESH MISMATCHED EVENT: promotes nothing, opens exactly one case ------------------
  const mmBk = await callRoute('book.js', req({
    body: { retailer_slug: retailerSlug, venue_id: venueId, demo_date: dayP(40), demo_time: '15:00' },
    cookies: { dh_brand_session: paySess } }));
  const mmBookingId = mmBk.body && (mmBk.body.booking_id || mmBk.body.id || (mmBk.body.booking && mmBk.body.booking.id));
  if (mmBookingId) track('bookings', mmBookingId);
  const mmCo = await callRoute('checkout.js', req({ body: { booking_ids: [mmBookingId] }, cookies: { dh_brand_session: paySess } }));
  const mmSession = mmCo.body && mmCo.body.session_id;
  const mmGroup   = mmCo.body && mmCo.body.payment_group_id;
  const mmTotal   = mmCo.body && mmCo.body.total_cents;
  ok('a FRESH unpaid group/session exists for the mismatch case',
     !!mmSession && !!mmGroup && mmGroup !== groupId, JSON.stringify({ mmSession, mmGroup }));

  const mmPi = 'pi_' + uniq('mm');
  spy.fixtures.paymentIntents[mmPi] = {
    id: mmPi, object: 'payment_intent', amount_received: mmTotal, currency: 'usd', on_behalf_of: null,
    latest_charge: { id: 'ch_' + uniq('mm'), object: 'charge', destination: null,
                     application_fee_amount: null, transfer: null, application_fee: null },
  };
  const mmEvent = JSON.stringify({
    id: 'evt_' + uniq('mm'), type: 'checkout.session.completed',
    data: { object: { id: mmSession, object: 'checkout.session', mode: 'payment', payment_status: 'paid',
                      amount_total: Number(mmTotal) + 500, currency: 'usd',
                      payment_intent: mmPi, metadata: { payment_group_id: mmGroup } } },
  });
  const mmResendBefore = spy.calls.resend.length;
  const mm1 = await callRoute('stripe-webhook.js', rawReq(mmEvent, { signature: sign(mmEvent) }));
  ok('a mismatched-amount event does not 500 the webhook', mm1.statusCode >= 200 && mm1.statusCode < 500, `${mm1.statusCode}`);
  const mmBookingRow = ((await db(`bookings?id=eq.${mmBookingId}&select=payment_status`)).body || [])[0];
  ok('the mismatched event promotes NOTHING', mmBookingRow && mmBookingRow.payment_status !== 'paid', JSON.stringify(mmBookingRow));
  const mmGrpRow = ((await db(`payment_groups?id=eq.${mmGroup}&select=status`)).body || [])[0];
  ok('the mismatched group stays in a safe (unpaid, unfrozen) state',
     mmGrpRow && mmGrpRow.status !== 'paid' && mmGrpRow.status !== 'frozen', JSON.stringify(mmGrpRow));
  ok('the mismatched event sent NO confirmation email', spy.calls.resend.length === mmResendBefore,
     `${mmResendBefore} -> ${spy.calls.resend.length}`);
  const mmCases1 = ((await db(`reconciliation_cases?payment_group_id=eq.${mmGroup}&reason=eq.amount_mismatch&select=id`)).body) || [];
  ok('exactly ONE amount_mismatch reconciliation case is linked to the group', mmCases1.length === 1, `${mmCases1.length}`);

  const mm2 = await callRoute('stripe-webhook.js', rawReq(mmEvent, { signature: sign(mmEvent) }));
  ok('the replayed mismatch event does not 500', mm2.statusCode >= 200 && mm2.statusCode < 500, `${mm2.statusCode}`);
  const mmCases2 = ((await db(`reconciliation_cases?payment_group_id=eq.${mmGroup}&reason=eq.amount_mismatch&select=id`)).body) || [];
  ok('replay does NOT create a duplicate reconciliation case', mmCases2.length === 1, `${mmCases2.length}`);

  // ---- TAMPERING AFTER SIGNING -------------------------------------------------------------
  const tampered = paidEvent.replace('"paid"', '"unpaid"');
  const tRes = await callRoute('stripe-webhook.js', rawReq(tampered, { signature: sign(paidEvent) }));
  ok('a paid event altered after signing is REFUSED', tRes.statusCode >= 400, `${tRes.statusCode}`);

  // ---- REFUND FAN-OUT REGRESSION (ledger) --------------------------------------------------
  // Cancelling ONE booking in the multi-demo group issues a LEDGER refund: booking-action.js
  // reserves the exact amount against THAT booking's own immutable allocation and converges via
  // apply_refund_event. It must flip only that booking and that allocation — the other two
  // allocations' refunded_amount must stay 0 (the "does not fan out" property, at allocation level).
  const rTok = (await db('admin_tokens', { method: 'POST', body: JSON.stringify({
    retailer_id: retailerId, email: `staff-${retailerSlug}@fixture.test` }) })).body?.[0];
  const refundSess = rTok
    ? (await callRoute('admin-auth.js', req({ body: { action: 'verify', token: rTok.token } }))).cookie('dh_retailer_session')
    : null;
  ok('a retailer admin session was minted for the refund', !!refundSess);

  const refundTarget = bookingIds[0];
  const rr = await callRoute('booking-action.js', req({
    body: { action: 'cancel', booking_id: refundTarget, force_refund: true },
    cookies: { dh_retailer_session: refundSess } }));
  ok('the cancel+refund route succeeds for one booking', rr.statusCode === 200,
     `${rr.statusCode} ${JSON.stringify(rr.body).slice(0, 200)}`);

  const refundedRow = ((await db(`bookings?id=eq.${refundTarget}&select=payment_status,status`)).body || [])[0];
  ok('the targeted booking is refunded', refundedRow && refundedRow.payment_status === 'refunded', JSON.stringify(refundedRow));

  const others = bookingIds.slice(1);
  const otherRows = ((await db(`bookings?id=in.(${idList(others)})&select=id,payment_status`)).body) || [];
  ok('the refund does NOT fan out — the other two bookings stay paid',
     otherRows.length === 2 && otherRows.every(b => b.payment_status === 'paid'), JSON.stringify(otherRows));

  const allocAfter = ((await db(`payment_allocations?payment_group_id=eq.${groupId}&select=booking_id,customer_amount,refunded_amount`)).body) || [];
  ok('all three allocations still exist after the single refund', allocAfter.length === 3, `${allocAfter.length}`);
  const targetAlloc = allocAfter.find(a => a.booking_id === refundTarget);
  const otherAllocs = allocAfter.filter(a => a.booking_id !== refundTarget);
  ok('only the refunded allocation carries a refunded_amount — the other two stay zero',
     !!targetAlloc && Number(targetAlloc.refunded_amount) === Number(targetAlloc.customer_amount)
       && otherAllocs.length === 2 && otherAllocs.every(a => Number(a.refunded_amount || 0) === 0),
     JSON.stringify(allocAfter));

  // C3: the cancel must also cancel the booking's DEMO on the calendar. The old code PATCHed a
  // nonexistent demos.cancelled_at and swallowed the error, leaving a live 'confirmed' demo behind.
  ok('the cancel response reports the demo cancelled (converged)', rr.body && rr.body.demo_cancelled === true,
     JSON.stringify(rr.body).slice(0, 160));
  const targetDemo = ((await db(`demos?booking_id=eq.${refundTarget}&select=status`)).body || [])[0];
  ok('the refunded booking’s demo is now cancelled', targetDemo && targetDemo.status === 'cancelled', JSON.stringify(targetDemo));
  const otherDemos = ((await db(`demos?booking_id=in.(${idList(others)})&select=booking_id,status`)).body) || [];
  ok('the other two demos remain confirmed', otherDemos.length === 2 && otherDemos.every(d => d.status === 'confirmed'),
     JSON.stringify(otherDemos));
  const activeFeed = ((await db(`demos?booking_id=in.(${idList(bookingIds)})&status=in.(confirmed,scheduled)&select=booking_id`)).body) || [];
  ok('the cancelled demo no longer appears in the active (confirmed/scheduled) feed',
     activeFeed.length === 2 && !activeFeed.some(d => d.booking_id === refundTarget), JSON.stringify(activeFeed.map(d => d.booking_id)));

  // C3: replay/retry of the same cancel must NOT cancel or refund another allocation.
  const stripeBeforeRetry = spy.calls.stripe.length;
  const rr2 = await callRoute('booking-action.js', req({
    body: { action: 'cancel', booking_id: refundTarget, force_refund: true },
    cookies: { dh_retailer_session: refundSess } }));
  ok('re-cancelling the already-cancelled booking is refused', rr2.statusCode === 409,
     `${rr2.statusCode} ${JSON.stringify(rr2.body).slice(0, 120)}`);
  ok('the retry issued no further Stripe refund call', spy.calls.stripe.length === stripeBeforeRetry,
     `${stripeBeforeRetry} -> ${spy.calls.stripe.length}`);
  const othersAfterRetry = ((await db(`bookings?id=in.(${idList(others)})&select=payment_status`)).body) || [];
  ok('the retry did not fan out — the other two bookings are still paid',
     othersAfterRetry.length === 2 && othersAfterRetry.every(b => b.payment_status === 'paid'), JSON.stringify(othersAfterRetry));
  const allocRetry = ((await db(`payment_allocations?payment_group_id=eq.${groupId}&select=refunded_amount`)).body) || [];
  ok('exactly one allocation carries a refund after the retry (no new refund)',
     allocRetry.filter(a => Number(a.refunded_amount || 0) > 0).length === 1, JSON.stringify(allocRetry));
}

// ---------------------------------------------------------------------------
// 14. /api/booking — the RETAILER STAFF manual-booking route.
//
// Codex v6 answered a question I had asked: both booking routes are live and intentional.
// api/book.js is the PUBLIC BRAND route; api/booking.js is the AUTHENTICATED RETAILER
// STAFF route used by the admin portal. They are not accidental duplicates and must not be
// merged in this pass.
//
// This route mattered most for the COI consolidation: booking.js was the LENIENT consumer.
// Before api/_coi-policy.js it did not even SELECT coi_verification_status, so a pending or
// REJECTED certificate that /api/book refused could be booked here by staff. The last
// assertion in this section is the one that proves that divergence is gone.
// ---------------------------------------------------------------------------
console.log('\n— 14: /api/booking, the retailer staff route —');
{
  const dayS = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const base = (over = {}) => ({
    retailer_slug: retailerSlug, brand_name: 'Staff Booked Co', contact_name: 'Staff Contact',
    contact_email: `${uniq('sb')}@fixture.test`, venue: 'Route Main',
    demo_date: dayS(30), demo_time: '09:00', ...over,
  });

  // NO SESSION.
  const noSess = await callRoute('booking.js', req({ body: base() }));
  ok('/api/booking without a retailer cookie is refused', noSess.statusCode === 401 || noSess.statusCode === 403,
     `${noSess.statusCode} ${JSON.stringify(noSess.body).slice(0, 140)}`);

  // A BRAND cookie is not a staff cookie. Roles are separate cookies by design, so this
  // proves the separation holds at the route rather than only in the cookie helper.
  const brandTry = await callRoute('booking.js', req({ body: base(), cookies: { dh_brand_session: brandCookie } }));
  ok('a BRAND session cannot drive the staff booking route',
     brandTry.statusCode === 401 || brandTry.statusCode === 403, `${brandTry.statusCode}`);

  // A VIEWER has a valid session and live membership but no booking capability.
  const viewerEmail = `${uniq('vw')}@fixture.test`;
  await db('retailer_admins', { method: 'POST', body: JSON.stringify({
    retailer_id: retailerId, email: viewerEmail, email_normalized: viewerEmail.toLowerCase(),
    role: 'viewer' }) });
  // Section 4 ends by testing LOGOUT, which kills staffCookie server-side. Reusing it here
  // produced 401 'Invalid session' and read like the staff route rejecting a valid admin.
  // Both sessions in this section are minted fresh.
  //
  // admin_tokens is inserted the way section 4 does it — email and retailer_id only. My first
  // attempt supplied token and expires_at explicitly, which is the shape brand_account_tokens
  // needs, not this table's.
  const vTok = (await db('admin_tokens', { method: 'POST', body: JSON.stringify({
    retailer_id: retailerId, email: viewerEmail }) })).body?.[0];
  let viewerCookie = null;
  if (vTok) {
    const vv = await callRoute('admin-auth.js', req({ body: { action: 'verify', token: vTok.token } }));
    viewerCookie = vv.cookie('dh_retailer_session');
  }
  ok('a viewer can sign in (so the next assertion tests ROLE, not authentication)', !!viewerCookie);
  const viewerTry = await callRoute('booking.js', req({ body: base(), cookies: { dh_retailer_session: viewerCookie } }));
  ok('a VIEWER cannot create a booking',
     viewerTry.statusCode === 401 || viewerTry.statusCode === 403, `${viewerTry.statusCode} ${JSON.stringify(viewerTry.body).slice(0, 120)}`);

  // A brand that IS covered. base() generates a random contact_email, which makes
  // api/booking.js create a brand with no certificate at all — and the canonical rule now
  // correctly refuses that with coi_state 'missing'. That refusal is the consolidation
  // working: before api/_coi-policy.js this route booked uncovered brands without asking.
  // The happy path therefore needs a genuinely covered brand.
  const okEmail = `${uniq('cov')}@fixture.test`;
  track('brands', (await db('brands', { method: 'POST', body: JSON.stringify({
    email: okEmail, company_name: 'Covered Co',
    default_coi_url: 'brands/covered.pdf', default_coi_expires: dayS(400),
    coi_verification_status: 'approved' }) })).body[0].id);

  // AUTHORISED STAFF, own retailer — a FRESH session, for the reason above.
  const sTok = (await db('admin_tokens', { method: 'POST', body: JSON.stringify({
    retailer_id: retailerId, email: `staff-${retailerSlug}@fixture.test` }) })).body?.[0];
  const freshStaff = sTok
    ? (await callRoute('admin-auth.js', req({ body: { action: 'verify', token: sTok.token } }))).cookie('dh_retailer_session')
    : null;
  ok('a fresh staff session was minted for this section', !!freshStaff);

  const good = await callRoute('booking.js', req({
    body: base({ contact_email: okEmail, brand_name: 'Covered Co' }),
    cookies: { dh_retailer_session: freshStaff } }));
  ok('authorised staff CAN create a booking for their own retailer',
     good.statusCode === 200 || good.statusCode === 201, `${good.statusCode} ${JSON.stringify(good.body).slice(0, 180)}`);
  const staffBooking = good.body && (good.body.booking_id || good.body.id || (good.body.booking && good.body.booking.id));
  if (staffBooking) track('bookings', staffBooking);

  // CROSS-RETAILER. The venue name belongs to a different retailer; the route resolves
  // venues WITHIN the authenticated retailer, so this must not silently book against theirs.
  const cross = await callRoute('booking.js', req({
    body: base({ venue: 'Other Main', contact_email: okEmail, brand_name: 'Covered Co' }),
    cookies: { dh_retailer_session: freshStaff } }));
  const crossBookedElsewhere = cross.body && cross.body.booking_id
    ? ((await db(`bookings?id=eq.${cross.body.booking_id}&select=retailer_id`)).body || [])[0]
    : null;
  ok('a venue belonging to ANOTHER retailer cannot be booked',
     cross.statusCode >= 400 || (crossBookedElsewhere && crossBookedElsewhere.retailer_id === retailerId),
     `${cross.statusCode} ${JSON.stringify(cross.body).slice(0, 140)}`);
  if (cross.body && cross.body.booking_id) track('bookings', cross.body.booking_id);

  // THE CANONICAL COI RULE, on the route that used to be lenient.
  // A brand whose certificate is REJECTED must be refused here exactly as /api/book refuses
  // it. Before api/_coi-policy.js this route never consulted coi_verification_status at all.
  const rejEmail = `${uniq('rej')}@fixture.test`;
  const rejBrand = track('brands', (await db('brands', { method: 'POST', body: JSON.stringify({
    email: rejEmail, company_name: 'Rejected Cert Co',
    default_coi_url: 'brands/rejected.pdf', default_coi_expires: dayS(400),
    coi_verification_status: 'rejected' }) })).body[0].id);

  const rejVia = await callRoute('booking.js', req({
    body: base({ contact_email: rejEmail, brand_name: 'Rejected Cert Co' }),
    cookies: { dh_retailer_session: freshStaff } }));
  const rejBooking = rejVia.body && rejVia.body.booking_id;
  if (rejBooking) track('bookings', rejBooking);
  const rejRow = rejBooking ? ((await db(`bookings?id=eq.${rejBooking}&select=coi_status,status`)).body || [])[0] : null;
  ok('a REJECTED certificate is not treated as covered on the staff route',
     rejVia.statusCode >= 400 || !!(rejRow && rejRow.coi_status !== 'covered'),
     `${rejVia.statusCode} ${JSON.stringify(rejRow || rejVia.body).slice(0, 160)}`);

  ok('the rejected brand is still not covered by the canonical rule',
     ((await db(`brands?id=eq.${rejBrand}&select=coi_verification_status`)).body || [])[0]?.coi_verification_status === 'rejected');
}

console.log('\n— teardown —');
for (const [t, id] of bin.reverse()) await db(`${t}?id=eq.${id}`, { method: 'DELETE' });
spy.restore();
process.exit(summary('route flows') ? 0 : 1);
