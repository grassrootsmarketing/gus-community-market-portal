// tests/attempt_request_snapshot.test.mjs (2026-11-22, Codex brand-walk order item 4): a payment attempt's provider
// request is frozen when the attempt is reserved (migration 0125) and a retry sends exactly that request.
// demohub-rebuild-check, Stripe spied. The spy now behaves like the provider for a reused Idempotency-Key: the same key
// with different parameters is refused (idempotency_error), so a test that only replayed by key can no longer pass.
//
//   1. create succeeds, bind fails, the venue is renamed (what a deploy or a rename does to a rebuilt body), retry:
//      the stored request is sent, the SAME session comes back and is bound; no mismatch, no second session
//   2. the stored request cannot be changed through the API
//   3. a reservation from before 0125 (no stored request) whose session was created by the older build: recovered
//   4. the same for a session created by the build that named the two parts of the amount: recovered on the second shape
//   5. a reservation whose original request cannot be established: no other payable attempt, reservation kept
//   6. simultaneous retries share the one session
//   7. an expired session ends its reservation and the NEXT generation freezes its own, current request
//   8. a keeps-all store (no split text at all) behaves the same
import pg from 'pg';
import { installSpy, callRoute, req, ok, summary, uniq, ENV, FIXTURE_PRODUCTS } from './_route.mjs';
import { HOURLY } from './_fixture_availability.mjs';
import { teardownRetailerFixtures } from './_teardown.mjs';

const SB = process.env.SB_URL, KEY = process.env.SB_KEY, DBURL = process.env.SB_DB_URL;
const TEST_REF = 'tileejdviuvijumjeplv';
if (!SB || !KEY || !SB.includes(TEST_REF)) { console.log('  FAIL SB_URL / SB_KEY must name demohub-rebuild-check'); process.exit(1); }
if (!DBURL || !DBURL.includes(TEST_REF)) { console.log('  FAIL SB_DB_URL must name demohub-rebuild-check'); process.exit(1); }
for (const ref of ['dkgjvsstbgnhcfboqqnd', 'ecapmcyumpjjgjwuokyv', 'eubbgurdwqmwqduamwhn']) if (DBURL.includes(ref) || SB.includes(ref)) { console.log('  FAIL REFUSING: production or retired project'); process.exit(1); }
const watchdog = setTimeout(() => { console.log('  FAIL watchdog: suite exceeded 8 minutes'); process.exit(1); }, 8 * 60 * 1000);

const spy = installSpy();
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j }; };
const one = (r) => (r && Array.isArray(r.body) ? r.body[0] : null);
const LA = 'America/Los_Angeles';
function dayP(n) { const d = new Date(Date.now() + n * 864e5); const p = {}; for (const x of new Intl.DateTimeFormat('en-US', { timeZone: LA, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)) p[x.type] = p[x.type] || x.value; return `${p.year}-${p.month}-${p.day}`; }
ENV.CONNECTED_CHECKOUT_ENABLED = 'true';
const ACCT = 'acct_snap_' + uniq('x').replace(/-/g, '');
const CATALOG = [{ id: 'cat-1', ...FIXTURE_PRODUCTS[0] }];
const c1 = new pg.Client({ connectionString: DBURL, ssl: { rejectUnauthorized: false } }); await c1.connect();

console.log('\nFixtures');
async function mkRetailer(prefix, connected) {
  const slug = uniq(prefix);
  const id = one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug, name: connected ? 'Snapshot Connected Market' : 'Snapshot Keeps-all Market', billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active',
    platform_keeps_all: !connected, stripe_account_id: connected ? ACCT : null, stripe_charges_enabled: connected, stripe_payouts_enabled: connected, stripe_account_status: connected ? 'active' : null, timezone: LA, auto_confirm_bookings: true, cancellation_mode: 'refundable', verification_status: 'approved' }) })).id;
  await db('settings', { method: 'POST', body: JSON.stringify({ retailer_id: id, demo_fee: 20, advance_booking_days: 0 }) });
  const venue = one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: id, name: 'Main', address: '1 Snapshot St', demo_fee: 20, availability: HOURLY }) })).id;
  return { id, slug, venue, connected };
}
const C = await mkRetailer('snc', true), K = await mkRetailer('snk', false);
const brandIds = [];
const email = `${uniq('snap')}@fixture.test`;
const A = { id: one(await db('brands', { method: 'POST', body: JSON.stringify({ email, company_name: 'Snapshot Brand', contact_name: 'Snapshot Contact', phone: '555-0174', is_verified: true, products: CATALOG, default_coi_url: 'brands/snap.pdf', default_coi_expires: dayP(400), coi_verification_status: 'approved' }) })).id };
brandIds.push(A.id);
{
  const tok = one(await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: A.id, email, token: 'tk-' + uniq('t'), expires_at: new Date(Date.now() + 36e5).toISOString() }) }));
  A.cookie = (await callRoute('brand-account.js', req({ body: { action: 'verify', token: tok.token } }))).cookie('dh_brand_session');
}
for (const store of [C, K]) {
  const chk = await callRoute('booking.js', req({ body: { action: 'agreement-check', retailer_slug: store.slug }, cookies: { dh_brand_session: A.cookie } }));
  await callRoute('booking.js', req({ body: { action: 'agreement-sign', retailer_slug: store.slug, signed_name: 'Fixture Owner', policy_hash: chk.body.policies.policy_hash }, cookies: { dh_brand_session: A.cookie } }));
}
let dayN = 60;
async function bookAs(store) {
  const bk = await callRoute('book.js', req({ body: { retailer_slug: store.slug, venue_id: store.venue, demo_date: dayP(dayN++), demo_time: '13:00', product_skus: [CATALOG[0]], op_key: ('op-' + uniq('k')).replace(/[^A-Za-z0-9_-]/g, '') }, cookies: { dh_brand_session: A.cookie } }));
  if (!bk.body || !bk.body.booking_id) throw new Error('book failed ' + bk.statusCode + ' ' + JSON.stringify(bk.body).slice(0, 200));
  return bk.body.booking_id;
}
const checkout = (ids) => callRoute('checkout.js', req({ body: { booking_ids: ids }, cookies: { dh_brand_session: A.cookie } }));
const allocGroup = async (b) => (one(await db(`payment_allocations?booking_id=eq.${b}&select=payment_group_id`)) || {}).payment_group_id;
const attemptsOf = async (gid) => (await db(`payment_attempts?payment_group_id=eq.${gid}&select=id,status,generation,stripe_checkout_session_id,provider_request,provider_request_version&order=generation.asc`)).body || [];
const creates = () => spy.calls.stripe.filter(c => String(c.method).toUpperCase() === 'POST' && /\/checkout\/sessions$/.test(c.url.replace(/\?.*$/, '')));
const dec = (body) => body.split('&').map(kv => kv.split('=').map(decodeURIComponent));
const enc = (pairs) => pairs.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
const SPLIT = /\. \$[\d.]+ store demo fee plus \$[\d.]+ Demohub booking fee$/;
// the request shapes this route sent before 0125: no expires_at, with or without the split text
const withoutExpiry = (body) => enc(dec(body).filter(([k]) => k !== 'expires_at'));
const withoutSplit = (body) => enc(dec(withoutExpiry(body)).map(([k, v]) => [k, /\[description\]$/.test(k) ? v.replace(SPLIT, '') : v]));
// a checkout whose session is created on the provider and whose bind then fails: a reservation with a session behind it
async function failedBind(store) {
  const b = await bookAs(store);
  spy.faults.push({ url: '/rpc/register_payment_attempt', method: 'POST', once: true, status: 500, message: 'injected bind failure' });
  const before = spy.sessions.size;
  const r = await checkout([b]);
  const gid = await allocGroup(b);
  const at = await attemptsOf(gid);
  return { b, gid, r, at, key: `co-${gid}-${at[0] && at[0].id}`, sessionsMade: spy.sessions.size - before };
}
// fixture only: make a reservation look as it did before 0125 (no stored request); the write-once trigger is bypassed on a direct connection
async function forgetRequest(attemptId) {
  await c1.query('BEGIN'); await c1.query("SET LOCAL session_replication_role = 'replica'");
  await c1.query('UPDATE payment_attempts SET provider_request = NULL, provider_request_version = NULL WHERE id = $1', [attemptId]);
  await c1.query('COMMIT');
}
ok('fixtures: connected store, keeps-all store, one insured brand', !!C.id && !!K.id && !!A.cookie);

try {
  console.log('\n1. bind fails, the venue is renamed, retry');
  {
    const f = await failedBind(C);
    const sentFirst = creates().slice(-1)[0].body;
    ok('1a. the first checkout created one session, failed to bind it and left a reservation holding the exact request that was sent', f.r.statusCode === 503 && f.sessionsMade === 1 && f.at.length === 1 && f.at[0].status === 'reserved' && f.at[0].provider_request === sentFirst && f.at[0].provider_request_version === 2, f.r.statusCode + ' ' + JSON.stringify(f.r.body) + ' ' + JSON.stringify(f.at.map(a => [a.status, (a.provider_request || '').length])));
    const exp = Number(dec(sentFirst).find(([k]) => k === 'expires_at')[1]) * 1000, payBy = Date.parse((await db(`bookings?id=eq.${f.b}&select=unpaid_expires_at`)).body[0].unpaid_expires_at);
    const stored = (await db(`payment_attempts?id=eq.${f.at[0].id}&select=provider_expires_at`)).body[0].provider_expires_at;
    ok('1b+. the request carries an absolute expires_at no later than the pay-by time (and no later than 23 hours away), and the same instant is stored on the reservation', exp <= payBy + 1000 && exp <= Date.now() + 23 * 3600e3 + 5000 && exp >= Date.now() + 30 * 60e3 && Date.parse(stored) === exp, JSON.stringify({ exp, payBy, stored }));
    ok('1b. that request names the two parts of the amount at the connected store', /\$20\.00 store demo fee plus \$10\.00 Demohub booking fee/.test(decodeURIComponent(sentFirst)));
    await db(`venues?id=eq.${C.venue}`, { method: 'PATCH', body: JSON.stringify({ name: 'Renamed Hall' }) });
    const n = creates().length, sessions = spy.sessions.size;
    const r2 = await checkout([f.b]);
    const sentRetry = creates().slice(n).map(c => c.body);
    const at2 = await attemptsOf(f.gid);
    ok('1c. the retry sends the STORED request (the old venue name), not a rebuilt one', sentRetry.length === 1 && sentRetry[0] === sentFirst && /Demo%20at%20Main/.test(sentRetry[0]) && !/Renamed/.test(sentRetry[0]), JSON.stringify(sentRetry.map(s => s.slice(0, 80))));
    ok('1d. the provider answers with the same session, it is bound, and there is still exactly one session and one attempt', r2.statusCode === 200 && spy.sessions.size === sessions && at2.length === 1 && at2[0].status === 'open' && at2[0].stripe_checkout_session_id === r2.body.session_id, r2.statusCode + ' ' + JSON.stringify(r2.body).slice(0, 160));
    await db(`payment_attempts?id=eq.${at2[0].id}`, { method: 'PATCH', body: JSON.stringify({ provider_request: 'tampered=1', provider_request_version: 9 }) });
    const at3 = await attemptsOf(f.gid);
    ok('2. the stored request is write-once: an API write leaves it unchanged', at3[0].provider_request === sentFirst && at3[0].provider_request_version === 2);
    await db(`venues?id=eq.${C.venue}`, { method: 'PATCH', body: JSON.stringify({ name: 'Main' }) });
  }

  console.log('\n3 to 5. reservations made before 0125');
  {
    const f = await failedBind(C);
    await forgetRequest(f.at[0].id);
    spy.requestsByKey.set(f.key, withoutSplit(f.at[0].provider_request));   // the session was created by the older build
    const n = creates().length, sessions = spy.sessions.size;
    const r = await checkout([f.b]);
    const sent = creates().slice(n).map(c => c.body);
    ok('3. a session created by the older build is reached with the older request shape on the first try and bound', r.statusCode === 200 && sent.length === 1 && !SPLIT.test(dec(sent[0]).find(([k]) => /\[description\]$/.test(k))[1]) && spy.sessions.size === sessions && (await attemptsOf(f.gid))[0].status === 'open', r.statusCode + ' ' + JSON.stringify(r.body).slice(0, 160) + ' sent ' + sent.length);
  }
  {
    const f = await failedBind(C);
    await forgetRequest(f.at[0].id);   // the session was created by the build that names the two parts
    spy.requestsByKey.set(f.key, withoutExpiry(f.at[0].provider_request));
    const n = creates().length, sessions = spy.sessions.size;
    const r = await checkout([f.b]);
    const sent = creates().slice(n).map(c => c.body);
    ok('4. a session created by the newer build is refused for the older shape and reached with the newer one; one session throughout', r.statusCode === 200 && sent.length === 2 && sent[1] === withoutExpiry(f.at[0].provider_request) && spy.sessions.size === sessions && (await attemptsOf(f.gid))[0].status === 'open', r.statusCode + ' ' + JSON.stringify(r.body).slice(0, 160) + ' sent ' + sent.length);
  }
  {
    const f = await failedBind(C);
    await forgetRequest(f.at[0].id);
    spy.requestsByKey.set(f.key, 'mode=payment&something=nobody-can-rebuild');
    const sessions = spy.sessions.size;
    const r = await checkout([f.b]);
    const at = await attemptsOf(f.gid);
    ok('5. an original request that cannot be established: 409 attempt_needs_review, the reservation kept, no new attempt, no new session', r.statusCode === 409 && r.body.error === 'attempt_needs_review' && !!r.body.message && at.length === 1 && at[0].status === 'reserved' && spy.sessions.size === sessions, r.statusCode + ' ' + JSON.stringify(r.body) + ' ' + JSON.stringify(at.map(a => a.status)));
    const again = await checkout([f.b]);
    ok('5b. asking again changes nothing', again.statusCode === 409 && again.body.error === 'attempt_needs_review' && (await attemptsOf(f.gid)).length === 1 && spy.sessions.size === sessions);
  }

  console.log('\n6. simultaneous retries');
  {
    const f = await failedBind(C);
    const sessions = spy.sessions.size;
    const [r1, r2] = await Promise.all([checkout([f.b]), checkout([f.b])]);
    const at = await attemptsOf(f.gid);
    const okCodes = [r1, r2].map(r => r.statusCode + ':' + ((r.body && r.body.error) || 'ok'));
    ok('6. two retries at once share the one session: no second session, one open attempt, at least one caller gets the link', spy.sessions.size === sessions && at.length === 1 && at[0].status === 'open' && [r1, r2].some(r => r.statusCode === 200) && [r1, r2].every(r => r.statusCode === 200 || (r.statusCode === 409 && r.body.error === 'attempt_in_progress')), JSON.stringify(okCodes));
  }

  console.log('\n7. the next generation freezes its own request');
  {
    const f = await failedBind(C);
    const sid = [...spy.sessions.values()].slice(-1)[0].id;
    spy.sessions.get(sid).status = 'expired';
    await db(`venues?id=eq.${C.venue}`, { method: 'PATCH', body: JSON.stringify({ name: 'Second Hall' }) });
    const r = await checkout([f.b]);
    const at = await attemptsOf(f.gid);
    ok('7. the expired session ends generation 1 with its request intact; generation 2 stores the request built now and opens a new session', r.statusCode === 200 && at.length === 2 && at[0].status === 'failed' && at[0].stripe_checkout_session_id === sid && /Demo%20at%20Main/.test(at[0].provider_request) && at[1].status === 'open' && /Second%20Hall/.test(at[1].provider_request) && at[1].stripe_checkout_session_id === r.body.session_id && r.body.session_id !== sid, r.statusCode + ' ' + JSON.stringify(at.map(a => [a.generation, a.status])));
    await db(`venues?id=eq.${C.venue}`, { method: 'PATCH', body: JSON.stringify({ name: 'Main' }) });
  }

  console.log('\n8. keeps-all store');
  {
    const f = await failedBind(K);
    ok('8a. at a keeps-all store the request carries no split text and is stored the same way', f.at[0].status === 'reserved' && !!f.at[0].provider_request && !/store%20demo%20fee%20plus/.test(f.at[0].provider_request));
    await forgetRequest(f.at[0].id);
    spy.requestsByKey.set(f.key, withoutExpiry(f.at[0].provider_request));
    const n = creates().length, sessions = spy.sessions.size;
    const r = await checkout([f.b]);
    ok('8b. a pre-0125 reservation there is recovered on the first shape (both shapes are the same request)', r.statusCode === 200 && creates().length - n === 1 && spy.sessions.size === sessions, r.statusCode + ' ' + JSON.stringify(r.body).slice(0, 120));
  }
} finally {
  clearTimeout(watchdog);
  try { await c1.query('ROLLBACK'); } catch (_) {}
  try { await c1.end(); } catch (_) {}
  spy.restore();
  try { console.log('\n:: teardown ::'); const counts = await teardownRetailerFixtures({ sbUrl: SB, sbKey: KEY, retailerIds: [C.id, K.id], brandIds, log: (m) => console.log(m) }); console.log('  teardown:', JSON.stringify(counts)); }
  catch (e) { console.log('  teardown failed (rows left on demohub-rebuild-check):', String((e && e.message) || e)); }
}
process.exit(summary('attempt request snapshot (routes + database, demohub-rebuild-check)') ? 0 : 1);
