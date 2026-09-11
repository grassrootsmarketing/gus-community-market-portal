// tests/reschedule_atomic.test.mjs — Release A: a reschedule is ONE database transaction and the
// bookings row is the authoritative schedule (migration 0074_release_a_schedule_and_outbox.sql).
//
// THE DEFECT this pins: api/brand-account.js `reschedule-respond` (accept) used to PATCH only
// demos.demo_date/demo_time. The bookings row — where 0070 enforces slot capacity — kept the old
// slot, so the calendar and capacity accounting disagreed, and an old dashboard tab (or a replay)
// could re-apply a proposal the retailer had since replaced.
//
// Two instruments, both real:
//   * the ROUTE HARNESS (tests/_route.mjs): the exported handlers of api/booking-action.js (retailer
//     proposes) and api/brand-account.js (brand accepts/declines and reads `data`) run with real
//     cookies, CSRF evidence and a valid binding against the test database; Resend is spied.
//   * the `pg` driver on SB_DB_URL: fixtures, direct state assertions, and the MULTI-CONNECTION race
//     (two brands' bookings racing into the last slot of one venue), which PostgREST's one-request-
//     one-transaction model cannot stage.
//
// Scenarios (numbered as in the Codex direction):
//   1  propose + accept -> bookings AND demos moved, schedule_revision 2, proposal cleared,
//      demo_rescheduled event with old/new slot; `data` ships reschedule_proposal_version
//   2  accept the same version again -> 409, nothing changes
//   3  propose v2, accept with v1 from an "old page" -> 409 stale_proposal; decline v2 clears it
//   4  two bookings racing into the last slot (two pg connections, staged behind the slot lock)
//      -> exactly one success, loser slot_full, loser's booking AND demo unchanged
//   5  cancel then accept -> 409, demo stays cancelled
//   6  proposal beyond the brand's COI expiry -> 409 coi_not_covered, unchanged
//   7  A -> B -> A yields revisions 1,2,3 and distinct occurrence keys / transition ids
//   8  pending reminder deliveries keyed on the OLD occurrence are skipped after acceptance;
//      already-accepted ones are untouched
//   9  demo_confirmed exactly once on -> confirmed (not on re-save, not on pending -> declined);
//      demo_cancelled only from confirmed, and it skips the booking's pending deliveries
//  10  coi_approved / coi_rejected on status change with brand_note in the payload; not on re-save
//  +   schedule_mismatches() reports zero rows for the fixture retailer before teardown
//
// Env: SB_URL, SB_KEY, SB_REF (route harness) and SB_DB_URL (direct/session pg connection to the
// SAME test project). Production and retired refs are refused. Teardown is FK-ordered.
import pg from 'pg';
import { HOURLY, STANDARD, HOURLY_JSON, STANDARD_JSON } from './_fixture_availability.mjs';

import { installSpy, callRoute, req, ok, summary, uniq } from './_route.mjs';

const { Client } = pg;
const STAGING_REF = 'tileejdviuvijumjeplv';
const FORBIDDEN = new Set(['dkgjvsstbgnhcfboqqnd', 'ecapmcyumpjjgjwuokyv', 'eubbgurdwqmwqduamwhn']);
const SB_DB_URL = process.env.SB_DB_URL;
const SB_REF = process.env.SB_REF;
if (!SB_DB_URL) { console.log('  FAIL SB_DB_URL not set — the race scenario needs a direct pg connection'); process.exit(1); }
if (SB_REF !== STAGING_REF || !SB_DB_URL.includes(STAGING_REF)) { console.log(`  FAIL REFUSING: SB_REF/SB_DB_URL must be the test project (${STAGING_REF})`); process.exit(1); }
for (const ref of FORBIDDEN) if (SB_DB_URL.includes(ref)) { console.log(`  FAIL REFUSING: SB_DB_URL references production/retired project ${ref}`); process.exit(1); }
if (/:6543(\/|$|\?)/.test(SB_DB_URL)) { console.log('  FAIL REFUSING: transaction-mode pooler (:6543); use the direct/session connection (:5432)'); process.exit(1); }

const watchdog = setTimeout(() => { console.log('  FAIL watchdog: suite exceeded 5 minutes — a lock did not release'); process.exit(1); }, 5 * 60 * 1000);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const dayP = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const LA = 'America/Los_Angeles';
const capture = (p) => p.then(r => ({ ok: true, r }), e => ({ ok: false, e }));

const clients = [];
async function connect(label) {
  const c = new Client({ connectionString: SB_DB_URL, ssl: /sslmode=disable/i.test(SB_DB_URL) ? false : { rejectUnauthorized: false }, application_name: `resched-${label}` });
  await c.connect();
  await c.query(`SET lock_timeout = '30s'`);
  await c.query(`SET statement_timeout = '60s'`);
  c.pid = (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  clients.push(c);
  return c;
}
const rollbackQuiet = async (c) => { try { await c.query('ROLLBACK'); } catch (_) {} };
async function waitUntilBlocked(ctl, pid, timeoutMs = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await ctl.query('SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid = $1', [pid]);
    const w = r.rows[0];
    if (w && w.wait_event_type === 'Lock') return w;
    await sleep(50);
  }
  return null;
}

const spy = installSpy();
const ctl = await connect('ctl');
const q = async (sql, params) => (await ctl.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0] || null;

// ---------------------------------------------------------------------------
// Preflight: 0074 is applied, and the routes under test can load.
// ---------------------------------------------------------------------------
const fx = { retailer: null, venues: [], brands: [], bookings: [] };
let staffCookie = null, cookieA = null, cookieB = null;
try {
  const pre = await one(`SELECT to_regclass('public.notification_events') AS ev, to_regclass('public.notification_deliveries') AS dl,
                                to_regprocedure('public.accept_reschedule(uuid,uuid,integer)') AS acc,
                                to_regprocedure('public.propose_reschedule(uuid,uuid,date,text)') AS prop,
                                to_regclass('public.demo_notifications') AS legacy`);
  ok('preflight: 0074 applied (outbox tables + RPCs present, demo_notifications dropped)', pre.ev && pre.dl && pre.acc && pre.prop && !pre.legacy, JSON.stringify(pre));

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------
  const slug = uniq('rs');
  fx.retailer = (await one(`INSERT INTO retailers (slug, name, billing_email, billing_tier, billing_status, platform_keeps_all, timezone, auto_confirm_bookings, cancellation_mode)
                            VALUES ($1, 'Reschedule Fixture Market', $2, 'pro', 'active', true, $3, false, 'refundable') RETURNING id`, [slug, `${slug}@fixture.test`, LA])).id;
  const R = fx.retailer;
  const mkVenue = async (name, cap) => { const v = await one(`INSERT INTO venues (retailer_id, name, address, demo_fee, max_demos_per_slot, availability) VALUES ($1, $2, '1 Move St', 30, $3, $4::jsonb) RETURNING id`, [R, name, cap, STANDARD_JSON]); fx.venues.push(v.id); return v.id; };
  const V1 = await mkVenue('Cap-1 Hall', 1);
  const V2 = await mkVenue('Cap-2 Annex', 2);

  const mkBrand = async (label, coiExpires) => {
    const email = `${uniq(label)}@fixture.test`;
    const b = await one(`INSERT INTO brands (email, company_name, contact_name, phone, is_verified, default_coi_url, default_coi_expires, coi_verification_status)
                         VALUES ($1, $2, 'Rep', '555-0100', true, $3, $4, 'approved') RETURNING id`, [email, `Brand ${label}`, `brands/${label}.pdf`, coiExpires]);
    fx.brands.push(b.id);
    return { id: b.id, email };
  };
  const A = await mkBrand('alpha', dayP(20));   // COI covers +20 days only (scenario 6)
  const B = await mkBrand('bravo', dayP(400));
  const brandCookie = async (brand) => {
    const tok = 'tk-' + uniq('r');
    await q(`INSERT INTO brand_account_tokens (brand_id, email, token, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')`, [brand.id, brand.email, tok]);
    const v = await callRoute('brand-account.js', req({ body: { action: 'verify', token: tok } }));
    return v.cookie('dh_brand_session');
  };
  cookieA = await brandCookie(A);
  cookieB = await brandCookie(B);

  const staffEmail = `staff-${slug}@fixture.test`;
  await q(`INSERT INTO retailer_admins (retailer_id, email, email_normalized, name, role) VALUES ($1, $2, $2, 'Move Staff', 'admin')`, [R, staffEmail]);
  const staffTok = await one(`INSERT INTO admin_tokens (email, retailer_id) VALUES ($1, $2) RETURNING token`, [staffEmail, R]);
  staffCookie = (await callRoute('admin-auth.js', req({ body: { action: 'verify', token: staffTok.token } }))).cookie('dh_retailer_session');
  ok('fixtures: staff + two brand sessions exist', !!staffCookie && !!cookieA && !!cookieB);

  // A confirmed booking WITH its demo projection (the state after /api/booking-action confirm).
  const mkConfirmed = async (brand, venue, date, time) => {
    const b = await one(`INSERT INTO bookings (retailer_id, venue_id, brand_id, brand_name, contact_name, contact_email, product, demo_date, demo_time, status, payment_status)
                         VALUES ($1, $2, $3, $4, 'Rep', $5, 'Samples', $6, $7, 'confirmed', 'paid') RETURNING id`, [R, venue, brand.id, `Brand ${brand.id.slice(0, 4)}`, brand.email, date, time]);
    fx.bookings.push(b.id);
    const d = await one(`INSERT INTO demos (retailer_id, venue_id, brand_id, company_name, contact_name, contact_email, demo_date, demo_time, duration_hours, status, confirmed_at, booking_id)
                         VALUES ($1, $2, $3, 'Brand', 'Rep', $4, $5, $6, 3, 'confirmed', now(), $7) RETURNING id`, [R, venue, brand.id, brand.email, date, time, b.id]);
    return { booking: b.id, demo: d.id };
  };
  const booking = (id) => one(`SELECT id, venue_id, demo_date::text AS demo_date, demo_time, status, schedule_revision, reschedule_proposal_version, start_at, end_at, timezone FROM bookings WHERE id = $1`, [id]);
  const demo = (id) => one(`SELECT id, venue_id, demo_date::text AS demo_date, demo_time, status, reschedule_to_date::text AS reschedule_to_date, reschedule_to_time FROM demos WHERE id = $1`, [id]);
  const events = (bid, kind) => q(`SELECT kind, transition_id, payload FROM notification_events WHERE booking_id = $1 AND ($2::text IS NULL OR kind = $2) ORDER BY created_at`, [bid, kind || null]);
  const expectedStart = async (date, hhmm) => (await one(`SELECT (($1::date + $2::time) AT TIME ZONE $3) AS t`, [date, hhmm, LA])).t;
  const propose = (demoId, date, time, cookie = staffCookie) => callRoute('booking-action.js', req({ body: { action: 'reschedule', demo_id: demoId, new_date: date, new_time: time }, cookies: { dh_retailer_session: cookie } }));
  const respond = (demoId, decision, version, cookie = cookieA) => callRoute('brand-account.js', req({ body: { action: 'reschedule-respond', demo_id: demoId, decision, ...(version === undefined ? {} : { proposal_version: version }) }, cookies: { dh_brand_session: cookie } }));

  const D0 = dayP(10), D1 = dayP(15), D2 = dayP(16), D4 = dayP(18), D5 = dayP(25);
  const B1 = await mkConfirmed(A, V1, D0, '11:00 AM');
  const B2 = await mkConfirmed(B, V1, dayP(12), '11:00 AM');

  const b1_0 = await booking(B1.booking);
  ok('fixture: a confirmed insert starts at schedule_revision 1 with the occurrence snapshot set', b1_0.schedule_revision === 1 && b1_0.timezone === LA && b1_0.start_at && new Date(b1_0.start_at).getTime() === new Date(await expectedStart(D0, '11:00')).getTime(), JSON.stringify(b1_0));
  ok('fixture: INSERT status=confirmed wrote exactly one demo_confirmed event (transition <id>:confirmed:1)', (await events(B1.booking, 'demo_confirmed')).length === 1 && (await events(B1.booking, 'demo_confirmed'))[0].transition_id === `${B1.booking}:confirmed:1`);

  // =========================================================================
  console.log('\n— 1: propose (route) + accept (route) moves bookings AND demos in one transaction —');
  // =========================================================================
  const p1 = await propose(B1.demo, D1, '2:00 PM');
  ok('propose: 200 with proposal_version 1 and the booking id', p1.statusCode === 200 && p1.body && p1.body.proposal_version === 1 && p1.body.booking_id === B1.booking, `${p1.statusCode} ${JSON.stringify(p1.body).slice(0, 200)}`);
  let d = await demo(B1.demo); let b = await booking(B1.booking);
  ok('propose: proposal stored on demos, version on the booking, schedule untouched', d.reschedule_to_date === D1 && d.reschedule_to_time === '2:00 PM' && b.reschedule_proposal_version === 1 && b.demo_date === D0 && b.schedule_revision === 1, JSON.stringify({ d, b }));
  ok('propose: the brand was emailed the proposal', spy.calls.resend.some(m => /proposed a new date/i.test(m.subject || '')), JSON.stringify(spy.calls.resend.map(m => m.subject)));

  const data = await callRoute('brand-account.js', req({ body: { action: 'data' }, cookies: { dh_brand_session: cookieA } }));
  const dashRow = data.statusCode === 200 && Array.isArray(data.body && data.body.demos) ? data.body.demos.find(x => x.id === B1.demo) : null;
  ok('data: the dashboard payload carries reschedule_proposal_version=1 (+ schedule_revision) on the demo with the proposal', !!dashRow && dashRow.reschedule_proposal_version === 1 && dashRow.schedule_revision === 1, `${data.statusCode} ${JSON.stringify(dashRow || data.body).slice(0, 200)}`);

  const noVer = await respond(B1.demo, 'accept');
  ok('accept without proposal_version -> 400 proposal_version_required, nothing moved', noVer.statusCode === 400 && /proposal_version_required/.test(JSON.stringify(noVer.body)) && (await booking(B1.booking)).demo_date === D0, `${noVer.statusCode} ${JSON.stringify(noVer.body)}`);

  const mailsBefore = spy.calls.resend.length;
  const a1 = await respond(B1.demo, 'accept', 1);
  ok('accept: 200 with schedule_revision 2 and moved_to', a1.statusCode === 200 && a1.body && a1.body.ok === true && a1.body.schedule_revision === 2 && a1.body.moved_to && a1.body.moved_to.date === D1, `${a1.statusCode} ${JSON.stringify(a1.body)}`);
  b = await booking(B1.booking); d = await demo(B1.demo);
  ok('accept: bookings moved (date, time, revision 2) and the snapshot recomputed for 2:00 PM local', b.demo_date === D1 && b.demo_time === '2:00 PM' && b.schedule_revision === 2 && new Date(b.start_at).getTime() === new Date(await expectedStart(D1, '14:00')).getTime() && new Date(b.end_at).getTime() - new Date(b.start_at).getTime() === 3 * 3600e3, JSON.stringify(b));
  ok('accept: demos moved to the same slot and the proposal is cleared', d.demo_date === D1 && d.demo_time === '2:00 PM' && d.reschedule_to_date === null && d.reschedule_to_time === null, JSON.stringify(d));
  const ev1 = await events(B1.booking, 'demo_rescheduled');
  ok('accept: one demo_rescheduled event, transition <id>:rescheduled:2, payload has old and new slot', ev1.length === 1 && ev1[0].transition_id === `${B1.booking}:rescheduled:2` && ev1[0].payload.old_date === D0 && ev1[0].payload.old_time === '11:00 AM' && ev1[0].payload.new_date === D1 && ev1[0].payload.new_time === '2:00 PM' && ev1[0].payload.schedule_revision === 2, JSON.stringify(ev1));
  const retailerMail = spy.calls.resend.slice(mailsBefore).find(m => /accepted the new date/.test(m.subject || ''));
  ok('accept: the retailer email ("accepted the new date") is unchanged', !!retailerMail, JSON.stringify(spy.calls.resend.slice(mailsBefore).map(m => m.subject)));
  ok('accept: no direct demos PATCH — no legacy store-contact path ran (no demo_notifications table, no extra mail)', spy.calls.resend.slice(mailsBefore).length === 1, `${spy.calls.resend.slice(mailsBefore).length} mails`);

  // =========================================================================
  console.log('\n— 2: replaying the same version -> 409, nothing changes —');
  // =========================================================================
  const a2 = await respond(B1.demo, 'accept', 1);
  const b2 = await booking(B1.booking); const d2 = await demo(B1.demo);
  ok('replay: 409 (no_proposal) and the row is untouched', a2.statusCode === 409 && a2.body && a2.body.error === 'no_proposal' && b2.schedule_revision === 2 && b2.demo_date === D1 && d2.demo_date === D1, `${a2.statusCode} ${JSON.stringify(a2.body)}`);
  ok('replay: still exactly one demo_rescheduled event', (await events(B1.booking, 'demo_rescheduled')).length === 1);

  // =========================================================================
  console.log('\n— 3: a superseded proposal (v2) cannot be accepted with v1 from an old page —');
  // =========================================================================
  const p2 = await propose(B1.demo, D2, null);
  ok('propose v2: 200 with proposal_version 2, time defaults to the current 2:00 PM', p2.statusCode === 200 && p2.body.proposal_version === 2 && p2.body.new_time === '2:00 PM', `${p2.statusCode} ${JSON.stringify(p2.body)}`);
  const stale = await respond(B1.demo, 'accept', 1);
  const b3 = await booking(B1.booking); const d3 = await demo(B1.demo);
  ok('stale accept: 409 stale_proposal; schedule untouched; the v2 proposal is still pending', stale.statusCode === 409 && stale.body.error === 'stale_proposal' && b3.demo_date === D1 && b3.schedule_revision === 2 && d3.reschedule_to_date === D2, `${stale.statusCode} ${JSON.stringify(stale.body)} ${JSON.stringify(d3)}`);
  const otherBrand = await respond(B1.demo, 'decline', 2, cookieB);
  ok('another brand cannot answer this proposal (403)', otherBrand.statusCode === 403, `${otherBrand.statusCode} ${JSON.stringify(otherBrand.body)}`);
  const dec = await respond(B1.demo, 'decline', 2);
  const b3b = await booking(B1.booking); const d3b = await demo(B1.demo);
  ok('decline v2: 200, proposal cleared, revision still 2, nothing moved', dec.statusCode === 200 && dec.body.decision === 'decline' && dec.body.moved_to === null && d3b.reschedule_to_date === null && b3b.schedule_revision === 2 && b3b.demo_date === D1 && d3b.demo_date === D1, `${dec.statusCode} ${JSON.stringify(dec.body)}`);
  ok('decline: the retailer email ("kept their original demo date") is unchanged', spy.calls.resend.some(m => /kept their original demo date/.test(m.subject || '')));

  // =========================================================================
  console.log('\n— 4: two bookings race into the last slot of a cap-1 venue (two pg connections) —');
  // =========================================================================
  // Both proposals target V1 on D4 11:00 AM (cap 1). Staged: ctl holds the destination slot's
  // advisory lock inside an open transaction; both accepts start and park on it; ctl commits; the
  // 0070 move trigger then serializes them — exactly one may consume the last unit.
  const pr1 = await one(`SELECT * FROM propose_reschedule($1, $2, $3::date, $4)`, [B1.demo, R, D4, '11:00 AM']);
  const pr2 = await one(`SELECT * FROM propose_reschedule($1, $2, $3::date, $4)`, [B2.demo, R, D4, '11:00 AM']);
  ok('race setup: both proposals accepted by propose_reschedule (v3 for B1, v1 for B2)', pr1.ok === true && pr1.proposal_version === 3 && pr2.ok === true && pr2.proposal_version === 1, JSON.stringify({ pr1, pr2 }));
  const c1 = await connect('c1'), c2 = await connect('c2');
  await ctl.query('BEGIN');
  // 0075 re-keyed the per-slot advisory lock on the NORMALIZED slot (slot_key), so "11:00" and "11:00 AM" are one lock.
  await ctl.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text || '|' || $2::date::text || '|' || slot_key($3::text), 0))`, [V1, D4, '11:00 AM']);
  const r1p = capture(c1.query('SELECT * FROM accept_reschedule($1, $2, $3)', [B1.booking, A.id, 3]));
  const r2p = capture(c2.query('SELECT * FROM accept_reschedule($1, $2, $3)', [B2.booking, B.id, 1]));
  const w1 = await waitUntilBlocked(ctl, c1.pid), w2 = await waitUntilBlocked(ctl, c2.pid);
  ok('race: both accepts are parked on the destination slot lock', !!w1 && !!w2, JSON.stringify({ w1, w2 }));
  await ctl.query('COMMIT');
  const [r1, r2] = await Promise.all([r1p, r2p]);
  const v1 = r1.ok ? r1.r.rows[0] : { error: String(r1.e && r1.e.message) };
  const v2 = r2.ok ? r2.r.rows[0] : { error: String(r2.e && r2.e.message) };
  const winners = [v1, v2].filter(v => v.ok === true), losers = [v1, v2].filter(v => v.ok === false);
  ok('race: exactly one accept succeeded and the other returned slot_full (no exception surfaced)', winners.length === 1 && losers.length === 1 && losers[0].reason === 'slot_full', JSON.stringify({ v1, v2 }));
  const winnerIsB1 = v1.ok === true;
  const W = winnerIsB1 ? B1 : B2, L = winnerIsB1 ? B2 : B1;
  const wb = await booking(W.booking), wd = await demo(W.demo), lb = await booking(L.booking), ld = await demo(L.demo);
  ok('race: the winner moved to D4 in both tables with revision+1 and its proposal consumed', wb.demo_date === D4 && wd.demo_date === D4 && wd.reschedule_to_date === null && wb.schedule_revision === (winnerIsB1 ? 3 : 2), JSON.stringify({ wb, wd }));
  ok('race: the loser\'s booking AND demo are unchanged and its proposal is still pending', lb.demo_date !== D4 && ld.demo_date !== D4 && lb.demo_date === ld.demo_date && ld.reschedule_to_date === D4 && lb.schedule_revision === (winnerIsB1 ? 1 : 2), JSON.stringify({ lb, ld }));
  const taken = await one(`SELECT count(*)::int AS n FROM bookings WHERE venue_id = $1 AND demo_date = $2 AND demo_time = '11:00 AM' AND coalesce(status,'pending') NOT IN ('cancelled','declined','expired','auth_canceled')`, [V1, D4]);
  ok('race: the destination slot holds exactly one active booking (cap 1)', taken.n === 1, `${taken.n}`);
  ok('race: the loser wrote no demo_rescheduled event', !(await events(L.booking, 'demo_rescheduled')).some(e => e.payload.new_date === D4));

  // =========================================================================
  console.log('\n— 5: a cancel that lands first wins; accept -> 409 and the demo stays cancelled —');
  // =========================================================================
  // The loser still holds a pending proposal to D4. Give it a queued reminder too, so the cancel
  // trigger's skip is observable, then cancel it the way /api/booking-action does.
  await q(`INSERT INTO notification_deliveries (retailer_id, booking_id, recipient_kind, recipient_email, kind, offset_key, occurrence_key, dedupe_key, due_at, status)
           VALUES ($1, $2, 'store_contact', 'lead@fixture.test', 'reminder', 'd1', $3, $4, now() + interval '1 day', 'pending')`, [R, L.booking, `${L.booking}:${lb.schedule_revision}`, `reminder:${L.booking}:${lb.schedule_revision}:store_contact:-:d1`]);
  await q(`UPDATE bookings SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'test' WHERE id = $1`, [L.booking]);
  await q(`UPDATE demos SET status = 'cancelled' WHERE booking_id = $1`, [L.booking]);
  const cancelEv = await events(L.booking, 'demo_cancelled');
  ok('cancel: confirmed -> cancelled wrote one demo_cancelled event (transition <id>:cancelled)', cancelEv.length === 1 && cancelEv[0].transition_id === `${L.booking}:cancelled`, JSON.stringify(cancelEv));
  const skippedOnCancel = await one(`SELECT status, skip_reason FROM notification_deliveries WHERE booking_id = $1`, [L.booking]);
  ok('cancel: the booking\'s pending delivery was skipped (booking_cancelled)', skippedOnCancel && skippedOnCancel.status === 'skipped' && skippedOnCancel.skip_reason === 'booking_cancelled', JSON.stringify(skippedOnCancel));
  const lateAccept = await respond(L.demo, 'accept', winnerIsB1 ? 1 : 3, winnerIsB1 ? cookieB : cookieA);
  const lb2 = await booking(L.booking), ld2 = await demo(L.demo);
  ok('late accept: 409 cancelled; booking and demo stay cancelled on the original slot', lateAccept.statusCode === 409 && lateAccept.body.error === 'cancelled' && lb2.status === 'cancelled' && ld2.status === 'cancelled' && lb2.demo_date === lb.demo_date && ld2.demo_date === ld.demo_date, `${lateAccept.statusCode} ${JSON.stringify(lateAccept.body)} ${JSON.stringify({ lb2, ld2 })}`);

  // =========================================================================
  console.log('\n— 6: a proposal beyond the brand\'s COI expiry is refused (coi_not_covered) —');
  // =========================================================================
  // Brand A's COI expires on dayP(20); D5 = dayP(25). Use whichever of B1 is still active.
  const active = winnerIsB1 ? B1 : null;
  if (!active) {
    ok('coi: (B1 lost the race and was cancelled) — scenario runs on a fresh booking', true);
  }
  const C = active || await mkConfirmed(A, V2, dayP(14), '10:00 AM');
  const cb0 = await booking(C.booking);
  const pr6 = await propose(C.demo, D5, null);
  ok('coi: the retailer may still propose beyond the COI (the check is at acceptance)', pr6.statusCode === 200 && pr6.body.proposal_version === cb0.reschedule_proposal_version + 1, `${pr6.statusCode} ${JSON.stringify(pr6.body)}`);
  const coiResp = await respond(C.demo, 'accept', pr6.body.proposal_version);
  const cb1 = await booking(C.booking), cd1 = await demo(C.demo);
  ok('coi: accept -> 409 coi_not_covered; nothing moved; proposal still pending', coiResp.statusCode === 409 && coiResp.body.error === 'coi_not_covered' && cb1.demo_date === cb0.demo_date && cb1.schedule_revision === cb0.schedule_revision && cd1.reschedule_to_date === D5, `${coiResp.statusCode} ${JSON.stringify(coiResp.body)} ${JSON.stringify({ cb1, cd1 })}`);
  const coiDecline = await respond(C.demo, 'decline', pr6.body.proposal_version);
  ok('coi: the brand can still decline it (200), which clears the proposal', coiDecline.statusCode === 200 && (await demo(C.demo)).reschedule_to_date === null, `${coiDecline.statusCode}`);

  // =========================================================================
  console.log('\n— 7 + 8: A -> B -> A gives revisions 1,2,3 with distinct occurrence keys; old reminders are skipped —');
  // =========================================================================
  const SA = { date: dayP(11), time: '10:00 AM' }, SB = { date: dayP(13), time: '10:00 AM' };
  const B3 = await mkConfirmed(A, V2, SA.date, SA.time);
  const occ = (rev) => `${B3.booking}:${rev}`;
  // Reminder deliveries for occurrence 1: one still pending (must be skipped), one already accepted (must not be touched).
  await q(`INSERT INTO notification_deliveries (retailer_id, booking_id, recipient_kind, recipient_email, kind, offset_key, occurrence_key, dedupe_key, due_at, status)
           VALUES ($1, $2, 'store_contact', 'lead@fixture.test', 'reminder', 'd1', $3, $4, now() + interval '1 day', 'pending'),
                  ($1, $2, 'store_contact', 'lead@fixture.test', 'reminder', 'w1', $3, $5, now() - interval '1 day', 'accepted')`,
    [R, B3.booking, occ(1), `reminder:${occ(1)}:store_contact:-:d1`, `reminder:${occ(1)}:store_contact:-:w1`]);
  const m1 = await one(`SELECT * FROM propose_reschedule($1, $2, $3::date, $4)`, [B3.demo, R, SB.date, SB.time]);
  const acc1 = await one(`SELECT * FROM accept_reschedule($1, $2, $3)`, [B3.booking, A.id, m1.proposal_version]);
  const m2 = await one(`SELECT * FROM propose_reschedule($1, $2, $3::date, $4)`, [B3.demo, R, SA.date, SA.time]);
  const acc2 = await one(`SELECT * FROM accept_reschedule($1, $2, $3)`, [B3.booking, A.id, m2.proposal_version]);
  const b7 = await booking(B3.booking), d7 = await demo(B3.demo);
  ok('A->B->A: revisions 1 -> 2 -> 3 and both tables back on slot A', acc1.ok === true && acc1.schedule_revision === 2 && acc2.ok === true && acc2.schedule_revision === 3 && b7.schedule_revision === 3 && b7.demo_date === SA.date && d7.demo_date === SA.date && d7.reschedule_to_date === null, JSON.stringify({ acc1, acc2, b7, d7 }));
  const ev7 = await events(B3.booking, 'demo_rescheduled');
  ok('A->B->A: two demo_rescheduled events with distinct transition ids (:2 and :3) — returning to A is a NEW occurrence', ev7.length === 2 && ev7.map(e => e.transition_id).sort().join(',') === [`${B3.booking}:rescheduled:2`, `${B3.booking}:rescheduled:3`].sort().join(','), JSON.stringify(ev7.map(e => e.transition_id)));
  ok('A->B->A: occurrence keys 1,2,3 are all distinct', new Set([occ(1), occ(2), occ(3)]).size === 3);
  const dl = await q(`SELECT offset_key, status, skip_reason FROM notification_deliveries WHERE booking_id = $1 ORDER BY offset_key`, [B3.booking]);
  ok('reminders: the pending old-occurrence reminder is skipped (rescheduled); the already-accepted one is untouched', dl.length === 2 && dl.find(x => x.offset_key === 'd1').status === 'skipped' && dl.find(x => x.offset_key === 'd1').skip_reason === 'rescheduled' && dl.find(x => x.offset_key === 'w1').status === 'accepted' && dl.find(x => x.offset_key === 'w1').skip_reason === null, JSON.stringify(dl));

  // =========================================================================
  console.log('\n— 9: demo_confirmed exactly once on -> confirmed; nothing for pending -> declined; demo_cancelled only from confirmed —');
  // =========================================================================
  const B4 = (await one(`INSERT INTO bookings (retailer_id, venue_id, brand_id, brand_name, contact_email, demo_date, demo_time, status, payment_status) VALUES ($1, $2, $3, 'B4', 'b4@fixture.test', $4, '5:00 PM', 'pending', 'paid') RETURNING id`, [R, V2, A.id, dayP(21)])).id; fx.bookings.push(B4);
  const B5 = (await one(`INSERT INTO bookings (retailer_id, venue_id, brand_id, brand_name, contact_email, demo_date, demo_time, status, payment_status) VALUES ($1, $2, $3, 'B5', 'b5@fixture.test', $4, '5:00 PM', 'pending', 'paid') RETURNING id`, [R, V2, B.id, dayP(21)])).id; fx.bookings.push(B5);
  ok('pending insert writes no event', (await events(B4, null)).length === 0 && (await events(B5, null)).length === 0);
  await q(`UPDATE bookings SET status = 'confirmed' WHERE id = $1`, [B4]);
  await q(`UPDATE bookings SET status = 'confirmed' WHERE id = $1`, [B4]);   // re-save of the same status
  await q(`UPDATE bookings SET payment_status = 'paid' WHERE id = $1`, [B4]); // unrelated column
  const ev9 = await events(B4, null);
  ok('pending -> confirmed (then re-saved) writes exactly ONE demo_confirmed with the slot in the payload', ev9.length === 1 && ev9[0].kind === 'demo_confirmed' && ev9[0].transition_id === `${B4}:confirmed:1` && ev9[0].payload.demo_time === '5:00 PM' && ev9[0].payload.venue_id === V2, JSON.stringify(ev9));
  await q(`UPDATE bookings SET status = 'declined' WHERE id = $1`, [B5]);
  ok('pending -> declined writes NOTHING (contacts were never told)', (await events(B5, null)).length === 0, JSON.stringify(await events(B5, null)));
  await q(`INSERT INTO notification_deliveries (retailer_id, booking_id, recipient_kind, recipient_email, kind, occurrence_key, dedupe_key, due_at, status)
           VALUES ($1, $2, 'store_contact', 'lead@fixture.test', 'demo_confirmed', $3, $4, now(), 'pending')`, [R, B4, `${B4}:1`, `demo_confirmed:${B4}:1:store_contact:-:-`]);
  await q(`UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [B4]);
  await q(`UPDATE bookings SET status = 'cancelled' WHERE id = $1`, [B4]);   // re-save
  const ev9b = await events(B4, 'demo_cancelled');
  const dl9 = await one(`SELECT status, skip_reason FROM notification_deliveries WHERE booking_id = $1`, [B4]);
  ok('confirmed -> cancelled writes ONE demo_cancelled and skips the queued (never sent) confirmation', ev9b.length === 1 && ev9b[0].transition_id === `${B4}:cancelled` && dl9.status === 'skipped' && dl9.skip_reason === 'booking_cancelled', JSON.stringify({ ev9b, dl9 }));
  ok('B4 total: exactly two events (confirmed, cancelled)', (await events(B4, null)).length === 2);

  // =========================================================================
  console.log('\n— 10: coi_approved / coi_rejected fire on status change with brand_note; not on re-save —');
  // =========================================================================
  const coiEvents = (vid) => q(`SELECT kind, transition_id, payload, retailer_id, booking_id, brand_id FROM notification_events WHERE transition_id LIKE $1 || ':%' ORDER BY created_at`, [vid]);
  const cv1 = (await one(`INSERT INTO coi_verifications (brand_id, status, storage_path, coi_url) VALUES ($1, 'pending', $2, $2) RETURNING id`, [B.id, `brands/${B.id}/v1.pdf`])).id;
  await q(`UPDATE coi_verifications SET review_notes = 'private words' WHERE id = $1`, [cv1]);
  ok('coi: a non-status update writes no event', (await coiEvents(cv1)).length === 0);
  await q(`UPDATE coi_verifications SET status = 'approved', review_decision = 'approved', brand_note = 'Looks good — see you at the demo.', policy_expiry = $2 WHERE id = $1`, [cv1, dayP(300)]);
  await q(`UPDATE coi_verifications SET status = 'approved' WHERE id = $1`, [cv1]);   // re-save
  const ce1 = await coiEvents(cv1);
  ok('coi: -> approved (then re-saved) writes ONE coi_approved with brand_note + expires_at, brand-scoped (no retailer/booking)', ce1.length === 1 && ce1[0].kind === 'coi_approved' && ce1[0].transition_id === `${cv1}:approved` && ce1[0].payload.brand_note === 'Looks good — see you at the demo.' && ce1[0].payload.expires_at === dayP(300) && ce1[0].brand_id === B.id && ce1[0].retailer_id === null && ce1[0].booking_id === null, JSON.stringify(ce1));
  const cv2 = (await one(`INSERT INTO coi_verifications (brand_id, status, storage_path, coi_url) VALUES ($1, 'pending', $2, $2) RETURNING id`, [B.id, `brands/${B.id}/v2.pdf`])).id;
  await q(`UPDATE coi_verifications SET status = 'rejected', review_decision = 'rejected', brand_note = 'Wrong insured party. Please re-upload.' WHERE id = $1`, [cv2]);
  await q(`UPDATE coi_verifications SET status = 'rejected', review_notes = 'again' WHERE id = $1`, [cv2]);   // re-save
  const ce2 = await coiEvents(cv2);
  ok('coi: -> rejected (then re-saved) writes ONE coi_rejected with the brand_note', ce2.length === 1 && ce2[0].kind === 'coi_rejected' && ce2[0].transition_id === `${cv2}:rejected` && ce2[0].payload.brand_note === 'Wrong insured party. Please re-upload.', JSON.stringify(ce2));

  // =========================================================================
  console.log('\n— audit: schedule_mismatches() sees no disagreement for the fixture retailer —');
  // =========================================================================
  const mism = await q(`SELECT * FROM schedule_mismatches() WHERE retailer_id = $1`, [R]);
  ok('schedule_mismatches(): zero rows for every future booking/demo pair the suite created', mism.length === 0, JSON.stringify(mism).slice(0, 300));
  // Prove the audit can see: make one pair disagree inside a transaction and roll it back.
  await ctl.query('BEGIN');
  await ctl.query(`UPDATE demos SET demo_time = '9:00 AM' WHERE id = $1`, [B3.demo]);
  const seen = await q(`SELECT field FROM schedule_mismatches() WHERE booking_id = $1`, [B3.booking]);
  await ctl.query('ROLLBACK');
  ok('schedule_mismatches(): reports a demo_time disagreement when one is introduced (rolled back)', seen.length === 1 && seen[0].field === 'demo_time', JSON.stringify(seen));
} catch (e) {
  ok('suite ran to completion without an unexpected exception', false, String((e && e.stack) || e).slice(0, 600));
} finally {
  console.log('\n— teardown (FK-ordered) —');
  try {
    for (const c of clients) await rollbackQuiet(c);
    const R = fx.retailer;
    if (fx.bookings.length) await ctl.query('DELETE FROM notification_deliveries WHERE booking_id = ANY($1::uuid[])', [fx.bookings]);
    if (R) await ctl.query('DELETE FROM notification_deliveries WHERE retailer_id = $1', [R]);
    if (R) await ctl.query('DELETE FROM notification_events WHERE retailer_id = $1', [R]);
    if (fx.brands.length) await ctl.query('DELETE FROM notification_events WHERE brand_id = ANY($1::uuid[])', [fx.brands]);
    if (R) await ctl.query('DELETE FROM demos WHERE retailer_id = $1', [R]);
    if (R) await ctl.query('DELETE FROM bookings WHERE retailer_id = $1', [R]);
    if (fx.brands.length) {
      await ctl.query('DELETE FROM coi_verifications WHERE brand_id = ANY($1::uuid[])', [fx.brands]);
      await ctl.query('DELETE FROM brand_account_sessions WHERE brand_id = ANY($1::uuid[])', [fx.brands]);
      await ctl.query('DELETE FROM brand_account_tokens WHERE brand_id = ANY($1::uuid[])', [fx.brands]);
      await ctl.query('DELETE FROM brands WHERE id = ANY($1::uuid[])', [fx.brands]);
    }
    if (R) {
      await ctl.query('DELETE FROM admin_sessions WHERE retailer_id = $1', [R]);
      await ctl.query('DELETE FROM admin_tokens WHERE retailer_id = $1', [R]);
      await ctl.query('DELETE FROM retailer_admins WHERE retailer_id = $1', [R]);
      await ctl.query('DELETE FROM venues WHERE retailer_id = $1', [R]);
      await ctl.query('DELETE FROM retailers WHERE id = $1', [R]);
      const left = await one(`SELECT (SELECT count(*) FROM bookings WHERE retailer_id = $1)::int AS b, (SELECT count(*) FROM demos WHERE retailer_id = $1)::int AS d,
                                     (SELECT count(*) FROM notification_events WHERE retailer_id = $1)::int AS e, (SELECT count(*) FROM retailers WHERE id = $1)::int AS r`, [R]);
      ok('teardown: fixture retailer, bookings, demos and events are gone', left.b === 0 && left.d === 0 && left.e === 0 && left.r === 0, JSON.stringify(left));
    }
  } catch (e) {
    ok('teardown completed', false, String((e && e.message) || e));
  }
  for (const c of clients) { try { await c.end(); } catch (_) {} }
  spy.restore();
  clearTimeout(watchdog);
}
process.exit(summary('reschedule atomic (0074)') ? 0 : 1);
