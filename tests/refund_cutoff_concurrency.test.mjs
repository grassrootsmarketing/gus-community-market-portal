// tests/refund_cutoff_concurrency.test.mjs (2026-10-19, Codex refund-cutoff revision 2 review, R2-1 / R2-2 / R2-3).
// Against the test database (demohub-rebuild-check): real routes, real RPCs, Stripe and Resend spied.
//
//   R2-3  The recorded cancellation decision is bound to the authoritative row and is a barrier:
//         * direct RPC: a record whose expected inputs (payment state, schedule revision, mode) no longer match is
//           answered 'stale' with the current values and writes nothing; a matching record sets the barrier
//         * the barrier: booking_transition confirm / promote_paid / materialize answer 'cancellation_pending';
//           a store move answers 409 cancellation_pending; the cancel itself lands and clears it
//         * REAL races on allocation-backed bookings of one shared payment: cancel versus confirm, cancel versus
//           move, both started in the same tick; every outcome converges to one decision row, one refund of that
//           booking's own allocation, siblings untouched
//         * a transition failure after the record keeps the barrier; the retry replays the saved decision
//   R2-2  The operator resolution of a refund the rule left undecided:
//         * pending_manual (inside the window): grant through /api/refund-review = ONE allocation-scoped refund,
//           a resolution row, the brand's notice; a repeat returns the recorded answer with no second refund;
//           deny after grant returns the recorded grant; a foreign retailer gets 403; no reason gets 400
//         * under_review whose case creation failed: the refund worker's sweep opens the missing case; deny
//           resolves it (case resolved, resolution row, notice); grant on an uncharged booking is refused and
//           records nothing
//   R2-1  Mixed operations on one shared payment: the two races, the grant and a move lapse on an inside-window
//         booking under a non-refundable policy (full refund regardless of the cutoff), each refunding exactly
//         its own allocation once.
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
ENV.RETAILER_MOVES_ENABLED = 'true';   // store moves are live in production; the suite exercises the barrier against them
const watchdog = setTimeout(() => { console.log('  FAIL watchdog: suite exceeded 8 minutes'); process.exit(1); }, 8 * 60 * 1000);
const sign = (payload, secret = 'whsec_harness') => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`; };
const idList = (arr) => arr.map(encodeURIComponent).join(',');
const hours = (h) => new Date(Date.now() + h * 3600e3).toISOString();
function dayP(n) {
  const d = new Date(Date.now() + n * 864e5);
  const p = {}; for (const x of new Intl.DateTimeFormat('en-US', { timeZone: LA, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}

console.log('\nFixtures');
const slug = uniq('rcc');
// auto_confirm OFF: a paid booking stays pending until the store confirms it, which is what the cancel-versus-confirm race needs
const retailerId = track('retailers', one(await db('retailers', { method: 'POST', body: JSON.stringify({
  slug, name: 'Concurrency Market', billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active',
  platform_keeps_all: true, timezone: LA, auto_confirm_bookings: false, cancellation_mode: 'refundable', verification_status: 'approved' }) })).id);
track('settings', one(await db('settings', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, demo_fee: 30, advance_booking_days: 0 }) })).id);
const venueId = track('venues', one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, name: 'Concurrency Main', address: '1 Race St', demo_fee: 30, availability: HOURLY }) })).id);
const staffEmail = `staff-${slug}@fixture.test`;
track('retailer_admins', one(await db('retailer_admins', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, email: staffEmail, email_normalized: staffEmail, name: 'Race Staff', role: 'admin' }) })).id);
const tok = one(await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: staffEmail, retailer_id: retailerId }) }));
const cookie = (await callRoute('admin-auth.js', req({ body: { action: 'verify', token: tok.token } }))).cookie('dh_retailer_session');
const otherSlug = uniq('rco');
const otherRetailerId = track('retailers', one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug: otherSlug, name: 'Other Market', billing_email: `${otherSlug}@fixture.test`, billing_tier: 'pro', billing_status: 'active', timezone: LA, verification_status: 'approved' }) })).id);
const otherStaff = `staff-${otherSlug}@fixture.test`;
track('retailer_admins', one(await db('retailer_admins', { method: 'POST', body: JSON.stringify({ retailer_id: otherRetailerId, email: otherStaff, email_normalized: otherStaff, name: 'Other Staff', role: 'admin' }) })).id);
const otherTok = one(await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: otherStaff, retailer_id: otherRetailerId }) }));
const otherCookie = (await callRoute('admin-auth.js', req({ body: { action: 'verify', token: otherTok.token } }))).cookie('dh_retailer_session');
const brandEmail = `${uniq('brand')}@fixture.test`;
const brandId = track('brands', one(await db('brands', { method: 'POST', body: JSON.stringify({ email: brandEmail, company_name: 'Race Brand', contact_name: 'Race Contact', phone: '555-0173', is_verified: true,
  default_coi_url: 'brands/race.pdf', default_coi_expires: dayP(400), coi_verification_status: 'approved' }) })).id);
const brandTok = one(await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: brandId, email: brandEmail, token: 'tk-' + uniq('c'), expires_at: hours(1) }) }));
const brandCookie = (await callRoute('brand-account.js', req({ body: { action: 'verify', token: brandTok.token } }))).cookie('dh_brand_session');
ok('fixtures: two retailers, staff sessions, brand session exist', !!retailerId && !!venueId && !!cookie && !!otherCookie && !!brandId && !!brandCookie);

let seedN = 0;
async function seed({ days, status = 'confirmed', payment_status = 'paid', pi = true, time = null }) {
  const t = time || `${9 + (seedN++ % 10)}:00`;
  const r = await db('bookings', { method: 'POST', body: JSON.stringify({
    retailer_id: retailerId, venue_id: venueId, brand_id: brandId, brand_name: 'Race Brand', contact_name: 'Race Contact', contact_email: brandEmail,
    product: 'Samples', demo_date: dayP(days), demo_time: t, status, payment_status, payment_intent_id: pi ? 'pi_' + uniq('rc') : null }) });
  const b = one(r);
  if (!b || !b.id) throw new Error('seed failed: ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 200));
  track('bookings', b.id);
  return b;
}
const setMode = async (mode) => { const r = await db(`retailers?id=eq.${retailerId}`, { method: 'PATCH', body: JSON.stringify({ cancellation_mode: mode }) }); if (r.status >= 400) throw new Error('setMode ' + r.status); };
const act = (body, c = cookie) => callRoute('booking-action.js', req({ body, cookies: { dh_retailer_session: c } }));
const cancel = (booking_id, extra = {}, c = cookie) => act({ action: 'cancel', category: 'brand_requested', booking_id, ...extra }, c);
const confirm = (booking_id) => act({ action: 'confirm', booking_id });
const move = (demo_id, new_date, new_time = '13:00') => act({ action: 'move', demo_id, new_date, new_time });
const review = (body, c = cookie) => callRoute('refund-review.js', req({ body, cookies: { dh_retailer_session: c } }));
const worker = () => callRoute('refund-worker.js', req({ method: 'GET', headers: { authorization: 'Bearer ' + ENV.CRON_SECRET } }));
const row = async (id) => one(await db(`bookings?id=eq.${id}&select=status,payment_status,cancelled_at,cancellation_pending_at,schedule_revision,demo_date,demo_time`));
const demoOf = async (id) => one(await db(`demos?booking_id=eq.${id}&select=id,status,demo_date,demo_time&order=created_at`));
const decisionRows = async (id) => (await db(`booking_cancellations?booking_id=eq.${id}&select=*`)).body || [];
const resolutionRows = async (id) => (await db(`booking_cancellation_resolutions?booking_id=eq.${id}&select=*`)).body || [];
const caseOf = async (id) => one(await db(`reconciliation_cases?dedupe_key=eq.${encodeURIComponent('refund-eligibility:' + id)}&select=id,status,resolved_by,resolved_at,kind,details`));
const allocOf = async (id) => one(await db(`payment_allocations?booking_id=eq.${id}&select=customer_amount,refunded_amount,reserved_refund_amount`));
const requestsOf = async (id) => (await db(`refund_requests?booking_id=eq.${id}&select=id,status,amount`)).body || [];
const stripeRefundCalls = () => spy.calls.stripe.filter(c => /\/refunds/.test(c.url)).length;
const mailsSince = (n, re) => spy.calls.resend.slice(n).filter(m => re.test(String(m.subject || '')));
const text = (m) => (m ? String(m.html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') : 'no mail');
let groupId = null; const bookingIds = [];

try {
  console.log('\nR2-3 direct RPC: the record is bound to the row it was computed from');
  {
    const b = await seed({ days: 9 });
    const base = { p_booking_id: b.id, p_retailer_id: retailerId, p_decision: { category: 'brand_requested', requested_at: new Date().toISOString(), actor: staffEmail, cancellation_mode: 'refundable', cutoff_hours: 72, start_at: null, start_source: 'computed', hours_before_demo: 200, refund: true, status: 'auto', reason: 'outside_cutoff' } };
    const live = await row(b.id);
    const stalePay = await rpc('booking_cancellation_record', { ...base, p_expect: { payment_status: 'unpaid', schedule_revision: live.schedule_revision } });
    ok('expected payment_status unpaid on a paid row: stale, with the current values, nothing written', stalePay && stalePay.outcome === 'stale' && stalePay.current && stalePay.current.payment_status === 'paid' && (await decisionRows(b.id)).length === 0, JSON.stringify(stalePay).slice(0, 200));
    const staleRev = await rpc('booking_cancellation_record', { ...base, p_expect: { schedule_revision: (Number(live.schedule_revision) || 1) + 5 } });
    ok('expected an older schedule revision: stale, nothing written', staleRev && staleRev.outcome === 'stale' && (await decisionRows(b.id)).length === 0, JSON.stringify(staleRev).slice(0, 160));
    const staleMode = await rpc('booking_cancellation_record', { ...base, p_expect: { cancellation_mode: 'non_refundable' } });
    ok('expected a policy the store does not have: stale (a policy change during the record is caught)', staleMode && staleMode.outcome === 'stale' && staleMode.current.cancellation_mode === 'refundable', JSON.stringify(staleMode).slice(0, 160));
    ok('no barrier was set by the refused records', (await row(b.id)).cancellation_pending_at == null);
    const good = await rpc('booking_cancellation_record', { ...base, p_expect: { payment_status: 'paid', schedule_revision: live.schedule_revision, demo_date: live.demo_date, demo_time: live.demo_time, fee_waived: false, cancellation_mode: 'refundable', timezone: LA } });
    const after = await row(b.id);
    ok('a record whose expectations match is recorded and sets the cancellation barrier', good && good.outcome === 'recorded' && good.existing === false && after.cancellation_pending_at != null && (await decisionRows(b.id)).length === 1, JSON.stringify(good).slice(0, 160));
    const again = await rpc('booking_cancellation_record', { ...base, p_decision: { ...base.p_decision, reason: 'something_else' }, p_expect: { payment_status: 'unpaid' } });
    ok('a retry returns the saved decision (existing) even with stale expectations; it never recomputes', again && again.outcome === 'existing' && again.decision && again.decision.reason === 'outside_cutoff', JSON.stringify(again).slice(0, 160));
    // the barrier
    const tc = await rpc('booking_transition', { p_booking_id: b.id, p_retailer_id: retailerId, p_action: 'materialize', p_fields: {}, p_demo_fee: 30 });
    ok('booking_transition materialize on the barrier: refused with cancellation_pending', tc && tc.ok === false && tc.reason === 'cancellation_pending', JSON.stringify(tc));
    const tp = await rpc('booking_transition', { p_booking_id: b.id, p_retailer_id: retailerId, p_action: 'promote_paid', p_fields: { status: 'confirmed' }, p_demo_fee: 30 });
    ok('booking_transition promote_paid on the barrier: refused with cancellation_pending (a capture cannot land on a recorded cancellation)', tp && tp.ok === false && tp.reason === 'cancellation_pending', JSON.stringify(tp));
    const r = await cancel(b.id);
    const done = await row(b.id);
    ok('the cancel route completes the recorded cancellation: 200, decision_replayed, cancelled, barrier cleared', r.statusCode === 200 && r.body.decision_replayed === true && done.status === 'cancelled' && done.cancellation_pending_at == null, `${r.statusCode} ${JSON.stringify(r.body).slice(0, 160)} ${JSON.stringify(done)}`);
    const tcAfter = await rpc('booking_transition', { p_booking_id: b.id, p_retailer_id: retailerId, p_action: 'materialize', p_fields: {}, p_demo_fee: 30 });
    ok('after the cancellation a materialize is superseded (the ordinary terminal refusal), not cancellation_pending', tcAfter && tcAfter.ok === false && tcAfter.reason === 'superseded', JSON.stringify(tcAfter));
  }

  console.log('\nR2-3 the barrier against a store move (confirmed booking with a calendar demo)');
  {
    const g = await seed({ days: 15 });
    await rpc('booking_transition', { p_booking_id: g.id, p_retailer_id: retailerId, p_action: 'materialize', p_fields: {}, p_demo_fee: 30 });
    const demo = await demoOf(g.id);
    ok('fixture: a confirmed booking with its demo', !!demo && demo.status === 'confirmed');
    const live = await row(g.id);
    const rec = await rpc('booking_cancellation_record', { p_booking_id: g.id, p_retailer_id: retailerId, p_decision: { category: 'store_caused', requested_at: new Date().toISOString(), actor: staffEmail, cancellation_mode: 'refundable', cutoff_hours: 72, start_source: 'computed', hours_before_demo: 300, refund: true, status: 'auto', reason: 'store_caused' }, p_expect: { schedule_revision: live.schedule_revision, payment_status: 'paid' } });
    ok('the decision is recorded directly (simulating a cancel whose transition has not landed yet)', rec && rec.outcome === 'recorded');
    const mv = await move(demo.id, dayP(16));
    ok('a store move on the barrier: 409 cancellation_pending, the schedule unchanged', mv.statusCode === 409 && mv.body.error === 'cancellation_pending' && (await row(g.id)).schedule_revision === live.schedule_revision, `${mv.statusCode} ${JSON.stringify(mv.body).slice(0, 200)}`);
    const pr = await rpc('propose_reschedule', { p_demo_id: demo.id, p_retailer_id: retailerId, p_new_date: dayP(17), p_new_time: '13:00' });
    ok('propose_reschedule on the barrier: refused with cancellation_pending', pr && pr.ok === false && pr.reason === 'cancellation_pending', JSON.stringify(pr));
    const c = await cancel(g.id, { category: 'store_caused' });
    const after = await row(g.id);
    ok('the cancel lands (replayed decision), the demo is cancelled, the barrier is cleared', c.statusCode === 200 && c.body.decision_replayed === true && after.status === 'cancelled' && after.cancellation_pending_at == null && (await demoOf(g.id)).status === 'cancelled', `${c.statusCode} ${JSON.stringify(c.body).slice(0, 160)}`);
    const mv2 = await move(demo.id, dayP(16));
    ok('moving the cancelled demo: 409 not_active', mv2.statusCode === 409 && mv2.body.error === 'not_active', `${mv2.statusCode} ${JSON.stringify(mv2.body).slice(0, 120)}`);
  }

  console.log('\nR2-3 transition failure after the record keeps the barrier; the retry replays the decision');
  {
    const h = await seed({ days: 4 });
    spy.faults.push({ url: '/rpc/booking_transition', method: 'POST', status: 500, message: 'injected_transition_failure', once: true });
    const f1 = await cancel(h.id);
    const mid = await row(h.id);
    ok('first attempt: 500 transition_failed, the booking still confirmed, the barrier set', f1.statusCode === 500 && f1.body.error === 'transition_failed' && mid.status === 'confirmed' && mid.cancellation_pending_at != null, `${f1.statusCode} ${JSON.stringify(f1.body).slice(0, 160)}`);
    if (f1.body.reconciliation_case_id) track('reconciliation_cases', f1.body.reconciliation_case_id);
    spy.faults.length = 0;
    const tm = await rpc('booking_transition', { p_booking_id: h.id, p_retailer_id: retailerId, p_action: 'materialize', p_fields: {}, p_demo_fee: 30 });
    ok('while the cancellation is pending a materialize is refused (cancellation_pending)', tm && tm.ok === false && tm.reason === 'cancellation_pending', JSON.stringify(tm));
    await setMode('non_refundable');
    const f2 = await cancel(h.id);
    const after = await row(h.id);
    ok('retry under a changed policy: 200, decision_replayed, cancelled, barrier cleared, the saved (refundable) decision stands', f2.statusCode === 200 && f2.body.decision_replayed === true && after.status === 'cancelled' && after.cancellation_pending_at == null && (await decisionRows(h.id))[0].cancellation_mode === 'refundable', `${f2.statusCode} ${JSON.stringify(f2.body).slice(0, 160)}`);
    await setMode('refundable');
  }

  console.log('\nOne shared payment: four allocation-backed bookings (A +5, B +6, C +1, D +2 days), store confirms later');
  {
    for (const days of [5, 6, 1, 2]) {
      const bk = await callRoute('book.js', req({ body: { retailer_slug: slug, venue_id: venueId, demo_date: dayP(days), demo_time: '13:00', product_skus: FIXTURE_PRODUCTS }, cookies: { dh_brand_session: brandCookie } }));
      const id = bk.body && (bk.body.booking_id || bk.body.id || (bk.body.booking && bk.body.booking.id));
      if (id) { track('bookings', id); bookingIds.push(id); } else console.log('  book.js ' + bk.statusCode + ' ' + JSON.stringify(bk.body).slice(0, 200));
    }
    ok('four bookings were created through /api/book', bookingIds.length === 4, `${bookingIds.length}`);
    const co = await callRoute('checkout.js', req({ body: { booking_ids: bookingIds }, cookies: { dh_brand_session: brandCookie } }));
    const sessionId = co.body && co.body.session_id; groupId = co.body && co.body.payment_group_id; const total = co.body && co.body.total_cents;
    ok('/api/checkout claimed ONE group', co.statusCode === 200 && !!sessionId && !!groupId && Number.isFinite(total), `${co.statusCode} ${JSON.stringify(co.body).slice(0, 200)}`);
    const piId = 'pi_' + uniq('paid'), chargeId = 'ch_' + uniq('paid');
    spy.fixtures.paymentIntents[piId] = { id: piId, object: 'payment_intent', amount_received: total, currency: 'usd', on_behalf_of: null,
      latest_charge: { id: chargeId, object: 'charge', destination: null, application_fee_amount: null, transfer: null, application_fee: null } };
    const paidEvent = JSON.stringify({ id: 'evt_' + uniq('paid'), type: 'checkout.session.completed',
      data: { object: { id: sessionId, object: 'checkout.session', mode: 'payment', payment_status: 'paid', amount_total: total, currency: 'usd', payment_intent: piId, metadata: { payment_group_id: groupId } } } });
    const paid1 = await callRoute('stripe-webhook.js', rawReq(paidEvent, { signature: sign(paidEvent) }));
    const rows = (await db(`bookings?id=in.(${idList(bookingIds)})&select=id,payment_status,status`)).body || [];
    ok('the signed paid event paid all four; they stay pending (no auto-confirm)', paid1.statusCode < 300 && rows.length === 4 && rows.every(b => b.payment_status === 'paid' && b.status === 'pending'), `${paid1.statusCode} ${JSON.stringify(rows)}`);
    const allocs = (await db(`payment_allocations?payment_group_id=eq.${groupId}&select=booking_id,customer_amount,refunded_amount`)).body || [];
    ok('four allocations exist, none refunded', allocs.length === 4 && allocs.every(a => Number(a.refunded_amount || 0) === 0), JSON.stringify(allocs));
  }
  const [A, B, C, D] = bookingIds;
  const siblingsUntouched = async (except) => { const others = (await db(`payment_allocations?payment_group_id=eq.${groupId}&booking_id=not.in.(${idList(except)})&select=booking_id,refunded_amount,reserved_refund_amount`)).body || []; return others.every(a => Number(a.refunded_amount || 0) === 0 && Number(a.reserved_refund_amount || 0) === 0); };

  console.log('\nRace 1: cancel versus confirm on A (paid, pending, +5 days), started in the same tick');
  {
    const r0 = stripeRefundCalls();
    const [c, k] = await Promise.all([cancel(A), confirm(A)]);
    console.log('  note outcomes: cancel ' + c.statusCode + ' ' + JSON.stringify(c.body).slice(0, 140) + ' | confirm ' + k.statusCode + ' ' + JSON.stringify(k.body).slice(0, 140));
    const after = await row(A); const d = await decisionRows(A); const al = await allocOf(A);
    const cancelWon = c.statusCode === 200;
    ok('the cancel succeeded (200) whichever side locked first; the confirm either won the lock first (200) or was refused (409)', cancelWon && (k.statusCode === 200 || k.statusCode === 409), `cancel ${c.statusCode} confirm ${k.statusCode}`);
    ok('converged: A cancelled, exactly one decision row (outside_cutoff, refund), one Stripe refund, A\'s allocation refunded in full', after.status === 'cancelled' && after.cancellation_pending_at == null && d.length === 1 && d[0].reason === 'outside_cutoff' && d[0].refund === true && stripeRefundCalls() === r0 + 1 && Number(al.refunded_amount) === Number(al.customer_amount), JSON.stringify({ after, d: d.map(x => x.reason), refunds: stripeRefundCalls() - r0, al }));
    ok('siblings B, C, D untouched', await siblingsUntouched([A]));
    const demo = await demoOf(A);
    ok('no live demo survives for A (none created, or created by the confirm and then cancelled)', !demo || demo.status === 'cancelled', JSON.stringify(demo));
    if (k.statusCode === 409) ok('the refused confirm named the cancellation (cancellation_pending) or the state change', ['cancellation_pending', 'state_changed'].includes(k.body.error) || /already cancelled/i.test(String(k.body.error)), JSON.stringify(k.body).slice(0, 160));
  }

  console.log('\nRace 2: cancel versus store move on B (confirmed, +6 days), started in the same tick');
  {
    const k = await confirm(B);
    const demoB = await demoOf(B);
    ok('fixture: B confirmed with its demo', k.statusCode === 200 && !!demoB && demoB.status === 'confirmed', `${k.statusCode} ${JSON.stringify(k.body).slice(0, 120)}`);
    const rev0 = (await row(B)).schedule_revision;
    const r0 = stripeRefundCalls();
    const [c, m] = await Promise.all([cancel(B), move(demoB.id, dayP(7))]);
    console.log('  note outcomes: cancel ' + c.statusCode + ' ' + JSON.stringify(c.body).slice(0, 160) + ' | move ' + m.statusCode + ' ' + JSON.stringify(m.body).slice(0, 140));
    const after = await row(B); const d = await decisionRows(B); const al = await allocOf(B);
    ok('the cancel succeeded; the move either landed first (200) or was refused (409 cancellation_pending)', c.statusCode === 200 && (m.statusCode === 200 || (m.statusCode === 409 && m.body.error === 'cancellation_pending')), `cancel ${c.statusCode} move ${m.statusCode} ${m.body && m.body.error}`);
    if (m.statusCode === 200) {
      ok('the move landed first: the decision was recomputed against the moved schedule (decision_recomputed true, decision start on the new date)', c.body.decision_recomputed === true && d.length === 1 && d[0].start_at && d[0].start_at.slice(0, 10) === dayP(7), JSON.stringify({ recomputed: c.body.decision_recomputed, start: d[0] && d[0].start_at }));
      const mvRow = one(await db(`booking_moves?booking_id=eq.${B}&select=status,settled_at&order=moved_at.desc`));
      await worker();
      const mvRow2 = one(await db(`booking_moves?booking_id=eq.${B}&select=status,settled_at&order=moved_at.desc`));
      ok('the pending move is not settled as a decline (no second refund): it is superseded by the cancellation or left pending', (mvRow2 && mvRow2.status !== 'declined' && mvRow2.status !== 'lapsed' && !mvRow2.settled_at) || !mvRow, JSON.stringify({ before: mvRow, after: mvRow2 }));
    } else {
      ok('the cancel locked first: the schedule never changed', after.schedule_revision === rev0 && c.body.decision_recomputed === false, JSON.stringify({ rev0, after: after.schedule_revision }));
    }
    ok('converged: B cancelled, one decision row, one Stripe refund, B\'s allocation refunded in full, barrier cleared', after.status === 'cancelled' && after.cancellation_pending_at == null && d.length === 1 && stripeRefundCalls() === r0 + 1 && Number(al.refunded_amount) === Number(al.customer_amount), JSON.stringify({ after, refunds: stripeRefundCalls() - r0, al }));
    ok('siblings C, D untouched', await siblingsUntouched([A, B]));
    ok('B\'s demo is cancelled', (await demoOf(B)).status === 'cancelled');
  }

  console.log('\nR2-2 pending_manual on C (+1 day, inside the window): the store grants the refund later');
  {
    const k = await confirm(C);
    ok('fixture: C confirmed', k.statusCode === 200, `${k.statusCode}`);
    const r0 = stripeRefundCalls(); const m0 = spy.calls.resend.length;
    const c = await cancel(C);
    ok('cancel: 200 pending_manual inside_cutoff, zero refunds, C still paid', c.statusCode === 200 && c.body.refund_status === 'pending_manual' && c.body.refund_reason === 'inside_cutoff' && stripeRefundCalls() === r0 && (await row(C)).payment_status === 'paid', `${c.statusCode} ${JSON.stringify(c.body).slice(0, 160)}`);
    const look = await review({ action: 'cancellation', booking_id: C });
    ok('refund-review action=cancellation: resolvable, why pending_manual, decision shown, no resolution yet', look.statusCode === 200 && look.body.resolvable === true && look.body.why === 'pending_manual' && look.body.decision && look.body.decision.refund === false && look.body.resolution == null, `${look.statusCode} ${JSON.stringify(look.body).slice(0, 200)}`);
    const noWhy = await review({ action: 'grant', booking_id: C });
    ok('grant without a reason: 400 reason_required, nothing recorded', noWhy.statusCode === 400 && noWhy.body.error === 'reason_required' && (await resolutionRows(C)).length === 0, `${noWhy.statusCode}`);
    const foreign = await review({ action: 'grant', booking_id: C, reason: 'not mine' }, otherCookie);
    ok('a foreign retailer: 403, nothing recorded, no refund', foreign.statusCode === 403 && (await resolutionRows(C)).length === 0 && stripeRefundCalls() === r0, `${foreign.statusCode} ${JSON.stringify(foreign.body)}`);
    const grant = await review({ action: 'grant', booking_id: C, reason: 'goodwill, first demo with us' });
    const al = await allocOf(C); const res = await resolutionRows(C); const reqs = await requestsOf(C);
    ok('grant: 200, refund submitted, ONE Stripe refund, C\'s allocation refunded in full, one refund request', grant.statusCode === 200 && grant.body.refund_status === 'submitted' && grant.body.existing === false && stripeRefundCalls() === r0 + 1 && Number(al.refunded_amount) === Number(al.customer_amount) && reqs.length === 1, `${grant.statusCode} ${JSON.stringify(grant.body).slice(0, 200)} ${JSON.stringify({ al, reqs })}`);
    ok('one resolution row: refund_granted, operator, reason, the refund request linked; the initial decision unchanged (refund false, pending_manual)', res.length === 1 && res[0].decision === 'refund_granted' && res[0].operator === staffEmail && /goodwill/.test(res[0].reason) && res[0].refund_request_id === reqs[0].id && (await decisionRows(C))[0].refund === false && (await decisionRows(C))[0].status === 'pending_manual', JSON.stringify(res));
    const mails = mailsSince(m0, /Refund approved/);
    ok('the brand was told once: "Refund approved", refund submitted wording', mails.length === 1 && /refund request was submitted/i.test(text(mails[0])), JSON.stringify(mails.map(m => m.subject)));
    ok('siblings untouched (D)', await siblingsUntouched([A, B, C]));
    const again = await review({ action: 'grant', booking_id: C, reason: 'clicked twice' });
    ok('grant again: 200 existing, no second refund, no second mail, still one resolution', again.statusCode === 200 && again.body.existing === true && stripeRefundCalls() === r0 + 1 && mailsSince(m0, /Refund approved/).length === 1 && (await resolutionRows(C)).length === 1, `${again.statusCode} ${JSON.stringify(again.body).slice(0, 160)}`);
    const deny = await review({ action: 'deny', booking_id: C, reason: 'changed my mind' });
    ok('deny after a grant: the recorded grant is returned (existing), nothing changes', deny.statusCode === 200 && deny.body.existing === true && deny.body.resolution.decision === 'refund_granted', `${deny.statusCode} ${JSON.stringify(deny.body).slice(0, 160)}`);
    const look2 = await review({ action: 'cancellation', booking_id: C });
    ok('action=cancellation now reports resolved', look2.statusCode === 200 && look2.body.resolvable === false && look2.body.why === 'resolved', JSON.stringify(look2.body).slice(0, 160));
  }

  console.log('\nR2-1 a move lapse on D (+2 days, inside the window, store non-refundable): the full allocation is refunded regardless');
  {
    const k = await confirm(D);
    const demoD = await demoOf(D);
    ok('fixture: D confirmed with its demo', k.statusCode === 200 && !!demoD, `${k.statusCode}`);
    await setMode('non_refundable');
    const mv = await move(demoD.id, dayP(3));
    ok('the store moved D to +3 days', mv.statusCode === 200 && !!mv.body.move_id, `${mv.statusCode} ${JSON.stringify(mv.body).slice(0, 160)}`);
    await db(`booking_moves?id=eq.${mv.body.move_id}`, { method: 'PATCH', body: JSON.stringify({ reconfirm_due_at: hours(-1) }) });
    const r0 = stripeRefundCalls();
    const wk = await worker();
    const after = await row(D); const al = await allocOf(D); const mvRow = one(await db(`booking_moves?id=eq.${mv.body.move_id}&select=status,settled_at`));
    ok('the worker lapsed and settled the move: D cancelled, ONE Stripe refund, D\'s allocation refunded in full, under a non-refundable policy', wk.statusCode === 200 && mvRow && mvRow.status === 'lapsed' && !!mvRow.settled_at && after.status === 'cancelled' && stripeRefundCalls() === r0 + 1 && Number(al.refunded_amount) === Number(al.customer_amount), JSON.stringify({ wk: wk.statusCode, body: wk.body && { lapsed: wk.body.moves_lapsed, settled: wk.body.moves_settled, failed: wk.body.moves_failed }, after, al, mvRow }));
    ok('no cancellation decision row is written by a move settlement (it is not a policy cancellation)', (await decisionRows(D)).length === 0);
    await setMode('refundable');
    const all = (await db(`payment_allocations?payment_group_id=eq.${groupId}&select=booking_id,customer_amount,refunded_amount`)).body || [];
    const reqsAll = (await db(`refund_requests?booking_id=in.(${idList(bookingIds)})&select=booking_id`)).body || [];
    ok('the shared payment: every allocation refunded exactly once (four refund requests, one per booking), amounts equal to each customer_amount', all.length === 4 && all.every(a => Number(a.refunded_amount) === Number(a.customer_amount)) && reqsAll.length === 4 && new Set(reqsAll.map(r => r.booking_id)).size === 4, JSON.stringify({ all, reqs: reqsAll.length }));
  }

  console.log('\nR2-2 under_review whose case creation failed: the worker opens it; deny resolves it; grant on an uncharged booking is refused');
  {
    const u = await seed({ days: 8 });
    const broke = await db(`bookings?id=eq.${u.id}`, { method: 'PATCH', body: JSON.stringify({ start_at: null, timezone: 'Not/AZone' }) });
    ok('fixture corruption applied (start unresolvable)', broke.status < 300);
    spy.faults.push({ url: '/rpc/_open_case', method: 'POST', status: 500, message: 'injected_case_service_down', once: true });
    const c = await cancel(u.id);
    ok('cancel: 200 under_review, the case NOT recorded (refund_review_recorded false), the decision row under_review', c.statusCode === 200 && c.body.refund_status === 'under_review' && c.body.refund_review_recorded === false && (await decisionRows(u.id))[0].status === 'under_review' && !(await caseOf(u.id)), `${c.statusCode} ${JSON.stringify(c.body).slice(0, 200)}`);
    spy.faults.length = 0;
    const wk = await worker();
    const cs = await caseOf(u.id);
    ok('the refund worker sweep opened the missing case (cancellation_cases_opened 1), kind refund_requires_review, open, opened_by the sweep', wk.statusCode === 200 && wk.body.cancellation_cases_opened === 1 && cs && cs.kind === 'refund_requires_review' && cs.status !== 'resolved' && cs.details && cs.details.opened_by === 'refund_worker_sweep', JSON.stringify({ wk: wk.body && { checked: wk.body.cancellation_reviews_checked, opened: wk.body.cancellation_cases_opened, failed: wk.body.cancellation_cases_failed }, cs }));
    if (cs) track('reconciliation_cases', cs.id);
    const wk2 = await worker();
    ok('a second run opens nothing more (the case exists)', wk2.statusCode === 200 && wk2.body.cancellation_cases_opened === 0, JSON.stringify(wk2.body && { opened: wk2.body.cancellation_cases_opened }));
    const r0 = stripeRefundCalls();
    const grant = await review({ action: 'grant', booking_id: u.id, reason: 'try to refund an uncharged booking' });
    ok('grant on a booking with no ledger charge: 409 refund_not_possible, no resolution, the case still open, zero Stripe', grant.statusCode === 409 && grant.body.error === 'refund_not_possible' && (await resolutionRows(u.id)).length === 0 && (await caseOf(u.id)).status !== 'resolved' && stripeRefundCalls() === r0, `${grant.statusCode} ${JSON.stringify(grant.body).slice(0, 160)}`);
    const m0 = spy.calls.resend.length;
    const deny = await review({ action: 'deny', booking_id: u.id, reason: 'the demo time was never valid; fee kept per policy' });
    const res = await resolutionRows(u.id); const cs2 = await caseOf(u.id);
    ok('deny: 200, one no_refund resolution linked to the case, the case resolved by the operator, no money moved', deny.statusCode === 200 && deny.body.outcome === 'resolved' && res.length === 1 && res[0].decision === 'no_refund' && res[0].case_id === cs.id && cs2.status === 'resolved' && cs2.resolved_by === staffEmail && stripeRefundCalls() === r0, `${deny.statusCode} ${JSON.stringify(deny.body).slice(0, 200)} ${JSON.stringify({ res, cs2 })}`);
    const mails = mailsSince(m0, /Refund decision/);
    ok('the brand was told the fee is not refunded (final)', mails.length === 1 && /not refunded/.test(text(mails[0])) && /final answer/.test(text(mails[0])), JSON.stringify(mails.map(m => m.subject)));
    const wk3 = await worker();
    ok('the sweep ignores a resolved under_review cancellation', wk3.statusCode === 200 && wk3.body.cancellation_cases_opened === 0);
    const again = await review({ action: 'deny', booking_id: u.id, reason: 'again' });
    ok('deny again: existing, no second mail', again.statusCode === 200 && again.body.existing === true && mailsSince(m0, /Refund decision/).length === 1, `${again.statusCode}`);
  }

  console.log('\nR2-2 refusals: a never-charged cancellation and a refunded one have nothing to resolve');
  {
    const np = await seed({ days: 10, payment_status: 'unpaid', pi: false, status: 'pending' });
    const c = await cancel(np.id);
    ok('unpaid cancel: not_paid', c.statusCode === 200 && c.body.refund_status === 'not_paid', `${c.statusCode} ${JSON.stringify(c.body).slice(0, 120)}`);
    const g = await review({ action: 'grant', booking_id: np.id, reason: 'x' });
    ok('grant on a not_paid decision with no ledger charge: 409 refund_not_possible, nothing claimed', g.statusCode === 409 && g.body.error === 'refund_not_possible' && (await resolutionRows(np.id)).length === 0, `${g.statusCode} ${JSON.stringify(g.body).slice(0, 120)}`);
    const notCancelled = await seed({ days: 11 });
    const g2 = await review({ action: 'deny', booking_id: notCancelled.id, reason: 'x' });
    ok('deny on a booking that is not cancelled: 409 not_cancelled', g2.statusCode === 409 && g2.body.error === 'not_cancelled', `${g2.statusCode} ${JSON.stringify(g2.body).slice(0, 120)}`);
    const anon = await callRoute('refund-review.js', req({ body: { action: 'grant', booking_id: np.id, reason: 'x' } }));
    ok('anonymous: 401', anon.statusCode === 401, `${anon.statusCode}`);
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
    const mvs = (await db(`booking_moves?booking_id=in.(${fxBookings.join(',')})&select=id`)).body || [];
    for (const m of mvs) await del(`reconciliation_cases?dedupe_key=eq.${encodeURIComponent('move_settle:' + m.id)}`);
    for (const t of ['booking_cancellation_resolutions', 'booking_cancellations', 'booking_moves', 'refund_operations', 'refund_requests', 'booking_fulfillments']) await del(`${t}?booking_id=in.(${fxBookings.join(',')})`);
  }
  await del(`brand_retailer_agreements?retailer_id=eq.${retailerId}`);
  await del(`notification_deliveries?retailer_id=eq.${retailerId}`);
  await del(`notification_events?retailer_id=eq.${retailerId}`);
  await del(`demos?retailer_id=eq.${retailerId}`);
  await del(`brand_account_sessions?brand_id=eq.${brandId}`);
  await del(`admin_sessions?retailer_id=eq.${retailerId}`); await del(`admin_sessions?retailer_id=eq.${otherRetailerId}`);
  for (const [t, id] of bin.reverse()) if (t !== 'reconciliation_cases') await del(`${t}?id=eq.${id}`);
  clearTimeout(watchdog);
  spy.restore();
}
process.exit(summary('refund cutoff concurrency and resolution') ? 0 : 1);
