// tests/refund_cutoff_route.test.mjs, the 72-hour refund rule THROUGH the real cancel route (David, 2026-10-18;
// revised after Codex's review the same day: category, request time, durable decision, review item, and
// allocation-backed refunds).
//
// tests/refund_cutoff.test.mjs pins the pure decision offline. This file proves api/booking-action.js honours it
// against the test database (demohub-rebuild-check): a real retailer session, real bookings, a REAL payment
// group with four allocations built through /api/book, /api/checkout and a signed paid webhook event (the same
// path tests/route_flows.test.mjs uses), Stripe and Resend spied. Two kinds of evidence:
//
//   allocation-backed (positive): the refund actually reserves and submits against THIS booking's allocation and
//   the siblings stay untouched; a transition failure after the refund step is resumed from the RECORDED decision
//   even after the store changes its policy; a provider failure leaves a retryable ledger request, never a lost
//   eligibility.
//   no-allocation (negative): paid rows seeded WITHOUT an allocation, so when the decision says "refund" the
//   ledger answers no_allocation (refund_failed, zero Stripe calls): "the refund step was reached" versus not.
//
// Cases: brand_requested inside the window (pending_manual, no Stripe, still paid, definite email); store_caused
// inside the window (full refund of that allocation, siblings untouched); request received 73 h out but processed
// later; transition failure then retry under a changed policy (saved decision wins, one decision row, one refund);
// provider failure (refund_failed, retryable request, decision recorded); non_refundable; Refund anyway with a
// recorded reason; unpaid; fee-waived; legacy mode; missing / unknown category refused; backdated request without
// a note refused; override without a reason refused; unresolvable start = under_review with a durable case;
// /api/admin PATCH writes mode and sentence together and refuses contradictions.
import { createHmac } from 'node:crypto';
import { installSpy, callRoute, req, rawReq, ok, summary, uniq, ENV, FIXTURE_PRODUCTS } from './_route.mjs';
import { HOURLY } from './_fixture_availability.mjs';
import { REFUNDABLE_CANCELLATION_POLICY, NON_REFUNDABLE_CANCELLATION_POLICY } from '../api/_refund-cutoff.js';

const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  return { ok: r.ok, status: r.status, body: j };
};
const one = (r) => (r && Array.isArray(r.body) ? r.body[0] : null);
const bin = []; const track = (t, id) => { if (id) bin.push([t, id]); return id; };
const LA = 'America/Los_Angeles';
const spy = installSpy();
const watchdog = setTimeout(() => { console.log('  FAIL watchdog: suite exceeded 6 minutes'); process.exit(1); }, 6 * 60 * 1000);
const sign = (payload, secret = 'whsec_harness') => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`; };
const idList = (arr) => arr.map(encodeURIComponent).join(',');
const hoursAgo = (h) => new Date(Date.now() - h * 36e5).toISOString();

// A calendar date N days from now in the store's zone (the demo_date column is a local date).
function dayP(n) {
  const d = new Date(Date.now() + n * 864e5);
  const p = {}; for (const x of new Intl.DateTimeFormat('en-US', { timeZone: LA, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}

console.log('\nFixtures');
const slug = uniq('rc');
const retailerId = track('retailers', one(await db('retailers', { method: 'POST', body: JSON.stringify({
  slug, name: 'Refund Cutoff Market', billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active',
  platform_keeps_all: true, timezone: LA, auto_confirm_bookings: true, cancellation_mode: 'refundable', verification_status: 'approved' }) })).id);
track('settings', one(await db('settings', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, demo_fee: 30, advance_booking_days: 0 }) })).id);
const venueId = track('venues', one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, name: 'Cutoff Main', address: '72 Hour St', demo_fee: 30, availability: HOURLY }) })).id);
const staffEmail = `staff-${slug}@fixture.test`;
track('retailer_admins', one(await db('retailer_admins', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, email: staffEmail, email_normalized: staffEmail, name: 'Cutoff Staff', role: 'admin' }) })).id);
const tok = one(await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: staffEmail, retailer_id: retailerId }) }));
const cookie = (await callRoute('admin-auth.js', req({ body: { action: 'verify', token: tok.token } }))).cookie('dh_retailer_session');
const brandEmail = `${uniq('brand')}@fixture.test`;
const brandId = track('brands', one(await db('brands', { method: 'POST', body: JSON.stringify({ email: brandEmail, company_name: 'Cutoff Brand', contact_name: 'Cutoff Contact', phone: '555-0172', is_verified: true,
  default_coi_url: 'brands/cutoff.pdf', default_coi_expires: dayP(400), coi_verification_status: 'approved' }) })).id);
const brandTok = one(await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: brandId, email: brandEmail, token: 'tk-' + uniq('c'), expires_at: new Date(Date.now() + 36e5).toISOString() }) }));
const brandCookie = (await callRoute('brand-account.js', req({ body: { action: 'verify', token: brandTok.token } }))).cookie('dh_brand_session');
ok('fixtures: retailer, venue, staff session, brand session exist', !!retailerId && !!venueId && !!cookie && !!brandId && !!brandCookie);

let seedN = 0;
async function seed({ days, status = 'confirmed', payment_status = 'paid', pi = true, fee_waived = false, time = null }) {
  const t = time || `${9 + (seedN++ % 10)}:00`;
  const r = await db('bookings', { method: 'POST', body: JSON.stringify({
    retailer_id: retailerId, venue_id: venueId, brand_id: brandId, brand_name: 'Cutoff Brand', contact_name: 'Cutoff Contact', contact_email: brandEmail,
    product: 'Samples', demo_date: dayP(days), demo_time: t, status, payment_status,
    payment_intent_id: pi ? 'pi_' + uniq('rc') : null, fee_waived }) });
  const b = one(r);
  if (!b || !b.id) throw new Error('seed failed: ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 200));
  track('bookings', b.id);
  return b;
}
const setMode = async (mode) => { const r = await db(`retailers?id=eq.${retailerId}`, { method: 'PATCH', body: JSON.stringify({ cancellation_mode: mode }) }); if (r.status >= 400) throw new Error('setMode ' + r.status); };
const cancel = (booking_id, extra = {}) => callRoute('booking-action.js', req({ body: { action: 'cancel', category: 'brand_requested', booking_id, ...extra }, cookies: { dh_retailer_session: cookie } }));
const row = async (id) => one(await db(`bookings?id=eq.${id}&select=status,payment_status,cancelled_at`));
const decisionRows = async (id) => (await db(`booking_cancellations?booking_id=eq.${id}&select=*`)).body || [];
const stripeRefundCalls = () => spy.calls.stripe.filter(c => /\/refunds/.test(c.url)).length;
const stripeCalls = () => spy.calls.stripe.length;
const lastBrandMail = () => [...spy.calls.resend].reverse().find(m => /was cancelled/.test(String(m.subject || '')));
const text = (m) => (m ? String(m.html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') : 'no mail');
let groupId = null;

try {
  console.log('\nRefusals before anything moves');
  {
    const b = await seed({ days: 20 });
    const s0 = stripeCalls();
    const noCat = await callRoute('booking-action.js', req({ body: { action: 'cancel', booking_id: b.id }, cookies: { dh_retailer_session: cookie } }));
    ok('a cancel without a category is refused 400 cancellation_category_required (never read as the brand\'s fault)', noCat.statusCode === 400 && noCat.body.error === 'cancellation_category_required', `${noCat.statusCode} ${JSON.stringify(noCat.body).slice(0, 160)}`);
    const badCat = await cancel(b.id, { category: 'other' });
    ok('an unknown category is refused', badCat.statusCode === 400 && badCat.body.error === 'cancellation_category_required', `${badCat.statusCode}`);
    const future = await cancel(b.id, { requested_at: new Date(Date.now() + 36e5).toISOString() });
    ok('a request time in the future is refused (requested_at_in_future)', future.statusCode === 400 && future.body.error === 'requested_at_in_future', `${future.statusCode} ${JSON.stringify(future.body).slice(0, 120)}`);
    const old = await cancel(b.id, { requested_at: hoursAgo(30) });
    ok('a request time more than a day ago without a note is refused (backdate_note_required)', old.statusCode === 400 && old.body.error === 'backdate_note_required', `${old.statusCode}`);
    const junk = await cancel(b.id, { requested_at: 'last tuesday' });
    ok('a junk request time is refused (invalid_requested_at)', junk.statusCode === 400 && junk.body.error === 'invalid_requested_at', `${junk.statusCode}`);
    const noWhy = await cancel(b.id, { force_refund: true });
    ok('Refund anyway without a reason is refused (override_reason_required)', noWhy.statusCode === 400 && noWhy.body.error === 'override_reason_required', `${noWhy.statusCode}`);
    const after = await row(b.id);
    ok('every refusal left the booking confirmed and paid, made no Stripe call and recorded no decision', after.status === 'confirmed' && after.payment_status === 'paid' && stripeCalls() === s0 && (await decisionRows(b.id)).length === 0, JSON.stringify(after));
  }

  console.log('\nA real payment group: four bookings, one checkout, one signed paid event');
  const bookingIds = [];
  {
    for (let i = 0; i < 4; i++) {
      const bk = await callRoute('book.js', req({ body: { retailer_slug: slug, venue_id: venueId, demo_date: dayP(1 + i), demo_time: '13:00', product_skus: FIXTURE_PRODUCTS }, cookies: { dh_brand_session: brandCookie } }));
      const id = bk.body && (bk.body.booking_id || bk.body.id || (bk.body.booking && bk.body.booking.id));
      if (id) { track('bookings', id); bookingIds.push(id); } else console.log('  book.js ' + bk.statusCode + ' ' + JSON.stringify(bk.body).slice(0, 200));
    }
    ok('four bookings (tomorrow, +2, +3, +4 days at 13:00) were created through /api/book', bookingIds.length === 4, `${bookingIds.length}`);
    const co = await callRoute('checkout.js', req({ body: { booking_ids: bookingIds }, cookies: { dh_brand_session: brandCookie } }));
    const sessionId = co.body && co.body.session_id; groupId = co.body && co.body.payment_group_id; const total = co.body && co.body.total_cents;
    ok('/api/checkout claimed ONE group with a session and a total', co.statusCode === 200 && !!sessionId && !!groupId && Number.isFinite(total), `${co.statusCode} ${JSON.stringify(co.body).slice(0, 200)}`);
    const piId = 'pi_' + uniq('paid'), chargeId = 'ch_' + uniq('paid');
    spy.fixtures.paymentIntents[piId] = { id: piId, object: 'payment_intent', amount_received: total, currency: 'usd', on_behalf_of: null,
      latest_charge: { id: chargeId, object: 'charge', destination: null, application_fee_amount: null, transfer: null, application_fee: null } };
    const paidEvent = JSON.stringify({ id: 'evt_' + uniq('paid'), type: 'checkout.session.completed',
      data: { object: { id: sessionId, object: 'checkout.session', mode: 'payment', payment_status: 'paid', amount_total: total, currency: 'usd', payment_intent: piId, metadata: { payment_group_id: groupId } } } });
    const paid1 = await callRoute('stripe-webhook.js', rawReq(paidEvent, { signature: sign(paidEvent) }));
    const rows = (await db(`bookings?id=in.(${idList(bookingIds)})&select=id,payment_status,status`)).body || [];
    ok('the signed paid event paid and confirmed all four (auto-confirm store)', paid1.statusCode < 300 && rows.length === 4 && rows.every(b => b.payment_status === 'paid' && b.status === 'confirmed'), `${paid1.statusCode} ${JSON.stringify(rows)}`);
    const allocs = (await db(`payment_allocations?payment_group_id=eq.${groupId}&select=booking_id,customer_amount,refunded_amount`)).body || [];
    ok('four allocations exist, none refunded', allocs.length === 4 && allocs.every(a => Number(a.refunded_amount || 0) === 0), JSON.stringify(allocs));
    const demos = (await db(`demos?booking_id=in.(${idList(bookingIds)})&select=id`)).body || [];
    for (const d of demos) track('demos', d.id);
  }
  const [A, B, C, D] = bookingIds;
  const allocOf = async (id) => one(await db(`payment_allocations?booking_id=eq.${id}&select=customer_amount,refunded_amount,reserved_refund_amount`));

  console.log('\nbrand_requested inside the window (B, +2 days): no automatic refund, definite email');
  {
    const s0 = stripeCalls(); const m0 = spy.calls.resend.length;
    const r = await cancel(B);
    ok('200, pending_manual, inside_cutoff, category echoed, requested_at defaulted to now, not replayed',
      r.statusCode === 200 && r.body.refund_status === 'pending_manual' && r.body.refund_reason === 'inside_cutoff' && r.body.cancellation_category === 'brand_requested' && !!r.body.requested_at && r.body.decision_replayed === false, `${r.statusCode} ${JSON.stringify(r.body).slice(0, 260)}`);
    ok('fewer than 72 hours before the demo', typeof r.body.hours_before_demo === 'number' && r.body.hours_before_demo < 72 && r.body.hours_before_demo > 0, String(r.body.hours_before_demo));
    ok('ZERO Stripe calls', stripeCalls() === s0, `${s0} -> ${stripeCalls()}`);
    const after = await row(B); const al = await allocOf(B);
    ok('the booking is cancelled, still paid; its allocation untouched', after.status === 'cancelled' && after.payment_status === 'paid' && Number(al.refunded_amount) === 0 && Number(al.reserved_refund_amount || 0) === 0, JSON.stringify({ after, al }));
    const d = await decisionRows(B);
    ok('ONE durable decision row: brand_requested, refundable, refund false, pending_manual, inside_cutoff, actor recorded, start from the snapshot',
      d.length === 1 && d[0].category === 'brand_requested' && d[0].cancellation_mode === 'refundable' && d[0].refund === false && d[0].status === 'pending_manual' && d[0].reason === 'inside_cutoff' && d[0].actor === staffEmail && d[0].start_source === 'snapshot' && !!d[0].start_at && Number(d[0].cutoff_hours) === 72, JSON.stringify(d));
    const mail = lastBrandMail();
    ok('the brand\'s email says "As you asked", states the definite outcome, and promises no follow-up', spy.calls.resend.length > m0 && /As you asked/.test(text(mail)) && /inside the 72-hour window/.test(text(mail)) && /the demo fee is not refunded\./.test(text(mail)) && !/follow up/.test(text(mail)) && !/refund request was submitted/i.test(text(mail)), text(mail).slice(0, 400));
    const again = await cancel(B);
    ok('cancelling it again is refused (already cancelled), no second decision row', again.statusCode === 409 && (await decisionRows(B)).length === 1, `${again.statusCode}`);
  }

  console.log('\nstore_caused inside the window (A, tomorrow): full refund of that allocation only');
  {
    const r0 = stripeRefundCalls(); const m0 = spy.calls.resend.length;
    const r = await cancel(A, { category: 'store_caused' });
    ok('200, refund submitted, reason store_caused, category echoed', r.statusCode === 200 && r.body.refund_status === 'submitted' && r.body.refund_reason === 'store_caused' && r.body.cancellation_category === 'store_caused' && r.body.demo_cancelled === true, `${r.statusCode} ${JSON.stringify(r.body).slice(0, 260)}`);
    ok('exactly ONE Stripe refund call', stripeRefundCalls() === r0 + 1, `${r0} -> ${stripeRefundCalls()}`);
    const alA = await allocOf(A); const others = (await db(`payment_allocations?payment_group_id=eq.${groupId}&booking_id=neq.${A}&select=booking_id,refunded_amount`)).body || [];
    ok('only A\'s allocation is refunded in full; the three siblings stay at zero', Number(alA.refunded_amount) === Number(alA.customer_amount) && others.length === 3 && others.every(a => Number(a.refunded_amount || 0) === 0), JSON.stringify({ alA, others }));
    const after = await row(A);
    ok('A is cancelled and its payment reads refunded', after.status === 'cancelled' && after.payment_status === 'refunded', JSON.stringify(after));
    const d = await decisionRows(A);
    ok('the decision row says store_caused, refund true, auto, with the hours (inside 72) recorded for the record', d.length === 1 && d[0].category === 'store_caused' && d[0].refund === true && d[0].status === 'auto' && d[0].reason === 'store_caused' && Number(d[0].hours_before_demo) < 72, JSON.stringify(d));
    const mail = lastBrandMail();
    ok('the brand\'s email says the store had to cancel and the refund was submitted', spy.calls.resend.length > m0 && /had to cancel/.test(text(mail)) && /refund request was submitted/i.test(text(mail)), text(mail).slice(0, 300));
  }

  console.log('\nRequest received 73+ hours out, transition fails after the refund, retried under a changed policy (C, +3 days)');
  {
    // C starts about 72 hours from now (13:00 in three days); the brand asked three hours ago, so the decision is
    // measured from then: outside the cutoff even though "now" may be just inside it.
    const requestedAt = hoursAgo(3);
    spy.faults.push({ url: '/rpc/booking_transition', method: 'POST', status: 500, message: 'injected_transition_failure' });
    const r0 = stripeRefundCalls();
    const f1 = await cancel(C, { requested_at: requestedAt });
    ok('first attempt: refund submitted (outside_cutoff, measured from the request), then the transition failed: 500 transition_failed with a reconciliation case', f1.statusCode === 500 && f1.body.error === 'transition_failed' && f1.body.refund_status === 'submitted' && !!f1.body.reconciliation_case_id, `${f1.statusCode} ${JSON.stringify(f1.body).slice(0, 260)}`);
    track('reconciliation_cases', f1.body.reconciliation_case_id);
    spy.faults.length = 0;
    const d1 = await decisionRows(C);
    ok('the decision was recorded BEFORE the refund: one row, refund true, outside_cutoff, requested_at as sent, hours from the request >= 72', d1.length === 1 && d1[0].refund === true && d1[0].reason === 'outside_cutoff' && Math.abs(new Date(d1[0].requested_at).getTime() - new Date(requestedAt).getTime()) < 1000 && Number(d1[0].hours_before_demo) >= 72, JSON.stringify(d1));
    const mid = await row(C);
    ok('nothing half-applied: the booking is still confirmed (the transition failed)', mid.status === 'confirmed', JSON.stringify(mid));
    // The store changes its policy to non-refundable between the attempts; the saved decision must still win.
    await setMode('non_refundable');
    const f2 = await cancel(C, { requested_at: requestedAt });
    ok('retry under non_refundable: 200, decision_replayed true, the booking cancels (refund already made: not_paid / refunded)', f2.statusCode === 200 && f2.body.decision_replayed === true && f2.body.demo_cancelled === true && f2.body.refund_reason === 'outside_cutoff', `${f2.statusCode} ${JSON.stringify(f2.body).slice(0, 260)}`);
    const d2 = await decisionRows(C);
    ok('still ONE decision row, unchanged (mode refundable, outside_cutoff): the policy change did not rewrite it', d2.length === 1 && d2[0].cancellation_mode === 'refundable' && d2[0].reason === 'outside_cutoff' && d2[0].decided_at === d1[0].decided_at, JSON.stringify(d2));
    ok('exactly ONE Stripe refund call across both attempts', stripeRefundCalls() === r0 + 1, `${r0} -> ${stripeRefundCalls()}`);
    const after = await row(C); const al = await allocOf(C);
    ok('C is cancelled and refunded; its allocation refunded in full once', after.status === 'cancelled' && after.payment_status === 'refunded' && Number(al.refunded_amount) === Number(al.customer_amount), JSON.stringify({ after, al }));
    const f3 = await cancel(C, { requested_at: requestedAt });
    ok('a further replay is refused (already cancelled), no second refund, no second decision', f3.statusCode === 409 && stripeRefundCalls() === r0 + 1 && (await decisionRows(C)).length === 1, `${f3.statusCode}`);
    await setMode('refundable');
  }

  console.log('\nProvider failure on an eligible refund (D, +4 days): the eligibility is kept in the ledger, not lost');
  {
    spy.faults.push({ url: '/refunds', method: 'POST', status: 500, message: 'injected_stripe_timeout', once: true });
    const r = await cancel(D);
    ok('200, refund_failed, outside_cutoff: the cancellation applied, the refund did not reach Stripe', r.statusCode === 200 && r.body.refund_status === 'refund_failed' && r.body.refund_reason === 'outside_cutoff' && r.body.demo_cancelled === true, `${r.statusCode} ${JSON.stringify(r.body).slice(0, 220)}`);
    const after = await row(D);
    ok('D is cancelled with payment_status refund_pending (durable, retryable)', after.status === 'cancelled' && after.payment_status === 'refund_pending', JSON.stringify(after));
    const reqs = (await db(`refund_requests?booking_id=eq.${D}&select=status,attempt_version`)).body || [];
    ok('ONE refund request is parked failed_retryable with the reservation kept (the worker retries with the same key)', reqs.length === 1 && reqs[0].status === 'failed_retryable', JSON.stringify(reqs));
    const d = await decisionRows(D);
    ok('the decision row says refund true (eligible), so no later attempt re-judges the clock', d.length === 1 && d[0].refund === true && d[0].reason === 'outside_cutoff', JSON.stringify(d));
    const mail = lastBrandMail();
    ok('the brand\'s email says the refund is in progress (tracked), not that it was denied', /refund is in progress/.test(text(mail)) && !/not refunded/.test(text(mail)), text(mail).slice(0, 300));
    const r0 = stripeRefundCalls();
    const wk = await callRoute('refund-worker.js', req({ method: 'GET', headers: { authorization: 'Bearer ' + ENV.CRON_SECRET } }));
    const afterWk = await row(D); const reqsWk = (await db(`refund_requests?booking_id=eq.${D}&select=status`)).body || [];
    ok('the refund worker runs (200) and either completes the parked refund or leaves it scheduled for its backoff; it never drops it', wk.statusCode === 200 && (afterWk.payment_status === 'refunded' || reqsWk.some(q => ['failed_retryable', 'submitted', 'succeeded'].includes(q.status))), `${wk.statusCode} ${JSON.stringify({ afterWk, reqsWk, refundsAfter: stripeRefundCalls() - r0 })}`);
    console.log('  note worker outcome: ' + JSON.stringify({ body: wk.body, payment_status: afterWk.payment_status, requests: reqsWk }).slice(0, 300));
  }

  console.log('\nNo-allocation negatives: the refund step is reached or not');
  {
    const b = await seed({ days: 10 });
    const s0 = stripeCalls();
    const r = await cancel(b.id);
    ok('paid, 10 days out, no allocation: outside_cutoff and the refund step ran (refund_failed from no_allocation, zero Stripe)', r.statusCode === 200 && r.body.refund_reason === 'outside_cutoff' && r.body.refund_status === 'refund_failed' && stripeCalls() === s0, `${r.statusCode} ${JSON.stringify(r.body).slice(0, 200)}`);
    await setMode('non_refundable');
    const n1 = await seed({ days: 12 });
    const rn = await cancel(n1.id);
    ok('non_refundable, 12 days out: pending_manual, reason non_refundable, zero Stripe, still paid', rn.statusCode === 200 && rn.body.refund_status === 'pending_manual' && rn.body.refund_reason === 'non_refundable' && stripeCalls() === s0 && (await row(n1.id)).payment_status === 'paid', `${rn.statusCode} ${JSON.stringify(rn.body).slice(0, 200)}`);
    ok('the brand\'s email states the non-refundable policy as a definite outcome', /non-refundable, so the demo fee is not refunded\./.test(text(lastBrandMail())) && !/follow up/.test(text(lastBrandMail())), text(lastBrandMail()).slice(0, 300));
    const n2 = await seed({ days: 13 });
    const rf = await cancel(n2.id, { force_refund: true, override_reason: 'goodwill, first-time brand' });
    ok('non_refundable + Refund anyway with a reason: forced, the refund step ran', rf.statusCode === 200 && rf.body.refund_reason === 'forced' && rf.body.refund_status === 'refund_failed', `${rf.statusCode} ${JSON.stringify(rf.body).slice(0, 200)}`);
    const dn2 = await decisionRows(n2.id);
    ok('the override is recorded with its reason and actor', dn2.length === 1 && dn2[0].force_refund === true && dn2[0].override_reason === 'goodwill, first-time brand' && dn2[0].actor === staffEmail, JSON.stringify(dn2));
    const n3 = await seed({ days: 14 });
    const sc = await cancel(n3.id, { category: 'store_caused' });
    ok('store_caused under non_refundable: reason store_caused, the refund step ran', sc.statusCode === 200 && sc.body.refund_reason === 'store_caused' && sc.body.refund_status === 'refund_failed', `${sc.statusCode} ${JSON.stringify(sc.body).slice(0, 200)}`);
    await setMode('refundable');
    const f1 = await seed({ days: 1 });
    const rf1 = await cancel(f1.id, { force_refund: true, override_reason: 'goodwill' });
    ok('refundable, tomorrow, Refund anyway: forced, the refund step ran', rf1.statusCode === 200 && rf1.body.refund_reason === 'forced' && rf1.body.refund_status === 'refund_failed' && rf1.body.hours_before_demo < 72, `${rf1.statusCode} ${JSON.stringify(rf1.body).slice(0, 200)}`);
    const f2 = await seed({ days: 1 });
    const rf2 = await cancel(f2.id, { force_refund: 'yes', override_reason: 'x' });
    ok('force_refund must be the boolean true: a truthy string does not force (inside_cutoff, pending_manual)', rf2.statusCode === 200 && rf2.body.refund_reason === 'inside_cutoff' && rf2.body.refund_status === 'pending_manual', `${rf2.statusCode} ${JSON.stringify(rf2.body).slice(0, 200)}`);
    const bd = await seed({ days: 2 });
    const rbd = await cancel(bd.id, { requested_at: hoursAgo(30), backdate_note: 'email from the brand on Monday 9am' });
    const dbd = await decisionRows(bd.id);
    ok('a backdated request with a note is accepted and the note is recorded', rbd.statusCode === 200 && dbd.length === 1 && dbd[0].backdate_note === 'email from the brand on Monday 9am' && Math.abs(new Date(dbd[0].requested_at).getTime() - (Date.now() - 30 * 36e5)) < 60e3, `${rbd.statusCode} ${JSON.stringify(dbd).slice(0, 300)}`);
    const u = await seed({ days: 14, status: 'pending', payment_status: 'unpaid', pi: false });
    const ru = await cancel(u.id);
    ok('unpaid pending booking: cancelled, not_paid, zero Stripe, decision recorded as not_paid', ru.statusCode === 200 && ru.body.refund_status === 'not_paid' && ru.body.refund_reason === 'not_paid' && stripeCalls() === s0 && (await row(u.id)).status === 'cancelled' && (await decisionRows(u.id))[0].status === 'not_paid', `${ru.statusCode} ${JSON.stringify(ru.body).slice(0, 200)}`);
    const w = await seed({ days: 15, payment_status: 'waived', pi: false, fee_waived: true });
    const rw = await cancel(w.id, { category: 'store_caused' });
    ok('fee-waived (booking code) booking, even store_caused: not_paid, zero Stripe, cancelled', rw.statusCode === 200 && rw.body.refund_status === 'not_paid' && stripeCalls() === s0 && (await row(w.id)).status === 'cancelled', `${rw.statusCode} ${JSON.stringify(rw.body).slice(0, 200)}`);
    const w2 = await seed({ days: 16, fee_waived: true });
    const rw2 = await cancel(w2.id, { force_refund: true, override_reason: 'try' });
    ok('a fee-waived row that reads as paid (defensive): reason fee_waived, not_paid, zero Stripe', rw2.statusCode === 200 && rw2.body.refund_status === 'not_paid' && rw2.body.refund_reason === 'fee_waived' && stripeCalls() === s0, `${rw2.statusCode} ${JSON.stringify(rw2.body).slice(0, 200)}`);
    await setMode('14_day_refund');   // direct write: the admin route refuses this value now, but existing rows carry it
    const lg = await seed({ days: 5 });
    const rl = await cancel(lg.id);
    ok('legacy 14_day_refund stored, 5 days out: outside_cutoff and the refund step ran (the old rule would have parked it)', rl.statusCode === 200 && rl.body.refund_reason === 'outside_cutoff' && rl.body.refund_status === 'refund_failed' && (await decisionRows(lg.id))[0].cancellation_mode === 'refundable', `${rl.statusCode} ${JSON.stringify(rl.body).slice(0, 200)}`);
    await setMode('refundable');
  }

  console.log('\nUnresolvable start: under review with a durable case, never an invented deadline');
  {
    const b = await seed({ days: 8 });
    const broke = await db(`bookings?id=eq.${b.id}`, { method: 'PATCH', body: JSON.stringify({ start_at: null, timezone: 'Not/AZone' }) });
    const chk = one(await db(`bookings?id=eq.${b.id}&select=start_at,timezone`));
    const broken = broke.status < 300 && chk && chk.start_at == null && chk.timezone === 'Not/AZone';
    console.log('  note fixture corruption (start_at null, timezone Not/AZone) applied: ' + broken + ' ' + JSON.stringify(chk));
    if (broken) {
      const s0 = stripeCalls(); const m0 = spy.calls.resend.length;
      const r = await cancel(b.id);
      ok('200, under_review, start_unresolvable, a durable review case recorded, zero Stripe', r.statusCode === 200 && r.body.refund_status === 'under_review' && r.body.refund_reason === 'start_unresolvable' && r.body.refund_review_recorded === true && !!r.body.refund_review_case_id && stripeCalls() === s0, `${r.statusCode} ${JSON.stringify(r.body).slice(0, 260)}`);
      track('reconciliation_cases', r.body.refund_review_case_id);
      const c = one(await db(`reconciliation_cases?id=eq.${r.body.refund_review_case_id}&select=kind,reason,dedupe_key,details`));
      ok('the case is refund_requires_review / refund_eligibility_unresolved, deduplicated per booking, with the scheduling fields', c && c.kind === 'refund_requires_review' && c.reason === 'refund_eligibility_unresolved' && c.dedupe_key === 'refund-eligibility:' + b.id && c.details && c.details.booking_id === b.id, JSON.stringify(c));
      const d = await decisionRows(b.id);
      ok('the decision row is under_review with start_source unresolved', d.length === 1 && d[0].status === 'under_review' && d[0].start_source === 'unresolved' && d[0].start_at == null, JSON.stringify(d));
      ok('the booking is cancelled and still paid (no automatic denial, no automatic refund)', (await row(b.id)).status === 'cancelled' && (await row(b.id)).payment_status === 'paid');
      const mail = lastBrandMail();
      ok('the brand\'s email says the eligibility is being reviewed and that they will hear by email', spy.calls.resend.length > m0 && /being reviewed by Demohub/.test(text(mail)) && /hear from us by email/.test(text(mail)) && !/not refunded/.test(text(mail)), text(mail).slice(0, 300));
    } else {
      ok('fixture could not be corrupted through PostgREST (the 0074 trigger keeps the snapshot); the unresolved path is pinned offline in tests/refund_cutoff.test.mjs instead', true);
    }
  }

  console.log('\n/api/admin PATCH: mode and sentence are one write');
  {
    const admin = async (body) => { const r = await callRoute('admin.js', req({ method: 'PATCH', query: { table: 'retailers', id: retailerId }, body, cookies: { dh_retailer_session: cookie } })); if (typeof r.body === 'string') { try { r.body = JSON.parse(r.body); } catch (_) {} } return r; };
    const read = async () => one(await db(`retailers?id=eq.${retailerId}&select=cancellation_mode,cancellation_policy`));
    const junk = await admin({ cancellation_mode: 'free_for_all' });
    ok('an unknown cancellation_mode is refused 400 invalid_cancellation_mode', junk.statusCode === 400 && junk.body && junk.body.error === 'invalid_cancellation_mode', `${junk.statusCode} ${JSON.stringify(junk.body).slice(0, 160)}`);
    const legacy = await admin({ cancellation_mode: '14_day_refund' });
    ok('the legacy 14_day_refund is refused on write', legacy.statusCode === 400 && legacy.body.error === 'invalid_cancellation_mode', `${legacy.statusCode}`);
    const nrOnly = await admin({ cancellation_mode: 'non_refundable' });
    const g1 = await read();
    ok('a mode-only PATCH to non_refundable writes the non-refundable sentence with it', nrOnly.statusCode === 200 && g1.cancellation_mode === 'non_refundable' && g1.cancellation_policy === NON_REFUNDABLE_CANCELLATION_POLICY, `${nrOnly.statusCode} ${JSON.stringify(g1).slice(0, 200)}`);
    const mismatch = await admin({ cancellation_mode: 'refundable', cancellation_policy: NON_REFUNDABLE_CANCELLATION_POLICY });
    ok('a sentence that contradicts the mode is refused 400 policy_text_mismatch (and names the expected sentence)', mismatch.statusCode === 400 && mismatch.body.error === 'policy_text_mismatch' && mismatch.body.expected === REFUNDABLE_CANCELLATION_POLICY, `${mismatch.statusCode} ${JSON.stringify(mismatch.body).slice(0, 160)}`);
    const custom = await admin({ cancellation_mode: 'refundable', cancellation_policy: 'Our own wording about refunds.' });
    ok('a custom sentence is refused (prose is never interpreted)', custom.statusCode === 400 && custom.body.error === 'policy_text_mismatch', `${custom.statusCode}`);
    const textOnly = await admin({ cancellation_policy: REFUNDABLE_CANCELLATION_POLICY });
    ok('a sentence without its mode is refused 400 policy_text_requires_mode', textOnly.statusCode === 400 && textOnly.body.error === 'policy_text_requires_mode', `${textOnly.statusCode}`);
    const g2 = await read();
    ok('the refusals changed nothing (still non_refundable with its sentence)', g2.cancellation_mode === 'non_refundable' && g2.cancellation_policy === NON_REFUNDABLE_CANCELLATION_POLICY, JSON.stringify(g2).slice(0, 200));
    const back = await admin({ cancellation_mode: 'refundable', cancellation_policy: REFUNDABLE_CANCELLATION_POLICY });
    const g3 = await read();
    ok('mode plus its matching sentence saves; the store is back on the 72-hour rule', back.statusCode === 200 && g3.cancellation_mode === 'refundable' && g3.cancellation_policy === REFUNDABLE_CANCELLATION_POLICY, `${back.statusCode} ${JSON.stringify(g3).slice(0, 200)}`);
    // the sentence brands see follows the mode even when the stored text is empty (api/booking.js fallback by mode)
    await db(`retailers?id=eq.${retailerId}`, { method: 'PATCH', body: JSON.stringify({ cancellation_mode: 'non_refundable', cancellation_policy: null }) });
    const chk = await callRoute('booking.js', req({ body: { action: 'agreement-check', retailer_slug: slug }, cookies: { dh_brand_session: brandCookie } }));
    ok('agreement-check for a non_refundable store with EMPTY text shows the non-refundable sentence, not the refundable default', chk.statusCode === 200 && chk.body && chk.body.policies && chk.body.policies.cancellation_policy === NON_REFUNDABLE_CANCELLATION_POLICY, `${chk.statusCode} ${JSON.stringify(chk.body).slice(0, 240)}`);
    await db(`retailers?id=eq.${retailerId}`, { method: 'PATCH', body: JSON.stringify({ cancellation_mode: 'refundable', cancellation_policy: null }) });
    const chk2 = await callRoute('booking.js', req({ body: { action: 'agreement-check', retailer_slug: slug }, cookies: { dh_brand_session: brandCookie } }));
    ok('and a refundable store with empty text shows the 72-hour sentence', chk2.statusCode === 200 && chk2.body.policies.cancellation_policy === REFUNDABLE_CANCELLATION_POLICY, `${chk2.statusCode} ${JSON.stringify(chk2.body).slice(0, 200)}`);
  }
} catch (e) {
  ok('suite ran without an unexpected exception', false, String((e && e.stack) || e).slice(0, 800));
} finally {
  const del = async (p) => { const d = await db(p, { method: 'DELETE' }); if (d.status >= 400) console.log(`  teardown: DELETE ${p} -> ${d.status} ${JSON.stringify(d.body).slice(0, 160)}`); };
  const fxBookings = bin.filter(([t]) => t === 'bookings').map(([, id]) => id);
  for (const [t, id] of bin) if (t === 'reconciliation_cases') await del(`reconciliation_cases?id=eq.${id}`);
  if (groupId) {
    const allocs = (await db(`payment_allocations?payment_group_id=eq.${groupId}&select=id`)).body || [];
    for (const a of allocs) {
      const reqs = (await db(`refund_requests?payment_allocation_id=eq.${a.id}&select=id`)).body || [];
      for (const rq of reqs) { await del(`reconciliation_cases?refund_request_id=eq.${rq.id}`); await del(`refund_review_actions?refund_request_id=eq.${rq.id}`); }
      const ops = (await db(`refund_operations?payment_allocation_id=eq.${a.id}&select=id`)).body || [];
      for (const op of ops) await del(`refund_review_actions?refund_operation_id=eq.${op.id}`);
      await del(`refund_requests?payment_allocation_id=eq.${a.id}`);
      await del(`refund_operations?payment_allocation_id=eq.${a.id}`);
    }
    await del(`booking_fulfillments?payment_group_id=eq.${groupId}`);
    await del(`reconciliation_cases?payment_group_id=eq.${groupId}`);
    await del(`payment_attempts?payment_group_id=eq.${groupId}`);
    await del(`payment_allocations?payment_group_id=eq.${groupId}`);
    await del(`payment_groups?id=eq.${groupId}`);
  }
  if (fxBookings.length) {
    await del(`reconciliation_cases?dedupe_key=in.(${fxBookings.map(id => '"transition:' + id + '"').join(',')})`);
    await del(`reconciliation_cases?dedupe_key=in.(${fxBookings.map(id => '"refund-eligibility:' + id + '"').join(',')})`);
    for (const t of ['refund_operations', 'refund_requests', 'booking_fulfillments', 'booking_cancellations']) await del(`${t}?booking_id=in.(${fxBookings.join(',')})`);
  }
  await del(`brand_retailer_agreements?retailer_id=eq.${retailerId}`);
  await del(`notification_deliveries?retailer_id=eq.${retailerId}`);
  await del(`notification_events?retailer_id=eq.${retailerId}`);
  await del(`demos?retailer_id=eq.${retailerId}`);
  for (const [t, id] of bin.reverse()) if (t !== 'reconciliation_cases') await del(`${t}?id=eq.${id}`);
  clearTimeout(watchdog);
  spy.restore();
}
process.exit(summary('refund cutoff route') ? 0 : 1);
