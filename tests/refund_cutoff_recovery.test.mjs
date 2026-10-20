// tests/refund_cutoff_recovery.test.mjs (2026-10-19, Codex refund-cutoff revision 3 review, R3-1 to R3-4).
// Against the test database (demohub-rebuild-check): real routes, real RPCs (0106 + 0107), Stripe and Resend spied.
//
//   R3-1  The operator decision is CLAIMED before any provider effect (booking_cancellation_claim). Interleavings
//         forced with the claim itself as the barrier: a denial claimed first makes a later grant return the stored
//         denial with ZERO provider calls; a grant claimed first (crash right after the claim) makes a later denial
//         return the stored grant and finish it (one refund); two concurrent grants and two concurrent denials each
//         produce one resolution, one refund at most, one notice; the response always carries the STORED decision.
//   R3-3  Partial completion is resumed from the recorded marks: provider timeout (refund_pending, the refund worker's
//         leased retry, then completion); mail failure (the worker re-sends under the SAME notice key); a progress mark
//         lost after the provider refund (the replay adopts the existing reservation: one ledger obligation); a crash
//         right after the claim (the worker finishes everything). The eligibility case closes only with a resolution.
//   R3-2  The review sweep selects outstanding work in the database: 30 under_review decisions where the oldest 25
//         already have cases are no obstacle (the 5 outstanding ones are picked on the first run); a poison row (case
//         service failing) does not block the others and is retried on a later run; two concurrent sweeps open each
//         case once.
//   R3-4  Payment in flight: a booking in checkout (pending_payment) cannot be cancelled and no decision can be
//         recorded on it (state_conflict); once paid, the record is bound to the paid state. An authorized hold against
//         cancellation in both controlled orders and concurrently: capture first then cancel (paid cancellation with a
//         refund), release first then confirm (nothing charged), capture landed at Stripe before the ledger saw it then
//         cancel (409 hold_captured, converged to paid, then a paid cancellation with a refund), and both at once
//         (never charged-and-released). An abandoned recorded cancellation becomes a deduplicated case and the retry
//         closes it.
import { createHmac } from 'node:crypto';
import { installSpy, callRoute, req, rawReq, ok, summary, uniq, ENV, FIXTURE_PRODUCTS } from './_route.mjs';
import { HOURLY } from './_fixture_availability.mjs';
import { getBinding } from '../api/_env.js';
import { fanOutEvents, dispatchDue } from '../api/_notification-outbox.js';
import { sweepUnfinishedResolutions } from '../api/_cancellation-review.js';

const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  return { ok: r.ok, status: r.status, body: j };
};
const rpc = async (fn, args) => { const r = await db(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) }); return Array.isArray(r.body) ? r.body[0] : r.body; };
const one = (r) => (r && Array.isArray(r.body) ? r.body[0] : null);
const bin = []; const track = (t, id) => { if (id) bin.push([t, id]); return id; };
const LA = 'America/Los_Angeles';
const spy = installSpy();
ENV.RETAILER_MOVES_ENABLED = 'true';
ENV.PROVISIONAL_HOLDS_ENABLED = 'true';            // a brand without an approved certificate books a HELD (authorized, uncaptured) booking
ENV.RESOLUTION_RESUME_GRACE_SECONDS = '0';         // the worker resumes unfinished resolutions at once in this suite
ENV.CANCELLATION_ABANDONED_MINUTES = '15';
const watchdog = setTimeout(() => { console.log('  FAIL watchdog: suite exceeded 25 minutes'); process.exit(1); }, 25 * 60 * 1000);
const sign = (payload, secret = 'whsec_harness') => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`; };
const idList = (arr) => arr.map(encodeURIComponent).join(',');
const hours = (h) => new Date(Date.now() + h * 3600e3).toISOString();
function dayP(n) {
  const d = new Date(Date.now() + n * 864e5);
  const p = {}; for (const x of new Intl.DateTimeFormat('en-US', { timeZone: LA, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}

console.log('\nFixtures');
const slug = uniq('rcr');
const retailerId = track('retailers', one(await db('retailers', { method: 'POST', body: JSON.stringify({
  slug, name: 'Recovery Market', billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active',
  platform_keeps_all: true, timezone: LA, auto_confirm_bookings: false, cancellation_mode: 'refundable', verification_status: 'approved' }) })).id);
track('settings', one(await db('settings', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, demo_fee: 30, advance_booking_days: 0 }) })).id);
const venueId = track('venues', one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, name: 'Recovery Main', address: '2 Resume St', demo_fee: 30, availability: HOURLY }) })).id);
const staffEmail = `staff-${slug}@fixture.test`;
track('retailer_admins', one(await db('retailer_admins', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, email: staffEmail, email_normalized: staffEmail, name: 'Recovery Staff', role: 'admin' }) })).id);
const tok = one(await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: staffEmail, retailer_id: retailerId }) }));
const cookie = (await callRoute('admin-auth.js', req({ body: { action: 'verify', token: tok.token } }))).cookie('dh_retailer_session');
const brandEmail = `${uniq('brand')}@fixture.test`;
const brandId = track('brands', one(await db('brands', { method: 'POST', body: JSON.stringify({ email: brandEmail, company_name: 'Recovery Brand', contact_name: 'Rec Contact', phone: '555-0174', is_verified: true,
  default_coi_url: 'brands/recovery.pdf', default_coi_expires: dayP(400), coi_verification_status: 'approved' }) })).id);
const brandTok = one(await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: brandId, email: brandEmail, token: 'tk-' + uniq('r'), expires_at: hours(1) }) }));
const brandCookie = (await callRoute('brand-account.js', req({ body: { action: 'verify', token: brandTok.token } }))).cookie('dh_brand_session');
// a second brand with NO approved certificate: its bookings are provisional holds
const holdEmail = `${uniq('hold')}@fixture.test`;
const holdBrandId = track('brands', one(await db('brands', { method: 'POST', body: JSON.stringify({ email: holdEmail, company_name: 'Hold Brand', contact_name: 'Hold Contact', phone: '555-0175', is_verified: true, coi_verification_status: 'pending' }) })).id);
const holdTok = one(await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: holdBrandId, email: holdEmail, token: 'tk-' + uniq('h'), expires_at: hours(1) }) }));
const holdCookie = (await callRoute('brand-account.js', req({ body: { action: 'verify', token: holdTok.token } }))).cookie('dh_brand_session');
ok('fixtures: retailer, staff session, two brand sessions exist', !!retailerId && !!venueId && !!cookie && !!brandCookie && !!holdCookie);
const otherRetailerIdForQ = track('retailers', one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug: uniq('rcq'), name: 'Other Market Q', billing_email: `${uniq('rcq')}@fixture.test`, billing_tier: 'pro', billing_status: 'active', timezone: LA, verification_status: 'approved' }) })).id);
const b = await getBinding();
// Codex R4-3: the resolution notice is an outbox event (kind refund_resolution); the suite drains the outbox the way the
// notification worker does: fan-out (live recipients) then dispatch (recheck, freeze, send under the delivery's key).
const notices = async (now = new Date()) => { await fanOutEvents(b, { now }); return dispatchDue(b, { now }); };
const deliveriesOf = async (id) => (await db(`notification_deliveries?booking_id=eq.${id}&kind=eq.refund_resolution&select=id,status,attempts,recipient_email,recipient_kind,frozen_payload&order=created_at.asc`)).body || [];

let seedN = 0;
async function seed({ days, status = 'confirmed', payment_status = 'paid', pi = true, time = null }) {
  const t = time || `${9 + (seedN++ % 10)}:00`;
  const r = await db('bookings', { method: 'POST', body: JSON.stringify({
    retailer_id: retailerId, venue_id: venueId, brand_id: brandId, brand_name: 'Recovery Brand', contact_name: 'Rec Contact', contact_email: brandEmail,
    product: 'Samples', demo_date: dayP(days), demo_time: t, status, payment_status, payment_intent_id: pi ? 'pi_' + uniq('rr') : null }) });
  const b = one(r);
  if (!b || !b.id) throw new Error('seed failed: ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 200));
  track('bookings', b.id);
  return b;
}
const act = (body, c = cookie) => callRoute('booking-action.js', req({ body, cookies: { dh_retailer_session: c } }));
const cancel = (booking_id, extra = {}) => act({ action: 'cancel', category: 'brand_requested', booking_id, ...extra });
const confirm = (booking_id) => act({ action: 'confirm', booking_id });
const review = (body) => callRoute('refund-review.js', req({ body, cookies: { dh_retailer_session: cookie } }));
const worker = () => callRoute('refund-worker.js', req({ method: 'GET', headers: { authorization: 'Bearer ' + ENV.CRON_SECRET } }));
const row = async (id) => one(await db(`bookings?id=eq.${id}&select=status,payment_status,cancelled_at,cancellation_pending_at,schedule_revision,payment_intent_id`));
const decisionRows = async (id) => (await db(`booking_cancellations?booking_id=eq.${id}&select=*`)).body || [];
const resolutionRows = async (id) => (await db(`booking_cancellation_resolutions?booking_id=eq.${id}&select=*`)).body || [];
const caseOf = async (id, prefix = 'refund-eligibility:') => one(await db(`reconciliation_cases?dedupe_key=eq.${encodeURIComponent(prefix + id)}&select=id,status,resolved_by,resolved_at,kind,reason,details`));
const allocOf = async (id) => one(await db(`payment_allocations?booking_id=eq.${id}&select=customer_amount,refunded_amount,reserved_refund_amount`));
const requestsOf = async (id) => (await db(`refund_requests?booking_id=eq.${id}&select=id,status,amount`)).body || [];
const stripeRefundCalls = () => spy.calls.stripe.filter(c => /\/refunds/.test(c.url) && String(c.method || 'GET').toUpperCase() === 'POST').length;   // refund SUBMISSIONS; the operator replace route also lists refunds (GET)
const mailsSince = (n, re) => spy.calls.resend.slice(n).filter(m => re.test(String(m.subject || '')));
const text = (m) => (m ? String(m.html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') : 'no mail');
const groups = [];

// Four bookings on one shared payment, paid, pending (auto-confirm off), through the real routes.
async function paidGroup(slots, bcookie = brandCookie) {
  const ids = [];
  for (const [days, time] of slots) {
    const bk = await callRoute('book.js', req({ body: { retailer_slug: slug, venue_id: venueId, demo_date: dayP(days), demo_time: time, product_skus: FIXTURE_PRODUCTS }, cookies: { dh_brand_session: bcookie } }));
    const id = bk.body && (bk.body.booking_id || bk.body.id || (bk.body.booking && bk.body.booking.id));
    if (id) { track('bookings', id); ids.push(id); } else throw new Error('book.js ' + bk.statusCode + ' ' + JSON.stringify(bk.body).slice(0, 200));
  }
  const co = await callRoute('checkout.js', req({ body: { booking_ids: ids }, cookies: { dh_brand_session: bcookie } }));
  const sessionId = co.body && co.body.session_id, groupId = co.body && co.body.payment_group_id, total = co.body && co.body.total_cents;
  if (!sessionId || !groupId) throw new Error('checkout ' + co.statusCode + ' ' + JSON.stringify(co.body).slice(0, 200));
  groups.push(groupId);
  const piId = 'pi_' + uniq('paid'), chargeId = 'ch_' + uniq('paid');
  spy.fixtures.paymentIntents[piId] = { id: piId, object: 'payment_intent', status: 'succeeded', amount: total, amount_received: total, currency: 'usd', on_behalf_of: null,
    latest_charge: { id: chargeId, object: 'charge', destination: null, application_fee_amount: null, transfer: null, application_fee: null } };
  const paidEvent = JSON.stringify({ id: 'evt_' + uniq('paid'), type: 'checkout.session.completed',
    data: { object: { id: sessionId, object: 'checkout.session', mode: 'payment', payment_status: 'paid', amount_total: total, currency: 'usd', payment_intent: piId, metadata: { payment_group_id: groupId } } } });
  const w = await callRoute('stripe-webhook.js', rawReq(paidEvent, { signature: sign(paidEvent) }));
  if (w.statusCode >= 300) throw new Error('paid webhook ' + w.statusCode);
  return { ids, groupId, piId };
}
// Cancel a paid pending booking inside the window: pending_manual, no refund yet.
async function pendingManual(id) {
  const k = await confirm(id); if (k.statusCode !== 200) throw new Error('confirm ' + k.statusCode + ' ' + JSON.stringify(k.body).slice(0, 160));
  const c = await cancel(id); if (c.statusCode !== 200 || c.body.refund_status !== 'pending_manual') throw new Error('cancel ' + c.statusCode + ' ' + JSON.stringify(c.body).slice(0, 160));
}
const claim = (id, decision, operator, reason) => rpc('booking_cancellation_claim', { p_booking_id: id, p_retailer_id: retailerId, p_decision: decision, p_operator: operator, p_reason: reason });

try {
  console.log('\nR3-1 the claim is the barrier (four inside-window cancellations on one shared payment)');
  const g1 = await paidGroup([[1, '9:00'], [1, '10:00'], [2, '9:00'], [2, '10:00']]);
  for (const id of g1.ids) await pendingManual(id);
  ok('four paid bookings cancelled inside the window: pending_manual, no refund', (await Promise.all(g1.ids.map(allocOf))).every(a => Number(a.refunded_amount) === 0) && stripeRefundCalls() === 0);
  {
    const [A, B, C, D] = g1.ids;
    // A: a denial wins the claim; the grant that follows issues nothing
    const r0 = stripeRefundCalls(); const m0 = spy.calls.resend.length;
    const d = await claim(A, 'no_refund', 'other-admin@fixture.test', 'kept per policy');
    ok('A: a denial is claimed directly (state claimed)', d && d.outcome === 'claimed' && d.resolution.state === 'claimed', JSON.stringify(d).slice(0, 160));
    await db(`booking_cancellation_resolutions?booking_id=eq.${A}`, { method: 'PATCH', body: JSON.stringify({ updated_at: new Date(Date.now() - 5 * 60e3).toISOString() }) });   // the claimant is long gone (a replay inside the grace window only reports the stored decision)
    const g = await review({ action: 'grant', booking_id: A, reason: 'please refund' });
    await notices();
    const resA = await resolutionRows(A);
    ok('A: the later grant returns the STORED denial (existing, decision no_refund), issues ZERO provider calls, and finishes the denial (completed, brand told once, Refund decision)', g.statusCode === 200 && g.body.existing === true && g.body.decision === 'no_refund' && g.body.requested === 'refund_granted' && g.body.refund_status === 'none' && stripeRefundCalls() === r0 && resA.length === 1 && resA[0].state === 'completed' && resA[0].decision === 'no_refund' && mailsSince(m0, /Refund decision/).length === 1 && mailsSince(m0, /Refund approved/).length === 0, `${g.statusCode} ${JSON.stringify(g.body).slice(0, 220)} ${JSON.stringify(resA[0] && { state: resA[0].state, notified: resA[0].brand_notified_at })}`);
    ok('A: the allocation is untouched', Number((await allocOf(A)).refunded_amount) === 0);
    // B: a grant is claimed and the process dies right after; a denial arrives next
    const r1 = stripeRefundCalls(); const m1 = spy.calls.resend.length;
    const gc = await claim(B, 'refund_granted', staffEmail, 'goodwill');
    ok('B: a grant is claimed directly (crash after the claim: no refund yet)', gc && gc.outcome === 'claimed' && (await requestsOf(B)).length === 0 && stripeRefundCalls() === r1, JSON.stringify(gc).slice(0, 120));
    await db(`booking_cancellation_resolutions?booking_id=eq.${B}`, { method: 'PATCH', body: JSON.stringify({ updated_at: new Date(Date.now() - 5 * 60e3).toISOString() }) });   // the crash was a while ago
    const dn = await review({ action: 'deny', booking_id: B, reason: 'changed my mind' });
    await notices();
    const resB = await resolutionRows(B); const alB = await allocOf(B);
    ok('B: the denial returns the STORED grant (existing, decision refund_granted) and finishes it: ONE refund, the allocation refunded in full, refund_status submitted, completed, Refund approved mail once', dn.statusCode === 200 && dn.body.existing === true && dn.body.decision === 'refund_granted' && dn.body.requested === 'no_refund' && dn.body.refund_status === 'submitted' && stripeRefundCalls() === r1 + 1 && Number(alB.refunded_amount) === Number(alB.customer_amount) && resB.length === 1 && resB[0].state === 'completed' && resB[0].refund_request_id && mailsSince(m1, /Refund approved/).length === 1 && mailsSince(m1, /Refund decision/).length === 0, `${dn.statusCode} ${JSON.stringify(dn.body).slice(0, 220)}`);
    // C: two grants at once
    const r2 = stripeRefundCalls(); const m2 = spy.calls.resend.length;
    const [c1, c2] = await Promise.all([review({ action: 'grant', booking_id: C, reason: 'one' }), review({ action: 'grant', booking_id: C, reason: 'two' })]);
    await notices();
    const resC = await resolutionRows(C); const alC = await allocOf(C);
    ok('C: two concurrent grants: both 200, exactly one won the claim, ONE Stripe refund, one request, one resolution (completed), one mail', c1.statusCode === 200 && c2.statusCode === 200 && [c1.body.existing, c2.body.existing].filter(x => x === false).length === 1 && stripeRefundCalls() === r2 + 1 && (await requestsOf(C)).length === 1 && resC.length === 1 && resC[0].state === 'completed' && Number(alC.refunded_amount) === Number(alC.customer_amount) && mailsSince(m2, /Refund approved/).length === 1, JSON.stringify({ c1: c1.body && { existing: c1.body.existing, state: c1.body.state }, c2: c2.body && { existing: c2.body.existing, state: c2.body.state }, refunds: stripeRefundCalls() - r2, mails: mailsSince(m2, /Refund approved/).length }));
    // D: two denials at once
    const r3 = stripeRefundCalls(); const m3 = spy.calls.resend.length;
    const [d1, d2] = await Promise.all([review({ action: 'deny', booking_id: D, reason: 'one' }), review({ action: 'deny', booking_id: D, reason: 'two' })]);
    await notices();
    const resD = await resolutionRows(D);
    ok('D: two concurrent denials: one resolution (reason of the winner), zero refunds, one mail', d1.statusCode === 200 && d2.statusCode === 200 && resD.length === 1 && ['one', 'two'].includes(resD[0].reason) && stripeRefundCalls() === r3 && mailsSince(m3, /Refund decision/).length === 1, JSON.stringify({ reason: resD[0] && resD[0].reason, mails: mailsSince(m3, /Refund decision/).length }));
    ok('D: the allocation is untouched; C and B are refunded exactly once each (one request per booking)', Number((await allocOf(D)).refunded_amount) === 0 && (await requestsOf(B)).length === 1 && (await requestsOf(C)).length === 1);
  }

  console.log('\nR3-3 partial completion is resumed from the recorded marks (four more inside-window cancellations)');
  const g2 = await paidGroup([[1, '11:00'], [1, '12:00'], [2, '11:00'], [2, '12:00']]);
  for (const id of g2.ids) await pendingManual(id);
  {
    const [E, F, G, I] = g2.ids;
    // E: provider timeout on the refund
    spy.faults.push({ url: '/refunds', method: 'POST', status: 500, message: 'injected_stripe_timeout', once: true });
    const m0 = spy.calls.resend.length;
    const e1 = await review({ action: 'grant', booking_id: E, reason: 'goodwill' });
    await notices();
    const resE1 = await resolutionRows(E); const rqE1 = await requestsOf(E);
    ok('E: 200 in_progress, refund_status refund_pending, the request parked failed_retryable with the reservation kept, state refund_pending, the brand told the refund is in progress', e1.statusCode === 200 && e1.body.outcome === 'in_progress' && e1.body.refund_status === 'refund_pending' && resE1[0].state === 'refund_pending' && rqE1.length === 1 && rqE1[0].status === 'failed_retryable' && /being processed/.test(text(mailsSince(m0, /Refund approved/)[0])), `${e1.statusCode} ${JSON.stringify(e1.body).slice(0, 200)} ${JSON.stringify(rqE1)}`);
    const wk = await worker();
    const rqE2 = await requestsOf(E); const resE2 = await resolutionRows(E); const alE = await allocOf(E);
    ok('E: the refund worker resubmits the parked request under its stored key and the resolution resume marks it submitted and completed; the allocation holds exactly one obligation (reserved or refunded); still one request', wk.statusCode === 200 && rqE2.length === 1 && ['submitted', 'succeeded', 'pending'].includes(rqE2[0].status) && resE2[0].state === 'completed' && resE2[0].refund_request_id === rqE2[0].id && Number(alE.refunded_amount) + Number(alE.reserved_refund_amount || 0) === Number(alE.customer_amount), JSON.stringify({ wk: wk.statusCode, body: wk.body && { resubmitted: wk.body.resubmitted, resolutions: [wk.body.resolutions_checked, wk.body.resolutions_completed], first_error: wk.body.first_error }, rq: rqE2, state: resE2[0].state, linked: resE2[0].refund_request_id, al: alE }));
    await notices();
    ok('E: the brand was told once (the event is unique per booking; the later state change does not resend)', mailsSince(m0, /Refund approved/).length === 1, String(mailsSince(m0, /Refund approved/).length));
    // F: the notice provider is down when the outbox first dispatches; the retry re-sends the FROZEN payload under the same key
    const m1 = spy.calls.resend.length; const r1 = stripeRefundCalls();
    const f1 = await review({ action: 'grant', booking_id: F, reason: 'goodwill' });
    const resF1 = await resolutionRows(F);
    ok('F: the grant completes its workflow: refund submitted, case step, the notice handed to the outbox (notice_event_id set), state completed', f1.statusCode === 200 && f1.body.outcome === 'resolved' && resF1[0].state === 'completed' && !!resF1[0].notice_event_id && resF1[0].brand_notified_at, `${f1.statusCode} ${JSON.stringify(f1.body).slice(0, 200)}`);
    const evF = one(await db(`notification_events?id=eq.${resF1[0].notice_event_id}&select=id,kind,transition_id,booking_id`));
    ok('F: one refund_resolution event for the booking (unique per booking)', evF && evF.kind === 'refund_resolution' && evF.transition_id === F + ':resolution' && evF.booking_id === F, JSON.stringify(evF));
    spy.faults.push({ url: 'api.resend.com', method: 'POST', status: 500, message: 'injected_mail_outage' });   // persistent until cleared
    await notices();
    const dl1 = await deliveriesOf(F);
    ok('F: the delivery to the brand owner failed and is kept for retry (failed, one attempt, payload frozen, recipient the owner, nothing accepted)', dl1.length === 1 && dl1[0].status === 'failed' && dl1[0].attempts === 1 && dl1[0].recipient_email === brandEmail && !!dl1[0].frozen_payload && mailsSince(m1, /Refund approved/).length === 1, JSON.stringify(dl1.map(d => ({ status: d.status, attempts: d.attempts, to: d.recipient_email, frozen: !!d.frozen_payload }))));
    spy.faults.length = 0;
    // the refund state changes in between (the mark is cleared to simulate a later change); the frozen payload must still be what is re-sent
    await db(`booking_cancellation_resolutions?booking_id=eq.${F}`, { method: 'PATCH', body: JSON.stringify({ refund_submitted_at: null }) });
    await notices(new Date(Date.now() + 3 * 60e3));   // past the first backoff
    await db(`booking_cancellation_resolutions?booking_id=eq.${F}`, { method: 'PATCH', body: JSON.stringify({ refund_submitted_at: resF1[0].refund_submitted_at }) });
    const dl2 = await deliveriesOf(F); const sentF = mailsSince(m1, /Refund approved/);
    ok('F: the retry re-sent the FROZEN payload under the same provider key: two provider calls, identical key and html, the delivery now accepted, no second refund', dl2.length === 1 && ['sent', 'accepted'].includes(dl2[0].status) && sentF.length === 2 && !!sentF[0].idempotency_key && sentF[0].idempotency_key === sentF[1].idempotency_key && sentF[0].html === sentF[1].html && stripeRefundCalls() === r1 + 1, JSON.stringify({ status: dl2[0] && dl2[0].status, keys: sentF.map(m => m.idempotency_key), sameHtml: sentF.length === 2 && sentF[0].html === sentF[1].html }));
    await notices(new Date(Date.now() + 6 * 60e3));
    ok('F: a further dispatch sends nothing more (one accepted notice)', mailsSince(m1, /Refund approved/).length === 2);
    // G: the progress mark is lost right after the provider refund
    spy.faults.push({ url: '/rpc/booking_cancellation_progress', method: 'POST', status: 500, message: 'injected_mark_loss', once: true });
    const r2 = stripeRefundCalls();
    const gg1 = await review({ action: 'grant', booking_id: G, reason: 'goodwill' });
    const resG1 = await resolutionRows(G); const rqG1 = await requestsOf(G);
    ok('G: the provider refund went out, the mark was lost: state failed with no request linked yet, one refund request in the ledger', gg1.statusCode === 200 && gg1.body.outcome === 'in_progress' && resG1[0].state === 'failed' && resG1[0].refund_request_id == null && stripeRefundCalls() === r2 + 1 && rqG1.length === 1, `${gg1.statusCode} ${JSON.stringify(gg1.body).slice(0, 200)} ${JSON.stringify({ state: resG1[0].state, rq: rqG1.length })}`);
    const gg2 = await review({ action: 'grant', booking_id: G, reason: 'retry' });
    const resG2 = await resolutionRows(G); const rqG2 = await requestsOf(G); const alG = await allocOf(G);
    ok('G: the replay adopts the existing reservation (same request, same key): still ONE refund request, the allocation refunded once, the request linked, completed', gg2.statusCode === 200 && gg2.body.existing === true && gg2.body.refund_status === 'submitted' && rqG2.length === 1 && resG2[0].refund_request_id === rqG2[0].id && resG2[0].state === 'completed' && Number(alG.refunded_amount) === Number(alG.customer_amount), JSON.stringify({ gg2: gg2.body && { existing: gg2.body.existing, state: gg2.body.state, step: gg2.body.pending_step }, rq: rqG2.length, al: alG, last_error: resG2[0] && resG2[0].last_error }));
    // I: a crash right after the claim; nothing else happens until the worker runs
    const r3 = stripeRefundCalls(); const m3 = spy.calls.resend.length;
    const ic = await claim(I, 'refund_granted', staffEmail, 'goodwill after the fact');
    ok('I: claimed, nothing else', ic && ic.outcome === 'claimed' && stripeRefundCalls() === r3);
    const wk3 = await worker();
    const resI = await resolutionRows(I); const alI = await allocOf(I);
    await notices();
    ok('I: the worker finishes the claimed grant: one refund, allocation refunded, brand told once, completed', wk3.statusCode === 200 && resI[0].state === 'completed' && stripeRefundCalls() === r3 + 1 && Number(alI.refunded_amount) === Number(alI.customer_amount) && (await deliveriesOf(I)).length === 1 && (await deliveriesOf(I))[0].status === 'accepted', JSON.stringify({ state: resI[0].state, wk: wk3.body && { checked: wk3.body.resolutions_checked, completed: wk3.body.resolutions_completed }, mails: mailsSince(m3, /Refund approved/).length, deliveries: (await deliveriesOf(I)).map(d => d.status), event: resI[0].notice_event_id }));
    const wk4 = await worker();
    ok('I: a further run finds nothing unfinished', wk4.statusCode === 200 && wk4.body.resolutions_checked === 0, JSON.stringify(wk4.body && { checked: wk4.body.resolutions_checked }));
  }

  console.log('\nR3-3 the eligibility case closes only with a resolution (under_review cancellation)');
  {
    const u = await seed({ days: 8 });
    await db(`bookings?id=eq.${u.id}`, { method: 'PATCH', body: JSON.stringify({ start_at: null, timezone: 'Not/AZone' }) });
    const c = await cancel(u.id);
    const cs = await caseOf(u.id);
    ok('cancel: under_review with its case open', c.statusCode === 200 && c.body.refund_status === 'under_review' && cs && cs.status !== 'resolved', `${c.statusCode}`);
    if (cs) track('reconciliation_cases', cs.id);
    const g = await review({ action: 'grant', booking_id: u.id, reason: 'try' });
    ok('a grant on this uncharged booking is refused before any claim: nothing recorded, the case still open', g.statusCode === 409 && g.body.error === 'refund_not_possible' && (await resolutionRows(u.id)).length === 0 && (await caseOf(u.id)).status !== 'resolved', `${g.statusCode} ${JSON.stringify(g.body).slice(0, 120)}`);
    const d = await review({ action: 'deny', booking_id: u.id, reason: 'never a valid slot' });
    const cs2 = await caseOf(u.id); const res = await resolutionRows(u.id);
    ok('a denial resolves it: the case resolved by the operator in the same step as the mark, resolution completed and linked to the case', d.statusCode === 200 && d.body.outcome === 'resolved' && cs2.status === 'resolved' && cs2.resolved_by === staffEmail && res[0].case_id === cs.id && res[0].state === 'completed' && res[0].case_closed_at, JSON.stringify({ d: d.body && d.body.outcome, cs2, res: res[0] && { state: res[0].state, case_id: res[0].case_id } }));
  }

  console.log('\nR3-2 the review sweep progresses beyond its first batch');
  {
    const ids = [];
    for (let i = 0; i < 30; i++) {
      const b = await seed({ days: 20 + (i % 5), status: 'cancelled', time: `${9 + (i % 9)}:00` });
      ids.push(b.id);
      const ins = await db('booking_cancellations', { method: 'POST', body: JSON.stringify({ booking_id: b.id, retailer_id: retailerId, category: 'brand_requested', requested_at: hours(-2), actor: staffEmail, cancellation_mode: 'refundable', cutoff_hours: 72, start_source: 'unresolved', refund: false, status: 'under_review', reason: 'start_unresolvable', decided_at: new Date(Date.now() - (60 - i) * 60e3).toISOString() }) });
      if (ins.status >= 300) throw new Error('decision seed ' + ins.status + ' ' + JSON.stringify(ins.body).slice(0, 160));
    }
    // the oldest 25 already have their case
    for (const id of ids.slice(0, 25)) {
      const cid = await rpc('_open_case', { p_kind: 'refund_requires_review', p_dedupe: 'refund-eligibility:' + id, p_reason: 'refund_eligibility_unresolved', p_group: null, p_request: null, p_operation: null, p_session: null, p_pi: null, p_charge: null, p_refund: null, p_amount: null, p_currency: null, p_details: { booking_id: id, opened_by: 'seed' } });
      if (!cid) throw new Error('seed case failed');
    }
    const wk = await worker();
    const missing = (await db(`reconciliation_cases?dedupe_key=in.(${ids.slice(25).map(id => '"refund-eligibility:' + id + '"').join(',')})&select=dedupe_key`)).body || [];
    ok('first run: the 5 outstanding rows behind 25 covered ones are selected and their cases opened (checked 5, opened 5)', wk.statusCode === 200 && wk.body.cancellation_reviews_checked === 5 && wk.body.cancellation_cases_opened === 5 && missing.length === 5, JSON.stringify({ wk: wk.body && { checked: wk.body.cancellation_reviews_checked, opened: wk.body.cancellation_cases_opened }, missing: missing.length }));
    const wk2 = await worker();
    ok('second run: nothing outstanding', wk2.statusCode === 200 && wk2.body.cancellation_reviews_checked === 0, JSON.stringify(wk2.body && { checked: wk2.body.cancellation_reviews_checked }));
    // a poison row: the case service fails for the first attempt; another outstanding row still progresses
    const p1 = await seed({ days: 26, status: 'cancelled', time: '9:00' }), p2 = await seed({ days: 26, status: 'cancelled', time: '10:00' });
    for (const [b, mins] of [[p1, 30], [p2, 20]]) await db('booking_cancellations', { method: 'POST', body: JSON.stringify({ booking_id: b.id, retailer_id: retailerId, category: 'brand_requested', requested_at: hours(-2), actor: staffEmail, cancellation_mode: 'refundable', cutoff_hours: 72, start_source: 'unresolved', refund: false, status: 'under_review', reason: 'start_unresolvable', decided_at: new Date(Date.now() - mins * 60e3).toISOString() }) });
    spy.faults.push({ url: '/rpc/_open_case', method: 'POST', status: 500, message: 'injected_case_service_down', once: true });
    const wk3 = await worker();
    const c1 = await caseOf(p1.id), c2 = await caseOf(p2.id);
    ok('poison run: one open failed (the run is reported failed), the other outstanding row still got its case', wk3.statusCode === 500 && wk3.body.cancellation_cases_failed === 1 && wk3.body.cancellation_cases_opened === 1 && ((c1 && !c2) || (!c1 && c2)), JSON.stringify({ wk: wk3.body && { opened: wk3.body.cancellation_cases_opened, failed: wk3.body.cancellation_cases_failed }, c1: !!c1, c2: !!c2 }));
    const wk4 = await worker();
    ok('next run: the poisoned row is retried and gets its case; no duplicates', wk4.statusCode === 200 && wk4.body.cancellation_cases_opened === 1 && !!(await caseOf(p1.id)) && !!(await caseOf(p2.id)), JSON.stringify(wk4.body && { opened: wk4.body.cancellation_cases_opened }));
    // two concurrent sweeps over two fresh outstanding rows: each case exactly once
    const q1 = await seed({ days: 27, status: 'cancelled', time: '9:00' }), q2 = await seed({ days: 27, status: 'cancelled', time: '10:00' });
    for (const b of [q1, q2]) await db('booking_cancellations', { method: 'POST', body: JSON.stringify({ booking_id: b.id, retailer_id: retailerId, category: 'brand_requested', requested_at: hours(-2), actor: staffEmail, cancellation_mode: 'refundable', cutoff_hours: 72, start_source: 'unresolved', refund: false, status: 'under_review', reason: 'start_unresolvable' }) });
    const [s1, s2] = await Promise.all([worker(), worker()]);
    const cases = (await db(`reconciliation_cases?dedupe_key=in.("refund-eligibility:${q1.id}","refund-eligibility:${q2.id}")&select=dedupe_key`)).body || [];
    ok('two concurrent workers: two cases in total, one per booking, both runs clean', s1.statusCode === 200 && s2.statusCode === 200 && cases.length === 2 && new Set(cases.map(c => c.dedupe_key)).size === 2 && (s1.body.cancellation_cases_opened + s2.body.cancellation_cases_opened) === 2, JSON.stringify({ a: s1.body && s1.body.cancellation_cases_opened, b: s2.body && s2.body.cancellation_cases_opened, cases: cases.length }));
    for (const id of [...ids, p1.id, p2.id, q1.id, q2.id]) { const c = await caseOf(id); if (c) track('reconciliation_cases', c.id); }
  }

  console.log('\nR3-4 payment in flight: a booking in checkout cannot be cancelled or recorded; once paid the record is bound to the paid state');
  {
    const bk = await callRoute('book.js', req({ body: { retailer_slug: slug, venue_id: venueId, demo_date: dayP(9), demo_time: '13:00', product_skus: FIXTURE_PRODUCTS }, cookies: { dh_brand_session: brandCookie } }));
    const id = bk.body && (bk.body.booking_id || bk.body.id); track('bookings', id);
    const co = await callRoute('checkout.js', req({ body: { booking_ids: [id] }, cookies: { dh_brand_session: brandCookie } }));
    groups.push(co.body && co.body.payment_group_id);
    const st = await row(id);
    ok('during checkout the booking is pending_payment and unpaid', st.status === 'pending_payment' && st.payment_status === 'unpaid', JSON.stringify(st));
    const c1 = await cancel(id);
    ok('a store cancel while the payment is in flight is refused (409, pending_payment is not cancellable)', c1.statusCode === 409 && /pending_payment/.test(String(c1.body.error || '')), `${c1.statusCode} ${JSON.stringify(c1.body).slice(0, 120)}`);
    const rec = await rpc('booking_cancellation_record', { p_booking_id: id, p_retailer_id: retailerId, p_decision: { category: 'brand_requested', requested_at: new Date().toISOString(), cancellation_mode: 'refundable', cutoff_hours: 72, start_source: 'computed', refund: false, status: 'not_paid', reason: 'not_paid' }, p_expect: { payment_status: 'unpaid' } });
    ok('no decision can be recorded on it either (state_conflict), so a not_paid decision cannot precede the capture', rec && rec.outcome === 'state_conflict' && (await decisionRows(id)).length === 0 && (await row(id)).cancellation_pending_at == null, JSON.stringify(rec));
    const piId = 'pi_' + uniq('late'), chargeId = 'ch_' + uniq('late'); const total = co.body.total_cents;
    spy.fixtures.paymentIntents[piId] = { id: piId, object: 'payment_intent', status: 'succeeded', amount: total, amount_received: total, currency: 'usd', on_behalf_of: null, latest_charge: { id: chargeId, object: 'charge', destination: null, application_fee_amount: null, transfer: null, application_fee: null } };
    const ev = JSON.stringify({ id: 'evt_' + uniq('late'), type: 'checkout.session.completed', data: { object: { id: co.body.session_id, object: 'checkout.session', mode: 'payment', payment_status: 'paid', amount_total: total, currency: 'usd', payment_intent: piId, metadata: { payment_group_id: co.body.payment_group_id } } } });
    await callRoute('stripe-webhook.js', rawReq(ev, { signature: sign(ev) }));
    const st2 = await row(id);
    ok('the payment lands: pending and paid', st2.status === 'pending' && st2.payment_status === 'paid', JSON.stringify(st2));
    const stale = await rpc('booking_cancellation_record', { p_booking_id: id, p_retailer_id: retailerId, p_decision: { category: 'brand_requested', requested_at: new Date().toISOString(), cancellation_mode: 'refundable', cutoff_hours: 72, start_source: 'computed', refund: false, status: 'not_paid', reason: 'not_paid' }, p_expect: { payment_status: 'unpaid' } });
    ok('a decision computed from the unpaid read is refused as stale (current payment_status paid); nothing recorded', stale && stale.outcome === 'stale' && stale.current.payment_status === 'paid' && (await decisionRows(id)).length === 0, JSON.stringify(stale).slice(0, 160));
    const r0 = stripeRefundCalls();
    const c2 = await cancel(id);
    const al = await allocOf(id);
    ok('the cancel through the route judges the paid row: outside_cutoff, refund submitted, the allocation refunded in full', c2.statusCode === 200 && c2.body.refund_status === 'submitted' && c2.body.refund_reason === 'outside_cutoff' && stripeRefundCalls() === r0 + 1 && Number(al.refunded_amount) === Number(al.customer_amount), `${c2.statusCode} ${JSON.stringify(c2.body).slice(0, 160)}`);
  }

  console.log('\nR3-4 an authorized hold against cancellation: both controlled orders and both at once');
  async function heldBooking(days, time) {
    const bk = await callRoute('book.js', req({ body: { retailer_slug: slug, venue_id: venueId, demo_date: dayP(days), demo_time: time, product_skus: FIXTURE_PRODUCTS }, cookies: { dh_brand_session: holdCookie } }));
    const id = bk.body && (bk.body.booking_id || bk.body.id); if (!id) throw new Error('hold book ' + bk.statusCode + ' ' + JSON.stringify(bk.body).slice(0, 200)); track('bookings', id);
    const co = await callRoute('checkout.js', req({ body: { booking_ids: [id] }, cookies: { dh_brand_session: holdCookie } }));
    if (!co.body || !co.body.session_id) throw new Error('hold checkout ' + co.statusCode + ' ' + JSON.stringify(co.body).slice(0, 200));
    groups.push(co.body.payment_group_id);
    const piId = 'pi_' + uniq('hold'), chargeId = 'ch_' + uniq('hold'); const total = co.body.total_cents;
    spy.fixtures.paymentIntents[piId] = { id: piId, object: 'payment_intent', status: 'requires_capture', amount: total, amount_received: 0, currency: 'usd', on_behalf_of: null, latest_charge: { id: chargeId, object: 'charge', destination: null, application_fee_amount: null, transfer: null, application_fee: null } };
    const ev = JSON.stringify({ id: 'evt_' + uniq('hold'), type: 'checkout.session.completed', data: { object: { id: co.body.session_id, object: 'checkout.session', mode: 'payment', payment_status: 'unpaid', amount_total: total, currency: 'usd', payment_intent: piId, metadata: { payment_group_id: co.body.payment_group_id } } } });
    const w = await callRoute('stripe-webhook.js', rawReq(ev, { signature: sign(ev) }));
    const st = await row(id);
    if (!(w.statusCode < 300 && st.status === 'held' && st.payment_status === 'authorized')) throw new Error('hold not authorized: ' + w.statusCode + ' ' + JSON.stringify(st));
    return { id, piId, chargeId, total };
  }
  const setPi = (h, status) => { spy.fixtures.paymentIntents[h.piId] = { ...spy.fixtures.paymentIntents[h.piId], status, amount_received: status === 'succeeded' ? h.total : 0 }; };
  const approveHoldBrand = () => db(`brands?id=eq.${holdBrandId}`, { method: 'PATCH', body: JSON.stringify({ coi_verification_status: 'approved', default_coi_url: 'brands/hold.pdf', default_coi_expires: dayP(400) }) });
  const unapproveHoldBrand = () => db(`brands?id=eq.${holdBrandId}`, { method: 'PATCH', body: JSON.stringify({ coi_verification_status: 'pending', default_coi_url: null, default_coi_expires: null }) });
  const h1 = await heldBooking(10, '9:00'), h2 = await heldBooking(10, '10:00'), h3 = await heldBooking(10, '11:00'), h4 = await heldBooking(10, '12:00');
  await unapproveHoldBrand();   // bookings exist as holds; approve the certificate so confirms may capture
  await approveHoldBrand();
  ok('four authorized holds exist (held, authorized, uncaptured)', (await Promise.all([h1, h2, h3, h4].map(h => row(h.id)))).every(s => s.status === 'held' && s.payment_status === 'authorized'));
  {
    // order 1: capture first, then cancel
    setPi(h1, 'succeeded');
    const r0 = stripeRefundCalls();
    const k = await confirm(h1.id);
    const s1 = await row(h1.id);
    ok('order 1: the confirm captured the hold: confirmed and paid', k.statusCode === 200 && s1.status === 'confirmed' && s1.payment_status === 'paid', `${k.statusCode} ${JSON.stringify(k.body).slice(0, 160)} ${JSON.stringify(s1)}`);
    const c = await cancel(h1.id);
    const s2 = await row(h1.id); const al = await allocOf(h1.id);
    ok('order 1: the cancel that follows is a PAID cancellation: decision recorded (outside the window), refund submitted, allocation refunded in full, no money stranded', c.statusCode === 200 && c.body.refund_status === 'submitted' && (await decisionRows(h1.id)).length === 1 && stripeRefundCalls() === r0 + 1 && s2.status === 'cancelled' && Number(al.refunded_amount) === Number(al.customer_amount), `${c.statusCode} ${JSON.stringify(c.body).slice(0, 160)}`);
    // order 2: release first, then confirm
    setPi(h2, 'canceled');
    const r1 = stripeRefundCalls();
    const c2 = await cancel(h2.id);
    const t1 = await row(h2.id);
    ok('order 2: the cancel released the hold (auth_released), cancelled, nothing charged, no refund, no decision row (a release is not a policy cancellation)', c2.statusCode === 200 && c2.body.refund_status === 'auth_released' && t1.status === 'cancelled' && t1.payment_status !== 'paid' && stripeRefundCalls() === r1 && (await decisionRows(h2.id)).length === 0, `${c2.statusCode} ${JSON.stringify(c2.body).slice(0, 160)} ${JSON.stringify(t1)}`);
    const k2 = await confirm(h2.id);
    const t2 = await row(h2.id);
    ok('order 2: the confirm that follows is refused before any capture; the booking stays cancelled and unpaid', k2.statusCode === 409 && t2.status === 'cancelled' && t2.payment_status !== 'paid' && !spy.calls.stripe.slice(-3).some(x => /\/capture$/.test(x.url) && x.url.includes(h2.piId)), `${k2.statusCode} ${JSON.stringify(k2.body).slice(0, 120)}`);
    // order 3: the capture landed at Stripe (a concurrent confirm, or the webhook) before the ledger saw it; the cancel arrives
    setPi(h3, 'succeeded');
    const r2 = stripeRefundCalls();
    const c3 = await cancel(h3.id);
    const u1 = await row(h3.id);
    ok('order 3: the release path finds the hold CAPTURED: 409 hold_captured, the ledger converged to paid, nothing released', c3.statusCode === 409 && c3.body.error === 'hold_captured' && u1.payment_status === 'paid' && stripeRefundCalls() === r2, `${c3.statusCode} ${JSON.stringify(c3.body).slice(0, 160)} ${JSON.stringify(u1)}`);
    const c3b = await cancel(h3.id);
    const u2 = await row(h3.id); const al3 = await allocOf(h3.id);
    ok('order 3: the retried cancel is a PAID cancellation: decision recorded, refund submitted, allocation refunded in full (captured money never stays on a cancelled booking without its refund)', c3b.statusCode === 200 && c3b.body.refund_status === 'submitted' && u2.status === 'cancelled' && stripeRefundCalls() === r2 + 1 && Number(al3.refunded_amount) === Number(al3.customer_amount) && (await decisionRows(h3.id)).length === 1, `${c3b.statusCode} ${JSON.stringify(c3b.body).slice(0, 160)} ${JSON.stringify({ u2, al3 })}`);
    // both at once
    setPi(h4, 'succeeded');
    const r3 = stripeRefundCalls();
    const [k4, c4] = await Promise.all([confirm(h4.id), cancel(h4.id)]);
    const v = await row(h4.id); const al4 = await allocOf(h4.id); const rq4 = await requestsOf(h4.id);
    console.log('  note concurrent outcomes: confirm ' + k4.statusCode + ' ' + JSON.stringify(k4.body).slice(0, 120) + ' | cancel ' + c4.statusCode + ' ' + JSON.stringify(c4.body).slice(0, 120));
    const chargedAndKept = v.payment_status === 'paid' && ['confirmed', 'held', 'pending'].includes(v.status) && Number(al4.refunded_amount) === 0;
    const cancelledAndSettled = v.status === 'cancelled' && (Number(al4.refunded_amount) === Number(al4.customer_amount) || rq4.length === 1);
    ok('both at once: never charged-and-released; the booking is either paid and live, or cancelled with its refund obligation recorded', (chargedAndKept || cancelledAndSettled) && !(v.status === 'cancelled' && v.payment_status === 'paid' && rq4.length === 0), JSON.stringify({ v, al4, rq4: rq4.length, refunds: stripeRefundCalls() - r3 }));
  }

  console.log('\nR3-4 an abandoned recorded cancellation is made visible and the retry closes it');
  {
    const a = await seed({ days: 14 });
    const live = await row(a.id);
    const rec = await rpc('booking_cancellation_record', { p_booking_id: a.id, p_retailer_id: retailerId, p_decision: { category: 'store_caused', requested_at: new Date().toISOString(), actor: staffEmail, cancellation_mode: 'refundable', cutoff_hours: 72, start_source: 'computed', hours_before_demo: 300, refund: true, status: 'auto', reason: 'store_caused' }, p_expect: { schedule_revision: live.schedule_revision, payment_status: 'paid' } });
    ok('a decision is recorded and the barrier set (the cancellation then never lands)', rec && rec.outcome === 'recorded' && (await row(a.id)).cancellation_pending_at != null);
    const wk0 = await worker();
    ok('a fresh barrier is not flagged yet (inside the grace window)', wk0.statusCode === 200 && wk0.body.abandoned_cases_opened === 0, JSON.stringify(wk0.body && { opened: wk0.body.abandoned_cases_opened }));
    await db(`bookings?id=eq.${a.id}`, { method: 'PATCH', body: JSON.stringify({ cancellation_pending_at: hours(-1) }) });
    const wk1 = await worker();
    const cs = await caseOf(a.id, 'cancel-abandoned:');
    ok('after the grace window the worker opens ONE deduplicated case naming the next step', wk1.statusCode === 200 && wk1.body.abandoned_cases_opened === 1 && cs && cs.reason === 'cancellation_pending_abandoned' && /retry the cancellation/.test(String(cs.details && cs.details.next_step)), JSON.stringify({ wk: wk1.body && { opened: wk1.body.abandoned_cases_opened }, cs }));
    if (cs) track('reconciliation_cases', cs.id);
    const wk2 = await worker();
    ok('a second run does not open another', wk2.statusCode === 200 && wk2.body.abandoned_cases_opened === 0);
    ok('meanwhile a confirm/materialize on the booking is refused (cancellation_pending)', (await rpc('booking_transition', { p_booking_id: a.id, p_retailer_id: retailerId, p_action: 'materialize', p_fields: {}, p_demo_fee: 30 })).reason === 'cancellation_pending');
    const c = await cancel(a.id, { category: 'store_caused' });
    const after = await row(a.id); const cs2 = await caseOf(a.id, 'cancel-abandoned:');
    ok('the operator retries the cancel: 200 with the recorded decision replayed, cancelled, barrier cleared, the abandoned case resolved by the route', c.statusCode === 200 && c.body.decision_replayed === true && after.status === 'cancelled' && after.cancellation_pending_at == null && cs2 && cs2.status === 'resolved', `${c.statusCode} ${JSON.stringify(c.body).slice(0, 120)} ${JSON.stringify(cs2)}`);
  }

  console.log('\nR4-1 compound failures: the money step is judged on the refund request, whatever the state label');
  const g3 = await paidGroup([[1, '13:00'], [1, '14:00'], [2, '13:00'], [2, '14:00']]);
  for (const id of g3.ids) await pendingManual(id);
  {
    const [J, K, L, M] = g3.ids;
    // J: provider timeout, then the row is left exactly as Codex's probe found it: linked request, state failed, no submitted mark, case step done
    spy.faults.push({ url: '/refunds', method: 'POST', status: 500, message: 'injected_stripe_timeout', once: true });
    const j1 = await review({ action: 'grant', booking_id: J, reason: 'goodwill' });
    const rqJ = await requestsOf(J);
    ok('J: provider timeout: refund_pending with the request parked failed_retryable', j1.statusCode === 200 && j1.body.refund_status === 'refund_pending' && rqJ.length === 1 && rqJ[0].status === 'failed_retryable', `${j1.statusCode} ${JSON.stringify(j1.body).slice(0, 160)}`);
    await db(`booking_cancellation_resolutions?booking_id=eq.${J}`, { method: 'PATCH', body: JSON.stringify({ state: 'failed', last_error: 'notice: simulated later failure', updated_at: new Date(Date.now() - 5 * 60e3).toISOString() }) });
    const m0 = spy.calls.resend.length;
    const wk = await worker();
    const rqJ2 = await requestsOf(J); const resJ = await resolutionRows(J);
    ok('J: the refund worker resubmits the parked request; the resolution sweep re-reads it despite the failed label and marks it submitted; completed; still one request', wk.statusCode === 200 && rqJ2.length === 1 && ['submitted', 'pending', 'succeeded'].includes(rqJ2[0].status) && resJ[0].state === 'completed' && !!resJ[0].refund_submitted_at && resJ[0].refund_request_id === rqJ2[0].id, JSON.stringify({ wk: wk.body && { resubmitted: wk.body.resubmitted, resolutions: [wk.body.resolutions_checked, wk.body.resolutions_completed, wk.body.resolutions_step_failed] }, rq: rqJ2, res: resJ[0] && { state: resJ[0].state, submitted: resJ[0].refund_submitted_at } }));
    await notices();
    ok('J: exactly one notice event and one accepted notice to the owner, no second refund', (await deliveriesOf(J)).length === 1 && mailsSince(m0, /Refund approved/).length === 1 && stripeRefundCalls() >= 1, JSON.stringify((await deliveriesOf(J)).map(d => d.status)));
    // K: the request is parked for operator review: the resolution is escalated, visible, and finishes once the operator fixes the request
    spy.faults.push({ url: '/refunds', method: 'POST', status: 500, message: 'injected_stripe_timeout', once: true });
    const k1 = await review({ action: 'grant', booking_id: K, reason: 'goodwill' });
    const rqK = (await requestsOf(K))[0];
    ok('K: refund_pending after the timeout', k1.statusCode === 200 && k1.body.refund_status === 'refund_pending' && !!rqK);
    await db(`refund_requests?id=eq.${rqK.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'requires_review' }) });   // the ledger parked it (as park_refund_for_review does)
    await db(`booking_cancellation_resolutions?booking_id=eq.${K}`, { method: 'PATCH', body: JSON.stringify({ updated_at: new Date(Date.now() - 5 * 60e3).toISOString() }) });
    const wkK = await worker();
    const resK = await resolutionRows(K); const csK = await caseOf(K, 'resolution-failed:');
    ok('K: the sweep escalates: one deduplicated case (resolution_refund_request_parked, the request and the recovery action in its details), the resolution linked and failed, the run reported as not clean', wkK.statusCode === 500 && wkK.body.resolutions_escalated === 1 && csK && csK.reason === 'resolution_refund_request_parked' && csK.details && csK.details.refund_request_id === rqK.id && /refund review/.test(String(csK.details.recovery)) && resK[0].escalated_case_id === csK.id && resK[0].state === 'failed' && !!resK[0].escalated_at, JSON.stringify({ wk: wkK.statusCode, body: wkK.body && { escalated: wkK.body.resolutions_escalated, first_error: wkK.body.first_error }, csK, res: resK[0] && { state: resK[0].state, esc: resK[0].escalated_case_id } }));
    if (csK) track('reconciliation_cases', csK.id);
    const lookK = await review({ action: 'cancellation', booking_id: K });
    ok('K: action=cancellation reports refund_status needs_review', lookK.statusCode === 200 && lookK.body.refund_status === 'needs_review', JSON.stringify(lookK.body && lookK.body.refund_status));
    const wkK2 = await worker();
    ok('K: an escalated resolution is no longer retried automatically', wkK2.body.resolutions_checked === 0, JSON.stringify(wkK2.body && { checked: wkK2.body.resolutions_checked }));
    await db(`refund_requests?id=eq.${rqK.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'submitted' }) });   // the operator adopted the refund in refund review
    const k2 = await review({ action: 'grant', booking_id: K, reason: 'finish after review' });
    const resK2 = await resolutionRows(K); const csK2 = await caseOf(K, 'resolution-failed:');
    ok('K: the operator\'s grant finishes it: existing, refund_status submitted, completed, the escalation case resolved', k2.statusCode === 200 && k2.body.existing === true && k2.body.refund_status === 'submitted' && resK2[0].state === 'completed' && csK2.status === 'resolved', `${k2.statusCode} ${JSON.stringify(k2.body).slice(0, 160)} ${JSON.stringify(csK2)}`);
    // L: the RPC refuses marks that disagree with the request
    spy.faults.push({ url: '/refunds', method: 'POST', status: 500, message: 'injected_stripe_timeout', once: true });
    await review({ action: 'grant', booking_id: L, reason: 'goodwill' });
    const rqL = (await requestsOf(L))[0];
    const badSub = await rpc('booking_cancellation_progress', { p_booking_id: L, p_retailer_id: retailerId, p_mark: 'refund_submitted', p_refund_request_id: rqL.id });
    ok('L: refund_submitted on a failed_retryable request is refused (refund_request_not_submitted)', badSub && badSub.outcome === 'refund_request_not_submitted' && badSub.request_status === 'failed_retryable', JSON.stringify(badSub).slice(0, 160));
    const foreign = await rpc('booking_cancellation_progress', { p_booking_id: L, p_retailer_id: retailerId, p_mark: 'refund_submitted', p_refund_request_id: rqJ2[0].id });
    ok('L: another booking\'s request is refused (refund_request_mismatch)', foreign && foreign.outcome === 'refund_request_mismatch', JSON.stringify(foreign).slice(0, 120));
    await db(`refund_requests?id=eq.${rqL.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'requires_review' }) });
    const term = await rpc('booking_cancellation_progress', { p_booking_id: L, p_retailer_id: retailerId, p_mark: 'refund_pending', p_refund_request_id: rqL.id });
    ok('L: refund_pending on a parked request is refused (refund_request_terminal)', term && term.outcome === 'refund_request_terminal', JSON.stringify(term).slice(0, 120));
    await db(`refund_requests?id=eq.${rqL.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'failed_retryable' }) });
    ok('L: the resolution still shows no submitted mark (nothing was accepted)', !(await resolutionRows(L))[0].refund_submitted_at);
    // M: the attempt cap is reached: an escalation case is written before the work leaves automatic retries; a case-write failure keeps it retryable
    spy.faults.push({ url: '/refunds', method: 'POST', status: 500, message: 'injected_stripe_timeout', once: true });
    await review({ action: 'grant', booking_id: M, reason: 'goodwill' });
    await db(`booking_cancellation_resolutions?booking_id=eq.${M}`, { method: 'PATCH', body: JSON.stringify({ attempts: 21, state: 'failed', last_error: 'case_closed: simulated', updated_at: new Date(Date.now() - 5 * 60e3).toISOString() }) });
    spy.faults.push({ url: '/rpc/_open_case', method: 'POST', status: 500, message: 'injected_case_service_down', once: true });
    const wkM1 = await worker();
    const resM1 = await resolutionRows(M);
    ok('M: the escalation case could not be written: the run is reported failed and the resolution stays selectable (not escalated)', wkM1.statusCode === 500 && (wkM1.body.resolutions_failed || 0) >= 1 && resM1[0].escalated_at == null, JSON.stringify({ wk: wkM1.statusCode, body: wkM1.body && { failed: wkM1.body.resolutions_failed, first_error: wkM1.body.first_error } }));
    await db(`booking_cancellation_resolutions?booking_id=eq.${M}`, { method: 'PATCH', body: JSON.stringify({ updated_at: new Date(Date.now() - 5 * 60e3).toISOString() }) });
    const wkM2 = await worker();
    const resM2 = await resolutionRows(M); const csM = await caseOf(M, 'resolution-failed:');
    ok('M: the next run writes the case (resolution_retry_exhausted, attempts recorded) and links it; the row leaves automatic retries', wkM2.body.resolutions_escalated === 1 && csM && csM.reason === 'resolution_retry_exhausted' && Number(csM.details && csM.details.attempts) >= 21 && resM2[0].escalated_case_id === csM.id, JSON.stringify({ wk: wkM2.body && { escalated: wkM2.body.resolutions_escalated }, csM: csM && { reason: csM.reason, attempts: csM.details && csM.details.attempts } }));
    if (csM) track('reconciliation_cases', csM.id);
    const wkM3 = await worker();
    ok('M: a further run does not pick it up again', wkM3.body.resolutions_checked === 0);
    const csJ = await caseOf(J, 'resolution-failed:'); const csL = await caseOf(L, 'resolution-failed:');
    if (csJ) track('reconciliation_cases', csJ.id); if (csL) track('reconciliation_cases', csL.id);
  }

  console.log('\nR4-2 abandoned recorded cancellations: discovery beyond one batch, closure in batches');
  {
    const ids = [];
    for (let i = 0; i < 27; i++) {
      const bk = await seed({ days: 30 + i, time: '9:00' });
      const live = await row(bk.id);
      const rec = await rpc('booking_cancellation_record', { p_booking_id: bk.id, p_retailer_id: retailerId, p_decision: { category: 'store_caused', requested_at: new Date().toISOString(), actor: staffEmail, cancellation_mode: 'refundable', cutoff_hours: 72, start_source: 'computed', hours_before_demo: 500, refund: true, status: 'auto', reason: 'store_caused' }, p_expect: { schedule_revision: live.schedule_revision, payment_status: 'paid' } });
      if (!rec || rec.outcome !== 'recorded') throw new Error('record seed ' + JSON.stringify(rec).slice(0, 120));
      ids.push(bk.id);
    }
    await db(`bookings?id=in.(${ids.join(',')})`, { method: 'PATCH', body: JSON.stringify({ cancellation_pending_at: hours(-2) }) });
    const w1 = await worker(); const w2 = await worker(); const w3 = await worker();
    const cases = (await db(`reconciliation_cases?dedupe_key=in.(${ids.map(id => '"cancel-abandoned:' + id + '"').join(',')})&select=dedupe_key,status`)).body || [];
    ok('27 abandoned barriers: the first run reports 25, the second the remaining 2, the third none; every one has exactly one case', w1.body.abandoned_cases_opened === 25 && w2.body.abandoned_cases_opened === 2 && w3.body.abandoned_cases_opened === 0 && cases.length === 27, JSON.stringify({ a: w1.body && w1.body.abandoned_cases_opened, b: w2.body && w2.body.abandoned_cases_opened, c: w3.body && w3.body.abandoned_cases_opened, cases: cases.length }));
    for (const c of cases) { const id = String(c.dedupe_key).slice('cancel-abandoned:'.length); const cs = await caseOf(id, 'cancel-abandoned:'); if (cs) track('reconciliation_cases', cs.id); }
    // twelve of them land (the barrier clears); closure runs in batches of five
    await db(`bookings?id=in.(${ids.slice(0, 12).join(',')})`, { method: 'PATCH', body: JSON.stringify({ cancellation_pending_at: null }) });
    const n1 = await rpc('cancellation_abandoned_close', { p_limit: 5 }), n2 = await rpc('cancellation_abandoned_close', { p_limit: 5 }), n3 = await rpc('cancellation_abandoned_close', { p_limit: 5 }), n4 = await rpc('cancellation_abandoned_close', { p_limit: 5 });
    const resolvedN = (await db(`reconciliation_cases?dedupe_key=in.(${ids.map(id => '"cancel-abandoned:' + id + '"').join(',')})&status=eq.resolved&select=id`)).body || [];
    ok('closure in batches of five: 5, 5, 2, 0; twelve cases resolved, fifteen still open', Number(n1) === 5 && Number(n2) === 5 && Number(n3) === 2 && Number(n4) === 0 && resolvedN.length === 12, JSON.stringify({ n1, n2, n3, n4, resolved: resolvedN.length }));
    const w4 = await worker();
    ok('the worker run after that reports nothing new to open or close', w4.body.abandoned_cases_opened === 0 && w4.body.abandoned_cases_resolved === 0, JSON.stringify(w4.body && { opened: w4.body.abandoned_cases_opened, resolved: w4.body.abandoned_cases_resolved }));
  }

  console.log('\nR4-3 the live recipient contract for the resolution notice');
  {
    // a booking made by a designated booker whose membership is revoked before the notice goes out
    const bookerEmail = `booker-${slug}@fixture.test`;
    const member = one(await db('brand_members', { method: 'POST', body: JSON.stringify({ brand_id: brandId, email: bookerEmail, name: 'Rev Booker', role: 'booker', status: 'accepted', accepted_at: new Date().toISOString() }) }));
    track('brand_members', member && member.id);
    const nb = await seed({ days: 1, time: '15:00' });
    await db(`bookings?id=eq.${nb.id}`, { method: 'PATCH', body: JSON.stringify({ contact_email: bookerEmail, booked_by_member_id: member.id, booked_by_email: bookerEmail, booked_by_name: 'Rev Booker' }) });
    const c = await cancel(nb.id);
    ok('fixture: the booker\'s booking is cancelled inside the window (pending_manual)', c.statusCode === 200 && c.body.refund_status === 'pending_manual', `${c.statusCode}`);
    await db(`brand_members?id=eq.${member.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'revoked' }) });
    const m0 = spy.calls.resend.length;
    const d = await review({ action: 'deny', booking_id: nb.id, reason: 'kept per policy' });
    await notices();
    const dls = await deliveriesOf(nb.id); const sent = spy.calls.resend.slice(m0).filter(m => /Refund decision/.test(String(m.subject || '')));
    ok('the notice goes to the brand account owner only; the revoked booker (the booking\'s contact email) receives nothing', d.statusCode === 200 && dls.length === 1 && dls[0].recipient_email === brandEmail && ['sent', 'accepted'].includes(dls[0].status) && sent.length === 1 && [].concat(sent[0].to).every(t => String(t).toLowerCase() !== bookerEmail), JSON.stringify({ dls: dls.map(x => ({ to: x.recipient_email, status: x.status })), sentTo: sent.map(m => m.to) }));
    // an owner-made booking: one notice to the owner; a brand lookup outage at dispatch keeps the delivery recoverable
    const ob = await seed({ days: 2, time: '15:00' });
    const c2 = await cancel(ob.id);
    ok('fixture: an owner-made booking cancelled inside the window', c2.statusCode === 200 && c2.body.refund_status === 'pending_manual');
    const m1 = spy.calls.resend.length;
    await review({ action: 'deny', booking_id: ob.id, reason: 'kept per policy' });
    await fanOutEvents(b, { now: new Date() });
    spy.faults.push({ url: 'brands?id=eq.', method: 'GET', status: 500, message: 'injected_lookup_outage', once: true });
    await dispatchDue(b, { now: new Date() });
    const dlo1 = await deliveriesOf(ob.id);
    ok('a recipient lookup outage at dispatch leaves the delivery unsent and retryable (not marked delivered)', dlo1.length === 1 && !['sent', 'accepted'].includes(dlo1[0].status) && spy.calls.resend.length === m1, JSON.stringify(dlo1.map(x => ({ status: x.status, attempts: x.attempts }))));
    await dispatchDue(b, { now: new Date(Date.now() + 6 * 60e3) });   // past the claim lease left by the failed attempt
    const dlo2 = await deliveriesOf(ob.id);
    ok('the retry delivers once to the owner', dlo2.length === 1 && ['sent', 'accepted'].includes(dlo2[0].status) && dlo2[0].recipient_email === brandEmail && spy.calls.resend.slice(m1).filter(m => /Refund decision/.test(String(m.subject || ''))).length === 1, JSON.stringify(dlo2.map(x => ({ to: x.recipient_email, status: x.status }))));
  }

  console.log('\nR5-1 an authorized replacement of a parked refund request is followed by the resolution');
  const g4 = await paidGroup([[1, '15:00'], [1, '16:00'], [2, '15:00'], [2, '16:00']]);
  for (const id of g4.ids) await pendingManual(id);
  const replace = (id) => review({ action: 'replace', op_key: id + ':review_grant' });
  const parkByWorker = async (id) => {
    // the real parking path: the request is one attempt from the refund worker's cap and the provider keeps failing
    const rq = (await requestsOf(id)).find(x => !['superseded', 'canceled', 'requires_review'].includes(x.status));   // the LIVE request (a replaced one is superseded)
    if (!rq) throw new Error('parkByWorker: no live request for ' + id);
    await db(`refund_requests?id=eq.${rq.id}`, { method: 'PATCH', body: JSON.stringify({ attempts: 7, next_attempt_at: hours(-1) }) });
    spy.faults.push({ url: '/refunds', method: 'POST', status: 500, message: 'injected_provider_down' });
    await db(`booking_cancellation_resolutions?booking_id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ updated_at: new Date(Date.now() - 5 * 60e3).toISOString() }) });
    const wk = await worker();
    spy.faults.length = 0;
    return { wk, rq: (await requestsOf(id)).find(x => x.id === rq.id) };
  };
  {
    const [N, O, P, Q] = g4.ids;
    // N: parked -> replaced through the supported route -> pending -> submitted -> completed; escalation closed; one notice
    spy.faults.push({ url: '/refunds', method: 'POST', status: 500, message: 'injected_stripe_timeout', once: true });
    const n1 = await review({ action: 'grant', booking_id: N, reason: 'goodwill' });
    ok('N: grant parked by a provider timeout (refund_pending)', n1.statusCode === 200 && n1.body.refund_status === 'refund_pending');
    const parkedN = await parkByWorker(N);
    const resN1 = await resolutionRows(N); const csN = await caseOf(N, 'resolution-failed:');
    ok('N: the refund worker parks the request for review at its cap (requires_review, the real park path) and the resolution sweep escalates it in the same run (active escalation, Needs review)', parkedN.rq && parkedN.rq.status === 'requires_review' && resN1[0].escalated_at && !resN1[0].escalation_cleared_at && csN && csN.reason === 'resolution_refund_request_parked', JSON.stringify({ rq: parkedN.rq && parkedN.rq.status, wk: parkedN.wk.body && { manual: parkedN.wk.body.manual, escalated: parkedN.wk.body.resolutions_escalated }, cs: csN && csN.reason }));
    if (csN) track('reconciliation_cases', csN.id);
    const r0 = stripeRefundCalls(); const m0 = spy.calls.resend.length;
    const rp = await replace(N);
    const reqsN = await requestsOf(N); const resN2 = await resolutionRows(N); const alN = await allocOf(N);
    const oldN = reqsN.find(x => x.id === parkedN.rq.id), newN = reqsN.find(x => x.id !== parkedN.rq.id);
    ok('N: the operator replaces through the supported route: the old request superseded, a new reserved request under the same operation, and the resolution relinked to it at once (refund_pending, no submitted mark, escalation re-armed)', rp.statusCode === 200 && rp.body.outcome === 'replacement_created' && rp.body.resolution_relink === 'relinked' && oldN && oldN.status === 'superseded' && newN && newN.status === 'reserved' && resN2[0].refund_request_id === newN.id && resN2[0].state === 'refund_pending' && resN2[0].refund_submitted_at == null && !!resN2[0].escalation_cleared_at && Number(alN.reserved_refund_amount) === Number(alN.customer_amount), `${rp.statusCode} ${JSON.stringify(rp.body).slice(0, 200)} ${JSON.stringify({ old: oldN && oldN.status, nw: newN && newN.status, res: resN2[0] && { state: resN2[0].state, link: resN2[0].refund_request_id === (newN && newN.id), cleared: !!resN2[0].escalation_cleared_at }, alN })}`);
    const lookN = await review({ action: 'cancellation', booking_id: N });
    ok('N: action=cancellation now says refund_pending, not needs_review', lookN.body.refund_status === 'refund_pending', JSON.stringify(lookN.body && lookN.body.refund_status));
    ok('N: no provider call was made by the relink itself', stripeRefundCalls() === r0);
    await db(`booking_cancellation_resolutions?booking_id=eq.${N}`, { method: 'PATCH', body: JSON.stringify({ updated_at: new Date(Date.now() - 5 * 60e3).toISOString() }) });
    const wkN = await worker();
    const reqsN2 = await requestsOf(N); const resN3 = await resolutionRows(N); const alN2 = await allocOf(N); const csN2 = await caseOf(N, 'resolution-failed:');
    const newN2 = reqsN2.find(x => x.id === newN.id);
    ok('N: the refund worker submits the successor (one provider call) and the resolution completes on it: submitted mark, completed, the escalation case resolved, exactly one obligation on the allocation', wkN.statusCode === 200 && newN2 && ['submitted', 'pending', 'succeeded'].includes(newN2.status) && stripeRefundCalls() === r0 + 1 && resN3[0].state === 'completed' && resN3[0].refund_request_id === newN.id && !!resN3[0].refund_submitted_at && csN2.status === 'resolved' && Number(alN2.refunded_amount) + Number(alN2.reserved_refund_amount || 0) === Number(alN2.customer_amount) && reqsN2.length === 2, JSON.stringify({ wk: wkN.statusCode, body: wkN.body && { resubmitted: wkN.body.resubmitted, claimed: wkN.body.claimed, completed: wkN.body.resolutions_completed }, newN2: newN2 && newN2.status, res: resN3[0] && { state: resN3[0].state, submitted: !!resN3[0].refund_submitted_at }, cs: csN2 && csN2.status, alN2 }));
    await notices();
    ok('N: one notice event, one accepted notice to the owner', (await deliveriesOf(N)).length === 1 && (await deliveriesOf(N))[0].status === 'accepted' && mailsSince(m0, /Refund approved/).length === 1, JSON.stringify((await deliveriesOf(N)).map(d => d.status)));
    // O: a repeated replacement chain (v1 parked, v2 parked, v3 submits) and a replay while the successor is in flight
    spy.faults.push({ url: '/refunds', method: 'POST', status: 500, message: 'injected_stripe_timeout', once: true });
    await review({ action: 'grant', booking_id: O, reason: 'goodwill' });
    await parkByWorker(O);
    const rp1 = await replace(O);
    ok('O: first replacement relinked', rp1.statusCode === 200 && rp1.body.resolution_relink === 'relinked', JSON.stringify(rp1.body).slice(0, 160));
    const v2 = (await requestsOf(O)).find(x => x.status === 'reserved');
    // the replay while v2 is still reserved: the stored decision is reported, nothing is submitted, no second mark
    const replayO = await review({ action: 'grant', booking_id: O, reason: 'again' });
    ok('O: a grant replay while the successor is in flight reports refund_pending and does not mark submitted', replayO.statusCode === 200 && replayO.body.existing === true && replayO.body.refund_status === 'refund_pending' && (await resolutionRows(O))[0].refund_submitted_at == null, JSON.stringify(replayO.body && { rs: replayO.body.refund_status, state: replayO.body.state }));
    await parkByWorker(O);   // v2 is parked as well
    const v2parked = (await requestsOf(O)).find(x => x.id === v2.id);
    const resO2 = await resolutionRows(O);
    ok('O: the parked successor escalates again (active)', v2parked.status === 'requires_review' && resO2[0].escalated_at && !resO2[0].escalation_cleared_at, JSON.stringify({ v2: v2parked.status, res: resO2[0] && { esc: !!resO2[0].escalated_at, cleared: resO2[0].escalation_cleared_at } }));
    const rp2 = await replace(O);
    const v3 = (await requestsOf(O)).find(x => x.status === 'reserved');
    ok('O: second replacement relinked to v3', rp2.statusCode === 200 && rp2.body.resolution_relink === 'relinked' && !!v3 && (await resolutionRows(O))[0].refund_request_id === v3.id, JSON.stringify(rp2.body).slice(0, 120));
    await db(`booking_cancellation_resolutions?booking_id=eq.${O}`, { method: 'PATCH', body: JSON.stringify({ updated_at: new Date(Date.now() - 5 * 60e3).toISOString() }) });
    const r1 = stripeRefundCalls();
    const wkO = await worker();
    const resO3 = await resolutionRows(O); const alO = await allocOf(O); const reqsO = await requestsOf(O);
    ok('O: v3 submits (one provider call), the resolution completes on v3; three requests in history (two superseded), one obligation', wkO.statusCode === 200 && stripeRefundCalls() === r1 + 1 && resO3[0].state === 'completed' && resO3[0].refund_request_id === v3.id && reqsO.length === 3 && reqsO.filter(x => x.status === 'superseded').length === 2 && Number(alO.refunded_amount) + Number(alO.reserved_refund_amount || 0) === Number(alO.customer_amount), JSON.stringify({ res: resO3[0] && resO3[0].state, reqs: reqsO.map(x => x.status), alO }));
    // P: two concurrent grant replays right after a replacement: one relink, consistent row
    spy.faults.push({ url: '/refunds', method: 'POST', status: 500, message: 'injected_stripe_timeout', once: true });
    await review({ action: 'grant', booking_id: P, reason: 'goodwill' });
    await parkByWorker(P);
    const [pa, pb] = await Promise.all([replace(P), review({ action: 'grant', booking_id: P, reason: 'retry' })]);
    const resP = await resolutionRows(P); const reqsP = await requestsOf(P);
    const live = reqsP.find(x => x.status !== 'superseded' && x.status !== 'requires_review');
    ok('P: a replace and a grant replay at once: the row ends linked to the live successor (or still parked if the replay ran first), never to a superseded request, and no provider call from the helper', pa.statusCode === 200 && pb.statusCode === 200 && (!live || resP[0].refund_request_id === live.id || resP[0].refund_request_id === reqsP.find(x => x.status === 'requires_review')?.id) && !reqsP.some(x => x.status === 'superseded' && x.id === resP[0].refund_request_id), JSON.stringify({ pa: pa.body && { o: pa.body.outcome, rl: pa.body.resolution_relink }, pb: pb.body && { rs: pb.body.refund_status, st: pb.body.state }, link: resP[0] && resP[0].refund_request_id, reqs: reqsP.map(x => [x.id.slice(0, 8), x.status]) }));
    const wkP = await worker();
    const resP2 = await resolutionRows(P);
    const reqsP2 = await requestsOf(P);
    ok('P: the worker converges it (relink if still needed, submit, complete)', resP2[0].state === 'completed' && !!resP2[0].refund_submitted_at, JSON.stringify({ wk: wkP.statusCode, body: wkP.body && { claimed: wkP.body.claimed, resubmitted: wkP.body.resubmitted, completed: wkP.body.resolutions_completed, escalated: wkP.body.resolutions_escalated, first_error: wkP.body.first_error }, res: resP2[0] && { state: resP2[0].state, link: resP2[0].refund_request_id && resP2[0].refund_request_id.slice(0, 8), last_error: resP2[0].last_error, esc: resP2[0].escalated_at, cleared: resP2[0].escalation_cleared_at }, reqs: reqsP2.map(x => [x.id.slice(0, 8), x.status]) }));
    // Q: refusals of the relink itself
    spy.faults.push({ url: '/refunds', method: 'POST', status: 500, message: 'injected_stripe_timeout', once: true });
    await review({ action: 'grant', booking_id: Q, reason: 'goodwill' });
    const notSup = await rpc('booking_cancellation_relink', { p_booking_id: Q, p_retailer_id: retailerId });
    ok('Q: relink on a request that is not superseded is refused (not_superseded)', notSup && notSup.outcome === 'not_superseded', JSON.stringify(notSup).slice(0, 120));
    const rqQ = (await requestsOf(Q))[0];
    await db(`refund_requests?id=eq.${rqQ.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'superseded' }) });   // superseded with NO authorized replacement behind it
    const noSucc = await rpc('booking_cancellation_relink', { p_booking_id: Q, p_retailer_id: retailerId });
    ok('Q: a superseded link with no authorized successor is refused (no_successor); the row is not relinked', noSucc && noSucc.outcome === 'no_successor' && (await resolutionRows(Q))[0].refund_request_id === rqQ.id, JSON.stringify(noSucc).slice(0, 120));
    const foreignQ = await rpc('booking_cancellation_relink', { p_booking_id: Q, p_retailer_id: otherRetailerIdForQ });
    ok('Q: another retailer cannot relink it (forbidden)', foreignQ && foreignQ.outcome === 'forbidden', JSON.stringify(foreignQ).slice(0, 100));
    await db(`booking_cancellation_resolutions?booking_id=eq.${Q}`, { method: 'PATCH', body: JSON.stringify({ updated_at: new Date(Date.now() - 5 * 60e3).toISOString() }) });
    const wkQ = await worker();
    const resQ = await resolutionRows(Q); const csQ = await caseOf(Q, 'resolution-failed:');
    ok('Q: the sweep escalates a superseded link without a successor (visible, not silently stuck)', resQ[0].escalated_at && csQ && /no authorized successor/.test(String(csQ.details && csQ.details.detail)), JSON.stringify({ wk: wkQ.statusCode, cs: csQ && csQ.details && csQ.details.detail }));
    await db(`refund_requests?id=eq.${rqQ.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'failed_retryable' }) });
    for (const id of [O, P, Q]) { const c = await caseOf(id, 'resolution-failed:'); if (c) track('reconciliation_cases', c.id); }
  }


  console.log('\nR6-1 finalization after a relink that finds an already-submitted successor (Codex rev7: the successor state is staged BEFORE the relink under test)');
  const g5 = await paidGroup([[1, '17:00'], [1, '18:00'], [2, '17:00'], [2, '18:00']]);
  for (const id of g5.ids) await pendingManual(id);
  {
    const [R, S, T, U] = g5.ids;
    // Arrange: grant parked by a timeout, driven to the worker's cap (parked for review, escalated), replaced through the
    // supported route with the immediate relink DOWN (deferred), then the refund worker submits the successor while the
    // resolution sweeps are quiesced, so the resolution still points at the superseded request with both non-money marks
    // present. The successor's provider-side state word is then staged (succeeded = the spy's own answer; submitted and
    // pending = set on the request row), and only THEN the relink/finalization under test runs (the worker's sweep).
    const runCase = async (id, successorStatus) => {
      spy.faults.push({ url: '/refunds', method: 'POST', status: 500, message: 'injected_stripe_timeout', once: true });
      const g = await review({ action: 'grant', booking_id: id, reason: 'goodwill' });
      if (!(g.statusCode === 200 && g.body.refund_status === 'refund_pending')) throw new Error('grant ' + g.statusCode + ' ' + JSON.stringify(g.body).slice(0, 120));
      const r0 = await resolutionRows(id);
      if (!(r0[0].case_closed_at && r0[0].brand_notified_at)) throw new Error('marks missing');
      await parkByWorker(id);
      if (!(await resolutionRows(id))[0].escalated_at) throw new Error('not escalated');
      spy.faults.push({ url: '/rpc/booking_cancellation_relink', method: 'POST', status: 500, message: 'injected_relink_outage', once: true });
      const rp = await replace(id);
      const r2 = await resolutionRows(id);
      const oldId = r2[0].refund_request_id;
      const okReplace = rp.statusCode === 200 && rp.body.outcome === 'replacement_created' && rp.body.resolution_relink === 'deferred_to_worker' && r2[0].refund_request_id === oldId;
      const r00 = stripeRefundCalls();
      ENV.CANCELLATION_RESOLUTION_QUIESCE = 'true';   // the refund loop runs, the resolution sweeps do not
      const wk0 = await worker();
      ENV.CANCELLATION_RESOLUTION_QUIESCE = 'false';
      const succ = (await requestsOf(id)).find(x => x.id !== oldId);
      const rBefore = (await resolutionRows(id))[0];
      const staged = !!succ && ['submitted', 'pending', 'succeeded'].includes(succ.status) && rBefore.refund_request_id === oldId && rBefore.state !== 'completed' && stripeRefundCalls() === r00 + 1;
      if (successorStatus !== 'succeeded' && succ) await db(`refund_requests?id=eq.${succ.id}`, { method: 'PATCH', body: JSON.stringify({ status: successorStatus }) });
      const stagedStatus = succ ? (await requestsOf(id)).find(x => x.id === succ.id).status : null;
      // the relink and finalization under test: the resolution sweep ALONE (the actual helper, no refund loop), which admits
      // the superseded link under the active escalation; any provider call from here on would be resolution recovery's
      const callsBeforeSweep = stripeRefundCalls();
      const ur = await sweepUnfinishedResolutions(b, { limit: 25, graceSeconds: 0 });
      const r3 = (await resolutionRows(id))[0]; const cs = await caseOf(id, 'resolution-failed:');
      return { okReplace, staged, stagedStatus, wk0, ur, succ, r3, cs, calls: stripeRefundCalls() - r00, recoveryCalls: stripeRefundCalls() - callsBeforeSweep };
    };
    for (const [id, st, label] of [[R, 'succeeded', 'R'], [S, 'submitted', 'S'], [T, 'pending', 'T']]) {
      const X = await runCase(id, st);
      ok(`${label} (successor ${st}): staged first (successor submitted by the worker, resolution still on the superseded link, unfinished, both non-money marks present), then ONE resolution sweep relinks and completes: completed, linked to the successor, submitted mark, escalation case resolved, one provider call in total (the worker's submission) and NONE from resolution recovery`, X.okReplace && X.staged && X.stagedStatus === st && (X.ur.relinked || 0) >= 1 && X.ur.completed === 1 && X.r3.state === 'completed' && X.r3.refund_request_id === (X.succ && X.succ.id) && !!X.r3.refund_submitted_at && X.cs && X.cs.status === 'resolved' && X.calls === 1 && X.recoveryCalls === 0, JSON.stringify({ okReplace: X.okReplace, staged: X.staged, stagedStatus: X.stagedStatus, sweep: { relinked: X.ur.relinked, completed: X.ur.completed, escalated: X.ur.escalated, errors: X.ur.errors }, recoveryCalls: X.recoveryCalls, res: { state: X.r3.state, link: X.r3.refund_request_id === (X.succ && X.succ.id), submitted: !!X.r3.refund_submitted_at, gen: X.r3.recovery_generation }, cs: X.cs && X.cs.status, calls: X.calls }));
      const r4 = stripeRefundCalls(); const again = await sweepUnfinishedResolutions(b, { limit: 25, graceSeconds: 0 }); await notices();
      ok(`${label}: a repeated resolution sweep has no further effect: nothing checked, no provider call from recovery, one notice event and one accepted notice`, again.checked === 0 && stripeRefundCalls() === r4 && (await deliveriesOf(id)).length === 1 && (await deliveriesOf(id))[0].status === 'accepted', JSON.stringify({ checked: again.checked, deliveries: (await deliveriesOf(id)).map(d => d.status) }));
    }
    // U: an already-submitted successor must not complete a resolution that still owes the notice handoff
    spy.faults.push({ url: '/refunds', method: 'POST', status: 500, message: 'injected_stripe_timeout', once: true });
    await review({ action: 'grant', booking_id: U, reason: 'goodwill' });
    await parkByWorker(U);
    await db(`booking_cancellation_resolutions?booking_id=eq.${U}`, { method: 'PATCH', body: JSON.stringify({ brand_notified_at: null, notice_event_id: null }) });   // fixture: the handoff mark never landed
    const evU = one(await db(`notification_events?booking_id=eq.${U}&kind=eq.refund_resolution&select=id`)); if (evU) await db(`notification_events?id=eq.${evU.id}`, { method: 'DELETE' });
    const rpU = await replace(U);
    ENV.CANCELLATION_RESOLUTION_QUIESCE = 'true'; await worker(); ENV.CANCELLATION_RESOLUTION_QUIESCE = 'false';   // the successor is submitted, no sweep
    const succU = (await requestsOf(U)).find(x => x.status === 'succeeded');
    const fin = await rpc('booking_cancellation_progress', { p_booking_id: U, p_retailer_id: retailerId, p_mark: 'finalize' });
    const rU = (await resolutionRows(U))[0];
    ok('U: with the successor already succeeded, the relink (immediate, reserved at that moment) and an explicit finalize do NOT complete: the notice handoff is still owed', rpU.body.resolution_relink === 'relinked' && !!succU && fin && fin.outcome === 'marked' && rU.state !== 'completed' && rU.brand_notified_at == null, JSON.stringify({ relink: rpU.body && rpU.body.resolution_relink, succ: !!succU, fin: fin && fin.resolution && fin.resolution.state, state: rU.state, notified: rU.brand_notified_at }));
    const wkU = await worker();
    const rU2 = (await resolutionRows(U))[0];
    ok('U: the worker marks the successor submitted, hands the notice to the outbox and only then completes', wkU.statusCode === 200 && rU2.state === 'completed' && !!rU2.brand_notified_at && !!rU2.refund_submitted_at && rU2.refund_request_id === succU.id, JSON.stringify({ state: rU2.state, notified: !!rU2.brand_notified_at }));
    for (const id of g5.ids) { const c = await caseOf(id, 'resolution-failed:'); if (c) track('reconciliation_cases', c.id); }
  }

  console.log('\nR6-2 an authorized replacement restores a recovery budget; an arbitrary replay does not; the new generation still terminates');
  const g6 = await paidGroup([[1, '19:00'], [1, '20:00'], [2, '19:00'], [2, '20:00']]);
  for (const id of g6.ids) await pendingManual(id);
  {
    const [V, W, X2, Y2] = g6.ids;
    // V: at and above the cap, immediate relink works
    spy.faults.push({ url: '/refunds', method: 'POST', status: 500, message: 'injected_stripe_timeout', once: true });
    await review({ action: 'grant', booking_id: V, reason: 'goodwill' });
    await parkByWorker(V);
    await db(`booking_cancellation_resolutions?booking_id=eq.${V}`, { method: 'PATCH', body: JSON.stringify({ attempts: 26 }) });   // lifetime attempts above the cap (audit history is kept)
    const rpV = await replace(V);
    const rV = (await resolutionRows(V))[0];
    ok('V: the replacement relinks and records a new budget: attempts kept (26), baseline 26, generation 1', rpV.body.resolution_relink === 'relinked' && rV.attempts === 26 && rV.attempts_baseline === 26 && rV.recovery_generation === 1, JSON.stringify({ a: rV.attempts, b: rV.attempts_baseline, g: rV.recovery_generation }));
    await db(`booking_cancellation_resolutions?booking_id=eq.${V}`, { method: 'PATCH', body: JSON.stringify({ updated_at: new Date(Date.now() - 5 * 60e3).toISOString() }) });
    const wkV = await worker();
    const rV2 = (await resolutionRows(V))[0];
    ok('V: automatic completion without any manual replay (no re-escalation despite the lifetime count)', wkV.statusCode === 200 && rV2.state === 'completed' && wkV.body.resolutions_escalated === 0, JSON.stringify({ state: rV2.state, escalated: wkV.body && wkV.body.resolutions_escalated }));
    // W: above the cap, immediate relink down: the worker fallback adopts the successor BEFORE judging the old budget
    spy.faults.push({ url: '/refunds', method: 'POST', status: 500, message: 'injected_stripe_timeout', once: true });
    await review({ action: 'grant', booking_id: W, reason: 'goodwill' });
    await parkByWorker(W);
    await db(`booking_cancellation_resolutions?booking_id=eq.${W}`, { method: 'PATCH', body: JSON.stringify({ attempts: 26 }) });
    spy.faults.push({ url: '/rpc/booking_cancellation_relink', method: 'POST', status: 500, message: 'injected_relink_outage', once: true });
    const rpW = await replace(W);
    ok('W: the immediate relink was down (deferred)', rpW.body.resolution_relink === 'deferred_to_worker');
    await db(`booking_cancellation_resolutions?booking_id=eq.${W}`, { method: 'PATCH', body: JSON.stringify({ updated_at: new Date(Date.now() - 5 * 60e3).toISOString() }) });
    const wkW = await worker();
    const rW = (await resolutionRows(W))[0];
    ok('W: the worker adopts the successor first (relinked, new baseline), submits it and completes; no escalation from the exhausted old budget', wkW.statusCode === 200 && (wkW.body.resolutions_relinked || 0) >= 1 && rW.state === 'completed' && rW.attempts_baseline >= 26 && wkW.body.resolutions_escalated === 0, JSON.stringify({ wk: wkW.body && { relinked: wkW.body.resolutions_relinked, escalated: wkW.body.resolutions_escalated }, res: { state: rW.state, base: rW.attempts_baseline, gen: rW.recovery_generation } }));
    // X2: an arbitrary replay does not reset the budget
    spy.faults.push({ url: '/refunds', method: 'POST', status: 500, message: 'injected_stripe_timeout', once: true });
    await review({ action: 'grant', booking_id: X2, reason: 'goodwill' });
    await db(`booking_cancellation_resolutions?booking_id=eq.${X2}`, { method: 'PATCH', body: JSON.stringify({ attempts: 26, updated_at: new Date(Date.now() - 5 * 60e3).toISOString() }) });
    const replayX = await review({ action: 'grant', booking_id: X2, reason: 'again' });
    const rX2 = (await resolutionRows(X2))[0];
    ok('X: a grant replay leaves the baseline and generation untouched', replayX.statusCode === 200 && rX2.attempts_baseline === 0 && rX2.recovery_generation === 0, JSON.stringify({ b: rX2.attempts_baseline, g: rX2.recovery_generation }));
    await db(`refund_requests?id=eq.${(await requestsOf(X2))[0].id}`, { method: 'PATCH', body: JSON.stringify({ next_attempt_at: hours(1) }) });   // keep the request parked for this check
    const wkX = await worker();
    const csX = await caseOf(X2, 'resolution-failed:');
    ok('X: the exhausted budget escalates once (retry_exhausted) and the row leaves automatic retries', wkX.body.resolutions_escalated === 1 && csX && csX.reason === 'resolution_retry_exhausted', JSON.stringify({ esc: wkX.body && wkX.body.resolutions_escalated, cs: csX && csX.reason }));
    // Y2: the new generation fails repeatedly and still terminates in ONE visible escalation
    spy.faults.push({ url: '/refunds', method: 'POST', status: 500, message: 'injected_stripe_timeout', once: true });
    await review({ action: 'grant', booking_id: Y2, reason: 'goodwill' });
    await parkByWorker(Y2);
    const rpY = await replace(Y2);
    ok('Y: replaced and relinked (generation 1)', rpY.body.resolution_relink === 'relinked' && (await resolutionRows(Y2))[0].recovery_generation === 1);
    await db(`booking_cancellation_resolutions?booking_id=eq.${Y2}`, { method: 'PATCH', body: JSON.stringify({ attempts: 60, attempts_baseline: 26, updated_at: new Date(Date.now() - 5 * 60e3).toISOString() }) });   // generation 1 has used 34 attempts
    await db(`refund_requests?id=eq.${(await requestsOf(Y2)).find(x => x.status === 'reserved').id}`, { method: 'PATCH', body: JSON.stringify({ next_attempt_at: hours(1) }) });
    const wkY = await worker();
    const rY = (await resolutionRows(Y2))[0]; const csY = await caseOf(Y2, 'resolution-failed:');
    const casesY = (await db(`reconciliation_cases?dedupe_key=eq.${encodeURIComponent('resolution-failed:' + Y2)}&select=id`)).body || [];
    ok('Y: the new generation exhausts its own budget and terminates in one visible escalation (the same deduplicated case, generation named)', wkY.body.resolutions_escalated === 1 && rY.escalated_at && !rY.escalation_cleared_at && csY && casesY.length === 1 && /generation 1/.test(String(rY.last_error)), JSON.stringify({ esc: wkY.body && wkY.body.resolutions_escalated, last: rY.last_error, cases: casesY.length }));
    const wkY2 = await worker();
    ok('Y: and is not retried again', wkY2.body.resolutions_checked === 0);
    for (const id of g6.ids) { const c = await caseOf(id, 'resolution-failed:'); if (c) track('reconciliation_cases', c.id); }
  }

  console.log('\nR6-3 the rollback drill: supported operator actions only, or an explicit fail-closed result');
  {
    // fixtures (set-up writes, not part of the measured procedure): a recorded cancellation that never landed (barrier), a
    // grant whose refund is parked (unfinished resolution), a completed denial whose notice failed at first dispatch (a
    // retryable frozen delivery), and a completed denial whose notice event is still un-fanned
    const a1 = await seed({ days: 16, time: '9:00' });
    const live1 = await row(a1.id);
    await rpc('booking_cancellation_record', { p_booking_id: a1.id, p_retailer_id: retailerId, p_decision: { category: 'store_caused', requested_at: new Date().toISOString(), actor: staffEmail, cancellation_mode: 'refundable', cutoff_hours: 72, start_source: 'computed', hours_before_demo: 300, refund: true, status: 'auto', reason: 'store_caused' }, p_expect: { schedule_revision: live1.schedule_revision, payment_status: 'paid' } });
    const g7 = await paidGroup([[2, '11:00']]); await pendingManual(g7.ids[0]); const Z = g7.ids[0];
    spy.faults.push({ url: '/refunds', method: 'POST', status: 500, message: 'injected_stripe_timeout', once: true });
    await review({ action: 'grant', booking_id: Z, reason: 'goodwill' });
    const z2 = await seed({ days: 2, time: '9:00' }); await cancel(z2.id);
    await review({ action: 'deny', booking_id: z2.id, reason: 'kept per policy' });
    spy.faults.push({ url: 'api.resend.com', method: 'POST', status: 500, message: 'injected_mail_outage' });
    await notices(); spy.faults.length = 0;
    const z4 = await seed({ days: 2, time: '12:00' }); await cancel(z4.id);
    await review({ action: 'deny', booking_id: z4.id, reason: 'kept per policy' });   // its event stays un-fanned until the drain
    const outstanding = async () => ({
      events: ((await db(`notification_events?kind=eq.refund_resolution&fanned_out_at=is.null&retailer_id=eq.${retailerId}&select=id`)).body || []).length,
      deliveries: ((await db(`notification_deliveries?kind=eq.refund_resolution&retailer_id=eq.${retailerId}&status=not.in.(accepted,sent,skipped)&select=id,status`)).body || []),
      barriers: ((await db(`bookings?retailer_id=eq.${retailerId}&cancellation_pending_at=not.is.null&select=id`)).body || []),
      unfinished: ((await db(`booking_cancellation_resolutions?retailer_id=eq.${retailerId}&state=neq.completed&select=booking_id,state,refund_request_id`)).body || []),
    });
    const o0 = await outstanding();
    ok('step 0: the preflight shows unfinished work (barriers, unfinished resolutions, an undelivered notice, an un-fanned event): rollback blocked', o0.barriers.length >= 1 && o0.unfinished.length >= 1 && o0.deliveries.some(d => d.status === 'failed') && o0.events >= 1, JSON.stringify({ barriers: o0.barriers.length, unfinished: o0.unfinished.length, deliveries: o0.deliveries.map(d => d.status), events: o0.events }));
    // step 1: restrict NEW producers
    ENV.CANCELLATION_MAINTENANCE = 'true';
    const fresh = await seed({ days: 17, time: '9:00' });
    const c1 = await cancel(fresh.id, { category: 'store_caused' });
    ok('step 1: a NEW cancellation is refused (503 cancellations_paused) and records nothing', c1.statusCode === 503 && c1.body.error === 'cancellations_paused' && (await decisionRows(fresh.id)).length === 0, `${c1.statusCode} ${JSON.stringify(c1.body).slice(0, 100)}`);
    const z3 = await seed({ days: 2, time: '10:00' }); await db(`bookings?id=eq.${z3.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }) });
    await db('booking_cancellations', { method: 'POST', body: JSON.stringify({ booking_id: z3.id, retailer_id: retailerId, category: 'brand_requested', requested_at: hours(-2), actor: staffEmail, cancellation_mode: 'refundable', cutoff_hours: 72, start_source: 'computed', refund: false, status: 'pending_manual', reason: 'inside_cutoff' }) });
    const d1 = await review({ action: 'deny', booking_id: z3.id, reason: 'new during maintenance' });
    ok('step 1: a NEW refund decision is refused (503 cancellations_paused)', d1.statusCode === 503 && d1.body.error === 'cancellations_paused' && (await resolutionRows(z3.id)).length === 0, `${d1.statusCode}`);
    // step 2: finish existing work through SUPPORTED actions only: cancel retries, grant replays, refund-review replace, the
    // workers, and time passing for requests in their backoff. No row is edited by hand here.
    const actions = { cancel_retries: 0, grant_replays: 0, replaces: 0, worker_runs: 0, waited_ms: 0 };
    for (const bk of o0.barriers) { const r = await cancel(bk.id, { category: 'store_caused' }); actions.cancel_retries++; if (r.statusCode !== 200) console.log('  note barrier retry ' + bk.id.slice(0, 8) + ' -> ' + r.statusCode + ' ' + JSON.stringify(r.body).slice(0, 120)); }
    let o2 = await outstanding();
    for (let pass = 0; pass < 6 && (o2.unfinished.length || o2.barriers.length); pass++) {
      for (const u of o2.unfinished) {
        const g = await review({ action: 'grant', booking_id: u.booking_id, reason: 'maintenance replay' }); actions.grant_replays++;
        const stillOpen = g.statusCode === 200 && g.body.state !== 'completed';
        if (stillOpen) {
          const reqs = await requestsOf(u.booking_id);
          const live = reqs.find(x => x.id === (g.body.resolution && g.body.resolution.refund_request_id)) || reqs.find(x => !['superseded', 'canceled', 'succeeded'].includes(x.status));
          if (live && ['requires_review', 'failed_retryable', 'reserved'].includes(live.status)) {
            // the operator's supported repair for a request that is parked or keeps failing: refund review's replace
            const rp = await replace(u.booking_id); actions.replaces++;
            if (!(rp.statusCode === 200)) console.log('  note replace ' + u.booking_id.slice(0, 8) + ' -> ' + rp.statusCode + ' ' + JSON.stringify(rp.body).slice(0, 120));
          }
        }
      }
      // requests in their backoff are retried by the refund worker once the backoff passes: wait for the earliest one (bounded)
      const pending = (await db(`refund_requests?booking_id=in.(${o2.unfinished.map(u => u.booking_id).join(',') || '00000000-0000-0000-0000-000000000000'})&status=in.(failed_retryable,reserved)&select=next_attempt_at&order=next_attempt_at.asc&limit=1`)).body || [];
      if (pending[0] && pending[0].next_attempt_at) { const waitMs = Math.min(150000, Math.max(0, Date.parse(pending[0].next_attempt_at) - Date.now() + 1000)); if (waitMs > 0) { await new Promise(r => setTimeout(r, waitMs)); actions.waited_ms += waitMs; } }
      await worker(); actions.worker_runs++;
      o2 = await outstanding();
    }
    const unresolved = [];
    for (const u of o2.unfinished) {
      const reqs = await requestsOf(u.booking_id);
      const live = reqs.find(x => x.id === u.refund_request_id) || reqs.find(x => !['superseded', 'canceled'].includes(x.status));
      const rq = live ? one(await db(`refund_requests?id=eq.${live.id}&select=id,status,next_attempt_at,attempts`)) : null;
      const waiting = !!(rq && ['failed_retryable', 'reserved'].includes(rq.status) && rq.next_attempt_at && Date.parse(rq.next_attempt_at) > Date.now());
      unresolved.push({ id: u.booking_id.slice(0, 8), state: u.state, request: rq && rq.status, next_attempt_in_min: rq && rq.next_attempt_at ? Math.round((Date.parse(rq.next_attempt_at) - Date.now()) / 60000) : null, legitimately_waiting: waiting });
    }
    if (unresolved.length) console.log('  note unresolved after supported actions (fail-closed: the rollback stays blocked until their backoff passes and the worker retries them): ' + JSON.stringify(unresolved));
    ok('step 2: with recovery running under maintenance, supported actions (cancel retries, grant replays, refund-review replace, the workers, time passing) finish every barrier and every unfinished resolution, or the drill fails closed: each remaining row is legitimately waiting on a future backoff and the preflight keeps blocking', o2.barriers.length === 0 && unresolved.every(u => u.legitimately_waiting), JSON.stringify({ barriers: o2.barriers.length, unresolved, actions }));
    // step 3: quiesce resolution production, recheck
    ENV.CANCELLATION_RESOLUTION_QUIESCE = 'true';
    const wq = await worker();
    const o3 = await outstanding();
    ok('step 3: quiesced (sweeps skipped, decisions refused) and the durable counts are unchanged', wq.body.cancellation_sweeps_quiesced === true && o3.barriers.length === o2.barriers.length && o3.unfinished.length === o2.unfinished.length, JSON.stringify({ q: wq.body && wq.body.cancellation_sweeps_quiesced, b: o3.barriers.length, u: o3.unfinished.length }));
    // step 4: the ACTUAL compatibility build's notification code (rollback/refund-cutoff-compat, 400d74a) against the queued work
    const compat = await import('file:///C:/Users/David/demohub-rollback-compat/api/_notification-outbox.js');
    const beforeKeys = spy.calls.resend.filter(m => m.idempotency_key).map(m => m.idempotency_key);
    const fo = await compat.fanOutEvents(b, { now: new Date() });
    const evZ4 = one(await db(`notification_events?booking_id=eq.${z4.id}&kind=eq.refund_resolution&select=id,fanned_out_at,payload`));
    const dlZ4 = await deliveriesOf(z4.id);
    ok('step 4 (compat build 400d74a): the un-fanned resolution event is fanned out as a known kind (no unknown_kind), one delivery to the brand owner', fo.errors.length === 0 && evZ4 && evZ4.fanned_out_at && !(evZ4.payload && evZ4.payload.fanout_note) && dlZ4.length === 1 && dlZ4[0].recipient_email === brandEmail && dlZ4[0].recipient_kind === 'brand', JSON.stringify({ fo, ev: evZ4 && { fanned: !!evZ4.fanned_out_at, note: evZ4.payload && evZ4.payload.fanout_note }, dl: dlZ4.map(d => ({ to: d.recipient_email, status: d.status })) }));
    const dlZ2before = (await deliveriesOf(z2.id))[0];
    const keyZ2 = beforeKeys.find(k => k === dlZ2before.id) || (spy.calls.resend.find(m => m.idempotency_key === dlZ2before.id) || {}).idempotency_key;
    await compat.dispatchDue(b, { now: new Date(Date.now() + 6 * 60e3) });
    const dlZ2 = (await deliveriesOf(z2.id))[0]; const dlZ4b = (await deliveriesOf(z4.id))[0];
    const sendsZ2 = spy.calls.resend.filter(m => m.idempotency_key === dlZ2before.id);
    ok('step 4 (compat build 400d74a): the retryable frozen delivery is re-sent under its unchanged identity (the delivery id) with the same html and accepted; the new delivery is accepted too', dlZ2 && ['sent', 'accepted'].includes(dlZ2.status) && sendsZ2.length === 2 && sendsZ2[0].html === sendsZ2[1].html && !!keyZ2 && dlZ4b && ['sent', 'accepted'].includes(dlZ4b.status), JSON.stringify({ z2: dlZ2 && dlZ2.status, sends: sendsZ2.length, sameHtml: sendsZ2.length === 2 && sendsZ2[0].html === sendsZ2[1].html, z4: dlZ4b && dlZ4b.status }));
    const o4 = await outstanding();
    ok('step 4: with the compatibility build the notice work is delivered (no un-fanned event, no undelivered delivery); the prerequisites for the rollback itself are the barrier and unfinished-resolution counts, reported as they stand (zero, or the fail-closed rows above)', o4.events === 0 && o4.deliveries.length === 0 && o4.barriers.length === 0 && o4.unfinished.length === unresolved.length, JSON.stringify({ events: o4.events, deliveries: o4.deliveries.length, barriers: o4.barriers.length, unfinished: o4.unfinished.length, rollback_allowed: o4.unfinished.length === 0 }));
    ENV.CANCELLATION_RESOLUTION_QUIESCE = 'false'; ENV.CANCELLATION_MAINTENANCE = 'false';
    const after = await cancel(fresh.id, { category: 'store_caused' });
    ok('after maintenance: cancellations work again', after.statusCode === 200, `${after.statusCode}`);
    for (const id of [Z, z2.id, z3.id, z4.id, ...o0.unfinished.map(u => u.booking_id)]) { const c = await caseOf(id, 'resolution-failed:'); if (c) track('reconciliation_cases', c.id); }
  }
} catch (e) {
  ok('suite ran without an unexpected exception', false, String((e && e.stack) || e).slice(0, 800));
} finally {
  const del = async (p) => { const d = await db(p, { method: 'DELETE' }); if (d.status >= 400) console.log(`  teardown: DELETE ${p} -> ${d.status} ${JSON.stringify(d.body).slice(0, 160)}`); };
  const fxBookings = bin.filter(([t]) => t === 'bookings').map(([, id]) => id);
  for (const [t, id] of bin) if (t === 'reconciliation_cases') await del(`reconciliation_cases?id=eq.${id}`);
  for (const groupId of groups.filter(Boolean)) {
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
    for (const prefix of ['transition:', 'refund-eligibility:', 'cancel-abandoned:']) await del(`reconciliation_cases?dedupe_key=in.(${fxBookings.map(id => '"' + prefix + id + '"').join(',')})`);
    for (const t of ['booking_cancellation_resolutions', 'booking_cancellations', 'booking_moves', 'refund_operations', 'refund_requests', 'booking_fulfillments']) await del(`${t}?booking_id=in.(${fxBookings.join(',')})`);
  }
  await del(`brand_retailer_agreements?retailer_id=eq.${retailerId}`);
  await del(`notification_deliveries?retailer_id=eq.${retailerId}`);
  await del(`notification_events?retailer_id=eq.${retailerId}`);
  await del(`demos?retailer_id=eq.${retailerId}`);
  for (const bid of [brandId, holdBrandId]) await del(`brand_account_sessions?brand_id=eq.${bid}`);
  await del(`admin_sessions?retailer_id=eq.${retailerId}`);
  for (const [t, id] of bin) if (t === 'brand_members') await del(`brand_members?id=eq.${id}`);
  if (bin.filter(([t]) => t === 'bookings').length) await del(`reconciliation_cases?dedupe_key=in.(${bin.filter(([t]) => t === 'bookings').map(([, id]) => '"resolution-failed:' + id + '"').join(',')})`);
  for (const [t, id] of bin.reverse()) if (t !== 'reconciliation_cases' && t !== 'brand_members') await del(`${t}?id=eq.${id}`);
  clearTimeout(watchdog);
  spy.restore();
}
process.exit(summary('refund cutoff recovery (Codex R3-1 to R3-4)') ? 0 : 1);
