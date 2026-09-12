// tests/notification_worker.test.mjs — the 0074 notification outbox WORKER MECHANICS, driven through
// api/_notification-outbox.js internals with injected clocks and fixture rows (Codex Release A).
//
// What this proves, against the real test database (tests/_route.mjs; Resend spied):
//   * recovery: a lifecycle event written by the database trigger is fanned out LATER by the worker
//     without replaying the user action;
//   * concurrent claims: two workers racing for the same due rows each own a disjoint set;
//   * crash before send: a claimed row whose lease expired is taken over; the dead worker's late
//     completion (old token) matches nothing and changes nothing;
//   * provider accepted, response lost: the row goes 'unknown' with the payload and idempotency key
//     FROZEN; the retry sends exactly the same payload under exactly the same Idempotency-Key, and the
//     provider's dedupe makes it one email; past Resend's 24h window an unknown row stops retrying;
//   * crash before the completion stamp: the row stays claimed, the lease expires, the next worker
//     re-sends under the SAME key (no new payload, no new key);
//   * failed enqueue / failed send / lost lease -> the route answers 500 and writes a 'failed'
//     heartbeat — never a false success;
//   * bounded retries with backoff (1m, 5m, 15m, 1h, 6h) and a terminal 'failed'/'unknown' after 8;
//   * schedule identity: A -> B -> A reschedules retire the old occurrence's rows and create new keys;
//     a cancellation that lands while a row is claimed suppresses the send;
//   * DST/time: due_at across PST/PDT, morning_of skipped for an early demo, catch-up expiry, first
//     rollout with reminders already due -> skipped 'due_before_scheduling';
//   * COI decisions: approve -> one brand delivery with the reviewed expiry and the compliance link
//     (never the certificate or a file link); reject -> the owner's brand_note as ESCAPED text; a
//     re-saved status writes no new event; a decision superseded by a newer upload is not emailed.
//
// Run from the repository root with test-database creds:  node tests/notification_worker.test.mjs
import { installSpy, callRoute, req, ok, summary, uniq, ENV } from './_route.mjs';
import { HOURLY, STANDARD, HOURLY_JSON, STANDARD_JSON } from './_fixture_availability.mjs';
// Release B: a venue only offers its slot list, so the 'early demo' (6:30 AM, before morning_of) case
// needs an explicit 06:30/1h slot inside opening hours that start early enough.
const EARLY_STANDARD = { schedule: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [String(d), [{ open: '06:00', close: '21:00' }]])), slots: [{ start: '06:30', hours: 1 }, { start: '09:00', hours: 1 }, { start: '10:00', hours: 1 }, { start: '11:00', hours: 3 }, { start: '15:00', hours: 2 }, { start: '17:00', hours: 3 }], blackouts: [] };   // offers every time this suite books: 6:30 AM, 10:00 AM, 11:00 AM, 3:00 PM, 5:00 PM

import { getBinding } from '../api/_env.js';
import { MailError, sendMail } from '../api/_mail.js';
import { demoStartUtc, reminderWindow } from '../api/_local-time.js';
import {
  fanOutEvents, scheduleReminders, dispatchDue, claimDue, processClaimed, collectMetrics, runWorker, backoffMs, makeCache,
  MAX_ATTEMPTS, LEASE_MS,
} from '../api/_notification-outbox.js';

ENV.NOTIFICATION_WORKER_ENABLED = 'true';

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
const CRON = { authorization: 'Bearer ' + ENV.CRON_SECRET };
const LA = 'America/Los_Angeles';
const startIso = new Date().toISOString();
const dayP = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const at = (d, ms = 0) => new Date(d.getTime() + ms);
const iso = (d) => d.toISOString();
const MIN = 60000, HOUR = 3600000;

const spy = installSpy();
const mailsSince = (n) => spy.calls.resend.slice(n);
const toContact = (m, email) => String(m.html || '').includes(email);
const subj = (m) => String(m.subject || '');

// A mailer that records the exact provider request (headers included) and can be told to fail.
function recordingMailer(b, { mode = 'ok' } = {}) {
  const calls = [];
  const fetchSpy = async (url, opts) => {
    calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    if (mode === 'unreachable') throw new Error('socket hang up');
    if (mode === 'reject') return { ok: false, status: 422, json: async () => ({ message: 'injected validation error' }), text: async () => '{}' };
    return { ok: true, status: 200, json: async () => ({ id: 'msg_' + calls.length }), text: async () => '{}' };
  };
  const mailer = (msg, opts) => sendMail(msg, { ...opts, binding: b, fetch: fetchSpy });
  return { mailer, calls, set: (m) => { mode = m; } };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const slug = uniq('nw');
const retailerId = track('retailers', one(await db('retailers', { method: 'POST', body: JSON.stringify({
  slug, name: 'Worker Fixture Market', billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active',
  platform_keeps_all: true, timezone: LA, auto_confirm_bookings: false }) })).id);
const V1 = track('venues', one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, name: 'Worker Main', address: '1 Worker Way', demo_fee: 30, availability: EARLY_STANDARD }) })).id);
const C1e = `c1-${slug}@fixture.test`;
const C1 = track('internal_contacts', one(await db('internal_contacts', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, name: 'Worker Contact', role: 'Lead', email: C1e, venue_ids: [V1], notification_prefs: { on_confirmed: true, on_cancelled: true, on_rescheduled: true, reminders: ['d3', 'd1', 'morning_of', 'h1'] } }) })).id);
const brandEmail = `${uniq('wbrand')}@fixture.test`;
const brandId = track('brands', one(await db('brands', { method: 'POST', body: JSON.stringify({ email: brandEmail, company_name: 'Worker Brand Co', contact_name: 'Rep W', phone: '555-0100', default_coi_url: 'brands/w.pdf', default_coi_expires: dayP(400), coi_verification_status: 'approved' }) })).id);
const memberEmail = `${uniq('wmember')}@fixture.test`;
track('brand_members', one(await db('brand_members', { method: 'POST', body: JSON.stringify({ brand_id: brandId, email: memberEmail, name: 'Team Member', role: 'member' }) })).id);

// The harness binding for the internals.
await callRoute('find-retailer.js', req({ body: { action: 'status' } }));
const b = await getBinding();

// A CONFIRMED booking inserted directly: the 0074 trigger writes demo_confirmed on INSERT.
async function confirmedBooking(demo_date, demo_time, extra = {}) {
  const res = await db('bookings', { method: 'POST', body: JSON.stringify({
    retailer_id: retailerId, venue_id: V1, brand_id: brandId, brand_name: 'Worker Brand Co', contact_name: 'Rep W', contact_phone: '555-0100',
    contact_email: brandEmail, product: 'Cold Brew', demo_date, demo_time, status: 'confirmed', payment_status: 'paid', needs_electricity: true, ...extra }) });
  const row = one(res);
  if (!row) throw new Error('fixture booking insert failed: ' + res.status + ' ' + JSON.stringify(res.body).slice(0, 300));
  track('bookings', row.id);
  // 0080 also queues an owner_booking_created event for this paid row. This suite exercises the
  // store-contact and brand kinds and counts claimed/dispatched rows exactly, so the owner event is
  // retired here before it can fan out (its own suite, owner_booking_events, covers it).
  await db(`notification_events?booking_id=eq.${row.id}&kind=eq.owner_booking_created`, { method: 'PATCH', body: JSON.stringify({ fanned_out_at: new Date().toISOString() }) });
  return row;
}
const deliveriesFor = async (bid, filter = '') => (await db(`notification_deliveries?booking_id=eq.${bid}&select=*${filter}&order=due_at.asc`)).body || [];
// 0080 also writes an owner_booking_created event for paid rows; this suite is about the store-contact
// and brand kinds, so the owner kind is excluded here (it has its own suite: owner_booking_events).
const eventsFor = async (bid) => (await db(`notification_events?booking_id=eq.${bid}&kind=neq.owner_booking_created&select=*&order=created_at.asc`)).body || [];
const delivery = async (id) => one(await db(`notification_deliveries?id=eq.${id}&select=*`));
const hbRows = async () => (await db(`cron_heartbeat?cron_name=eq.notification-worker&ran_at=gte.${encodeURIComponent(startIso)}&select=outcome,summary&order=ran_at.asc`)).body || [];
const insertDelivery = async (fields) => one(await db('notification_deliveries', { method: 'POST', body: JSON.stringify(fields) }));

try {
  ok('fixtures exist', !!retailerId && !!V1 && !!C1 && !!brandId && !!b);

  // =========================================================================
  console.log('\n— 1: recovery — the trigger wrote the event; the worker fans it out later, no action replayed —');
  // =========================================================================
  const D1 = dayP(15), T1 = '11:00 AM';
  const bk1 = await confirmedBooking(D1, T1);
  const start1 = demoStartUtc(D1, T1, LA);
  {
    const ev = await eventsFor(bk1.id);
    ok('inserting a CONFIRMED booking wrote exactly one demo_confirmed event in the same transaction', ev.length === 1 && ev[0].kind === 'demo_confirmed' && ev[0].fanned_out_at === null && ev[0].payload.schedule_revision === 1, JSON.stringify(ev));
    ok('the snapshot columns are set (start_at = 11:00 LA)', bk1.start_at && iso(new Date(bk1.start_at)) === iso(start1) && bk1.timezone === LA, JSON.stringify([bk1.start_at, bk1.timezone]));
    const now = new Date();
    const f = await fanOutEvents(b, { now });
    ok('fanOutEvents (a later run) created one pending delivery for the in-scope contact', f.errors.length === 0 && f.deliveries >= 1, JSON.stringify(f));
    const rows = await deliveriesFor(bk1.id, '&kind=eq.demo_confirmed');
    ok('the delivery row: pending, due now, recipient C1, frozen_payload NULL (built at dispatch), no idempotency key yet', rows.length === 1 && rows[0].status === 'pending' && rows[0].recipient_id === C1 && rows[0].frozen_payload === null && rows[0].idempotency_key === null && rows[0].occurrence_key === `${bk1.id}:1`, JSON.stringify(rows));
    ok('the event is stamped fanned_out_at', (await eventsFor(bk1.id))[0].fanned_out_at !== null);
    const f2 = await fanOutEvents(b, { now });
    ok('a second fan-out creates nothing (dedupe_key + fanned_out_at)', f2.deliveries === 0 && (await deliveriesFor(bk1.id, '&kind=eq.demo_confirmed')).length === 1, JSON.stringify(f2));
  }

  // =========================================================================
  console.log('\n— 2: concurrent claims — two workers, disjoint ownership; lease takeover after a crash —');
  // =========================================================================
  {
    const now = new Date();
    const mk = (i) => insertDelivery({ retailer_id: retailerId, booking_id: bk1.id, recipient_kind: 'store_contact', recipient_id: C1, recipient_email: C1e, kind: 'reminder', offset_key: 'd1', occurrence_key: `${bk1.id}:race`, dedupe_key: `race:${slug}:${i}`, due_at: iso(at(now, -MIN)), expires_at: iso(at(now, HOUR)), status: 'pending' });
    const rows = [];
    for (let i = 0; i < 6; i++) rows.push(await mk(i));
    // claimDue claims ANY due row (bk1's confirmed delivery is due too), so the race assertions are
    // scoped to the six race rows by their dedupe_key prefix.
    const isRace = (r) => String(r.dedupe_key || '').startsWith(`race:${slug}:`);
    const tokA = crypto.randomUUID(), tokB = crypto.randomUUID();
    const [aAll, bAll] = await Promise.all([claimDue(b, { now, batch: 4, claimToken: tokA }), claimDue(b, { now, batch: 4, claimToken: tokB })]);
    const a = aAll.filter(isRace), bb = bAll.filter(isRace);
    const ids = (l) => l.map(r => r.id);
    const overlap = ids(aAll).filter(id => ids(bAll).includes(id));
    ok('two concurrent claimants own DISJOINT sets', overlap.length === 0, JSON.stringify({ a: aAll.length, b: bAll.length, overlap }));
    ok('each batch is bounded by 4 and together they hold at most the 6 race rows', aAll.length <= 4 && bAll.length <= 4 && a.length + bb.length <= 6 && a.length + bb.length >= 3, `${a.length} + ${bb.length}`);
    ok('claimed rows carry the winner token and a lease ~5 minutes out', [...aAll, ...bAll].every(r => r.status === 'claimed' && (r.claim_token === tokA || r.claim_token === tokB) && new Date(r.lease_until) - now > LEASE_MS - 5000));
    const restAll = await claimDue(b, { now, batch: 10, claimToken: crypto.randomUUID() });
    const rest = restAll.filter(isRace);
    ok('the remaining race rows are claimable by a third worker; none of A/B\'s rows are', restAll.every(r => !ids(aAll).includes(r.id) && !ids(bAll).includes(r.id)) && a.length + bb.length + rest.length === 6, `${rest.length}`);

    // CRASH BEFORE SEND: worker A dies. Its lease expires; a new worker takes its rows over.
    const later = at(now, LEASE_MS + MIN);
    const tokC = crypto.randomUUID();
    const takenAll = await claimDue(b, { now: later, batch: 10, claimToken: tokC });
    const taken = takenAll.filter(isRace);
    ok('after the lease expired, a new worker took over EVERY claimed race row (A, B and the third)', taken.length === 6 && taken.every(r => r.claim_token === tokC), `${taken.length}`);
    // The dead worker A finishes late and tries to record a completion with its OLD token.
    const victim = a[0] || bb[0];
    const rec = recordingMailer(b);
    const late = await processClaimed(b, { ...victim, claim_token: victim.claim_token }, { now: later, token: victim.claim_token, mailer: rec.mailer });
    ok('the dead worker\'s completion (old token) is a LOST lease: nothing written, no email sent', late.outcome === 'lost' && rec.calls.length === 0, JSON.stringify(late));
    const still = await delivery(victim.id);
    ok('the row still belongs to the new worker', still.claim_token === tokC && still.status === 'claimed', JSON.stringify([still.status, still.claim_token === tokC]));
    // Clean up the race rows (they are not real reminders) and release the real rows these claims
    // swept up, so the next section starts from a pending confirmed delivery.
    await db(`notification_deliveries?dedupe_key=like.race:${slug}:*`, { method: 'DELETE' });
    await db(`notification_deliveries?booking_id=eq.${bk1.id}&status=eq.claimed`, { method: 'PATCH', body: JSON.stringify({ status: 'pending', claim_token: null, lease_until: null }) });
  }

  // =========================================================================
  console.log('\n— 3: provider accepted, response lost -> unknown; retry reuses the frozen payload AND key; 24h window —');
  // =========================================================================
  {
    const now = new Date();
    const row = (await deliveriesFor(bk1.id, '&kind=eq.demo_confirmed'))[0];
    const rec = recordingMailer(b, { mode: 'unreachable' });
    const claimed = await claimDue(b, { now, batch: 5, claimToken: crypto.randomUUID() });
    const mine = claimed.find(r => r.id === row.id);
    ok('the confirmed delivery was claimed', !!mine, JSON.stringify(claimed.map(r => r.kind)));
    const r1 = await processClaimed(b, mine, { now, token: mine.claim_token, mailer: rec.mailer });
    const after1 = await delivery(row.id);
    ok('a timed-out provider call -> status UNKNOWN (not failed), attempts 1, retry in 1 minute', r1.outcome === 'unknown' && after1.status === 'unknown' && after1.attempts === 1 && after1.next_attempt_at && Math.abs(new Date(after1.next_attempt_at) - at(now, backoffMs(1))) < 2000 && /mail_provider_unreachable/.test(after1.last_error), JSON.stringify([r1, after1.status, after1.attempts, after1.next_attempt_at, after1.last_error]));
    ok('the payload and the idempotency key (= delivery id) were FROZEN before the attempt', after1.frozen_payload && after1.frozen_payload.to === C1e && /Demo confirmed/.test(after1.frozen_payload.subject) && after1.frozen_payload.attempted_at && after1.idempotency_key === row.id, JSON.stringify([after1.idempotency_key === row.id, Object.keys(after1.frozen_payload || {})]));
    ok('the provider request carried Idempotency-Key = the delivery id', rec.calls.length === 1 && rec.calls[0].headers['Idempotency-Key'] === row.id, JSON.stringify(rec.calls[0] && rec.calls[0].headers));
    const firstBody = rec.calls[0].body;

    // Not yet due for retry: nothing claimed.
    const early = await claimDue(b, { now: at(now, 30000), batch: 5, claimToken: crypto.randomUUID() });
    ok('30s later the unknown row is not yet retried (backoff 1m)', !early.some(r => r.id === row.id));
    // Retry: same payload, same key, provider now answers -> accepted, exactly one more request.
    rec.set('ok');
    const t2 = at(now, 2 * MIN);
    const c2 = await claimDue(b, { now: t2, batch: 5, claimToken: crypto.randomUUID() });
    const mine2 = c2.find(r => r.id === row.id);
    ok('2 minutes later the unknown row is claimable again', !!mine2);
    const r2 = await processClaimed(b, mine2, { now: t2, token: mine2.claim_token, mailer: rec.mailer });
    const after2 = await delivery(row.id);
    ok('the retry is ACCEPTED with the provider message id recorded, attempts 2', r2.outcome === 'accepted' && after2.status === 'accepted' && after2.attempts === 2 && after2.provider_message_id === 'msg_2' && after2.claim_token === null, JSON.stringify([r2, after2.status, after2.attempts, after2.provider_message_id]));
    ok('the retry sent EXACTLY the frozen payload under EXACTLY the same Idempotency-Key (no duplicate is possible)', rec.calls.length === 2 && rec.calls[1].headers['Idempotency-Key'] === row.id && JSON.stringify(rec.calls[1].body) === JSON.stringify(firstBody), JSON.stringify(rec.calls.map(c => c.headers['Idempotency-Key'])));
    ok('recorded as "accepted by the provider", never "delivered"', after2.status === 'accepted');

    // An UNKNOWN row older than Resend's 24h dedupe window stops retrying and stays visible.
    const oldUnknown = await insertDelivery({ retailer_id: retailerId, booking_id: bk1.id, recipient_kind: 'store_contact', recipient_id: C1, recipient_email: C1e, kind: 'demo_confirmed', occurrence_key: `${bk1.id}:1`, dedupe_key: `oldunknown:${slug}`, due_at: iso(at(now, -26 * HOUR)), status: 'unknown', attempts: 3, next_attempt_at: iso(at(now, -MIN)), idempotency_key: `oldkey:${slug}`, frozen_payload: { to: C1e, subject: 'Demo confirmed: old', html: '<p>old</p>', attempted_at: iso(at(now, -25 * HOUR)) } });
    const rec3 = recordingMailer(b, { mode: 'unreachable' });
    const c3 = await claimDue(b, { now, batch: 5, claimToken: crypto.randomUUID() });
    const mine3 = c3.find(r => r.id === oldUnknown.id);
    const r3 = await processClaimed(b, mine3, { now, token: mine3.claim_token, mailer: rec3.mailer });
    const after3 = await delivery(oldUnknown.id);
    ok('an unknown row whose first attempt was 25h ago: one more try under the same key, then FINAL unknown (idempotency_window_expired), no further retries', r3.outcome === 'unknown' && r3.final === true && after3.status === 'unknown' && after3.next_attempt_at === null && after3.skip_reason === 'idempotency_window_expired' && rec3.calls[0].headers['Idempotency-Key'] === `oldkey:${slug}`, JSON.stringify([r3, after3.status, after3.next_attempt_at, after3.skip_reason]));
    const c4 = await claimDue(b, { now: at(now, HOUR), batch: 5, claimToken: crypto.randomUUID() });
    ok('the final unknown row is never claimed again', !c4.some(r => r.id === oldUnknown.id));
    const metrics = await collectMetrics(b, { now });
    ok('metrics report the unknown row separately from liveness', metrics.unknown_count >= 1 && typeof metrics.backlog_pending === 'number' && typeof metrics.oldest_pending_age_min === 'number', JSON.stringify(metrics));
  }

  // =========================================================================
  console.log('\n— 4: crash before the completion stamp; definite failures, backoff, terminal states —');
  // =========================================================================
  {
    const now = new Date();
    // Pre-frozen row (the freeze already happened); the completion PATCH fails once -> row stays claimed.
    const frozenRow = await insertDelivery({ retailer_id: retailerId, booking_id: bk1.id, recipient_kind: 'store_contact', recipient_id: C1, recipient_email: C1e, kind: 'demo_confirmed', occurrence_key: `${bk1.id}:1`, dedupe_key: `stamp:${slug}`, due_at: iso(at(now, -MIN)), status: 'pending', idempotency_key: `stampkey:${slug}`, frozen_payload: { to: C1e, subject: 'Demo confirmed: stamp test', html: '<p>stamp</p>', attempted_at: iso(now) } });
    const c1 = await claimDue(b, { now, batch: 5, claimToken: crypto.randomUUID() });
    const m1 = c1.find(r => r.id === frozenRow.id);
    const rec = recordingMailer(b);
    spy.faults.push({ url: `notification_deliveries?id=eq.${frozenRow.id}&claim_token=eq.${m1.claim_token}`, method: 'PATCH', status: 500, message: 'injected_completion_fault', once: true });
    const r1 = await processClaimed(b, m1, { now, token: m1.claim_token, mailer: rec.mailer });
    spy.faults.length = 0;
    const after1 = await delivery(frozenRow.id);
    ok('send succeeded but the completion stamp failed: outcome error, the row STAYS claimed (not lost, not re-sent now)', r1.outcome === 'error' && after1.status === 'claimed' && after1.claim_token === m1.claim_token && rec.calls.length === 1, JSON.stringify([r1, after1.status]));
    const later = at(now, LEASE_MS + MIN);
    const c2 = await claimDue(b, { now: later, batch: 5, claimToken: crypto.randomUUID() });
    const m2 = c2.find(r => r.id === frozenRow.id);
    const r2 = await processClaimed(b, m2, { now: later, token: m2.claim_token, mailer: rec.mailer });
    const after2 = await delivery(frozenRow.id);
    ok('after the lease expired the next worker re-sent the SAME frozen payload under the SAME key and stamped accepted', r2.outcome === 'accepted' && after2.status === 'accepted' && rec.calls.length === 2 && rec.calls[0].headers['Idempotency-Key'] === `stampkey:${slug}` && rec.calls[1].headers['Idempotency-Key'] === `stampkey:${slug}` && JSON.stringify(rec.calls[0].body) === JSON.stringify(rec.calls[1].body), JSON.stringify([r2, after2.status, rec.calls.map(c => c.headers['Idempotency-Key'])]));

    // Definite provider rejection -> failed with backoff; the 8th attempt is terminal.
    const failRow = await insertDelivery({ retailer_id: retailerId, booking_id: bk1.id, recipient_kind: 'store_contact', recipient_id: C1, recipient_email: C1e, kind: 'demo_confirmed', occurrence_key: `${bk1.id}:1`, dedupe_key: `fail:${slug}`, due_at: iso(at(now, -MIN)), status: 'pending' });
    const rej = recordingMailer(b, { mode: 'reject' });
    const c3 = await claimDue(b, { now, batch: 5, claimToken: crypto.randomUUID() });
    const m3 = c3.find(r => r.id === failRow.id);
    const r3 = await processClaimed(b, m3, { now, token: m3.claim_token, mailer: rej.mailer });
    const after3 = await delivery(failRow.id);
    ok('a definite provider rejection -> FAILED (kept, not deleted), attempts 1, last_error bounded, retry in 1 minute', r3.outcome === 'failed' && after3.status === 'failed' && after3.attempts === 1 && after3.last_error.length <= 300 && Math.abs(new Date(after3.next_attempt_at) - at(now, MIN)) < 2000 && after3.claim_token === null, JSON.stringify([r3, after3.status, after3.attempts, after3.next_attempt_at]));
    ok('backoff schedule: 1m, 5m, 15m, 1h, 6h, then 6h', [1, 2, 3, 4, 5, 6, 8].map(backoffMs).join(',') === [1, 5, 15, 60, 360, 360, 360].map(m => m * MIN).join(','));
    await db(`notification_deliveries?id=eq.${failRow.id}`, { method: 'PATCH', body: JSON.stringify({ attempts: MAX_ATTEMPTS - 1, next_attempt_at: iso(at(now, -MIN)) }) });
    const c4 = await claimDue(b, { now, batch: 5, claimToken: crypto.randomUUID() });
    const m4 = c4.find(r => r.id === failRow.id);
    const r4 = await processClaimed(b, m4, { now, token: m4.claim_token, mailer: rej.mailer });
    const after4 = await delivery(failRow.id);
    ok(`the ${MAX_ATTEMPTS}th failure is TERMINAL: status failed, skip_reason max_attempts, no next attempt`, r4.outcome === 'failed' && r4.final === true && after4.status === 'failed' && after4.skip_reason === 'max_attempts' && after4.next_attempt_at === null, JSON.stringify([r4, after4.status, after4.skip_reason]));
    ok('a terminal failed row is never claimed again', !(await claimDue(b, { now: at(now, HOUR), batch: 5, claimToken: crypto.randomUUID() })).some(r => r.id === failRow.id));
    const metrics = await collectMetrics(b, { now });
    ok('metrics count the failed row', metrics.failed_count >= 1, JSON.stringify(metrics));
  }

  // =========================================================================
  console.log('\n— 5: no false success — a failed send / failed enqueue makes the ROUTE answer 500 with a failed heartbeat —');
  // =========================================================================
  {
    // A fresh confirmed booking gives the route real fan-out + dispatch work.
    const bk2 = await confirmedBooking(dayP(16), '5:00 PM');
    const hb0 = (await hbRows()).length;
    spy.faults.push({ url: 'api.resend.com', method: 'POST', status: 500, message: 'injected_resend_fault' });
    const r = await callRoute('notification-worker.js', req({ method: 'GET', headers: CRON }));
    spy.faults.length = 0;
    ok('a failed send -> 500 partial_failure', r.statusCode === 500 && r.body && r.body.ok === false && r.body.error === 'partial_failure' && r.body.dispatch && r.body.dispatch.failed >= 1, `${r.statusCode} ${JSON.stringify(r.body).slice(0, 300)}`);
    let hb = await hbRows();
    ok("the heartbeat row is 'failed' with partial:true and a first_error code", hb.length === hb0 + 1 && hb[hb.length - 1].outcome === 'failed' && hb[hb.length - 1].summary.partial === true && /send_failed/.test(String(hb[hb.length - 1].summary.first_error)), JSON.stringify(hb[hb.length - 1]));
    const failed = (await deliveriesFor(bk2.id, '&kind=eq.demo_confirmed'))[0];
    ok('the delivery is kept as FAILED with a retry time (never deleted)', failed && failed.status === 'failed' && failed.attempts === 1 && failed.next_attempt_at, JSON.stringify([failed && failed.status, failed && failed.attempts]));
    // Recovery: make it due and run clean.
    await db(`notification_deliveries?id=eq.${failed.id}`, { method: 'PATCH', body: JSON.stringify({ next_attempt_at: iso(at(new Date(), -MIN)) }) });
    const n = spy.calls.resend.length;
    const r2 = await callRoute('notification-worker.js', req({ method: 'GET', headers: CRON }));
    ok('the next clean run sends it and recovers the heartbeat to succeeded', r2.statusCode === 200 && r2.body.ok === true && mailsSince(n).some(m => subj(m).includes('Demo confirmed:') && toContact(m, C1e)) && (await hbRows()).slice(-1)[0].outcome === 'succeeded', `${r2.statusCode}`);

    // Failed ENQUEUE (fan-out insert fails) -> 500 + failed heartbeat; the event stays unfanned for the next run.
    const bk3 = await confirmedBooking(dayP(17), '10:00 AM');
    spy.faults.push({ url: 'notification_deliveries?on_conflict=dedupe_key', method: 'POST', status: 500, message: 'injected_enqueue_fault' });
    const r3 = await callRoute('notification-worker.js', req({ method: 'GET', headers: CRON }));
    spy.faults.length = 0;
    hb = await hbRows();
    ok('a failed enqueue -> 500 and a failed heartbeat naming the fan-out error', r3.statusCode === 500 && hb[hb.length - 1].outcome === 'failed' && /fanout/.test(String(hb[hb.length - 1].summary.first_error)), `${r3.statusCode} ${JSON.stringify(hb[hb.length - 1] && hb[hb.length - 1].summary).slice(0, 200)}`);
    ok('the event is still unfanned (nothing lost)', (await eventsFor(bk3.id))[0].fanned_out_at === null);
    const r4 = await callRoute('notification-worker.js', req({ method: 'GET', headers: CRON }));
    ok('the next run fans it out and delivers', r4.statusCode === 200 && (await deliveriesFor(bk3.id, '&kind=eq.demo_confirmed'))[0].status === 'accepted', `${r4.statusCode}`);
  }

  // =========================================================================
  console.log('\n— 6: schedule identity — A -> B -> A, cancellation while claimed, DST, early demo, catch-up, first rollout —');
  // =========================================================================
  {
    // scheduleReminders / dispatchDue operate on EVERY confirmed booking (as in production). To keep
    // the injected-clock assertions about bk1 exact, retire the reminder rows of this retailer's other
    // fixture bookings first, and identify bk1's mail by its unique product name.
    await db(`notification_deliveries?retailer_id=eq.${retailerId}&booking_id=neq.${bk1.id}&status=eq.pending`, { method: 'PATCH', body: JSON.stringify({ status: 'skipped', skip_reason: 'test_housekeeping' }) });
    await db(`bookings?id=eq.${bk1.id}`, { method: 'PATCH', body: JSON.stringify({ product: 'Cold Brew Alpha' }) });
    const rec = recordingMailer(b);
    const bk1Calls = () => rec.calls.filter(c => String(c.body.html).includes('Cold Brew Alpha'));

    // Reminders for bk1 (occurrence :1) at a clock long before any is due.
    const early = at(start1, -14 * 24 * HOUR);
    const s = await scheduleReminders(b, { now: early });
    const rem1 = await deliveriesFor(bk1.id, '&kind=eq.reminder');
    const keys1 = rem1.map(r => r.offset_key).sort();
    ok('scheduled d3, d1, morning_of, h1 for occurrence :1, all pending', s.errors.length === 0 && JSON.stringify(keys1) === JSON.stringify(['d1', 'd3', 'h1', 'morning_of']) && rem1.every(r => r.status === 'pending' && r.occurrence_key === `${bk1.id}:1`), JSON.stringify({ s, keys1 }));
    const wd1A = reminderWindow('d1', start1, LA);
    ok('d1 due_at is 09:00 local the day before with a 2h catch-up', iso(new Date(rem1.find(r => r.offset_key === 'd1').due_at)) === iso(wd1A.due_at) && iso(new Date(rem1.find(r => r.offset_key === 'd1').expires_at)) === iso(wd1A.expires_at));

    // Move A -> B (direct schedule change with a revision bump, as accept_reschedule does).
    const DB = dayP(22);
    await db(`bookings?id=eq.${bk1.id}`, { method: 'PATCH', body: JSON.stringify({ demo_date: DB, schedule_revision: 2 }) });
    const startB = demoStartUtc(DB, T1, LA);
    const s2 = await scheduleReminders(b, { now: early });
    const rem2 = await deliveriesFor(bk1.id, `&kind=eq.reminder&occurrence_key=eq.${bk1.id}:2`);
    ok('after A -> B: four NEW pending rows for occurrence :2 with new dedupe keys', s2.errors.length === 0 && rem2.length === 4 && rem2.every(r => r.status === 'pending' && !rem1.some(o => o.dedupe_key === r.dedupe_key)), JSON.stringify(rem2.map(r => r.dedupe_key)));
    // Dispatch at slot A's d1 instant: the :1 rows are claimed and SKIPPED 'rescheduled' (occurrence mismatch).
    const r1 = await dispatchDue(b, { now: wd1A.due_at, mailer: rec.mailer });
    const rem1After = await deliveriesFor(bk1.id, `&kind=eq.reminder&occurrence_key=eq.${bk1.id}:1`);
    ok('at slot A\'s d1 instant the stale :1 d3/d1 rows are skipped "rescheduled", no email', r1.skip_reasons.rescheduled >= 2 && bk1Calls().length === 0 && rem1After.filter(r => ['d3', 'd1'].includes(r.offset_key)).every(r => r.status === 'skipped' && r.skip_reason === 'rescheduled'), JSON.stringify({ r1, rows: rem1After.map(r => [r.offset_key, r.status, r.skip_reason]) }));
    // Dispatch at slot B's d1 instant: the :2 d1 fires for slot B ("Demo tomorrow").
    const wd1B = reminderWindow('d1', startB, LA);
    const r2 = await dispatchDue(b, { now: wd1B.due_at, mailer: rec.mailer });
    const d1B = (await deliveriesFor(bk1.id, `&kind=eq.reminder&occurrence_key=eq.${bk1.id}:2&offset_key=eq.d1`))[0];
    ok('at slot B\'s d1 instant the :2 d1 reminder fires ("Demo tomorrow"), once', d1B.status === 'accepted' && bk1Calls().length === 1 && /Demo tomorrow/.test(bk1Calls()[0].body.subject), JSON.stringify({ r2, subject: bk1Calls()[0] && bk1Calls()[0].body.subject }));
    // Move B -> A (revision 3): the destination is slot A again, but the occurrence is new.
    await db(`bookings?id=eq.${bk1.id}`, { method: 'PATCH', body: JSON.stringify({ demo_date: D1, schedule_revision: 3 }) });
    const s3 = await scheduleReminders(b, { now: early });
    const rem3 = await deliveriesFor(bk1.id, `&kind=eq.reminder&occurrence_key=eq.${bk1.id}:3`);
    ok('after B -> A: four pending rows for occurrence :3, keys distinct from :1 (same date/time is NOT the same reminder)', s3.errors.length === 0 && rem3.length === 4 && rem3.every(r => r.status === 'pending' && !rem1.some(o => o.dedupe_key === r.dedupe_key)), JSON.stringify(rem3.map(r => r.dedupe_key)));
    const r3 = await dispatchDue(b, { now: wd1A.due_at, mailer: rec.mailer });
    const d1A3 = (await deliveriesFor(bk1.id, `&kind=eq.reminder&occurrence_key=eq.${bk1.id}:3&offset_key=eq.d1`))[0];
    ok('at slot A\'s d1 instant the :3 d1 fires ("Demo tomorrow") even though a :1 d1 for the same instant existed', d1A3.status === 'accepted' && bk1Calls().length === 2 && /Demo tomorrow/.test(bk1Calls()[1].body.subject), JSON.stringify({ r3, subjects: bk1Calls().map(c => c.body.subject) }));
    ok('the :2 rows for slot B are retired or pending — never sent for a slot the demo is no longer on', (await deliveriesFor(bk1.id, `&kind=eq.reminder&occurrence_key=eq.${bk1.id}:2`)).filter(r => r.status === 'accepted').length === 1);

    // CANCELLATION AFTER CLAIM: claim the :3 morning_of row, then cancel the booking (trigger retires
    // pending/claimed rows); the worker's send is suppressed and nothing is written over the retirement.
    const wMorn = reminderWindow('morning_of', start1, LA);
    const claimed = await claimDue(b, { now: wMorn.due_at, batch: 20, claimToken: crypto.randomUUID() });
    const mornRow = claimed.find(r => r.offset_key === 'morning_of' && r.occurrence_key === `${bk1.id}:3`);
    ok('the :3 morning_of row is claimed at 07:00 local', !!mornRow, JSON.stringify(claimed.map(r => [r.offset_key, r.occurrence_key === `${bk1.id}:3`])));
    await db(`bookings?id=eq.${bk1.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'cancelled', cancel_reason: 'race test' }) });
    const before = bk1Calls().length;
    const rc = await processClaimed(b, mornRow, { now: wMorn.due_at, token: mornRow.claim_token, mailer: rec.mailer });
    const mornAfter = await delivery(mornRow.id);
    ok('a cancellation that lands while the row is claimed suppresses the send: skipped booking_cancelled, no email', rc.outcome === 'skipped' && mornAfter.status === 'skipped' && mornAfter.skip_reason === 'booking_cancelled' && bk1Calls().length === before, JSON.stringify([rc, mornAfter.status, mornAfter.skip_reason]));
    ok('the cancel wrote a demo_cancelled event', (await eventsFor(bk1.id)).some(e => e.kind === 'demo_cancelled'));
    // Release the other rows that claim swept up (they belong to later assertions of other bookings).
    await db(`notification_deliveries?retailer_id=eq.${retailerId}&status=eq.claimed`, { method: 'PATCH', body: JSON.stringify({ status: 'pending', claim_token: null, lease_until: null }) });

    // DST: a demo two days after the March change: d3 in PST (17:00Z), d1 in PDT (16:00Z).
    const bkDst = await confirmedBooking('2027-03-16', '11:00 AM', { product: 'Cold Brew DST' });   // US DST 2027 begins Mar 14
    const sDst = await scheduleReminders(b, { now: new Date('2027-03-01T12:00:00Z') });
    const remDst = await deliveriesFor(bkDst.id, '&kind=eq.reminder');
    const by = Object.fromEntries(remDst.map(r => [r.offset_key, r]));
    ok('DST: d3 lands on Mar 13 09:00 PST = 17:00Z; d1 on Mar 15 09:00 PDT = 16:00Z; morning_of 07:00 PDT = 14:00Z; h1 = 17:00Z', sDst.errors.length === 0 && by.d3 && iso(new Date(by.d3.due_at)) === '2027-03-13T17:00:00.000Z' && iso(new Date(by.d1.due_at)) === '2027-03-15T16:00:00.000Z' && iso(new Date(by.morning_of.due_at)) === '2027-03-16T14:00:00.000Z' && iso(new Date(by.h1.due_at)) === '2027-03-16T17:00:00.000Z', JSON.stringify(remDst.map(r => [r.offset_key, r.due_at])));

    // Early demo: morning_of is recorded as skipped 'starts_before_morning_of'; h1 still scheduled.
    const bkEarly = await confirmedBooking(dayP(18), '6:30 AM', { product: 'Cold Brew Early' });
    await scheduleReminders(b, { now: new Date() });
    const remEarly = await deliveriesFor(bkEarly.id, '&kind=eq.reminder');
    ok('a 6:30 AM demo: morning_of is SKIPPED starts_before_morning_of (recorded, explainable); h1 pending', remEarly.some(r => r.offset_key === 'morning_of' && r.status === 'skipped' && r.skip_reason === 'starts_before_morning_of') && remEarly.some(r => r.offset_key === 'h1' && r.status === 'pending'), JSON.stringify(remEarly.map(r => [r.offset_key, r.status, r.skip_reason])));

    // Catch-up expiry: a pending d3 first dispatched 1 minute after its 2h window is skipped 'expired'.
    const d3Early = remEarly.find(r => r.offset_key === 'd3');
    const rExp = await dispatchDue(b, { now: at(new Date(d3Early.expires_at), MIN), mailer: rec.mailer });
    ok('a reminder first seen after its catch-up window is skipped "expired"', (await delivery(d3Early.id)).skip_reason === 'expired' && rExp.skip_reasons.expired >= 1, JSON.stringify(rExp));

    // First rollout: a confirmed booking in 2 days whose d3 is already past -> skipped
    // 'due_before_scheduling'; d1 / morning_of / h1 pending. No burst.
    const bkSoon = await confirmedBooking(dayP(2), '3:00 PM', { product: 'Cold Brew Soon' });
    const sSoon = await scheduleReminders(b, { now: new Date() });
    const remSoon = await deliveriesFor(bkSoon.id, '&kind=eq.reminder');
    const soonBy = Object.fromEntries(remSoon.map(r => [r.offset_key, r]));
    ok('first rollout: already-due d3 inserted as skipped due_before_scheduling; d1/morning_of/h1 pending', sSoon.errors.length === 0 && soonBy.d3 && soonBy.d3.status === 'skipped' && soonBy.d3.skip_reason === 'due_before_scheduling' && ['d1', 'morning_of', 'h1'].every(k => soonBy[k] && soonBy[k].status === 'pending'), JSON.stringify(remSoon.map(r => [r.offset_key, r.status, r.skip_reason])));
    await dispatchDue(b, { now: new Date(), mailer: rec.mailer });
    ok('a dispatch right after first rollout sends NO backlog for the already-due offset', !rec.calls.some(c => String(c.body.html).includes('Cold Brew Soon') && /Demo in 3 days/.test(c.body.subject)));
    // Impossible date: refused at the booking entry point (proven in store_contact_notifications);
    // here the strict helper refuses to schedule anything for it.
    ok('impossible date resolves to nothing (never scheduled, never guessed)', demoStartUtc('2026-02-30', '11:00 AM', LA) === null);
  }

  // =========================================================================
  console.log('\n— 7: COI decisions — approve/reject via review_coi_verification; replay; superseded; hostile note —');
  // =========================================================================
  {
    const seed = async () => {
      const vid = crypto.randomUUID();
      const r = await rpc('finalize_coi_upload', { p_brand_id: brandId, p_verification_id: vid, p_storage_path: `brands/${brandId}/${vid}.pdf`, p_content_sha256: 'sha-' + vid.slice(0, 8), p_expires: null, p_status: 'pending' });
      if (!r.ok) throw new Error('finalize_coi_upload failed: ' + JSON.stringify(r.body));
      track('coi_verifications', vid);
      return vid;
    };
    const review = (vid, decision, extra = {}) => rpc('review_coi_verification', { p_verification_id: vid, p_decision: decision, p_reviewer: 'owner@fixture.test', p_notes: 'PRIVATE reviewer note — must never be emailed', ...extra });
    const coiEvents = async (vid) => (await db(`notification_events?transition_id=like.${vid}*&select=*`)).body || [];
    const coiDeliveries = async (vid) => (await db(`notification_deliveries?dedupe_key=like.*${vid}*&select=*&order=recipient_email.asc`)).body || [];

    // APPROVE
    const v1 = await seed();
    const exp = dayP(300);
    const a = await review(v1, 'approved', { p_expiry: exp, p_brand_note: 'Looks good — thanks for the quick turnaround.' });
    ok('approve via review_coi_verification succeeds', a.ok, JSON.stringify(a.body).slice(0, 200));
    let ev = await coiEvents(v1);
    ok('exactly one coi_approved event with the reviewed expiry and brand_note in its payload', ev.length === 1 && ev[0].kind === 'coi_approved' && ev[0].transition_id === `${v1}:approved` && ev[0].payload.expires_at === exp && /quick turnaround/.test(ev[0].payload.brand_note), JSON.stringify(ev));
    const replay = await db(`coi_verifications?id=eq.${v1}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved' }) });
    ok('re-saving the same status writes NO new event (replay-safe)', replay.ok && (await coiEvents(v1)).length === 1);
    const now = new Date();
    const f = await fanOutEvents(b, { now });
    const dels = await coiDeliveries(v1);
    ok('fan-out created one brand delivery per server-resolved account recipient (brand email + team member)', f.errors.length === 0 && dels.length === 2 && dels.every(d => d.recipient_kind === 'brand' && d.retailer_id === null) && dels.some(d => d.recipient_email === brandEmail) && dels.some(d => d.recipient_email === memberEmail), JSON.stringify(dels.map(d => [d.recipient_kind, d.status])));
    const n = spy.calls.resend.length;
    const rd = await dispatchDue(b, { now });
    // The same fan-out also released this suite's other due lifecycle rows; assert on the approvals.
    const mails = mailsSince(n).filter(m => /Certificate of Insurance is approved/.test(subj(m)));
    ok('dispatch sent exactly two approval emails (brand + member)', rd.accepted >= 2 && mails.length === 2 && mails.some(m => toContact(m, brandEmail)) && mails.some(m => toContact(m, memberEmail)), JSON.stringify({ rd, subjects: mailsSince(n).map(subj) }));
    const body = String(mails[0].html);
    const expLabel = new Date(exp + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    ok('the approval names the REVIEWED expiry and links to /brand/dashboard#compliance', body.includes(expLabel) && body.includes('/brand/dashboard#compliance') && subj(mails[0]).includes(expLabel), subj(mails[0]));
    ok('the approval carries the brand-visible note, never the private reviewer note, never a certificate/file link', /quick turnaround/.test(body) && !/PRIVATE reviewer note/.test(body) && !/coi-file|coi-docs|\.pdf|storage\/v1/.test(body));

    // REJECT with a hostile brand_note -> escaped text.
    const v2 = await seed();   // supersedes v1 (v1 is decided; v2 is the current version)
    const hostile = '<img src=x onerror=alert(1)>Wrong insured party & "quotes"';
    const rj = await review(v2, 'rejected', { p_brand_note: hostile });
    ok('reject via review_coi_verification succeeds', rj.ok, JSON.stringify(rj.body).slice(0, 200));
    ev = await coiEvents(v2);
    ok('one coi_rejected event with the brand_note', ev.length === 1 && ev[0].kind === 'coi_rejected' && ev[0].payload.brand_note === hostile, JSON.stringify(ev.map(e => e.kind)));
    await fanOutEvents(b, { now });
    const n2 = spy.calls.resend.length;
    const rd2 = await dispatchDue(b, { now });
    const rejMails = mailsSince(n2).filter(m => /needs another look/.test(subj(m)));
    ok('dispatch sent the rejection to both recipients', rd2.accepted >= 2 && rejMails.length === 2 && rejMails.some(m => toContact(m, brandEmail)) && rejMails.some(m => toContact(m, memberEmail)), JSON.stringify({ rd2, subjects: mailsSince(n2).map(subj) }));
    const rbody = String(rejMails[0].html).replace(/Non-production email[\s\S]*?<\/div>/, '');
    ok('the hostile brand_note is rendered as ESCAPED text (no <img, no raw quotes)', rbody.includes('&lt;img src=x onerror=alert(1)&gt;Wrong insured party &amp; &quot;quotes&quot;') && !rbody.includes('<img src=x'), rbody.slice(rbody.indexOf('Note from'), rbody.indexOf('Note from') + 200));
    ok('the rejection links to the compliance/upload screen and never to a certificate', rbody.includes('/brand/dashboard#compliance') && !/coi-file|coi-docs|\.pdf/.test(rbody));

    // SUPERSEDED before dispatch: approve v3, then upload v4 (v3 superseded) BEFORE the worker runs.
    const v3 = await seed();
    const a3 = await review(v3, 'approved', { p_expiry: dayP(250), p_brand_note: 'ok' });
    ok('approve v3 succeeds', a3.ok);
    const v4 = await seed();
    // finalize_coi_upload supersedes OPEN versions; a decided v3 is retired by the brand's current
    // pointer moving to v4 — which is what the dispatch recheck reads.
    ok('the brand\'s current certificate is now v4 (v3 is no longer current)', (one(await db(`brands?id=eq.${brandId}&select=current_coi_verification_id`)) || {}).current_coi_verification_id === v4);
    await fanOutEvents(b, { now });
    const n3 = spy.calls.resend.length;
    const rd3 = await dispatchDue(b, { now });
    const d3rows = await coiDeliveries(v3);
    ok('the superseded approval is NOT emailed: rows skipped "superseded", no approval mail sent', rd3.skip_reasons.superseded >= 2 && d3rows.length === 2 && d3rows.every(d => d.status === 'skipped' && d.skip_reason === 'superseded') && !mailsSince(n3).some(m => /Certificate of Insurance is approved/.test(subj(m))), JSON.stringify({ rd3, rows: d3rows.map(d => d.status) }));
    // Clean up brand rows the tests inserted (events have no FK to brands; deliveries reference events).
    for (const vid of [v1, v2, v3, v4]) {
      const evs = await coiEvents(vid);
      for (const e of evs) { await db(`notification_deliveries?event_id=eq.${e.id}`, { method: 'DELETE' }); await db(`notification_events?id=eq.${e.id}`, { method: 'DELETE' }); }
    }
  }
} finally {
  console.log('\n— teardown —');
  for (const [t, id] of bin) {
    if (t !== 'bookings') continue;
    await db(`notification_deliveries?booking_id=eq.${id}`, { method: 'DELETE' });
    await db(`notification_events?booking_id=eq.${id}`, { method: 'DELETE' });
    await db(`demos?booking_id=eq.${id}`, { method: 'DELETE' });
  }
  await db(`notification_deliveries?dedupe_key=like.*${slug}*`, { method: 'DELETE' });
  await db(`notification_events?brand_id=eq.${brandId}`, { method: 'DELETE' });
  await db(`brands?id=eq.${brandId}`, { method: 'PATCH', body: JSON.stringify({ current_coi_verification_id: null }) });
  for (const [t, id] of bin.reverse()) await db(`${t}?id=eq.${id}`, { method: 'DELETE' });
  await db(`cron_heartbeat?cron_name=eq.notification-worker&ran_at=gte.${encodeURIComponent(startIso)}`, { method: 'DELETE' });
  spy.restore();
}
process.exit(summary('notification worker mechanics') ? 0 : 1);
