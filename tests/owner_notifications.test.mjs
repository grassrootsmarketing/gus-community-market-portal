// tests/owner_notifications.test.mjs — Codex N-1 (design review 2026-10-03): the owner Notifications panel reads.
//
// Real routes (api/admin-auth.js -> api/_owner-notifications.js) against the test database. Fixture deliveries are
// inserted directly in every status the outbox can hold, for two stores and two schedule revisions, so the four
// lists, the exact counts, the booking view and the pagination can be checked against known rows.
//   * owner only: anonymous, retailer staff, brand and cross-origin callers are refused;
//   * malformed input is a 400; a missing booking a 404; a failed required read a 503 with retry (never an empty
//     panel); a failed enrichment read is reported in `partial` and the rows keep their ids;
//   * list definitions: scheduled / overdue (pending overdue, expired claim, retryable failure) / attention
//     (terminal failed + unknown, however old) / accepted (recorded update time only);
//   * retailer filter is applied before pagination (totals are per store); pagination beyond 1000 rows is
//     deterministic and complete; the per-booking view counts reminder TIMES and recipient EMAILS separately and
//     per schedule revision; skipped rows are counted with reasons;
//   * no frozen bodies, provider ids, claim tokens, idempotency keys or raw errors leave the server.
import crypto from 'node:crypto';
import { callRoute, req, ok, summary, uniq, installSpy } from './_route.mjs';
import { STANDARD } from './_fixture_availability.mjs';
import { publicErrorCode, ERROR_CODES, parseListInput } from '../api/_owner-notifications.js';

const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const spy = installSpy();
const db = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j }; };
const one = (r) => (r && Array.isArray(r.body) ? r.body[0] : null);
const bin = []; const track = (t, id) => { if (id) bin.push([t, id]); return id; };
const LA = 'America/Los_Angeles', NY = 'America/New_York';
const RUN = uniq('on');
const hours = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const days = (d) => hours(24 * d);
const dayP = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// ---- fixtures ----
const mkRetailer = async (tag, name, tz) => { const slug = uniq(tag); return { slug, id: track('retailers', one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug, name, verification_status: 'approved', billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active', platform_keeps_all: true, timezone: tz }) })).id) }; };
const A = await mkRetailer('ona', 'Notify Owner Market <b>A</b>', LA), B = await mkRetailer('onb', 'Notify Owner Market B', NY);
const vA = track('venues', one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: A.id, name: 'A Main', address: '1 A St', demo_fee: 30, availability: STANDARD }) })).id);
const vB = track('venues', one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: B.id, name: 'B Main', address: '1 B St', demo_fee: 30, availability: STANDARD }) })).id);
const cA1 = track('internal_contacts', one(await db('internal_contacts', { method: 'POST', body: JSON.stringify({ retailer_id: A.id, name: 'Contact "One" <script>x</script>', role: 'Lead', email: `c1-${RUN}@fixture.test`, venue_ids: [vA], notification_prefs: { on_confirmed: true, reminders: ['d3'] } }) })).id);
const cA2 = track('internal_contacts', one(await db('internal_contacts', { method: 'POST', body: JSON.stringify({ retailer_id: A.id, name: 'Contact Two', role: 'Lead', email: `c2-${RUN}@fixture.test`, venue_ids: [vA], notification_prefs: { on_confirmed: true, reminders: ['d3'] } }) })).id);
const brandEmail = `${uniq('onbrand')}@fixture.test`;
const brandId = track('brands', one(await db('brands', { method: 'POST', body: JSON.stringify({ email: brandEmail, company_name: 'Owner Notify Brand', is_verified: true }) })).id);
const mkBooking = async (r, vid, date, extra = {}) => track('bookings', one(await db('bookings', { method: 'POST', body: JSON.stringify({ retailer_id: r.id, venue_id: vid, brand_id: brandId, brand_name: 'Owner Notify Brand & Co', contact_email: brandEmail, demo_date: date, demo_time: '11:00 AM', status: 'confirmed', payment_status: 'paid', ...extra }) })).id);
const bkA = await mkBooking(A, vA, dayP(10));        // the main booking: two contacts, rescheduled once (revision 1 is current)
const bkB = await mkBooking(B, vB, dayP(5));         // second store, for the filter
const bkEmpty = await mkBooking(A, vA, dayP(40));    // confirmed, beyond lookahead: no rows at all
const bkBig = await mkBooking(A, vA, dayP(20));      // 1,050 pending rows for pagination
await db(`bookings?id=eq.${bkA}`, { method: 'PATCH', body: JSON.stringify({ schedule_revision: 1 }) });
const revA = one(await db(`bookings?id=eq.${bkA}&select=schedule_revision`)).schedule_revision;
ok('fixture: booking A is at schedule revision 1', revA === 1, String(revA));
const occA = `${bkA}:1`, occA0 = `${bkA}:0`;
// Inserting a booking as 'confirmed' makes the 0074 trigger write its demo_confirmed event (not yet fanned out: no worker ran).
const evA = (one(await db(`notification_events?booking_id=eq.${bkA}&kind=eq.demo_confirmed&select=id`)) || {}).id || null;
ok('fixture: the confirmed-booking trigger wrote a demo_confirmed event', !!evA);
track('notification_events', one(await db('notification_events', { method: 'POST', body: JSON.stringify({ retailer_id: A.id, booking_id: bkA, brand_id: brandId, kind: 'demo_rescheduled', transition_id: `${bkA}:rescheduled:1`, fanned_out_at: hours(-24) }) })).id);
let n = 0;
// PostgREST bulk inserts need identical keys on every object, so every optional column is present (null by default).
const del = (fields) => ({ event_id: null, next_attempt_at: null, lease_until: null, claim_token: null, idempotency_key: null, frozen_payload: null, provider_message_id: null, last_error: null, skip_reason: null, expires_at: null, retailer_id: A.id, booking_id: bkA, recipient_kind: 'store_contact', recipient_id: cA1, recipient_email: `c1-${RUN}@fixture.test`, kind: 'reminder', offset_key: 'd3', occurrence_key: occA, dedupe_key: `${RUN}:${++n}`, due_at: days(7), status: 'pending', attempts: 0, ...fields });
const RAW_ERROR = 'mail_send_failed: provider said 422 {"name":"validation_error","message":"The gmail.com domain is not verified"}';
const fixtures = [
  // current occurrence, contact 1 and 2: three reminder TIMES (w1 d3 morning_of) x two recipients = six scheduled emails
  del({ event_id: evA, offset_key: 'w1', due_at: days(3) }), del({ event_id: evA, offset_key: 'd3', due_at: days(7) }), del({ event_id: evA, offset_key: 'morning_of', due_at: days(10) }),
  del({ recipient_id: cA2, recipient_email: `c2-${RUN}@fixture.test`, offset_key: 'w1', due_at: days(3) }), del({ recipient_id: cA2, recipient_email: `c2-${RUN}@fixture.test`, offset_key: 'd3', due_at: days(7) }), del({ recipient_id: cA2, recipient_email: `c2-${RUN}@fixture.test`, offset_key: 'morning_of', due_at: days(10) }),
  // current occurrence: the confirmation itself was accepted by the provider for both contacts (recorded time = updated_at)
  del({ kind: 'demo_rescheduled', offset_key: null, status: 'accepted', due_at: hours(-24), provider_message_id: 'resend-msg-SECRET-1', frozen_payload: { to: 'x', subject: 'FROZEN SUBJECT', html: '<p>FROZEN BODY</p>' }, idempotency_key: 'idem-SECRET-1', claim_token: crypto.randomUUID() }),
  del({ kind: 'demo_rescheduled', offset_key: null, status: 'accepted', due_at: hours(-24), recipient_id: cA2, recipient_email: `c2-${RUN}@fixture.test`, provider_message_id: 'resend-msg-SECRET-2' }),
  // current occurrence: one pending but OVERDUE (due an hour ago), one CLAIMED with an expired lease, one FAILED retryable, one FAILED terminal, one UNKNOWN very old
  del({ offset_key: 'd1', due_at: hours(-1) }),
  del({ offset_key: 'h1', status: 'claimed', due_at: hours(-2), lease_until: hours(-1), claim_token: crypto.randomUUID() }),
  del({ offset_key: 'd14', status: 'failed', due_at: hours(-3), attempts: 2, next_attempt_at: hours(1), last_error: RAW_ERROR }),
  del({ offset_key: 'd7', status: 'failed', due_at: hours(-5), attempts: 5, next_attempt_at: null, skip_reason: 'max_attempts', last_error: 'max_attempts: ' + RAW_ERROR }),
  del({ kind: 'demo_confirmed', offset_key: null, status: 'unknown', due_at: days(-40), attempts: 3, next_attempt_at: null, last_error: 'mail_ack_unverified: no answer' }),
  // current occurrence: skipped rows with reasons
  del({ recipient_id: cA2, recipient_email: `c2-${RUN}@fixture.test`, offset_key: 'd1', status: 'skipped', skip_reason: 'opted_out', due_at: days(9) }),
  del({ kind: 'demo_confirmed', offset_key: null, status: 'skipped', skip_reason: 'due_before_scheduling', due_at: hours(-30) }),
  // EARLIER occurrence (revision 0): the old reminders were skipped as rescheduled; one had been accepted
  del({ occurrence_key: occA0, offset_key: 'd3', status: 'skipped', skip_reason: 'rescheduled', due_at: days(2) }),
  del({ occurrence_key: occA0, kind: 'demo_confirmed', offset_key: null, status: 'accepted', due_at: hours(-50), provider_message_id: 'resend-msg-SECRET-0' }),
  // store B: two scheduled, one accepted
  del({ retailer_id: B.id, booking_id: bkB, recipient_kind: 'brand', recipient_id: brandId, recipient_email: brandEmail, occurrence_key: `${bkB}:0`, offset_key: 'd3', due_at: days(2) }),
  del({ retailer_id: B.id, booking_id: bkB, recipient_kind: 'brand', recipient_id: brandId, recipient_email: brandEmail, occurrence_key: `${bkB}:0`, offset_key: 'morning_of', due_at: days(5) }),
  del({ retailer_id: B.id, booking_id: bkB, recipient_kind: 'brand', recipient_id: brandId, recipient_email: brandEmail, occurrence_key: `${bkB}:0`, kind: 'demo_confirmed', offset_key: null, status: 'accepted', due_at: hours(-10) }),
  // far future (beyond a 14-day window, inside 31)
  del({ offset_key: 'd20', due_at: days(20) }),
];
const ins = await db('notification_deliveries', { method: 'POST', body: JSON.stringify(fixtures) });
ok('fixture: deliveries inserted', ins.ok && Array.isArray(ins.body) && ins.body.length === fixtures.length, JSON.stringify(ins.body).slice(0, 200));
await db(`notification_deliveries?booking_id=eq.${bkA}&status=eq.unknown`, { method: 'PATCH', body: JSON.stringify({ updated_at: days(-40) }) });
// 1,050 pending rows on bkBig, all due in 15 days, so the scheduled list for store A crosses the 1000-row default
const big = Array.from({ length: 1050 }, (_, i) => del({ booking_id: bkBig, occurrence_key: `${bkBig}:0`, offset_key: 'd5', due_at: new Date(Date.now() + 15 * 864e5 + i * 1000).toISOString() }));
for (let i = 0; i < big.length; i += 350) { const r = await db('notification_deliveries', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(big.slice(i, i + 350)) }); if (!r.ok) ok('fixture: bulk insert chunk', false, JSON.stringify(r.body)); }
const hb = one(await db('cron_heartbeat', { method: 'POST', body: JSON.stringify({ cron_name: 'notification-worker', ran_at: new Date().toISOString(), duration_ms: 120, outcome: 'succeeded', summary: { claimed: 3, accepted: 3, skipped: 0, failed: 0, unknown: 0, note: 'FREE TEXT MUST NOT LEAK' } }) }));
if (hb) track('cron_heartbeat', hb.id);

// sessions
let ownerCookie; { const OWNER_EMAIL = 'david@demohubhq.com'; const ex = await db('retailers?slug=eq.__owner__&select=id'); const ownerRid = (ex.body && ex.body[0] && ex.body[0].id) || (await db('retailers', { method: 'POST', body: JSON.stringify({ slug: '__owner__', name: 'Demohub Owner (system)', billing_email: OWNER_EMAIL }) })).body[0].id; const tok = (await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: OWNER_EMAIL, retailer_id: ownerRid }) })).body[0]; ownerCookie = (await callRoute('admin-auth.js', req({ body: { action: 'owner-verify', token: tok.token } }))).cookie('dh_owner_session'); }
const staffEmail = `staff-${RUN}@fixture.test`;
track('retailer_admins', one(await db('retailer_admins', { method: 'POST', body: JSON.stringify({ retailer_id: A.id, email: staffEmail, email_normalized: staffEmail, name: 'Staff', role: 'admin' }) })).id);
const staffTok = one(await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: staffEmail, retailer_id: A.id }) }));
const staffCookie = (await callRoute('admin-auth.js', req({ body: { action: 'verify', token: staffTok.token } }))).cookie('dh_retailer_session');
const brandTok = one(await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: brandId, email: brandEmail, token: 'tk-' + RUN, expires_at: hours(1) }) }));
const brandCookie = (await callRoute('brand-account.js', req({ body: { action: 'verify', token: brandTok.token } }))).cookie('dh_brand_session');
const owner = (action, body, extra = {}) => callRoute('admin-auth.js', req({ body: { action, ...body }, cookies: { dh_owner_session: ownerCookie }, ...extra }));
const LEAK = /FROZEN|SECRET|idem-|claim_token|frozen_payload|provider_message_id|last_error|gmail\.com domain|MUST NOT LEAK/;

try {
  ok('fixtures: owner, staff and brand sessions exist', !!ownerCookie && !!staffCookie && !!brandCookie);

  console.log('\n— who may read: owner only, same origin only —');
  for (const action of ['owner-notifications', 'owner-notifications-summary', 'owner-booking-notifications']) {
    const body = action === 'owner-booking-notifications' ? { booking_id: bkA } : { list: 'scheduled' };
    ok(`${action}: anonymous → 401`, (await callRoute('admin-auth.js', req({ body: { action, ...body } }))).statusCode === 401);
    ok(`${action}: retailer staff cookie → 401`, (await callRoute('admin-auth.js', req({ body: { action, ...body }, cookies: { dh_retailer_session: staffCookie } }))).statusCode === 401);
    ok(`${action}: brand cookie → 401`, (await callRoute('admin-auth.js', req({ body: { action, ...body }, cookies: { dh_brand_session: brandCookie } }))).statusCode === 401);
    const x = await callRoute('admin-auth.js', req({ body: { action, ...body }, cookies: { dh_owner_session: ownerCookie }, csrf: false, headers: { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' } }));
    ok(`${action}: cross-site owner call is refused (${x.statusCode})`, x.statusCode === 403 || x.statusCode === 401);
  }

  console.log('\n— input validation —');
  ok('bad list → 400', (await owner('owner-notifications', { list: 'everything' })).statusCode === 400);
  ok('days 0 → 400', (await owner('owner-notifications', { list: 'scheduled', days: 0 })).statusCode === 400);
  ok('days 32 → 400', (await owner('owner-notifications', { list: 'scheduled', days: 32 })).statusCode === 400);
  ok('days 2.5 → 400', (await owner('owner-notifications', { list: 'scheduled', days: 2.5 })).statusCode === 400);
  ok('limit 501 → 400', (await owner('owner-notifications', { list: 'scheduled', limit: 501 })).statusCode === 400);
  ok('negative offset → 400', (await owner('owner-notifications', { list: 'scheduled', offset: -1 })).statusCode === 400);
  ok('bad retailer_id → 400', (await owner('owner-notifications', { list: 'scheduled', retailer_id: 'gus' })).statusCode === 400);
  ok('summary with bad days → 400', (await owner('owner-notifications-summary', { days: 'soon' })).statusCode === 400);
  ok('booking view without a UUID → 400', (await owner('owner-booking-notifications', { booking_id: '123' })).statusCode === 400);
  ok('booking view for a missing booking → 404', (await owner('owner-booking-notifications', { booking_id: crypto.randomUUID() })).statusCode === 404);
  ok('parseListInput defaults: scheduled / 14 days / 200 / 0', JSON.stringify(parseListInput({})) === JSON.stringify({ ok: true, list: 'scheduled', retailer_id: null, days: 14, limit: 200, offset: 0 }));

  console.log('\n— summary: exact counts per list and worker health —');
  const sumA = (await owner('owner-notifications-summary', { retailer_id: A.id, days: 14 })).body;
  ok('store A, 14 days: scheduled = 6 reminders + the d20 is outside 14 days → 6', sumA.counts.scheduled === 6, JSON.stringify(sumA.counts));
  ok('store A: overdue = pending overdue + expired claim + retryable failure = 3', sumA.counts.overdue === 3, JSON.stringify(sumA.counts));
  ok('store A: attention = terminal failure + 40-day-old unknown = 2', sumA.counts.attention === 2, JSON.stringify(sumA.counts));
  ok('store A: accepted in the last 14 days = 3 (two current + one earlier occurrence)', sumA.counts.accepted === 3, JSON.stringify(sumA.counts));
  const sumA31 = (await owner('owner-notifications-summary', { retailer_id: A.id, days: 31 })).body;
  ok('store A, 31 days: scheduled includes the d20 row and the 1,050 bulk rows (1057)', sumA31.counts.scheduled === 1057, JSON.stringify(sumA31.counts));
  const sumB = (await owner('owner-notifications-summary', { retailer_id: B.id, days: 14 })).body;
  ok('store B: 2 scheduled, 0 overdue, 0 attention, 1 accepted (filter applied server-side)', sumB.counts.scheduled === 2 && sumB.counts.overdue === 0 && sumB.counts.attention === 0 && sumB.counts.accepted === 1, JSON.stringify(sumB.counts));
  ok('window semantics are stated (days x 24h, UTC instants)', /24 hours/.test(sumA.window.semantics) && sumA.window.days === 14 && sumA.lookahead_days === 31);
  ok('worker: last successful run reported, healthy, whitelisted counts only (free text dropped)', sumA.worker && sumA.worker.healthy === true && sumA.worker.last_success_at && sumA.worker.last_run_counts && sumA.worker.last_run_counts.accepted === 3 && !('note' in sumA.worker.last_run_counts), JSON.stringify(sumA.worker));
  ok('summary payload leaks nothing', !LEAK.test(JSON.stringify(sumA)));

  console.log('\n— lists: content, order, labels, fields —');
  const sched = (await owner('owner-notifications', { list: 'scheduled', retailer_id: A.id, days: 14 })).body;
  ok('scheduled: 6 rows, total 6, complete', sched.rows.length === 6 && sched.total === 6 && sched.complete === true, JSON.stringify([sched.rows.length, sched.total, sched.complete]));
  ok('scheduled: ordered by due_at then id', sched.rows.every((r, i) => i === 0 || r.due_at > sched.rows[i - 1].due_at || (r.due_at === sched.rows[i - 1].due_at && r.id > sched.rows[i - 1].id)));
  const r0 = sched.rows[0];
  ok('row: explicit fields with retailer, timezone, venue, brand, demo, recipient name, labels', r0.retailer === 'Notify Owner Market <b>A</b>' && r0.timezone === LA && r0.venue === 'A Main' && r0.brand === 'Owner Notify Brand & Co' && r0.demo_date === dayP(10) && r0.status_label === 'Scheduled' && r0.kind === 'reminder' && r0.offset_key === 'w1' && r0.current_occurrence === true && typeof r0.recipient_name === 'string', JSON.stringify(r0));
  ok('row: no forbidden fields at all', !('frozen_payload' in r0) && !('provider_message_id' in r0) && !('idempotency_key' in r0) && !('claim_token' in r0) && !('last_error' in r0));
  ok('row: accepted_at is null for a scheduled row', r0.accepted_at === null);
  const over = (await owner('owner-notifications', { list: 'overdue', retailer_id: A.id })).body;
  ok('overdue: 3 rows = pending overdue, expired claim, retryable failure', over.total === 3 && over.rows.map(r => r.status).sort().join() === 'claimed,failed,pending', JSON.stringify(over.rows.map(r => [r.status, r.offset_key])));
  ok('overdue: the claimed row is marked lease_expired with its label', over.rows.find(r => r.status === 'claimed').lease_expired === true && over.rows.find(r => r.status === 'claimed').status_label === 'In progress');
  ok('overdue: the retryable failure carries next_attempt_at, the mapped code and "Failed, will retry"', (() => { const f = over.rows.find(r => r.status === 'failed'); return f && f.next_attempt_at && f.error_code === 'provider_rejected' && f.status_label === 'Failed, will retry' && f.attempts === 2; })());
  const att = (await owner('owner-notifications', { list: 'attention', retailer_id: A.id })).body;
  ok('attention: terminal failure + the 40-day-old unknown (age does not hide it)', att.total === 2 && att.rows.map(r => r.status).sort().join() === 'failed,unknown', JSON.stringify(att.rows.map(r => [r.status, r.due_at])));
  ok('attention: terminal failure maps to max_attempts; unknown maps to provider_ack_unverified', att.rows.find(r => r.status === 'failed').error_code === 'max_attempts' && att.rows.find(r => r.status === 'unknown').error_code === 'provider_ack_unverified');
  ok('attention: labels are "Failed" and "Unknown (provider may have accepted)"', att.rows.find(r => r.status === 'failed').status_label === 'Failed' && /^Unknown/.test(att.rows.find(r => r.status === 'unknown').status_label));
  const acc = (await owner('owner-notifications', { list: 'accepted', retailer_id: A.id, days: 14 })).body;
  ok('accepted: 3 rows, label "Accepted by email provider", accepted_at = recorded updated_at, provider_accepted boolean only', acc.total === 3 && acc.rows.every(r => r.status_label === 'Accepted by email provider' && r.accepted_at === r.updated_at && typeof r.provider_accepted === 'boolean'), JSON.stringify(acc.rows.map(r => [r.status_label, r.accepted_at === r.updated_at])));
  ok('accepted: the earlier-occurrence row is marked current_occurrence=false', acc.rows.filter(r => r.current_occurrence === false).length === 1);
  ok('no list payload leaks frozen bodies, provider ids, keys or raw errors', ![sched, over, att, acc].some(p => LEAK.test(JSON.stringify(p))));
  ok('all retailers (no filter): scheduled total covers both stores (6 + 2)', (await owner('owner-notifications', { list: 'scheduled', days: 14 })).body.total >= 8);

  console.log('\n— pagination beyond 1000 rows, deterministic and complete —');
  const p1 = (await owner('owner-notifications', { list: 'scheduled', retailer_id: A.id, days: 31, limit: 500, offset: 0 })).body;
  const p2 = (await owner('owner-notifications', { list: 'scheduled', retailer_id: A.id, days: 31, limit: 500, offset: 500 })).body;
  const p3 = (await owner('owner-notifications', { list: 'scheduled', retailer_id: A.id, days: 31, limit: 500, offset: 1000 })).body;
  ok('three pages: 500 + 500 + 57, total 1057 on each, complete only on the last', p1.rows.length === 500 && p2.rows.length === 500 && p3.rows.length === 57 && p1.total === 1057 && p3.total === 1057 && !p1.complete && !p2.complete && p3.complete, JSON.stringify([p1.rows.length, p2.rows.length, p3.rows.length, p1.total, p1.complete, p3.complete]));
  const ids = new Set([...p1.rows, ...p2.rows, ...p3.rows].map(r => r.id));
  ok('no duplicates and no gaps across pages', ids.size === 1057);
  const past = (await owner('owner-notifications', { list: 'scheduled', retailer_id: A.id, days: 31, limit: 500, offset: 2000 })).body;
  ok('offset past the end → 0 rows, total 1057, complete', past.rows.length === 0 && past.total === 1057 && past.complete === true, JSON.stringify([past.rows.length, past.total, past.complete]));
  ok('store B at the same offsets is unaffected by store A\'s volume (filter before pagination)', (await owner('owner-notifications', { list: 'scheduled', retailer_id: B.id, days: 31, limit: 500 })).body.total === 2);

  console.log('\n— booking view: facts, counts two ways, per occurrence, skipped reasons —');
  const bv = (await owner('owner-booking-notifications', { booking_id: bkA })).body;
  ok('booking facts: status, revision, timezone, store, venue, brand', bv.booking.status === 'confirmed' && bv.booking.schedule_revision === 1 && bv.booking.timezone === LA && bv.booking.retailer === 'Notify Owner Market <b>A</b>' && bv.booking.venue === 'A Main' && bv.booking.brand === 'Owner Notify Brand & Co', JSON.stringify(bv.booking));
  ok('events: confirmed (trigger-written, not fanned out) + rescheduled (fanned out), with ids', bv.events.length === 2 && bv.events.every(e => e.id) && bv.events.map(e => e.kind).join() === 'demo_confirmed,demo_rescheduled' && bv.events[0].fanned_out_at === null && !!bv.events[1].fanned_out_at, JSON.stringify(bv.events));
  const s = bv.summary;
  ok('reminder TIMES scheduled = 5 (w1, d3, morning_of, d1, d20), recipient EMAILS scheduled = 8 (3x2 + overdue d1 + d20)', s.reminder_times_scheduled === 5 && s.reminder_emails_scheduled === 8, JSON.stringify(s));
  ok('reminder totals (not skipped): 8 pending + 1 claimed + 2 failed = 11 emails over 8 offsets', s.reminder_emails_total === 11 && s.reminder_times_total === 8, JSON.stringify(s));
  ok('outcomes: 2 accepted, 8 scheduled, 1 in progress, 2 failed, 1 unknown, 2 skipped with reasons', s.accepted_by_provider === 2 && s.scheduled === 8 && s.in_progress === 1 && s.failed === 2 && s.unknown === 1 && s.skipped === 2 && s.skipped_reasons.opted_out === 1 && s.skipped_reasons.due_before_scheduling === 1, JSON.stringify(s));
  ok('earlier occurrence rows counted separately (2) and marked in the list', s.earlier_occurrence_rows === 2 && bv.deliveries.filter(r => r.current_occurrence === false).length === 2);
  ok('deliveries list complete with total', bv.deliveries_total === bv.deliveries.length && bv.deliveries_complete === true);
  ok('booking view leaks nothing', !LEAK.test(JSON.stringify(bv)));
  const empty = (await owner('owner-booking-notifications', { booking_id: bkEmpty })).body;
  ok('a confirmed booking with no rows: 200, zero deliveries, its confirmed event not yet fanned out, facts present, no invented reason', empty.deliveries.length === 0 && empty.events.length === 1 && empty.events[0].fanned_out_at === null && empty.booking.status === 'confirmed' && empty.lookahead_days === 31 && empty.worker && !('reason' in empty) && !('cause' in empty), JSON.stringify(Object.keys(empty)));
  const bigv = (await owner('owner-booking-notifications', { booking_id: bkBig })).body;
  ok('a booking with 1,050 rows: capped at 500 with total and complete=false', bigv.deliveries.length === 500 && bigv.deliveries_total === 1050 && bigv.deliveries_complete === false);

  console.log('\n— failures: required read → 503 retry; enrichment read → partial, rows kept —');
  spy.faults.push({ url: '/rest/v1/notification_deliveries?select=', status: 500, message: 'injected', once: true });
  const f1 = await owner('owner-notifications', { list: 'scheduled', retailer_id: A.id });
  ok('deliveries read fails → 503 notifications_unavailable, retry:true (not an empty list)', f1.statusCode === 503 && f1.body.error === 'notifications_unavailable' && f1.body.retry === true, JSON.stringify([f1.statusCode, f1.body]));
  spy.faults.push({ url: '/rest/v1/cron_heartbeat?', status: 500, message: 'injected', once: true });
  const f2 = await owner('owner-notifications-summary', { retailer_id: A.id });
  ok('summary with a failed heartbeat read → 503 (worker health is required there)', f2.statusCode === 503, String(f2.statusCode));
  spy.faults.push({ url: '/rest/v1/internal_contacts?id=in.', status: 500, message: 'injected', once: true });
  const f3 = await owner('owner-notifications', { list: 'scheduled', retailer_id: A.id });
  ok('contacts enrichment fails → 200, partial names "contacts", rows keep emails and ids', f3.statusCode === 200 && f3.body.partial.includes('contacts') && f3.body.rows.length === 6 && f3.body.rows.every(r => r.recipient_email && r.recipient_name === null && r.retailer), JSON.stringify(f3.body.partial));
  spy.faults.push({ url: '/rest/v1/retailers?id=in.', status: 500, message: 'injected', once: true });
  const f4 = await owner('owner-notifications', { list: 'scheduled', retailer_id: A.id });
  ok('retailers enrichment fails → rows keep retailer_id and the booking timezone', f4.statusCode === 200 && f4.body.partial.includes('retailers') && f4.body.rows.every(r => r.retailer === null && r.retailer_id === A.id));
  spy.faults.push({ url: '/rest/v1/notification_events?', status: 500, message: 'injected', once: true });
  const f5 = await owner('owner-booking-notifications', { booking_id: bkA });
  ok('booking view with a failed events read → 503 (events are part of the facts)', f5.statusCode === 503);

  console.log('\n— error code mapping is an allowlist —');
  ok('every mapped value is in ERROR_CODES', ['mail_send_failed: x', 'mail_provider_unreachable', 'mail_ack_unverified: y', 'mail_provider_not_configured', 'idempotency_window_expired: z', 'review_required', 'max_attempts: q', 'recipient_changed', 'settings_read_malformed', 'send_failed', 'something new and raw', 'DROP TABLE'].every(e => ERROR_CODES.includes(publicErrorCode(e))));
  ok('empty error → null; unknown text → other', publicErrorCode('') === null && publicErrorCode('weird: {"json":true}') === 'other');
} finally {
  await db(`notification_deliveries?booking_id=in.(${[bkA, bkB, bkEmpty, bkBig].join(',')})`, { method: 'DELETE' });
  await db(`notification_events?booking_id=in.(${[bkA, bkB, bkEmpty, bkBig].join(',')})`, { method: 'DELETE' });
  await db(`admin_sessions?retailer_id=in.(${A.id},${B.id})`, { method: 'DELETE' });
  await db(`brand_account_sessions?brand_id=eq.${brandId}`, { method: 'DELETE' });
  await db(`brand_account_tokens?brand_id=eq.${brandId}`, { method: 'DELETE' });
  for (const [t, id] of bin.reverse()) await db(`${t}?id=eq.${id}`, { method: 'DELETE' });
  spy.restore();
}
process.exit(summary('owner notifications panel (N-1)') ? 0 : 1);
