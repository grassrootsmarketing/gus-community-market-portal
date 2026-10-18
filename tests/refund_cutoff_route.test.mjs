// tests/refund_cutoff_route.test.mjs, the 72-hour refund rule THROUGH the real cancel route (David, 2026-10-18).
//
// tests/refund_cutoff.test.mjs pins the pure decision offline. This file proves api/booking-action.js honours it
// against the test database (demohub-rebuild-check): a real retailer session, real bookings rows, Stripe and
// Resend spied. The fixture bookings are seeded as paid WITHOUT a payment allocation on purpose: when the decision
// says "refund", the ledger reservation (refund_reserve_cas) answers no_allocation and the route reports
// refund_failed with ZERO Stripe calls, which is exactly the evidence wanted here, "the refund step was reached"
// versus "it was not". The full refund with a real allocation is proven in tests/route_flows.test.mjs, whose
// cancel no longer passes force_refund (a 30-days-out demo refunds on the rule alone).
//
//   inside the window  (tomorrow)         paid, refundable      -> pending_manual, inside_cutoff, no Stripe, still paid
//   outside the window (10 days)          paid, refundable      -> refund step reached (outside_cutoff)
//   non_refundable, 12 days out           paid                  -> pending_manual, non_refundable, no Stripe
//   non_refundable + Refund anyway        paid                  -> refund step reached (forced)
//   inside the window + Refund anyway     paid, refundable      -> refund step reached (forced)
//   unpaid, 14 days out                   pending               -> not_paid, nothing touched
//   fee-waived (booking code), 15 days    confirmed, waived     -> not_paid (fee_waived) even with Refund anyway
//   legacy 14_day_refund stored, 5 days   paid                  -> refund step reached (the 72-hour rule, not 14 days)
//   the brand's cancellation email says why there was no automatic refund
//   /api/admin PATCH refuses a cancellation_mode the server does not read (14_day_refund, junk); accepts the two
import { installSpy, callRoute, req, ok, summary, uniq, ENV } from './_route.mjs';
import { HOURLY } from './_fixture_availability.mjs';

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
const watchdog = setTimeout(() => { console.log('  FAIL watchdog: suite exceeded 4 minutes'); process.exit(1); }, 4 * 60 * 1000);

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
const brandId = track('brands', one(await db('brands', { method: 'POST', body: JSON.stringify({ email: brandEmail, company_name: 'Cutoff Brand', contact_name: 'Cutoff Contact', phone: '555-0172', is_verified: true }) })).id);
ok('fixtures: retailer, venue, staff session and brand exist', !!retailerId && !!venueId && !!cookie && !!brandId);

let seedN = 0;
async function seed({ days, status = 'confirmed', payment_status = 'paid', pi = true, fee_waived = false }) {
  const time = `${9 + (seedN++ % 10)}:00`;
  const r = await db('bookings', { method: 'POST', body: JSON.stringify({
    retailer_id: retailerId, venue_id: venueId, brand_id: brandId, brand_name: 'Cutoff Brand', contact_name: 'Cutoff Contact', contact_email: brandEmail,
    product: 'Samples', demo_date: dayP(days), demo_time: time, status, payment_status,
    payment_intent_id: pi ? 'pi_' + uniq('rc') : null, fee_waived }) });
  const b = one(r);
  if (!b || !b.id) throw new Error('seed failed: ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 200));
  track('bookings', b.id);
  return b;
}
const setMode = async (mode) => { const r = await db(`retailers?id=eq.${retailerId}`, { method: 'PATCH', body: JSON.stringify({ cancellation_mode: mode }) }); if (r.status >= 400) throw new Error('setMode ' + r.status); };
const cancel = (booking_id, extra = {}) => callRoute('booking-action.js', req({ body: { action: 'cancel', booking_id, ...extra }, cookies: { dh_retailer_session: cookie } }));
const row = async (id) => one(await db(`bookings?id=eq.${id}&select=status,payment_status,cancelled_at`));
const stripeRefundCalls = () => spy.calls.stripe.filter(c => /\/refunds/.test(c.url)).length;
const stripeCalls = () => spy.calls.stripe.length;
const lastBrandMail = () => [...spy.calls.resend].reverse().find(m => /was cancelled/.test(String(m.subject || '')));

try {
  console.log('\nInside the window: no automatic refund');
  {
    const b = await seed({ days: 1 });
    const s0 = stripeCalls(); const m0 = spy.calls.resend.length;
    const r = await cancel(b.id);
    ok('cancel of a paid demo tomorrow: 200, cancelled, refund_status pending_manual, refund_reason inside_cutoff',
      r.statusCode === 200 && r.body.ok === true && r.body.refund_status === 'pending_manual' && r.body.refund_reason === 'inside_cutoff', `${r.statusCode} ${JSON.stringify(r.body).slice(0, 240)}`);
    ok('the response reports fewer than 72 hours before the demo', typeof r.body.hours_before_demo === 'number' && r.body.hours_before_demo < 72 && r.body.hours_before_demo > -24, String(r.body.hours_before_demo));
    ok('ZERO Stripe calls (no reservation, no refund)', stripeCalls() === s0, `${s0} -> ${stripeCalls()}`);
    const after = await row(b.id);
    ok('the booking is cancelled and its payment is untouched (still paid, no refund_pending)', after && after.status === 'cancelled' && after.payment_status === 'paid' && !!after.cancelled_at, JSON.stringify(after));
    const mail = lastBrandMail();
    ok('the brand\'s cancellation email says the cancellation came inside the 72-hour window', spy.calls.resend.length > m0 && !!mail && /inside the 72-hour window/.test(mail.html) && !/refund request was submitted/i.test(mail.html), mail ? mail.html.replace(/<[^>]+>/g, ' ').slice(0, 300) : 'no mail');
    ok('no refund_requests row exists for it', ((await db(`refund_requests?booking_id=eq.${b.id}&select=id`)).body || []).length === 0);
  }

  console.log('\nOutside the window: the refund step is reached on the rule alone');
  {
    const b = await seed({ days: 10 });
    const s0 = stripeCalls();
    const r = await cancel(b.id);
    ok('cancel of a paid demo 10 days out, NO force_refund: refund_reason outside_cutoff and the refund step ran (refund_failed here: the fixture has no allocation)',
      r.statusCode === 200 && r.body.refund_reason === 'outside_cutoff' && r.body.refund_status === 'refund_failed', `${r.statusCode} ${JSON.stringify(r.body).slice(0, 240)}`);
    ok('the response reports at least 72 hours before the demo', r.body.hours_before_demo >= 72, String(r.body.hours_before_demo));
    ok('the ledger refused before Stripe (zero Stripe calls, no money moved blindly)', stripeCalls() === s0, `${s0} -> ${stripeCalls()}`);
    const after = await row(b.id);
    ok('the booking is cancelled with payment_status refund_pending (durable, retryable by the worker / operator review)', after && after.status === 'cancelled' && after.payment_status === 'refund_pending', JSON.stringify(after));
  }

  console.log('\nNon_refundable: never automatic, force still refunds');
  {
    await setMode('non_refundable');
    const b = await seed({ days: 12 });
    const s0 = stripeCalls();
    const r = await cancel(b.id);
    ok('non_refundable, 12 days out: pending_manual with reason non_refundable', r.statusCode === 200 && r.body.refund_status === 'pending_manual' && r.body.refund_reason === 'non_refundable', `${r.statusCode} ${JSON.stringify(r.body).slice(0, 200)}`);
    ok('zero Stripe calls, booking cancelled and still paid', stripeCalls() === s0 && (await row(b.id)).payment_status === 'paid' && (await row(b.id)).status === 'cancelled');
    const mail = lastBrandMail();
    ok('the brand\'s email says the policy is non-refundable', !!mail && /non-refundable/.test(mail.html), mail ? mail.html.replace(/<[^>]+>/g, ' ').slice(0, 300) : 'no mail');
    const b2 = await seed({ days: 13 });
    const r2 = await cancel(b2.id, { force_refund: true });
    ok('non_refundable + "Refund the brand anyway": reason forced, the refund step ran', r2.statusCode === 200 && r2.body.refund_reason === 'forced' && r2.body.refund_status === 'refund_failed', `${r2.statusCode} ${JSON.stringify(r2.body).slice(0, 200)}`);
    await setMode('refundable');
  }

  console.log('\nInside the window + "Refund the brand anyway"');
  {
    const b = await seed({ days: 1 });
    const r = await cancel(b.id, { force_refund: true });
    ok('refundable, tomorrow, force_refund true: reason forced, the refund step ran', r.statusCode === 200 && r.body.refund_reason === 'forced' && r.body.refund_status === 'refund_failed' && r.body.hours_before_demo < 72, `${r.statusCode} ${JSON.stringify(r.body).slice(0, 200)}`);
    const b2 = await seed({ days: 1 });
    const r2 = await cancel(b2.id, { force_refund: 'yes' });
    ok('force_refund must be the boolean true: a truthy string does not force (inside_cutoff, pending_manual)', r2.statusCode === 200 && r2.body.refund_reason === 'inside_cutoff' && r2.body.refund_status === 'pending_manual', `${r2.statusCode} ${JSON.stringify(r2.body).slice(0, 200)}`);
  }

  console.log('\nUnpaid and fee-waived bookings never reach a refund');
  {
    const u = await seed({ days: 14, status: 'pending', payment_status: 'unpaid', pi: false });
    const s0 = stripeCalls();
    const r = await cancel(u.id);
    ok('unpaid pending booking: cancelled, refund_status not_paid, reason not_paid, zero Stripe', r.statusCode === 200 && r.body.refund_status === 'not_paid' && r.body.refund_reason === 'not_paid' && stripeCalls() === s0 && (await row(u.id)).status === 'cancelled', `${r.statusCode} ${JSON.stringify(r.body).slice(0, 200)}`);
    const w = await seed({ days: 15, payment_status: 'waived', pi: false, fee_waived: true });
    const r2 = await cancel(w.id, { force_refund: true });
    ok('fee-waived (booking code) confirmed booking, even with Refund anyway: not_paid, zero Stripe, cancelled', r2.statusCode === 200 && r2.body.refund_status === 'not_paid' && stripeCalls() === s0 && (await row(w.id)).status === 'cancelled', `${r2.statusCode} ${JSON.stringify(r2.body).slice(0, 200)}`);
    const w2 = await seed({ days: 16, fee_waived: true });
    const r3 = await cancel(w2.id, { force_refund: true });
    ok('a fee-waived row that reads as paid (defensive): reason fee_waived, not_paid, zero Stripe', r3.statusCode === 200 && r3.body.refund_status === 'not_paid' && r3.body.refund_reason === 'fee_waived' && stripeCalls() === s0, `${r3.statusCode} ${JSON.stringify(r3.body).slice(0, 200)}`);
  }

  console.log('\nThe legacy stored value reads as the 72-hour rule');
  {
    await setMode('14_day_refund');   // direct write: the admin route refuses this value now, but existing rows carry it
    const b = await seed({ days: 5 });
    const r = await cancel(b.id);
    ok('14_day_refund stored, demo 5 days out: outside_cutoff and the refund step ran (the old rule would have parked it as inside 14 days)', r.statusCode === 200 && r.body.refund_reason === 'outside_cutoff' && r.body.refund_status === 'refund_failed', `${r.statusCode} ${JSON.stringify(r.body).slice(0, 200)}`);
    await setMode('refundable');
  }

  console.log('\n/api/admin PATCH stores only the two modes the server reads');
  {
    const admin = async (body) => { const r = await callRoute('admin.js', req({ method: 'PATCH', query: { table: 'retailers', id: retailerId }, body, cookies: { dh_retailer_session: cookie } })); if (typeof r.body === 'string') { try { r.body = JSON.parse(r.body); } catch (_) {} } return r; };
    const junk = await admin({ cancellation_mode: 'free_for_all' });
    ok('an unknown cancellation_mode is refused 400 invalid_cancellation_mode', junk.statusCode === 400 && junk.body && junk.body.error === 'invalid_cancellation_mode', `${junk.statusCode} ${JSON.stringify(junk.body).slice(0, 160)}`);
    const legacy = await admin({ cancellation_mode: '14_day_refund' });
    ok('the legacy 14_day_refund is refused on write', legacy.statusCode === 400 && legacy.body.error === 'invalid_cancellation_mode', `${legacy.statusCode}`);
    const nr = await admin({ cancellation_mode: 'non_refundable', cancellation_policy: 'Demo fees are not refunded when a demo is cancelled, because the store orders product for you as soon as you book. Please cancel as early as you can so the slot can go to another brand. Reschedules are welcome anytime.' });
    const g1 = one(await db(`retailers?id=eq.${retailerId}&select=cancellation_mode,cancellation_policy`));
    ok('non_refundable plus its sentence saves (the admin page sends both together)', nr.statusCode === 200 && g1 && g1.cancellation_mode === 'non_refundable' && /not refunded/.test(g1.cancellation_policy || ''), `${nr.statusCode} ${JSON.stringify(g1)}`);
    const rf = await admin({ cancellation_mode: 'refundable', cancellation_policy: 'Cancel at least 72 hours before your demo for a refund. Inside 72 hours the fee is not refunded, because the store has usually already ordered product for you. Please cancel as early as you can, ideally a week ahead. Reschedules are welcome anytime.' });
    const g2 = one(await db(`retailers?id=eq.${retailerId}&select=cancellation_mode,cancellation_policy`));
    ok('back to refundable with the 72-hour sentence', rf.statusCode === 200 && g2 && g2.cancellation_mode === 'refundable' && /72 hours/.test(g2.cancellation_policy || ''), `${rf.statusCode} ${JSON.stringify(g2)}`);
  }
  ok('no Stripe refund was ever submitted by this suite', stripeRefundCalls() === 0, String(stripeRefundCalls()));
} catch (e) {
  ok('suite ran without an unexpected exception', false, String((e && e.stack) || e).slice(0, 600));
} finally {
  const del = async (p) => { const d = await db(p, { method: 'DELETE' }); if (d.status >= 400) console.log(`  teardown: DELETE ${p} -> ${d.status} ${JSON.stringify(d.body).slice(0, 160)}`); };
  const fxBookings = bin.filter(([t]) => t === 'bookings').map(([, id]) => id);
  if (fxBookings.length) for (const t of ['refund_operations', 'refund_requests', 'booking_fulfillments']) await del(`${t}?booking_id=in.(${fxBookings.join(',')})`);
  await del(`brand_retailer_agreements?retailer_id=eq.${retailerId}`);
  await del(`notification_deliveries?retailer_id=eq.${retailerId}`);
  await del(`notification_events?retailer_id=eq.${retailerId}`);
  await del(`demos?retailer_id=eq.${retailerId}`);
  for (const [t, id] of bin.reverse()) await del(`${t}?id=eq.${id}`);
  clearTimeout(watchdog);
  spy.restore();
}
process.exit(summary('refund cutoff route') ? 0 : 1);
