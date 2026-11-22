// tests/unpaid_expiry_fencing.test.mjs (2026-11-22, Codex return review of 9891aba: R1, R2, R3). demohub-rebuild-check,
// Stripe spied; never production. The pauses are deterministic: a spy fault with a `before` hook stops one request of the
// checkout handler at an exact step, runs the workers there, and lets the request go on (or fails it).
//
// R2  a retry holding an old reservation is paused BEFORE its provider request; expiry starts; the request resumes.
//     Capacity stays reserved until that attempt's provider outcome is settled. Repeated for: creation succeeds, the
//     creation response is lost, the bind fails, two workers at once, a worker run again. Plus the handler's own bound:
//     outside its send window it sends nothing.
// R1  both workers interleaved with a keeps-all hold's checkout: before the reservation, after it and before the provider
//     request, after creation and before the bind, after the bind. provisional-sweep never releases an unpaid hold; the
//     bump's locked release refuses while an attempt is live.
// R3  more than a batch of persistently blocked groups, then ordinary due groups and ungrouped bookings: the later work
//     completes within three ticks; blocked groups carry their reason, age and next check; a persistent block turns the
//     heartbeat unhealthy while the request answers 200.
import pg from 'pg';
import { installSpy, callRoute, req, ok, summary, uniq, ENV, FIXTURE_PRODUCTS } from './_route.mjs';
import { HOURLY } from './_fixture_availability.mjs';
import { teardownRetailerFixtures } from './_teardown.mjs';

const SB = process.env.SB_URL, KEY = process.env.SB_KEY, DBURL = process.env.SB_DB_URL;
const TEST_REF = 'tileejdviuvijumjeplv';
if (!SB || !KEY || !SB.includes(TEST_REF)) { console.log('  FAIL SB_URL / SB_KEY must name demohub-rebuild-check'); process.exit(1); }
if (!DBURL || !DBURL.includes(TEST_REF)) { console.log('  FAIL SB_DB_URL must name demohub-rebuild-check'); process.exit(1); }
for (const ref of ['dkgjvsstbgnhcfboqqnd', 'ecapmcyumpjjgjwuokyv', 'eubbgurdwqmwqduamwhn']) if (DBURL.includes(ref) || SB.includes(ref)) { console.log('  FAIL REFUSING: production or retired project'); process.exit(1); }
const watchdog = setTimeout(() => { console.log('  FAIL watchdog: suite exceeded 14 minutes'); process.exit(1); }, 14 * 60 * 1000);

const spy = installSpy();
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j }; };
const rpc = async (fn, args) => { const r = await fetch(`${SB}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H, body: JSON.stringify(args) }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j, text: t }; };
const one = (r) => (r && Array.isArray(r.body) ? r.body[0] : null);
const val = (r) => (Array.isArray(r.body) ? r.body[0] : r.body) || {};
const LA = 'America/Los_Angeles';
function dayP(n) { const d = new Date(Date.now() + n * 864e5); const p = {}; for (const x of new Intl.DateTimeFormat('en-US', { timeZone: LA, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)) p[x.type] = p[x.type] || x.value; return `${p.year}-${p.month}-${p.day}`; }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
ENV.PROVISIONAL_HOLDS_ENABLED = 'true';
ENV.CONNECTED_CHECKOUT_ENABLED = 'true';
const ACCT = 'acct_fence_' + uniq('x').replace(/-/g, '');
const CATALOG = [{ id: 'cat-1', ...FIXTURE_PRODUCTS[0] }];
const CRON = { authorization: 'Bearer ' + ENV.CRON_SECRET };
const c1 = new pg.Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await c1.connect();

console.log('\nFixtures');
async function mkRetailer(prefix, connected) {
  const slug = uniq(prefix);
  const id = one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug, name: connected ? 'Fence Connected Market' : 'Fence Keeps-all Market', billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active',
    platform_keeps_all: !connected, stripe_account_id: connected ? ACCT : null, stripe_charges_enabled: connected, stripe_payouts_enabled: connected, stripe_account_status: connected ? 'active' : null, timezone: LA, auto_confirm_bookings: true, cancellation_mode: 'refundable', verification_status: 'approved' }) })).id;
  await db('settings', { method: 'POST', body: JSON.stringify({ retailer_id: id, demo_fee: 20, advance_booking_days: 0 }) });
  const venue = one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: id, name: 'Main', address: '1 Fence St', demo_fee: 20, availability: HOURLY }) })).id;
  return { id, slug, venue, connected };
}
const K = await mkRetailer('fnk', false), C = await mkRetailer('fnc', true);
const brandIds = [];
async function mkBrand(label, coi) {
  const email = `${uniq(label)}@fixture.test`;
  const body = { email, company_name: label + ' Brand', contact_name: label + ' Contact', phone: '555-0176', is_verified: true, products: CATALOG };
  if (coi) Object.assign(body, { default_coi_url: `brands/${label}.pdf`, default_coi_expires: dayP(400), coi_verification_status: 'approved' });
  const id = one(await db('brands', { method: 'POST', body: JSON.stringify(body) })).id; brandIds.push(id);
  const tok = one(await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: id, email, token: 'tk-' + uniq('t'), expires_at: new Date(Date.now() + 36e5).toISOString() }) }));
  const cookie = (await callRoute('brand-account.js', req({ body: { action: 'verify', token: tok.token } }))).cookie('dh_brand_session');
  for (const store of [K, C]) {
    const chk = await callRoute('booking.js', req({ body: { action: 'agreement-check', retailer_slug: store.slug }, cookies: { dh_brand_session: cookie } }));
    await callRoute('booking.js', req({ body: { action: 'agreement-sign', retailer_slug: store.slug, signed_name: 'Fixture Owner', policy_hash: chk.body.policies.policy_hash }, cookies: { dh_brand_session: cookie } }));
  }
  return { id, cookie };
}
const A = await mkBrand('fna', true), B = await mkBrand('fnb', false);
let dayN = 100;
const bookRaw = (brand, store, date) => callRoute('book.js', req({ body: { retailer_slug: store.slug, venue_id: store.venue, demo_date: date, demo_time: '13:00', product_skus: [CATALOG[0]], op_key: ('op-' + uniq('k')).replace(/[^A-Za-z0-9_-]/g, '') }, cookies: { dh_brand_session: brand.cookie } }));
async function book(brand, store, date) {
  const bk = await bookRaw(brand, store, date || dayP(dayN++));
  if (!bk.body || !bk.body.booking_id) throw new Error('book failed ' + bk.statusCode + ' ' + JSON.stringify(bk.body).slice(0, 200));
  return bk.body.booking_id;
}
const checkout = (brand, ids) => callRoute('checkout.js', req({ body: { booking_ids: ids }, cookies: { dh_brand_session: brand.cookie } }));
const stateOf = async (id) => one(await db(`bookings?id=eq.${id}&select=status,payment_status,held_expires_at,unpaid_expires_at,payment_intent_id`));
const groupOfBooking = async (b) => (one(await db(`payment_allocations?booking_id=eq.${b}&select=payment_group_id`)) || {}).payment_group_id;
const groupOf = async (gid) => one(await db(`payment_groups?id=eq.${gid}&select=id,status,unpaid_expiry_started_at,unpaid_expired_at,unpaid_expiry_next_check_at,unpaid_expiry_blocked_reason,unpaid_expiry_blocked_since,unpaid_expiry_blocked_count`));
const attemptsOf = async (gid) => (await db(`payment_attempts?payment_group_id=eq.${gid}&select=id,status,stripe_checkout_session_id,last_error,create_lease_until,reserved_at&order=created_at.asc`)).body || [];
const creates = () => spy.calls.stripe.filter(c => String(c.method).toUpperCase() === 'POST' && /\/checkout\/sessions$/.test(c.url.replace(/\?.*$/, ''))).length;
const unpaidSweep = () => callRoute('unpaid-sweep.js', req({ body: {}, headers: CRON }));
const holdSweep = () => callRoute('provisional-sweep.js', req({ body: {}, headers: CRON }));
// fixture writes on a direct connection: a deadline in the past (the immutability trigger is bypassed for that statement)
async function pastDeadline(when, ...ids) {
  await c1.query('BEGIN'); await c1.query("SET LOCAL session_replication_role = 'replica'");
  await c1.query('UPDATE bookings SET unpaid_expires_at = $2::timestamptz WHERE id = ANY($1::uuid[])', [ids, when]);
  await c1.query('COMMIT');
}
const DUE = '2003-01-01T00:00:00Z';
// time passing for chosen groups: the fence backdated, their creation leases in the past, the next check cleared
async function age(...gids) {
  if (!gids.length) return;
  await db(`payment_groups?id=in.(${gids.join(',')})&unpaid_expiry_started_at=not.is.null`, { method: 'PATCH', body: JSON.stringify({ unpaid_expiry_started_at: '2001-01-02T00:00:00Z', unpaid_expiry_next_check_at: null }) });
  await db(`payment_attempts?payment_group_id=in.(${gids.join(',')})&create_lease_until=not.is.null`, { method: 'PATCH', body: JSON.stringify({ create_lease_until: '2001-01-02T00:00:00Z' }) });
}
// the fair queue (R3) gives a blocked group a next-check time; this makes it due again WITHOUT moving any clock of the protocol
const recheck = (...gids) => db(`payment_groups?id=in.(${gids.join(',')})`, { method: 'PATCH', body: JSON.stringify({ unpaid_expiry_next_check_at: null }) });
async function sweepAged(gid, done, max = 10) { for (let i = 0; i < max; i++) { await age(gid); await unpaidSweep(); if (await done()) return true; } return false; }
// a reservation with no session behind it, first made 40 minutes ago, its last lease long over
async function oldReservation(brand, store) {
  const b = await book(brand, store);
  spy.faults.push({ url: 'api.stripe.com/v1/checkout/sessions', method: 'POST', once: true, status: 500, message: 'provider down' });
  const r = await checkout(brand, [b]);
  const gid = await groupOfBooking(b);
  const at = await attemptsOf(gid);
  await db(`payment_attempts?id=eq.${at[0].id}`, { method: 'PATCH', body: JSON.stringify({ reserved_at: new Date(Date.now() - 40 * 60 * 1000).toISOString(), create_lease_until: new Date(Date.now() - 39 * 60 * 1000).toISOString() }) });
  return { b, gid, attempt: at[0].id, first: r };
}
ok('fixtures: keeps-all store, connected store, an insured brand and an uninsured brand', !!K.id && !!C.id && !!A.cookie && !!B.cookie);

try {
  console.log('\nR2. a retry paused before its provider request while expiry starts');
  {
    const o = await oldReservation(A, C);
    ok('R2-0. the fixture: a reserved attempt with no session, 40 minutes old, its lease over', o.first.statusCode === 502 && (await attemptsOf(o.gid))[0].status === 'reserved' && !(await attemptsOf(o.gid))[0].stripe_checkout_session_id);
    const seen = {};
    spy.faults.push({ url: 'api.stripe.com/v1/checkout/sessions', method: 'POST', once: true, passthrough: true, before: async () => {
      // the retry holds the reservation (a fresh lease) and is about to send. The deadline passes now.
      await pastDeadline(DUE, o.b);
      seen.t1 = (await unpaidSweep()).body; seen.t2 = (await unpaidSweep()).body; seen.t3 = (await holdSweep()).body;
      seen.booking = await stateOf(o.b); seen.group = await groupOf(o.gid); seen.attempts = await attemptsOf(o.gid); seen.creates = creates();
    } });
    const before = creates();
    const r = await checkout(A, [o.b]);
    ok('R2-1. paused before the provider request: expiry started and fenced the group, but nothing was released and nothing was searched or failed', !!seen.group && !!seen.group.unpaid_expiry_started_at && !seen.group.unpaid_expired_at && seen.booking.status === 'pending_payment' && seen.attempts.length === 1 && seen.attempts[0].status === 'reserved' && seen.group.unpaid_expiry_blocked_reason === 'blocked_creation_lease', JSON.stringify({ g: seen.group, a: seen.attempts && seen.attempts.map(x => x.status), t1: seen.t1 && seen.t1.blocked_reasons }));
    ok('R2-2. the reservation it was handed carried a lease in the future although the reservation itself was 40 minutes old', Date.parse(seen.attempts[0].create_lease_until) > Date.now() - 5000 + 0 && Date.parse(seen.attempts[0].reserved_at) < Date.now() - 30 * 60 * 1000, JSON.stringify(seen.attempts[0]));
    const at = await attemptsOf(o.gid);
    ok('R2-3. the request resumed and reached the provider AFTER expiry had begun: one session, bound to the same attempt, and the booking still holds its place', creates() === before + 1 && at.length === 1 && at[0].status === 'open' && !!at[0].stripe_checkout_session_id && (await stateOf(o.b)).status === 'pending_payment' && r.statusCode === 200, r.statusCode + ' ' + JSON.stringify(r.body).slice(0, 160));
    const sid = at[0].stripe_checkout_session_id;
    await recheck(o.gid); await unpaidSweep();
    const mid = await groupOf(o.gid);
    ok('R2-4. the next tick settles THAT session with the provider (expired there) but still does not release before the quiescence point', spy.sessions.get(sid).status === 'expired' && !mid.unpaid_expired_at && (await stateOf(o.b)).status === 'pending_payment', JSON.stringify(mid));
    const done = await sweepAged(o.gid, async () => (await stateOf(o.b)).status === 'expired');
    ok('R2-5. only after the provider outcome is settled and the quiescence point has passed is capacity released, once', done && (await groupOf(o.gid)).status === 'failed' && (await attemptsOf(o.gid))[0].status === 'expired');
    const again = await checkout(A, [o.b]);
    ok('R2-6. no session can be created for it afterwards', again.statusCode === 409 && creates() === before + 1, again.statusCode + ' ' + JSON.stringify(again.body));
  }
  {
    // the provider created the session but the response was lost (timeout): outcome unknown to the handler
    const o = await oldReservation(A, C);
    let made = null;
    spy.faults.push({ url: 'api.stripe.com/v1/checkout/sessions', method: 'POST', once: true, status: 500, message: 'response lost', before: async (u, opts) => {
      made = await (await fetch(u, opts)).json();   // the provider processes the request...
      await pastDeadline(DUE, o.b);                 // ...the deadline passes, and the handler never sees the answer
    } });
    const r = await checkout(A, [o.b]);
    await unpaidSweep(); await unpaidSweep();
    const g = await groupOf(o.gid), at = await attemptsOf(o.gid);
    ok('R2-7. creation outcome unknown: the handler reports a provider failure, the reservation is kept, and expiry waits for the lease instead of failing it', r.statusCode === 502 && !!made && made.id && at[0].status === 'reserved' && !at[0].stripe_checkout_session_id && !!g.unpaid_expiry_started_at && !g.unpaid_expired_at && g.unpaid_expiry_blocked_reason === 'blocked_creation_lease' && (await stateOf(o.b)).status === 'pending_payment' && spy.sessions.get(made.id).status === 'open', r.statusCode + ' ' + JSON.stringify({ g, a: at.map(x => x.status) }));
    const done = await sweepAged(o.gid, async () => (await stateOf(o.b)).status === 'expired');
    const at2 = await attemptsOf(o.gid);
    ok('R2-8. after quiescence the provider is searched, the unbound session is found and expired there, and only then is the reservation failed and the booking released', done && spy.sessions.get(made.id).status === 'expired' && at2[0].status === 'failed' && at2[0].stripe_checkout_session_id === made.id, JSON.stringify(at2));
  }
  {
    // the bind fails after creation
    const o = await oldReservation(A, C);
    spy.faults.push({ url: '/rpc/register_payment_attempt', method: 'POST', once: true, status: 500, message: 'bind failed', before: async () => { await pastDeadline(DUE, o.b); } });
    const sessions = spy.sessions.size;
    const r = await checkout(A, [o.b]);
    const sid = [...spy.sessions.values()].slice(-1)[0].id;
    await unpaidSweep(); await unpaidSweep();
    ok('R2-9. bind failed after creation: one unbound open session exists, and expiry blocks on the lease', r.statusCode === 503 && spy.sessions.size === sessions + 1 && spy.sessions.get(sid).status === 'open' && (await attemptsOf(o.gid))[0].status === 'reserved' && (await stateOf(o.b)).status === 'pending_payment' && !(await groupOf(o.gid)).unpaid_expired_at, r.statusCode + ' ' + JSON.stringify(r.body));
    // two workers at once, then the same worker again
    await age(o.gid);
    const [w1, w2] = await Promise.all([unpaidSweep(), unpaidSweep()]);
    const done = await sweepAged(o.gid, async () => (await stateOf(o.b)).status === 'expired');
    const w3 = await unpaidSweep();
    const at = await attemptsOf(o.gid);
    ok('R2-10. two workers at once and a rerun: no error, the session expired on the provider, the reservation failed once with that session, the booking released once', w1.statusCode === 200 && w2.statusCode === 200 && w3.statusCode === 200 && done && spy.sessions.get(sid).status === 'expired' && at.length === 1 && at[0].status === 'failed' && at[0].stripe_checkout_session_id === sid && (await groupOf(o.gid)).status === 'failed', JSON.stringify({ w1: w1.body && w1.body.errors, w2: w2.body && w2.body.errors, at }));
  }
  {
    // the ledger refuses a NEW attempt for a fenced group; binding a live reservation stays possible (R2-3 above)
    const b = await book(A, K);
    const first = await checkout(A, [b]);
    const gid = first.body.payment_group_id;
    await callRoute('stripe-webhook.js', (await import('./_route.mjs')).rawReq(JSON.stringify({ id: 'evt_' + uniq('x'), type: 'ignored' }), {})).catch(() => {});
    await rpc('expire_payment_attempt', { p_session_id: first.body.session_id });
    await pastDeadline(DUE, b);
    const beg = val(await rpc('begin_unpaid_group_expiry', { p_group_id: gid }));
    const reg = await rpc('register_payment_attempt', { p_group_id: gid, p_session_id: 'cs_test_direct_' + uniq('s'), p_payment_intent: null, p_hash: 'h-direct', p_schema: 1 });
    const rsv = await rpc('reserve_payment_attempt', { p_group_id: gid, p_hash: 'h-direct', p_schema: 1, p_request: 'a=b' });
    ok('R2-11. once fenced, the ledger grants no reservation and accepts no direct registration for the group', beg.outcome === 'expiring' && !reg.ok && /unpaid_expired/.test(reg.text) && !rsv.ok && /unpaid_expired/.test(rsv.text) && (await attemptsOf(gid)).filter(a => ['open', 'reserved'].includes(a.status)).length === 0, reg.text.slice(0, 120) + ' | ' + rsv.text.slice(0, 120));
    const early = val(await rpc('finalize_unpaid_group_expiry', { p_group_id: gid }));
    ok('R2-12. finalize refuses before the quiescence point even with no live attempt, because a lease was granted for this group', early.outcome === 'not_quiescent' && (await stateOf(b)).status === 'pending_payment', JSON.stringify(early));
  }
  {
    // the handler's own bound: outside its send window it sends nothing
    const b = await book(A, C);
    const before = creates();
    spy.faults.push({ url: '/rpc/reserve_payment_attempt', method: 'POST', once: true, passthrough: true, before: async () => { await sleep(31500); } });
    const r = await checkout(A, [b]);
    const gid = await groupOfBooking(b);
    ok('R2-13. a handler that is 31 seconds late does not send its provider request: 503 checkout_slow, no session created, the reservation kept for a retry', r.statusCode === 503 && r.body.error === 'checkout_slow' && creates() === before && (await attemptsOf(gid))[0].status === 'reserved', r.statusCode + ' ' + JSON.stringify(r.body));
    const retry = await checkout(A, [b]);
    ok('R2-14. the retry gets a fresh lease and creates the session under the same attempt', retry.statusCode === 200 && creates() === before + 1 && (await attemptsOf(gid)).length === 1 && (await attemptsOf(gid))[0].status === 'open', retry.statusCode + ' ' + JSON.stringify(retry.body).slice(0, 120));
  }

  console.log('\nR1. one expiry path for an unpaid hold (keeps-all store, uninsured brand)');
  const overdueHold = (id) => db(`bookings?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ held_expires_at: new Date(Date.now() - 3600e3).toISOString() }) });
  {
    const h = await book(B, K);
    const s0 = await stateOf(h);
    ok('R1-0. the fixture: a held, unpaid booking at the keeps-all store', s0.status === 'held' && s0.payment_status === 'unpaid');
    const snaps = {};
    const snap = async (name) => { await overdueHold(h); await pastDeadline(DUE, h); const a = (await holdSweep()), b = (await unpaidSweep()); const gid = await groupOfBooking(h); snaps[name] = { hold: a.body, unpaid: b.body, st: await stateOf(h), at: gid ? await attemptsOf(gid) : [], g: gid ? await groupOf(gid) : null }; };
    // (a) after the claim, before the reservation
    spy.faults.push({ url: '/rpc/reserve_payment_attempt', method: 'POST', once: true, passthrough: true, before: async () => { await snap('before_reservation'); } });
    const before = creates();
    const r = await checkout(B, [h]);
    const a = snaps.before_reservation;
    ok('R1-1. both workers run between the claim and the reservation: the hold is still held and unpaid; provisional-sweep left it to the unpaid sweep, which only fenced the group', a.st.status === 'held' && a.st.payment_status === 'unpaid' && (a.hold.left_to_unpaid_sweep >= 1) && !!a.g && !!a.g.unpaid_expiry_started_at && !a.g.unpaid_expired_at, JSON.stringify({ hold: a.hold, g: a.g }));
    ok('R1-2. the reservation is then refused, so no provider request is ever sent for the expiring hold', r.statusCode === 409 && r.body.error === 'unpaid_expired' && creates() === before && a.at.length === 0, r.statusCode + ' ' + JSON.stringify(r.body));
  }
  {
    const h = await book(B, K);
    const snaps = {};
    const snap = async (name) => { await overdueHold(h); await pastDeadline(DUE, h); const a = await holdSweep(), b = await unpaidSweep(), a2 = await holdSweep(); const gid = await groupOfBooking(h); snaps[name] = { hold: a.body, hold2: a2.body, unpaid: b.body, st: await stateOf(h), at: await attemptsOf(gid), g: await groupOf(gid) }; };
    // (b) after the reservation, before the provider request; (c) after creation, before the bind
    spy.faults.push({ url: 'api.stripe.com/v1/checkout/sessions', method: 'POST', once: true, passthrough: true, before: async () => { await snap('before_provider'); } });
    spy.faults.push({ url: '/rpc/register_payment_attempt', method: 'POST', once: true, passthrough: true, before: async () => { await snap('before_bind'); } });
    const r = await checkout(B, [h]);
    const gid = await groupOfBooking(h);
    const b1 = snaps.before_provider, b2 = snaps.before_bind;
    ok('R1-3. both workers run after the reservation and before the provider request: still held, the reservation untouched, nothing released', b1.st.status === 'held' && b1.at.length === 1 && b1.at[0].status === 'reserved' && !b1.g.unpaid_expired_at && b1.hold.left_to_unpaid_sweep >= 1, JSON.stringify({ st: b1.st.status, at: b1.at.map(x => x.status), hold: b1.hold }));
    ok('R1-4. both workers run after creation and before the bind: still held, the reservation untouched, nothing released', b2.st.status === 'held' && b2.at.length === 1 && b2.at[0].status === 'reserved' && !b2.g.unpaid_expired_at, JSON.stringify({ st: b2.st.status, at: b2.at.map(x => x.status) }));
    const at = await attemptsOf(gid);
    ok('R1-5. the request completes: a manual-capture session bound to the same attempt', r.statusCode === 200 && at.length === 1 && at[0].status === 'open', r.statusCode + ' ' + JSON.stringify(r.body).slice(0, 140));
    // (d) after the bind
    await overdueHold(h); await recheck(gid);
    const hs = await holdSweep(), us = await unpaidSweep();
    const sid = at[0].stripe_checkout_session_id;
    ok('R1-6. both workers run after the bind: provisional-sweep still does not touch the unpaid hold; the unpaid sweep expires the session on the provider and waits', (await stateOf(h)).status === 'held' && hs.statusCode === 200 && us.statusCode === 200 && spy.sessions.get(sid).status === 'expired' && !(await groupOf(gid)).unpaid_expired_at, JSON.stringify({ hold: hs.body, unpaid: us.body && us.body.blocked_reasons }));
    const bump = val(await rpc('release_unpaid_held_booking', { p_booking_id: h, p_target: 'expired' }));
    ok('R1-7. the bump\'s locked release refuses this hold while its group is not quiescent', ['attempt_live', 'not_quiescent'].includes(bump.outcome) && (await stateOf(h)).status === 'held', JSON.stringify(bump));
    const done = await sweepAged(gid, async () => (await stateOf(h)).status === 'expired');
    ok('R1-8. the unpaid sweep is the one that releases it, after the provider outcome is settled', done && (await groupOf(gid)).status === 'failed' && (await attemptsOf(gid))[0].status === 'expired');
  }
  {
    // an authorized hold is not the unpaid sweep's: it is left for the provider-aware release
    const h = await book(B, K);
    const r = await checkout(B, [h]);
    const gid = r.body.payment_group_id, sid = r.body.session_id;
    const pi = 'pi_fence_' + uniq('p');
    const auth = val(await rpc('apply_verified_authorization', { p_session_id: sid, p_payment_intent: pi, p_charge: 'ch_fence_' + uniq('c'), p_amount: 2000, p_currency: 'usd' }));
    const st = await stateOf(h);
    await pastDeadline(DUE, h);
    const us = await unpaidSweep(); await unpaidSweep();
    const st2 = await stateOf(h), g = await groupOf(gid);
    ok('R1-9. once authorized, the unpaid sweep never expires the hold and leaves no fence on its group', st.payment_status === 'authorized' && st2.status === 'held' && st2.payment_status === 'authorized' && !g.unpaid_expired_at && !g.unpaid_expiry_started_at && us.statusCode === 200, JSON.stringify({ auth, st2, g }));
    const direct = val(await rpc('expire_unpaid_booking', { p_booking_id: h })), bump = val(await rpc('release_unpaid_held_booking', { p_booking_id: h }));
    ok('R1-10. neither one-step function touches an authorized hold', direct.outcome === 'not_unpaid' && bump.outcome === 'not_unpaid_held', JSON.stringify({ direct, bump }));
  }
  {
    // the bump: a hold that never reached checkout is released under its lock; the insured brand then gets the slot
    const date = dayP(dayN++);
    const h = await book(B, K, date);
    // the slot holds one demo: the hold fills it, so the insured brand's first booking can only succeed by bumping it
    const got = await bookRaw(A, K, date);
    const after = await bookRaw(A, K, date);
    ok('R1-11. a full slot holding an unpaid hold that never reached checkout: the insured booking bumps it through the locked release, and exactly one place changes hands', got.statusCode === 200 && (await stateOf(h)).status === 'expired' && after.statusCode === 409 && after.body.error === 'slot_full', got.statusCode + ' ' + JSON.stringify(got.body).slice(0, 120) + ' then ' + after.statusCode);
    const date2 = dayP(dayN++);
    const h2 = await book(B, K, date2);
    await checkout(B, [h2]);   // an open session: this hold may still be paid
    for (let i = 0; i < 12; i++) { const x = await bookRaw(A, K, date2); if (x.statusCode !== 200) break; }
    const refused = await bookRaw(A, K, date2);
    ok('R1-12. a hold with a live payment attempt is not bumped: the slot stays full and the hold stays held', refused.statusCode === 409 && refused.body.error === 'slot_full' && (await stateOf(h2)).status === 'held', refused.statusCode + ' ' + JSON.stringify(refused.body));
  }
  ok('R1-13. provisional-sweep contains no write to an unpaid booking', !/status: 'expired'/.test((await import('node:fs')).readFileSync('api/provisional-sweep.js', 'utf8')) && !/method: 'PATCH'/.test((await import('node:fs')).readFileSync('api/provisional-sweep.js', 'utf8')));

  console.log('\nR3. a fair queue');
  {
    const BLOCKED = 27;
    const blocked = [];
    for (let i = 0; i < BLOCKED; i++) { const b = await book(A, C); const r = await checkout(A, [b]); Object.assign(spy.sessions.get(r.body.session_id), { status: 'complete', payment_status: 'paid' }); blocked.push({ b, gid: r.body.payment_group_id }); }
    const ordinary = [];
    for (let i = 0; i < 3; i++) { const b = await book(A, C); const r = await checkout(A, [b]); ordinary.push({ b, gid: r.body.payment_group_id, sid: r.body.session_id }); }
    const loose = [await book(A, C), await book(A, C)];
    await pastDeadline('2001-06-01T00:00:00Z', ...blocked.map(x => x.b));        // the blocked ones are the OLDEST due work
    await pastDeadline('2002-06-01T00:00:00Z', ...ordinary.map(x => x.b), ...loose);
    const ticks = [];
    for (let i = 0; i < 3; i++) { await age(...ordinary.map(x => x.gid)); ticks.push((await unpaidSweep()).body); }
    const ordStates = await Promise.all(ordinary.map(x => stateOf(x.b))), looseStates = await Promise.all(loose.map(stateOf));
    ok('R3-1. with 27 persistently blocked groups ahead of them, the ordinary due groups and the ungrouped bookings are all released within three ticks', ordStates.every(s => s.status === 'expired') && looseStates.every(s => s.status === 'expired'), JSON.stringify({ ord: ordStates.map(s => s.status), loose: looseStates.map(s => s.status), ticks: ticks.map(t => [t.scanned, t.blocked, t.expired_groups, t.expired_bookings]) }));
    const bStates = await Promise.all(blocked.map(x => stateOf(x.b))), bGroups = await Promise.all(blocked.map(x => groupOf(x.gid)));
    ok('R3-2. nothing was released to relieve the blockage: all 27 still hold their place', bStates.every(s => s.status === 'pending_payment') && bGroups.every(g => !g.unpaid_expired_at));
    ok('R3-3. every blocked group carries its reason, when it first blocked, how often, and a next check in the future', bGroups.every(g => g.unpaid_expiry_blocked_reason === 'blocked_payment_pending' && !!g.unpaid_expiry_blocked_since && g.unpaid_expiry_blocked_count >= 1 && Date.parse(g.unpaid_expiry_next_check_at) > Date.now()), JSON.stringify(bGroups[0]));
    const quiet = (await unpaidSweep()).body;
    ok('R3-4. until their next check the blocked groups are not offered again, and the run reports how many are blocked and for how long', quiet.scanned < 25 && quiet.blocked === 0 && quiet.blocked_total >= BLOCKED && typeof quiet.oldest_blocked_minutes === 'number', JSON.stringify(quiet).slice(0, 260));
    const before = (await db(`cron_heartbeat?cron_name=eq.unpaid-sweep&select=outcome&order=ran_at.desc&limit=1`)).body || [];
    ok('R3-5. a run whose blockages are recent is a healthy run', before.length === 1 && before[0].outcome === 'succeeded' && !quiet.degraded);
    await db(`payment_groups?id=eq.${blocked[0].gid}`, { method: 'PATCH', body: JSON.stringify({ unpaid_expiry_blocked_since: new Date(Date.now() - 3 * 3600e3).toISOString() }) });
    const loud = await unpaidSweep();
    const hb = (await db(`cron_heartbeat?cron_name=eq.unpaid-sweep&select=outcome,summary&order=ran_at.desc&limit=1`)).body || [];
    ok('R3-6. a group blocked for three hours: the request still answers 200, but the run is reported degraded and the heartbeat says failed, naming the group and the reason', loud.statusCode === 200 && loud.body.degraded === true && loud.body.persistent_blocked.length === 1 && loud.body.persistent_blocked[0].group === blocked[0].gid && hb[0].outcome === 'failed' && hb[0].summary && hb[0].summary.reason === 'persistent_blocked', JSON.stringify({ body: loud.body && loud.body.persistent_blocked, hb: hb[0] && hb[0].outcome }));
    // backoff grows and is bounded
    const n1 = val(await rpc('note_unpaid_group_blocked', { p_group_id: blocked[1].gid, p_reason: 'blocked_provider_unknown' })), n2 = val(await rpc('note_unpaid_group_blocked', { p_group_id: blocked[1].gid, p_reason: 'blocked_provider_unknown' }));
    for (let i = 0; i < 8; i++) await rpc('note_unpaid_group_blocked', { p_group_id: blocked[1].gid, p_reason: 'blocked_provider_unknown' });
    const n9 = val(await rpc('note_unpaid_group_blocked', { p_group_id: blocked[1].gid, p_reason: 'blocked_provider_unknown' }));
    const lease = val(await rpc('note_unpaid_group_blocked', { p_group_id: blocked[2].gid, p_reason: 'blocked_creation_lease', p_retry_seconds: 150 }));
    ok('R3-7. the backoff doubles and stops at six hours; a wait for the quiescence point uses that wait and does not lengthen the backoff', n2.next_check_in_seconds === 2 * n1.next_check_in_seconds && n9.next_check_in_seconds === 21600 && lease.next_check_in_seconds === 150 && (await groupOf(blocked[2].gid)).unpaid_expiry_blocked_count === (bGroups[2].unpaid_expiry_blocked_count), JSON.stringify({ n1, n2, n9, lease }));
    // a blocked group that is paid leaves the queue and loses its marks
    const win = blocked[3];
    const sidRow = (await attemptsOf(win.gid))[0];
    await rpc('apply_verified_payment', { p_session_id: sidRow.stripe_checkout_session_id, p_payment_intent: 'pi_r3_' + uniq('p'), p_charge: 'ch_r3_' + uniq('c'), p_amount: 3000, p_currency: 'usd', p_connect_dest: ACCT, p_on_behalf_of: ACCT, p_application_fee: 1000, p_transfer_id: null, p_fee_id: null });
    await db(`payment_groups?id=eq.${win.gid}`, { method: 'PATCH', body: JSON.stringify({ unpaid_expiry_next_check_at: null }) });
    await unpaidSweep();
    const wg = await groupOf(win.gid);
    ok('R3-8. when the awaited payment is applied, the group is no longer expiring or blocked and the booking is paid', wg.status === 'paid' && !wg.unpaid_expiry_started_at && !wg.unpaid_expiry_blocked_reason && !wg.unpaid_expiry_blocked_since && (await stateOf(win.b)).payment_status === 'paid', JSON.stringify(wg));
  }
} finally {
  clearTimeout(watchdog);
  try { await c1.query('ROLLBACK'); } catch (_) {}
  try { await c1.end(); } catch (_) {}
  spy.restore();
  try { console.log('\n:: teardown ::'); const counts = await teardownRetailerFixtures({ sbUrl: SB, sbKey: KEY, retailerIds: [K.id, C.id], brandIds, log: () => {} }); console.log('  teardown:', JSON.stringify(counts).slice(0, 220)); }
  catch (e) { console.log('  teardown failed (rows left on demohub-rebuild-check):', String((e && e.message) || e)); }
}
process.exit(summary('unpaid expiry fencing: R1, R2, R3 (routes + workers + database, demohub-rebuild-check)') ? 0 : 1);
