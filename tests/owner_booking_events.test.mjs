// tests/owner_booking_events.test.mjs — Codex H2 (2026-09-12): the owner's "a brand actually booked"
// notice as a DURABLE outbox event (0080 + api/_notification-outbox.js recipient_kind 'owner').
//
// Real test database + the outbox functions in-process with a recording mailer (exact provider
// request, headers included). Asserts event identity, message kind, provider calls and durable
// state separately — never blanket mail counts.
import crypto from 'node:crypto';
import { callRoute, req, ok, summary, uniq, ENV } from './_route.mjs';
import { HOURLY } from './_fixture_availability.mjs';
import { getBinding } from '../api/_env.js';
import { sendMail } from '../api/_mail.js';
import { fanOutEvents, claimDue, processClaimed, makeCache, backoffMs, RESEND_IDEMPOTENCY_WINDOW_MS } from '../api/_notification-outbox.js';
import { OWNER_ALERT_EMAIL } from '../api/_owner-alerts.js';

ENV.NOTIFICATION_WORKER_ENABLED = 'true';
const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  return { ok: r.ok, status: r.status, body: j };
};
const one = (r) => (r && Array.isArray(r.body) ? r.body[0] : null);
const bin = [];
const track = (t, id) => { if (id) bin.push([t, id]); return id; };
const LA = 'America/Los_Angeles';
const dayP = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const at = (d, ms = 0) => new Date(d.getTime() + ms);

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

// Fixtures: a manual-confirm retailer with one venue, one brand.
const slug = uniq('own');
const retailerId = track('retailers', one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug, name: 'Owner Fixture Market', billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active', platform_keeps_all: true, timezone: LA, auto_confirm_bookings: false }) })).id);
track('settings', one(await db('settings', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, demo_fee: 30, demo_duration: '3 hours', advance_booking_days: 14 }) })).id);
const V1 = track('venues', one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, name: 'Owner Main', address: '1 Owner Way', demo_fee: 30, availability: HOURLY }) })).id);
const brandEmail = `${uniq('obrand')}@fixture.test`;
const brandId = track('brands', one(await db('brands', { method: 'POST', body: JSON.stringify({ email: brandEmail, company_name: 'Owner Brand Co', contact_name: 'Rep O', phone: '555-0100' }) })).id);
await callRoute('find-retailer.js', req({ body: { action: 'status' } }));
const b = await getBinding();

let hourN = 6;
async function booking(extra = {}) {
  const res = await db('bookings', { method: 'POST', body: JSON.stringify({
    retailer_id: retailerId, venue_id: V1, brand_id: brandId, brand_name: 'Owner Brand Co', contact_name: 'Rep O', contact_phone: '555-0100', contact_email: brandEmail,
    product: 'Cold Brew', demo_date: dayP(20 + Math.floor(hourN / 16)), demo_time: `${6 + (hourN++ % 16)}:00`, status: 'pending_payment', payment_status: 'unpaid', amount_paid: 3000, ...extra }) });
  const row = one(res);
  if (!row) throw new Error('booking insert failed: ' + res.status + ' ' + JSON.stringify(res.body).slice(0, 300));
  track('bookings', row.id);
  return row;
}
const patch = async (id, fields) => one(await db(`bookings?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(fields) }));
const events = async (bid) => ((await db(`notification_events?booking_id=eq.${bid}&kind=eq.owner_booking_created&select=*`)).body || []);
const deliveries = async (bid) => ((await db(`notification_deliveries?booking_id=eq.${bid}&kind=eq.owner_booking_created&select=*`)).body || []);
const demosOf = async (bid) => ((await db(`demos?booking_id=eq.${bid}&select=id,status`)).body || []);
const fan = (now = new Date()) => fanOutEvents(b, { now });
async function claimOne(bid, now = new Date()) {
  const token = crypto.randomUUID();
  const rows = await claimDue(b, { now, batch: 50, claimToken: token });
  const row = (rows || []).find(r => r.booking_id === bid && r.kind === 'owner_booking_created');
  // release anything else we claimed (other suites' rows are not ours to hold)
  for (const r of (rows || [])) if (r !== row) await db(`notification_deliveries?id=eq.${r.id}`, { method: 'PATCH', body: JSON.stringify({ claim_token: null, lease_until: null, status: r.status === 'claimed' ? 'pending' : r.status }) });
  return row ? { row, token } : null;
}
const keyOf = (call) => call.headers['Idempotency-Key'] || call.headers['idempotency-key'];

try {
  ok('fixtures exist', !!retailerId && !!V1 && !!brandId && !!b);

  console.log('\n— identity: one durable event per booking, only from a verified payment state —');
  const unpaid = await booking();
  ok('S1 unpaid / abandoned checkout: NO owner event', (await events(unpaid.id)).length === 0);

  const hold = await booking({ status: 'held', held_expires_at: at(new Date(), 24 * 3600e3).toISOString() });
  await patch(hold.id, { payment_status: 'authorized' });
  const evH = await events(hold.id);
  ok('S2 authorization writes exactly one owner_booking_created event (transition_id = booking id)', evH.length === 1 && evH[0].transition_id === hold.id && evH[0].payload.payment_status === 'authorized', JSON.stringify(evH));
  const f1 = await fan();
  const dH = await deliveries(hold.id);
  ok('S2 fan-out: one delivery to the owner recipient with a stable dedupe key', f1.errors.length === 0 && dH.length === 1 && dH[0].recipient_kind === 'owner' && dH[0].recipient_email === OWNER_ALERT_EMAIL && dH[0].dedupe_key === `owner_booking_created:${hold.id}:owner` && dH[0].status === 'pending', JSON.stringify(dH.map(d => [d.recipient_kind, d.dedupe_key, d.status])));
  {
    const rec = recordingMailer(b);
    const c = await claimOne(hold.id);
    const r = await processClaimed(b, c.row, { now: new Date(), token: c.token, mailer: rec.mailer });
    const after = (await deliveries(hold.id))[0];
    ok('S2 dispatch: accepted; frozen payload is the HOLD version addressed to the owner; provider key = delivery id', r.outcome === 'accepted' && after.status === 'accepted' && after.frozen_payload && after.frozen_payload.to === OWNER_ALERT_EMAIL && /^Hold placed: Owner Brand Co/.test(after.frozen_payload.subject) && after.idempotency_key === after.id && rec.calls.length === 1 && keyOf(rec.calls[0]) === after.id, JSON.stringify({ r, subject: after.frozen_payload && after.frozen_payload.subject, key: keyOf(rec.calls[0]) }));
    ok('S2 hold copy follows the retailer\'s CURRENT mode (manual confirm): approve COI AND confirm; deadline is the booking\'s own expiry', /then confirm the booking in the retailer admin/.test(after.frozen_payload.html) && !/auto-confirm enabled/.test(after.frozen_payload.html) && /Hold expires/.test(after.frozen_payload.html));
  }
  await patch(hold.id, { payment_status: 'paid', status: 'pending' });
  await fan();
  ok('S3 a hold captured after it was announced: still ONE event and ONE delivery (no second booking-created notice)', (await events(hold.id)).length === 1 && (await deliveries(hold.id)).length === 1);

  console.log('\n— paid bookings —');
  const paid = await booking();
  await patch(paid.id, { payment_status: 'paid', status: 'pending' });
  await fan();
  {
    const rec = recordingMailer(b);
    const c = await claimOne(paid.id);
    const r = await processClaimed(b, c.row, { now: new Date(), token: c.token, mailer: rec.mailer });
    const d = (await deliveries(paid.id))[0];
    ok('S4 ordinary paid booking: one paid event, "Booked:" awaiting the retailer\'s confirmation', (await events(paid.id)).length === 1 && r.outcome === 'accepted' && /^Booked: Owner Brand Co/.test(d.frozen_payload.subject) && /PAID — awaiting/.test(d.frozen_payload.html), JSON.stringify({ r, s: d.frozen_payload && d.frozen_payload.subject }));
  }
  const paidConfirmed = await booking({ status: 'confirmed', payment_status: 'paid' });   // paid on INSERT
  await fan();
  {
    const rec = recordingMailer(b);
    const c = await claimOne(paidConfirmed.id);
    const r = await processClaimed(b, c.row, { now: new Date(), token: c.token, mailer: rec.mailer });
    const d = (await deliveries(paidConfirmed.id))[0];
    ok('S4b inserted paid+confirmed (manual-confirm retailer): event on INSERT; "PAID and CONFIRMED by the retailer", no auto-confirm claim', (await events(paidConfirmed.id)).length === 1 && r.outcome === 'accepted' && /PAID and CONFIRMED by the retailer/.test(d.frozen_payload.html) && !/auto-confirms/.test(d.frozen_payload.html), d.frozen_payload && d.frozen_payload.html.match(/Status<\/td><td[^>]*>[^<]*/)?.[0]);
  }

  console.log('\n— capture before the held notice went out —');
  const fast = await booking({ status: 'held', held_expires_at: at(new Date(), 24 * 3600e3).toISOString() });
  await patch(fast.id, { payment_status: 'authorized' });
  await patch(fast.id, { payment_status: 'paid', status: 'confirmed' });   // captured + auto-confirmed before any send
  await fan();
  {
    const rec = recordingMailer(b);
    const c = await claimOne(fast.id);
    const r = await processClaimed(b, c.row, { now: new Date(), token: c.token, mailer: rec.mailer });
    const d = await deliveries(fast.id);
    ok('S5 capture before the held worker sends: ONE current PAID+confirmed notice, never an obsolete hold notice', (await events(fast.id)).length === 1 && d.length === 1 && r.outcome === 'accepted' && /^Booked:/.test(d[0].frozen_payload.subject) && /PAID and CONFIRMED/.test(d[0].frozen_payload.html) && !/Hold placed/.test(d[0].frozen_payload.subject), JSON.stringify({ r, s: d[0] && d[0].frozen_payload && d[0].frozen_payload.subject }));
  }

  console.log('\n— failures, replays, the provider window —');
  const flaky = await booking({ status: 'held', held_expires_at: at(new Date(), 24 * 3600e3).toISOString() });
  await patch(flaky.id, { payment_status: 'authorized' });
  await fan();
  {
    const rec = recordingMailer(b, { mode: 'reject' });
    const c = await claimOne(flaky.id);
    const r1 = await processClaimed(b, c.row, { now: new Date(), token: c.token, mailer: rec.mailer });
    const d1 = (await deliveries(flaky.id))[0];
    ok('S6 a rejected first attempt is FAILED with backoff, the hold payload frozen, one event kept', r1.outcome === 'failed' && d1.status === 'failed' && d1.attempts === 1 && !!d1.next_attempt_at && /^Hold placed/.test(d1.frozen_payload.subject) && (await events(flaky.id)).length === 1, JSON.stringify({ r1, d1: [d1.status, d1.attempts] }));
    await patch(flaky.id, { payment_status: 'paid', status: 'pending' });   // captured in between
    rec.set('ok');
    const later = at(new Date(), backoffMs(1) + 1000);
    const c2 = await claimOne(flaky.id, later);
    const r2 = await processClaimed(b, c2.row, { now: later, token: c2.token, mailer: rec.mailer });
    const d2 = (await deliveries(flaky.id))[0];
    ok('S6 retry after the capture: recovers as ONE accepted delivery, same frozen payload and same key (no uncontrolled duplicate)', r2.outcome === 'accepted' && d2.status === 'accepted' && d2.attempts === 2 && rec.calls.length === 2 && keyOf(rec.calls[0]) === keyOf(rec.calls[1]) && rec.calls[0].body.subject === rec.calls[1].body.subject && (await deliveries(flaky.id)).length === 1, JSON.stringify({ r2, calls: rec.calls.map(keyOf) }));
  }
  {
    // S7 accepted, but the completion stamp is lost: a replay must reuse the frozen payload and key.
    const d = (await deliveries(paid.id))[0];
    await db(`notification_deliveries?id=eq.${d.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'pending', claim_token: null, lease_until: null, next_attempt_at: null }) });
    const rec = recordingMailer(b);
    const c = await claimOne(paid.id);
    const r = await processClaimed(b, c.row, { now: new Date(), token: c.token, mailer: rec.mailer });
    const d2 = (await deliveries(paid.id))[0];
    ok('S7 replay after a lost completion stamp: SAME idempotency key and frozen subject go to the provider (provider-side dedupe), still one delivery row', r.outcome === 'accepted' && rec.calls.length === 1 && keyOf(rec.calls[0]) === d.idempotency_key && String(rec.calls[0].body.subject).replace(/^\[[^\]]*\]\s*/, '') === d.frozen_payload.subject && d2.id === d.id && (await deliveries(paid.id)).length === 1, JSON.stringify({ r, key: keyOf(rec.calls[0]), expected: d.idempotency_key, sent: rec.calls[0] && rec.calls[0].body.subject, frozen: d.frozen_payload && d.frozen_payload.subject, rows: (await deliveries(paid.id)).length }));
  }
  {
    // S8 brand mail failed (not modelled here), retailer confirmed before the owner notice: current facts win
    const adv = await booking();
    await patch(adv.id, { payment_status: 'paid', status: 'pending' });
    await fan();
    await patch(adv.id, { status: 'confirmed' });
    const rec = recordingMailer(b);
    const c = await claimOne(adv.id);
    const r = await processClaimed(b, c.row, { now: new Date(), token: c.token, mailer: rec.mailer });
    const d = (await deliveries(adv.id))[0];
    ok('S8 manual confirmation before the owner notice: the event still resolves, as the CONFIRMED version', r.outcome === 'accepted' && /PAID and CONFIRMED by the retailer/.test(d.frozen_payload.html), JSON.stringify(r));
  }
  {
    // S9 expiry / cancellation before the send: explicit skip, nothing reactivated
    const exp = await booking({ status: 'held', held_expires_at: at(new Date(), 24 * 3600e3).toISOString() });
    await patch(exp.id, { payment_status: 'authorized' });
    await fan();
    await patch(exp.id, { status: 'expired', payment_status: 'unpaid' });   // the sweep released it
    const rec = recordingMailer(b);
    const c = await claimOne(exp.id);
    const r = await processClaimed(b, c.row, { now: new Date(), token: c.token, mailer: rec.mailer });
    const d = (await deliveries(exp.id))[0];
    ok('S9 hold released before the notice: skipped with an explicit reason, no provider call, no demo', r.outcome === 'skipped' && r.reason === 'booking_expired' && d.status === 'skipped' && rec.calls.length === 0 && (await demosOf(exp.id)).length === 0, JSON.stringify(r));
    const can = await booking();
    await patch(can.id, { payment_status: 'paid', status: 'pending' });
    await patch(can.id, { status: 'cancelled', cancelled_at: new Date().toISOString() });   // cancelled before fan-out
    const f = await fan();
    const ev = await events(can.id);
    ok('S9b cancelled before fan-out: the event is retired at fan-out (no delivery created)', f.errors.length === 0 && ev.length === 1 && ev[0].fanned_out_at && (await deliveries(can.id)).length === 0, JSON.stringify({ f, ev: ev.map(e => e.fanned_out_at) }));
  }
  {
    // S10 provider timeout/unreachable: unknown + retry; the booking/payment state is untouched
    const to = await booking();
    await patch(to.id, { payment_status: 'paid', status: 'pending' });
    await fan();
    const rec = recordingMailer(b, { mode: 'unreachable' });
    const c = await claimOne(to.id);
    const r = await processClaimed(b, c.row, { now: new Date(), token: c.token, mailer: rec.mailer });
    const d = (await deliveries(to.id))[0];
    const bk = one(await db(`bookings?id=eq.${to.id}&select=status,payment_status`));
    ok('S10 provider unreachable: recorded as UNKNOWN with a retry, frozen payload kept; booking/payment untouched, no demo', r.outcome === 'unknown' && d.status === 'unknown' && !!d.next_attempt_at && !!d.frozen_payload && bk.status === 'pending' && bk.payment_status === 'paid' && (await demosOf(to.id)).length === 0, JSON.stringify({ r, d: [d.status, d.attempts] }));
    // S12 past the provider's dedupe window an ambiguous row is surfaced, not resent
    await db(`notification_deliveries?id=eq.${d.id}`, { method: 'PATCH', body: JSON.stringify({ frozen_payload: { ...d.frozen_payload, attempted_at: at(new Date(), -(RESEND_IDEMPOTENCY_WINDOW_MS + 60000)).toISOString() }, next_attempt_at: new Date().toISOString(), claim_token: null, lease_until: null }) });
    const c2 = await claimOne(to.id);
    const r2 = await processClaimed(b, c2.row, { now: new Date(), token: c2.token, mailer: rec.mailer });
    const d2 = (await deliveries(to.id))[0];
    ok('S12 ambiguous outcome past the 24h dedupe window: final UNKNOWN (idempotency_window_expired), surfaced for an operator, not blindly resent', r2.outcome === 'unknown' && r2.final === true && d2.status === 'unknown' && d2.skip_reason === 'idempotency_window_expired' && d2.next_attempt_at === null, JSON.stringify({ r2, d2: [d2.status, d2.skip_reason] }));
  }
  {
    // S11 multi-demo checkout: one event per child booking
    const a = await booking(), c = await booking();
    await patch(a.id, { payment_status: 'paid', status: 'pending' }); await patch(c.id, { payment_status: 'paid', status: 'pending' });
    await fan();
    const ea = await events(a.id), ec = await events(c.id), da = await deliveries(a.id), dc = await deliveries(c.id);
    ok('S11 two bookings paid together: two events, two deliveries with distinct dedupe keys', ea.length === 1 && ec.length === 1 && da.length === 1 && dc.length === 1 && da[0].dedupe_key !== dc[0].dedupe_key, JSON.stringify([da[0] && da[0].dedupe_key, dc[0] && dc[0].dedupe_key]));
  }
} catch (e) {
  ok('suite ran without an unexpected exception', false, String((e && e.stack) || e).slice(0, 600));
} finally {
  console.log('\n— teardown —');
  for (const [t, id] of bin) if (t === 'bookings') { await db(`notification_deliveries?booking_id=eq.${id}`, { method: 'DELETE' }); await db(`notification_events?booking_id=eq.${id}`, { method: 'DELETE' }); await db(`demos?booking_id=eq.${id}`, { method: 'DELETE' }); }
  for (const [t, id] of bin.reverse()) { const d = await db(`${t}?id=eq.${id}`, { method: 'DELETE' }); if (!d.ok) console.log('  teardown: DELETE ' + t + ' ' + id + ' -> ' + d.status); }
}
process.exit(summary('owner booking events (Codex H2)') ? 0 : 1);
