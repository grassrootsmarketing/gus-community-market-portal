// tests/connected_settlement.test.mjs (2026-10-30, Codex review of 8f43360: CC-1 exact per-allocation fee refunds, CC-2
// settlement recovery without webhooks, CC-3 verified evidence, CC-4 intake-off regression). Through the real routes
// (api/book, api/checkout, api/stripe-webhook, api/booking-action, api/refund-worker) against demohub-rebuild-check with
// Stripe simulated by path fixtures that behave like the provider (a refund creates its transfer reversal, a fee refund
// is deduplicated by idempotency key, every object can be read back) and Resend intercepted.
//
// Cases: the $30/$50 unequal cart (either booking first, then the remainder; exact amounts; no proportional flag;
// explicit fee refund under the request's key); worker-only recovery with every refund webhook suppressed; 429 then
// success; a database failure after the provider accepted the fee refund (recovered by lookup, no second refund); two
// workers at once; an expired lease; a stale request raising a case while retries continue; zero platform fee; the
// cumulative fee rounding rule at the database; evidence that is refused (wrong metadata, wrong charge, wrong parent
// transfer, wrong amount, wrong currency, conflicting id on replay, legacy ambiguity, a failed list read); duplicate
// events; and intake switched off with a connected payment and a pending settlement still converging.
import { createHmac } from 'node:crypto';
import { installSpy, callRoute, req, rawReq, ok, summary, uniq, ENV, FIXTURE_PRODUCTS } from './_route.mjs';
import { teardownRetailerFixtures } from './_teardown.mjs';
import { HOURLY } from './_fixture_availability.mjs';

const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j, text: t }; };
const rpc = async (fn, args) => { const r = await fetch(`${SB}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H, body: JSON.stringify(args) }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: Array.isArray(j) ? j[0] : j, text: t }; };
const one = (r) => (r && Array.isArray(r.body) ? r.body[0] : null);
const LA = 'America/Los_Angeles';
const spy = installSpy();
const watchdog = setTimeout(() => { console.log('  FAIL watchdog: suite exceeded 8 minutes'); process.exit(1); }, 8 * 60 * 1000);
const sign = (payload, secret = 'whsec_harness') => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`; };
const CRON = { authorization: 'Bearer ' + ENV.CRON_SECRET };
function dayP(n) { const d = new Date(Date.now() + n * 864e5); const p = {}; for (const x of new Intl.DateTimeFormat('en-US', { timeZone: LA, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)) p[x.type] = x.value; return `${p.year}-${p.month}-${p.day}`; }
const ACCT = 'acct_settle_' + uniq('x').replace(/-/g, '');
ENV.CONNECTED_CHECKOUT_ENABLED = 'true';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// A small Stripe behaving like the provider for one charge: refunds, reversals and fee refunds are created, stored and
// readable; a fee refund is deduplicated by its Idempotency-Key; every object is answered by path fixtures.
// ---------------------------------------------------------------------------
const SIMS = new Map();   // by PaymentIntent: several carts share the one POST /v1/refunds fixture
spy.fixtures.byPath[`POST /v1/refunds`] = (form, url, opts) => { const sim = SIMS.get(form.payment_intent); if (!sim) throw new Error('no sim for ' + form.payment_intent); return sim.createRefund(form, url, opts); };
function stripeSim({ pi, charge, transfer, fee, total, feeTotal }) {
  const sim = { refunds: [], reversals: [], feeRefunds: [], feeKeys: new Map(), refundForms: [], feeForms: [], overrides: {} };
  const now = () => Math.floor(Date.now() / 1000);
  SIMS.set(pi, sim);
  sim.refundKeys = new Map();
  const canon = (form) => JSON.stringify(Object.entries(form).sort());
  sim.createRefund = (form, url, opts) => {
    sim.refundForms.push(form);
    const key = opts && opts.headers && (opts.headers['Idempotency-Key'] || opts.headers['idempotency-key']);
    if (key && sim.refundKeys.has(key)) {
      const prior = sim.refundKeys.get(key);
      if (canon(prior.form) === canon(form)) return prior.re;
      // Stripe: a key reused with other parameters is refused (type idempotency_error), nothing is created
      return { __status: 400, body: { error: { type: 'idempotency_error', message: "Keys for idempotent requests can only be used with the same parameters they were first used with. Try using a key other than '" + key + "' if you meant to execute a different request." } } };
    }
    const amount = Number(form.amount);
    const re = { id: 're_' + uniq('s').replace(/-/g, ''), object: 'refund', amount, currency: 'usd', status: 'succeeded', payment_intent: pi, charge, created: now(), transfer_reversal: null,
      metadata: Object.fromEntries(Object.entries(form).filter(([k]) => k.startsWith('metadata[')).map(([k, v]) => [k.slice(9, -1), v])) };
    if (form.reverse_transfer === 'true') { const trr = { id: 'trr_' + uniq('s').replace(/-/g, ''), object: 'transfer_reversal', amount, currency: 'usd', transfer, created: now() }; sim.reversals.push(trr); re.transfer_reversal = trr.id; spy.fixtures.byPath[`/v1/transfers/${transfer}/reversals/${trr.id}`] = () => ({ ...trr, ...(sim.overrides['reversal:' + trr.id] || {}) }); }
    if (form.refund_application_fee === 'true') { const fr = { id: 'fr_' + uniq('s').replace(/-/g, ''), object: 'fee_refund', amount: Math.round(feeTotal * amount / total), currency: 'usd', fee, created: now(), metadata: {} }; sim.feeRefunds.push(fr); spy.fixtures.byPath[`/v1/application_fees/${fee}/refunds/${fr.id}`] = () => fr; }
    sim.refunds.push(re);
    if (key) sim.refundKeys.set(key, { form, re });
    spy.fixtures.byPath[`/v1/refunds/${re.id}`] = () => ({ ...re, ...(sim.overrides['refund:' + re.id] || {}) });
    return re;
  };
  // the PaymentIntent's refund list (the worker's adoption lookup reads it)
  spy.fixtures.byPath['/v1/refunds'] = (form, url) => { const q = new URL(url).searchParams.get('payment_intent'); const x = SIMS.get(q); return { object: 'list', has_more: false, data: x ? x.refunds.slice().reverse() : [] }; };
  spy.fixtures.byPath[`POST /v1/application_fees/${fee}/refunds`] = (form, url, opts) => {
    sim.feeForms.push({ form, key: opts.headers && (opts.headers['Idempotency-Key'] || opts.headers['idempotency-key']) });
    const key = opts.headers && (opts.headers['Idempotency-Key'] || opts.headers['idempotency-key']);
    if (key && sim.feeKeys.has(key)) return sim.feeKeys.get(key);
    const fr = { id: 'fr_' + uniq('s').replace(/-/g, ''), object: 'fee_refund', amount: Number(form.amount), currency: 'usd', fee, created: now(),
      metadata: Object.fromEntries(Object.entries(form).filter(([k]) => k.startsWith('metadata[')).map(([k, v]) => [k.slice(9, -1), v])) };
    sim.feeRefunds.push(fr); if (key) sim.feeKeys.set(key, fr);
    spy.fixtures.byPath[`/v1/application_fees/${fee}/refunds/${fr.id}`] = () => ({ ...fr, ...(sim.overrides['fee_refund:' + fr.id] || {}) });
    return fr;
  };
  spy.fixtures.byPath[`/v1/application_fees/${fee}/refunds`] = () => ({ object: 'list', has_more: false, data: sim.feeRefunds.slice().reverse() });
  spy.fixtures.byPath[`/v1/charges/${charge}`] = () => ({ id: charge, object: 'charge', payment_intent: pi, destination: ACCT, on_behalf_of: ACCT, application_fee_amount: feeTotal > 0 ? feeTotal : null, transfer, application_fee: feeTotal > 0 ? fee : null, amount: total });
  return sim;
}

console.log('\nFixtures');
const slug = uniq('cs');
const retailerId = one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug, name: 'Settlement Market', billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active',
  platform_keeps_all: false, stripe_account_id: ACCT, stripe_charges_enabled: true, stripe_payouts_enabled: true, stripe_account_status: 'active', timezone: LA, auto_confirm_bookings: true, cancellation_mode: 'refundable', verification_status: 'approved' }) })).id;
await db('settings', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, demo_fee: 30, advance_booking_days: 0 }) });
const venue30 = one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, name: 'Thirty', address: '30 St', demo_fee: 30, availability: HOURLY }) })).id;
const venue50 = one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, name: 'Fifty', address: '50 St', demo_fee: 50, availability: HOURLY }) })).id;
const venue150 = one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, name: 'One Fifty', address: '150 St', demo_fee: 150, availability: HOURLY }) })).id;
const venue3333 = one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, name: 'Odd', address: '33 St', demo_fee: 33.33, availability: HOURLY }) })).id;
const staffEmail = `staff-${slug}@fixture.test`;
await db('retailer_admins', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, email: staffEmail, email_normalized: staffEmail, name: 'Settlement Staff', role: 'admin' }) });
const tok = one(await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: staffEmail, retailer_id: retailerId }) }));
const cookie = (await callRoute('admin-auth.js', req({ body: { action: 'verify', token: tok.token } }))).cookie('dh_retailer_session');
const brandEmail = `${uniq('brand')}@fixture.test`;
const brandId = one(await db('brands', { method: 'POST', body: JSON.stringify({ email: brandEmail, company_name: 'Settlement Brand', contact_name: 'Settlement Contact', phone: '555-0160', is_verified: true, default_coi_url: 'brands/settle.pdf', default_coi_expires: dayP(400), coi_verification_status: 'approved' }) })).id;
const brandTok = one(await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: brandId, email: brandEmail, token: 'tk-' + uniq('c'), expires_at: new Date(Date.now() + 36e5).toISOString() }) }));
const brandCookie = (await callRoute('brand-account.js', req({ body: { action: 'verify', token: brandTok.token } }))).cookie('dh_brand_session');
ok('fixtures: connected retailer (charges and payouts enabled), $30 / $50 / $150 / $33.33 venues, brand and staff sessions', !!retailerId && !!venue30 && !!venue50 && !!cookie && !!brandCookie);

let dayN = 12;
async function book(vid) {
  const bk = await callRoute('book.js', req({ body: { retailer_slug: slug, venue_id: vid, demo_date: dayP(dayN++), demo_time: '13:00', product_skus: FIXTURE_PRODUCTS }, cookies: { dh_brand_session: brandCookie } }));
  const id = bk.body && (bk.body.booking_id || bk.body.id || (bk.body.booking && bk.body.booking.id));
  if (!id) throw new Error('book failed ' + bk.statusCode + ' ' + JSON.stringify(bk.body).slice(0, 200));
  return id;
}
// a paid connected cart: book, checkout, signed paid event with the Connect fields; returns the ids and a Stripe sim
async function paidCart(venueIds) {
  const ids = []; for (const v of venueIds) ids.push(await book(v));
  const co = await callRoute('checkout.js', req({ body: { booking_ids: ids }, cookies: { dh_brand_session: brandCookie } }));
  if (co.statusCode !== 200) throw new Error('checkout ' + co.statusCode + ' ' + JSON.stringify(co.body).slice(0, 200));
  const gid = co.body.payment_group_id, sid = co.body.session_id, total = co.body.total_cents;
  const allocs = (await db(`payment_allocations?payment_group_id=eq.${gid}&select=booking_id,customer_amount,platform_fee_amount`)).body;
  const feeTotal = allocs.reduce((s, a) => s + a.platform_fee_amount, 0);
  const pi = 'pi_' + uniq('s').replace(/-/g, ''), charge = 'ch_' + uniq('s').replace(/-/g, ''), transfer = 'tr_' + uniq('s').replace(/-/g, ''), fee = 'fee_' + uniq('s').replace(/-/g, '');
  spy.fixtures.paymentIntents[pi] = { id: pi, object: 'payment_intent', amount_received: total, currency: 'usd', on_behalf_of: ACCT, latest_charge: { id: charge, object: 'charge', destination: ACCT, application_fee_amount: feeTotal, transfer, application_fee: fee } };
  const raw = JSON.stringify({ id: 'evt_' + uniq('p'), type: 'checkout.session.completed', data: { object: { id: sid, object: 'checkout.session', mode: 'payment', payment_status: 'paid', amount_total: total, currency: 'usd', payment_intent: pi, metadata: { payment_group_id: gid } } } });
  const w = await callRoute('stripe-webhook.js', rawReq(raw, { signature: sign(raw) }));
  if (w.statusCode !== 200) throw new Error('paid event ' + w.statusCode);
  const sim = stripeSim({ pi, charge, transfer, fee, total, feeTotal });
  return { ids, gid, sid, total, feeTotal, pi, charge, transfer, fee, sim, allocs };
}
const cancel = (booking_id, category = 'store_caused') => callRoute('booking-action.js', req({ body: { action: 'cancel', category, booking_id }, cookies: { dh_retailer_session: cookie } }));
const runWorker = () => callRoute('refund-worker.js', req({ body: {}, headers: CRON }));
const requestOf = async (bookingId) => one(await db(`refund_requests?booking_id=eq.${bookingId}&select=id,amount,status,customer_refund_status,settlement_status,settlement_strategy,stripe_refund_id,last_error,fee_refund_intent_at,settlement_last_error,expected_transfer_reversal_amount,expected_fee_refund_amount,stripe_transfer_reversal_id,stripe_fee_refund_id,transfer_reversal_status,fee_refund_status,transfer_reversal_amount,fee_refund_amount,fee_refund_idempotency_key,fee_refund_intent_at,settlement_attempts,settlement_next_attempt_at,settlement_last_error,settlement_lease_owner&order=created_at.desc`));
const allocsOf = async (gid) => (await db(`payment_allocations?payment_group_id=eq.${gid}&select=booking_id,customer_amount,venue_amount,platform_fee_amount,refunded_amount,reserved_refund_amount&order=booking_id.asc`)).body || [];
const groupStatus = async (gid) => one(await db(`payment_groups?id=eq.${gid}&select=status`)).status;
const casesOf = async (rqId) => (await db(`reconciliation_cases?refund_request_id=eq.${rqId}&select=kind,reason,dedupe_key,details`)).body || [];
const refundEvent = async (re, type = 'refund.updated') => { const raw = JSON.stringify({ id: 'evt_' + uniq('r'), type, data: { object: re } }); return callRoute('stripe-webhook.js', rawReq(raw, { signature: sign(raw) })); };
const isComplete = (rq) => rq && rq.settlement_status === 'complete' && rq.transfer_reversal_status === 'succeeded' && rq.fee_refund_status === 'succeeded';

try {
  console.log('\nCC-1: the $30 / $50 cart, the $30 booking first');
  {
    const c = await paidCart([venue30, venue50]);
    const [A, B] = c.ids;
    ok('one charge of 10000 = (3000 + 1000) + (5000 + 1000), application fee 2000', c.total === 10000 && c.feeTotal === 2000, `${c.total} ${c.feeTotal}`);
    const r = await cancel(A);
    ok('cancel A -> 200, refund submitted', r.statusCode === 200 && r.body.refund_status === 'submitted', `${r.statusCode} ${JSON.stringify(r.body).slice(0, 160)}`);
    const rf = c.sim.refundForms[0] || {};
    ok('the customer refund carried amount=4000 and reverse_transfer=true and NO refund_application_fee (strategy 2)', rf.amount === '4000' && rf.reverse_transfer === 'true' && !('refund_application_fee' in rf), JSON.stringify(rf));
    const rq = await requestOf(A);
    ok('the request reserved 4000, expects a 4000 reversal and a 1000 fee refund (the allocation\'s own fee, not 800), strategy 2 with its own key', rq.amount === 4000 && rq.expected_transfer_reversal_amount === 4000 && rq.expected_fee_refund_amount === 1000 && rq.settlement_strategy === 2 && /^fr-/.test(rq.fee_refund_idempotency_key), JSON.stringify(rq));
    const ff = c.sim.feeForms[0] || {};
    ok('exactly one fee refund was created, amount=1000, under the request\'s idempotency key, with metadata naming the request', c.sim.feeForms.length === 1 && ff.form.amount === '1000' && ff.key === rq.fee_refund_idempotency_key && ff.form['metadata[refund_request_id]'] === rq.id, JSON.stringify(ff));
    ok('settlement complete at once (cancel path): reversal 4000 and fee refund 1000 recorded with the sim\'s ids', isComplete(rq) && rq.transfer_reversal_amount === 4000 && rq.fee_refund_amount === 1000 && rq.stripe_transfer_reversal_id === c.sim.reversals[0].id && rq.stripe_fee_refund_id === c.sim.feeRefunds[0].id, JSON.stringify(rq));
    const al = await allocsOf(c.gid);
    ok('allocation A refunded 4000; sibling B untouched (0 refunded, 0 reserved); group partially_refunded', al.find(a => a.booking_id === A).refunded_amount === 4000 && al.find(a => a.booking_id === B).refunded_amount === 0 && al.find(a => a.booking_id === B).reserved_refund_amount === 0 && (await groupStatus(c.gid)) === 'partially_refunded', JSON.stringify(al));
    const r2 = await cancel(B);
    const rq2 = await requestOf(B);
    ok('then B: refund 6000, reversal 6000, fee refund 1000, complete; group refunded', r2.statusCode === 200 && rq2.amount === 6000 && isComplete(rq2) && rq2.transfer_reversal_amount === 6000 && rq2.fee_refund_amount === 1000 && (await groupStatus(c.gid)) === 'refunded', JSON.stringify(rq2));
    const sums = { refunds: c.sim.refunds.reduce((s, x) => s + x.amount, 0), reversals: c.sim.reversals.reduce((s, x) => s + x.amount, 0), fees: c.sim.feeRefunds.reduce((s, x) => s + x.amount, 0) };
    ok('everything reconciles to the immutable allocations: refunds 10000 = the charge, reversals 10000 = the transfer, fee refunds 2000 = the application fee, two fee refunds in total', sums.refunds === 10000 && sums.reversals === 10000 && sums.fees === 2000 && c.sim.feeRefunds.length === 2, JSON.stringify(sums));
  }

  console.log('\nCC-1: the same cart, the $50 booking first; and an equal-price cart');
  {
    const c = await paidCart([venue30, venue50]);
    const [A, B] = c.ids;
    await cancel(B); const rqB = await requestOf(B);
    ok('B first: refund 6000, reversal 6000, fee refund 1000, complete, A untouched', isComplete(rqB) && rqB.amount === 6000 && rqB.fee_refund_amount === 1000 && (await allocsOf(c.gid)).find(a => a.booking_id === A).refunded_amount === 0, JSON.stringify(rqB));
    await cancel(A); const rqA = await requestOf(A);
    ok('then A: 4000 / 4000 / 1000, complete; sums 10000 / 10000 / 2000', isComplete(rqA) && rqA.amount === 4000 && rqA.fee_refund_amount === 1000 && c.sim.refunds.reduce((s, x) => s + x.amount, 0) === 10000 && c.sim.feeRefunds.reduce((s, x) => s + x.amount, 0) === 2000, JSON.stringify(rqA));
    const e = await paidCart([venue150, venue150]);
    await cancel(e.ids[0]); const rqE = await requestOf(e.ids[0]);
    ok('equal-price cart: 16000 / 16000 / 1000, complete, sibling untouched', isComplete(rqE) && rqE.amount === 16000 && rqE.transfer_reversal_amount === 16000 && rqE.fee_refund_amount === 1000 && (await allocsOf(e.gid)).find(a => a.booking_id === e.ids[1]).refunded_amount === 0, JSON.stringify(rqE));
  }

  console.log('\nCC-2: the customer refund succeeds synchronously, every refund webhook is suppressed, the worker alone completes settlement');
  {
    const c = await paidCart([venue150]);
    spy.faults.push({ url: `/v1/application_fees/${c.fee}/refunds`, method: 'POST', status: 500, message: 'injected_fee_refund_outage', once: true });
    const r = await cancel(c.ids[0]);
    let rq = await requestOf(c.ids[0]);
    ok('cancel 200; customer leg succeeded; reversal recorded; fee leg not recorded; settlement pending (the cancel path\'s attempt hit the outage)', r.statusCode === 200 && rq.status === 'succeeded' && rq.customer_refund_status === 'succeeded' && rq.transfer_reversal_status === 'succeeded' && !rq.stripe_fee_refund_id && rq.settlement_status === 'pending' && !!rq.fee_refund_intent_at, JSON.stringify(rq));
    const refundsBefore = c.sim.refunds.length;
    const w = await runWorker();
    rq = await requestOf(c.ids[0]);
    ok('no webhook replayed; one worker run -> settlement complete, fee refund 1000 created under the request\'s key, no second customer refund', w.statusCode === 200 && isComplete(rq) && c.sim.feeRefunds.length === 1 && c.sim.refunds.length === refundsBefore && c.sim.refundForms.length === 1, `${w.statusCode} ${JSON.stringify({ rq, fees: c.sim.feeRefunds.length, refunds: c.sim.refunds.length, out: w.body && { claimed: w.body.settlement_claimed, completed: w.body.settlement_completed } })}`);
    ok('the worker reported the settlement counters', w.body && w.body.settlement_claimed >= 1 && w.body.settlement_completed >= 1, JSON.stringify(w.body && { c: w.body.settlement_claimed, d: w.body.settlement_completed }));
  }

  console.log('\nCC-2: 429 then success; a database failure after the provider accepted the fee refund; two workers; an expired lease');
  {
    const c = await paidCart([venue150]);
    spy.faults.push({ url: `/v1/application_fees/${c.fee}/refunds`, method: 'POST', status: 429, message: 'rate_limited', once: true });
    await cancel(c.ids[0]);
    let rq = await requestOf(c.ids[0]);
    ok('429 on the fee refund: settlement pending, intent recorded, no fee refund on Stripe', rq.settlement_status === 'pending' && !!rq.fee_refund_intent_at && c.sim.feeRefunds.length === 0, JSON.stringify(rq));
    // the worker: a second 429 persists a backoff and the reason; the request is not claimed again until it is due
    spy.faults.push({ url: `/v1/application_fees/${c.fee}/refunds`, method: 'POST', status: 429, message: 'rate_limited_again', once: true });
    const w1 = await runWorker(); rq = await requestOf(c.ids[0]);
    ok('worker run with a 429: retried, next attempt in the future, the reason persisted, still pending, no fee refund', w1.body && w1.body.settlement_retried >= 1 && rq.settlement_status === 'pending' && rq.settlement_next_attempt_at && new Date(rq.settlement_next_attempt_at).getTime() > Date.now() && /stripe_create_fee_refund/.test(rq.settlement_last_error || '') && c.sim.feeRefunds.length === 0, JSON.stringify({ rq, out: w1.body && { r: w1.body.settlement_retried, e: w1.body.errors } }));
    const w1b = await runWorker(); const rq1b = await requestOf(c.ids[0]);
    ok('a run before the backoff elapses does not claim it (attempts unchanged)', rq1b.settlement_attempts === rq.settlement_attempts, `${rq.settlement_attempts} -> ${rq1b.settlement_attempts} ${w1b.statusCode}`);
    await db(`refund_requests?id=eq.${rq.id}`, { method: 'PATCH', body: JSON.stringify({ settlement_next_attempt_at: new Date(Date.now() - 1000).toISOString() }) });
    // now the provider accepts but the ledger write fails once: the next run must find the fee refund by lookup
    spy.faults.push({ url: 'rpc/record_settlement_leg', method: 'POST', status: 500, message: 'injected_db_outage', once: true });
    const w2 = await runWorker(); rq = await requestOf(c.ids[0]);
    ok('provider accepted (one fee refund exists with the request\'s metadata) but the ledger write failed: still pending, retry persisted', c.sim.feeRefunds.length === 1 && c.sim.feeRefunds[0].metadata.refund_request_id === rq.id && rq.settlement_status === 'pending' && !rq.stripe_fee_refund_id && /db_record_fee_refund/.test(rq.settlement_last_error || ''), JSON.stringify({ rq, fees: c.sim.feeRefunds.length, w2: w2.body && w2.body.settlement_retried }));
    await db(`refund_requests?id=eq.${rq.id}`, { method: 'PATCH', body: JSON.stringify({ settlement_next_attempt_at: new Date(Date.now() - 1000).toISOString() }) });
    const w3 = await runWorker(); rq = await requestOf(c.ids[0]);
    ok('next run: the existing fee refund is found by lookup and recorded; complete; still exactly one fee refund and exactly one accepted provider call (no blind second refund)', isComplete(rq) && rq.stripe_fee_refund_id === c.sim.feeRefunds[0].id && c.sim.feeRefunds.length === 1 && c.sim.feeForms.length === 1, JSON.stringify({ rq, fees: c.sim.feeRefunds.length, forms: c.sim.feeForms.length, w3: w3.statusCode }));

    // two workers at once on one pending request
    const d = await paidCart([venue150]);
    spy.faults.push({ url: `/v1/application_fees/${d.fee}/refunds`, method: 'POST', status: 500, message: 'outage', once: true });
    await cancel(d.ids[0]);
    const [wa, wb] = await Promise.all([runWorker(), runWorker()]);
    const rqd = await requestOf(d.ids[0]);
    ok('two concurrent workers: the lease lets one settle; complete; exactly one fee refund created', wa.statusCode < 500 && wb.statusCode < 500 && isComplete(rqd) && d.sim.feeRefunds.length === 1, JSON.stringify({ rqd: rqd.settlement_status, fees: d.sim.feeRefunds.length, a: wa.body && wa.body.settlement_claimed, b: wb.body && wb.body.settlement_claimed }));

    // an expired lease from a terminated process is reclaimed
    const e = await paidCart([venue150]);
    spy.faults.push({ url: `/v1/application_fees/${e.fee}/refunds`, method: 'POST', status: 500, message: 'outage', once: true });
    await cancel(e.ids[0]);
    const rqe0 = await requestOf(e.ids[0]);
    await db(`refund_requests?id=eq.${rqe0.id}`, { method: 'PATCH', body: JSON.stringify({ settlement_lease_owner: 'settle-dead-process', settlement_lease_expires_at: new Date(Date.now() - 60000).toISOString(), settlement_next_attempt_at: null }) });
    await runWorker(); const rqe = await requestOf(e.ids[0]);
    ok('a lease left by a dead process (expired) is reclaimed and the request completes', isComplete(rqe) && rqe.settlement_lease_owner === null, JSON.stringify(rqe));
  }

  console.log('\nCC-2: a stale request raises an actionable case while retries continue');
  {
    const c = await paidCart([venue150]);
    spy.faults.push({ url: `/v1/application_fees/${c.fee}/refunds`, method: 'POST', status: 500, message: 'persistent_outage' });   // not once: persists
    await cancel(c.ids[0]);
    let rq = await requestOf(c.ids[0]);
    await db(`refund_requests?id=eq.${rq.id}`, { method: 'PATCH', body: JSON.stringify({ settlement_attempts: 8, settlement_next_attempt_at: null }) });
    const w = await runWorker(); rq = await requestOf(c.ids[0]);
    const cases = await casesOf(rq.id);
    ok('after 8 attempts with the outage persisting: a settlement_stale case is open (deduplicated), the request is still pending and still retried', rq.settlement_status === 'pending' && cases.some(x => x.reason === 'settlement_stale' && x.dedupe_key === 'settlement-stale:' + rq.id) && w.body && w.body.settlement_stale_cases >= 1, JSON.stringify({ rq: rq.settlement_status, cases, w: w.body && w.body.settlement_stale_cases }));
    await db(`refund_requests?id=eq.${rq.id}`, { method: 'PATCH', body: JSON.stringify({ settlement_next_attempt_at: null }) });
    await runWorker(); const again = await casesOf(rq.id);
    ok('a second stale run does not open a second case', again.filter(x => x.reason === 'settlement_stale').length === 1);
    spy.faults.length = 0;
    await db(`refund_requests?id=eq.${rq.id}`, { method: 'PATCH', body: JSON.stringify({ settlement_next_attempt_at: null }) });
    await runWorker(); rq = await requestOf(c.ids[0]);
    ok('once the provider recovers the request completes; the case stays for the operator', isComplete(rq) && (await casesOf(rq.id)).length >= 1, JSON.stringify(rq.settlement_status));
  }

  console.log('\nCC-1: zero platform fee and the cumulative fee rounding rule (database level)');
  {
    // zero fee: a connected claim with a zero fee, paid and refunded through the RPCs, settled by the worker with no fee refund call
    const b = await book(venue150);
    const claim = (await rpc('checkout_claim_group', { p_brand_id: brandId, p_retailer_id: retailerId, p_booking_ids: [b], p_platform_keeps_all: false, p_connect_account_id: ACCT, p_platform_fee_cents: 0 })).body;
    const gid = claim.payment_group_id;
    const sid = 'cs_zero_' + uniq('z'), pi = 'pi_zero_' + uniq('z').replace(/-/g, ''), ch = 'ch_zero_' + uniq('z').replace(/-/g, ''), tr = 'tr_zero_' + uniq('z').replace(/-/g, ''), fee = 'fee_zero_' + uniq('z').replace(/-/g, '');
    await rpc('register_payment_attempt', { p_group_id: gid, p_session_id: sid, p_payment_intent: pi, p_hash: 'h-' + gid, p_schema: 1 });
    // the provider's shape for a destination charge created without an application fee: application_fee_amount absent,
    // no application fee object; 0118 counts that as a zero fee against the allocations' zero fee sum
    const paid = (await rpc('apply_verified_payment', { p_session_id: sid, p_payment_intent: pi, p_charge: ch, p_amount: 15000, p_currency: 'usd', p_connect_dest: ACCT, p_on_behalf_of: ACCT, p_application_fee: null, p_transfer_id: tr, p_fee_id: null })).body;
    ok('zero-fee connected group: claim 15000 with fee 0, applied', claim.total_customer_amount === 15000 && paid.outcome === 'applied', JSON.stringify({ claim, paid }));
    const rr = (await rpc('refund_reserve_cas', { p_booking_id: b, p_op_key: b + ':cancel', p_actor: 'test', p_reason: 'zero' })).body;
    ok('the reservation expects a 15000 reversal and a 0 fee refund, strategy 2', rr.outcome === 'reserved' && rr.expected_transfer_reversal_amount === 15000 && rr.expected_fee_refund_amount === 0 && rr.settlement_strategy === 2, JSON.stringify(rr));
    const sim = stripeSim({ pi, charge: ch, transfer: tr, fee: null, total: 15000, feeTotal: 0 });
    const re = sim.createRefund({ amount: '15000', reverse_transfer: 'true', payment_intent: pi, 'metadata[refund_request_id]': rr.refund_request_id }, '', {});
    const grpZ = one(await db(`payment_groups?id=eq.${gid}&select=stripe_transfer_id,stripe_application_fee_id`));
    ok('zero fee at the provider\'s shape: the group records the transfer id and no application fee id', grpZ && grpZ.stripe_transfer_id === tr && grpZ.stripe_application_fee_id === null, JSON.stringify(grpZ));
    await rpc('apply_refund_event', { p_refund_id: re.id, p_status: 'succeeded', p_amount: 15000, p_currency: 'usd', p_pi: pi, p_charge: ch, p_meta_request_id: rr.refund_request_id, p_event_id: null });
    await runWorker();
    const rqz = one(await db(`refund_requests?id=eq.${rr.refund_request_id}&select=settlement_status,fee_refund_status,fee_refund_amount,stripe_fee_refund_id,transfer_reversal_status`));
    ok('the worker\'s group id fill neither waits on nor opens a case for the missing fee object of a zero-fee group', ((await db(`reconciliation_cases?payment_group_id=eq.${gid}&select=id`)).body || []).length === 0);
    ok('settled by the worker: fee leg not_required (amount 0, no id, no provider call), reversal recorded, complete', rqz.settlement_status === 'complete' && rqz.fee_refund_status === 'not_required' && rqz.fee_refund_amount === 0 && rqz.stripe_fee_refund_id === null && sim.feeForms.length === 0, JSON.stringify({ rqz, feeForms: sim.feeForms.length }));

    // cumulative rounding: $33.33 + $10 = 4333; a prior 2000 refund expected round(1000*2000/4333)=462; the remainder must expect 538, never 539 or 1000
    const b2 = await book(venue3333);
    const claim2 = (await rpc('checkout_claim_group', { p_brand_id: brandId, p_retailer_id: retailerId, p_booking_ids: [b2], p_platform_keeps_all: false, p_connect_account_id: ACCT, p_platform_fee_cents: 1000 })).body;
    const sid2 = 'cs_round_' + uniq('z'), pi2 = 'pi_round_' + uniq('z').replace(/-/g, ''), ch2 = 'ch_round_' + uniq('z').replace(/-/g, '');
    await rpc('register_payment_attempt', { p_group_id: claim2.payment_group_id, p_session_id: sid2, p_payment_intent: pi2, p_hash: 'h-' + claim2.payment_group_id, p_schema: 1 });
    const paid2 = (await rpc('apply_verified_payment', { p_session_id: sid2, p_payment_intent: pi2, p_charge: ch2, p_amount: claim2.total_customer_amount, p_currency: 'usd', p_connect_dest: ACCT, p_on_behalf_of: ACCT, p_application_fee: 1000, p_transfer_id: 'tr_r_' + uniq('z').replace(/-/g, ''), p_fee_id: 'fee_r_' + uniq('z').replace(/-/g, '') })).body;
    ok('rounding group: claim total 4333, applied', claim2.total_customer_amount === 4333 && paid2 && paid2.outcome === 'applied', JSON.stringify({ claim2, paid2 }));
    const first = (await rpc('refund_reserve_cas', { p_booking_id: b2, p_op_key: b2 + ':partial1', p_actor: 'test', p_reason: 'round' })).body;
    ok('allocation 4333 (3333 + 1000): a full-remainder reservation expects fee 1000', first.amount === 4333 && first.expected_fee_refund_amount === 1000, JSON.stringify(first));
    // turn it into a recorded partial of 2000 (the ledger never does this itself today; the rule must still hold)
    await db(`refund_requests?id=eq.${first.refund_request_id}`, { method: 'PATCH', body: JSON.stringify({ amount: 2000, expected_customer_amount: 2000, expected_transfer_reversal_amount: 2000, expected_fee_refund_amount: 462, status: 'succeeded', customer_refund_status: 'succeeded', stripe_refund_id: 're_round_' + uniq('z').replace(/-/g, '') }) });
    await db(`refund_operations?id=eq.${first.refund_operation_id}`, { method: 'PATCH', body: JSON.stringify({ status: 'succeeded' }) });
    const alloc2 = (await db(`payment_allocations?booking_id=eq.${b2}&select=id`)).body[0];
    await db(`payment_allocations?id=eq.${alloc2.id}`, { method: 'PATCH', body: JSON.stringify({ refunded_amount: 2000, reserved_refund_amount: 0 }) });
    const second = (await rpc('refund_reserve_cas', { p_booking_id: b2, p_op_key: b2 + ':partial2', p_actor: 'test', p_reason: 'round' })).body;
    ok('the remainder (2333) expects fee round(1000 * 4333 / 4333) - 462 = 538, so the two legs sum to exactly 1000', second.outcome === 'reserved' && second.amount === 2333 && second.expected_fee_refund_amount === 538, JSON.stringify(second));
    // this reservation has no simulated provider behind it; keep it out of every later worker run in this suite
    await db(`refund_requests?id=eq.${second.refund_request_id}`, { method: 'PATCH', body: JSON.stringify({ next_attempt_at: new Date(Date.now() + 36e5).toISOString() }) });
  }

  console.log('\nCC-3: evidence that does not bind is refused (never complete), and good replay stays idempotent');
  {
    const bad = async (label, mutate, expectReason) => {
      const c = await paidCart([venue150]);
      spy.faults.push({ url: `/v1/application_fees/${c.fee}/refunds`, method: 'POST', status: 500, message: 'hold', once: true });   // keep the cancel path from settling, so the mutation applies first
      await cancel(c.ids[0]);
      let rq = await requestOf(c.ids[0]);
      await mutate(c, rq);
      await db(`refund_requests?id=eq.${rq.id}`, { method: 'PATCH', body: JSON.stringify({ settlement_next_attempt_at: null, transfer_reversal_status: null, stripe_transfer_reversal_id: null }) });
      await runWorker(); rq = await requestOf(c.ids[0]);
      const cases = await casesOf(rq.id);
      ok(`${label}: settlement_status exception with reason ${expectReason}, never complete; a deduplicated case`, rq.settlement_status === 'exception' && cases.some(x => x.kind === 'settlement_exception' && x.reason === expectReason && x.dedupe_key === 'settlement:' + rq.id) && cases.filter(x => x.dedupe_key === 'settlement:' + rq.id).length === 1, JSON.stringify({ status: rq.settlement_status, cases: cases.map(x => x.reason) }));
      await runWorker(); const rq2 = await requestOf(c.ids[0]);
      ok(`${label}: an exception is not claimed again (attempts unchanged)`, rq2.settlement_attempts === rq.settlement_attempts);
      return c;
    };
    await bad('wrong request metadata on the refund', async (c, rq) => { c.sim.overrides['refund:' + rq.stripe_refund_id] = { metadata: { refund_request_id: 'someone-else' } }; }, 'refund_binding_mismatch');
    await bad('wrong charge on the refund', async (c, rq) => { c.sim.overrides['refund:' + rq.stripe_refund_id] = { charge: 'ch_other' }; }, 'refund_binding_mismatch');
    await bad('wrong amount on the refund', async (c, rq) => { c.sim.overrides['refund:' + rq.stripe_refund_id] = { amount: 15999 }; }, 'refund_binding_mismatch');
    await bad('reversal under a different parent transfer', async (c, rq) => { const trr = c.sim.reversals[0]; c.sim.overrides['reversal:' + trr.id] = { transfer: 'tr_other' }; }, 'transfer_reversal_mismatch');
    await bad('reversal with the wrong amount', async (c, rq) => { const trr = c.sim.reversals[0]; c.sim.overrides['reversal:' + trr.id] = { amount: 15000 }; }, 'transfer_reversal_mismatch');
    await bad('fee refund in the wrong currency', async (c, rq) => { spy.fixtures.byPath[`POST /v1/application_fees/${c.fee}/refunds`] = (form) => ({ id: 'fr_' + uniq('w').replace(/-/g, ''), object: 'fee_refund', amount: Number(form.amount), currency: 'eur', fee: c.fee, created: Math.floor(Date.now() / 1000), metadata: {} }); }, 'fee_refund_mismatch');

    // conflicting evidence on replay, at the RPC: a different id, a regression, a mismatched amount are all refused
    const c = await paidCart([venue150]);
    await cancel(c.ids[0]); const rq = await requestOf(c.ids[0]);
    ok('a good request completed through the cancel path', isComplete(rq));
    const conflict = await rpc('record_settlement_leg', { p_request_id: rq.id, p_leg: 'transfer_reversal', p_stripe_id: 'trr_other', p_status: 'succeeded', p_amount: 16000, p_currency: 'usd' });
    const regress = await rpc('record_settlement_leg', { p_request_id: rq.id, p_leg: 'fee_refund', p_stripe_id: rq.stripe_fee_refund_id, p_status: 'failed', p_amount: 1000, p_currency: 'usd' });
    const mismatch = await rpc('record_settlement_leg', { p_request_id: rq.id, p_leg: 'fee_refund', p_stripe_id: rq.stripe_fee_refund_id, p_status: 'succeeded', p_amount: 999, p_currency: 'usd' });
    const same = await rpc('record_settlement_leg', { p_request_id: rq.id, p_leg: 'fee_refund', p_stripe_id: rq.stripe_fee_refund_id, p_status: 'succeeded', p_amount: 1000, p_currency: 'usd' });
    const after = await requestOf(c.ids[0]);
    ok('the RPC refuses a different id (settlement_leg_conflict), a regression (settlement_leg_regress) and a wrong amount (settlement_leg_mismatch); the same evidence again is accepted and nothing changed', !conflict.ok && /settlement_leg_conflict/.test(conflict.text) && !regress.ok && /settlement_leg_regress/.test(regress.text) && !mismatch.ok && /settlement_leg_mismatch/.test(mismatch.text) && same.ok && isComplete(after) && after.stripe_transfer_reversal_id === rq.stripe_transfer_reversal_id, JSON.stringify({ conflict: conflict.text.slice(0, 60), regress: regress.text.slice(0, 60), mismatch: mismatch.text.slice(0, 60), same: same.body }));
    // duplicate events are idempotent
    const re = c.sim.refunds[0];
    const w1 = await refundEvent(re); const w2 = await refundEvent(re, 'charge.refunded' === 'x' ? 'refund.updated' : 'refund.updated');
    const after2 = await requestOf(c.ids[0]);
    ok('replaying the refund event twice: 200, still complete, the same ids, still one fee refund', w1.statusCode === 200 && w2.statusCode === 200 && isComplete(after2) && after2.stripe_fee_refund_id === rq.stripe_fee_refund_id && c.sim.feeRefunds.length === 1);

    // legacy strategy 1: two equal-amount fee refunds at the same timestamp are an unresolved exception, exactly one is accepted
    const l = await paidCart([venue150]);
    spy.faults.push({ url: `/v1/application_fees/${l.fee}/refunds`, method: 'POST', status: 500, message: 'hold', once: true });
    await cancel(l.ids[0]); let rql = await requestOf(l.ids[0]);
    const created = Math.floor(Date.now() / 1000);
    l.sim.feeRefunds.push({ id: 'fr_legacy1_' + uniq('z').replace(/-/g, ''), object: 'fee_refund', amount: 1000, currency: 'usd', fee: l.fee, created, metadata: {} }, { id: 'fr_legacy2_' + uniq('z').replace(/-/g, ''), object: 'fee_refund', amount: 1000, currency: 'usd', fee: l.fee, created, metadata: {} });
    await db(`refund_requests?id=eq.${rql.id}`, { method: 'PATCH', body: JSON.stringify({ settlement_strategy: 1, settlement_next_attempt_at: null }) });
    await runWorker(); rql = await requestOf(l.ids[0]);
    ok('strategy 1 with two equal-amount candidates at the same second: legacy_fee_refund_ambiguous exception, no association invented', rql.settlement_status === 'exception' && (await casesOf(rql.id)).some(x => x.reason === 'legacy_fee_refund_ambiguous') && !rql.stripe_fee_refund_id, JSON.stringify(rql));
    const FR_ONLY = 'fr_legacy_only_' + uniq('z').replace(/-/g, '');
    const l2 = await paidCart([venue150]);
    spy.faults.push({ url: `/v1/application_fees/${l2.fee}/refunds`, method: 'POST', status: 500, message: 'hold', once: true });
    await cancel(l2.ids[0]); let rql2 = await requestOf(l2.ids[0]);
    l2.sim.feeRefunds.push({ id: FR_ONLY, object: 'fee_refund', amount: 1000, currency: 'usd', fee: l2.fee, created: Math.floor(Date.now() / 1000), metadata: {} });
    await db(`refund_requests?id=eq.${rql2.id}`, { method: 'PATCH', body: JSON.stringify({ settlement_strategy: 1, settlement_next_attempt_at: null }) });
    await runWorker(); rql2 = await requestOf(l2.ids[0]);
    ok('strategy 1 with exactly one matching candidate: recorded and complete', isComplete(rql2) && rql2.stripe_fee_refund_id === FR_ONLY, JSON.stringify({ rql2: rql2.settlement_status, cases: await casesOf(rql2.id), list: l2.sim.feeRefunds.map(x => x.id) }));

    // a failed list read is a retry, never an empty list
    const f = await paidCart([venue150]);
    spy.faults.push({ url: `/v1/application_fees/${f.fee}/refunds`, method: 'POST', status: 500, message: 'hold', once: true });
    await cancel(f.ids[0]); let rqf = await requestOf(f.ids[0]);
    spy.faults.push({ url: `/v1/application_fees/${f.fee}/refunds`, method: 'GET', status: 500, message: 'list_outage', once: true });
    await db(`refund_requests?id=eq.${rqf.id}`, { method: 'PATCH', body: JSON.stringify({ settlement_next_attempt_at: null }) });
    await runWorker(); rqf = await requestOf(f.ids[0]);
    ok('a failed read of the fee refund list (needed before any new call once intent exists) is a retry with the reason persisted, not complete, no new fee refund', rqf.settlement_status === 'pending' && /stripe_list_fee_refunds/.test(rqf.settlement_last_error || '') && f.sim.feeRefunds.length === 0, JSON.stringify(rqf));
    await db(`refund_requests?id=eq.${rqf.id}`, { method: 'PATCH', body: JSON.stringify({ settlement_next_attempt_at: null }) });
    await runWorker(); rqf = await requestOf(f.ids[0]);
    ok('then it completes with one fee refund', isComplete(rqf) && f.sim.feeRefunds.length === 1);
  }

  console.log('\nCC-2: delayed transfer / application fee ids on a paid group are filled by the worker from validated provider state');
  {
    const ids = [await book(venue150)];
    const co = await callRoute('checkout.js', req({ body: { booking_ids: ids }, cookies: { dh_brand_session: brandCookie } }));
    const gid = co.body.payment_group_id, sid = co.body.session_id;
    const pi = 'pi_' + uniq('d').replace(/-/g, ''), charge = 'ch_' + uniq('d').replace(/-/g, ''), transfer = 'tr_' + uniq('d').replace(/-/g, ''), fee = 'fee_' + uniq('d').replace(/-/g, '');
    // the paid event arrives before Stripe filled the ids (the handler's re-read sees them still missing)
    spy.fixtures.paymentIntents[pi] = { id: pi, object: 'payment_intent', amount_received: 16000, currency: 'usd', on_behalf_of: ACCT, latest_charge: { id: charge, object: 'charge', destination: ACCT, application_fee_amount: 1000, transfer: null, application_fee: null } };
    const raw = JSON.stringify({ id: 'evt_' + uniq('p'), type: 'checkout.session.completed', data: { object: { id: sid, object: 'checkout.session', mode: 'payment', payment_status: 'paid', amount_total: 16000, currency: 'usd', payment_intent: pi, metadata: { payment_group_id: gid } } } });
    const w = await callRoute('stripe-webhook.js', rawReq(raw, { signature: sign(raw) }));
    const g1 = one(await db(`payment_groups?id=eq.${gid}&select=status,stripe_transfer_id,stripe_application_fee_id`));
    ok('paid without the ids: group paid, transfer and fee ids null', w.statusCode === 200 && g1.status === 'paid' && g1.stripe_transfer_id === null && g1.stripe_application_fee_id === null, JSON.stringify(g1));
    spy.fixtures.byPath[`/v1/charges/${charge}`] = () => ({ id: charge, object: 'charge', payment_intent: pi, destination: ACCT, on_behalf_of: ACCT, application_fee_amount: 1000, transfer, application_fee: fee, amount: 16000 });
    const wk = await runWorker();
    const g2 = one(await db(`payment_groups?id=eq.${gid}&select=status,stripe_transfer_id,stripe_application_fee_id`));
    ok('the worker read the charge, validated it against the group and filled both ids through the idempotent apply', wk.body && wk.body.group_ids_filled >= 1 && g2.stripe_transfer_id === transfer && g2.stripe_application_fee_id === fee, JSON.stringify({ g2, out: wk.body && { c: wk.body.group_ids_checked, f: wk.body.group_ids_filled } }));
    // a charge that does not match the group is a contradiction case, never a fill
    const ids2 = [await book(venue150)];
    const co2 = await callRoute('checkout.js', req({ body: { booking_ids: ids2 }, cookies: { dh_brand_session: brandCookie } }));
    const pi2 = 'pi_' + uniq('e').replace(/-/g, ''), charge2 = 'ch_' + uniq('e').replace(/-/g, '');
    spy.fixtures.paymentIntents[pi2] = { id: pi2, object: 'payment_intent', amount_received: 16000, currency: 'usd', on_behalf_of: ACCT, latest_charge: { id: charge2, object: 'charge', destination: ACCT, application_fee_amount: 1000, transfer: null, application_fee: null } };
    const raw2 = JSON.stringify({ id: 'evt_' + uniq('p'), type: 'checkout.session.completed', data: { object: { id: co2.body.session_id, object: 'checkout.session', mode: 'payment', payment_status: 'paid', amount_total: 16000, currency: 'usd', payment_intent: pi2, metadata: { payment_group_id: co2.body.payment_group_id } } } });
    await callRoute('stripe-webhook.js', rawReq(raw2, { signature: sign(raw2) }));
    spy.fixtures.byPath[`/v1/charges/${charge2}`] = () => ({ id: charge2, object: 'charge', payment_intent: pi2, destination: 'acct_other', on_behalf_of: 'acct_other', application_fee_amount: 1000, transfer: 'tr_x', application_fee: 'fee_x', amount: 16000 });
    await runWorker();
    const g3 = one(await db(`payment_groups?id=eq.${co2.body.payment_group_id}&select=stripe_transfer_id,stripe_application_fee_id`));
    const gc = (await db(`reconciliation_cases?payment_group_id=eq.${co2.body.payment_group_id}&select=reason`)).body || [];
    ok('a charge whose destination differs from the group: ids NOT filled, a group_charge_mismatch case', g3.stripe_transfer_id === null && gc.some(x => x.reason === 'group_charge_mismatch'), JSON.stringify({ g3, gc }));
  }

  console.log('\nCC-4: intake switched off with a connected payment, an issued session and a pending settlement');
  {
    const open = await paidCart([venue150]);                        // paid, will be refunded with intake off
    const issuedIds = [await book(venue150)];                        // a session issued before the switch
    const issued = await callRoute('checkout.js', req({ body: { booking_ids: issuedIds }, cookies: { dh_brand_session: brandCookie } }));
    ok('before the switch: a connected session was issued', issued.statusCode === 200, String(issued.statusCode));
    const pend = await paidCart([venue150]);
    spy.faults.push({ url: `/v1/application_fees/${pend.fee}/refunds`, method: 'POST', status: 500, message: 'hold', once: true });
    await cancel(pend.ids[0]);
    ok('before the switch: a refund with its settlement still pending', (await requestOf(pend.ids[0])).settlement_status === 'pending');
    delete ENV.CONNECTED_CHECKOUT_ENABLED;
    const newIds = [await book(venue150)];
    const refused = await callRoute('checkout.js', req({ body: { booking_ids: newIds }, cookies: { dh_brand_session: brandCookie } }));
    ok('intake off: a new connected checkout is refused 409 connected_checkout_unavailable_pilot', refused.statusCode === 409 && refused.body.error === 'connected_checkout_unavailable_pilot');
    const pi = 'pi_' + uniq('f').replace(/-/g, ''), charge = 'ch_' + uniq('f').replace(/-/g, '');
    spy.fixtures.paymentIntents[pi] = { id: pi, object: 'payment_intent', amount_received: 16000, currency: 'usd', on_behalf_of: ACCT, latest_charge: { id: charge, object: 'charge', destination: ACCT, application_fee_amount: 1000, transfer: 'tr_f_' + uniq('z').replace(/-/g, ''), application_fee: 'fee_f_' + uniq('z').replace(/-/g, '') } };
    const raw = JSON.stringify({ id: 'evt_' + uniq('p'), type: 'checkout.session.completed', data: { object: { id: issued.body.session_id, object: 'checkout.session', mode: 'payment', payment_status: 'paid', amount_total: 16000, currency: 'usd', payment_intent: pi, metadata: { payment_group_id: issued.body.payment_group_id } } } });
    const w = await callRoute('stripe-webhook.js', rawReq(raw, { signature: sign(raw) }));
    ok('intake off: the customer completing the already-issued session is still applied (group paid)', w.statusCode === 200 && (await groupStatus(issued.body.payment_group_id)) === 'paid', JSON.stringify({ w: w.statusCode, body: w.body, g: await groupStatus(issued.body.payment_group_id), cases: (await db(`reconciliation_cases?payment_group_id=eq.${issued.body.payment_group_id}&select=reason,details`)).body }));
    const r = await cancel(open.ids[0]); const rqo = await requestOf(open.ids[0]);
    ok('intake off: a refund of an existing connected payment still converges, settlement complete', r.statusCode === 200 && isComplete(rqo), JSON.stringify({ r: r.statusCode, s: rqo && rqo.settlement_status }));
    await runWorker(); const rqp = await requestOf(pend.ids[0]);
    ok('intake off: the pending settlement is completed by the worker', isComplete(rqp), JSON.stringify(rqp && rqp.settlement_status));
    ENV.CONNECTED_CHECKOUT_ENABLED = 'true';
  }

  console.log('\nR3-3: a customer refund made outside the routes under the request\'s key, with other parameters, is adopted by the worker, never resubmitted');
  {
    const postsOf = () => spy.calls.stripe.filter(x => String(x.method).toUpperCase() === 'POST' && /\/v1\/refunds$/.test(x.url.replace(/\?.*$/, ''))).length;
    const keyOf = (x) => x.headers && (x.headers['Idempotency-Key'] || x.headers['idempotency-key']);
    const sectionStart = spy.calls.stripe.length;
    // (a) the reported case: same key, no reason field, the ledger never told, no webhook
    const c = await paidCart([venue150]);
    const rr = (await rpc('refund_reserve_cas', { p_booking_id: c.ids[0], p_op_key: c.ids[0] + ':cancel', p_actor: 'support-tool', p_reason: 'outside the routes' })).body;
    const outside = await (await fetch('https://api.stripe.com/v1/refunds', { method: 'POST', headers: { 'Idempotency-Key': rr.idempotency_key, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ payment_intent: c.pi, amount: String(rr.amount), reverse_transfer: 'true', 'metadata[refund_request_id]': rr.refund_request_id, 'metadata[booking_id]': c.ids[0] }).toString() })).json();
    ok('(a) the outside refund exists on the provider, tagged with the request, the ledger not told (request reserved, no refund id)', outside && /^re_/.test(outside.id) && (await requestOf(c.ids[0])).status === 'reserved' && !(await requestOf(c.ids[0])).stripe_refund_id, JSON.stringify(outside).slice(0, 160));
    const p0 = postsOf();
    const w = await runWorker();
    let rq = await requestOf(c.ids[0]);
    ok('(a) the worker resubmits ONCE under the stored key, the provider refuses it (idempotency_error), and the worker adopts the existing refund: request succeeded with that refund id, nothing created under any other key, exactly one customer refund', w.statusCode === 200 && postsOf() - p0 === 1 && rq.stripe_refund_id === outside.id && rq.status === 'succeeded' && c.sim.refunds.length === 1 && w.body.adopted >= 1 && w.body.errors === 0, JSON.stringify({ w: w.statusCode, body: w.body, rq, refunds: c.sim.refunds.length }));
    if (!isComplete(rq)) { await runWorker(); rq = await requestOf(c.ids[0]); }
    ok('(a) settlement then completes on the adopted refund: the exact fee refund created under the request\'s fee key, the reversal verified', isComplete(rq) && c.sim.feeRefunds.length === 1 && c.sim.feeRefunds[0].amount === 1000 && c.sim.refunds.length === 1, JSON.stringify({ rq, fees: c.sim.feeRefunds.map(x => x.amount) }));

    // (b) mismatched: the outside refund carries the request id but the wrong amount: neither adopted nor resubmitted
    const d = await paidCart([venue150]);
    const rd = (await rpc('refund_reserve_cas', { p_booking_id: d.ids[0], p_op_key: d.ids[0] + ':cancel', p_actor: 'support-tool', p_reason: 'wrong amount' })).body;
    await (await fetch('https://api.stripe.com/v1/refunds', { method: 'POST', headers: { 'Idempotency-Key': rd.idempotency_key, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ payment_intent: d.pi, amount: String(rd.amount - 100), reverse_transfer: 'true', 'metadata[refund_request_id]': rd.refund_request_id }).toString() })).json();
    const p1 = postsOf();
    const w2 = await runWorker();
    const rq2 = await requestOf(d.ids[0]);
    ok('(b) wrong amount under the request id: the conflict is a controlled retry (failed_retryable, reason recorded), no adoption, no second refund, one provider refusal only', postsOf() - p1 === 1 && rq2.status === 'failed_retryable' && !rq2.stripe_refund_id && /idempotency_conflict/.test(rq2.last_error || '') && d.sim.refunds.length === 1 && w2.body.adopted === 0, JSON.stringify({ rq2, posts: postsOf() - p1, refunds: d.sim.refunds.length }));
    // keep (b)'s row out of the next runs (its backoff would make it due again and its retry is not what (c) measures)
    await db(`refund_requests?id=eq.${rq2.id}`, { method: 'PATCH', body: JSON.stringify({ next_attempt_at: new Date(Date.now() + 36e5).toISOString() }) });

    // (c) ambiguous: two live refunds carry the request id (one under the key with other parameters, one with no key): review, no adoption, no resubmit
    const e = await paidCart([venue150]);
    const re2 = (await rpc('refund_reserve_cas', { p_booking_id: e.ids[0], p_op_key: e.ids[0] + ':cancel', p_actor: 'support-tool', p_reason: 'twice' })).body;
    await (await fetch('https://api.stripe.com/v1/refunds', { method: 'POST', headers: { 'Idempotency-Key': re2.idempotency_key, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ payment_intent: e.pi, amount: String(re2.amount), reverse_transfer: 'true', 'metadata[refund_request_id]': re2.refund_request_id }).toString() })).json();
    e.sim.createRefund({ payment_intent: e.pi, amount: String(re2.amount), reverse_transfer: 'true', 'metadata[refund_request_id]': re2.refund_request_id }, '', {});
    const p2 = postsOf();
    const w3 = await runWorker();
    const rq3 = await requestOf(e.ids[0]);
    ok('(c) two qualifying refunds for one request: parked requires_review with the candidates named, nothing adopted, nothing resubmitted', postsOf() - p2 === 1 && rq3.status === 'requires_review' && !rq3.stripe_refund_id && /ambiguous/.test(rq3.last_error || '') && e.sim.refunds.length === 2 && w3.body && w3.body.adopted === 0 && w3.body.manual >= 1, JSON.stringify({ posts: postsOf() - p2, w3: w3.statusCode, body: w3.body, status: rq3.status, err: rq3.last_error, refund: rq3.stripe_refund_id, refunds: e.sim.refunds.length }));
    ok('(c) the parked request has its review case', (await casesOf(rq3.id)).length >= 1);
    ok('every strategy 2 submission the routes and the worker made in this section carried the canonical parameter set (payment_intent, amount, reverse_transfer, reason, metadata) and no refund_application_fee', spy.calls.stripe.slice(sectionStart).filter(x => String(x.method).toUpperCase() === 'POST' && /\/v1\/refunds$/.test(x.url.replace(/\?.*$/, '')) && /reason=requested_by_customer/.test(x.body)).every(x => /payment_intent=/.test(x.body) && /amount=/.test(x.body) && /reverse_transfer=true/.test(x.body) && /metadata%5Brefund_request_id%5D=/.test(x.body) && !/refund_application_fee/.test(x.body)));
    void keyOf;
  }

  console.log('\nSmall correction 2: a fee refund list that cannot be proven complete never authorizes a new fee refund');
  {
    const c = await paidCart([venue150]);
    // the first fee refund create fails transiently, so the next attempt has to look before it creates
    spy.faults.push({ url: `/v1/application_fees/${c.fee}/refunds`, method: 'POST', status: 500, once: true });
    const r = await cancel(c.ids[0]);
    let rq = await requestOf(c.ids[0]);
    ok('the cancel succeeds, the customer refund is applied, the fee leg is deferred after the transient failure (intent recorded, no fee refund)', r.statusCode === 200 && rq.status === 'succeeded' && rq.settlement_status === 'pending' && !!rq.fee_refund_intent_at && c.sim.feeRefunds.length === 0, JSON.stringify(rq));
    // the provider now answers the list with has_more on every page (the cap is reached with more to come)
    const normalList = spy.fixtures.byPath[`/v1/application_fees/${c.fee}/refunds`];
    spy.fixtures.byPath[`/v1/application_fees/${c.fee}/refunds`] = () => ({ object: 'list', has_more: true, data: [{ id: 'fr_elsewhere_' + uniq('o').replace(/-/g, ''), object: 'fee_refund', amount: 1, currency: 'usd', fee: c.fee, metadata: {} }] });
    await db(`refund_requests?id=eq.${rq.id}`, { method: 'PATCH', body: JSON.stringify({ settlement_next_attempt_at: null }) });
    const gets0 = spy.calls.stripe.length;
    await runWorker(); rq = await requestOf(c.ids[0]);
    const pages = spy.calls.stripe.slice(gets0).filter(x => String(x.method).toUpperCase() === 'GET' && x.url.includes(`/v1/application_fees/${c.fee}/refunds`)).length;
    ok('incomplete enumeration: the worker read the page cap and stopped as a retry; no fee refund was created and the reason is recorded', rq.settlement_status === 'pending' && c.sim.feeRefunds.length === 0 && pages >= 20 && /incomplete/.test(rq.settlement_last_error || ''), JSON.stringify({ pages, rq }));
    // malformed data is a failure too
    spy.fixtures.byPath[`/v1/application_fees/${c.fee}/refunds`] = () => ({ object: 'list', has_more: false, data: null });
    await db(`refund_requests?id=eq.${rq.id}`, { method: 'PATCH', body: JSON.stringify({ settlement_next_attempt_at: null }) });
    await runWorker(); rq = await requestOf(c.ids[0]);
    ok('malformed list: a retry, still no fee refund', rq.settlement_status === 'pending' && c.sim.feeRefunds.length === 0 && /malformed/.test(rq.settlement_last_error || ''), JSON.stringify(rq.settlement_last_error));
    spy.fixtures.byPath[`/v1/application_fees/${c.fee}/refunds`] = normalList;
    await db(`refund_requests?id=eq.${rq.id}`, { method: 'PATCH', body: JSON.stringify({ settlement_next_attempt_at: null }) });
    await runWorker(); rq = await requestOf(c.ids[0]);
    ok('once the list is complete again the worker creates exactly one fee refund and completes', isComplete(rq) && c.sim.feeRefunds.length === 1 && c.sim.feeRefunds[0].amount === 1000, JSON.stringify({ rq, fees: c.sim.feeRefunds.length }));
  }

  console.log('\nR4-2 (i): contradictory pagination of the fee refund list fails closed (api/_booking-refund.js listFeeRefunds)');
  {
    const c = await paidCart([venue150]);
    spy.faults.push({ url: `/v1/application_fees/${c.fee}/refunds`, method: 'POST', status: 500, once: true });
    await cancel(c.ids[0]);
    let rq = await requestOf(c.ids[0]);
    ok('setup: the fee leg is deferred with intent recorded, so every later attempt must look before it creates', rq.settlement_status === 'pending' && !!rq.fee_refund_intent_at && c.sim.feeRefunds.length === 0, JSON.stringify(rq));
    const normalList = spy.fixtures.byPath[`/v1/application_fees/${c.fee}/refunds`];
    const item = (id) => ({ id, object: 'fee_refund', amount: 1, currency: 'usd', fee: c.fee, metadata: {} });
    let calls = 0;
    const variants = [
      ['an empty page claiming has_more', () => ({ object: 'list', has_more: true, data: [] }), /malformed_fee_refund_list:has_more_with_empty_page/],
      ['has_more missing', () => ({ object: 'list', data: [] }), /malformed_fee_refund_list:malformed_has_more/],
      ['has_more not a boolean', () => ({ object: 'list', has_more: 'yes', data: [] }), /malformed_fee_refund_list:malformed_has_more/],
      ['a repeated cursor (every page ends in the same id)', () => ({ object: 'list', has_more: true, data: [item('fr_same_cursor')] }), /malformed_fee_refund_list:cursor_not_advancing/],
      ['a page claiming more whose last object has no id', () => ({ object: 'list', has_more: true, data: [{ object: 'fee_refund', amount: 1 }] }), /malformed_fee_refund_list:has_more_without_cursor/],
      ['a later page failing', () => (++calls === 1 ? { object: 'list', has_more: true, data: [item('fr_first_page_' + uniq('f').replace(/-/g, ''))] } : { __status: 500, body: { error: { message: 'page_two_outage', type: 'api_error' } } }), /stripe_list_fee_refunds/],
    ];
    for (const [label, fx, re] of variants) {
      calls = 0;
      spy.fixtures.byPath[`/v1/application_fees/${c.fee}/refunds`] = fx;
      await db(`refund_requests?id=eq.${rq.id}`, { method: 'PATCH', body: JSON.stringify({ settlement_next_attempt_at: null }) });
      const posts0 = c.sim.feeForms.length;
      await runWorker(); rq = await requestOf(c.ids[0]);
      ok(`${label}: a controlled retry (settlement pending, reason recorded), no fee refund POST, nothing created`, rq.settlement_status === 'pending' && c.sim.feeRefunds.length === 0 && c.sim.feeForms.length === posts0 && re.test(rq.settlement_last_error || ''), JSON.stringify({ err: rq.settlement_last_error, fees: c.sim.feeRefunds.length, posts: c.sim.feeForms.length - posts0 }));
    }
    spy.fixtures.byPath[`/v1/application_fees/${c.fee}/refunds`] = normalList;
    await db(`refund_requests?id=eq.${rq.id}`, { method: 'PATCH', body: JSON.stringify({ settlement_next_attempt_at: null }) });
    await runWorker(); rq = await requestOf(c.ids[0]);
    ok('a complete valid list (empty, has_more false): exactly one justified fee refund is created and settlement completes', isComplete(rq) && c.sim.feeRefunds.length === 1 && c.sim.feeRefunds[0].amount === 1000 && rq.stripe_fee_refund_id === c.sim.feeRefunds[0].id, JSON.stringify({ rq, fees: c.sim.feeRefunds.length }));
    // and a complete list that already holds the request's fee refund (an earlier attempt reached the provider): found, not created again
    const d = await paidCart([venue150]);
    spy.faults.push({ url: `/v1/application_fees/${d.fee}/refunds`, method: 'POST', status: 500, once: true });
    await cancel(d.ids[0]);
    let rqd = await requestOf(d.ids[0]);
    const prior = { id: 'fr_prior_' + uniq('p').replace(/-/g, ''), object: 'fee_refund', amount: 1000, currency: 'usd', fee: d.fee, created: Math.floor(Date.now() / 1000), metadata: { refund_request_id: rqd.id } };
    d.sim.feeRefunds.push(prior);
    const posts1 = d.sim.feeForms.length;
    await db(`refund_requests?id=eq.${rqd.id}`, { method: 'PATCH', body: JSON.stringify({ settlement_next_attempt_at: null }) });
    await runWorker(); rqd = await requestOf(d.ids[0]);
    ok('a complete valid list holding the request\'s own fee refund: recovery records it, no second fee refund is created', isComplete(rqd) && rqd.stripe_fee_refund_id === prior.id && d.sim.feeForms.length === posts1 && d.sim.feeRefunds.length === 1, JSON.stringify({ rqd: rqd.settlement_status, id: rqd.stripe_fee_refund_id, posts: d.sim.feeForms.length - posts1 }));
  }

  console.log('\nR4-2 (ii): contradictory pagination of the PaymentIntent refund list fails closed (api/refund-worker.js stripeListRefundsForPI, the adoption lookup)');
  {
    const postsOf = () => spy.calls.stripe.filter(x => String(x.method).toUpperCase() === 'POST' && /\/v1\/refunds$/.test(x.url.replace(/\?.*$/, ''))).length;
    const e = await paidCart([venue150]);
    const re = (await rpc('refund_reserve_cas', { p_booking_id: e.ids[0], p_op_key: e.ids[0] + ':cancel', p_actor: 'support-tool', p_reason: 'outside, other parameters' })).body;
    const outside = await (await fetch('https://api.stripe.com/v1/refunds', { method: 'POST', headers: { 'Idempotency-Key': re.idempotency_key, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ payment_intent: e.pi, amount: String(re.amount), reverse_transfer: 'true', 'metadata[refund_request_id]': re.refund_request_id }).toString() })).json();
    ok('setup: the request\'s key was used outside with other parameters, so the worker\'s resubmit is refused and it must look the refund up', outside && /^re_/.test(outside.id) && (await requestOf(e.ids[0])).status === 'reserved');
    const normalRefundList = spy.fixtures.byPath['/v1/refunds'];
    const ritem = (id) => ({ id, object: 'refund', amount: re.amount, currency: 'usd', status: 'succeeded', payment_intent: e.pi, charge: e.charge, metadata: { refund_request_id: re.refund_request_id } });
    let wcalls = 0;
    const wvariants = [
      ['an empty page claiming has_more', () => ({ object: 'list', has_more: true, data: [] }), /list: malformed_refund_list:has_more_with_empty_page/],
      ['has_more missing', () => ({ object: 'list', data: [] }), /list: malformed_refund_list:malformed_has_more/],
      ['has_more not a boolean', () => ({ object: 'list', has_more: 'true', data: [] }), /list: malformed_refund_list:malformed_has_more/],
      ['a repeated cursor', () => ({ object: 'list', has_more: true, data: [ritem('re_same_cursor')] }), /list: malformed_refund_list:cursor_not_advancing/],
      ['a page claiming more whose last object has no id', () => ({ object: 'list', has_more: true, data: [{ object: 'refund' }] }), /list: malformed_refund_list:has_more_without_cursor/],
      ['a later page failing', () => (++wcalls === 1 ? { object: 'list', has_more: true, data: [ritem('re_first_page_' + uniq('w').replace(/-/g, ''))] } : { __status: 500 }), /list: fixture 500/],
      ['the page cap reached with more to come', () => ({ object: 'list', has_more: true, data: [ritem('re_cap_' + uniq('c').replace(/-/g, ''))] }), /list: incomplete_refund_list/],
    ];
    let rq;
    for (const [label, fx, rex] of wvariants) {
      wcalls = 0;
      spy.fixtures.byPath['/v1/refunds'] = (form, url) => (new URL(url).searchParams.get('payment_intent') === e.pi ? fx() : normalRefundList(form, url));
      await db(`refund_requests?id=eq.${re.refund_request_id}`, { method: 'PATCH', body: JSON.stringify({ next_attempt_at: new Date().toISOString() }) });   // due now (a NULL next_attempt_at is never due)
      const p0 = postsOf();
      const w = await runWorker(); rq = await requestOf(e.ids[0]);
      ok(`${label}: no adoption (failed_retryable with the reason), one refused resubmit only, still exactly one refund on the provider, no fee refund`, rq.status === 'failed_retryable' && !rq.stripe_refund_id && rex.test(rq.last_error || '') && postsOf() - p0 === 1 && e.sim.refunds.length === 1 && e.sim.feeRefunds.length === 0 && w.body && w.body.adopted === 0, JSON.stringify({ status: rq.status, err: rq.last_error, posts: postsOf() - p0, refunds: e.sim.refunds.length, adopted: w.body && w.body.adopted }));
    }
    spy.fixtures.byPath['/v1/refunds'] = normalRefundList;
    await db(`refund_requests?id=eq.${re.refund_request_id}`, { method: 'PATCH', body: JSON.stringify({ next_attempt_at: new Date().toISOString() }) });   // due now (a NULL next_attempt_at is never due)
    const w = await runWorker(); rq = await requestOf(e.ids[0]);
    ok('a complete valid list: the existing refund is adopted (succeeded with its id), nothing created under any key', w.body && w.body.adopted >= 1 && rq.status === 'succeeded' && rq.stripe_refund_id === outside.id && e.sim.refunds.length === 1, JSON.stringify({ body: w.body && { adopted: w.body.adopted, errors: w.body.errors }, rq: rq.status, id: rq.stripe_refund_id }));
    if (!isComplete(rq)) { await runWorker(); rq = await requestOf(e.ids[0]); }
    ok('settlement then completes on the adopted refund with exactly one fee refund', isComplete(rq) && e.sim.feeRefunds.length === 1 && e.sim.feeRefunds[0].amount === 1000, JSON.stringify({ rq: rq.settlement_status, fees: e.sim.feeRefunds.length }));
  }
} finally {
  clearTimeout(watchdog);
  spy.restore();
  // The suite's rows carry simulated Stripe ids; left behind, the real refund worker on demohub-rebuild-check would retry
  // them forever (found by the 2026-10-30 live rehearsal), so the fixtures go with the run.
  try { console.log('\n:: teardown ::'); const counts = await teardownRetailerFixtures({ sbUrl: SB, sbKey: KEY, retailerIds: [retailerId], brandIds: [brandId], log: (m) => console.log(m) }); console.log('  teardown:', JSON.stringify(counts)); }
  catch (e) { console.log('  teardown failed (rows left on demohub-rebuild-check):', String((e && e.message) || e)); }
}
process.exit(summary('connected settlement (routes + worker, demohub-rebuild-check)') ? 0 : 1);
