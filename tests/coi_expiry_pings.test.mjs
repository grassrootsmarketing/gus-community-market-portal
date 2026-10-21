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
//     each ping, says whether the emails are on, and refuses anonymous callers, retailer staff, brand owners and
//     brand bookers (Codex C4);
//   * the switch (Codex C2): with COI_EXPIRY_PINGS_ENABLED unset the sweep inserts nothing and reports what it is
//     holding, the real claim protocol leaves a due COI row pending while a due row of another kind is claimed, a COI
//     row handed to the worker is deferred back to pending with no provider call, the panel reports enabled:false;
//     on again, the held row is claimed and sent once, the sweep adds nothing new, and a row whose catch-up window
//     passed while off is skipped 'expired'.
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
ENV.COI_EXPIRY_PINGS_ENABLED = 'true';   // the feature under test; the switch section turns it off and on again
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
    // Codex C3: the countdown is today's (the expiry is 10 UTC days out; 9 to 11 on the owner calendar depending on the hour), while the footer names the 3-day schedule slot.
    ok('subject: brand, today\'s countdown (not the slot), demo count; footer names the 3-day reminder and the facts time', /^COI expiring in (9|10|11) days: Expiry Brand & Co \(1 upcoming demo\)$/.test(after.frozen_payload.subject) && /This is the 3-day reminder/.test(html) && /Facts as of/.test(html), after.frozen_payload.subject);
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
  let ownerCookie;
  {
    { const OWNER_EMAIL = 'david@demohubhq.com'; const ex = await db('retailers?slug=eq.__owner__&select=id'); const ownerRid = (ex.body && ex.body[0] && ex.body[0].id) || (await db('retailers', { method: 'POST', body: JSON.stringify({ slug: '__owner__', name: 'Demohub Owner (system)', billing_email: OWNER_EMAIL }) })).body[0].id; const tok = (await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: OWNER_EMAIL, retailer_id: ownerRid }) })).body[0]; ownerCookie = (await callRoute('admin-auth.js', req({ body: { action: 'owner-verify', token: tok.token } }))).cookie('dh_owner_session'); }
    const anon = await callRoute('admin-auth.js', req({ body: { action: 'owner-coi-expiring' } }));
    ok('anonymous: 401', anon.statusCode === 401, String(anon.statusCode));
    const res = await callRoute('admin-auth.js', req({ body: { action: 'owner-coi-expiring' }, cookies: { dh_owner_session: ownerCookie } }));
    const j = res.body || {};
    const mine = Array.isArray(j.expiring) ? j.expiring.find(x => x.brand_id === brandId) : null;
    ok('owner: the response says the emails are on and the list is complete', j.enabled === true && j.incomplete === false && j.truncated && j.truncated.brands === false && j.truncated.pings === false, JSON.stringify([j.enabled, j.truncated]));
    ok('owner: 200 with the fixture brand, its expiry, days left and one upcoming paid demo at the fixture store', res.statusCode === 200 && j.ok === true && j.horizon_days === 30 && mine && mine.expiry === EXP1 && mine.demo_count === 1 && mine.demos[0].retailer_name === 'Expiry Fixture Market' && typeof mine.days_left === 'number', JSON.stringify({ status: res.statusCode, mine: mine || j }).slice(0, 400));
    ok('owner: the three pings carry their recorded state (d30/d14 skipped when first scheduled, d3 accepted then renewed)', mine && mine.pings.length === 3 && mine.pings.find(p => p.days === 30).skip_reason === 'due_before_scheduling' && mine.pings.find(p => p.days === 14).skip_reason === 'due_before_scheduling' && mine.pings.find(p => p.days === 3).status === 'skipped' && mine.pings.find(p => p.days === 3).skip_reason === 'coi_renewed', JSON.stringify(mine && mine.pings));
    ok('owner: no frozen body, provider id, claim token or document URL leaves the server', !/frozen_payload|provider_message_id|claim_token|idempotency_key|default_coi_url/.test(JSON.stringify(j)));
    const today = ownerToday(new Date());
    ok('owner: every listed brand expires today or later within the horizon', Array.isArray(j.expiring) && j.expiring.every(x => x.expiry >= today && x.days_left <= 30));
  }
  console.log('\n,  authorization: only the owner session may read the cross-store list (Codex C4) , ');
  {
    const staffEmail = `${uniq('staff')}@fixture.test`;
    track('retailer_admins', one(await db('retailer_admins', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, email: staffEmail, email_normalized: staffEmail, name: 'Staff fixture', role: 'owner' }) })).id);
    const stTok = one(await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: staffEmail, retailer_id: retailerId }) }));
    const staffCookie = (await callRoute('admin-auth.js', req({ body: { action: 'verify', token: stTok.token } }))).cookie('dh_retailer_session');
    const boTok = one(await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: brandId, email: brandEmail, token: 'tk-' + uniq('o'), expires_at: new Date(Date.now() + 36e5).toISOString() }) }));
    const ownerBrandCookie = (await callRoute('brand-account.js', req({ body: { action: 'verify', token: boTok.token } }))).cookie('dh_brand_session');
    const bkEmail = `${uniq('booker')}@fixture.test`;
    track('brand_members', one(await db('brand_members', { method: 'POST', body: JSON.stringify({ brand_id: brandId, email: bkEmail, name: 'Bea Booker', role: 'booker', status: 'accepted', accepted_at: new Date().toISOString() }) })).id);
    const bkTok = one(await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: brandId, email: bkEmail, token: 'tk-' + uniq('b'), expires_at: new Date(Date.now() + 36e5).toISOString() }) }));
    const bookerCookie = (await callRoute('brand-account.js', req({ body: { action: 'verify', token: bkTok.token } }))).cookie('dh_brand_session');
    ok('fixtures: retailer staff, brand owner and brand booker sessions exist', !!staffCookie && !!ownerBrandCookie && !!bookerCookie);
    const tryWith = async (cookies) => (await callRoute('admin-auth.js', req({ body: { action: 'owner-coi-expiring' }, cookies }))).statusCode;
    const st = await tryWith({ dh_retailer_session: staffCookie }), bo = await tryWith({ dh_brand_session: ownerBrandCookie }), bk = await tryWith({ dh_brand_session: bookerCookie });
    ok('retailer staff (store owner role) with a valid store session: 401, no cross-store list', st === 401, String(st));
    ok('brand owner session: 401', bo === 401, String(bo));
    ok('brand booker session: 401', bk === 401, String(bk));
    const swap = await tryWith({ dh_owner_session: ownerBrandCookie }), swap2 = await tryWith({ dh_owner_session: staffCookie });
    ok('a brand or store session value presented in the owner cookie slot: 401', swap === 401 && swap2 === 401, [swap, swap2].join(','));
    const own = await tryWith({ dh_owner_session: ownerCookie });
    ok('the owner session still answers 200 (the matrix did not break the positive path)', own === 200, String(own));
  }

  console.log('\n,  switch: COI_EXPIRY_PINGS_ENABLED off holds rows, on resumes them (Codex C2) , ');
  {
    const now2 = new Date();
    const r0 = await rowsFor(EXP1);
    const d3r = byKey(r0, 3), d14r = byKey(r0, 14);
    await makeDue(d3r.id, now2);   // the 3-day row: pending, due a minute ago, inside its window
    // A due row of ANOTHER kind that the 0074 shape also admits without a retailer (a COI decision notice with no
    // event behind it): the real claim must take it while leaving the COI expiry row alone.
    const other = one(await db('notification_deliveries', { method: 'POST', body: JSON.stringify({ event_id: null, retailer_id: null, booking_id: null, recipient_kind: 'brand', recipient_id: null, recipient_email: 'sink@fixture.test', kind: 'coi_approved', offset_key: 'now', occurrence_key: 'cx-switch-' + slug, dedupe_key: 'coi_approved:cx-switch:' + slug, attempts: 0, due_at: new Date(now2.getTime() - 60000).toISOString(), expires_at: null, status: 'pending', skip_reason: null }) }));
    track('notification_deliveries', other.id);
    delete process.env.COI_EXPIRY_PINGS_ENABLED;
    const sOff = await scheduleCoiExpiryPings(b, { now: now2 });
    ok('OFF: the sweep inserts nothing, reports enabled:false and at least the one held row', sOff.enabled === false && sOff.held >= 1 && sOff.errors.length === 0 && (await rowsFor(EXP1)).length === 3, JSON.stringify(sOff));
    const token = crypto.randomUUID();
    const claimed = await claimDue(b, { now: now2, batch: 200, claimToken: token });
    const d3Off = (await rowsFor(EXP1)).find(x => x.id === d3r.id);
    ok('OFF: the real claim takes the due row of the other kind and leaves the due COI expiry row pending', claimed.some(x => x.id === other.id) && !claimed.some(x => x.kind === 'coi_expiry_owner') && d3Off.status === 'pending' && d3Off.claim_token === null, JSON.stringify([claimed.map(x => x.kind), d3Off.status]));
    for (const x of claimed) await db(`notification_deliveries?id=eq.${x.id}`, { method: 'PATCH', body: JSON.stringify({ claim_token: null, lease_until: null, status: 'pending' }) });
    const tk2 = crypto.randomUUID();
    await db(`notification_deliveries?id=eq.${d3r.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'claimed', claim_token: tk2, lease_until: new Date(now2.getTime() + 600000).toISOString() }) });
    const recOff = recordingMailer(b);
    const rDef = await processClaimed(b, { ...d3Off, status: 'claimed', claim_token: tk2 }, { now: now2, token: tk2, mailer: recOff.mailer });
    const d3Def = (await rowsFor(EXP1)).find(x => x.id === d3r.id);
    ok('OFF: a COI row handed to the worker is deferred back to pending with no provider call, its frozen payload (from the earlier send) untouched', rDef.outcome === 'deferred' && rDef.reason === 'coi_expiry_disabled' && d3Def.status === 'pending' && d3Def.claim_token === null && JSON.stringify(d3Def.frozen_payload) === JSON.stringify(d3Off.frozen_payload) && recOff.calls.length === 0, JSON.stringify(rDef));
    delete ENV.COI_EXPIRY_PINGS_ENABLED;
    const offRes = await callRoute('admin-auth.js', req({ body: { action: 'owner-coi-expiring' }, cookies: { dh_owner_session: ownerCookie } }));
    ok('OFF: the panel action still lists the brand and reports enabled:false', offRes.statusCode === 200 && offRes.body.enabled === false && Array.isArray(offRes.body.expiring) && offRes.body.expiring.some(x => x.brand_id === brandId), JSON.stringify([offRes.statusCode, offRes.body && offRes.body.enabled]));
    ENV.COI_EXPIRY_PINGS_ENABLED = 'true'; process.env.COI_EXPIRY_PINGS_ENABLED = 'true';
    const recOn = recordingMailer(b);
    const c = await claimOurs(d3r.dedupe_key, now2);
    const rOn = c ? await processClaimed(b, c.row, { now: now2, token: c.token, mailer: recOn.mailer }) : null;
    const d3On = (await rowsFor(EXP1)).find(x => x.id === d3r.id);
    ok('ON again: the held row is claimed by the normal protocol and sent once, under its own id', rOn && rOn.outcome === 'accepted' && d3On.status === 'accepted' && recOn.calls.length === 1 && keyOf(recOn.calls[0]) === d3On.id, JSON.stringify(rOn));
    ok('ON again: the subject countdown is today\'s (3 days left for an expiry 10 days out is impossible, so it reads the real number) and the body is frozen', d3On.frozen_payload && /^COI expiring in \d+ days: Expiry Brand & Co/.test(d3On.frozen_payload.subject) && /Facts as of/.test(d3On.frozen_payload.html), d3On.frozen_payload && d3On.frozen_payload.subject);
    const sOn = await scheduleCoiExpiryPings(b, { now: now2 });
    ok('ON again: the sweep adds nothing new (dedupe keys unchanged)', sOn.enabled === true && sOn.errors.length === 0 && (await rowsFor(EXP1)).length === 3, JSON.stringify(sOn));
    await db(`notification_deliveries?id=eq.${d14r.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'pending', claim_token: null, lease_until: null, skip_reason: null, due_at: new Date(now2.getTime() - 2 * 864e5).toISOString(), expires_at: new Date(now2.getTime() - 864e5).toISOString() }) });
    const c2 = await claimOurs(d14r.dedupe_key, now2);
    const rExp = c2 ? await processClaimed(b, c2.row, { now: now2, token: c2.token, mailer: recOn.mailer }) : null;
    ok('ON again: a row whose catch-up window passed while off is skipped expired, never sent late', rExp && rExp.outcome === 'skipped' && rExp.reason === 'expired' && recOn.calls.length === 1, JSON.stringify(rExp));
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
