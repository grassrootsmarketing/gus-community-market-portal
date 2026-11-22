// tests/unpaid_visibility.test.mjs (2026-11-22, Codex brand-walk order item 3): unpaid reservations are visible to the
// brand with their real amounts and pay-by time, and a payment is resumed as its exact, server-resolved set.
// Part 1 is offline (api/_unpaid-view.js). Part 2 runs against demohub-rebuild-check with Stripe spied.
import { readFileSync } from 'node:fs';
import { unpaidView } from '../api/_unpaid-view.js';
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? ' ' + d : '')); } };

console.log('\n1. the view (offline)');
{
  const split = { id: 'r1', name: 'Split Market', slug: 'split', platform_keeps_all: false }, keeps = { id: 'r2', name: 'Pilot Market', slug: 'pilot', platform_keeps_all: true };
  const covered = { default_coi_url: 'x', coi_verification_status: 'approved', default_coi_expires: '2099-01-01' }, uncovered = {};
  const bk = (id, o = {}) => ({ id, status: 'pending_payment', payment_status: 'unpaid', demo_date: '2026-12-15', demo_time: '11:00 AM', unpaid_expires_at: '2026-11-23T10:00:00Z', retailers: split, venues: { id: 'v', name: 'Main', demo_fee: 20 }, booked_by_member_id: 'm1', ...o });
  let v = unpaidView({ bookings: [bk('a')], allocations: [], brand: covered, role: 'owner', memberId: 'm9' });
  ok('1a. no group yet at a split store: the venue fee plus the booking fee, payable, a set of one', v.length === 1 && v[0].store_fee_cents === 2000 && v[0].booking_fee_cents === 1000 && v[0].total_cents === 3000 && v[0].state === 'awaiting_payment' && v[0].can_pay && !v[0].in_checkout && v[0].group_booking_ids.join() === 'a' && v[0].pay_by === '2026-11-23T10:00:00Z', JSON.stringify(v));
  v = unpaidView({ bookings: [bk('a', { retailers: keeps })], allocations: [], brand: covered, role: 'owner' });
  ok('1b. at a keeps-all store no booking fee is invented', v[0].store_fee_cents === 2000 && v[0].booking_fee_cents === 0 && v[0].total_cents === 2000);
  v = unpaidView({ bookings: [bk('a', { venues: { id: 'v', name: 'Main', demo_fee: 0 } })], allocations: [], brand: covered, role: 'owner' });
  ok('1c. a $0 store fee is shown as $0 plus the booking fee; no store part is invented', v[0].store_fee_cents === 0 && v[0].booking_fee_cents === 1000 && v[0].total_cents === 1000);
  const allocs = [{ booking_id: 'a', payment_group_id: 'g', customer_amount: 4500, platform_fee_amount: 1000 }, { booking_id: 'b', payment_group_id: 'g', customer_amount: 3000, platform_fee_amount: 1000 }];
  v = unpaidView({ bookings: [bk('a'), bk('b')], allocations: allocs, brand: covered, role: 'owner' });
  ok('1d. in a payment group the amounts are the allocations (mixed fees kept apart) and the group is the complete set', v.length === 2 && v.find(x => x.id === 'a').store_fee_cents === 3500 && v.find(x => x.id === 'b').store_fee_cents === 2000 && v.every(x => x.in_checkout && x.group_total_cents === 7500 && x.group_booking_ids.join() === 'a,b'), JSON.stringify(v.map(x => [x.id, x.store_fee_cents, x.group_total_cents])));
  v = unpaidView({ bookings: [bk('a', { status: 'held' })], allocations: [], brand: uncovered, role: 'owner' });
  ok('1e. held without coverage at a split store: awaiting the certificate, not payable', v[0].state === 'awaiting_coi' && v[0].can_pay === false);
  v = unpaidView({ bookings: [bk('a', { status: 'held', retailers: keeps })], allocations: [], brand: uncovered, role: 'owner' });
  ok('1f. held without coverage at a keeps-all store: still awaiting the certificate, payable through the card hold', v[0].state === 'awaiting_coi' && v[0].can_pay === true);
  v = unpaidView({ bookings: [bk('a', { status: 'held' })], allocations: [], brand: covered, role: 'owner' });
  ok('1g. held with a certificate that now covers the date: awaiting payment', v[0].state === 'awaiting_payment' && v[0].can_pay === true);
  v = unpaidView({ bookings: [bk('a'), bk('b', { booked_by_member_id: 'm2' })], allocations: [], brand: covered, role: 'booker', memberId: 'm1' });
  ok('1h. a booking-only member sees only the bookings they made', v.length === 1 && v[0].id === 'a' && v[0].booked_by_me === true);
  v = unpaidView({ bookings: [bk('a', { payment_status: 'paid' }), bk('b', { status: 'expired' }), bk('c', { status: 'cancelled' }), bk('d', { fee_waived: true }), bk('e', { payment_status: 'authorized', status: 'held' })], allocations: [], brand: covered, role: 'owner' });
  ok('1i. paid, expired, cancelled, fee-waived and authorized bookings are not listed', v.length === 0, JSON.stringify(v.map(x => x.id)));
  v = unpaidView({ bookings: [bk('late', { unpaid_expires_at: '2026-11-25T00:00:00Z' }), bk('soon', { unpaid_expires_at: '2026-11-22T00:00:00Z' })], allocations: [], brand: covered, role: 'owner' });
  ok('1j. the one released soonest comes first', v[0].id === 'soon');
  const page = readFileSync('r/gus/index.html', 'utf8'), dash = readFileSync('brand/dashboard/index.html', 'utf8'), admin = readFileSync('r/gus/admin/index.html', 'utf8'), co = readFileSync('api/checkout.js', 'utf8');
  ok('1k. the booking page pays for what this submission saved plus what was ticked, never the whole cache', /const unpaid = \[\.\.\.new Set\(successBookingIds\.concat\(_earlierTickedIds\(\)\)\)\]/.test(page) && !/const unpaid = saved\.paid\.map/.test(page));
  ok('1l. its cache key carries the brand as well as the store', /'dh_outcomes_' \+ \(location\.pathname\.split\('\/'\)\[2\] \|\| ''\) \+ '_' \+/.test(page));
  ok('1m. cached ids are kept only while the server still lists them', /filter\(id => live\.has\(String\(id\)\)\)/.test(page));
  ok('1n. the brand portal has the Awaiting payment card and resumes through the server', /id="awaitingPaymentCard"/.test(dash) && /resume_booking_id: id/.test(dash));
  ok('1o. the store sees a read-only list with no amounts and no actions', /id="demosUnpaidInfo"/.test(admin) && /Slot is released if unpaid by/.test(admin) && !/demosUnpaidInfo[\s\S]{0,1500}(Confirm|Decline)<\/button>/.test(admin));
  ok('1p. resume resolves the set on the server and never accepts a saved link', /resume_booking_id/.test(co) && /payment_allocations\?payment_group_id=eq\./.test(co) && !/body\.url|body\.session_url/.test(co));
}

const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
if (!(SB && KEY && SB.includes('tileejdviuvijumjeplv'))) {
  console.log('  (database part skipped: SB_URL / SB_KEY for demohub-rebuild-check not set)');
  console.log(`\nunpaid visibility: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

const { installSpy, callRoute, req, uniq, ENV, FIXTURE_PRODUCTS } = await import('./_route.mjs');
const { HOURLY } = await import('./_fixture_availability.mjs');
const { teardownRetailerFixtures } = await import('./_teardown.mjs');
const spy = installSpy();
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j }; };
const one = (r) => (r && Array.isArray(r.body) ? r.body[0] : null);
const LA = 'America/Los_Angeles';
function dayP(n) { const d = new Date(Date.now() + n * 864e5); const p = {}; for (const x of new Intl.DateTimeFormat('en-US', { timeZone: LA, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)) p[x.type] = p[x.type] || x.value; return `${p.year}-${p.month}-${p.day}`; }
ENV.CONNECTED_CHECKOUT_ENABLED = 'true';
const ACCT = 'acct_vis_' + uniq('x').replace(/-/g, '');
const CATALOG = [{ id: 'cat-1', ...FIXTURE_PRODUCTS[0] }];
const watchdog = setTimeout(() => { console.log('  FAIL watchdog: suite exceeded 8 minutes'); process.exit(1); }, 8 * 60 * 1000);

console.log('\n2. routes (demohub-rebuild-check)');
const slug = uniq('vis');
const rid = one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug, name: 'Visibility Market', billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active', platform_keeps_all: false, stripe_account_id: ACCT, stripe_charges_enabled: true, stripe_payouts_enabled: true, stripe_account_status: 'active', timezone: LA, auto_confirm_bookings: true, cancellation_mode: 'refundable', verification_status: 'approved' }) })).id;
await db('settings', { method: 'POST', body: JSON.stringify({ retailer_id: rid, demo_fee: 20, advance_booking_days: 0 }) });
const v20 = one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: rid, name: 'Main', address: '1 Vis St', demo_fee: 20, availability: HOURLY }) })).id;
const v35 = one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: rid, name: 'Annex', address: '2 Vis St', demo_fee: 35, availability: HOURLY }) })).id;
const brandIds = [];
async function mkBrand(label) {
  const email = `${uniq(label)}@fixture.test`;
  const id = one(await db('brands', { method: 'POST', body: JSON.stringify({ email, company_name: label + ' Brand', contact_name: label + ' Contact', phone: '555-0175', is_verified: true, products: CATALOG, default_coi_url: `brands/${label}.pdf`, default_coi_expires: dayP(400), coi_verification_status: 'approved' }) })).id;
  brandIds.push(id);
  const tok = one(await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: id, email, token: 'tk-' + uniq('t'), expires_at: new Date(Date.now() + 36e5).toISOString() }) }));
  const cookie = (await callRoute('brand-account.js', req({ body: { action: 'verify', token: tok.token } }))).cookie('dh_brand_session');
  const chk = await callRoute('booking.js', req({ body: { action: 'agreement-check', retailer_slug: slug }, cookies: { dh_brand_session: cookie } }));
  await callRoute('booking.js', req({ body: { action: 'agreement-sign', retailer_slug: slug, signed_name: 'Fixture Owner', policy_hash: chk.body.policies.policy_hash }, cookies: { dh_brand_session: cookie } }));
  return { id, cookie };
}
const A = await mkBrand('visa'), B = await mkBrand('visb');
let dayN = 80;
async function book(brand, venue) {
  const bk = await callRoute('book.js', req({ body: { retailer_slug: slug, venue_id: venue, demo_date: dayP(dayN++), demo_time: '13:00', product_skus: [CATALOG[0]], op_key: ('op-' + uniq('k')).replace(/[^A-Za-z0-9_-]/g, '') }, cookies: { dh_brand_session: brand.cookie } }));
  if (!bk.body || !bk.body.booking_id) throw new Error('book failed ' + bk.statusCode + ' ' + JSON.stringify(bk.body).slice(0, 200));
  return bk.body.booking_id;
}
const data = async (brand) => (await callRoute('brand-account.js', req({ method: 'GET', query: { action: 'data' }, body: {}, cookies: { dh_brand_session: brand.cookie } }))).body || {};
const checkout = (brand, body) => callRoute('checkout.js', req({ body, cookies: { dh_brand_session: brand.cookie } }));
const creates = () => spy.calls.stripe.filter(c => String(c.method).toUpperCase() === 'POST' && /\/checkout\/sessions$/.test(c.url.replace(/\?.*$/, ''))).length;

try {
  const old = await book(A, v20), n1 = await book(A, v20), n2 = await book(A, v35);
  let d = await data(A);
  let u = d.unpaid_bookings || [];
  ok('2a. three saved, unpaid demos are listed for the brand, each with its own fee and a pay-by time, none in a checkout', u.length === 3 && u.every(x => !x.in_checkout && x.pay_by && x.state === 'awaiting_payment') && u.find(x => x.id === n2).total_cents === 4500 && u.find(x => x.id === old).total_cents === 3000, JSON.stringify(u.map(x => [x.total_cents, x.in_checkout])));
  ok('2b. another brand sees none of them', ((await data(B)).unpaid_bookings || []).length === 0);
  const first = await checkout(A, { booking_ids: [n1, n2] });
  ok('2c. the two new demos are sent to checkout together: $30 + $45 = $75, the older one is not included', first.statusCode === 200 && first.body.total_cents === 7500 && first.body.booking_ids.length === 2 && !first.body.booking_ids.includes(old), first.statusCode + ' ' + JSON.stringify(first.body).slice(0, 200));
  u = (await data(A)).unpaid_bookings || [];
  const g1 = u.find(x => x.id === n1), g2 = u.find(x => x.id === n2), go = u.find(x => x.id === old);
  ok('2d. the list now shows them as one started payment of $75 for exactly those two, and the older one still on its own', g1.in_checkout && g2.in_checkout && g1.group_total_cents === 7500 && g1.group_booking_ids.slice().sort().join() === [n1, n2].sort().join() && !go.in_checkout && go.group_total_cents === 3000, JSON.stringify(u.map(x => [x.in_checkout, x.group_total_cents])));
  const sessions = spy.sessions.size, made = creates();
  const plain = await checkout(A, { booking_ids: [n1, n2] });
  ok('2e. a plain retry while the session is open is still 409 attempt_in_progress', plain.statusCode === 409 && plain.body.error === 'attempt_in_progress');
  const resumed = await checkout(A, { resume_booking_id: n2 });
  ok('2f. Resume payment names ONE booking; the server resolves both, returns the SAME open session and creates nothing', resumed.statusCode === 200 && resumed.body.resumed === true && resumed.body.session_id === first.body.session_id && resumed.body.url && resumed.body.total_cents === 7500 && resumed.body.booking_ids.length === 2 && spy.sessions.size === sessions && creates() === made, resumed.statusCode + ' ' + JSON.stringify(resumed.body).slice(0, 220));
  const foreign = await checkout(B, { resume_booking_id: n2 });
  ok('2g. another brand cannot resume it: 403 not_your_booking, no link', foreign.statusCode === 403 && foreign.body.error === 'not_your_booking' && !foreign.body.url, foreign.statusCode + ' ' + JSON.stringify(foreign.body));
  const splice = await checkout(A, { booking_ids: [n1, n2, old] });
  ok('2h. the started payment cannot have another demo spliced into it', splice.statusCode !== 200 && !splice.body.url, splice.statusCode + ' ' + JSON.stringify(splice.body).slice(0, 120));
  const partial = await checkout(A, { booking_ids: [n1] });
  ok('2i. nor can one of its demos be paid apart from the other', partial.statusCode !== 200 && !partial.body.url, partial.statusCode + ' ' + JSON.stringify(partial.body).slice(0, 120));
  const alone = await checkout(A, { resume_booking_id: old });
  ok('2j. the older demo, never sent to checkout, is paid on its own through the same route: a set of one, $30', alone.statusCode === 200 && alone.body.total_cents === 3000 && alone.body.booking_ids.length === 1 && alone.body.booking_ids[0] === old, alone.statusCode + ' ' + JSON.stringify(alone.body).slice(0, 160));
  Object.assign(spy.sessions.get(first.body.session_id), { status: 'complete', payment_status: 'paid' });
  const proc = await checkout(A, { resume_booking_id: n1 });
  ok('2k. once the session has completed, resume answers payment_pending and hands out no link', proc.statusCode === 409 && proc.body.error === 'payment_pending' && !proc.body.url, proc.statusCode + ' ' + JSON.stringify(proc.body));
  spy.sessions.get(alone.body.session_id).status = 'expired';
  const fresh = await checkout(A, { resume_booking_id: old });
  ok('2l. after its session expired on the provider, resume goes through the reservation flow and opens a new one', fresh.statusCode === 200 && fresh.body.session_id !== alone.body.session_id && fresh.body.total_cents === 3000, fresh.statusCode + ' ' + JSON.stringify(fresh.body).slice(0, 160));
  const bad = await checkout(A, { resume_booking_id: 'not-a-uuid' });
  ok('2m. a malformed id is refused before any lookup', bad.statusCode === 400);
  await db(`bookings?id=eq.${old}`, { method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }) });
  const gone = await checkout(A, { resume_booking_id: old });
  u = (await data(A)).unpaid_bookings || [];
  ok('2n. a demo that is no longer unpaid leaves the list and cannot be resumed', gone.statusCode === 409 && gone.body.error === 'not_payable_state' && !u.some(x => x.id === old), gone.statusCode + ' ' + JSON.stringify(gone.body));
} finally {
  clearTimeout(watchdog);
  spy.restore();
  try { console.log('\n:: teardown ::'); const counts = await teardownRetailerFixtures({ sbUrl: SB, sbKey: KEY, retailerIds: [rid], brandIds, log: () => {} }); console.log('  teardown:', JSON.stringify(counts).slice(0, 200)); }
  catch (e) { console.log('  teardown failed (rows left on demohub-rebuild-check):', String((e && e.message) || e)); }
}
console.log(`\nunpaid visibility: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
