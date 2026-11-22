// tests/unpaid_expiry.test.mjs (2026-11-22, Codex brand-walk order item 2): the bounded unpaid reservation lifecycle
// (migration 0123, api/unpaid-sweep.js). Runs against demohub-rebuild-check with Stripe spied; never production.
//
// A booking's deadline is made "past" by a fixture write that bypasses the immutability trigger on a direct connection
// (the trigger itself is proven first, through the ordinary API path). The worker then runs with the real clock.
//
//   0. the deadline is set by the database at creation and cannot be moved through the API
//   1. never-started checkout: expires in one step; not before the deadline
//   2. open session: expired on the provider, recorded, bookings released, capacity freed exactly once; rerun changes nothing
//   3. completed session: never expired; the payment wins and the expiry marker is cleared
//   4. reserved attempt with no session id: blocked inside the grace period; after it, failed only once the provider was
//      searched; an unbound open session found there is expired first; a complete one blocks
//   5. two demos paid together end together when the earliest deadline passes; allocations and attempts are kept
//   6. after the deadline nothing is payable: the claim and the reservation refuse before any provider call
//   7. a late payment after finalize is not applied: a reconciliation case, the booking stays expired
//   8. races on two connections: begin against reserve, claim against expire_unpaid_booking, finalize against payment
//   9. provider unreadable: the group stays blocked and nothing is released
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { installSpy, callRoute, req, ok, summary, uniq, ENV, FIXTURE_PRODUCTS } from './_route.mjs';
import { HOURLY } from './_fixture_availability.mjs';
import { teardownRetailerFixtures } from './_teardown.mjs';

const SB = process.env.SB_URL, KEY = process.env.SB_KEY, DBURL = process.env.SB_DB_URL;
const TEST_REF = 'tileejdviuvijumjeplv';
if (!SB || !KEY || !SB.includes(TEST_REF)) { console.log('  FAIL SB_URL / SB_KEY must name demohub-rebuild-check'); process.exit(1); }
if (!DBURL || !DBURL.includes(TEST_REF)) { console.log('  FAIL SB_DB_URL must name demohub-rebuild-check'); process.exit(1); }
for (const ref of ['dkgjvsstbgnhcfboqqnd', 'ecapmcyumpjjgjwuokyv', 'eubbgurdwqmwqduamwhn']) if (DBURL.includes(ref) || SB.includes(ref)) { console.log('  FAIL REFUSING: production or retired project'); process.exit(1); }
const watchdog = setTimeout(() => { console.log('  FAIL watchdog: suite exceeded 10 minutes'); process.exit(1); }, 10 * 60 * 1000);

const spy = installSpy();
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j }; };
const rpc = async (fn, args) => { const r = await fetch(`${SB}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H, body: JSON.stringify(args) }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j, text: t }; };
const one = (r) => (r && Array.isArray(r.body) ? r.body[0] : null);
const val = (r) => (Array.isArray(r.body) ? r.body[0] : r.body) || {};
const LA = 'America/Los_Angeles';
function dayP(n) { const d = new Date(Date.now() + n * 864e5); const p = {}; for (const x of new Intl.DateTimeFormat('en-US', { timeZone: LA, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)) p[x.type] = p[x.type] || x.value; return `${p.year}-${p.month}-${p.day}`; }
const capture = (p) => p.then(r => ({ ok: true, r }), e => ({ ok: false, e }));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
ENV.PROVISIONAL_HOLDS_ENABLED = 'true';
ENV.CONNECTED_CHECKOUT_ENABLED = 'true';
const ACCT = 'acct_unpaid_' + uniq('x').replace(/-/g, '');
const CATALOG = [{ id: 'cat-1', ...FIXTURE_PRODUCTS[0] }];
const CRON = { authorization: 'Bearer ' + ENV.CRON_SECRET };

const pgc = () => new pg.Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });
const c1 = pgc(), c2 = pgc(); await c1.connect(); await c2.connect();

console.log('\nFixtures');
async function mkRetailer(prefix, connected) {
  const slug = uniq(prefix);
  const id = one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug, name: connected ? 'Unpaid Connected Market' : 'Unpaid Keeps-all Market', billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active',
    platform_keeps_all: !connected, stripe_account_id: connected ? ACCT : null, stripe_charges_enabled: connected, stripe_payouts_enabled: connected, stripe_account_status: connected ? 'active' : null, timezone: LA, auto_confirm_bookings: true, cancellation_mode: 'refundable', verification_status: 'approved' }) })).id;
  await db('settings', { method: 'POST', body: JSON.stringify({ retailer_id: id, demo_fee: 150, advance_booking_days: 0 }) });
  const venue = one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: id, name: 'Main', address: '1 Unpaid St', demo_fee: 150, availability: HOURLY }) })).id;
  return { id, slug, venue, connected };
}
const K = await mkRetailer('upk', false), C = await mkRetailer('upc', true);
const brandIds = [];
async function mkBrand(label, { coi }) {
  const email = `${uniq(label)}@fixture.test`;
  const body = { email, company_name: label + ' Brand', contact_name: label + ' Contact', phone: '555-0172', is_verified: true, products: CATALOG };
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
const A = await mkBrand('una', { coi: true }), B = await mkBrand('unb', { coi: false });
for (const brand of [A, B]) for (const store of [K, C]) await signAgreement(brand, store);
let dayN = 40;
const bookRaw = (cookie, store, date, time = '13:00') => callRoute('book.js', req({ body: { retailer_slug: store.slug, venue_id: store.venue, demo_date: date, demo_time: time, product_skus: [CATALOG[0]], op_key: ('op-' + uniq('k')).replace(/[^A-Za-z0-9_-]/g, '') }, cookies: { dh_brand_session: cookie } }));
async function bookAs(cookie, store, date) {
  const bk = await bookRaw(cookie, store, date || dayP(dayN++));
  const id = bk.body && bk.body.booking_id;
  if (!id) throw new Error('book failed ' + bk.statusCode + ' ' + JSON.stringify(bk.body).slice(0, 200));
  return id;
}
const stateOf = async (id) => one(await db(`bookings?id=eq.${id}&select=status,payment_status,unpaid_expires_at,created_at,held_expires_at,payment_intent_id,demo_date`));
const allocsOf = async (id) => (await db(`payment_allocations?booking_id=eq.${id}&select=id,payment_group_id,customer_amount`)).body || [];
const groupOf = async (gid) => one(await db(`payment_groups?id=eq.${gid}&select=id,status,total_customer_amount,unpaid_expiry_started_at,unpaid_expired_at`));
const attemptsOf = async (gid) => (await db(`payment_attempts?payment_group_id=eq.${gid}&select=id,status,stripe_checkout_session_id,last_error,reserved_at&order=created_at.asc`)).body || [];
const checkoutAs = (ids, cookie) => callRoute('checkout.js', req({ body: { booking_ids: ids }, cookies: { dh_brand_session: cookie } }));
// fixture only: put a booking's deadline in the past. The trigger that keeps the deadline fixed is bypassed for this
// one statement on a direct connection; scenario 0 proves the trigger through the ordinary path first.
async function pastDeadline(...ids) {
  await c1.query('BEGIN'); await c1.query("SET LOCAL session_replication_role = 'replica'");
  await c1.query("UPDATE bookings SET unpaid_expires_at = timestamptz '2001-01-01' WHERE id = ANY($1::uuid[])", [ids]);
  await c1.query('COMMIT');
}
// run the worker until `done()` is true (the practice database can hold other due rows; a run handles 25)
// Time passing, for the fixtures of this suite only (0126): a group whose expiry has begun is moved past its quiescence
// point (the fence is backdated, its creation leases are in the past, its next-check time is cleared). Without this a
// group needs lease + settle (150 s) of real time between begin and finalize, which tests/unpaid_expiry_fencing.test.mjs
// proves on purpose; here the other rules are under test.
async function ageAll() {
  const ids = ((await db(`payment_groups?retailer_id=in.(${K.id},${C.id})&unpaid_expired_at=is.null&select=id`)).body || []).map(g => g.id);
  if (!ids.length) return;
  await db(`payment_groups?id=in.(${ids.join(',')})&unpaid_expiry_started_at=not.is.null`, { method: 'PATCH', body: JSON.stringify({ unpaid_expiry_started_at: '2001-01-02T00:00:00Z', unpaid_expiry_next_check_at: null }) });
  await db(`payment_attempts?payment_group_id=in.(${ids.join(',')})&create_lease_until=not.is.null`, { method: 'PATCH', body: JSON.stringify({ create_lease_until: '2001-01-02T00:00:00Z' }) });
}
async function sweepUntil(done, max = 14) {
  let last = null;
  for (let i = 0; i < max; i++) { await ageAll(); last = await callRoute('unpaid-sweep.js', req({ body: {}, headers: CRON })); if (await done(last)) return last; }
  return last;
}
const sweepOnce = () => callRoute('unpaid-sweep.js', req({ body: {}, headers: CRON }));
ok('fixtures: keeps-all store, connected store, brand A (approved certificate), brand B (none)', !!K.id && !!C.id && !!A.cookie && !!B.cookie);

try {
  console.log('\n0. the deadline belongs to the database');
  {
    const b = await bookAs(A.cookie, C);
    const s = await stateOf(b);
    const gap = Date.parse(s.unpaid_expires_at) - Date.parse(s.created_at);
    ok('0a. a new unpaid booking carries a deadline 24 hours after its creation', s.status === 'pending_payment' && Math.abs(gap - 24 * 3600 * 1000) < 2000, JSON.stringify(s));
    await db(`bookings?id=eq.${b}`, { method: 'PATCH', body: JSON.stringify({ unpaid_expires_at: new Date(Date.now() + 30 * 864e5).toISOString() }) });
    const after = await stateOf(b);
    ok('0b. a write through the API cannot move the deadline', after.unpaid_expires_at === s.unpaid_expires_at, JSON.stringify(after));
    const un = await sweepOnce();
    ok('0c. the worker runs, authenticated, and leaves a booking that is not due alone', un.statusCode === 200 && (await stateOf(b)).status === 'pending_payment', JSON.stringify(un.body).slice(0, 200));
    const noAuth = await callRoute('unpaid-sweep.js', req({ body: {} }));
    ok('0d. without the cron secret the worker refuses', noAuth.statusCode === 401);
    const notDue = val(await rpc('expire_unpaid_booking', { p_booking_id: b }));
    ok('0e. expire_unpaid_booking answers not_due before the deadline', notDue.outcome === 'not_due', JSON.stringify(notDue));
  }

  console.log('\n1. checkout never started');
  {
    const date = dayP(dayN++);
    const b = await bookAs(A.cookie, C, date);
    const b2 = await bookAs(B.cookie, K);   // no certificate at a keeps-all store: a held, unpaid, never-authorized booking
    ok('1a. the uncovered booking at the keeps-all store is held and has a deadline too', (await stateOf(b2)).status === 'held' && !!(await stateOf(b2)).unpaid_expires_at);
    await pastDeadline(b, b2);
    const before = spy.calls.stripe.length;
    await sweepUntil(async () => (await stateOf(b)).status === 'expired' && (await stateOf(b2)).status === 'expired');
    ok('1b. both are expired by the sweep, with no provider call (there is no payment group)', (await stateOf(b)).status === 'expired' && (await stateOf(b2)).status === 'expired' && spy.calls.stripe.length === before, JSON.stringify({ a: await stateOf(b), b: await stateOf(b2) }));
    const again = val(await rpc('expire_unpaid_booking', { p_booking_id: b }));
    ok('1c. a second expiry of the same booking changes nothing (not_unpaid)', again.outcome === 'not_unpaid', JSON.stringify(again));
    const co = await checkoutAs([b], A.cookie);
    ok('1d. the expired booking cannot be paid: 409 not_payable_state and no allocation', co.statusCode === 409 && co.body.error === 'not_payable_state' && (await allocsOf(b)).length === 0, co.statusCode + ' ' + JSON.stringify(co.body));
  }

  console.log('\n2. an open session');
  for (const store of [C, K]) {
    const label = store === C ? 'connected store' : 'keeps-all store';
    const date = dayP(dayN++);
    const b = await bookAs(A.cookie, store, date);
    const co = await checkoutAs([b], A.cookie);
    const gid = co.body && co.body.payment_group_id, sid = co.body && co.body.session_id;
    ok(`2a. ${label}: checkout opened one session for the booking`, co.statusCode === 200 && !!gid && !!sid, co.statusCode + ' ' + JSON.stringify(co.body).slice(0, 160));
    // capacity: fill the slot to its limit so the release can be observed
    let filled = 0; for (let i = 0; i < 12; i++) { const r = await bookRaw(A.cookie, store, date); if (r.statusCode === 200) filled++; else break; }
    const full = await bookRaw(A.cookie, store, date);
    ok(`2b. ${label}: the slot is full while the unpaid booking holds its place`, full.statusCode === 409 && full.body.error === 'slot_full', full.statusCode + ' ' + JSON.stringify(full.body).slice(0, 120) + ' filled ' + filled);
    await pastDeadline(b);
    await sweepUntil(async () => (await stateOf(b)).status === 'expired');
    const g = await groupOf(gid), at = await attemptsOf(gid), s = await stateOf(b);
    ok(`2c. ${label}: the session was expired on the provider, the attempt recorded expired, the booking released and the group closed`, s.status === 'expired' && s.payment_status === 'unpaid' && spy.sessions.get(sid).status === 'expired' && at.length === 1 && at[0].status === 'expired' && g.status === 'failed' && !!g.unpaid_expired_at && !!g.unpaid_expiry_started_at, JSON.stringify({ s, g, at }));
    ok(`2d. ${label}: nothing was deleted: the allocation, the attempt and the group are still there`, (await allocsOf(b)).length === 1 && at.length === 1 && !!g.id);
    const free1 = await bookRaw(A.cookie, store, date), free2 = await bookRaw(A.cookie, store, date);
    ok(`2e. ${label}: exactly one place was released (one new booking fits, a second is slot_full)`, free1.statusCode === 200 && free2.statusCode === 409 && free2.body.error === 'slot_full', free1.statusCode + ' / ' + free2.statusCode);
    const fin = val(await rpc('finalize_unpaid_group_expiry', { p_group_id: gid })), beg = val(await rpc('begin_unpaid_group_expiry', { p_group_id: gid }));
    await sweepOnce();
    ok(`2f. ${label}: a rerun is a no-op (already_expired) and the booking stays expired`, fin.outcome === 'already_expired' && beg.outcome === 'already_expired' && (await stateOf(b)).status === 'expired', JSON.stringify({ fin, beg }));
    const retry = await checkoutAs([b], A.cookie);
    ok(`2g. ${label}: paying it now is refused before any new session`, retry.statusCode === 409 && retry.body.error === 'not_payable_state' && (await attemptsOf(gid)).length === 1, retry.statusCode + ' ' + JSON.stringify(retry.body));
    // 7. a late payment for that expired session is not applied
    const late = val(await rpc('apply_verified_payment', { p_session_id: sid, p_payment_intent: 'pi_late_' + uniq('p'), p_charge: 'ch_late_' + uniq('c'), p_amount: g.total_customer_amount, p_currency: 'usd',
      p_connect_dest: store.connected ? ACCT : null, p_on_behalf_of: store.connected ? ACCT : null, p_application_fee: store.connected ? 1000 : null, p_transfer_id: null, p_fee_id: null }));
    ok(`7. ${label}: a late payment on the expired attempt opens a reconciliation case and changes no booking`, late.outcome === 'contradiction' && !!late.case_id && (await stateOf(b)).status === 'expired' && (await stateOf(b)).payment_status === 'unpaid', JSON.stringify(late));
  }

  console.log('\n3. a session that completed');
  {
    const b = await bookAs(A.cookie, K);
    const co = await checkoutAs([b], A.cookie);
    const gid = co.body.payment_group_id, sid = co.body.session_id;
    Object.assign(spy.sessions.get(sid), { status: 'complete', payment_status: 'paid' });
    await pastDeadline(b);
    await sweepUntil(async () => !!(await groupOf(gid)).unpaid_expiry_started_at);
    const g1 = await groupOf(gid), s1 = await stateOf(b), at1 = await attemptsOf(gid);
    ok('3a. a completed session is never expired: the booking keeps its place, the attempt stays open, the group is only marked', s1.status === 'pending_payment' && at1[0].status === 'open' && g1.status === 'session_created' && !!g1.unpaid_expiry_started_at && !g1.unpaid_expired_at && spy.sessions.get(sid).status === 'complete', JSON.stringify({ s1, g1, at1 }));
    const fin = val(await rpc('finalize_unpaid_group_expiry', { p_group_id: gid }));
    ok('3b. finalize refuses while the attempt is live', fin.outcome === 'attempt_live', JSON.stringify(fin));
    const paid = val(await rpc('apply_verified_payment', { p_session_id: sid, p_payment_intent: 'pi_win_' + uniq('p'), p_charge: 'ch_win_' + uniq('c'), p_amount: g1.total_customer_amount, p_currency: 'usd',
      p_connect_dest: null, p_on_behalf_of: null, p_application_fee: null, p_transfer_id: null, p_fee_id: null }));
    const s2 = await stateOf(b);
    ok('3c. the payment is applied through the ordinary path although expiry had begun', paid.outcome === 'applied' || paid.outcome === 'paid' || s2.payment_status === 'paid', JSON.stringify({ paid, s2 }));
    await sweepUntil(async () => !(await groupOf(gid)).unpaid_expiry_started_at);
    const g2 = await groupOf(gid);
    ok('3d. the next sweep sees the payment won and clears the marker; nothing is expired', g2.status === 'paid' && !g2.unpaid_expiry_started_at && !g2.unpaid_expired_at && (await stateOf(b)).status !== 'expired', JSON.stringify(g2));
  }

  console.log('\n4. a reservation with no session id');
  const claimSql = 'SELECT * FROM checkout_claim_group($1,$2,$3::uuid[],$4,$5,1000,$6)';
  async function reservedGroup(store) {
    const b = await bookAs(A.cookie, store);
    const cl = await c1.query(claimSql, [A.id, store.id, [b], !store.connected, store.connected ? ACCT : null, false]);
    const gid = cl.rows[0].payment_group_id;
    const rv = val(await rpc('reserve_payment_attempt', { p_group_id: gid, p_hash: 'h-' + uniq('h'), p_schema: 1 }));
    return { b, gid, attempt: rv.attempt_id };
  }
  {
    const r = await reservedGroup(C);
    await pastDeadline(r.b);
    // an OLD reservation (first made 40 minutes ago) that was just handed out again: its age decides nothing, its lease does
    await db(`payment_attempts?id=eq.${r.attempt}`, { method: 'PATCH', body: JSON.stringify({ reserved_at: new Date(Date.now() - 40 * 60 * 1000).toISOString() }) });
    let seen = null;
    for (let i = 0; i < 6 && !(await groupOf(r.gid)).unpaid_expiry_started_at; i++) seen = await sweepOnce();
    seen = await sweepOnce();
    const g4 = await groupOf(r.gid);
    ok('4a. while its creation lease may still be in use the reservation blocks the group, however old it is: nothing released, attempt still reserved, no provider search', (await stateOf(r.b)).status === 'pending_payment' && (await attemptsOf(r.gid))[0].status === 'reserved' && !!g4.unpaid_expiry_started_at && !g4.unpaid_expired_at, JSON.stringify(seen && seen.body).slice(0, 200));
    const before = spy.calls.stripe.length;
    await sweepUntil(async () => (await stateOf(r.b)).status === 'expired');
    const listed = spy.calls.stripe.slice(before).some(c => /\/v1\/checkout\/sessions\?/.test(c.url) && String(c.method).toUpperCase() === 'GET');
    const at = await attemptsOf(r.gid);
    ok('4b. after the grace period the provider is searched, no session is found, the reservation is failed and the booking released', listed && (await stateOf(r.b)).status === 'expired' && at[0].status === 'failed' && /no_session_found/.test(at[0].last_error || '') && (await groupOf(r.gid)).status === 'failed', JSON.stringify({ listed, at }));
  }
  {
    // an unbound session exists on the provider for the group (created, never registered)
    const r = await reservedGroup(K);
    const made = await (await fetch('https://api.stripe.com/v1/checkout/sessions', { method: 'POST', headers: { 'Idempotency-Key': 'co-' + r.gid + '-' + r.attempt }, body: new URLSearchParams({ 'metadata[payment_group_id]': r.gid, 'line_items[0][price_data][unit_amount]': '15000', 'line_items[0][quantity]': '1' }).toString() })).json();
    await db(`payment_attempts?id=eq.${r.attempt}`, { method: 'PATCH', body: JSON.stringify({ reserved_at: new Date(Date.now() - 40 * 60 * 1000).toISOString() }) });
    await pastDeadline(r.b);
    await sweepUntil(async () => (await stateOf(r.b)).status === 'expired');
    const at = await attemptsOf(r.gid);
    ok('4c. an unbound open session found on the provider is expired there first and recorded on the failed reservation', spy.sessions.get(made.id).status === 'expired' && at[0].status === 'failed' && at[0].stripe_checkout_session_id === made.id && (await stateOf(r.b)).status === 'expired', JSON.stringify(at));
  }
  {
    const r = await reservedGroup(K);
    const made = await (await fetch('https://api.stripe.com/v1/checkout/sessions', { method: 'POST', headers: { 'Idempotency-Key': 'co-' + r.gid + '-' + r.attempt }, body: new URLSearchParams({ 'metadata[payment_group_id]': r.gid, 'line_items[0][price_data][unit_amount]': '15000', 'line_items[0][quantity]': '1' }).toString() })).json();
    Object.assign(spy.sessions.get(made.id), { status: 'complete', payment_status: 'paid' });
    await db(`payment_attempts?id=eq.${r.attempt}`, { method: 'PATCH', body: JSON.stringify({ reserved_at: new Date(Date.now() - 40 * 60 * 1000).toISOString() }) });
    await pastDeadline(r.b);
    let lastBody = null;
    await sweepUntil(async (res) => { lastBody = res.body; return !!(await groupOf(r.gid)).unpaid_expiry_started_at; });
    await sweepOnce();
    ok('4d. an unbound session that completed blocks the group: the reservation is kept and nothing is released', (await stateOf(r.b)).status === 'pending_payment' && (await attemptsOf(r.gid))[0].status === 'reserved' && !(await groupOf(r.gid)).unpaid_expired_at, JSON.stringify(lastBody).slice(0, 240));
  }

  console.log('\n5. demos paid together end together');
  {
    const b1 = await bookAs(A.cookie, C), b2 = await bookAs(A.cookie, C);
    const co = await checkoutAs([b1, b2], A.cookie);
    const gid = co.body.payment_group_id;
    await pastDeadline(b1);   // only the earlier one is due
    await sweepUntil(async () => (await stateOf(b1)).status === 'expired');
    const g = await groupOf(gid);
    ok('5a. both bookings of the group are released when the earliest deadline passes', co.statusCode === 200 && (await stateOf(b1)).status === 'expired' && (await stateOf(b2)).status === 'expired' && g.status === 'failed', JSON.stringify({ g, s2: await stateOf(b2) }));
    ok('5b. the immutable allocations are kept and still add up to the group total', (await allocsOf(b1)).length === 1 && (await allocsOf(b2)).length === 1 && (await allocsOf(b1))[0].customer_amount + (await allocsOf(b2))[0].customer_amount === g.total_customer_amount);
  }

  console.log('\n6. after the deadline, before the sweep');
  {
    const b = await bookAs(A.cookie, C);
    await pastDeadline(b);
    const before = spy.calls.stripe.length;
    const co = await checkoutAs([b], A.cookie);
    ok('6a. a due booking the sweep has not reached yet is refused by the claim: 409 unpaid_expired, no group, no provider call', co.statusCode === 409 && co.body.error === 'unpaid_expired' && !!co.body.message && (await allocsOf(b)).length === 0 && spy.calls.stripe.length === before, co.statusCode + ' ' + JSON.stringify(co.body));
    const b2 = await bookAs(A.cookie, C);
    const first = await checkoutAs([b2], A.cookie);
    const gid = first.body.payment_group_id, sid = first.body.session_id;
    spy.sessions.get(sid).status = 'expired';   // the brand's first session ran out on its own
    await pastDeadline(b2);
    const before2 = spy.calls.stripe.filter(c => String(c.method).toUpperCase() === 'POST' && /\/checkout\/sessions$/.test(c.url.replace(/\?.*$/, ''))).length;
    const again = await checkoutAs([b2], A.cookie);
    const after2 = spy.calls.stripe.filter(c => String(c.method).toUpperCase() === 'POST' && /\/checkout\/sessions$/.test(c.url.replace(/\?.*$/, ''))).length;
    ok('6b. an existing group past its deadline gets no new session: 409 unpaid_expired and no session create', again.statusCode === 409 && again.body.error === 'unpaid_expired' && after2 === before2 && (await attemptsOf(gid)).filter(a => a.status === 'reserved').length === 0, again.statusCode + ' ' + JSON.stringify(again.body));
  }

  console.log('\n8. races on two connections');
  {
    // begin against reserve: a reservation requested while expiry is beginning waits and is then refused
    const b = await bookAs(A.cookie, K);
    const cl = await c1.query(claimSql, [A.id, K.id, [b], true, null, false]);
    const gid = cl.rows[0].payment_group_id;
    await pastDeadline(b);
    await c1.query('BEGIN');
    const beg = await c1.query('SELECT begin_unpaid_group_expiry($1) AS r', [gid]);
    const pending = capture(c2.query('SELECT reserve_payment_attempt($1,$2,1) AS r', [gid, 'h-race']));
    await sleep(600);
    await c1.query('COMMIT');
    const rv = await pending;
    ok('8a. begin holds the group; the reservation waits and is then refused unpaid_expired; no attempt was created', beg.rows[0].r.outcome === 'expiring' && !rv.ok && /unpaid_expired/.test(String(rv.e && rv.e.message)) && (await attemptsOf(gid)).length === 0, JSON.stringify({ beg: beg.rows[0].r, rv: rv.ok ? rv.r.rows : String(rv.e.message) }));
    const early = val(await rpc('finalize_unpaid_group_expiry', { p_group_id: gid }));
    const stillHeld = (await stateOf(b)).status;
    const fin = val(await rpc('finalize_unpaid_group_expiry', { p_group_id: gid, p_now: new Date(Date.now() + 10 * 60 * 1000).toISOString() }));
    ok('8b-. with no attempt at all, finalize still refuses before the quiescence point measured from the fence', early.outcome === 'not_quiescent' && stillHeld === 'pending_payment', JSON.stringify(early));
    ok('8b. finalize then releases it once', fin.outcome === 'expired' && fin.released.length === 1 && (await stateOf(b)).status === 'expired', JSON.stringify(fin));
  }
  {
    // the reverse: a reservation committed first; begin sees it and hands it to the worker
    const b = await bookAs(A.cookie, K);
    const cl = await c1.query(claimSql, [A.id, K.id, [b], true, null, false]);
    const gid = cl.rows[0].payment_group_id;
    await c1.query('BEGIN');
    const rv = await c1.query('SELECT reserve_payment_attempt($1,$2,1) AS r', [gid, 'h-race2']);
    await pastDeadline2(b);
    const pending = capture(c2.query('SELECT begin_unpaid_group_expiry($1) AS r', [gid]));
    await sleep(600);
    await c1.query('COMMIT');
    const beg = await pending;
    ok('8c. a reservation that committed first is reported by begin as the live attempt', rv.rows[0].r.outcome === 'reserved' && beg.ok && beg.r.rows[0].r.outcome === 'expiring' && beg.r.rows[0].r.live_attempt && beg.r.rows[0].r.live_attempt.status === 'reserved', JSON.stringify(beg.ok ? beg.r.rows[0].r : String(beg.e.message)));
    const fin = val(await rpc('finalize_unpaid_group_expiry', { p_group_id: gid }));
    ok('8d. finalize refuses while that reservation is live; the booking keeps its place', fin.outcome === 'attempt_live' && (await stateOf(b)).status === 'pending_payment', JSON.stringify(fin));
  }
  {
    // claim against expire_unpaid_booking: the claim holds the booking lock; the expiry waits and then sees the group
    const b = await bookAs(A.cookie, K);
    await c1.query('BEGIN');
    await c1.query(claimSql, [A.id, K.id, [b], true, null, false]);
    // the controlled clock (p_now) stands in for the deadline here: the row is locked by the claim, so it cannot be rewritten
    const pending = capture(c2.query("SELECT expire_unpaid_booking($1, now() + interval '25 hours') AS r", [b]));
    await sleep(600);
    await c1.query('COMMIT');
    const ex = await pending;
    ok('8e. a claim in progress wins the booking lock; the one-step expiry waits and answers has_group, releasing nothing', ex.ok && ex.r.rows[0].r.outcome === 'has_group' && (await stateOf(b)).status === 'pending_payment', JSON.stringify(ex.ok ? ex.r.rows[0].r : String(ex.e.message)));
  }
  {
    // the one-step expiry first; the claim waits and is then refused
    const b = await bookAs(A.cookie, K);
    await pastDeadline(b);
    await c1.query('BEGIN');
    const ex = await c1.query('SELECT expire_unpaid_booking($1) AS r', [b]);
    const pending = capture(c2.query(claimSql, [A.id, K.id, [b], true, null, false]));
    await sleep(600);
    await c1.query('COMMIT');
    const cl = await pending;
    ok('8f. an expiry in progress wins; the claim waits and is refused not_payable_state; no group exists', ex.rows[0].r.outcome === 'expired' && !cl.ok && /not_payable_state/.test(String(cl.e && cl.e.message)) && (await allocsOf(b)).length === 0, cl.ok ? JSON.stringify(cl.r.rows) : String(cl.e.message));
  }

  console.log('\n9. provider unreadable');
  {
    const b = await bookAs(A.cookie, C);
    const co = await checkoutAs([b], A.cookie);
    const gid = co.body.payment_group_id, sid = co.body.session_id;
    await pastDeadline(b);
    spy.faults.push({ url: '/v1/checkout/sessions/' + sid, status: 503, message: 'provider down' });
    await sweepUntil(async () => !!(await groupOf(gid)).unpaid_expiry_started_at);
    await sweepOnce();
    ok('9a. while the provider cannot be read the group stays blocked: booking kept, attempt open, session untouched', (await stateOf(b)).status === 'pending_payment' && (await attemptsOf(gid))[0].status === 'open' && spy.sessions.get(sid).status === 'open' && !(await groupOf(gid)).unpaid_expired_at);
    spy.faults.length = 0;
    await sweepUntil(async () => (await stateOf(b)).status === 'expired');
    ok('9b. once the provider answers again the same group completes its expiry', (await stateOf(b)).status === 'expired' && (await groupOf(gid)).status === 'failed' && spy.sessions.get(sid).status === 'expired');
    const hb = (await db(`cron_heartbeat?cron_name=eq.unpaid-sweep&select=outcome,summary&order=ran_at.desc&limit=1`)).body || [];
    ok('9c. each run leaves a heartbeat row with its counts', hb.length === 1 && hb[0].outcome === 'succeeded' && hb[0].summary && typeof hb[0].summary.scanned === 'number', JSON.stringify(hb).slice(0, 200));
    const stat = await callRoute('find-retailer.js', req({ body: { action: 'status' } }));
    const jobs = stat.body && stat.body.checks && stat.body.checks.cron && stat.body.checks.cron.jobs;
    ok('9d. the status route lists unpaid-sweep as a required job and reads its fresh heartbeat as healthy', !!jobs && !!jobs['unpaid-sweep'] && jobs['unpaid-sweep'].required === true && jobs['unpaid-sweep'].ok === true, JSON.stringify(jobs || stat.body).slice(0, 300));
  }
} finally {
  clearTimeout(watchdog);
  try { await c1.query('ROLLBACK'); } catch (_) {}
  for (const c of [c1, c2]) { try { await c.end(); } catch (_) {} }
  spy.restore();
  try { console.log('\n:: teardown ::'); const counts = await teardownRetailerFixtures({ sbUrl: SB, sbKey: KEY, retailerIds: [K.id, C.id], brandIds, log: (m) => console.log(m) }); console.log('  teardown:', JSON.stringify(counts)); }
  catch (e) { console.log('  teardown failed (rows left on demohub-rebuild-check):', String((e && e.message) || e)); }
}
process.exit(summary('unpaid reservation deadline (routes + worker + database, demohub-rebuild-check)') ? 0 : 1);

// the same fixture write on the second connection, for the scenarios where the first holds an open transaction
async function pastDeadline2(...ids) {
  await c2.query('BEGIN'); await c2.query("SET LOCAL session_replication_role = 'replica'");
  await c2.query("UPDATE bookings SET unpaid_expires_at = timestamptz '2001-01-01' WHERE id = ANY($1::uuid[])", [ids]);
  await c2.query('COMMIT');
}
