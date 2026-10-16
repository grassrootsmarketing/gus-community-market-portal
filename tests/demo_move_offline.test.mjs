// tests/demo_move_offline.test.mjs: retailer-initiated demo moves (0094 / 0095), offline.
//
// The REAL code (api/_notification-outbox.js fan-out, reminder scheduling and dispatch recheck for the three
// brand notices; api/_notification-mail.js builders; api/_booking-moves.js settlement and sweep;
// api/_booking-refund.js reservation checks) runs against an intercepted fetch: no database, no provider, no
// Stripe. Every scenario asserts the decision, what was written, how many provider calls happened, and what
// the email says. The database RPCs (claim / finalize / lapse) are modelled on their 0095 contracts; the real
// ones are exercised in tests/demo_move.test.mjs.
//
//   MAIL       moved / reminder / cancelled: store, old and new slot, deadline, note (escaped), refund wording.
//   FAN-OUT    demo_moved -> one delivery per brand recipient keyed on the move; an answered move: no rows.
//   RECHECK    moved/reminder send only while pending, active, on the move's revision, before the deadline;
//              cancelled only once declined/lapsed and inactive; a replay rebuilds nothing.
//   REMINDERS  +24h / +48h per recipient; too_close_to_deadline and due_before_scheduling recorded.
//   SETTLEMENT (Codex RM-1..RM-6) claim before money; paid: one reservation, ONE provider call, request id
//              recorded before the transition, finalized atomically with the event; retry: NO provider call
//              (the worker owns the request); reservation outage: not finalized, retried; paid without a
//              payment intent / no allocation / request parked: ONE case, review_required; unpaid / waived /
//              already refunded: no money step; transition failure: one case, unsettled; held: untouched;
//              lease held or revision mismatch: nothing done; a malformed reservation never reaches Stripe.
//   SWEEP      lapse outage -> claim_failed; read outage -> read_failed; malformed reply -> failed; attempt cap
//              parks behind one case; an undeliverable "please confirm" notice opens one case.
//
// Run from the repository root:  node tests/demo_move_offline.test.mjs   (no credentials needed)
import { fanOutEvents, scheduleMoveReminders, processClaimed, makeCache, MOVE_REMINDER_KIND } from '../api/_notification-outbox.js';
import { demoMovedMessage, moveReminderMessage, demoMoveCancelledMessage } from '../api/_notification-mail.js';
import { settleMove, sweepMoves, SETTLE_MAX_ATTEMPTS } from '../api/_booking-moves.js';
import { reserveAndRefund } from '../api/_booking-refund.js';
let _pass = 0, _fail = 0;
const ok = (n, c, d) => { if (c) { _pass++; console.log('  ok   ' + n); } else { _fail++; console.log('  FAIL ' + n + (d ? ' ' + d : '')); } };
const summary = (label) => { console.log(`\n${label}: ${_pass} passed, ${_fail} failed`); process.exit(_fail ? 1 : 0); };

const b = { supabaseUrl: 'https://offline.invalid', serviceKey: 'fake', siteOrigin: 'https://example.test', stripeKey: 'sk_test_binding' };
const now = new Date('2026-10-16T18:00:00Z');   // 11:00 PDT
const movedAt = '2026-10-16T17:00:00Z';
const due = '2026-10-19T17:00:00Z';              // +72h
const data = () => ({
  booking_moves: [{ id: 'mv1', booking_id: 'bk1', retailer_id: 'gus', brand_id: 'brand', demo_id: 'd1', from_date: '2026-10-24', from_time: '10:00 AM', to_date: '2026-10-31', to_time: '2:00 PM', schedule_revision: 2, note: 'Agreed with Maria <by phone>', moved_by: 'staff@gus.test', moved_at: movedAt, reconfirm_due_at: due, status: 'pending', settled_at: null, refund_status: null, refund_request_id: null, reconciliation_case_id: null, settle_attempts: 0, settle_lease_owner: null, settle_lease_until: null }],
  bookings: [{ id: 'bk1', brand_id: 'brand', retailer_id: 'gus', venue_id: 'v1', status: 'confirmed', payment_status: 'paid', payment_intent_id: 'pi_1', fee_waived: false, demo_date: '2026-10-31', demo_time: '2:00 PM', product: 'Cold Brew', schedule_revision: 2, timezone: 'America/Los_Angeles', pending_move_settlement: null }],
  brands: [{ id: 'brand', email: 'brand@example.test', company_name: 'Alpha & Co', contact_name: 'Rep' }],
  brand_members: [{ id: 'mate', brand_id: 'brand', email: 'mate@example.test' }],
  retailers: [{ id: 'gus', name: "Gus's Community Market", slug: 'gus', timezone: 'America/Los_Angeles' }],
  venues: [{ id: 'v1', name: 'Mission District', address: '1 Main' }],
  notification_events: [{ id: 'ev1', kind: 'demo_moved', booking_id: 'bk1', brand_id: 'brand', retailer_id: 'gus', transition_id: 'mv1', payload: { move_id: 'mv1' }, fanned_out_at: null, created_at: movedAt }],
  notification_deliveries: [],
  refund_requests: [],
});
let tables = data(), patches = [], inserts = [], events = [], sent = [], rpc = [], stripe = [], fail = {}, reserveReply = null;
function applyFilters(rows, qs) {
  let out = rows;
  for (const part of qs.split('&')) {
    const m = /^([a-z_]+)=(eq|in|gt|gte|lt|lte|is)\.(.*)$/.exec(part);
    if (!m) continue;
    const [, key, op, raw] = m; const v = decodeURIComponent(raw);
    if (op === 'eq') out = out.filter(r => String(r[key]) === v);
    else if (op === 'is') out = out.filter(r => v === 'null' ? r[key] == null : r[key] != null);
    else if (op === 'in') { const set = v.replace(/^\(|\)$/g, '').split(',').map(decodeURIComponent); out = out.filter(r => set.includes(String(r[key]))); }
    else if (op === 'gt') out = out.filter(r => r[key] != null && String(r[key]) > v);
    else if (op === 'gte') out = out.filter(r => r[key] != null && Number(r[key]) >= Number(v));
    else if (op === 'lt') out = out.filter(r => r[key] != null && Number(r[key]) < Number(v));
    else if (op === 'lte') out = out.filter(r => r[key] != null && String(r[key]) <= v);
  }
  return out;
}
const mv = () => tables.booking_moves[0];
const bk = () => tables.bookings[0];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://api.stripe.com/v1/refunds')) { stripe.push({ body: String(opts.body), key: opts.headers && opts.headers['Idempotency-Key'] }); return new Response(JSON.stringify({ id: 're_fake', amount: 3000, currency: 'usd', status: 'succeeded', payment_intent: 'pi_1', charge: 'ch_1' }), { status: 200 }); }
  if (!u.startsWith(b.supabaseUrl + '/rest/v1/')) throw new Error('unexpected network: ' + u);
  const [path, qs = ''] = u.split('/rest/v1/')[1].split('?');
  if (path.startsWith('rpc/')) {
    const fn = path.slice(4); const args = JSON.parse(opts.body || '{}'); rpc.push({ fn, args });
    if (fail[fn] === 'malformed') return new Response(JSON.stringify({ message: 'not a list' }), { status: 200 });
    if (fail[fn]) return new Response(JSON.stringify({ message: 'simulated ' + fn + ' failure' }), { status: 500 });
    if (fn === 'refund_reserve_cas') {
      if (reserveReply) return new Response(JSON.stringify([reserveReply]), { status: 200 });
      const existing = tables.refund_requests.find(r => r.op_key === args.p_op_key);
      if (existing) return new Response(JSON.stringify([{ outcome: 'existing', payment_intent: 'pi_1', amount: 3000, keeps_all: true, idempotency_key: existing.stripe_idempotency_key, refund_request_id: existing.id, charge_id: 'ch_1' }]), { status: 200 });
      const id = 'rr' + (tables.refund_requests.length + 1);
      tables.refund_requests.push({ id, op_key: args.p_op_key, status: 'reserved', stripe_idempotency_key: 'idem-' + args.p_op_key, stripe_refund_id: null, amount: 3000 });
      return new Response(JSON.stringify([{ outcome: 'reserved', payment_intent: 'pi_1', amount: 3000, keeps_all: true, idempotency_key: 'idem-' + args.p_op_key, refund_request_id: id, charge_id: 'ch_1' }]), { status: 200 });
    }
    if (fn === 'apply_refund_event') { const r = tables.refund_requests.find(x => x.id === args.p_meta_request_id); if (r) { r.status = 'succeeded'; r.stripe_refund_id = args.p_refund_id; } return new Response('[]', { status: 200 }); }
    if (fn === 'booking_transition') { const bb = tables.bookings.find(x => x.id === args.p_booking_id); const before = bb.status; if (bb) { bb.status = 'cancelled'; Object.assign(bb, args.p_fields || {}); } return new Response(JSON.stringify([{ ok: true, reason: before === 'cancelled' ? 'already_applied' : null, status_before: before, status_after: 'cancelled' }]), { status: 200 }); }
    if (fn === '_open_case') return new Response(JSON.stringify(['case-' + args.p_dedupe]), { status: 200 });
    if (fn === 'claim_move_settlement') {
      const m = tables.booking_moves.find(x => x.id === args.p_move_id); const bb = m && tables.bookings.find(x => x.id === m.booking_id);
      const reply = (okv, reason) => new Response(JSON.stringify([{ ok: okv, reason, move: m ? { ...m } : null, booking: bb ? { ...bb } : null }]), { status: 200 });
      if (!m) return reply(false, 'not_found');
      if (!['declined', 'lapsed'].includes(m.status)) return reply(false, 'move_' + m.status);
      if (m.settled_at) return reply(false, 'already_settled');
      if (bb.retailer_id !== m.retailer_id) return reply(false, 'tenant_mismatch');
      if (m.settle_lease_until && m.settle_lease_until > now.toISOString() && m.settle_lease_owner !== args.p_owner) return reply(false, 'lease_held');
      if (['pending', 'confirmed'].includes(bb.status) && bb.schedule_revision !== m.schedule_revision) { m.status = 'superseded'; return reply(false, 'revision_mismatch'); }
      m.settle_lease_owner = args.p_owner; m.settle_lease_until = new Date(now.getTime() + 180e3).toISOString();
      return reply(true, null);
    }
    if (fn === 'finalize_move_settlement') {
      const m = tables.booking_moves.find(x => x.id === args.p_move_id);
      if (!m) return new Response(JSON.stringify([{ ok: false, reason: 'not_found', event_written: false }]), { status: 200 });
      if (m.settle_lease_owner !== args.p_owner) return new Response(JSON.stringify([{ ok: false, reason: 'lease_lost', event_written: false }]), { status: 200 });
      if (!args.p_settled) { m.settle_attempts++; m.settle_last_error = args.p_error; m.refund_request_id = args.p_refund_request_id || m.refund_request_id; m.reconciliation_case_id = args.p_case_id || m.reconciliation_case_id; m.settle_lease_owner = null; m.settle_lease_until = null; return new Response(JSON.stringify([{ ok: true, reason: null, event_written: false }]), { status: 200 }); }
      m.settled_at = now.toISOString(); m.refund_status = args.p_refund_status; m.refund_request_id = args.p_refund_request_id || m.refund_request_id; m.reconciliation_case_id = args.p_case_id || m.reconciliation_case_id; m.settle_lease_owner = null; m.settle_lease_until = null;
      const bb = tables.bookings.find(x => x.id === m.booking_id); if (bb && bb.pending_move_settlement === m.id) bb.pending_move_settlement = null;
      const tid = m.id + ':cancelled'; let written = false;
      if (!events.some(e => e.transition_id === tid)) { events.push({ kind: 'demo_move_cancelled', transition_id: tid, payload: { ...(args.p_event_payload || {}), move_id: m.id, outcome: m.status, refund_status: args.p_refund_status } }); written = true; }
      return new Response(JSON.stringify([{ ok: true, reason: null, event_written: written }]), { status: 200 });
    }
    if (fn === 'lapse_booking_moves') { const dueRows = tables.booking_moves.filter(m => m.status === 'pending' && m.reconfirm_due_at <= now.toISOString()); for (const m of dueRows) { m.status = 'lapsed'; m.lapsed_at = now.toISOString(); const bb = tables.bookings.find(x => x.id === m.booking_id); if (bb) bb.pending_move_settlement = m.id; } return new Response(JSON.stringify(dueRows), { status: 200 }); }
    throw new Error('unexpected rpc ' + fn);
  }
  if (opts.method === 'POST') {
    const rows = JSON.parse(opts.body);
    if (path === 'notification_deliveries') { inserts.push(...rows); tables.notification_deliveries.push(...rows.map((r, i) => ({ id: 'ins' + inserts.length + '-' + i, ...r }))); return new Response(JSON.stringify(rows.map((r, i) => ({ id: 'ins' + inserts.length + '-' + i, ...r }))), { status: 200 }); }
    throw new Error('unexpected POST ' + path);
  }
  if (opts.method === 'PATCH') {
    const p = JSON.parse(opts.body); patches.push({ table: path, qs, p });
    if (path === 'booking_moves') { const m = /id=eq\.([^&]+)/.exec(qs); const row = tables.booking_moves.find(x => x.id === decodeURIComponent(m[1])); if (row) Object.assign(row, p); }
    if (path === 'refund_requests') { const m = /id=eq\.([^&]+)/.exec(qs); const row = tables.refund_requests.find(x => x.id === decodeURIComponent(m[1])); if (row) Object.assign(row, p); }
    if (path === 'notification_events') { const m = /id=eq\.([^&]+)/.exec(qs); const row = tables.notification_events.find(x => x.id === decodeURIComponent(m[1])); if (row) Object.assign(row, p); }
    return new Response(JSON.stringify([{ id: 'delivery', ...p }]), { status: 200 });
  }
  if (fail[path] === 'malformed') return new Response(JSON.stringify({ message: 'not a list' }), { status: 200 });
  if (fail[path]) return new Response(JSON.stringify({ message: 'simulated read failure' }), { status: 503 });
  if (!(path in tables)) throw new Error('unexpected table ' + path);
  return new Response(JSON.stringify(applyFilters(tables[path], qs)), { status: 200 });
};
const mailer = async (msg, o) => { sent.push({ msg, key: o && o.idempotencyKey }); return { ok: true, id: 'fake' }; };
const reset = () => { tables = data(); patches = []; inserts = []; events = []; sent = []; rpc = []; stripe = []; fail = {}; reserveReply = null; };
const row = (extra = {}) => ({ id: 'delivery', event_id: 'ev1', retailer_id: 'gus', booking_id: 'bk1', recipient_kind: 'brand', recipient_id: 'brand', recipient_email: 'brand@example.test', kind: 'demo_moved', occurrence_key: 'mv1', attempts: 0, ...extra });
const run = (r, o = {}) => processClaimed(b, r, { now: o.now || now, token: 'token', mailer, cache: makeCache() });
const ctx = () => ({ brand: tables.brands[0], retailer: tables.retailers[0], venue: tables.venues[0], booking: bk(), move: mv(), now });
const rpcs = (fn) => rpc.filter(x => x.fn === fn);
const settle = (o = {}) => settleMove(b, mv(), { owner: o.owner || 'w1', now });

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
  mv().status = 'lapsed'; mv().refund_status = 'submitted';
  const c = demoMoveCancelledMessage(b, ctx());
  ok('cancelled (lapsed): says no answer, refund submitted to the card provider, never "received"', /did not hear back in time/.test(c.html) && /refund has been submitted/.test(c.html) && !/received your refund/.test(c.html) && /refund submitted/.test(c.subject), c.subject);
  mv().status = 'declined'; mv().refund_status = 'not_paid';
  const c2 = demoMoveCancelledMessage(b, ctx());
  ok('cancelled (declined, unpaid): says the brand declined and nothing to refund', /You told us the new time does not work/.test(c2.html) && /nothing to refund/.test(c2.html));
  mv().refund_status = 'pending_worker';
  const c3 = demoMoveCancelledMessage(b, ctx());
  ok('cancelled (refund still with the worker): says it is being processed, no completion claimed', /being processed/.test(c3.html) && !/has been submitted/.test(c3.html));
  ok('no em dash in any of them', ![m, r, c, c2, c3].some(x => /2014/.test(x.subject + x.html)));
}

console.log('\n:: fan-out ::');
{
  reset();
  const f = await fanOutEvents(b, { now });
  ok('demo_moved fans out to the account email and the team member, keyed on the move', f.deliveries === 2 && inserts.length === 2 && inserts.every(r => r.kind === 'demo_moved' && r.occurrence_key === 'mv1' && r.retailer_id === 'gus' && r.booking_id === 'bk1') && inserts.map(r => r.recipient_email).sort().join(',') === 'brand@example.test,mate@example.test', JSON.stringify({ f, inserts: inserts.map(r => r.dedupe_key) }));
  reset(); mv().status = 'confirmed';
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
  reset(); mv().status = 'confirmed';
  ok('moved: brand confirmed before the send: skipped move_confirmed', (await run(row())).reason === 'move_confirmed' && sent.length === 0);
  reset(); mv().status = 'superseded';
  ok('moved: the store moved it again: skipped move_superseded', (await run(row())).reason === 'move_superseded');
  reset(); bk().status = 'cancelled';
  ok('moved: booking cancelled meanwhile: skipped booking_cancelled', (await run(row())).reason === 'booking_cancelled');
  reset(); bk().schedule_revision = 3;
  ok('moved: booking on a newer revision than the move: skipped rescheduled', (await run(row())).reason === 'rescheduled');
  reset(); ok('moved: past the deadline: skipped deadline_passed', (await run(row(), { now: new Date('2026-10-20T00:00:00Z') })).reason === 'deadline_passed');
  reset(); const r8 = await run(row({ kind: MOVE_REMINDER_KIND, offset_key: 'h24', event_id: null, expires_at: '2026-10-17T23:00:00Z' }));
  ok('reminder: sends while pending', r8.outcome === 'accepted' && /Reminder: confirm your moved demo/.test(sent[0].msg.subject), JSON.stringify(r8));
  reset(); ok('reminder: past its catch-up window: skipped expired', (await run(row({ kind: MOVE_REMINDER_KIND, offset_key: 'h24', event_id: null, expires_at: '2026-10-16T17:30:00Z' }))).reason === 'expired');
  reset(); mv().status = 'lapsed'; mv().refund_status = 'submitted';
  ok('cancelled: booking still active (settlement not through yet): skipped booking_still_active', (await run(row({ kind: 'demo_move_cancelled' }))).reason === 'booking_still_active');
  bk().status = 'cancelled'; sent = []; patches = [];
  const r11 = await run(row({ kind: 'demo_move_cancelled' }));
  ok('cancelled: booking cancelled and move lapsed: sends with the refund line', r11.outcome === 'accepted' && /was cancelled, refund submitted/.test(sent[0].msg.subject) && /did not hear back/.test(sent[0].msg.html), JSON.stringify(r11));
  reset(); bk().status = 'cancelled';
  ok('cancelled: move still pending (cancelled for another reason): skipped move_pending', (await run(row({ kind: 'demo_move_cancelled' }))).reason === 'move_pending');
  reset(); tables.brand_members = [];
  ok('a removed team member is skipped recipient_deleted', (await run(row({ recipient_id: 'mate', recipient_email: 'mate@example.test' }))).reason === 'recipient_deleted');
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
  ok('two recipients x two offsets, keyed on the move, due +24h and +48h after the move', s.moves === 1 && inserts.length === 4 && keys.join(' ') === ['demo_move_reminder:mv1:brand:brand:h24', 'demo_move_reminder:mv1:brand:brand:h48', 'demo_move_reminder:mv1:brand:mate:h24', 'demo_move_reminder:mv1:brand:mate:h48'].join(' ') && inserts.find(r => r.offset_key === 'h24').due_at === '2026-10-17T17:00:00.000Z' && inserts.every(r => r.status === 'pending'), JSON.stringify({ s, keys }));
  reset(); mv().reconfirm_due_at = '2026-10-18T00:00:00Z';
  await scheduleMoveReminders(b, { now });
  ok('a compressed window: the +48h nudge is skipped too_close_to_deadline, the +24h one pending', inserts.filter(r => r.offset_key === 'h48').every(r => r.skip_reason === 'too_close_to_deadline') && inserts.filter(r => r.offset_key === 'h24').every(r => r.status === 'pending'));
  reset(); await scheduleMoveReminders(b, { now: new Date('2026-10-18T00:00:00Z') });
  ok('first run after the +24h moment passed: that nudge is skipped due_before_scheduling, +48h pending', inserts.filter(r => r.offset_key === 'h24').every(r => r.skip_reason === 'due_before_scheduling') && inserts.filter(r => r.offset_key === 'h48').every(r => r.status === 'pending'));
  reset(); mv().status = 'confirmed';
  ok('an answered move schedules nothing', (await scheduleMoveReminders(b, { now })).moves === 0 && inserts.length === 0);
}

console.log('\n:: settlement: paid, declined (RM-2 / RM-3 / RM-4) ::');
{
  reset(); mv().status = 'declined'; bk().pending_move_settlement = 'mv1';
  const r = await settle();
  const tr = rpcs('booking_transition')[0], reserve = rpcs('refund_reserve_cas')[0], fin = rpcs('finalize_move_settlement')[0];
  ok('claim happens before any money: the claim RPC is the first call', rpc[0].fn === 'claim_move_settlement' && rpc[0].args.p_owner === 'w1', JSON.stringify(rpc.map(x => x.fn)));
  ok('reserved under the move operation key, ONE Stripe refund with the reservation key and an explicit amount', r.ok && reserve.args.p_op_key === 'bk1:move_declined' && stripe.length === 1 && stripe[0].key === 'idem-bk1:move_declined' && /amount=3000/.test(stripe[0].body), JSON.stringify({ r, stripe }));
  ok('the request id is recorded on the move BEFORE the transition', patches.some(p => p.table === 'booking_moves' && p.p.refund_request_id === 'rr1') && rpc.findIndex(x => x.fn === 'booking_transition') > 0, JSON.stringify(patches.map(p => p.p)));
  ok('cancel through booking_transition with the decline reason and refund_id; refund_status submitted', tr && tr.args.p_action === 'cancel' && tr.args.p_retailer_id === 'gus' && /could not make the new time/.test(tr.args.p_fields.cancel_reason) && tr.args.p_fields.refund_id === 're_fake' && r.refund_status === 'submitted' && r.refund_request_id === 'rr1', JSON.stringify(tr && tr.args));
  ok('finalized atomically: settled stamp, pending settlement cleared, ONE demo_move_cancelled event with the persisted refund state', fin && fin.args.p_settled === true && fin.args.p_refund_status === 'submitted' && fin.args.p_refund_request_id === 'rr1' && mv().settled_at && bk().pending_move_settlement === null && events.length === 1 && events[0].payload.refund_status === 'submitted' && events[0].payload.outcome === 'declined', JSON.stringify(events));
  const r2 = await settle();
  ok('settling again: refused already_settled, no RPC beyond the claim, no provider call', !r2.ok && r2.error === 'already_settled' && stripe.length === 1, JSON.stringify(r2));
}
console.log('\n:: settlement: retry never resubmits (RM-4) ::');
{
  reset(); mv().status = 'lapsed'; bk().pending_move_settlement = 'mv1';
  fail.booking_transition = true;
  const r1 = await settle();
  ok('transition fails after the refund step: not ok, ONE case, request id kept on the move, attempts + 1, lease released, no event', !r1.ok && r1.error === 'transition_failed' && r1.retry && rpcs('_open_case').length === 1 && rpcs('_open_case')[0].args.p_dedupe === 'move_settle:mv1' && mv().refund_request_id === 'rr1' && mv().settle_attempts === 1 && !mv().settled_at && mv().settle_lease_owner === null && events.length === 0 && stripe.length === 1, JSON.stringify(r1));
  fail = {};
  const r2 = await settle();
  ok('retry: the request is READ, no reservation call, NO second provider call, then cancelled and finalized with the request\'s state', r2.ok && stripe.length === 1 && rpcs('refund_reserve_cas').length === 1 && r2.refund_status === 'succeeded' && mv().settled_at && events.length === 1 && events[0].payload.refund_status === 'succeeded', JSON.stringify({ r2, reserves: rpcs('refund_reserve_cas').length, stripe: stripe.length }));
}
{
  // a reservation that exists from an earlier crash BEFORE the id was recorded: 'existing' is deferred to the worker
  reset(); mv().status = 'lapsed'; bk().pending_move_settlement = 'mv1';
  tables.refund_requests.push({ id: 'rr-old', op_key: 'bk1:move_lapsed', status: 'failed_retryable', stripe_idempotency_key: 'idem-old', stripe_refund_id: null, amount: 3000 });
  const r = await settle();
  ok('an existing reservation is never resubmitted here: zero provider calls, refund_status pending_worker, request id recorded, finalized', r.ok && stripe.length === 0 && r.refund_status === 'pending_worker' && r.refund_request_id === 'rr-old' && mv().settled_at && bk().payment_status === 'refund_pending', JSON.stringify(r));
}
{
  reset(); mv().status = 'lapsed'; bk().pending_move_settlement = 'mv1';
  reserveReply = { outcome: 'reserved', payment_intent: 'pi_1', keeps_all: true, idempotency_key: 'k', refund_request_id: 'rrX' };   // no amount
  const r = await settle();
  ok('a reservation without an amount never reaches Stripe: reserve_malformed, not finalized, retried', !r.ok && r.retry && r.error === 'reserve_malformed' && stripe.length === 0 && !mv().settled_at && mv().settle_attempts === 1, JSON.stringify(r));
  reset(); const rr = await reserveAndRefund(b, bk(), 'x', 'y', 'cancel');
  ok('the shared helper on a healthy reservation still submits once for the retailer cancel path', rr.ok && stripe.length === 1 && rr.refund_request_id === 'rr1');
}
console.log('\n:: settlement: no-money and review branches (RM-2) ::');
{
  reset(); mv().status = 'lapsed'; bk().pending_move_settlement = 'mv1'; bk().payment_status = 'unpaid'; bk().payment_intent_id = null;
  const r = await settle();
  ok('never charged: no reservation, no Stripe call, cancelled, refund_status not_paid, finalized', r.ok && r.refund_status === 'not_paid' && rpcs('refund_reserve_cas').length === 0 && stripe.length === 0 && bk().status === 'cancelled' && mv().settled_at, JSON.stringify(r));
  reset(); mv().status = 'lapsed'; bk().pending_move_settlement = 'mv1'; bk().fee_waived = true; bk().payment_status = 'waived'; bk().payment_intent_id = null;
  ok('fee-waived: not_paid, no money step', (await settle()).refund_status === 'not_paid' && stripe.length === 0);
  reset(); mv().status = 'declined'; bk().pending_move_settlement = 'mv1'; bk().payment_status = 'refunded';
  ok('already refunded: already_refunded, no money step', (await settle()).refund_status === 'already_refunded' && rpcs('refund_reserve_cas').length === 0);
  reset(); mv().status = 'declined'; bk().pending_move_settlement = 'mv1'; bk().payment_intent_id = null;   // paid, no intent
  const r4 = await settle();
  ok('paid but no payment intent: ONE deduplicated case, review_required, cancelled with refund_pending, finalized with the case id', r4.ok && r4.refund_status === 'review_required' && r4.case_id === 'case-move_refund:mv1' && rpcs('_open_case').length === 1 && stripe.length === 0 && bk().payment_status === 'refund_pending' && mv().settled_at && mv().reconciliation_case_id === 'case-move_refund:mv1' && events[0].payload.refund_status === 'review_required', JSON.stringify(r4));
  reset(); mv().status = 'declined'; bk().pending_move_settlement = 'mv1'; reserveReply = { outcome: 'no_allocation', requires_review: true };
  const r5 = await settle();
  ok('paid with no allocation: one case, review_required, finalized (durable operator handoff)', r5.ok && r5.refund_status === 'review_required' && rpcs('_open_case').length === 1 && rpcs('_open_case')[0].args.p_reason === 'move_refund_no_allocation' && stripe.length === 0, JSON.stringify(r5));
  reset(); mv().status = 'declined'; bk().pending_move_settlement = 'mv1'; fail.refund_reserve_cas = true;
  const r6 = await settle();
  ok('reservation RPC outage: NOT finalized, no case, retried (attempts + 1)', !r6.ok && r6.retry && r6.error === 'reserve_failed' && !mv().settled_at && rpcs('_open_case').length === 0 && mv().settle_attempts === 1 && bk().status === 'confirmed', JSON.stringify(r6));
  fail = {}; const r7 = await settle();
  ok('after the outage: the same move settles with one reservation and one provider call', r7.ok && stripe.length === 1 && r7.refund_status === 'submitted');
  reset(); mv().status = 'declined'; bk().pending_move_settlement = 'mv1'; mv().refund_request_id = 'rrP';
  tables.refund_requests.push({ id: 'rrP', op_key: 'bk1:move_declined', status: 'requires_review', stripe_idempotency_key: 'k', stripe_refund_id: null, amount: 3000 });
  const r8 = await settle();
  ok('a request parked for review: one case, review_required, no provider call', r8.ok && r8.refund_status === 'review_required' && rpcs('_open_case').length === 1 && stripe.length === 0);
  reset(); mv().status = 'declined'; bk().pending_move_settlement = 'mv1'; bk().status = 'held'; bk().payment_status = 'authorized';
  const r9 = await settle();
  ok('a booking that became held underneath: case, untouched, no money moved', !r9.ok && r9.error === 'booking_held' && stripe.length === 0 && rpcs('booking_transition').length === 0 && !mv().settled_at);
  reset(); mv().status = 'declined'; bk().pending_move_settlement = 'mv1'; bk().schedule_revision = 3;
  const r10 = await settle();
  ok('RM-1: a booking on a newer active revision: the claim retires the move (revision_mismatch), nothing cancelled, nothing refunded', !r10.ok && r10.error === 'revision_mismatch' && mv().status === 'superseded' && bk().status === 'confirmed' && stripe.length === 0 && rpcs('booking_transition').length === 0);
  reset(); mv().status = 'declined'; mv().settle_lease_owner = 'other'; mv().settle_lease_until = new Date(now.getTime() + 60e3).toISOString();
  const r11 = await settle();
  ok('a lease held by another worker: nothing done', !r11.ok && r11.error === 'lease_held' && rpc.length === 1);
}
console.log('\n:: sweep (RM-6) ::');
{
  reset(); mv().reconfirm_due_at = '2026-10-10T00:00:00Z';
  const s = await sweepMoves(b, { now, limit: 25 });
  ok('a pending move past its deadline is lapsed and settled (refund, cancel, event)', s.lapsed === 1 && s.settled === 1 && s.failed === 0 && !s.claim_failed && !s.read_failed && mv().status === 'lapsed' && mv().settled_at && stripe.length === 1 && stripe[0].key === 'idem-bk1:move_lapsed' && events.length === 1 && events[0].payload.outcome === 'lapsed', JSON.stringify(s));
  const s2 = await sweepMoves(b, { now, limit: 25 });
  ok('sweep again: nothing to do, no provider call', s2.lapsed === 0 && s2.settled === 0 && stripe.length === 1, JSON.stringify(s2));
  reset(); mv().status = 'declined'; bk().pending_move_settlement = 'mv1';
  ok('an unsettled declined move is settled by the worker', (await sweepMoves(b, { now })).settled === 1 && stripe[0].key === 'idem-bk1:move_declined');
  reset(); fail.lapse_booking_moves = true;
  const s3 = await sweepMoves(b, { now });
  ok('lapse RPC outage: claim_failed with a safe diagnostic, the unsettled scan still runs', s3.claim_failed === true && /lapse:/.test(s3.errors[0]) && !s3.read_failed, JSON.stringify(s3));
  reset(); fail.lapse_booking_moves = 'malformed';
  ok('a malformed lapse reply is a claim failure, not "no work"', (await sweepMoves(b, { now })).claim_failed === true);
  reset(); fail.booking_moves = true;
  const s4 = await sweepMoves(b, { now });
  ok('unsettled-query outage: read_failed with a safe diagnostic', s4.read_failed === true && /read:/.test(s4.errors[0]), JSON.stringify(s4));
  reset(); fail.booking_moves = 'malformed';
  ok('a malformed unsettled reply is a read failure', (await sweepMoves(b, { now })).read_failed === true);
  reset(); mv().status = 'declined'; bk().pending_move_settlement = 'mv1'; fail.booking_transition = true;
  const s5 = await sweepMoves(b, { now });
  ok('a per-item settlement failure counts as failed, with the move id in the diagnostic', s5.failed === 1 && /settle mv1: transition_failed/.test(s5.errors[0]), JSON.stringify(s5));
  reset(); mv().status = 'declined'; mv().settle_attempts = SETTLE_MAX_ATTEMPTS; mv().settle_last_error = 'transition_failed';
  const s6 = await sweepMoves(b, { now });
  ok('a move at the attempt cap is parked behind ONE case and no longer processed', s6.parked === 1 && s6.settled === 0 && s6.failed === 0 && rpcs('_open_case').length === 1 && rpcs('_open_case')[0].args.p_reason === 'move_settlement_attempts_exhausted' && mv().reconciliation_case_id === 'case-move_settle:mv1', JSON.stringify(s6));
  const s7 = await sweepMoves(b, { now });
  ok('parked once: a second sweep opens no second case', s7.parked === 0 && rpcs('_open_case').length === 1);
  reset(); tables.notification_deliveries.push({ id: 'dl', kind: 'demo_moved', occurrence_key: 'mv1', status: 'failed', next_attempt_at: null, skip_reason: 'max_attempts' });
  const s8 = await sweepMoves(b, { now });
  ok('RM-8: an undeliverable "please confirm" notice for a pending move opens one operator case', s8.notice_cases === 1 && rpcs('_open_case').some(x => x.args.p_dedupe === 'move_notice:mv1' && x.args.p_reason === 'move_notice_undeliverable'), JSON.stringify(s8));
}

summary('retailer demo moves (offline)');
