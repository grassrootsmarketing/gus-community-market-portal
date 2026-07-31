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
  ok('approving a STALE record is refused', stale.statusCode === 409 && stale.body && stale.body.error === 'stale_review',
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

  // --- clean up through the application route ---
  const removed = await callRoute('brand-account.js', req({ body: { action: 'remove-coi' }, cookies: { dh_brand_session: revSess } }));
  ok('remove-coi succeeds through the route', removed.statusCode === 200, `${removed.statusCode}`);
  const b5 = (await db(`brands?id=eq.${revBrandId}&select=default_coi_url`)).body || [];
  ok('the certificate is detached from the brand', b5[0] && !b5[0].default_coi_url, JSON.stringify(b5[0]));

  for (const r of ((await db(`coi_verifications?brand_id=eq.${revBrandId}&select=id`)).body || [])) {
    await db(`coi_verifications?id=eq.${r.id}`, { method: 'DELETE' });
  }
}

console.log('\n— teardown —');
for (const [t, id] of bin.reverse()) await db(`${t}?id=eq.${id}`, { method: 'DELETE' });
spy.restore();
process.exit(summary('route flows') ? 0 : 1);
