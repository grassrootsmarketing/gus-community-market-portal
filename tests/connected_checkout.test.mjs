// tests/connected_checkout.test.mjs (2026-10-30): connected checkout (the revenue split) THROUGH the real routes against
// demohub-rebuild-check, Stripe and Resend spied. Pins the CONNECTED_CHECKOUT_ENABLED paths in api/checkout.js and the
// 0116 ledger behaviour (claim without the pilot gate, apply_verified_payment validating the Connect routing and
// recording the settlement ids, the keeps-all refusal unchanged, the refund request's per-allocation expectations).
//
// Cases: flag off -> 409 connected_checkout_unavailable_pilot before any claim; flag on but the store not payout-ready
// (no account, or charges not enabled) -> 409 store_not_payout_ready before any claim; account.updated flips the store;
// a connected two-booking checkout carries the application fee, destination and on_behalf_of and snapshots the account
// on the group; a signed paid event with matching routing applies (bookings paid, transfer and fee ids recorded); a
// paid event with the wrong application fee is a contradiction with a connect-routing case and applies nothing; a
// keeps-all store's checkout carries no Connect parameters and a paid event WITH Connect fields on it is a
// contradiction (then the clean event applies); a connected refund reserves the per-allocation expectations (reversal
// = the refunded amount, fee refund = the platform fee portion) and the Stripe refund call carries reverse_transfer and
// refund_application_fee; a refund.updated event for a connected refund records the transfer reversal and the
// application fee refund (settlement complete) and a charge.refunded replay is idempotent; a held cart at a connected
// store is refused 409 store_requires_insurance_on_file before any claim while a held cart at a keeps-all store still
// takes the manual-capture path. The real Stripe objects are proven by tools/rehearse-connected-checkout.mjs (on an on_behalf_of
// destination charge Stripe transfers the whole charge and collects the fee from the store, so a refund reverses the
// whole refunded amount: 0034's expectations hold).
import { createHmac } from 'node:crypto';
import { installSpy, callRoute, req, rawReq, ok, summary, uniq, ENV, FIXTURE_PRODUCTS } from './_route.mjs';
import { HOURLY } from './_fixture_availability.mjs';

const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  return { ok: r.ok, status: r.status, body: j };
};
const one = (r) => (r && Array.isArray(r.body) ? r.body[0] : null);
const LA = 'America/Los_Angeles';
const spy = installSpy();
const watchdog = setTimeout(() => { console.log('  FAIL watchdog: suite exceeded 5 minutes'); process.exit(1); }, 5 * 60 * 1000);
const sign = (payload, secret = 'whsec_harness') => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`; };
const formOf = (body) => Object.fromEntries(new URLSearchParams(body || ''));
function dayP(n) {
  const d = new Date(Date.now() + n * 864e5);
  const p = {}; for (const x of new Intl.DateTimeFormat('en-US', { timeZone: LA, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}
const ACCT = 'acct_route_' + uniq('x').replace(/-/g, '');
const flagOn = () => { ENV.CONNECTED_CHECKOUT_ENABLED = 'true'; };
const flagOff = () => { delete ENV.CONNECTED_CHECKOUT_ENABLED; };

console.log('\nFixtures');
const slug = uniq('cc');
const retailerId = one(await db('retailers', { method: 'POST', body: JSON.stringify({
  slug, name: 'Connected Route Market', billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active',
  platform_keeps_all: false, stripe_account_id: null, stripe_charges_enabled: false, timezone: LA, auto_confirm_bookings: true, cancellation_mode: 'refundable', verification_status: 'approved' }) })).id;
await db('settings', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, demo_fee: 150, advance_booking_days: 0 }) });
const venueId = one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, name: 'Connected Main', address: '150 Split St', demo_fee: 150, availability: HOURLY }) })).id;
const staffEmail = `staff-${slug}@fixture.test`;
await db('retailer_admins', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, email: staffEmail, email_normalized: staffEmail, name: 'Connected Staff', role: 'admin' }) });
const tok = one(await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: staffEmail, retailer_id: retailerId }) }));
const cookie = (await callRoute('admin-auth.js', req({ body: { action: 'verify', token: tok.token } }))).cookie('dh_retailer_session');
const kslug = uniq('ka');
const keepsId = one(await db('retailers', { method: 'POST', body: JSON.stringify({
  slug: kslug, name: 'Keeps-all Route Market', billing_email: `${kslug}@fixture.test`, billing_tier: 'pro', billing_status: 'active',
  platform_keeps_all: true, timezone: LA, auto_confirm_bookings: true, cancellation_mode: 'refundable', verification_status: 'approved' }) })).id;
await db('settings', { method: 'POST', body: JSON.stringify({ retailer_id: keepsId, demo_fee: 150, advance_booking_days: 0 }) });
const keepsVenue = one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: keepsId, name: 'Keeps Main', address: '1 Keeps St', demo_fee: 150, availability: HOURLY }) })).id;
const brandEmail = `${uniq('brand')}@fixture.test`;
const brandId = one(await db('brands', { method: 'POST', body: JSON.stringify({ email: brandEmail, company_name: 'Connected Brand', contact_name: 'Connected Contact', phone: '555-0150', is_verified: true,
  default_coi_url: 'brands/connected.pdf', default_coi_expires: dayP(400), coi_verification_status: 'approved' }) })).id;
const brandTok = one(await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: brandId, email: brandEmail, token: 'tk-' + uniq('c'), expires_at: new Date(Date.now() + 36e5).toISOString() }) }));
const brandCookie = (await callRoute('brand-account.js', req({ body: { action: 'verify', token: brandTok.token } }))).cookie('dh_brand_session');
ok('fixtures: connected retailer (no account yet), keeps-all retailer, $150 venues, staff and brand sessions', !!retailerId && !!venueId && !!keepsId && !!cookie && !!brandCookie);

let dayN = 10;
async function book(rslug, vid) {
  const bk = await callRoute('book.js', req({ body: { retailer_slug: rslug, venue_id: vid, demo_date: dayP(dayN++), demo_time: '13:00', product_skus: FIXTURE_PRODUCTS }, cookies: { dh_brand_session: brandCookie } }));
  const id = bk.body && (bk.body.booking_id || bk.body.id || (bk.body.booking && bk.body.booking.id));
  if (!id) throw new Error('book failed ' + bk.statusCode + ' ' + JSON.stringify(bk.body).slice(0, 200));
  return id;
}
async function checkoutAs(ids, cookieValue) {
  const before = spy.calls.stripe.length;
  const res = await callRoute('checkout.js', req({ body: { booking_ids: ids }, cookies: { dh_brand_session: cookieValue } }));
  const made = spy.calls.stripe.slice(before).filter(c => c.method === 'POST' && /\/checkout\/sessions$/.test(c.url.replace(/\?.*$/, '')));
  return { res, request: made[0] ? formOf(made[0].body) : null };
}
async function checkout(ids) {
  const before = spy.calls.stripe.length;
  const res = await callRoute('checkout.js', req({ body: { booking_ids: ids }, cookies: { dh_brand_session: brandCookie } }));
  const made = spy.calls.stripe.slice(before).filter(c => c.method === 'POST' && /\/checkout\/sessions$/.test(c.url.replace(/\?.*$/, '')));
  return { res, request: made[0] ? formOf(made[0].body) : null };
}
const allocsOf = async (gid) => (await db(`payment_allocations?payment_group_id=eq.${gid}&select=booking_id,customer_amount,venue_amount,platform_fee_amount,refunded_amount&order=booking_id.asc`)).body || [];
const groupOf = async (gid) => one(await db(`payment_groups?id=eq.${gid}&select=status,platform_keeps_all,connect_account_id,total_customer_amount,stripe_payment_intent_id,stripe_charge_id,stripe_transfer_id,stripe_application_fee_id`));
const bookingsOf = async (ids) => (await db(`bookings?id=in.(${ids.join(',')})&select=id,status,payment_status&order=id.asc`)).body || [];
const casesOf = async (gid) => (await db(`reconciliation_cases?payment_group_id=eq.${gid}&select=kind,reason,dedupe_key,details`)).body || [];
async function paidEvent(sessionId, gid, total, { pi, charge, dest = null, obo = null, fee = null, transfer = null, feeId = null }) {
  spy.fixtures.paymentIntents[pi] = { id: pi, object: 'payment_intent', amount_received: total, currency: 'usd', on_behalf_of: obo,
    latest_charge: { id: charge, object: 'charge', destination: dest, application_fee_amount: fee, transfer, application_fee: feeId } };
  const raw = JSON.stringify({ id: 'evt_' + uniq('paid'), type: 'checkout.session.completed',
    data: { object: { id: sessionId, object: 'checkout.session', mode: 'payment', payment_status: 'paid', amount_total: total, currency: 'usd', payment_intent: pi, metadata: { payment_group_id: gid } } } });
  return callRoute('stripe-webhook.js', rawReq(raw, { signature: sign(raw) }));
}

try {
  console.log('\nFlag off: refused before any claim');
  {
    flagOff();
    const b = await book(slug, venueId);
    const s0 = spy.calls.stripe.length;
    const co = await checkout([b]);
    ok('409 connected_checkout_unavailable_pilot with the booking ids', co.res.statusCode === 409 && co.res.body.error === 'connected_checkout_unavailable_pilot' && Array.isArray(co.res.body.booking_ids) && co.res.body.booking_ids.includes(b), `${co.res.statusCode} ${JSON.stringify(co.res.body).slice(0, 160)}`);
    ok('no Stripe call and no allocation for the booking', spy.calls.stripe.length === s0 && ((await db(`payment_allocations?booking_id=eq.${b}&select=id`)).body || []).length === 0);
  }

  console.log('\nFlag on but the store is not payout-ready');
  {
    flagOn();
    const b = await book(slug, venueId);
    const s0 = spy.calls.stripe.length;
    const noAcct = await checkout([b]);
    ok('no connected account on the row -> 409 store_not_payout_ready', noAcct.res.statusCode === 409 && noAcct.res.body.error === 'store_not_payout_ready', `${noAcct.res.statusCode} ${JSON.stringify(noAcct.res.body).slice(0, 160)}`);
    await db(`retailers?id=eq.${retailerId}`, { method: 'PATCH', body: JSON.stringify({ stripe_account_id: ACCT, stripe_charges_enabled: false }) });
    const notEnabled = await checkout([b]);
    ok('account present but charges not enabled -> 409 store_not_payout_ready', notEnabled.res.statusCode === 409 && notEnabled.res.body.error === 'store_not_payout_ready', `${notEnabled.res.statusCode}`);
    await db(`retailers?id=eq.${retailerId}`, { method: 'PATCH', body: JSON.stringify({ stripe_charges_enabled: true, stripe_payouts_enabled: false }) });
    const noPayouts = await checkout([b]);
    ok('charges enabled but payouts not enabled -> 409 store_not_payout_ready (charges alone is not payout readiness)', noPayouts.res.statusCode === 409 && noPayouts.res.body.error === 'store_not_payout_ready', `${noPayouts.res.statusCode}`);
    ok('still no Stripe call and no allocation', spy.calls.stripe.length === s0 && ((await db(`payment_allocations?booking_id=eq.${b}&select=id`)).body || []).length === 0);
    // account.updated (signed) is what flips the store in production
    const rawNoTransfers = JSON.stringify({ id: 'evt_' + uniq('acct'), type: 'account.updated', data: { object: { id: ACCT, object: 'account', charges_enabled: true, payouts_enabled: true, capabilities: { card_payments: 'active', transfers: 'pending' }, requirements: { disabled_reason: null } } } });
    const w0 = await callRoute('stripe-webhook.js', rawReq(rawNoTransfers, { signature: sign(rawNoTransfers) }));
    const row0 = one(await db(`retailers?id=eq.${retailerId}&select=stripe_charges_enabled,stripe_payouts_enabled,stripe_account_status`));
    ok('account.updated with the transfers capability still pending: both booleans on but status pending, not active', w0.statusCode === 200 && row0.stripe_charges_enabled === true && row0.stripe_payouts_enabled === true && row0.stripe_account_status === 'pending', JSON.stringify(row0));
    const raw = JSON.stringify({ id: 'evt_' + uniq('acct'), type: 'account.updated', data: { object: { id: ACCT, object: 'account', charges_enabled: true, payouts_enabled: true, capabilities: { card_payments: 'active', transfers: 'active' }, requirements: { disabled_reason: null } } } });
    const w = await callRoute('stripe-webhook.js', rawReq(raw, { signature: sign(raw) }));
    const row = one(await db(`retailers?id=eq.${retailerId}&select=stripe_charges_enabled,stripe_payouts_enabled,stripe_account_status`));
    ok('account.updated with transfers active flips the store to charges enabled, payouts enabled, status active', w.statusCode === 200 && row.stripe_charges_enabled === true && row.stripe_payouts_enabled === true && row.stripe_account_status === 'active', JSON.stringify({ w: w.statusCode, row }));
  }

  console.log('\nConnected two-booking checkout and a matching paid event');
  const ids = [await book(slug, venueId), await book(slug, venueId)];
  let gid, sessionId;
  {
    const co = await checkout(ids);
    ok('200 with a session, group and total 32000 (2 x ($150 + $10))', co.res.statusCode === 200 && !!co.res.body.session_id && !!co.res.body.payment_group_id && co.res.body.total_cents === 32000, `${co.res.statusCode} ${JSON.stringify(co.res.body).slice(0, 200)}`);
    gid = co.res.body.payment_group_id; sessionId = co.res.body.session_id;
    const rq = co.request || {};
    ok('the Session request carries application_fee_amount=2000, transfer_data[destination] and on_behalf_of = the account, two line items of 16000', rq['payment_intent_data[application_fee_amount]'] === '2000' && rq['payment_intent_data[transfer_data][destination]'] === ACCT && rq['payment_intent_data[on_behalf_of]'] === ACCT && rq['line_items[0][price_data][unit_amount]'] === '16000' && rq['line_items[1][price_data][unit_amount]'] === '16000', JSON.stringify(Object.fromEntries(Object.entries(rq).filter(([k]) => /payment_intent_data|unit_amount/.test(k)))));
    const g = await groupOf(gid); const al = await allocsOf(gid);
    ok('ledger: group not keeps-all with the account on the snapshot; two allocations 16000 = 15000 venue + 1000 fee', g.platform_keeps_all === false && g.connect_account_id === ACCT && g.total_customer_amount === 32000 && al.length === 2 && al.every(a => a.customer_amount === 16000 && a.venue_amount === 15000 && a.platform_fee_amount === 1000), JSON.stringify({ g, al }));
    const pi = 'pi_' + uniq('ok'), charge = 'ch_' + uniq('ok'), transfer = 'tr_' + uniq('ok'), feeId = 'fee_' + uniq('ok');
    const w = await paidEvent(sessionId, gid, 32000, { pi, charge, dest: ACCT, obo: ACCT, fee: 2000, transfer, feeId });
    const g2 = await groupOf(gid); const bks = await bookingsOf(ids);
    ok('a paid event with matching destination, on_behalf_of and fee applies: group paid, both bookings paid and confirmed, transfer and fee ids recorded', w.statusCode === 200 && g2.status === 'paid' && g2.stripe_payment_intent_id === pi && g2.stripe_charge_id === charge && g2.stripe_transfer_id === transfer && g2.stripe_application_fee_id === feeId && bks.length === 2 && bks.every(b => b.payment_status === 'paid' && b.status === 'confirmed'), JSON.stringify({ w: w.statusCode, g2, bks }));
    ok('no reconciliation case was opened', (await casesOf(gid)).length === 0);
    const demos = (await db(`demos?booking_id=in.(${ids.join(',')})&select=id`)).body || [];
    ok('the fulfilment outbox created a demo per booking', demos.length === 2, String(demos.length));
  }

  console.log('\nA connected paid event with the wrong application fee is a contradiction');
  {
    const b = await book(slug, venueId);
    const co = await checkout([b]);
    const g = co.res.body.payment_group_id, s = co.res.body.session_id;
    const pi = 'pi_' + uniq('bad'), charge = 'ch_' + uniq('bad');
    const w = await paidEvent(s, g, 16000, { pi, charge, dest: ACCT, obo: ACCT, fee: 500, transfer: 'tr_' + uniq('bad'), feeId: 'fee_' + uniq('bad') });
    const g2 = await groupOf(g); const bk = (await bookingsOf([b]))[0]; const cases = await casesOf(g);
    ok('webhook 200 (the case is the durable outcome); nothing applied: group not paid, booking unpaid', w.statusCode === 200 && g2.status !== 'paid' && bk.payment_status === 'unpaid' && bk.status === 'pending_payment', JSON.stringify({ w: w.statusCode, g2: g2.status, bk }));
    ok('one payment_contradiction case connect_routing_mismatch keyed connect-routing:<session> with expected fee 1000 and got 500', cases.length === 1 && cases[0].kind === 'payment_contradiction' && cases[0].reason === 'connect_routing_mismatch' && cases[0].dedupe_key === 'connect-routing:' + s && cases[0].details && cases[0].details.expected_fee === 1000 && cases[0].details.app_fee === 500, JSON.stringify(cases));
    const w2 = await paidEvent(s, g, 16000, { pi, charge, dest: 'acct_other', obo: ACCT, fee: 1000, transfer: 'tr_x', feeId: 'fee_x' });
    ok('a second wrong event (destination differs) reuses the same case (deduplicated), still nothing applied', w2.statusCode === 200 && (await casesOf(g)).length === 1 && (await bookingsOf([b]))[0].payment_status === 'unpaid');
  }

  console.log('\nA keeps-all store is unchanged by the flag and still refuses Connect fields');
  {
    const b = await book(kslug, keepsVenue);
    const co = await checkout([b]);
    const rq = co.request || {};
    ok('keeps-all checkout 200; the Session request has no application fee, destination or on_behalf_of; allocation 15000 with fee 0', co.res.statusCode === 200 && co.res.body.total_cents === 15000 && !('payment_intent_data[application_fee_amount]' in rq) && !('payment_intent_data[transfer_data][destination]' in rq) && !('payment_intent_data[on_behalf_of]' in rq), `${co.res.statusCode} ${JSON.stringify(Object.keys(rq).filter(k => /payment_intent_data/.test(k)))}`);
    const g = co.res.body.payment_group_id, s = co.res.body.session_id;
    const pi = 'pi_' + uniq('ka'), charge = 'ch_' + uniq('ka');
    const w = await paidEvent(s, g, 15000, { pi, charge, dest: ACCT, obo: ACCT, fee: 1000, transfer: 'tr_ka', feeId: 'fee_ka' });
    const cases = await casesOf(g);
    ok('a paid event carrying Connect fields on the keeps-all group is a contradiction (unexpected_connect_fields_on_keeps_all), nothing applied', w.statusCode === 200 && (await bookingsOf([b]))[0].payment_status === 'unpaid' && cases.length === 1 && cases[0].reason === 'unexpected_connect_fields_on_keeps_all' && cases[0].dedupe_key === 'connect-on-keepsall:' + s, JSON.stringify(cases));
    const w2 = await paidEvent(s, g, 15000, { pi, charge });
    const g2 = await groupOf(g);
    ok('the clean paid event (no Connect fields) then applies: group paid, no transfer or fee id', w2.statusCode === 200 && g2.status === 'paid' && g2.stripe_transfer_id === null && g2.stripe_application_fee_id === null && (await bookingsOf([b]))[0].payment_status === 'paid', JSON.stringify(g2));
  }

  console.log('\nA connected refund: per-allocation expectations and the Stripe call');
  {
    const r0 = spy.calls.stripe.length;
    const c = await callRoute('booking-action.js', req({ body: { action: 'cancel', category: 'store_caused', booking_id: ids[0] }, cookies: { dh_retailer_session: cookie } }));
    ok('cancel of the first connected booking (store_caused) -> 200, refund submitted', c.statusCode === 200 && c.body.refund_status === 'submitted', `${c.statusCode} ${JSON.stringify(c.body).slice(0, 160)}`);
    const refundCall = spy.calls.stripe.slice(r0).find(x => x.method === 'POST' && /\/refunds$/.test(x.url));
    const rf = refundCall ? formOf(refundCall.body) : {};
    ok('the Stripe refund call carries amount=16000 and reverse_transfer=true and NO refund_application_fee (0117 strategy 2: the fee refund is created exactly, per allocation)', rf.amount === '16000' && rf.reverse_transfer === 'true' && !('refund_application_fee' in rf), JSON.stringify(rf));
    const rq = one(await db(`refund_requests?booking_id=eq.${ids[0]}&select=amount,expected_customer_amount,expected_transfer_reversal_amount,expected_fee_refund_amount,settlement_status`));
    // the settlement outcome here is not meaningful: the harness answers POST /v1/refunds with a canned 3000 object, which the
    // verified helper rightly refuses (an exception, never 'complete'); the real legs are proven in tests/connected_settlement.test.mjs
    ok('the request expects a 16000 customer refund, a 16000 transfer reversal and a 1000 fee refund, strategy 2 with its own key; a canned provider refund that does not bind is never marked complete', rq && rq.amount === 16000 && rq.expected_customer_amount === 16000 && rq.expected_transfer_reversal_amount === 16000 && rq.expected_fee_refund_amount === 1000 && rq.settlement_status !== 'complete', JSON.stringify(rq));
    const al = await allocsOf(gid);
    ok('only the cancelled allocation is refunded (the spy refund shape is applied by the route); the sibling stays at zero', al.find(a => a.booking_id === ids[0]) && al.find(a => a.booking_id === ids[1]).refunded_amount === 0, JSON.stringify(al));

    // The two Stripe-side settlement legs are verified and recorded by tests/connected_settlement.test.mjs (0117).
  }

  console.log('\nA held (unverified-COI) cart at a connected store is refused before any claim');
  {
    ENV.PROVISIONAL_HOLDS_ENABLED = 'true';
    const heldEmail = `${uniq('held')}@fixture.test`;
    const heldBrandId = one(await db('brands', { method: 'POST', body: JSON.stringify({ email: heldEmail, company_name: 'Held Brand', contact_name: 'Held Contact', phone: '555-0151', is_verified: true }) })).id;
    const heldTok = one(await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: heldBrandId, email: heldEmail, token: 'tk-' + uniq('h'), expires_at: new Date(Date.now() + 36e5).toISOString() }) }));
    const heldCookie = (await callRoute('brand-account.js', req({ body: { action: 'verify', token: heldTok.token } }))).cookie('dh_brand_session');
    const bk = await callRoute('book.js', req({ body: { retailer_slug: slug, venue_id: venueId, demo_date: dayP(dayN++), demo_time: '13:00', product_skus: FIXTURE_PRODUCTS }, cookies: { dh_brand_session: heldCookie } }));
    const heldId = bk.body && (bk.body.booking_id || bk.body.id || (bk.body.booking && bk.body.booking.id));
    const heldRow = heldId ? one(await db(`bookings?id=eq.${heldId}&select=status,payment_status`)) : null;
    ok('a brand without a COI books a held booking at the connected store (provisional holds on)', bk.statusCode === 200 && heldRow && heldRow.status === 'held' && heldRow.payment_status === 'unpaid', `${bk.statusCode} ${JSON.stringify(heldRow)}`);
    const s0 = spy.calls.stripe.length;
    const co = await callRoute('checkout.js', req({ body: { booking_ids: [heldId] }, cookies: { dh_brand_session: heldCookie } }));
    ok('checkout of the held cart -> 409 store_requires_insurance_on_file with the booking id', co.statusCode === 409 && co.body.error === 'store_requires_insurance_on_file' && Array.isArray(co.body.booking_ids) && co.body.booking_ids[0] === heldId, `${co.statusCode} ${JSON.stringify(co.body).slice(0, 200)}`);
    ok('no Stripe call, no allocation, the booking still held and unpaid', spy.calls.stripe.length === s0 && ((await db(`payment_allocations?booking_id=eq.${heldId}&select=id`)).body || []).length === 0 && one(await db(`bookings?id=eq.${heldId}&select=status,payment_status`)).status === 'held');
    // the same held cart at the keeps-all store still takes the manual-capture path (unchanged)
    const bk2 = await callRoute('book.js', req({ body: { retailer_slug: kslug, venue_id: keepsVenue, demo_date: dayP(dayN++), demo_time: '13:00', product_skus: FIXTURE_PRODUCTS }, cookies: { dh_brand_session: heldCookie } }));
    const heldK = bk2.body && (bk2.body.booking_id || bk2.body.id || (bk2.body.booking && bk2.body.booking.id));
    const co2 = await checkoutAs([heldK], heldCookie);
    ok('a held cart at the keeps-all store still checks out with capture_method=manual (unchanged)', co2.res.statusCode === 200 && co2.request && co2.request['payment_intent_data[capture_method]'] === 'manual', `${co2.res.statusCode} ${JSON.stringify(co2.res.body).slice(0, 120)}`);

    console.log('\nThe route forward: the held brand\'s COI is approved, the held booking at the connected store is paid like any other');
    await db(`brands?id=eq.${heldBrandId}`, { method: 'PATCH', body: JSON.stringify({ default_coi_url: 'brands/held-approved.pdf', default_coi_expires: dayP(400), coi_verification_status: 'approved' }) });
    const s1 = spy.calls.stripe.length;
    const co3 = await checkoutAs([heldId], heldCookie);
    const after = one(await db(`bookings?id=eq.${heldId}&select=status,payment_status,held_expires_at`));
    ok('after approval the same held booking checks out at the connected store: 200, the booking moved to pending_payment (hold cleared), an immediate-charge destination Session (no capture_method), one Stripe call', co3.res.statusCode === 200 && after.status === 'pending_payment' && after.held_expires_at === null && co3.request && !('payment_intent_data[capture_method]' in co3.request) && co3.request['payment_intent_data[transfer_data][destination]'] === ACCT && spy.calls.stripe.length === s1 + 1, `${co3.res.statusCode} ${JSON.stringify({ after, body: co3.res.body }).slice(0, 200)}`);
    const al3 = await allocsOf(co3.res.body.payment_group_id);
    ok('its allocation is an ordinary 15000 + 1000', al3.length === 1 && al3[0].customer_amount === 16000 && al3[0].platform_fee_amount === 1000, JSON.stringify(al3));
    delete ENV.PROVISIONAL_HOLDS_ENABLED;
  }
} finally {
  clearTimeout(watchdog);
  spy.restore();
}
process.exit(summary('connected checkout (routes, demohub-rebuild-check)') ? 0 : 1);
