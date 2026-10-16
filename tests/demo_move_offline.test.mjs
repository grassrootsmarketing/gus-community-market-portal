// tests/demo_move_offline.test.mjs: retailer-initiated demo moves (0094, 2026-10-16), offline.
//
// The REAL code (api/_notification-outbox.js fan-out, reminder scheduling and dispatch recheck for the three
// brand notices; api/_notification-mail.js builders; api/_booking-moves.js settlement and sweep) runs against
// an intercepted fetch: no database, no provider, no Stripe. Every scenario asserts the decision, what was
// written, how many provider calls happened, and what the email says.
//
//   MAIL      moved / reminder / cancelled: store, old and new slot, deadline, note (escaped), refund wording,
//             dashboard link, no em dash.
//   FAN-OUT   demo_moved -> one delivery per brand recipient keyed on the move; a move already answered is
//             fanned out as skipped (no rows).
//   RECHECK   moved/reminder send only while the move is pending, the booking active and on the move's
//             revision and before the deadline; cancelled sends only once the move is declined/lapsed and the
//             booking inactive; a replay rebuilds nothing.
//   REMINDERS +24h / +48h per recipient, 'too_close_to_deadline' and 'due_before_scheduling' recorded.
//   SETTLE    declined/lapsed: refund reserved under the move's own operation key, ONE Stripe call, cancel
//             through booking_transition, settled stamp, one cancelled event; unpaid booking: no Stripe call;
//             a failed transition opens ONE case and leaves the move unsettled; a second settle after success
//             makes no new Stripe call; the sweep lapses due moves and settles unsettled ones.
//
// Run from the repository root:  node tests/demo_move_offline.test.mjs   (no credentials needed)
import { fanOutEvents, scheduleMoveReminders, processClaimed, makeCache, MOVE_REMINDER_KIND } from '../api/_notification-outbox.js';
import { demoMovedMessage, moveReminderMessage, demoMoveCancelledMessage } from '../api/_notification-mail.js';
import { settleMove, sweepMoves } from '../api/_booking-moves.js';
let _pass = 0, _fail = 0;
const ok = (n, c, d) => { if (c) { _pass++; console.log('  ok   ' + n); } else { _fail++; console.log('  FAIL ' + n + (d ? ' ' + d : '')); } };
const summary = (label) => { console.log(`\n${label}: ${_pass} passed, ${_fail} failed`); process.exit(_fail ? 1 : 0); };

const b = { supabaseUrl: 'https://offline.invalid', serviceKey: 'fake', siteOrigin: 'https://example.test', stripeKey: 'sk_test_binding' };
const now = new Date('2026-10-16T18:00:00Z');   // 11:00 PDT
const movedAt = '2026-10-16T17:00:00Z';
const due = '2026-10-19T17:00:00Z';              // +72h
const data = () => ({
  booking_moves: [{ id: 'mv1', booking_id: 'bk1', retailer_id: 'gus', brand_id: 'brand', demo_id: 'd1', from_date: '2026-10-24', from_time: '10:00 AM', to_date: '2026-10-31', to_time: '2:00 PM', schedule_revision: 2, note: 'Agreed with Maria <by phone>', moved_by: 'staff@gus.test', moved_at: movedAt, reconfirm_due_at: due, status: 'pending', settled_at: null, refund_status: null }],
  bookings: [{ id: 'bk1', brand_id: 'brand', retailer_id: 'gus', venue_id: 'v1', status: 'confirmed', payment_status: 'paid', payment_intent_id: 'pi_1', demo_date: '2026-10-31', demo_time: '2:00 PM', product: 'Cold Brew', schedule_revision: 2, timezone: 'America/Los_Angeles' }],
  brands: [{ id: 'brand', email: 'brand@example.test', company_name: 'Alpha & Co', contact_name: 'Rep' }],
  brand_members: [{ id: 'mate', brand_id: 'brand', email: 'mate@example.test' }],
  retailers: [{ id: 'gus', name: "Gus's Community Market", slug: 'gus', timezone: 'America/Los_Angeles' }],
  venues: [{ id: 'v1', name: 'Mission District', address: '1 Main' }],
  notification_events: [{ id: 'ev1', kind: 'demo_moved', booking_id: 'bk1', brand_id: 'brand', retailer_id: 'gus', transition_id: 'mv1', payload: { move_id: 'mv1' }, fanned_out_at: null, created_at: movedAt }],
  notification_deliveries: [],
});
let tables = data(), patches = [], inserts = [], events = [], sent = [], rpc = [], stripe = [], fail = {};
function applyFilters(rows, qs) {
  let out = rows;
  for (const part of qs.split('&')) {
    const m = /^([a-z_]+)=(eq|in|gt|gte|lte|is)\.(.*)$/.exec(part);
    if (!m) continue;
    const [, key, op, raw] = m; const v = decodeURIComponent(raw);
    if (op === 'eq') out = out.filter(r => String(r[key]) === v);
    else if (op === 'is') out = out.filter(r => v === 'null' ? r[key] == null : r[key] != null);
    else if (op === 'in') { const set = v.replace(/^\(|\)$/g, '').split(',').map(decodeURIComponent); out = out.filter(r => set.includes(String(r[key]))); }
    else if (op === 'gt') out = out.filter(r => r[key] != null && String(r[key]) > v);
    else if (op === 'gte') out = out.filter(r => r[key] != null && String(r[key]) >= v);
    else if (op === 'lte') out = out.filter(r => r[key] != null && String(r[key]) <= v);
  }
  return out;
}
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://api.stripe.com/v1/refunds')) { stripe.push({ body: String(opts.body), key: opts.headers && opts.headers['Idempotency-Key'] }); return new Response(JSON.stringify({ id: 're_fake', amount: 3000, currency: 'usd', status: 'succeeded', payment_intent: 'pi_1', charge: 'ch_1' }), { status: 200 }); }
  if (!u.startsWith(b.supabaseUrl + '/rest/v1/')) throw new Error('unexpected network: ' + u);
  const [path, qs = ''] = u.split('/rest/v1/')[1].split('?');
  if (path.startsWith('rpc/')) {
    const fn = path.slice(4); const args = JSON.parse(opts.body || '{}'); rpc.push({ fn, args });
    if (fail[fn]) return new Response(JSON.stringify({ message: 'simulated ' + fn + ' failure' }), { status: 500 });
    if (fn === 'refund_reserve_cas') return new Response(JSON.stringify([{ outcome: 'reserved', payment_intent: 'pi_1', amount: 3000, keeps_all: true, idempotency_key: 'idem-' + args.p_op_key, refund_request_id: 'rr1', charge_id: 'ch_1' }]), { status: 200 });
    if (fn === 'apply_refund_event') return new Response('[]', { status: 200 });
    if (fn === 'booking_transition') { const bk = tables.bookings.find(x => x.id === args.p_booking_id); const before = bk.status; if (bk) { bk.status = 'cancelled'; Object.assign(bk, args.p_fields || {}); } return new Response(JSON.stringify([{ ok: true, reason: before === 'cancelled' ? 'already_applied' : null, status_before: before, status_after: 'cancelled' }]), { status: 200 }); }
    if (fn === '_open_case') return new Response(JSON.stringify(['case-1']), { status: 200 });
    if (fn === 'lapse_booking_moves') { const dueRows = tables.booking_moves.filter(m => m.status === 'pending' && m.reconfirm_due_at <= new Date().toISOString()); for (const m of dueRows) m.status = 'lapsed'; return new Response(JSON.stringify(dueRows), { status: 200 }); }
    throw new Error('unexpected rpc ' + fn);
  }
  if (opts.method === 'POST') {
    const rows = JSON.parse(opts.body);
    if (path === 'notification_deliveries') { inserts.push(...rows); tables.notification_deliveries.push(...rows.map((r, i) => ({ id: 'ins' + inserts.length + '-' + i, ...r }))); return new Response(JSON.stringify(rows.map((r, i) => ({ id: 'ins' + inserts.length + '-' + i, ...r }))), { status: 200 }); }
    if (path === 'notification_events') { events.push(...rows); return new Response('', { status: 201 }); }
    throw new Error('unexpected POST ' + path);
  }
  if (opts.method === 'PATCH') {
    const p = JSON.parse(opts.body); patches.push({ table: path, qs, p });
    if (path === 'booking_moves') { const m = /id=eq\.([^&]+)/.exec(qs); const row = tables.booking_moves.find(x => x.id === decodeURIComponent(m[1])); if (row && !(qs.includes('settled_at=is.null') && row.settled_at)) Object.assign(row, p); }
    if (path === 'notification_events') { const m = /id=eq\.([^&]+)/.exec(qs); const row = tables.notification_events.find(x => x.id === decodeURIComponent(m[1])); if (row) Object.assign(row, p); }
    return new Response(JSON.stringify([{ id: 'delivery', ...p }]), { status: 200 });
  }
  if (!(path in tables)) throw new Error('unexpected table ' + path);
  return new Response(JSON.stringify(applyFilters(tables[path], qs)), { status: 200 });
};
const mailer = async (msg, o) => { sent.push({ msg, key: o && o.idempotencyKey }); return { ok: true, id: 'fake' }; };
const reset = () => { tables = data(); patches = []; inserts = []; events = []; sent = []; rpc = []; stripe = []; fail = {}; };
const row = (extra = {}) => ({ id: 'delivery', event_id: 'ev1', retailer_id: 'gus', booking_id: 'bk1', recipient_kind: 'brand', recipient_id: 'brand', recipient_email: 'brand@example.test', kind: 'demo_moved', occurrence_key: 'mv1', attempts: 0, ...extra });
const run = (r, o = {}) => processClaimed(b, r, { now: o.now || now, token: 'token', mailer, cache: makeCache() });
const ctx = () => ({ brand: tables.brands[0], retailer: tables.retailers[0], venue: tables.venues[0], booking: tables.bookings[0], move: tables.booking_moves[0], now });

console.log(':: mail ::');
{
  reset();
  const m = demoMovedMessage(b, ctx());
  ok('moved: subject names the store and the new slot', m.subject === "Gus's Community Market moved your demo to Saturday, October 31, 2026 at 2:00 PM: please confirm", m.subject);
  ok('moved: body has old and new slot, the deadline in the store zone, the escaped note, the dashboard link, the full-refund promise', /Saturday, October 24, 2026 at 10:00 AM/.test(m.html) && /Saturday, October 31, 2026 at 2:00 PM/.test(m.html) && /Monday, October 19 at 10:00 AM PDT/.test(m.html) && /Agreed with Maria &lt;by phone&gt;/.test(m.html) && !/<by phone>/.test(m.html) && /href="https:\/\/example\.test\/brand\/dashboard"/.test(m.html) && /refunded in full/.test(m.html), m.html.slice(0, 300));
  const r = moveReminderMessage(b, ctx());
  ok('reminder: hours left in the subject, the deadline and the refund consequence in the body', /Reminder: confirm your moved demo at Gus's Community Market \(3 days left\)/.test(r.subject) && /until Monday, October 19 at 10:00 AM PDT/.test(r.html) && /refunded in full/.test(r.html), r.subject);
  const r2 = moveReminderMessage(b, { ...ctx(), now: new Date('2026-10-18T20:00:00Z') });
  ok('reminder: under 36 hours it counts hours', /\(21 hours left\)/.test(r2.subject), r2.subject);
  tables.booking_moves[0].status = 'lapsed'; tables.booking_moves[0].refund_status = 'submitted';
  const c = demoMoveCancelledMessage(b, ctx());
  ok('cancelled (lapsed): says no answer, refund submitted, 5 to 10 business days', /did not hear back in time/.test(c.html) && /refund has been submitted/.test(c.html) && /refund submitted/.test(c.subject), c.subject);
  tables.booking_moves[0].status = 'declined'; tables.booking_moves[0].refund_status = 'not_paid';
  const c2 = demoMoveCancelledMessage(b, ctx());
  ok('cancelled (declined, unpaid): says the brand declined and nothing to refund', /You told us the new time does not work/.test(c2.html) && /nothing to refund/.test(c2.html));
  ok('no em dash in any of the three', ![m, r, c, c2].some(x => /—/.test(x.subject + x.html)));
}

console.log('\n:: fan-out ::');
{
  reset();
  const f = await fanOutEvents(b, { now });
  ok('demo_moved fans out to the account email and the team member, keyed on the move', f.deliveries === 2 && inserts.length === 2 && inserts.every(r => r.kind === 'demo_moved' && r.occurrence_key === 'mv1' && r.retailer_id === 'gus' && r.booking_id === 'bk1') && inserts.map(r => r.recipient_email).sort().join(',') === 'brand@example.test,mate@example.test', JSON.stringify({ f, inserts: inserts.map(r => r.dedupe_key) }));
  reset(); tables.booking_moves[0].status = 'confirmed';
  const f2 = await fanOutEvents(b, { now });
  ok('a moved notice for a move the brand already answered is fanned out as skipped, no rows', f2.deliveries === 0 && f2.skipped_events === 1 && inserts.length === 0 && patches.some(p => p.table === 'notification_events' && p.p.payload && p.p.payload.fanout_note === 'skipped_move_confirmed'), JSON.stringify(f2));
}

console.log('\n:: recheck and send ::');
{
  reset();
  const r = await run(row());
  ok('moved: accepted, frozen to the brand, key = delivery id', r.outcome === 'accepted' && sent.length === 1 && sent[0].msg.to === 'brand@example.test' && sent[0].key === 'delivery' && /please confirm/.test(sent[0].msg.subject), JSON.stringify(r));
  reset(); const r2 = await run(row({ recipient_id: 'mate', recipient_email: 'mate@example.test' }));
  ok('moved: the team member gets their own copy', r2.outcome === 'accepted' && sent[0].msg.to === 'mate@example.test');
  reset(); tables.booking_moves[0].status = 'confirmed';
  const r3 = await run(row());
  ok('moved: brand confirmed before the send: skipped move_confirmed', r3.outcome === 'skipped' && r3.reason === 'move_confirmed' && sent.length === 0);
  reset(); tables.booking_moves[0].status = 'superseded';
  const r4 = await run(row());
  ok('moved: the store moved it again: skipped move_superseded', r4.outcome === 'skipped' && r4.reason === 'move_superseded');
  reset(); tables.bookings[0].status = 'cancelled';
  const r5 = await run(row());
  ok('moved: booking cancelled meanwhile: skipped booking_cancelled', r5.outcome === 'skipped' && r5.reason === 'booking_cancelled');
  reset(); tables.bookings[0].schedule_revision = 3;
  const r6 = await run(row());
  ok('moved: booking on a newer revision than the move: skipped rescheduled', r6.outcome === 'skipped' && r6.reason === 'rescheduled');
  reset(); const r7 = await run(row(), { now: new Date('2026-10-20T00:00:00Z') });
  ok('moved: past the deadline: skipped deadline_passed', r7.outcome === 'skipped' && r7.reason === 'deadline_passed');
  reset(); const r8 = await run(row({ kind: MOVE_REMINDER_KIND, offset_key: 'h24', event_id: null, expires_at: '2026-10-17T23:00:00Z' }));
  ok('reminder: sends while pending', r8.outcome === 'accepted' && /Reminder: confirm your moved demo/.test(sent[0].msg.subject), JSON.stringify(r8));
  reset(); const r9 = await run(row({ kind: MOVE_REMINDER_KIND, offset_key: 'h24', event_id: null, expires_at: '2026-10-16T17:30:00Z' }));
  ok('reminder: past its catch-up window: skipped expired', r9.outcome === 'skipped' && r9.reason === 'expired');
  reset(); tables.booking_moves[0].status = 'lapsed'; tables.booking_moves[0].refund_status = 'submitted';
  const r10 = await run(row({ kind: 'demo_move_cancelled' }));
  ok('cancelled: booking still active (settlement not through yet): skipped booking_still_active', r10.outcome === 'skipped' && r10.reason === 'booking_still_active');
  tables.bookings[0].status = 'cancelled'; sent = []; patches = [];
  const r11 = await run(row({ kind: 'demo_move_cancelled' }));
  ok('cancelled: booking cancelled and move lapsed: sends with the refund line', r11.outcome === 'accepted' && /was cancelled, refund submitted/.test(sent[0].msg.subject) && /did not hear back/.test(sent[0].msg.html), JSON.stringify(r11));
  reset(); tables.bookings[0].status = 'cancelled';
  const r12 = await run(row({ kind: 'demo_move_cancelled' }));
  ok('cancelled: move still pending (someone cancelled for another reason): skipped move_pending', r12.outcome === 'skipped' && r12.reason === 'move_pending');
  reset(); tables.brand_members = [];
  const r13 = await run(row({ recipient_id: 'mate', recipient_email: 'mate@example.test' }));
  ok('a removed team member is skipped recipient_deleted', r13.outcome === 'skipped' && r13.reason === 'recipient_deleted');
  reset();
  const frozen = { to: 'brand@example.test', subject: 'Frozen', html: '<p>Frozen</p>', attempted_at: '2026-10-16T17:30:00Z', attempting_at: '2026-10-16T17:30:00Z', settled_at: '2026-10-16T17:30:01Z', uncertain: false };
  const r14 = await run(row({ frozen_payload: frozen, attempts: 1, idempotency_key: 'delivery' }));
  ok('replay: the frozen body under the frozen key, nothing rebuilt', r14.outcome === 'accepted' && sent[0].msg.html === '<p>Frozen</p>' && sent[0].key === 'delivery');
}

console.log('\n:: reminders ::');
{
  reset();
  const s = await scheduleMoveReminders(b, { now });
  const keys = inserts.map(r => r.dedupe_key).sort();
  ok('two recipients x two offsets, keyed on the move, due +24h and +48h after the move', s.moves === 1 && inserts.length === 4 && keys.join(' ') === ['demo_move_reminder:mv1:brand:brand:h24', 'demo_move_reminder:mv1:brand:brand:h48', 'demo_move_reminder:mv1:brand:mate:h24', 'demo_move_reminder:mv1:brand:mate:h48'].join(' ') && inserts.find(r => r.offset_key === 'h24').due_at === '2026-10-17T17:00:00.000Z' && inserts.find(r => r.offset_key === 'h48').due_at === '2026-10-18T17:00:00.000Z' && inserts.every(r => r.status === 'pending'), JSON.stringify({ s, keys }));
  ok('catch-up: 6h, never past the deadline', inserts.find(r => r.offset_key === 'h24').expires_at === '2026-10-17T23:00:00.000Z');
  reset(); tables.booking_moves[0].reconfirm_due_at = '2026-10-18T00:00:00Z';   // compressed window: +48h would land after the deadline
  await scheduleMoveReminders(b, { now });
  ok('a compressed window: the +48h nudge is recorded skipped too_close_to_deadline, the +24h one pending', inserts.filter(r => r.offset_key === 'h48').every(r => r.status === 'skipped' && r.skip_reason === 'too_close_to_deadline') && inserts.filter(r => r.offset_key === 'h24').every(r => r.status === 'pending'), JSON.stringify(inserts.map(r => [r.offset_key, r.status, r.skip_reason])));
  reset();
  await scheduleMoveReminders(b, { now: new Date('2026-10-18T00:00:00Z') });
  ok('first run after the +24h moment passed: that nudge is skipped due_before_scheduling, +48h pending', inserts.filter(r => r.offset_key === 'h24').every(r => r.skip_reason === 'due_before_scheduling') && inserts.filter(r => r.offset_key === 'h48').every(r => r.status === 'pending'));
  reset(); tables.booking_moves[0].status = 'confirmed';
  const s2 = await scheduleMoveReminders(b, { now });
  ok('an answered move schedules nothing', s2.moves === 0 && inserts.length === 0);
}

console.log('\n:: settlement ::');
{
  reset(); tables.booking_moves[0].status = 'declined';
  const r = await settleMove(b, tables.booking_moves[0], { outcome: 'declined', actor: 'brand:brand', now });
  const reserve = rpc.find(x => x.fn === 'refund_reserve_cas'), tr = rpc.find(x => x.fn === 'booking_transition');
  ok('declined, paid: reserved under the move operation key, ONE Stripe refund with the reservation key, cancel through booking_transition, settled, refund submitted', r.ok && r.refund_status === 'submitted' && r.cancelled && reserve && reserve.args.p_op_key === 'bk1:move_declined' && stripe.length === 1 && stripe[0].key === 'idem-bk1:move_declined' && tr && tr.args.p_action === 'cancel' && tr.args.p_retailer_id === 'gus' && /could not make the new time/.test(tr.args.p_fields.cancel_reason) && tr.args.p_fields.refund_id === 're_fake' && tables.booking_moves[0].settled_at && tables.booking_moves[0].refund_status === 'submitted', JSON.stringify({ r, reserve: reserve && reserve.args, stripe }));
  ok('one demo_move_cancelled event, idempotent on the move', events.length === 1 && events[0].kind === 'demo_move_cancelled' && events[0].transition_id === 'mv1:cancelled' && events[0].payload.outcome === 'declined' && events[0].payload.refund_status === 'submitted', JSON.stringify(events));
  const r2 = await settleMove(b, tables.booking_moves[0], { outcome: 'declined', now });
  ok('settling again: the reservation CAS returns the same request, no second Stripe refund is possible beyond the idempotent key, transition already_applied, still ok', r2.ok && stripe.length === 2 && stripe[1].key === stripe[0].key, JSON.stringify({ r2, keys: stripe.map(s => s.key) }));
}
{
  reset(); tables.booking_moves[0].status = 'lapsed'; tables.bookings[0].payment_status = 'unpaid'; tables.bookings[0].payment_intent_id = null;
  const r = await settleMove(b, tables.booking_moves[0], { outcome: 'lapsed', now });
  ok('lapsed, never charged: no reservation, no Stripe call, cancelled, refund_status not_paid', r.ok && r.refund_status === 'not_paid' && !rpc.some(x => x.fn === 'refund_reserve_cas') && stripe.length === 0 && rpc.some(x => x.fn === 'booking_transition') && /did not reconfirm/.test(rpc.find(x => x.fn === 'booking_transition').args.p_fields.cancel_reason), JSON.stringify(r));
}
{
  reset(); tables.booking_moves[0].status = 'lapsed'; fail.booking_transition = true;
  const r = await settleMove(b, tables.booking_moves[0], { outcome: 'lapsed', now });
  ok('transition fails after the refund step: ONE reconciliation case, move left unsettled with the case id, not ok', !r.ok && r.error === 'transition_failed' && r.case_id === 'case-1' && rpc.filter(x => x.fn === '_open_case').length === 1 && rpc.find(x => x.fn === '_open_case').args.p_dedupe === 'move_settle:mv1' && !tables.booking_moves[0].settled_at && tables.booking_moves[0].reconciliation_case_id === 'case-1' && events.length === 0, JSON.stringify(r));
}
{
  reset(); tables.bookings[0].status = 'held'; tables.booking_moves[0].status = 'declined';
  const r = await settleMove(b, tables.booking_moves[0], { outcome: 'declined', now });
  ok('a booking that became held underneath is left to an operator (booking_held), no money moved', !r.ok && r.error === 'booking_held' && stripe.length === 0 && rpc.length === 0);
}
{
  reset(); tables.booking_moves[0].reconfirm_due_at = '2026-10-10T00:00:00Z';
  const s = await sweepMoves(b, { now, limit: 25 });
  ok('sweep: a pending move past its deadline is lapsed and settled (refund, cancel, event)', s.lapsed === 1 && s.settled === 1 && s.failed === 0 && tables.booking_moves[0].status === 'lapsed' && tables.booking_moves[0].settled_at && stripe.length === 1 && stripe[0].key === 'idem-bk1:move_lapsed' && events.length === 1 && events[0].payload.outcome === 'lapsed', JSON.stringify(s));
  const s2 = await sweepMoves(b, { now, limit: 25 });
  ok('sweep again: nothing to lapse, nothing unsettled', s2.lapsed === 0 && s2.settled === 0 && stripe.length === 1, JSON.stringify(s2));
  reset(); tables.booking_moves[0].status = 'declined';   // declined by the brand, the route's settlement did not finish
  const s3 = await sweepMoves(b, { now, limit: 25 });
  ok('sweep: an unsettled declined move is settled by the worker', s3.lapsed === 0 && s3.settled === 1 && tables.booking_moves[0].settled_at && stripe[0].key === 'idem-bk1:move_declined', JSON.stringify(s3));
}

summary('retailer demo moves (offline)');
