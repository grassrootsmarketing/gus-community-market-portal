// tests/claim_reuse.test.mjs (2026-10-31, Codex connected checkout round 5, R4-1): checkout_claim_group (0119) validates a
// REUSED payment group as carefully as a new one, under the booking row locks, and the route refuses before any Stripe call.
//
// The lifecycle these scenarios follow: a checkout creates the group, its allocations and ONE open payment attempt
// (register_payment_attempt allows one open attempt per group, so a retry while the first session is still open is
// 409 attempt_in_progress); when the Checkout Session expires, the webhook's checkout.session.expired marks the attempt
// expired and reopens the group (expire_payment_attempt), and the next checkout REUSES the group and its immutable
// allocations with a fresh session. That reuse is what 0119 validates.
//
// Routes (demohub-rebuild-check, Stripe spied), at a keeps-all store and at a connected store (CONNECTED_CHECKOUT_ENABLED on):
//   an existing group whose booking is then cancelled (direct write of the lifecycle's effect, and for a held booking the
//   store's real cancel route), expired (the sweep's write), authorized (the authorization's write) or paid (the payment's
//   write): the retry is refused 409 not_payable_state with NO Stripe call, the group and its allocation untouched; a valid
//   immediate-charge retry and a valid manual-capture retry (after the first session expired) each reuse exactly one group
//   and one allocation set with a fresh session; a retry while the first session is still open is 409 attempt_in_progress
//   with nothing else written; a six-argument caller (no p_provisional) still reuses, with no capture-mode assertion.
// Database (two direct connections, an EXISTING group): a cancellation held open, the reuse waits and then sees it
//   (not_payable_state); the reverse order, the cancellation waits for the reuse and then lands, no deadlock, one allocation
//   set, no second group; an authorized hold's reuse is refused as not payable; the existing new-group races in
//   tests/held_promotion.test.mjs are unchanged and still run.
import pg from 'pg';
import { createHmac, randomUUID } from 'node:crypto';
import { installSpy, callRoute, req, rawReq, ok, summary, uniq, ENV, FIXTURE_PRODUCTS } from './_route.mjs';
import { HOURLY } from './_fixture_availability.mjs';
import { teardownRetailerFixtures } from './_teardown.mjs';

const SB = process.env.SB_URL, KEY = process.env.SB_KEY, DBURL = process.env.SB_DB_URL;
const TEST_REF = 'tileejdviuvijumjeplv';
if (!SB || !KEY || !SB.includes(TEST_REF)) { console.log('  FAIL SB_URL / SB_KEY must name demohub-rebuild-check'); process.exit(1); }
if (!DBURL || !DBURL.includes(TEST_REF)) { console.log('  FAIL SB_DB_URL must name demohub-rebuild-check (the race scenarios need a direct connection)'); process.exit(1); }
for (const ref of ['dkgjvsstbgnhcfboqqnd', 'ecapmcyumpjjgjwuokyv', 'eubbgurdwqmwqduamwhn']) if (DBURL.includes(ref) || SB.includes(ref)) { console.log('  FAIL REFUSING: production or retired project'); process.exit(1); }
const watchdog = setTimeout(() => { console.log('  FAIL watchdog: suite exceeded 8 minutes'); process.exit(1); }, 8 * 60 * 1000);

const spy = installSpy();
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j, text: t }; };
const rpc = async (fn, args) => { const r = await fetch(`${SB}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H, body: JSON.stringify(args) }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j, text: t }; };
const one = (r) => (r && Array.isArray(r.body) ? r.body[0] : null);
const LA = 'America/Los_Angeles';
function dayP(n) { const d = new Date(Date.now() + n * 864e5); const p = {}; for (const x of new Intl.DateTimeFormat('en-US', { timeZone: LA, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)) p[x.type] = p[x.type] || x.value; return `${p.year}-${p.month}-${p.day}`; }
const formOf = (body) => Object.fromEntries(new URLSearchParams(String(body || '')));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const capture = (p) => p.then(r => ({ ok: true, r }), e => ({ ok: false, e }));
const sign = (payload, secret = 'whsec_harness') => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`; };
ENV.PROVISIONAL_HOLDS_ENABLED = 'true';
ENV.CONNECTED_CHECKOUT_ENABLED = 'true';
const ACCT = 'acct_reuse_' + uniq('x').replace(/-/g, '');
const CATALOG = [{ id: 'cat-1', ...FIXTURE_PRODUCTS[0] }];
// the spied Stripe (tests/_route.mjs) answers a Checkout Session create like the provider: the same Idempotency-Key replays the same session

console.log('\nFixtures');
async function mkRetailer(prefix, connected) {
  const slug = uniq(prefix);
  const id = one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug, name: connected ? 'Reuse Connected Market' : 'Reuse Keeps-all Market', billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active',
    platform_keeps_all: !connected, stripe_account_id: connected ? ACCT : null, stripe_charges_enabled: connected, stripe_payouts_enabled: connected, stripe_account_status: connected ? 'active' : null, timezone: LA, auto_confirm_bookings: true, cancellation_mode: 'refundable', verification_status: 'approved' }) })).id;
  await db('settings', { method: 'POST', body: JSON.stringify({ retailer_id: id, demo_fee: 150, advance_booking_days: 0 }) });
  const venue = one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: id, name: 'Main', address: '1 Reuse St', demo_fee: 150, availability: HOURLY }) })).id;
  const staffEmail = `staff-${slug}@fixture.test`;
  await db('retailer_admins', { method: 'POST', body: JSON.stringify({ retailer_id: id, email: staffEmail, email_normalized: staffEmail, name: 'Reuse Staff', role: 'admin' }) });
  const tok = one(await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: staffEmail, retailer_id: id }) }));
  const cookie = (await callRoute('admin-auth.js', req({ body: { action: 'verify', token: tok.token } }))).cookie('dh_retailer_session');
  return { id, slug, venue, cookie, connected };
}
const K = await mkRetailer('rsk', false), C = await mkRetailer('rsc', true);
const brandIds = [];
async function mkBrand(label, { coi }) {
  const email = `${uniq(label)}@fixture.test`;
  const body = { email, company_name: label + ' Brand', contact_name: label + ' Contact', phone: '555-0171', is_verified: true, products: CATALOG };
  if (coi) Object.assign(body, { default_coi_url: `brands/${label}.pdf`, default_coi_expires: dayP(400), coi_verification_status: 'approved' });
  const id = one(await db('brands', { method: 'POST', body: JSON.stringify(body) })).id;
  brandIds.push(id);
  const tok = one(await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: id, email, token: 'tk-' + uniq('t'), expires_at: new Date(Date.now() + 36e5).toISOString() }) }));
  const cookie = (await callRoute('brand-account.js', req({ body: { action: 'verify', token: tok.token } }))).cookie('dh_brand_session');
  if (!cookie) throw new Error('no session for ' + label);
  return { id, email, cookie };
}
async function signAgreement(brand, store) {
  const chk = await callRoute('booking.js', req({ body: { action: 'agreement-check', retailer_slug: store.slug }, cookies: { dh_brand_session: brand.cookie } }));
  const hash = chk.body && chk.body.policies && chk.body.policies.policy_hash;
  const sg = await callRoute('booking.js', req({ body: { action: 'agreement-sign', retailer_slug: store.slug, signed_name: 'Fixture Owner', policy_hash: hash }, cookies: { dh_brand_session: brand.cookie } }));
  if (sg.statusCode !== 200) throw new Error('agreement-sign ' + sg.statusCode + ' ' + JSON.stringify(sg.body).slice(0, 160));
}
const A = await mkBrand('alpha', { coi: true }), B = await mkBrand('beta', { coi: false });
for (const brand of [A, B]) for (const store of [K, C]) await signAgreement(brand, store);
let dayN = 30;
async function bookAs(cookie, store) {
  const bk = await callRoute('book.js', req({ body: { retailer_slug: store.slug, venue_id: store.venue, demo_date: dayP(dayN++), demo_time: '13:00', product_skus: [CATALOG[0]], op_key: ('op-' + uniq('k')).replace(/[^A-Za-z0-9_-]/g, '') }, cookies: { dh_brand_session: cookie } }));
  const id = bk.body && (bk.body.booking_id || bk.body.id || (bk.body.booking && bk.body.booking.id));
  if (!id) throw new Error('book failed ' + bk.statusCode + ' ' + JSON.stringify(bk.body).slice(0, 200));
  return id;
}
const stateOf = async (id) => one(await db(`bookings?id=eq.${id}&select=status,payment_status,held_expires_at,payment_intent_id`));
const allocsOf = async (id) => (await db(`payment_allocations?booking_id=eq.${id}&select=id,payment_group_id,customer_amount,platform_fee_amount`)).body || [];
const groupOf = async (gid) => one(await db(`payment_groups?id=eq.${gid}&select=id,status,total_customer_amount,stripe_checkout_session_id`));
const attemptsOf = async (gid) => (await db(`payment_attempts?payment_group_id=eq.${gid}&select=id,status,stripe_checkout_session_id&order=created_at.asc`)).body || [];
async function checkoutAs(ids, cookie) {
  const before = spy.calls.stripe.length;
  const res = await callRoute('checkout.js', req({ body: { booking_ids: ids }, cookies: { dh_brand_session: cookie } }));
  const made = spy.calls.stripe.slice(before);
  const session = made.find(c => String(c.method).toUpperCase() === 'POST' && /\/checkout\/sessions$/.test(c.url.replace(/\?.*$/, '')));
  return { res, stripeCalls: made.length, request: session ? formOf(session.body) : null };
}
// the lifecycle's own way out of an open attempt: Stripe's checkout.session.expired through the webhook route
async function expireSession(sid, gid) {
  const raw = JSON.stringify({ id: 'evt_' + uniq('x'), type: 'checkout.session.expired', data: { object: { id: sid, object: 'checkout.session', mode: 'payment', status: 'expired', payment_status: 'unpaid', metadata: { payment_group_id: gid } } } });
  const w = await callRoute('stripe-webhook.js', rawReq(raw, { signature: sign(raw) }));
  if (w.statusCode !== 200) throw new Error('expired event ' + w.statusCode + ' ' + JSON.stringify(w.body).slice(0, 160));
}
const cancelAs = (store, booking_id) => callRoute('booking-action.js', req({ body: { action: 'cancel', category: 'store_caused', booking_id }, cookies: { dh_retailer_session: store.cookie } }));
// an existing group whose first session has expired: the group is reopened (pending), its allocation kept
async function existingGroup(bookingId, cookie) {
  const first = await checkoutAs([bookingId], cookie);
  if (first.res.statusCode !== 200) throw new Error('first checkout ' + first.res.statusCode + ' ' + JSON.stringify(first.res.body).slice(0, 160));
  const gid = first.res.body.payment_group_id, sid = first.res.body.session_id;
  await expireSession(sid, gid);
  return { gid, sid, first, group: await groupOf(gid), allocs: await allocsOf(bookingId), attempts: await attemptsOf(gid) };
}
ok('fixtures: keeps-all store and connected store with staff sessions, brand A (approved COI), brand B (no COI)', !!K.id && !!C.id && !!K.cookie && !!C.cookie && !!A.cookie && !!B.cookie);

try {
  for (const store of [K, C]) {
    const label = store === K ? 'keeps-all store' : 'connected store';
    console.log(`\nR4-1 through the route at the ${label}: an existing (reopened) group, then a non-payable booking`);
    {
      const b1 = await bookAs(A.cookie, store);
      const g = await existingGroup(b1, A.cookie);
      ok(`${label}: the first checkout made the group; after its session expired the group is pending again with its one allocation and one expired attempt`, g.group.status === 'pending' && g.allocs.length === 1 && g.attempts.length === 1 && g.attempts[0].status === 'expired', JSON.stringify({ g: g.group.status, a: g.allocs.length, att: g.attempts.map(x => x.status) }));
      // cancelled: the lifecycle's effect written directly (the store's cancel route only takes pending, confirmed or held bookings)
      await db(`bookings?id=eq.${b1}`, { method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }) });
      const g0 = await groupOf(g.gid), a0 = await allocsOf(b1);
      const retry = await checkoutAs([b1], A.cookie);
      ok(`${label}: the retry on the cancelled booking is refused 409 not_payable_state with NO Stripe call`, retry.res.statusCode === 409 && retry.res.body.error === 'not_payable_state' && retry.stripeCalls === 0, `${retry.res.statusCode} ${JSON.stringify(retry.res.body)} stripe ${retry.stripeCalls}`);
      ok(`${label}: the existing group, its allocation and its attempts are untouched (no new attempt, no new session)`, JSON.stringify(await groupOf(g.gid)) === JSON.stringify(g0) && JSON.stringify(await allocsOf(b1)) === JSON.stringify(a0) && a0.length === 1 && (await attemptsOf(g.gid)).length === 1);
    }
    {
      // paid (the payment's write: payment_status paid, status pending)
      const b2 = await bookAs(A.cookie, store);
      const g = await existingGroup(b2, A.cookie);
      await db(`bookings?id=eq.${b2}`, { method: 'PATCH', body: JSON.stringify({ status: 'pending', payment_status: 'paid', payment_intent_id: 'pi_paid_' + uniq('p').replace(/-/g, '') }) });
      const g0 = await groupOf(g.gid);
      const retry = await checkoutAs([b2], A.cookie);
      ok(`${label}: a booking already paid (payment_status paid) is refused 409 not_payable_state, no Stripe call, group untouched, no new attempt`, retry.res.statusCode === 409 && retry.res.body.error === 'not_payable_state' && retry.stripeCalls === 0 && JSON.stringify(await groupOf(g.gid)) === JSON.stringify(g0) && (await allocsOf(b2)).length === 1 && (await attemptsOf(g.gid)).length === 1, `${retry.res.statusCode} ${JSON.stringify(retry.res.body)}`);
    }
    {
      // expired (the sweep's write, status expired)
      const b3 = await bookAs(A.cookie, store);
      const g = await existingGroup(b3, A.cookie);
      await db(`bookings?id=eq.${b3}`, { method: 'PATCH', body: JSON.stringify({ status: 'expired' }) });
      const g0 = await groupOf(g.gid);
      const retry = await checkoutAs([b3], A.cookie);
      ok(`${label}: an expired booking's retry is refused 409 not_payable_state (not read as "not held, so immediate"), no Stripe call, group untouched`, retry.res.statusCode === 409 && retry.res.body.error === 'not_payable_state' && retry.stripeCalls === 0 && JSON.stringify(await groupOf(g.gid)) === JSON.stringify(g0) && (await attemptsOf(g.gid)).length === 1, `${retry.res.statusCode} ${JSON.stringify(retry.res.body)}`);
    }
    if (store === K) {
      // authorized (the authorization's write) and a cancelled HELD booking through the store's real cancel route
      const h1 = await bookAs(B.cookie, store);
      const g = await existingGroup(h1, B.cookie);
      ok(`${label}: an uncovered hold checked out with manual capture; after its session expired the group is pending with one allocation`, g.first.request && g.first.request['payment_intent_data[capture_method]'] === 'manual' && g.group.status === 'pending' && g.allocs.length === 1, JSON.stringify({ g: g.group.status }));
      await db(`bookings?id=eq.${h1}`, { method: 'PATCH', body: JSON.stringify({ payment_status: 'authorized', payment_intent_id: 'pi_auth_' + uniq('a').replace(/-/g, '') }) });
      const g0 = await groupOf(g.gid);
      const retry = await checkoutAs([h1], B.cookie);
      ok(`${label}: an authorized hold's retry is refused 409 not_payable_state, no Stripe call, group untouched`, retry.res.statusCode === 409 && retry.res.body.error === 'not_payable_state' && retry.stripeCalls === 0 && JSON.stringify(await groupOf(g.gid)) === JSON.stringify(g0) && (await attemptsOf(g.gid)).length === 1, `${retry.res.statusCode} ${JSON.stringify(retry.res.body)}`);

      const h2 = await bookAs(B.cookie, store);
      const g2 = await existingGroup(h2, B.cookie);
      const cancelled = await cancelAs(store, h2);
      const st = await stateOf(h2);
      ok(`${label}: the store cancels the unpaid HELD booking through its real route (200, status cancelled, still unpaid)`, cancelled.statusCode === 200 && st.status === 'cancelled' && st.payment_status === 'unpaid', `${cancelled.statusCode} ${JSON.stringify(cancelled.body).slice(0, 120)} ${JSON.stringify(st)}`);
      const retry2 = await checkoutAs([h2], B.cookie);
      ok(`${label}: the retry on the route-cancelled hold is refused 409 not_payable_state with no Stripe call; one allocation, one attempt`, retry2.res.statusCode === 409 && retry2.res.body.error === 'not_payable_state' && retry2.stripeCalls === 0 && (await allocsOf(h2)).length === 1 && (await attemptsOf(g2.gid)).length === 1, `${retry2.res.statusCode} ${JSON.stringify(retry2.res.body)}`);
    }

    console.log(`\nR4-1 at the ${label}: valid retries reuse exactly one group and allocation set`);
    {
      const b4 = await bookAs(A.cookie, store);
      const r1 = await checkoutAs([b4], A.cookie);
      const gid = r1.res.body && r1.res.body.payment_group_id, sid1 = r1.res.body && r1.res.body.session_id;
      // while the first session is still open: one open attempt per group, so the retry is refused and nothing else is written
      const open = await checkoutAs([b4], A.cookie);
      ok(`${label}: a retry while the first session is open is 409 attempt_in_progress; the group, its allocation and its single open attempt are untouched`, r1.res.statusCode === 200 && open.res.statusCode === 409 && open.res.body.error === 'attempt_in_progress' && (await allocsOf(b4)).length === 1 && (await attemptsOf(gid)).length === 1 && (await groupOf(gid)).status === 'session_created', `${open.res.statusCode} ${JSON.stringify(open.res.body)}`);
      await expireSession(sid1, gid);
      const r2 = await checkoutAs([b4], A.cookie);
      const atts = await attemptsOf(gid);
      ok(`${label}: after the session expired, the retry reuses the group (same payment_group_id, 200, a fresh session), one allocation, attempts: one expired and one open, no manual capture`, r2.res.statusCode === 200 && r2.res.body.payment_group_id === gid && r2.res.body.session_id && r2.res.body.session_id !== sid1 && (await allocsOf(b4)).length === 1 && atts.length === 2 && atts.map(a => a.status).sort().join(',') === 'expired,open' && r2.request && !r2.request['payment_intent_data[capture_method]'], JSON.stringify({ s: r2.res.statusCode, same: r2.res.body && r2.res.body.payment_group_id === gid, atts: atts.map(a => a.status) }));
      if (store === C) ok(`${label}: the fresh session is a destination charge to the store's account with the $10 fee`, r2.request['payment_intent_data[transfer_data][destination]'] === ACCT && r2.request['payment_intent_data[application_fee_amount]'] === '1000', JSON.stringify(Object.keys(r2.request).filter(k => /transfer_data|application_fee/.test(k))));
      // a six-argument caller (no p_provisional) still reuses, with no capture-mode assertion
      const six = await rpc('checkout_claim_group', { p_brand_id: A.id, p_retailer_id: store.id, p_booking_ids: [b4], p_platform_keeps_all: store === K, p_connect_account_id: store === K ? null : ACCT, p_platform_fee_cents: 1000 });
      const row = Array.isArray(six.body) ? six.body[0] : six.body;
      ok(`${label}: the six-argument call (older caller, p_provisional NULL) reuses the same group, reused = true`, six.ok && row && row.payment_group_id === gid && row.reused === true, `${six.status} ${JSON.stringify(six.body).slice(0, 160)}`);
    }
    if (store === K) {
      const h3 = await bookAs(B.cookie, store);
      const r1 = await checkoutAs([h3], B.cookie);
      const gid = r1.res.body.payment_group_id, sid1 = r1.res.body.session_id;
      await expireSession(sid1, gid);
      const r2 = await checkoutAs([h3], B.cookie);
      const atts = await attemptsOf(gid);
      ok(`${label}: a manual-capture retry of a held booking after its session expired reuses the group (same id, manual capture both times, one allocation, booking still held)`, r1.res.statusCode === 200 && r2.res.statusCode === 200 && r2.res.body.payment_group_id === gid && r1.request['payment_intent_data[capture_method]'] === 'manual' && r2.request['payment_intent_data[capture_method]'] === 'manual' && (await allocsOf(h3)).length === 1 && atts.length === 2 && (await stateOf(h3)).status === 'held', JSON.stringify({ a: r1.res.statusCode, b: r2.res.statusCode, atts: atts.map(a => a.status) }));
    }
  }

  // ---------------------------------------------------------------------------
  // Two connections, an EXISTING group
  // ---------------------------------------------------------------------------
  console.log('\nR4-1 at the database: the reuse decision and a cancellation serialize on the booking lock, both orders');
  const clients = [];
  async function connect(label) {
    const c = new pg.Client({ connectionString: DBURL, ssl: /sslmode=disable/i.test(DBURL) ? false : { rejectUnauthorized: false }, application_name: `reuse-${label}` });
    await c.connect(); await c.query(`SET lock_timeout = '30s'`); await c.query(`SET statement_timeout = '60s'`); clients.push(c); return c;
  }
  const c1 = await connect('one'), c2 = await connect('two');
  const claimSql = `SELECT * FROM checkout_claim_group($1::uuid, $2::uuid, $3::uuid[], $4::boolean, $5::text, 1000, $6::boolean)`;
  {
    // 1. cancellation held open, the reuse waits and then sees it
    const x1 = await bookAs(A.cookie, K);
    const g = await existingGroup(x1, A.cookie);
    await c1.query('BEGIN');
    await c1.query(`UPDATE bookings SET status = 'cancelled' WHERE id = $1::uuid`, [x1]);
    const pending = capture(c2.query(claimSql, [A.id, K.id, [x1], true, null, false]));
    const early = await Promise.race([pending.then(() => 'resolved'), sleep(400).then(() => 'waiting')]);
    await c1.query('COMMIT');
    const out = await pending;
    ok('1. the reuse waited for the open cancellation and, once it committed, was refused not_payable_state; one allocation, the group untouched', early === 'waiting' && !out.ok && /not_payable_state/.test(String(out.e && out.e.message)) && (await allocsOf(x1)).length === 1 && (await groupOf(g.gid)).status === 'pending', JSON.stringify({ early, err: String(out.e && out.e.message).slice(0, 80) }));
  }
  {
    // 2. the reverse order: the reuse holds the lock, the cancellation waits, then lands; no deadlock, no second group
    const x2 = await bookAs(A.cookie, K);
    const g = await existingGroup(x2, A.cookie);
    await c1.query('BEGIN');
    const reused = await c1.query(claimSql, [A.id, K.id, [x2], true, null, false]);
    const cancel = capture(c2.query(`UPDATE bookings SET status = 'cancelled' WHERE id = $1::uuid AND status = 'pending_payment'`, [x2]));
    const early = await Promise.race([cancel.then(() => 'resolved'), sleep(400).then(() => 'waiting')]);
    await c1.query('COMMIT');
    const out = await cancel;
    const groups = new Set((await allocsOf(x2)).map(a => a.payment_group_id));
    ok('2. the reuse returned the existing group (reused true) while the cancellation waited; after the commit the cancellation landed (1 row); one allocation, one group, no deadlock', reused.rows.length === 1 && reused.rows[0].reused === true && reused.rows[0].payment_group_id === g.gid && early === 'waiting' && out.ok && out.r.rowCount === 1 && (await stateOf(x2)).status === 'cancelled' && groups.size === 1 && groups.has(g.gid), JSON.stringify({ early, rowCount: out.ok && out.r.rowCount, err: out.e && String(out.e.message).slice(0, 80) }));
    const after = await capture(c2.query(claimSql, [A.id, K.id, [x2], true, null, false]));
    ok('2. a later reuse of that cancelled booking is refused not_payable_state and no new payment attempt exists', !after.ok && /not_payable_state/.test(String(after.e && after.e.message)) && (await attemptsOf(g.gid)).length === 1, String(after.e && after.e.message).slice(0, 80));
  }
  {
    // 3. an authorized hold: the reuse is refused as not payable, whichever capture mode the caller believes in
    const x3 = await bookAs(B.cookie, K);
    const g = await existingGroup(x3, B.cookie);
    await c1.query(`UPDATE bookings SET payment_status = 'authorized', payment_intent_id = $2 WHERE id = $1::uuid`, [x3, 'pi_auth_' + uniq('z').replace(/-/g, '')]);
    const asHold = await capture(c2.query(claimSql, [B.id, K.id, [x3], true, null, true]));
    const asImmediate = await capture(c2.query(claimSql, [B.id, K.id, [x3], true, null, false]));
    const asNull = await capture(c2.query(claimSql, [B.id, K.id, [x3], true, null, null]));
    ok('3. an authorized hold with an existing group: reuse refused not_payable_state for p_provisional true, false and NULL alike', !!g.gid && [asHold, asImmediate, asNull].every(r => !r.ok && /not_payable_state/.test(String(r.e && r.e.message))), JSON.stringify([asHold, asImmediate, asNull].map(r => String(r.e && r.e.message).slice(0, 40))));
  }
  {
    // 4. the lock is taken before any decision: a claim for a booking that does not exist, or of another brand, writes nothing
    const x4 = await bookAs(A.cookie, K);
    const missing = await capture(c1.query(claimSql, [A.id, K.id, [x4, randomUUID()], true, null, false]));
    const foreign = await capture(c1.query(claimSql, [B.id, K.id, [x4], true, null, false]));
    ok('4. an unknown id in the set is booking_set_mismatch and another brand\'s id is not_your_booking; nothing written', !missing.ok && /booking_set_mismatch/.test(String(missing.e && missing.e.message)) && !foreign.ok && /not_your_booking/.test(String(foreign.e && foreign.e.message)) && (await allocsOf(x4)).length === 0, JSON.stringify([String(missing.e && missing.e.message).slice(0, 40), String(foreign.e && foreign.e.message).slice(0, 40)]));
    const fresh = await capture(c1.query(claimSql, [A.id, K.id, [x4], true, null, false]));
    const again = await capture(c1.query(claimSql, [A.id, K.id, [x4], true, null, false]));
    ok('4. the new-group path still works and a second call reuses it', fresh.ok && fresh.r.rows[0].reused === false && again.ok && again.r.rows[0].reused === true && again.r.rows[0].payment_group_id === fresh.r.rows[0].payment_group_id && (await allocsOf(x4)).length === 1);
  }
  for (const c of clients) { try { await c.end(); } catch (_) {} }
} finally {
  clearTimeout(watchdog);
  spy.restore();
  try { console.log('\n:: teardown ::'); const counts = await teardownRetailerFixtures({ sbUrl: SB, sbKey: KEY, retailerIds: [K.id, C.id], brandIds, log: (m) => console.log(m) }); console.log('  teardown:', JSON.stringify(counts)); }
  catch (e) { console.log('  teardown failed (rows left on demohub-rebuild-check):', String((e && e.message) || e)); }
}
process.exit(summary('claim reuse validated (routes + database, demohub-rebuild-check)') ? 0 : 1);
