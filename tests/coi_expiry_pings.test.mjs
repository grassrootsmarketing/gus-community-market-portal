// tests/coi_expiry_pings.test.mjs: owner COI expiry pings (2026-10-16) against the real test database
// (demohub-rebuild-check through tests/_route.mjs; Resend spied, the provider request recorded exactly).
//
// What this proves with real rows, the 0093 constraint and the real claim protocol:
//   * the sweep writes one delivery per offset for an approved brand with a paid upcoming demo (brand-scoped
//     rows: no retailer, no booking, no event, admitted by 0093), offsets already past recorded as skipped
//     'due_before_scheduling', the remaining one pending at 09:00 owner time; a second sweep adds nothing;
//   * a due row is claimed, rechecked and sent ONCE to the owner with the brand, the expiry date, the demo's
//     date and store, and the /owner#coi link; the provider key is the delivery id; the body is frozen;
//   * a renewal (expiry moved later) retires the old date's rows ('coi_renewed') and the next sweep schedules
//     the new date's rows; a brand back in review ('coi_not_approved') and a brand with no paid upcoming demo
//     ('no_upcoming_demos') are skipped at dispatch;
//   * the owner panel action owner-coi-expiring lists the brand with its demo count and the recorded state of
//     each ping, and refuses anonymous callers.
//
// Run from the repository root with test-database creds:  node tests/coi_expiry_pings.test.mjs
import crypto from 'node:crypto';
import { callRoute, req, ok, summary, uniq, ENV, installSpy } from './_route.mjs';
import { HOURLY } from './_fixture_availability.mjs';
import { getBinding } from '../api/_env.js';
import { sendMail } from '../api/_mail.js';
import { scheduleCoiExpiryPings, claimDue, processClaimed } from '../api/_notification-outbox.js';
import { coiExpiryDedupeKey, coiExpiryWindow, ownerToday } from '../api/_coi-expiry.js';
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
const spy = installSpy();

function recordingMailer(b) {
  const calls = [];
  const fetchSpy = async (url, opts) => { calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) }); return { ok: true, status: 200, json: async () => ({ id: 'msg_' + calls.length }), text: async () => '{}' }; };
  return { mailer: (msg, opts) => sendMail(msg, { ...opts, binding: b, fetch: fetchSpy }), calls };
}
const keyOf = (call) => call.headers['Idempotency-Key'] || call.headers['idempotency-key'];

// Fixtures: one store with one location, one approved brand expiring in 10 days with one paid confirmed demo.
const slug = uniq('cx');
const retailerId = track('retailers', one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug, name: 'Expiry Fixture Market', billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active', platform_keeps_all: true, timezone: LA, auto_confirm_bookings: false }) })).id);
track('settings', one(await db('settings', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, demo_fee: 30, demo_duration: '3 hours', advance_booking_days: 14 }) })).id);
const V1 = track('venues', one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, name: 'Expiry Main', address: '1 Expiry Way', demo_fee: 30, availability: HOURLY }) })).id);
const brandEmail = `${uniq('cxbrand')}@fixture.test`;
// EXP2 (the renewal) is 28 days out: inside the sweep's 31-day horizon whatever the owner-calendar date is, with
// the 30-day moment already past and the 14-day and 3-day moments ahead.
const EXP1 = dayP(10), EXP2 = dayP(28);
const brandId = track('brands', one(await db('brands', { method: 'POST', body: JSON.stringify({ email: brandEmail, company_name: 'Expiry Brand & Co', contact_name: 'Rep X', phone: '555-0100', default_coi_url: `brands/${slug}.pdf`, default_coi_expires: EXP1, coi_verification_status: 'approved' }) })).id);
const bookingRes = await db('bookings', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, venue_id: V1, brand_id: brandId, brand_name: 'Expiry Brand & Co', contact_name: 'Rep X', contact_phone: '555-0100', contact_email: brandEmail, product: 'Cold Brew', demo_date: dayP(6), demo_time: '10:00', status: 'confirmed', payment_status: 'paid', amount_paid: 3000 }) });
const booking = one(bookingRes);
if (!booking) throw new Error('booking insert failed: ' + bookingRes.status + ' ' + JSON.stringify(bookingRes.body).slice(0, 300));
track('bookings', booking.id);
await callRoute('find-retailer.js', req({ body: { action: 'status' } }));
const b = await getBinding();
const rowsFor = async (expiry) => ((await db(`notification_deliveries?kind=eq.coi_expiry_owner&occurrence_key=eq.${encodeURIComponent(brandId + ':' + expiry)}&select=*&order=offset_key.asc`)).body || []);
const byKey = (rows, days, expiry = EXP1) => rows.find(r => r.dedupe_key === coiExpiryDedupeKey(brandId, expiry, days));
async function claimOurs(dedupeKey, now = new Date()) {
  const token = crypto.randomUUID();
  const rows = await claimDue(b, { now, batch: 100, claimToken: token });
  const row = (rows || []).find(r => r.dedupe_key === dedupeKey);
  for (const r of (rows || [])) if (r !== row) await db(`notification_deliveries?id=eq.${r.id}`, { method: 'PATCH', body: JSON.stringify({ claim_token: null, lease_until: null, status: r.status === 'claimed' ? 'pending' : r.status }) });
  return row ? { row, token } : null;
}
const makeDue = (id, now) => db(`notification_deliveries?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'pending', claim_token: null, lease_until: null, due_at: new Date(now.getTime() - 60000).toISOString(), expires_at: new Date(now.getTime() + 3600000).toISOString() }) });

try {
  ok('fixtures exist', !!retailerId && !!V1 && !!brandId && !!booking && !!b);

  console.log('\n,  sweep: one row per offset, brand-scoped, past offsets recorded as skipped , ');
  const now = new Date();
  const s1 = await scheduleCoiExpiryPings(b, { now });
  const r1 = await rowsFor(EXP1);
  ok('sweep ran clean and found the fixture brand eligible', s1.errors.length === 0 && s1.eligible >= 1, JSON.stringify(s1));
  ok('three rows (d30, d14, d3) under kind:brand:expiry:dN keys, no retailer / booking / event (0093 admits them)', r1.length === 3 && [3, 14, 30].every(d => r1.some(x => x.dedupe_key === coiExpiryDedupeKey(brandId, EXP1, d))) && r1.every(x => x.retailer_id === null && x.booking_id === null && x.event_id === null && x.recipient_kind === 'owner' && x.recipient_email === OWNER_ALERT_EMAIL), JSON.stringify(r1.map(x => [x.dedupe_key, x.status, x.skip_reason])));
  const d30 = byKey(r1, 30), d14 = byKey(r1, 14), d3 = byKey(r1, 3);
  ok('30-day and 14-day moments already passed (expiry in 10 days): skipped due_before_scheduling', d30.status === 'skipped' && d30.skip_reason === 'due_before_scheduling' && d14.status === 'skipped' && d14.skip_reason === 'due_before_scheduling');
  const w3 = coiExpiryWindow(EXP1, 3);
  ok('3-day ping pending at 09:00 owner time on expiry minus 3, 24h catch-up', d3.status === 'pending' && new Date(d3.due_at).getTime() === w3.due_at.getTime() && new Date(d3.expires_at).getTime() === w3.expires_at.getTime(), JSON.stringify([d3.due_at, w3.due_at]));
  const s2 = await scheduleCoiExpiryPings(b, { now });
  ok('a second sweep adds nothing (idempotent on dedupe_key)', s2.errors.length === 0 && (await rowsFor(EXP1)).length === 3, JSON.stringify(s2));

  console.log('\n,  dispatch: claim, recheck, freeze, send once , ');
  {
    await makeDue(d3.id, now);
    const rec = recordingMailer(b);
    const c = await claimOurs(d3.dedupe_key, now);
    ok('the due row is claimed by the real claim protocol', !!c, 'not claimed');
    const r = c ? await processClaimed(b, c.row, { now, token: c.token, mailer: rec.mailer }) : null;
    const after = (await rowsFor(EXP1)).find(x => x.id === d3.id);
    ok('accepted: one provider call, key = delivery id, frozen to the owner', r && r.outcome === 'accepted' && after.status === 'accepted' && rec.calls.length === 1 && keyOf(rec.calls[0]) === after.id && after.frozen_payload && after.frozen_payload.to === OWNER_ALERT_EMAIL && after.idempotency_key === after.id, JSON.stringify({ r, calls: rec.calls.length }));
    const html = (after.frozen_payload && after.frozen_payload.html) || '';
    ok('subject: brand, 3 days, demo count', /^COI expiring in 3 days: Expiry Brand & Co \(1 upcoming demo\)$/.test(after.frozen_payload.subject), after.frozen_payload.subject);
    ok('body: escaped brand name, the expiry date, the demo date and store, the COI Review link, no em dash', html.includes('Expiry Brand &amp; Co') && html.includes('Expiry Fixture Market, Expiry Main') && /href="[^"]+\/owner#coi"/.test(html) && !/\u2014/.test(html), html.slice(0, 200));
    // Re-run on the accepted row: nothing is claimable, nothing is sent.
    const again = await claimOurs(d3.dedupe_key, now);
    ok('an accepted row is never claimed again', again === null);
  }

  console.log('\n,  renewal: the old date stops, the new date gets its own rows , ');
  {
    await db(`brands?id=eq.${brandId}`, { method: 'PATCH', body: JSON.stringify({ default_coi_expires: EXP2 }) });
    await makeDue(d3.id, now);   // pretend the 3-day ping had not gone out yet
    const rec = recordingMailer(b);
    const c = await claimOurs(d3.dedupe_key, now);
    const r = c ? await processClaimed(b, c.row, { now, token: c.token, mailer: rec.mailer }) : null;
    ok('old date\'s ping: skipped coi_renewed, no provider call', r && r.outcome === 'skipped' && r.reason === 'coi_renewed' && rec.calls.length === 0, JSON.stringify(r));
    const s3 = await scheduleCoiExpiryPings(b, { now });
    const r2 = await rowsFor(EXP2);
    const p14 = byKey(r2, 14, EXP2), p30 = byKey(r2, 30, EXP2), p3 = byKey(r2, 3, EXP2);
    ok('next sweep: three rows for the renewed date under its own keys (30-day moment past: skipped; 14-day and 3-day pending), the old date\'s rows untouched', s3.errors.length === 0 && r2.length === 3 && p30 && p30.status === 'skipped' && p30.skip_reason === 'due_before_scheduling' && p14 && p14.status === 'pending' && p3 && p3.status === 'pending' && (await rowsFor(EXP1)).length === 3, JSON.stringify(r2.map(x => [x.offset_key, x.status, x.skip_reason])));
    // Back in review: a renewal upload awaiting the owner's decision.
    await db(`brands?id=eq.${brandId}`, { method: 'PATCH', body: JSON.stringify({ coi_verification_status: 'pending' }) });
    await makeDue(p14.id, now);
    const c2 = await claimOurs(p14.dedupe_key, now);
    const rr = c2 ? await processClaimed(b, c2.row, { now, token: c2.token, mailer: rec.mailer }) : null;
    ok('brand back in review: skipped coi_not_approved', rr && rr.outcome === 'skipped' && rr.reason === 'coi_not_approved' && rec.calls.length === 0, JSON.stringify(rr));
    // Approved again, but the only paid demo is cancelled.
    await db(`brands?id=eq.${brandId}`, { method: 'PATCH', body: JSON.stringify({ coi_verification_status: 'approved' }) });
    await db(`bookings?id=eq.${booking.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }) });
    await makeDue(p14.id, now);
    const c3 = await claimOurs(p14.dedupe_key, now);
    const r3 = c3 ? await processClaimed(b, c3.row, { now, token: c3.token, mailer: rec.mailer }) : null;
    ok('no paid upcoming demo any more: skipped no_upcoming_demos', r3 && r3.outcome === 'skipped' && r3.reason === 'no_upcoming_demos' && rec.calls.length === 0, JSON.stringify(r3));
    await db(`bookings?id=eq.${booking.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'confirmed' }) });
    await db(`brands?id=eq.${brandId}`, { method: 'PATCH', body: JSON.stringify({ default_coi_expires: EXP1 }) });
  }

  console.log('\n,  owner panel: Expiring in the next 30 days , ');
  {
    let ownerCookie;
    { const OWNER_EMAIL = 'david@demohubhq.com'; const ex = await db('retailers?slug=eq.__owner__&select=id'); const ownerRid = (ex.body && ex.body[0] && ex.body[0].id) || (await db('retailers', { method: 'POST', body: JSON.stringify({ slug: '__owner__', name: 'Demohub Owner (system)', billing_email: OWNER_EMAIL }) })).body[0].id; const tok = (await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: OWNER_EMAIL, retailer_id: ownerRid }) })).body[0]; ownerCookie = (await callRoute('admin-auth.js', req({ body: { action: 'owner-verify', token: tok.token } }))).cookie('dh_owner_session'); }
    const anon = await callRoute('admin-auth.js', req({ body: { action: 'owner-coi-expiring' } }));
    ok('anonymous: 401', anon.statusCode === 401, String(anon.statusCode));
    const res = await callRoute('admin-auth.js', req({ body: { action: 'owner-coi-expiring' }, cookies: { dh_owner_session: ownerCookie } }));
    const j = res.body || {};
    const mine = Array.isArray(j.expiring) ? j.expiring.find(x => x.brand_id === brandId) : null;
    ok('owner: 200 with the fixture brand, its expiry, days left and one upcoming paid demo at the fixture store', res.statusCode === 200 && j.ok === true && j.horizon_days === 30 && mine && mine.expiry === EXP1 && mine.demo_count === 1 && mine.demos[0].retailer_name === 'Expiry Fixture Market' && typeof mine.days_left === 'number', JSON.stringify({ status: res.statusCode, mine: mine || j }).slice(0, 400));
    ok('owner: the three pings carry their recorded state (d30/d14 skipped when first scheduled, d3 accepted then renewed)', mine && mine.pings.length === 3 && mine.pings.find(p => p.days === 30).skip_reason === 'due_before_scheduling' && mine.pings.find(p => p.days === 14).skip_reason === 'due_before_scheduling' && mine.pings.find(p => p.days === 3).status === 'skipped' && mine.pings.find(p => p.days === 3).skip_reason === 'coi_renewed', JSON.stringify(mine && mine.pings));
    ok('owner: no frozen body, provider id, claim token or document URL leaves the server', !/frozen_payload|provider_message_id|claim_token|idempotency_key|default_coi_url/.test(JSON.stringify(j)));
    const today = ownerToday(new Date());
    ok('owner: every listed brand expires today or later within the horizon', Array.isArray(j.expiring) && j.expiring.every(x => x.expiry >= today && x.days_left <= 30));
  }
} finally {
  console.log('\n,  teardown , ');
  await db(`notification_deliveries?kind=eq.coi_expiry_owner&occurrence_key=like.${encodeURIComponent(brandId + ':*')}`, { method: 'DELETE' });
  for (const [t, id] of bin) {
    if (t !== 'bookings') continue;
    await db(`notification_deliveries?booking_id=eq.${id}`, { method: 'DELETE' });
    await db(`notification_events?booking_id=eq.${id}`, { method: 'DELETE' });
    await db(`demos?booking_id=eq.${id}`, { method: 'DELETE' });
  }
  await db(`notification_events?brand_id=eq.${brandId}`, { method: 'DELETE' });
  for (const [t, id] of bin.reverse()) await db(`${t}?id=eq.${id}`, { method: 'DELETE' });
  spy.restore();
}
process.exit(summary('owner COI expiry pings (database)') ? 0 : 1);
