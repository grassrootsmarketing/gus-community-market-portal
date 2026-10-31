// tests/attempt_reservation.test.mjs (2026-10-31, Codex connected checkout round 7, "next action 2"): the checkout creates
// a Stripe Checkout Session only against a payment attempt the LEDGER reserved first (0120), under a key that names the
// reservation; nothing expired or unusable is ever registered as open or returned as a payment link.
//
// Through the real routes against demohub-rebuild-check, Stripe simulated by tests/_route.mjs (a create under a known
// Idempotency-Key replays the same session object, a test can turn a session expired through spy.sessions):
//   1. a retry while the first session is open: refused 409 attempt_in_progress, NO session created (one GET of the open
//      session only), one live attempt;
//   2. the open attempt's session expired on Stripe (never told to the ledger): the retry records it expired and hands
//      back a fresh session, never the dead one; attempts expired + open;
//   3. provider creation succeeds, the ledger write fails: 503, the reservation stays with no session; the retry reuses
//      the reservation's key, Stripe replays the same session, it is bound; one attempt, one session, no duplicate;
//   4. the replayed session is unusable (it expired between the failed write and the retry): recorded as the
//      reservation's terminal outcome with the session id, a new generation is reserved and created; the dead link is
//      never returned; attempts failed + open;
//   5. simultaneous retries: both callers get the same session (same reservation, same key); one live attempt;
//   6. the attempt read fails: 503 attempt_reserve_failed with NO Stripe call (no fallback to a guessed sequence);
//   7. the payment completes during a retry: 409 payment_pending with nothing written, then the paid event applies and a
//      further checkout is refused not_payable_state;
//   8. a direct registration without a reservation (the ledger tests' and rehearsal's path) still works, and a fork
//      against an open attempt is still attempt_in_progress; fail_payment_attempt refuses a non-reserved attempt.
import { createHmac } from 'node:crypto';
import { installSpy, callRoute, req, rawReq, ok, summary, uniq, ENV, FIXTURE_PRODUCTS } from './_route.mjs';
import { HOURLY } from './_fixture_availability.mjs';
import { teardownRetailerFixtures } from './_teardown.mjs';

const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
if (!SB || !KEY || !SB.includes('tileejdviuvijumjeplv')) { console.log('  FAIL SB_URL / SB_KEY must name demohub-rebuild-check'); process.exit(1); }
const watchdog = setTimeout(() => { console.log('  FAIL watchdog: suite exceeded 8 minutes'); process.exit(1); }, 8 * 60 * 1000);
const spy = installSpy();
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j, text: t }; };
const rpc = async (fn, args) => { const r = await fetch(`${SB}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H, body: JSON.stringify(args) }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j, text: t }; };
const one = (r) => (r && Array.isArray(r.body) ? r.body[0] : null);
const LA = 'America/Los_Angeles';
function dayP(n) { const d = new Date(Date.now() + n * 864e5); const p = {}; for (const x of new Intl.DateTimeFormat('en-US', { timeZone: LA, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)) p[x.type] = p[x.type] || x.value; return `${p.year}-${p.month}-${p.day}`; }
const sign = (payload, secret = 'whsec_harness') => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`; };
const CATALOG = [{ id: 'cat-1', ...FIXTURE_PRODUCTS[0] }];

console.log('\nFixtures');
const slug = uniq('ar');
const retailerId = one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug, name: 'Reservation Market', billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active', platform_keeps_all: true, timezone: LA, auto_confirm_bookings: true, cancellation_mode: 'refundable', verification_status: 'approved' }) })).id;
await db('settings', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, demo_fee: 150, advance_booking_days: 0 }) });
const venue = one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, name: 'Main', address: '1 Reservation St', demo_fee: 150, availability: HOURLY }) })).id;
const brandEmail = `${uniq('brand')}@fixture.test`;
const brandId = one(await db('brands', { method: 'POST', body: JSON.stringify({ email: brandEmail, company_name: 'Reservation Brand', contact_name: 'Reservation Contact', phone: '555-0173', is_verified: true, products: CATALOG, default_coi_url: 'brands/res.pdf', default_coi_expires: dayP(400), coi_verification_status: 'approved' }) })).id;
const brandTok = one(await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: brandId, email: brandEmail, token: 'tk-' + uniq('c'), expires_at: new Date(Date.now() + 36e5).toISOString() }) }));
const brandCookie = (await callRoute('brand-account.js', req({ body: { action: 'verify', token: brandTok.token } }))).cookie('dh_brand_session');
{
  const chk = await callRoute('booking.js', req({ body: { action: 'agreement-check', retailer_slug: slug }, cookies: { dh_brand_session: brandCookie } }));
  const hash = chk.body && chk.body.policies && chk.body.policies.policy_hash;
  await callRoute('booking.js', req({ body: { action: 'agreement-sign', retailer_slug: slug, signed_name: 'Fixture Owner', policy_hash: hash }, cookies: { dh_brand_session: brandCookie } }));
}
ok('fixtures: keeps-all retailer, $150 venue, brand session', !!retailerId && !!venue && !!brandCookie);
let dayN = 50;
async function book() {
  const bk = await callRoute('book.js', req({ body: { retailer_slug: slug, venue_id: venue, demo_date: dayP(dayN++), demo_time: '13:00', product_skus: [CATALOG[0]], op_key: ('op-' + uniq('k')).replace(/[^A-Za-z0-9_-]/g, '') }, cookies: { dh_brand_session: brandCookie } }));
  const id = bk.body && (bk.body.booking_id || bk.body.id || (bk.body.booking && bk.body.booking.id));
  if (!id) throw new Error('book failed ' + bk.statusCode + ' ' + JSON.stringify(bk.body).slice(0, 200));
  return id;
}
async function checkout(ids) {
  const before = spy.calls.stripe.length;
  const res = await callRoute('checkout.js', req({ body: { booking_ids: ids }, cookies: { dh_brand_session: brandCookie } }));
  const made = spy.calls.stripe.slice(before).map(c => `${String(c.method).toUpperCase()} ${c.url.replace('https://api.stripe.com', '').replace(/\?.*$/, '')}`);
  return { res, calls: made, posts: made.filter(m => m === 'POST /v1/checkout/sessions').length };
}
const attemptsOf = async (gid) => (await db(`payment_attempts?payment_group_id=eq.${gid}&select=id,status,stripe_checkout_session_id,generation,canonical_request_hash,last_error&order=created_at.asc`)).body || [];
const groupOf = async (gid) => one(await db(`payment_groups?id=eq.${gid}&select=id,status,stripe_checkout_session_id`));
const live = (atts) => atts.filter(a => ['open', 'reserved'].includes(a.status));

try {
  console.log('\n1. a retry while the first session is open creates nothing');
  {
    const b = await book();
    const c1 = await checkout([b]);
    const gid = c1.res.body.payment_group_id, sid1 = c1.res.body.session_id;
    const a1 = await attemptsOf(gid);
    ok('first checkout: 200, one POST, one open attempt bound to the session with generation 1', c1.res.statusCode === 200 && c1.posts === 1 && a1.length === 1 && a1[0].status === 'open' && a1[0].stripe_checkout_session_id === sid1 && a1[0].generation === 1, JSON.stringify({ s: c1.res.statusCode, a1 }));
    const c2 = await checkout([b]);
    ok('retry while open: 409 attempt_in_progress, no url, exactly one Stripe call and it is a GET of that session, nothing created', c2.res.statusCode === 409 && c2.res.body.error === 'attempt_in_progress' && !c2.res.body.url && c2.calls.length === 1 && c2.calls[0] === `GET /v1/checkout/sessions/${sid1}` && c2.posts === 0 && (await attemptsOf(gid)).length === 1 && spy.sessions.size === 1, JSON.stringify({ s: c2.res.statusCode, calls: c2.calls, sessions: spy.sessions.size }));
  }

  console.log('\n2. the open attempt\'s session expired on Stripe without the ledger being told');
  {
    const b = await book();
    const c1 = await checkout([b]);
    const gid = c1.res.body.payment_group_id, sid1 = c1.res.body.session_id;
    spy.sessions.get(sid1).status = 'expired';
    const c2 = await checkout([b]);
    const atts = await attemptsOf(gid);
    ok('retry: the dead session is recorded expired and a fresh session is returned (200, new id, one POST); attempts expired + open, the expired one keeps its session id', c2.res.statusCode === 200 && c2.res.body.session_id && c2.res.body.session_id !== sid1 && c2.posts === 1 && atts.length === 2 && atts[0].status === 'expired' && atts[0].stripe_checkout_session_id === sid1 && atts[1].status === 'open' && atts[1].stripe_checkout_session_id === c2.res.body.session_id && atts[1].generation === 2, JSON.stringify({ s: c2.res.statusCode, same: c2.res.body.session_id === sid1, atts: atts.map(a => [a.status, a.generation]) }));
    ok('the dead link is never in a response: the new url differs from the expired session\'s', c2.res.body.url && c2.res.body.url !== spy.sessions.get(sid1).url);
  }

  console.log('\n3. provider creation succeeds, the ledger write fails');
  {
    const b = await book();
    spy.faults.push({ url: '/rest/v1/rpc/register_payment_attempt', method: 'POST', status: 500, message: 'db_write_outage', once: true });
    const c1 = await checkout([b]);
    const gids = (await db(`payment_allocations?booking_id=eq.${b}&select=payment_group_id`)).body || [];
    const gid = gids[0] && gids[0].payment_group_id;
    const a1 = await attemptsOf(gid);
    ok('503 attempt_persist_failed, no url; the reservation stays reserved with NO session id; one session exists on the provider', c1.res.statusCode === 503 && c1.res.body.error === 'attempt_persist_failed' && !c1.res.body.url && a1.length === 1 && a1[0].status === 'reserved' && a1[0].stripe_checkout_session_id === null && c1.posts === 1, JSON.stringify({ s: c1.res.statusCode, a1 }));
    const created = [...spy.sessions.values()].slice(-1)[0];
    const c2 = await checkout([b]);
    const a2 = await attemptsOf(gid);
    ok('the retry reuses the reservation: the same key replays the SAME session, it is bound (open), one attempt, no second session', c2.res.statusCode === 200 && c2.res.body.session_id === created.id && a2.length === 1 && a2[0].status === 'open' && a2[0].stripe_checkout_session_id === created.id && a2[0].id === a1[0].id, JSON.stringify({ s: c2.res.statusCode, same: c2.res.body.session_id === created.id, a2 }));
  }

  console.log('\n4. the replayed session is unusable (it expired between the failed write and the retry)');
  {
    const b = await book();
    spy.faults.push({ url: '/rest/v1/rpc/register_payment_attempt', method: 'POST', status: 500, message: 'db_write_outage', once: true });
    const c1 = await checkout([b]);
    const gid = ((await db(`payment_allocations?booking_id=eq.${b}&select=payment_group_id`)).body || [])[0].payment_group_id;
    const dead = [...spy.sessions.values()].slice(-1)[0];
    dead.status = 'expired';
    const c2 = await checkout([b]);
    const atts = await attemptsOf(gid);
    ok('the retry replays the dead session, records the reservation failed WITH that session id and the reason, reserves generation 2 and returns a fresh usable session; the dead link is never returned', c1.res.statusCode === 503 && c2.res.statusCode === 200 && c2.res.body.session_id !== dead.id && c2.posts === 2 && atts.length === 2 && atts[0].status === 'failed' && atts[0].stripe_checkout_session_id === dead.id && /session_unusable:expired/.test(atts[0].last_error || '') && atts[1].status === 'open' && atts[1].generation === 2 && atts[1].stripe_checkout_session_id === c2.res.body.session_id, JSON.stringify({ s: c2.res.statusCode, atts: atts.map(a => [a.status, a.generation, a.last_error]) }));
  }

  console.log('\n5. simultaneous retries share one reservation and one session');
  {
    const b = await book();
    const [p, q] = await Promise.all([checkout([b]), checkout([b])]);
    const gid = (p.res.body && p.res.body.payment_group_id) || (q.res.body && q.res.body.payment_group_id);
    const atts = await attemptsOf(gid);
    const wins = [p, q].filter(x => x.res.statusCode === 200);
    const sameSession = wins.length === 2 ? wins[0].res.body.session_id === wins[1].res.body.session_id : true;
    ok('two checkouts at once: every 200 answer names the SAME session, exactly one live attempt (open), no second session on the provider for the group', wins.length >= 1 && sameSession && live(atts).length === 1 && atts.filter(a => a.status === 'open').length === 1 && [...spy.sessions.values()].filter(s => s.metadata && s.metadata.payment_group_id === gid).length === 1 && [p, q].every(x => x.res.statusCode === 200 || (x.res.statusCode === 409 && x.res.body.error === 'attempt_in_progress')), JSON.stringify({ codes: [p.res.statusCode, q.res.statusCode], atts: atts.map(a => a.status), sessions: [...spy.sessions.values()].filter(s => s.metadata && s.metadata.payment_group_id === gid).length }));
  }

  console.log('\n6. the attempt read fails: fail closed, no provider call');
  {
    const b = await book();
    spy.faults.push({ url: '/rest/v1/rpc/reserve_payment_attempt', method: 'POST', status: 500, message: 'ledger_outage', once: true });
    const c1 = await checkout([b]);
    ok('503 attempt_reserve_failed, no url, zero Stripe calls, no attempt row', c1.res.statusCode === 503 && c1.res.body.error === 'attempt_reserve_failed' && !c1.res.body.url && c1.calls.length === 0, JSON.stringify({ s: c1.res.statusCode, body: c1.res.body, calls: c1.calls }));
    const c2 = await checkout([b]);
    const gid = c2.res.body && c2.res.body.payment_group_id;
    ok('the next checkout works normally: 200, one open attempt, generation 1', c2.res.statusCode === 200 && gid && (await attemptsOf(gid)).length === 1 && (await attemptsOf(gid))[0].generation === 1, String(c2.res.statusCode));
  }

  console.log('\n7. the payment completes during a retry');
  {
    const b = await book();
    const c1 = await checkout([b]);
    const gid = c1.res.body.payment_group_id, sid = c1.res.body.session_id;
    const s = spy.sessions.get(sid); s.status = 'complete'; s.payment_status = 'paid';
    const c2 = await checkout([b]);
    ok('retry while the session is complete on Stripe: 409 payment_pending, no url, nothing created, the attempt still open for the webhook', c2.res.statusCode === 409 && c2.res.body.error === 'payment_pending' && !c2.res.body.url && c2.posts === 0 && (await attemptsOf(gid)).length === 1 && (await attemptsOf(gid))[0].status === 'open', JSON.stringify({ s: c2.res.statusCode, body: c2.res.body }));
    const pi = 'pi_' + uniq('r').replace(/-/g, '');
    spy.fixtures.paymentIntents[pi] = { id: pi, object: 'payment_intent', amount_received: 15000, currency: 'usd', latest_charge: { id: 'ch_' + uniq('r').replace(/-/g, ''), object: 'charge' } };
    const raw = JSON.stringify({ id: 'evt_' + uniq('p'), type: 'checkout.session.completed', data: { object: { id: sid, object: 'checkout.session', mode: 'payment', payment_status: 'paid', amount_total: 15000, currency: 'usd', payment_intent: pi, metadata: { payment_group_id: gid } } } });
    const w = await callRoute('stripe-webhook.js', rawReq(raw, { signature: sign(raw) }));
    const c3 = await checkout([b]);
    ok('the paid event applies (group paid, attempt paid) and a further checkout is refused not_payable_state with no Stripe call', w.statusCode === 200 && (await groupOf(gid)).status === 'paid' && (await attemptsOf(gid))[0].status === 'paid' && c3.res.statusCode === 409 && c3.res.body.error === 'not_payable_state' && c3.calls.length === 0, JSON.stringify({ w: w.statusCode, g: (await groupOf(gid)).status, s: c3.res.statusCode }));
  }

  console.log('\n8. the ledger functions on their own: direct registration, forks, failing a non-reserved attempt');
  {
    const b = await book();
    const claim = (await rpc('checkout_claim_group', { p_brand_id: brandId, p_retailer_id: retailerId, p_booking_ids: [b], p_platform_keeps_all: true, p_connect_account_id: null, p_platform_fee_cents: 0, p_provisional: false })).body;
    const gid = (Array.isArray(claim) ? claim[0] : claim).payment_group_id;
    const direct = await rpc('register_payment_attempt', { p_group_id: gid, p_session_id: 'cs_test_direct_' + uniq('d').replace(/-/g, ''), p_payment_intent: null, p_hash: 'direct-' + gid, p_schema: 1 });
    const atts = await attemptsOf(gid);
    ok('a direct registration without a reservation still inserts an open attempt (generation 1)', direct.ok && atts.length === 1 && atts[0].status === 'open' && atts[0].generation === 1, direct.text.slice(0, 120));
    const fork = await rpc('register_payment_attempt', { p_group_id: gid, p_session_id: 'cs_test_fork_' + uniq('f').replace(/-/g, ''), p_payment_intent: null, p_hash: 'direct-' + gid, p_schema: 1 });
    ok('a different session against the open attempt is still refused attempt_in_progress', !fork.ok && /attempt_in_progress/.test(fork.text), fork.text.slice(0, 80));
    const res2 = await rpc('reserve_payment_attempt', { p_group_id: gid, p_hash: 'direct-' + gid, p_schema: 1 });
    ok('reserve_payment_attempt on a group with an open attempt answers that attempt (outcome open, existing true) and inserts nothing', res2.ok && res2.body.outcome === 'open' && res2.body.existing === true && res2.body.attempt_id === atts[0].id && (await attemptsOf(gid)).length === 1, res2.text.slice(0, 160));
    const otherHash = await rpc('reserve_payment_attempt', { p_group_id: gid, p_hash: 'other-' + gid, p_schema: 1 });
    ok('a different request snapshot against the live attempt is attempt_in_progress', !otherHash.ok && /attempt_in_progress/.test(otherHash.text), otherHash.text.slice(0, 80));
    const notReserved = await rpc('fail_payment_attempt', { p_attempt_id: atts[0].id, p_session_id: null, p_error: 'x' });
    ok('fail_payment_attempt refuses an attempt that is not reserved (outcome not_reserved), the open attempt untouched', notReserved.ok && notReserved.body.outcome === 'not_reserved' && (await attemptsOf(gid))[0].status === 'open', notReserved.text.slice(0, 120));
    const anon = await fetch(`${SB}/rest/v1/rpc/reserve_payment_attempt`, { method: 'POST', headers: { apikey: process.env.SB_ANON_KEY || KEY.replace(/./g, 'x'), 'Content-Type': 'application/json' }, body: JSON.stringify({ p_group_id: gid, p_hash: 'x', p_schema: 1 }) });
    ok('the reservation function is not reachable without the service credential', anon.status === 401 || anon.status === 403 || anon.status === 404, String(anon.status));
  }
} finally {
  clearTimeout(watchdog);
  spy.restore();
  try { console.log('\n:: teardown ::'); const counts = await teardownRetailerFixtures({ sbUrl: SB, sbKey: KEY, retailerIds: [retailerId], brandIds: [brandId], log: (m) => console.log(m) }); console.log('  teardown:', JSON.stringify(counts)); }
  catch (e) { console.log('  teardown failed (rows left on demohub-rebuild-check):', String((e && e.message) || e)); }
}
process.exit(summary('payment attempt reservations (routes + ledger, demohub-rebuild-check)') ? 0 : 1);
