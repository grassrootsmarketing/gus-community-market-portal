// tests/demo_move.test.mjs: retailer-initiated demo moves (0094, 2026-10-16) against the real test database
// (demohub-rebuild-check through tests/_route.mjs; Stripe and Resend spied).
//
// Proves, with real rows, the real RPCs and the real routes:
//   * the store moves a confirmed demo NOW (api/booking-action action 'move'): booking and demo on the new
//     slot, schedule revision +1, ONE pending move row with a 72h deadline, both events written
//     (demo_rescheduled for the store contacts, demo_moved for the brand), the old occurrence's deliveries
//     retired; a second move supersedes the first; refusals: anonymous, another retailer, past date, same
//     slot, a full slot, a brand whose COI does not cover the new date;
//   * the outbox fans the brand notice out and sends it once; the reminder rows are scheduled on the move;
//   * the brand dashboard data carries pending_move; the brand confirms (move confirmed, booking untouched),
//     a stale/foreign/answered move is refused;
//   * decline: the booking is cancelled and the move settled (unpaid fixture: refund_status not_paid), the
//     store contacts' demo_cancelled and the brand's demo_move_cancelled events exist;
//   * lapse: the worker step lapses a past-deadline move, cancels, settles, and the refund worker's run
//     reports it; a move whose settlement already happened is not touched again.
//
// Run from the repository root with test-database creds:  node tests/demo_move.test.mjs
import { callRoute, req, ok, summary, uniq, ENV, installSpy } from './_route.mjs';
import { HOURLY } from './_fixture_availability.mjs';
import { getBinding } from '../api/_env.js';
import { fanOutEvents, scheduleMoveReminders, dispatchDue } from '../api/_notification-outbox.js';
import { sweepMoves } from '../api/_booking-moves.js';

ENV.NOTIFICATION_WORKER_ENABLED = 'true';
ENV.RETAILER_MOVES_ENABLED = 'true';   // Codex RM-7: creation is behind a switch; the suite turns it on, and proves OFF below
const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  return { ok: r.ok, status: r.status, body: j };
};
const rpc = (fn, args) => db(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });
const one = (r) => (r && Array.isArray(r.body) ? r.body[0] : null);
const bin = [];
const track = (t, id) => { if (id) bin.push([t, id]); return id; };
const LA = 'America/Los_Angeles';
const RUN = uniq('mv');
const dayP = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const hours = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const spy = installSpy();

// ---- fixtures: one store (hourly slots, capacity 1), staff session, two brands, one other store ----
const slug = RUN;
const retailerId = track('retailers', one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug, name: 'Move Fixture Market', verification_status: 'approved', billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active', platform_keeps_all: true, timezone: LA, auto_confirm_bookings: false, cancellation_mode: 'refundable' }) })).id);
track('settings', one(await db('settings', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, demo_fee: 30, demo_duration: '3 hours', advance_booking_days: 14 }) })).id);
const V1 = track('venues', one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, name: 'Move Main', address: '1 Move Way', demo_fee: 30, availability: HOURLY, max_demos_per_slot: 1 }) })).id);
const staffEmail = `staff-${RUN}@fixture.test`;
track('retailer_admins', one(await db('retailer_admins', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, email: staffEmail, email_normalized: staffEmail, name: 'Move Staff', role: 'admin' }) })).id);
const staffTok = one(await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: staffEmail, retailer_id: retailerId }) }));
const staffCookie = (await callRoute('admin-auth.js', req({ body: { action: 'verify', token: staffTok.token } }))).cookie('dh_retailer_session');
const otherSlug = uniq('mvo');
const otherRetailerId = track('retailers', one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug: otherSlug, name: 'Other Market', billing_email: `${otherSlug}@fixture.test`, billing_tier: 'pro', billing_status: 'active', platform_keeps_all: true, timezone: LA }) })).id);
const otherStaff = `staff-${otherSlug}@fixture.test`;
track('retailer_admins', one(await db('retailer_admins', { method: 'POST', body: JSON.stringify({ retailer_id: otherRetailerId, email: otherStaff, email_normalized: otherStaff, name: 'Other Staff', role: 'admin' }) })).id);
const otherTok = one(await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: otherStaff, retailer_id: otherRetailerId }) }));
const otherCookie = (await callRoute('admin-auth.js', req({ body: { action: 'verify', token: otherTok.token } }))).cookie('dh_retailer_session');
const brandEmail = `${uniq('mvbrand')}@fixture.test`;
const brandId = track('brands', one(await db('brands', { method: 'POST', body: JSON.stringify({ email: brandEmail, company_name: 'Move Brand & Co', contact_name: 'Rep M', phone: '555-0100', default_coi_url: `brands/${RUN}.pdf`, default_coi_expires: dayP(60), coi_verification_status: 'approved' }) })).id);
const brandTok = one(await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: brandId, email: brandEmail, token: 'tk-' + RUN, expires_at: hours(1) }) }));
const brandCookie = (await callRoute('brand-account.js', req({ body: { action: 'verify', token: brandTok.token } }))).cookie('dh_brand_session');
const otherBrandEmail = `${uniq('mvbrand2')}@fixture.test`;
const otherBrandId = track('brands', one(await db('brands', { method: 'POST', body: JSON.stringify({ email: otherBrandEmail, company_name: 'Other Brand', default_coi_url: `brands/${RUN}-2.pdf`, default_coi_expires: dayP(400), coi_verification_status: 'approved' }) })).id);
const otherBrandTok = one(await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: otherBrandId, email: otherBrandEmail, token: 'tk2-' + RUN, expires_at: hours(1) }) }));
const otherBrandCookie = (await callRoute('brand-account.js', req({ body: { action: 'verify', token: otherBrandTok.token } }))).cookie('dh_brand_session');
await callRoute('find-retailer.js', req({ body: { action: 'status' } }));
const b = await getBinding();

async function confirmedBooking(demo_date, demo_time, extra = {}) {
  const res = await db('bookings', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, venue_id: V1, brand_id: brandId, brand_name: 'Move Brand & Co', contact_name: 'Rep M', contact_phone: '555-0100', contact_email: brandEmail, product: 'Cold Brew', demo_date, demo_time, status: 'confirmed', payment_status: 'paid', amount_paid: 3000, ...extra }) });
  const row = one(res);
  if (!row) throw new Error('booking insert failed: ' + res.status + ' ' + JSON.stringify(res.body).slice(0, 300));
  track('bookings', row.id);
  await db(`notification_events?booking_id=eq.${row.id}&kind=eq.owner_booking_created`, { method: 'PATCH', body: JSON.stringify({ fanned_out_at: new Date().toISOString() }) });
  let demo = one(await db(`demos?booking_id=eq.${row.id}&select=*`));
  if (!demo) { await rpc('booking_transition', { p_booking_id: row.id, p_retailer_id: retailerId, p_action: 'materialize', p_fields: {}, p_demo_fee: 30 }); demo = one(await db(`demos?booking_id=eq.${row.id}&select=*`)); }
  return { booking: row, demo };
}
const bookingRow = async (id) => one(await db(`bookings?id=eq.${id}&select=*`));
const demoRow = async (id) => one(await db(`demos?id=eq.${id}&select=*`));
const movesFor = async (bid) => (await db(`booking_moves?booking_id=eq.${bid}&select=*&order=moved_at.asc`)).body || [];
const eventsFor = async (bid, kind) => (await db(`notification_events?booking_id=eq.${bid}&kind=eq.${kind}&select=*&order=created_at.asc`)).body || [];
const deliveriesFor = async (bid, kind) => (await db(`notification_deliveries?booking_id=eq.${bid}&kind=eq.${kind}&select=*&order=due_at.asc`)).body || [];
const move = (body, cookie = staffCookie) => callRoute('booking-action.js', req({ body: { action: 'move', ...body }, cookies: cookie ? { dh_retailer_session: cookie } : {} }));
const respond = (body, cookie = brandCookie) => callRoute('brand-account.js', req({ body: { action: 'move-respond', ...body }, cookies: { dh_brand_session: cookie } }));
const brandData = async (cookie = brandCookie) => (await callRoute('brand-account.js', req({ method: 'GET', query: { action: 'data' }, cookies: { dh_brand_session: cookie } }))).body;

try {
  ok('fixtures exist', !!retailerId && !!V1 && !!brandId && !!staffCookie && !!brandCookie && !!b);

  console.log('\n:: the move ::');
  const D1 = dayP(20), D2 = dayP(22);
  const { booking: bk, demo } = await confirmedBooking(D1, '10:00');
  ok('fixture: a confirmed paid booking with a calendar demo', !!demo && demo.status === 'confirmed', JSON.stringify(demo && demo.status));
  const before = await bookingRow(bk.id);
  // a pending store-contact-style delivery on the OLD occurrence, to prove it gets retired
  const oldOcc = `${bk.id}:${before.schedule_revision == null ? 1 : before.schedule_revision}`;
  const retired = one(await db('notification_deliveries', { method: 'POST', body: JSON.stringify({ event_id: null, retailer_id: retailerId, booking_id: bk.id, recipient_kind: 'store_contact', recipient_id: null, recipient_email: 'x@fixture.test', kind: 'reminder', offset_key: 'd3', occurrence_key: oldOcc, dedupe_key: `reminder:${oldOcc}:store_contact:${RUN}:d3`, due_at: hours(24), status: 'pending', attempts: 0 }) }));
  ok('anonymous: 401', (await move({ demo_id: demo.id, new_date: D2, new_time: '11:00' }, null)).statusCode === 401);
  const foreign = await move({ demo_id: demo.id, new_date: D2, new_time: '11:00' }, otherCookie);
  ok('another retailer\'s staff: refused (403 or not found), nothing moved', [403, 404].includes(foreign.statusCode) && (await bookingRow(bk.id)).demo_date === D1, String(foreign.statusCode));
  const past = await move({ demo_id: demo.id, new_date: dayP(-2), new_time: '11:00' });
  ok('a past date: 400', past.statusCode === 400, JSON.stringify(past.body));
  const same = await move({ demo_id: demo.id, new_date: D1, new_time: '10:00' });
  ok('the same slot: 400 same_slot', same.statusCode === 400 && same.body.error === 'same_slot', JSON.stringify(same.body));
  const longNote = await move({ demo_id: demo.id, new_date: D2, new_time: '11:00', note: 'x'.repeat(501) });
  ok('a 501-character note: 400', longNote.statusCode === 400, JSON.stringify(longNote.body));
  const beyondCoi = await move({ demo_id: demo.id, new_date: dayP(90), new_time: '11:00' });
  ok('a date past the brand\'s COI expiry: 409 coi_not_covered, nothing moved', beyondCoi.statusCode === 409 && beyondCoi.body.error === 'coi_not_covered' && (await bookingRow(bk.id)).demo_date === D1, JSON.stringify(beyondCoi.body));
  // another brand's confirmed demo occupies D2 11:00 (capacity 1)
  const blocker = one(await db('bookings', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, venue_id: V1, brand_id: otherBrandId, brand_name: 'Other Brand', contact_email: otherBrandEmail, product: 'Chips', demo_date: D2, demo_time: '11:00', status: 'confirmed', payment_status: 'paid', amount_paid: 3000 }) }));
  track('bookings', blocker.id);
  await db(`notification_events?booking_id=eq.${blocker.id}&kind=eq.owner_booking_created`, { method: 'PATCH', body: JSON.stringify({ fanned_out_at: new Date().toISOString() }) });
  const full = await move({ demo_id: demo.id, new_date: D2, new_time: '11:00' });
  ok('a full slot: 409 slot_full, nothing moved', full.statusCode === 409 && full.body.error === 'slot_full' && (await bookingRow(bk.id)).demo_date === D1 && (await movesFor(bk.id)).length === 0, JSON.stringify(full.body));

  const mv = await move({ demo_id: demo.id, new_date: D2, new_time: '12:00', note: 'Agreed with Rep M by phone' });
  ok('the move: 200 with booking id, new slot, revision and a deadline', mv.statusCode === 200 && mv.body.ok === true && mv.body.booking_id === bk.id && mv.body.new_date === D2 && mv.body.move_id && mv.body.reconfirm_due_at, JSON.stringify(mv.body));
  const after = await bookingRow(bk.id), demoAfter = await demoRow(demo.id);
  ok('booking and demo on the new slot, revision +1, start_at recomputed', after.demo_date === D2 && /^12:00/.test(String(after.demo_time)) && after.schedule_revision === (before.schedule_revision == null ? 1 : before.schedule_revision) + 1 && demoAfter.demo_date === D2 && after.start_at && after.start_at !== before.start_at, JSON.stringify([after.demo_date, after.demo_time, after.schedule_revision, demoAfter.demo_date]));
  const moves1 = await movesFor(bk.id);
  const dueMs = new Date(moves1[0] && moves1[0].reconfirm_due_at).getTime() - Date.now();
  ok('one pending move row: old and new slot, note, staff email, deadline about 72h out', moves1.length === 1 && moves1[0].status === 'pending' && moves1[0].from_date === D1 && moves1[0].to_date === D2 && moves1[0].note === 'Agreed with Rep M by phone' && moves1[0].moved_by === staffEmail && moves1[0].schedule_revision === after.schedule_revision && dueMs > 71 * 3600e3 && dueMs <= 72 * 3600e3, JSON.stringify(moves1[0]));
  ok('events: demo_rescheduled (store contacts) and demo_moved (brand) written in the transaction', (await eventsFor(bk.id, 'demo_rescheduled')).length === 1 && (await eventsFor(bk.id, 'demo_moved')).length === 1 && (await eventsFor(bk.id, 'demo_moved'))[0].transition_id === moves1[0].id);
  ok('the old occurrence\'s pending delivery was retired (skipped rescheduled)', (one(await db(`notification_deliveries?id=eq.${retired.id}&select=status,skip_reason`)) || {}).skip_reason === 'rescheduled');
  ok('no mail was sent from the request path', spy.calls.resend.length === 0, String(spy.calls.resend.length));

  console.log('\n:: outbox: brand notice and reminders ::');
  const f = await fanOutEvents(b, { now: new Date() });
  const dMoved = await deliveriesFor(bk.id, 'demo_moved');
  ok('fan-out: one demo_moved delivery to the brand, keyed on the move', f.errors.length === 0 && dMoved.length === 1 && dMoved[0].recipient_email === brandEmail && dMoved[0].occurrence_key === moves1[0].id, JSON.stringify(dMoved.map(d => [d.recipient_email, d.status])));
  const n0 = spy.calls.resend.length;
  const dd = await dispatchDue(b, { now: new Date() });
  const sentMoved = spy.calls.resend.slice(n0).find(m => /moved your demo/.test(m.subject));
  // Non-production sends go to the sink; the original recipient is carried in the body banner.
  ok('dispatch: the brand gets "moved your demo ... please confirm" with the note and the deadline', dd.errors.length === 0 && sentMoved && String(sentMoved.html).includes(brandEmail) && /Agreed with Rep M by phone/.test(sentMoved.html) && /refunded in full/.test(sentMoved.html), JSON.stringify({ dd, subjects: spy.calls.resend.slice(n0).map(m => m.subject) }));
  const sr = await scheduleMoveReminders(b, { now: new Date() });
  const rem = await deliveriesFor(bk.id, 'demo_move_reminder');
  ok('reminders scheduled: +24h and +48h, pending', sr.errors.length === 0 && rem.length === 2 && rem.every(r => r.status === 'pending') && rem.map(r => r.offset_key).sort().join(',') === 'h24,h48', JSON.stringify(rem.map(r => [r.offset_key, r.status, r.due_at])));

  console.log('\n:: the brand answers ::');
  const data = await brandData();
  const mine = (data.demos || []).find(d => d.booking_id === bk.id);
  ok('brand data: the demo carries pending_move with id, slots, note and deadline', mine && mine.pending_move && mine.pending_move.id === moves1[0].id && mine.pending_move.from_date === D1 && mine.pending_move.to_date === D2 && mine.pending_move.note === 'Agreed with Rep M by phone' && mine.pending_move.reconfirm_due_at, JSON.stringify(mine && mine.pending_move));
  const wrongBrand = await respond({ move_id: moves1[0].id, decision: 'confirm' }, otherBrandCookie);
  ok('another brand cannot answer: 403', wrongBrand.statusCode === 403, JSON.stringify(wrongBrand.body));
  const bad = await respond({ move_id: moves1[0].id, decision: 'maybe' });
  ok('an invalid decision: 400', bad.statusCode === 400);
  const conf = await respond({ move_id: moves1[0].id, decision: 'confirm' });
  const mvConf = (await movesFor(bk.id))[0];
  ok('confirm: 200, move confirmed with a response stamp, booking untouched and still confirmed', conf.statusCode === 200 && conf.body.status === 'confirmed' && mvConf.status === 'confirmed' && mvConf.responded_at && (await bookingRow(bk.id)).status === 'confirmed', JSON.stringify(conf.body));
  const again = await respond({ move_id: moves1[0].id, decision: 'decline' });
  ok('answering again: 409 move_confirmed', again.statusCode === 409 && again.body.error === 'move_confirmed', JSON.stringify(again.body));
  const n1 = spy.calls.resend.length;
  await dispatchDue(b, { now: new Date(Date.now() + 25 * 3600e3) });
  {
    const remAfter = await deliveriesFor(bk.id, 'demo_move_reminder');
    const h24 = remAfter.find(r => r.offset_key === 'h24'), h48 = remAfter.find(r => r.offset_key === 'h48');
    ok('the +24h reminder that came due after the brand confirmed is skipped move_confirmed, not sent; the +48h one is simply not due yet', !spy.calls.resend.slice(n1).some(m => /Reminder: confirm your moved demo/.test(m.subject)) && h24 && h24.status === 'skipped' && h24.skip_reason === 'move_confirmed' && h48 && h48.status === 'pending', JSON.stringify(remAfter.map(r => [r.offset_key, r.status, r.skip_reason])));
  }

  console.log('\n:: a second move supersedes; the brand declines ::');
  const D3 = dayP(24);
  const mv2 = await move({ demo_id: demo.id, new_date: D3, new_time: '13:00' });
  ok('second move: 200', mv2.statusCode === 200, JSON.stringify(mv2.body));
  const mv3 = await move({ demo_id: demo.id, new_date: D3, new_time: '14:00' });
  const moves3 = await movesFor(bk.id);
  ok('third move before the brand answered the second: the second is superseded, one pending remains', mv3.statusCode === 200 && moves3.length === 3 && moves3[1].status === 'superseded' && moves3[2].status === 'pending', JSON.stringify(moves3.map(m => m.status)));
  const staleAnswer = await respond({ move_id: moves3[1].id, decision: 'confirm' });
  ok('answering the superseded move: 409 move_superseded', staleAnswer.statusCode === 409 && staleAnswer.body.error === 'move_superseded', JSON.stringify(staleAnswer.body));
  const dec = await respond({ move_id: moves3[2].id, decision: 'decline' });
  const bkDec = await bookingRow(bk.id), mvDec = (await movesFor(bk.id))[2];
  // Codex RM-2: this fixture is recorded as PAID with no payment intent, an inconsistent payment state. The
  // cancellation proceeds, the refund obligation is handed to an operator through ONE case, and the move says so.
  ok('decline: 200, the booking is cancelled, the move declined and settled with refund_status review_required and a reconciliation case (paid, no payment intent), reason recorded, message truthful', dec.statusCode === 200 && dec.body.status === 'declined' && dec.body.cancelled === true && bkDec.status === 'cancelled' && /could not make the new time/.test(bkDec.cancel_reason || '') && mvDec.status === 'declined' && mvDec.settled_at && mvDec.refund_status === 'review_required' && !!mvDec.reconciliation_case_id && /with our team for review/.test(dec.body.message) && bkDec.payment_status === 'refund_pending', JSON.stringify({ body: dec.body, bk: [bkDec.status, bkDec.payment_status], mv: [mvDec.status, mvDec.refund_status, mvDec.reconciliation_case_id] }));
  ok('the case is deduplicated: one reconciliation case for that move', (await db(`reconciliation_cases?id=eq.${mvDec.reconciliation_case_id}&select=id,kind,reason`)).body.length === 1 && (await db(`reconciliation_cases?dedupe_key=eq.${encodeURIComponent('move_refund:' + mvDec.id)}&select=id`)).body.length <= 1);
  ok('events: demo_cancelled (store contacts, from the status trigger) and demo_move_cancelled (brand)', (await eventsFor(bk.id, 'demo_cancelled')).length >= 1 && (await eventsFor(bk.id, 'demo_move_cancelled')).length === 1);
  ok('no Stripe refund call for a booking without a payment intent', !spy.calls.stripe.some(c => /refunds/.test(c.url)), JSON.stringify(spy.calls.stripe.map(c => c.url)));
  await fanOutEvents(b, { now: new Date() });
  const n2 = spy.calls.resend.length;
  await dispatchDue(b, { now: new Date() });
  const sentCancel = spy.calls.resend.slice(n2).find(m => /was cancelled/.test(m.subject));
  ok('the brand is emailed that the demo was cancelled because they declined', !!sentCancel && /You told us the new time does not work/.test(sentCancel.html), JSON.stringify(spy.calls.resend.slice(n2).map(m => m.subject)));

  console.log('\n:: lapse: the deadline passes with no answer ::');
  const { booking: bk2, demo: demo2 } = await confirmedBooking(dayP(30), '10:00');
  const mv4 = await move({ demo_id: demo2.id, new_date: dayP(31), new_time: '10:00' });
  ok('a move on the second booking', mv4.statusCode === 200, JSON.stringify(mv4.body));
  await db(`booking_moves?id=eq.${mv4.body.move_id}`, { method: 'PATCH', body: JSON.stringify({ reconfirm_due_at: hours(-1) }) });
  const sw = await sweepMoves(b, { now: new Date(), limit: 25 });
  const bk2After = await bookingRow(bk2.id), mv4After = one(await db(`booking_moves?id=eq.${mv4.body.move_id}&select=*`));
  ok('sweep: the move is lapsed and settled, the booking cancelled with the lapse reason', sw.lapsed >= 1 && sw.failed === 0 && mv4After.status === 'lapsed' && mv4After.settled_at && bk2After.status === 'cancelled' && /did not reconfirm/.test(bk2After.cancel_reason || ''), JSON.stringify({ sw, mv: [mv4After.status, mv4After.refund_status] }));
  const sw2 = await sweepMoves(b, { now: new Date(), limit: 25 });
  ok('sweep again: the settled move is not touched', !(await movesFor(bk2.id)).some(m => m.settled_at !== mv4After.settled_at) && sw2.failed === 0, JSON.stringify(sw2));
  const rw = await callRoute('refund-worker.js', req({ headers: { authorization: 'Bearer ' + ENV.CRON_SECRET } }));
  ok('the refund worker route runs the move sweep and reports it', rw.statusCode === 200 && rw.body && typeof rw.body.moves_lapsed === 'number' && typeof rw.body.moves_settled === 'number', JSON.stringify({ status: rw.statusCode, moves: [rw.body && rw.body.moves_lapsed, rw.body && rw.body.moves_settled, rw.body && rw.body.first_error] }));
  const lapsedAnswer = await respond({ move_id: mv4.body.move_id, decision: 'confirm' });
  ok('answering after the lapse: 409 move_lapsed', lapsedAnswer.statusCode === 409 && lapsedAnswer.body.error === 'move_lapsed', JSON.stringify(lapsedAnswer.body));
  const moveCancelled = await move({ demo_id: demo2.id, new_date: dayP(32), new_time: '10:00' });
  ok('moving a cancelled demo: 409 not_active', moveCancelled.statusCode === 409 && moveCancelled.body.error === 'not_active', JSON.stringify(moveCancelled.body));

  console.log('\n:: Codex RM-5: the deadline policy, exact values, and a late answer ::');
  // The scenarios below move demos past the 60-day certificate used for the coi_not_covered case above.
  await db(`brands?id=eq.${brandId}`, { method: 'PATCH', body: JSON.stringify({ default_coi_expires: dayP(400) }) });
  {
    const T0 = '2026-01-01T00:00:00+00:00';
    const dl = async (hoursAhead) => (await rpc('move_reconfirm_deadline', { p_now: T0, p_start: new Date(Date.parse(T0) + hoursAhead * 3600e3).toISOString(), p_hours: 72 })).body;
    const at = (h) => new Date(Date.parse(T0) + h * 3600e3).toISOString();
    const same = (a, h) => Date.parse(a) === Date.parse(at(h));
    ok('start +6h: the start itself; +18h and +30h and +36h: now + 12h; +96h: now + 72h; +9d: now + 72h', same(await dl(6), 6) && same(await dl(18), 12) && same(await dl(30), 12) && same(await dl(36), 12) && same(await dl(96), 72) && same(await dl(216), 72), JSON.stringify([await dl(6), await dl(18), await dl(30), await dl(36), await dl(96)]));
    ok('start +48h: start minus 24h (the 24h buffer wins over the window)', same(await dl(48), 24));
    const { demo: demo3, booking: bk3 } = await confirmedBooking(dayP(40), '10:00');
    const m3 = await move({ demo_id: demo3.id, new_date: dayP(41), new_time: '10:00' });
    ok('move for the late-answer case', m3.statusCode === 200, JSON.stringify(m3.body));
    await db(`booking_moves?id=eq.${m3.body.move_id}`, { method: 'PATCH', body: JSON.stringify({ reconfirm_due_at: hours(-0.5) }) });
    const late = await respond({ move_id: m3.body.move_id, decision: 'confirm' });
    const m3After = one(await db(`booking_moves?id=eq.${m3.body.move_id}&select=*`)), bk3After = await bookingRow(bk3.id);
    ok('a confirmation after the deadline is refused (409 move_lapsed), the move is lapsed with lapsed_at, and the route settled it: booking cancelled, move settled', late.statusCode === 409 && late.body.error === 'move_lapsed' && m3After.status === 'lapsed' && m3After.lapsed_at && m3After.settled_at && bk3After.status === 'cancelled' && bk3After.pending_move_settlement === null && /cancelled/.test(late.body.message), JSON.stringify({ late: late.body, mv: [m3After.status, m3After.refund_status] }));
  }

  console.log('\n:: Codex RM-1: a pending settlement blocks every schedule change, and a newer schedule retires an old move ::');
  {
    const { demo: demo4, booking: bk4 } = await confirmedBooking(dayP(45), '10:00');
    const m4 = await move({ demo_id: demo4.id, new_date: dayP(46), new_time: '10:00' });
    // the brand declines through the RPC alone (no settlement yet): exactly the window between decline and settle
    const dec = one(await rpc('respond_booking_move', { p_move_id: m4.body.move_id, p_brand_id: brandId, p_decision: 'decline', p_actor: 'test' }));
    const bk4Mid = await bookingRow(bk4.id);
    ok('decline recorded: the booking carries pending_move_settlement = the move', dec && dec.ok === true && bk4Mid.pending_move_settlement === m4.body.move_id && bk4Mid.status === 'confirmed', JSON.stringify(dec));
    const blockedMove = await move({ demo_id: demo4.id, new_date: dayP(47), new_time: '10:00' });
    ok('a new move while the cancellation is pending: 409 cancellation_pending', blockedMove.statusCode === 409 && blockedMove.body.error === 'cancellation_pending', JSON.stringify(blockedMove.body));
    const blockedPropose = await callRoute('booking-action.js', req({ body: { action: 'reschedule', demo_id: demo4.id, new_date: dayP(47), new_time: '10:00' }, cookies: { dh_retailer_session: staffCookie } }));
    ok('an ask-first proposal while the cancellation is pending: 409 cancellation_pending', blockedPropose.statusCode === 409 && blockedPropose.body.error === 'cancellation_pending', JSON.stringify(blockedPropose.body));
    const sw4 = await sweepMoves(b, { now: new Date(), limit: 25 });
    const bk4After = await bookingRow(bk4.id), m4After = one(await db(`booking_moves?id=eq.${m4.body.move_id}&select=*`));
    ok('the worker settles the decline: booking cancelled, pending settlement cleared, move settled', sw4.settled >= 1 && sw4.failed === 0 && bk4After.status === 'cancelled' && bk4After.pending_move_settlement === null && m4After.settled_at && m4After.status === 'declined', JSON.stringify({ sw4, mv: [m4After.status, m4After.refund_status] }));
    ok('exactly one brand cancellation event for that move', (await db(`notification_events?transition_id=eq.${m4.body.move_id}:cancelled&select=id`)).body.length === 1);

    // a brand-accepted proposal lands while a retailer move is still unanswered: the move is retired atomically
    const { demo: demo5, booking: bk5 } = await confirmedBooking(dayP(50), '10:00');
    const m5 = await move({ demo_id: demo5.id, new_date: dayP(51), new_time: '10:00' });
    const prop = await callRoute('booking-action.js', req({ body: { action: 'reschedule', demo_id: demo5.id, new_date: dayP(52), new_time: '11:00' }, cookies: { dh_retailer_session: staffCookie } }));
    ok('a proposal can follow an unanswered move', prop.statusCode === 200, JSON.stringify(prop.body));
    const acc = await callRoute('brand-account.js', req({ body: { action: 'reschedule-respond', demo_id: demo5.id, decision: 'accept', proposal_version: prop.body.proposal_version }, cookies: { dh_brand_session: brandCookie } }));
    const m5After = one(await db(`booking_moves?id=eq.${m5.body.move_id}&select=*`)), bk5After = await bookingRow(bk5.id);
    ok('the brand accepts the proposal: the booking is on the proposed slot and the unanswered move is superseded, never lapsed', acc.statusCode === 200 && bk5After.demo_date === dayP(52) && m5After.status === 'superseded', JSON.stringify({ acc: acc.body, mv: m5After.status }));
    await db(`booking_moves?id=eq.${m5.body.move_id}`, { method: 'PATCH', body: JSON.stringify({ reconfirm_due_at: hours(-1) }) });
    const sw5 = await sweepMoves(b, { now: new Date(), limit: 25 });
    ok('a sweep after that never cancels the newer schedule', (await bookingRow(bk5.id)).status === 'confirmed' && sw5.failed === 0, JSON.stringify(sw5));
  }

  console.log('\n:: Codex RM-1 / RM-4: races ::');
  {
    // lapse vs a new move, started together: exactly one of them wins
    const { demo: demo6, booking: bk6 } = await confirmedBooking(dayP(55), '10:00');
    const m6 = await move({ demo_id: demo6.id, new_date: dayP(56), new_time: '10:00' });
    await db(`booking_moves?id=eq.${m6.body.move_id}`, { method: 'PATCH', body: JSON.stringify({ reconfirm_due_at: hours(-1) }) });
    const [sw6, mv6b] = await Promise.all([sweepMoves(b, { now: new Date(), limit: 25 }), move({ demo_id: demo6.id, new_date: dayP(57), new_time: '10:00' })]);
    const bk6After = await bookingRow(bk6.id), moves6 = await movesFor(bk6.id);
    const lapsedWon = bk6After.status === 'cancelled', moveWon = mv6b.statusCode === 200;
    ok('lapse vs new move: exactly one winner, no pending move on a cancelled booking, no cancellation of a moved booking', (lapsedWon !== moveWon) && (!lapsedWon || !moves6.some(m => m.status === 'pending')) && (!moveWon || (bk6After.status === 'confirmed' && bk6After.demo_date === dayP(57) && moves6[0].status === 'superseded')) && sw6.failed === 0, JSON.stringify({ lapsedWon, moveWon, status: bk6After.status, moves: moves6.map(m => m.status), sw6 }));

    // confirm vs lapse at the deadline: both paths lapse; exactly one settlement, one event
    const { demo: demo7, booking: bk7 } = await confirmedBooking(dayP(60), '10:00');
    const m7 = await move({ demo_id: demo7.id, new_date: dayP(61), new_time: '10:00' });
    await db(`booking_moves?id=eq.${m7.body.move_id}`, { method: 'PATCH', body: JSON.stringify({ reconfirm_due_at: hours(-1) }) });
    const [c7, sw7] = await Promise.all([respond({ move_id: m7.body.move_id, decision: 'confirm' }), sweepMoves(b, { now: new Date(), limit: 25 })]);
    const m7After = one(await db(`booking_moves?id=eq.${m7.body.move_id}&select=*`)), bk7After = await bookingRow(bk7.id);
    ok('confirm vs lapse: the confirmation is refused, the move is lapsed and settled exactly once, the booking cancelled, one cancellation event', c7.statusCode === 409 && m7After.status === 'lapsed' && m7After.settled_at && bk7After.status === 'cancelled' && (await db(`notification_events?transition_id=eq.${m7.body.move_id}:cancelled&select=id`)).body.length === 1 && sw7.failed === 0, JSON.stringify({ c7: c7.body, sw7 }));

    // two settlement workers on the same declined move
    const { demo: demo8, booking: bk8 } = await confirmedBooking(dayP(65), '10:00');
    const m8 = await move({ demo_id: demo8.id, new_date: dayP(66), new_time: '10:00' });
    await rpc('respond_booking_move', { p_move_id: m8.body.move_id, p_brand_id: brandId, p_decision: 'decline', p_actor: 'test' });
    const [w1, w2] = await Promise.all([sweepMoves(b, { now: new Date(), limit: 25, owner: 'w1' }), sweepMoves(b, { now: new Date(), limit: 25, owner: 'w2' })]);
    const m8After = one(await db(`booking_moves?id=eq.${m8.body.move_id}&select=*`));
    ok('two workers: the move is settled exactly once (lease), one event, the booking cancelled once', (w1.settled + w2.settled) === 1 && w1.failed + w2.failed === 0 && m8After.settled_at && (await db(`notification_events?transition_id=eq.${m8.body.move_id}:cancelled&select=id`)).body.length === 1 && (await bookingRow(bk8.id)).status === 'cancelled', JSON.stringify({ w1, w2 }));
  }

  console.log('\n:: Codex RM-7: the creation switch ::');
  {
    const { demo: demo9 } = await confirmedBooking(dayP(70), '10:00');
    const m9 = await move({ demo_id: demo9.id, new_date: dayP(71), new_time: '10:00' });
    ok('a move exists before the switch is turned off', m9.statusCode === 200);
    ENV.RETAILER_MOVES_ENABLED = 'false';
    const off = await move({ demo_id: demo9.id, new_date: dayP(72), new_time: '10:00' });
    ok('switch off: a new move is refused with 503 retailer_moves_disabled', off.statusCode === 503 && off.body.error === 'retailer_moves_disabled', JSON.stringify(off.body));
    const dataOffRes = await callRoute('admin.js', req({ method: 'GET', query: { action: 'data' }, cookies: { dh_retailer_session: staffCookie } }));
    const dataOff = typeof dataOffRes.body === 'string' ? JSON.parse(dataOffRes.body) : dataOffRes.body;
    ok('switch off: the admin data says so (features.retailer_moves false)', dataOff && dataOff.features && dataOff.features.retailer_moves === false, JSON.stringify({ status: dataOffRes.statusCode, features: dataOff && dataOff.features, error: dataOff && dataOff.error }).slice(0, 300));
    const confOff = await respond({ move_id: m9.body.move_id, decision: 'confirm' });
    ok('switch off: the brand can still answer the existing move (confirm works)', confOff.statusCode === 200 && confOff.body.status === 'confirmed', JSON.stringify(confOff.body));
    const swOff = await sweepMoves(b, { now: new Date(), limit: 25 });
    ok('switch off: the sweep still runs clean', swOff.failed === 0 && !swOff.claim_failed && !swOff.read_failed, JSON.stringify(swOff));
    ENV.RETAILER_MOVES_ENABLED = 'true';
  }
} finally {
  console.log('\n:: teardown ::');
  for (const [t, id] of bin) {
    if (t !== 'bookings') continue;
    await db(`notification_deliveries?booking_id=eq.${id}`, { method: 'DELETE' });
    await db(`notification_events?booking_id=eq.${id}`, { method: 'DELETE' });
    await db(`booking_moves?booking_id=eq.${id}`, { method: 'DELETE' });
    await db(`refund_requests?booking_id=eq.${id}`, { method: 'DELETE' }).catch(() => {});
    await db(`demos?booking_id=eq.${id}`, { method: 'DELETE' });
  }
  await db(`notification_deliveries?dedupe_key=like.*${RUN}*`, { method: 'DELETE' });
  await db(`notification_events?brand_id=in.(${brandId},${otherBrandId})`, { method: 'DELETE' });
  await db(`brand_account_tokens?brand_id=in.(${brandId},${otherBrandId})`, { method: 'DELETE' });
  await db(`brand_sessions?brand_id=in.(${brandId},${otherBrandId})`, { method: 'DELETE' }).catch(() => {});
  await db(`admin_tokens?email=in.(${staffEmail},${otherStaff})`, { method: 'DELETE' });
  await db(`cron_heartbeat?cron_name=eq.refund-worker&summary->>moves_lapsed=not.is.null&ran_at=gte.${encodeURIComponent(new Date(Date.now() - 600e3).toISOString())}`, { method: 'DELETE' }).catch(() => {});
  for (const [t, id] of bin.reverse()) await db(`${t}?id=eq.${id}`, { method: 'DELETE' });
  spy.restore();
}
process.exit(summary('retailer demo moves (database)') ? 0 : 1);
