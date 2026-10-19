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
const watchdog = setTimeout(() => { console.log('  FAIL watchdog: suite exceeded 9 minutes'); process.exit(1); }, 9 * 60 * 1000);
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
const stripeRefundCalls = () => spy.calls.stripe.filter(c => /\/refunds/.test(c.url)).length;
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
    const resA = await resolutionRows(A);
    ok('A: the later grant returns the STORED denial (existing, decision no_refund), issues ZERO provider calls, and finishes the denial (completed, brand told once, Refund decision)', g.statusCode === 200 && g.body.existing === true && g.body.decision === 'no_refund' && g.body.requested === 'refund_granted' && g.body.refund_status === 'none' && stripeRefundCalls() === r0 && resA.length === 1 && resA[0].state === 'completed' && resA[0].decision === 'no_refund' && mailsSince(m0, /Refund decision/).length === 1 && mailsSince(m0, /Refund approved/).length === 0, `${g.statusCode} ${JSON.stringify(g.body).slice(0, 220)} ${JSON.stringify(resA[0] && { state: resA[0].state, notified: resA[0].brand_notified_at })}`);
    ok('A: the allocation is untouched', Number((await allocOf(A)).refunded_amount) === 0);
    // B: a grant is claimed and the process dies right after; a denial arrives next
    const r1 = stripeRefundCalls(); const m1 = spy.calls.resend.length;
    const gc = await claim(B, 'refund_granted', staffEmail, 'goodwill');
    ok('B: a grant is claimed directly (crash after the claim: no refund yet)', gc && gc.outcome === 'claimed' && (await requestsOf(B)).length === 0 && stripeRefundCalls() === r1, JSON.stringify(gc).slice(0, 120));
    await db(`booking_cancellation_resolutions?booking_id=eq.${B}`, { method: 'PATCH', body: JSON.stringify({ updated_at: new Date(Date.now() - 5 * 60e3).toISOString() }) });   // the crash was a while ago
    const dn = await review({ action: 'deny', booking_id: B, reason: 'changed my mind' });
    const resB = await resolutionRows(B); const alB = await allocOf(B);
    ok('B: the denial returns the STORED grant (existing, decision refund_granted) and finishes it: ONE refund, the allocation refunded in full, refund_status submitted, completed, Refund approved mail once', dn.statusCode === 200 && dn.body.existing === true && dn.body.decision === 'refund_granted' && dn.body.requested === 'no_refund' && dn.body.refund_status === 'submitted' && stripeRefundCalls() === r1 + 1 && Number(alB.refunded_amount) === Number(alB.customer_amount) && resB.length === 1 && resB[0].state === 'completed' && resB[0].refund_request_id && mailsSince(m1, /Refund approved/).length === 1 && mailsSince(m1, /Refund decision/).length === 0, `${dn.statusCode} ${JSON.stringify(dn.body).slice(0, 220)}`);
    // C: two grants at once
    const r2 = stripeRefundCalls(); const m2 = spy.calls.resend.length;
    const [c1, c2] = await Promise.all([review({ action: 'grant', booking_id: C, reason: 'one' }), review({ action: 'grant', booking_id: C, reason: 'two' })]);
    const resC = await resolutionRows(C); const alC = await allocOf(C);
    ok('C: two concurrent grants: both 200, exactly one won the claim, ONE Stripe refund, one request, one resolution (completed), one mail', c1.statusCode === 200 && c2.statusCode === 200 && [c1.body.existing, c2.body.existing].filter(x => x === false).length === 1 && stripeRefundCalls() === r2 + 1 && (await requestsOf(C)).length === 1 && resC.length === 1 && resC[0].state === 'completed' && Number(alC.refunded_amount) === Number(alC.customer_amount) && mailsSince(m2, /Refund approved/).length === 1, JSON.stringify({ c1: c1.body && { existing: c1.body.existing, state: c1.body.state }, c2: c2.body && { existing: c2.body.existing, state: c2.body.state }, refunds: stripeRefundCalls() - r2, mails: mailsSince(m2, /Refund approved/).length }));
    // D: two denials at once
    const r3 = stripeRefundCalls(); const m3 = spy.calls.resend.length;
    const [d1, d2] = await Promise.all([review({ action: 'deny', booking_id: D, reason: 'one' }), review({ action: 'deny', booking_id: D, reason: 'two' })]);
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
    const resE1 = await resolutionRows(E); const rqE1 = await requestsOf(E);
    ok('E: 200 in_progress, refund_status refund_pending, the request parked failed_retryable with the reservation kept, state refund_pending, the brand told the refund is in progress', e1.statusCode === 200 && e1.body.outcome === 'in_progress' && e1.body.refund_status === 'refund_pending' && resE1[0].state === 'refund_pending' && rqE1.length === 1 && rqE1[0].status === 'failed_retryable' && /refund is in progress/.test(text(mailsSince(m0, /Refund approved/)[0])), `${e1.statusCode} ${JSON.stringify(e1.body).slice(0, 200)} ${JSON.stringify(rqE1)}`);
    const wk = await worker();
    const rqE2 = await requestsOf(E); const resE2 = await resolutionRows(E); const alE = await allocOf(E);
    ok('E: the refund worker resubmits the parked request under its stored key and the resolution resume marks it submitted and completed; the allocation holds exactly one obligation (reserved or refunded); still one request', wk.statusCode === 200 && rqE2.length === 1 && ['submitted', 'succeeded', 'pending'].includes(rqE2[0].status) && resE2[0].state === 'completed' && resE2[0].refund_request_id === rqE2[0].id && Number(alE.refunded_amount) + Number(alE.reserved_refund_amount || 0) === Number(alE.customer_amount), JSON.stringify({ wk: wk.statusCode, body: wk.body && { resubmitted: wk.body.resubmitted, resolutions: [wk.body.resolutions_checked, wk.body.resolutions_completed], first_error: wk.body.first_error }, rq: rqE2, state: resE2[0].state, linked: resE2[0].refund_request_id, al: alE }));
    ok('E: the brand was told once', mailsSince(m0, /Refund approved/).length === 1);
    // F: the mail provider fails once
    spy.faults.push({ url: 'api.resend.com', method: 'POST', status: 500, message: 'injected_mail_outage', once: true });
    const m1 = spy.calls.resend.length; const r1 = stripeRefundCalls();
    const f1 = await review({ action: 'grant', booking_id: F, reason: 'goodwill' });
    const resF1 = await resolutionRows(F);
    ok('F: the refund is submitted but the notice failed: 200 in_progress, state failed, brand_notified false, pending_step names the notice', f1.statusCode === 200 && f1.body.outcome === 'in_progress' && f1.body.refund_status === 'submitted' && f1.body.brand_notified === false && resF1[0].state === 'failed' && resF1[0].brand_notified_at == null && /notice/.test(String(f1.body.pending_step || '')), `${f1.statusCode} ${JSON.stringify(f1.body).slice(0, 220)}`);
    const keyFailed = spy.calls.resend.slice(m1).map(m => m.idempotency_key).filter(Boolean)[0];
    const wk2 = await worker();
    const resF2 = await resolutionRows(F);
    const sentF = mailsSince(m1, /Refund approved/);
    ok('F: the worker resumes: the notice is re-sent under the SAME notice key, the row completes, no second refund', wk2.statusCode === 200 && resF2[0].state === 'completed' && resF2[0].brand_notified_at && sentF.length === 2 && keyFailed && sentF.every(m => m.idempotency_key === keyFailed) && keyFailed === resF2[0].notice_key && stripeRefundCalls() === r1 + 1, JSON.stringify({ state: resF2[0].state, keys: sentF.map(m => m.idempotency_key), notice_key: resF2[0].notice_key }));
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
    ok('I: the worker finishes the claimed grant: one refund, allocation refunded, brand told once, completed', wk3.statusCode === 200 && resI[0].state === 'completed' && stripeRefundCalls() === r3 + 1 && Number(alI.refunded_amount) === Number(alI.customer_amount) && mailsSince(m3, /Refund approved/).length === 1, JSON.stringify({ state: resI[0].state, wk: wk3.body && { checked: wk3.body.resolutions_checked, completed: wk3.body.resolutions_completed } }));
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
  for (const [t, id] of bin.reverse()) if (t !== 'reconciliation_cases') await del(`${t}?id=eq.${id}`);
  clearTimeout(watchdog);
  spy.restore();
}
process.exit(summary('refund cutoff recovery (Codex R3-1 to R3-4)') ? 0 : 1);
