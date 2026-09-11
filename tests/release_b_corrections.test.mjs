// tests/release_b_corrections.test.mjs — Codex Release B review fix order (2026-09-10), B-02…B-08,
// through the real routes and the real database (demohub-rebuild-check). B-01 (DOM) lives in
// tests/admin_controls_dom.e2e.mjs.
//
//   B-02  no unconfigured-venue wildcard: NULL/{}/blackout-only refuse new reservations; absent slot
//         list = the standard slots; malformed blobs fail closed; legacy rows are reported as legacy.
//   B-03  confirm-vs-cancel with a barrier after the initial read (blackout + slot-removal variants);
//         direct inactive->active writes re-check offerings; an active pending reservation confirmed
//         after a later blackout stays valid; stale materialisation cannot recreate a cancelled demo.
//   B-04  2h->4h and 4h->2h reschedules project duration to the demo and end_at; a refused move keeps
//         the length; retailer timezone change moves nothing (feed reads the snapshot); a duration-
//         only update preserves start/timezone even when the saved zone differs from the setting;
//         DST gap/fold local times are refused everywhere; audits clean.
//   B-05  group->local, local->group, overlapping groups, undo in both orders, stale add, remove/
//         re-add/replay, concurrent add+remove.
//   B-06  opposing-source apply-all and apply-all vs all-locations blackout run concurrently without
//         deadlock; a destination refusal leaves the SOURCE untouched; stale source version refused.
//   B-08  a slot ending at/after midnight is refused by the action and by the database.
import pg from 'pg';
import { installSpy, callRoute, req, ok, summary, uniq, ENV } from './_route.mjs';
import { _resetBindingCache } from '../api/_env.js';

const { Client } = pg;
const STAGING_REF = 'tileejdviuvijumjeplv';
const FORBIDDEN = new Set(['dkgjvsstbgnhcfboqqnd', 'ecapmcyumpjjgjwuokyv', 'eubbgurdwqmwqduamwhn']);
const SB_DB_URL = process.env.SB_DB_URL;
const SB_REF = process.env.SB_REF;
if (!SB_DB_URL) { console.log('  FAIL SB_DB_URL not set'); process.exit(1); }
if (SB_REF !== STAGING_REF || !SB_DB_URL.includes(STAGING_REF)) { console.log(`  FAIL REFUSING: SB_REF/SB_DB_URL must be the test project (${STAGING_REF})`); process.exit(1); }
for (const ref of FORBIDDEN) if (SB_DB_URL.includes(ref)) { console.log(`  FAIL REFUSING: SB_DB_URL references production/retired project ${ref}`); process.exit(1); }
if (/:6543(\/|$|\?)/.test(SB_DB_URL)) { console.log('  FAIL REFUSING: transaction-mode pooler (:6543)'); process.exit(1); }
const watchdog = setTimeout(() => { console.log('  FAIL watchdog: suite exceeded 6 minutes'); process.exit(1); }, 6 * 60 * 1000);

const LA = 'America/Los_Angeles';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const capture = (p) => p.then(r => ({ ok: true, r }), e => ({ ok: false, e }));
function futureDow(dow, k = 0, min = 40) {
  const d = new Date(); d.setUTCHours(12, 0, 0, 0); d.setUTCDate(d.getUTCDate() + min);
  while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCDate(d.getUTCDate() + 7 * k);
  return d.toISOString().slice(0, 10);
}
const dayP = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const clients = [];
async function connect(label) {
  const c = new Client({ connectionString: SB_DB_URL, ssl: /sslmode=disable/i.test(SB_DB_URL) ? false : { rejectUnauthorized: false }, application_name: `relbfix-${label}` });
  await c.connect();
  await c.query(`SET lock_timeout = '30s'`); await c.query(`SET statement_timeout = '60s'`);
  c.pid = (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  clients.push(c); return c;
}
async function release(...cs) { for (const c of cs) { try { await c.query('ROLLBACK'); } catch (_) {} try { await c.end(); } catch (_) {} const i = clients.indexOf(c); if (i >= 0) clients.splice(i, 1); } }
const spy = installSpy();
const ctl = await connect('ctl');
const q = async (sql, params) => (await ctl.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0] || null;
const pgErr = async (sql, params) => { try { await ctl.query(sql, params); return null; } catch (e) { return e; } };
// Codex R7: a malformed-fixture injection that must bypass a guard runs as ONE short transaction on a
// dedicated connection: DISABLE TRIGGER -> write -> ENABLE TRIGGER -> COMMIT; any error rolls back
// (including the DISABLE), and the connection is closed afterwards so a crash cannot leave the shared
// guard off. The browser/route work runs AFTER the commit, never inside the transaction.
async function withTriggerBypass(table, trigger, fn) {
  const tx = await connect('bypass');
  try {
    await tx.query('BEGIN');
    await tx.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    const out = await fn(tx);
    await tx.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
    await tx.query('COMMIT');
    return out;
  } catch (e) { try { await tx.query('ROLLBACK'); } catch (_) {} throw e; }
  finally { await release(tx); }
}
const triggerEnabled = async (table, trigger) => (await one(`SELECT tgenabled FROM pg_trigger WHERE tgrelid = $1::regclass AND tgname = $2`, [table, trigger])).tgenabled !== 'D';
const allDays = (w) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [String(d), w]));
const HOURS = allDays([{ open: '08:00', close: '21:00' }]);
const canon = (v) => JSON.stringify(v, (k, val) => (val && typeof val === 'object' && !Array.isArray(val)) ? Object.fromEntries(Object.keys(val).sort().map(k2 => [k2, val[k2]])) : val);
const parsed = (r) => ({ ...r, body: (typeof r.body === 'string') ? (() => { try { return JSON.parse(r.body); } catch (_) { return r.body; } })() : r.body });

const fx = { retailer: null, brands: [] };
let staffCookie = null, brandCookie = null;
try {
  const pre = await one(`SELECT to_regprocedure('public.venue_blackouts_set(uuid,text,date[],uuid[],text,uuid,uuid[])') AS b,
                                to_regprocedure('public.venue_availability_apply_all(uuid,uuid,integer,jsonb,jsonb,boolean,integer,boolean)') AS a,
                                to_regprocedure('public.booking_transition(uuid,uuid,text,jsonb,numeric)') AS t,
                                to_regprocedure('public.projection_anomalies(uuid)') AS p,
                                to_regprocedure('public.booking_slot_start_strict(date,text,text)') AS s,
                                to_regprocedure('public.snapshot_drift(uuid)') AS d`);
  ok('preflight: 0076 + 0077 applied (RPC signatures, strict parser, snapshot_drift, booking_transition, projection_anomalies)', pre.b && pre.a && pre.s && pre.d && pre.t && pre.p, JSON.stringify(pre));

  // ---------------------------------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------------------------------
  const slug = uniq('rbfix');
  fx.retailer = (await one(`INSERT INTO retailers (slug, name, billing_email, billing_tier, billing_status, platform_keeps_all, timezone, auto_confirm_bookings, cancellation_mode)
                            VALUES ($1, 'Release B Fix Market', $2, 'pro', 'active', true, $3, false, 'refundable') RETURNING id`, [slug, `${slug}@fixture.test`, LA])).id;
  const R = fx.retailer;
  const mkVenue = async (name, availability, cap = 1) => (await one(`INSERT INTO venues (retailer_id, name, address, demo_fee, max_demos_per_slot, availability) VALUES ($1, $2, '1 Fix St', 30, $3, $4::jsonb) RETURNING id`,
      [R, name, cap, availability === undefined ? '{}' : JSON.stringify(availability)])).id;
  const VA = await mkVenue('Alpha', { schedule: HOURS, slots: [{ start: '09:00', hours: 2 }, { start: '11:00', hours: 4 }, { start: '15:00', hours: 3 }], blackouts: [] });
  const VB = await mkVenue('Bravo', { schedule: HOURS, slots: [{ start: '09:00', hours: 2 }, { start: '11:00', hours: 4 }, { start: '15:00', hours: 3 }], blackouts: [] });
  const VC = await mkVenue('Charlie', { schedule: HOURS, slots: [{ start: '09:00', hours: 2 }, { start: '11:00', hours: 4 }, { start: '15:00', hours: 3 }], blackouts: [] });
  const VD = await mkVenue('Dst', { schedule: allDays([{ open: '00:00', close: '23:00' }]), slots: [{ start: '00:30', hours: 3 }, { start: '11:00', hours: 3 }], blackouts: [] });
  const VE = await mkVenue('Fold', { schedule: allDays([{ open: '00:00', close: '23:00' }]), slots: [{ start: '01:30', hours: 1 }, { start: '02:30', hours: 1 }], blackouts: [] });
  const VN = await mkVenue('Never configured');                 // {}
  const VBO = await mkVenue('Blackout only', { blackouts: [] });  // no hours
  const brandEmail = `${uniq('brand')}@fixture.test`;
  const brand = await one(`INSERT INTO brands (email, company_name, contact_name, phone, is_verified, default_coi_url, default_coi_expires, coi_verification_status)
                           VALUES ($1, 'Fix Brand', 'Rep', '555-0100', true, 'brands/fix.pdf', $2, 'approved') RETURNING id`, [brandEmail, dayP(600)]);
  fx.brands.push(brand.id);
  { const tok = 'tk-' + uniq('b'); await q(`INSERT INTO brand_account_tokens (brand_id, email, token, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')`, [brand.id, brandEmail, tok]);
    brandCookie = (await callRoute('brand-account.js', req({ body: { action: 'verify', token: tok } }))).cookie('dh_brand_session'); }
  const staffEmail = `staff-${slug}@fixture.test`;
  await q(`INSERT INTO retailer_admins (retailer_id, email, email_normalized, name, role) VALUES ($1, $2, $2, 'Fix Staff', 'admin')`, [R, staffEmail]);
  const staffTok = await one(`INSERT INTO admin_tokens (email, retailer_id) VALUES ($1, $2) RETURNING token`, [staffEmail, R]);
  staffCookie = (await callRoute('admin-auth.js', req({ body: { action: 'verify', token: staffTok.token } }))).cookie('dh_retailer_session');
  ok('fixtures: staff + brand sessions', !!staffCookie && !!brandCookie);

  const book = (venue, date, time) => callRoute('book.js', req({ body: { retailer_slug: slug, venue_id: venue, demo_date: date, demo_time: time }, cookies: { dh_brand_session: brandCookie } }));
  const admin = async (action, body) => parsed(await callRoute('admin.js', req({ method: 'POST', query: { action }, body, cookies: { dh_retailer_session: staffCookie } })));
  const venue = (id) => one(`SELECT id, name, availability, availability_version, max_demos_per_slot FROM venues WHERE id = $1`, [id]);
  const booking = (id) => one(`SELECT id, venue_id, demo_date::text AS demo_date, demo_time, duration_hours, status, start_at, end_at, timezone, schedule_revision FROM bookings WHERE id = $1`, [id]);
  const hoursBetween = (a, b) => (new Date(b).getTime() - new Date(a).getTime()) / 3600e3;
  const INSERT = `INSERT INTO bookings (retailer_id, venue_id, brand_id, brand_name, contact_name, contact_email, demo_date, demo_time, status, payment_status)
                  VALUES ($1, $2, $3, 'Fix Brand', 'Rep', $4, $5, $6, $7, 'unpaid') RETURNING id`;
  const insertBooking = (venueId, date, time, status = 'pending') => one(INSERT, [R, venueId, brand.id, brandEmail, date, time, status]);
  const mkConfirmed = async (venueId, date, time, dur) => {
    const b = await one(`INSERT INTO bookings (retailer_id, venue_id, brand_id, brand_name, contact_name, contact_email, product, demo_date, demo_time, status, payment_status)
                         VALUES ($1, $2, $3, 'Fix Brand', 'Rep', $4, 'Samples', $5, $6, 'confirmed', 'paid') RETURNING id, duration_hours`, [R, venueId, brand.id, brandEmail, date, time]);
    const d = await one(`INSERT INTO demos (retailer_id, venue_id, brand_id, company_name, contact_name, contact_email, demo_date, demo_time, duration_hours, status, confirmed_at, booking_id)
                         VALUES ($1, $2, $3, 'Fix Brand', 'Rep', $4, $5, $6, $7, 'confirmed', now(), $8) RETURNING id`, [R, venueId, brand.id, brandEmail, date, time, dur ?? b.duration_hours ?? 3, b.id]);
    return { booking: b.id, demo: d.id };
  };

  // ===========================================================================================
  console.log('\n— B-02: no wildcard for NEW reservations; legacy rows reported as legacy —');
  {
    const D = futureDow(2);
    for (const [label, vid] of [['NULL-equivalent {}', VN], ['blackout-only (no hours)', VBO]]) {
      const e = await pgErr(INSERT, [R, vid, brand.id, brandEmail, D, '2:00 AM', 'pending']);
      ok(`B-02: ${label} refuses an arbitrary time (venue_hours_not_set)`, e && /venue_hours_not_set/.test(e.message), e ? e.message.slice(0, 90) : 'inserted');
      const e2 = await pgErr(INSERT, [R, vid, brand.id, brandEmail, D, '11:00 AM', 'pending']);
      ok(`B-02: ${label} refuses even the standard slot start until hours exist`, e2 && /venue_hours_not_set/.test(e2.message), e2 ? e2.message.slice(0, 90) : 'inserted');
      const api = await book(vid, D, '11:00 AM');
      ok(`B-02: ${label} through /api/book -> 400 venue_hours_not_set`, api.statusCode === 400 && api.body.error === 'venue_hours_not_set', `${api.statusCode} ${api.body && api.body.error}`);
    }
    // Overlapping arbitrary starts can no longer coexist on a hours-only venue.
    await q(`UPDATE venues SET availability = $2::jsonb WHERE id = $1`, [VN, JSON.stringify({ schedule: HOURS, blackouts: [] })]);
    const a1 = await pgErr(INSERT, [R, VN, brand.id, brandEmail, D, '10:00', 'pending']);
    ok('B-02: with hours but no slot list, "10:00" is refused (standard slots only)', a1 && /slot_not_offered/.test(a1.message), a1 ? a1.message.slice(0, 90) : 'inserted');
    const a2 = await insertBooking(VN, D, '11:00 AM');
    ok('B-02: the standard "11:00 AM" inserts with the 3h default', !!a2 && (await booking(a2.id)).duration_hours === 3);
    // A legacy reservation (accepted before hours existed) is inventoried as LEGACY, not corruption.
    // Codex R7: bypass + fixture write + restore in ONE transaction; a failure rolls everything back
    // (the guard can never be left disabled by a failed middle statement or an exit).
    const legacy = await withTriggerBypass('bookings', 'trg_booking_slot_resolve', async (tx) =>
      (await tx.query(INSERT, [R, VBO, brand.id, brandEmail, futureDow(3), '10:37', 'confirmed'])).rows[0]);
    const audit = await q(`SELECT booking_id, reason, class FROM offering_anomalies($1)`, [R]);
    const row = audit.find(a => a.booking_id === legacy.id);
    ok('B-02: offering_anomalies() reports the pre-hours reservation as class=legacy (venue_hours_not_set), and nothing else', row && row.class === 'legacy' && row.reason === 'venue_hours_not_set' && audit.length === 1, JSON.stringify(audit));
    ok('B-02: the legacy reservation was not rewritten', (await booking(legacy.id)).demo_time === '10:37');
    await q(`DELETE FROM bookings WHERE id = ANY($1::uuid[])`, [[a2.id, legacy.id]]);
  }

  // ===========================================================================================
  console.log('\n— B-03: confirmation cannot restore a cancelled booking; reactivation re-checks offerings —');
  {
    // Barrier: the confirm handler's conditional PATCH is held until the test releases it.
    let gate = null, gateResolve = null, gateHit = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (gate && u.includes('/rpc/booking_transition') && String(opts.body || '').includes('"p_action":"confirm"')) { gateHit++; await gate; }
      return realFetch(url, opts);
    };
    for (const variant of ['blackout', 'slot-removal']) {
      const D = futureDow(4, variant === 'blackout' ? 0 : 1);
      const b = await insertBooking(VA, D, '9:00 AM', 'pending');
      spy.calls.resend.length = 0;
      gate = new Promise(r => { gateResolve = r; });
      const confirming = callRoute('booking-action.js', req({ body: { booking_id: b.id, action: 'confirm' }, cookies: { dh_retailer_session: staffCookie } }));
      // wait until the handler is parked at the barrier (it has read 'pending' already)
      for (let i = 0; i < 100 && gateHit === 0; i++) await sleep(50);
      ok(`B-03 (${variant}): the confirm handler reached its conditional transition and is parked`, gateHit === 1, `${gateHit}`);
      await q(`UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [b.id]);
      if (variant === 'blackout') {
        const blk = await admin('availability-blackouts', { op: 'add', dates: [D], venue_ids: [VA] });
        ok('B-03 (blackout): blackout committed while confirm is parked', blk.statusCode === 200);
      } else {
        const v = await venue(VA);
        const edit = await admin('availability-set', { venue_id: VA, expected_version: v.availability_version, slots: [{ start: '11:00', hours: 4 }, { start: '15:00', hours: 3 }] });
        ok('B-03 (slot-removal): the 09:00 slot removed while confirm is parked (the cancelled row does not block it)', edit.statusCode === 200, `${edit.statusCode} ${JSON.stringify(edit.body).slice(0, 120)}`);
      }
      gateResolve(); gate = null; gateHit = 0;
      const res = await confirming;
      ok(`B-03 (${variant}): confirmation is refused (409 state_changed) — cancellation won`, res.statusCode === 409 && res.body.error === 'state_changed', `${res.statusCode} ${JSON.stringify(res.body).slice(0, 120)}`);
      const after = await booking(b.id);
      const demos = await q(`SELECT id FROM demos WHERE booking_id = $1`, [b.id]);
      ok(`B-03 (${variant}): the booking stays cancelled, no demo materialised, no confirmation email`, after.status === 'cancelled' && demos.length === 0 && !spy.calls.resend.some(m => /confirmed/i.test(m.subject || '')), `${after.status} demos=${demos.length} mails=${spy.calls.resend.length}`);
      // Direct inactive -> active write must re-check the offering.
      const re = await pgErr(`UPDATE bookings SET status = 'pending' WHERE id = $1`, [b.id]);
      ok(`B-03 (${variant}): a direct reactivation is refused by the offering check (${variant === 'blackout' ? 'date_blackout' : 'slot_not_offered'})`, re && new RegExp(variant === 'blackout' ? 'date_blackout' : 'slot_not_offered').test(re.message), re ? re.message.slice(0, 100) : 'reactivated');
      // restore VA
      if (variant === 'blackout') { const e = (await venue(VA)).availability.blackouts.find(x => x.date === D); await admin('availability-blackouts', { op: 'remove', entry_ids: [e.id] }); }
      else { const v = await venue(VA); await admin('availability-set', { venue_id: VA, expected_version: v.availability_version, slots: [{ start: '09:00', hours: 2 }, { start: '11:00', hours: 4 }, { start: '15:00', hours: 3 }] }); }
    }
    globalThis.fetch = realFetch;
    // An active pending reservation confirmed AFTER a later blackout remains valid.
    const D2 = futureDow(5);
    const keep = await insertBooking(VA, D2, '9:00 AM', 'pending');
    await admin('availability-blackouts', { op: 'add', dates: [D2], venue_ids: [VA] });
    const conf = await callRoute('booking-action.js', req({ body: { booking_id: keep.id, action: 'confirm' }, cookies: { dh_retailer_session: staffCookie } }));
    const kept = await booking(keep.id);
    ok('B-03: a still-active pending reservation is confirmed after a later blackout (200, confirmed, demo created)', conf.statusCode === 200 && kept.status === 'confirmed' && (await q(`SELECT id FROM demos WHERE booking_id = $1`, [keep.id])).length === 1, `${conf.statusCode} ${kept.status}`);
    { const e = (await venue(VA)).availability.blackouts.find(x => x.date === D2); await admin('availability-blackouts', { op: 'remove', entry_ids: [e.id] }); }
    // Stale materialisation cannot recreate a cancelled demo.
    process.env = { ...ENV }; _resetBindingCache();
    const wh = await import('../api/stripe-webhook.js?t=' + Date.now());
    const c = await insertBooking(VA, futureDow(5, 1), '9:00 AM', 'pending');
    await q(`UPDATE bookings SET status = 'cancelled' WHERE id = $1`, [c.id]);
    const ctx = await wh.fetchBookingContext(c.id); ctx.booking_id = c.id;
    await wh.createDemoForConfirmedBooking(ctx);
    ok('B-03: createDemoForConfirmedBooking() on a cancelled booking materialises nothing', (await q(`SELECT id FROM demos WHERE booking_id = $1`, [c.id])).length === 0);
  }

  // ===========================================================================================
  console.log('\n— B-04: one occurrence snapshot — durations, timezone changes, DST, audits —');
  {
    const D0 = futureDow(2, 2), D1 = futureDow(3, 2);
    const B = await mkConfirmed(VA, D0, '9:00 AM');          // 2h slot
    const b0 = await booking(B.booking);
    ok('B-04: the confirmed 9:00 AM booking carries the 2h slot (end_at = start + 2h; demo 2h)', b0.duration_hours === 2 && hoursBetween(b0.start_at, b0.end_at) === 2 && (await one(`SELECT duration_hours FROM demos WHERE id = $1`, [B.demo])).duration_hours === 2, JSON.stringify(b0));
    const propose = (date, time) => callRoute('booking-action.js', req({ body: { action: 'reschedule', demo_id: B.demo, new_date: date, new_time: time }, cookies: { dh_retailer_session: staffCookie } }));
    const p1 = await propose(D1, '11:00 AM');
    const acc1 = await one(`SELECT * FROM accept_reschedule($1, $2, $3)`, [B.booking, brand.id, p1.body.proposal_version]);
    const b1 = await booking(B.booking); const d1 = await one(`SELECT demo_date::text AS demo_date, demo_time, duration_hours FROM demos WHERE id = $1`, [B.demo]);
    ok('B-04: 2h -> 4h move: booking AND demo carry 4h; end_at = start + 4h; revision 2', acc1.ok === true && b1.duration_hours === 4 && hoursBetween(b1.start_at, b1.end_at) === 4 && d1.duration_hours === 4 && d1.demo_time === '11:00 AM' && b1.schedule_revision === 2, JSON.stringify({ acc1, b1, d1 }));
    const p2 = await propose(D0, '9:00 AM');
    const acc2 = await one(`SELECT * FROM accept_reschedule($1, $2, $3)`, [B.booking, brand.id, p2.body.proposal_version]);
    const b2 = await booking(B.booking); const d2 = await one(`SELECT duration_hours FROM demos WHERE id = $1`, [B.demo]);
    ok('B-04: 4h -> 2h move back: both rows 2h again, revision 3', acc2.ok === true && b2.duration_hours === 2 && hoursBetween(b2.start_at, b2.end_at) === 2 && d2.duration_hours === 2 && b2.schedule_revision === 3, JSON.stringify({ acc2, b2, d2 }));
    // A refused move keeps the length.
    const p3 = await propose(D1, '11:00 AM');
    await admin('availability-blackouts', { op: 'add', dates: [D1], venue_ids: [VA] });
    const acc3 = await one(`SELECT * FROM accept_reschedule($1, $2, $3)`, [B.booking, brand.id, p3.body.proposal_version]);
    const b3 = await booking(B.booking);
    ok('B-04: a refused move (date_blackout) leaves date, slot, 2h length and revision untouched', acc3.ok === false && acc3.reason === 'date_blackout' && b3.duration_hours === 2 && b3.demo_date === D0 && b3.schedule_revision === 3, JSON.stringify({ acc3, b3 }));
    { const e = (await venue(VA)).availability.blackouts.find(x => x.date === D1); await admin('availability-blackouts', { op: 'remove', entry_ids: [e.id] }); }
    await one(`SELECT * FROM decline_reschedule($1, $2, $3)`, [B.booking, brand.id, p3.body.proposal_version]);

    // Retailer timezone change moves nothing; the feed reads the snapshot.
    const feedKey = 'fk_' + uniq('k').replace(/-/g, '');
    await q(`UPDATE retailers SET cal_feed_key = $1 WHERE id = $2`, [feedKey, R]);
    const feedStart = async () => {
      const feed = await callRoute('cal.js', req({ method: 'GET', query: { slug, key: feedKey } }));
      const ev = String(feed.body || '').split('BEGIN:VEVENT').find(s => s.includes('UID:' + B.demo)) || '';
      const m = ev.match(/DTSTART:(\d{8}T\d{6}Z)/); const n = ev.match(/DTEND:(\d{8}T\d{6}Z)/);
      const toDate = (s) => new Date(s.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z'));
      return { status: feed.statusCode, start: m ? toDate(m[1]) : null, end: n ? toDate(n[1]) : null };
    };
    const before = await feedStart();
    await q(`UPDATE retailers SET timezone = 'America/New_York' WHERE id = $1`, [R]);
    const afterTz = await booking(B.booking);
    const feedAfter = await feedStart();
    ok('B-04: changing the retailer timezone changes NO stored instant (start_at/timezone/end_at unchanged)', afterTz.start_at.getTime() === b3.start_at.getTime() && afterTz.timezone === LA && afterTz.end_at.getTime() === b3.end_at.getTime(), JSON.stringify(afterTz));
    ok('B-04: the retailer calendar feed still serves the accepted instant (snapshot, not a recomputation)', before.status === 200 && feedAfter.status === 200 && before.start && feedAfter.start && before.start.getTime() === feedAfter.start.getTime() && feedAfter.start.getTime() === afterTz.start_at.getTime() && (feedAfter.end - feedAfter.start) / 3600e3 === 2, JSON.stringify({ before, feedAfter }));
    const drift = await q(`SELECT reason FROM snapshot_drift($1)`, [R]);
    ok('B-04: snapshot_drift() reports only the informational timezone difference while the setting differs', drift.length >= 1 && drift.every(r => r.reason === 'timezone_differs_from_retailer'), JSON.stringify(drift));
    // Duration-only update while the saved zone differs from the current setting: start preserved.
    await q(`UPDATE bookings SET duration_hours = 3 WHERE id = $1`, [B.booking]);
    const dur3 = await booking(B.booking);
    ok('B-04: a duration-only update preserves start_at and timezone (saved LA, setting NY) and recomputes end_at = start + 3h', dur3.start_at.getTime() === b3.start_at.getTime() && dur3.timezone === LA && hoursBetween(dur3.start_at, dur3.end_at) === 3, JSON.stringify(dur3));
    await q(`UPDATE bookings SET duration_hours = 2 WHERE id = $1`, [B.booking]);
    await q(`UPDATE retailers SET timezone = $2 WHERE id = $1`, [R, LA]);
    ok('B-04: snapshot_drift() is empty once the setting matches again', (await q(`SELECT * FROM snapshot_drift($1)`, [R])).length === 0);
    // A status-only flip never moves the occurrence either.
    await q(`UPDATE bookings SET status = 'pending' WHERE id = $1`, [B.booking]);
    await q(`UPDATE bookings SET status = 'confirmed' WHERE id = $1`, [B.booking]);
    const flip = await booking(B.booking);
    ok('B-04: active->active status flips keep the snapshot', flip.start_at.getTime() === b3.start_at.getTime() && flip.schedule_revision === 3);
    // DST: gap and fold local times are refused for new reservations; a daytime slot on the same day is fine.
    const gap = await book(VE, '2027-03-14', '2:30 AM');
    ok('B-04: a DST-gap local time (2027-03-14 02:30 LA) is refused by /api/book (400 invalid_local_time)', gap.statusCode === 400 && gap.body.error === 'invalid_local_time', `${gap.statusCode} ${gap.body && gap.body.error}`);
    const gapDb = await pgErr(INSERT, [R, VE, brand.id, brandEmail, '2027-03-14', '2:30 AM', 'pending']);
    ok('B-04: the database refuses it too', gapDb && /invalid_local_time/.test(gapDb.message), gapDb ? gapDb.message.slice(0, 90) : 'inserted');
    const fold = await book(VE, '2026-11-01', '1:30 AM');
    ok('B-04: a DST-fold local time (2026-11-01 01:30 LA) is refused (ambiguous)', fold.statusCode === 400 && fold.body.error === 'invalid_local_time', `${fold.statusCode} ${fold.body && fold.body.error}`);
    const okDay = await book(VD, '2026-11-01', '11:00 AM');
    const okRow = okDay.body.booking_id ? await booking(okDay.body.booking_id) : null;
    ok('B-04: a normal daytime slot on the transition day books with a 3h elapsed duration', okDay.statusCode === 200 && okRow && hoursBetween(okRow.start_at, okRow.end_at) === 3, `${okDay.statusCode} ${JSON.stringify(okRow)}`);
    const span = await book(VD, '2026-11-01', '12:30 AM');
    ok('R6: a slot spanning the fall-back hour (00:30 + 3h) is REFUSED by /api/book (invalid_local_time)', span.statusCode === 400 && span.body.error === 'invalid_local_time', `${span.statusCode} ${span.body && span.body.error}`);
    const spanDb = await pgErr(INSERT, [R, VD, brand.id, brandEmail, '2026-11-01', '12:30 AM', 'pending']);
    ok('R6: the database refuses the fall-back span too', spanDb && /spans a daylight-saving change/.test(spanDb.message), spanDb ? spanDb.message.slice(0, 100) : 'inserted');
    const spring = await book(VD, '2027-03-14', '12:30 AM');
    const springDb = await pgErr(INSERT, [R, VD, brand.id, brandEmail, '2027-03-14', '12:30 AM', 'pending']);
    ok('R6: the spring-forward span (00:30 + 3h crosses 02:00) is refused by route and database alike', spring.statusCode === 400 && spring.body.error === 'invalid_local_time' && springDb && /spans a daylight-saving change/.test(springDb.message), `${spring.statusCode} ${springDb ? springDb.message.slice(0, 80) : 'inserted'}`);
    // A refused move leaves the old reservation untouched.
    const keepD = futureDow(2, 6);
    const K = await mkConfirmed(VD, keepD, '11:00 AM');
    const pK = await callRoute('booking-action.js', req({ body: { action: 'reschedule', demo_id: K.demo, new_date: '2027-03-14', new_time: '12:30 AM' }, cookies: { dh_retailer_session: staffCookie } }));
    const kRow = await booking(K.booking);
    ok('R6: proposing a transition-spanning move is refused (400) and the reservation is untouched', pK.statusCode === 400 && pK.body.error === 'invalid_local_time' && kRow.demo_date === keepD && kRow.schedule_revision === 1, `${pK.statusCode} ${JSON.stringify(kRow)}`);
    const pKok = await callRoute('booking-action.js', req({ body: { action: 'reschedule', demo_id: K.demo, new_date: '2027-03-14', new_time: '11:00 AM' }, cookies: { dh_retailer_session: staffCookie } }));
    ok('R6: an ordinary daytime slot on the transition date can still be proposed', pKok.statusCode === 200, `${pKok.statusCode} ${JSON.stringify(pKok.body).slice(0, 100)}`);
    await one(`SELECT * FROM decline_reschedule($1, $2, $3)`, [K.booking, brand.id, pKok.body.proposal_version]);
    const mism = await q(`SELECT * FROM schedule_mismatches() WHERE retailer_id = $1`, [R]);
    ok('B-04: schedule_mismatches() (now incl. duration) is empty for the fixture retailer', mism.length === 0, JSON.stringify(mism).slice(0, 200));
    await q(`UPDATE demos SET duration_hours = 4 WHERE id = $1`, [B.demo]);
    const mism2 = await q(`SELECT field FROM schedule_mismatches() WHERE booking_id = $1`, [B.booking]);
    ok('B-04: a demo/booking duration disagreement is reported by schedule_mismatches()', mism2.length === 1 && mism2[0].field === 'duration_hours', JSON.stringify(mism2));
    await q(`UPDATE demos SET duration_hours = 2 WHERE id = $1`, [B.demo]);
  }

  // ===========================================================================================
  console.log('\n— B-05: blackout identity — coexisting intents, undo orders, stale/replayed commands —');
  {
    const D = futureDow(1, 3);
    const grp = await admin('availability-blackouts', { op: 'add', dates: [D], venue_ids: null, reason: 'Company holiday' });
    const gid = grp.body.venues[0].group_id;
    ok('B-05: all-locations block adds one group entry per venue', grp.statusCode === 200 && grp.body.added === 7 && grp.body.venues.every(v => v.group_id === gid), JSON.stringify(grp.body).slice(0, 120));
    const loc = await admin('availability-blackouts', { op: 'add', dates: [D], venue_ids: [VB], reason: 'Bravo floor repair' });
    ok('B-05: group -> local: a local block on the same date is ADDED alongside the group entry (intent preserved, not swallowed)', loc.statusCode === 200 && loc.body.added === 1 && (await venue(VB)).availability.blackouts.filter(x => x.date === D).length === 2, JSON.stringify(loc.body).slice(0, 120));
    const undo = await admin('availability-blackouts', { op: 'remove', group_id: gid });
    const vb = await venue(VB);
    ok('B-05: undoing the group afterwards keeps Bravo blocked by its local entry; other venues reopen', undo.body.removed === 7 && vb.availability.blackouts.some(x => x.date === D && !x.group_id) && !(await venue(VA)).availability.blackouts.some(x => x.date === D), JSON.stringify(vb.availability.blackouts));
    const stillBlocked = await book(VB, D, '9:00 AM');
    ok('B-05: Bravo still refuses the date (local intent survived the group undo)', stillBlocked.statusCode === 400 && stillBlocked.body.error === 'date_blackout', `${stillBlocked.statusCode}`);
    // Overlapping groups: two all-locations blocks on the same date, undone in both orders.
    const g1 = await admin('availability-blackouts', { op: 'add', dates: [D], venue_ids: null, reason: 'G1' });
    const g2 = await admin('availability-blackouts', { op: 'add', dates: [D], venue_ids: null, reason: 'G2' });
    const id1 = g1.body.venues[0].group_id, id2 = g2.body.venues[0].group_id;
    ok('B-05: two overlapping all-locations blocks keep two distinct group entries per venue', id1 !== id2 && (await venue(VA)).availability.blackouts.filter(x => x.date === D).length === 2);
    await admin('availability-blackouts', { op: 'remove', group_id: id1 });
    ok('B-05: undoing G1 leaves the date blocked at Alpha by G2', (await book(VA, D, '9:00 AM')).body.error === 'date_blackout');
    await admin('availability-blackouts', { op: 'remove', group_id: id2 });
    ok('B-05: undoing G2 reopens Alpha; Bravo stays blocked by its local entry', (await book(VA, D, '9:00 AM')).statusCode === 200 && (await book(VB, D, '9:00 AM')).body.error === 'date_blackout');
    await q(`DELETE FROM bookings WHERE venue_id = $1 AND demo_date = $2`, [VA, D]);
    // remove / re-add / replay: an old command never deletes the replacement.
    const oldId = (await venue(VB)).availability.blackouts.find(x => x.date === D && !x.group_id).id;
    await admin('availability-blackouts', { op: 'remove', entry_ids: [oldId] });
    const readd = await admin('availability-blackouts', { op: 'add', dates: [D], venue_ids: [VB], reason: 'Replacement' });
    const newId = (await venue(VB)).availability.blackouts.find(x => x.date === D && !x.group_id).id;
    const replay = await admin('availability-blackouts', { op: 'remove', entry_ids: [oldId] });
    ok('B-05: replaying the OLD remove after a replacement was added removes nothing (the replacement survives)', readd.body.added === 1 && newId !== oldId && replay.body.removed === 0 && (await venue(VB)).availability.blackouts.some(x => x.id === newId), JSON.stringify(replay.body).slice(0, 80));
    // Concurrent add (group) + remove (local) on the same date.
    const [cAdd, cRem] = await Promise.all([
      admin('availability-blackouts', { op: 'add', dates: [D], venue_ids: null, reason: 'Concurrent group' }),
      admin('availability-blackouts', { op: 'remove', entry_ids: [newId] }),
    ]);
    const vbc = await venue(VB);
    ok('B-05: a concurrent group add and local remove both apply; Bravo ends with exactly the group entry', cAdd.statusCode === 200 && cRem.statusCode === 200 && cRem.body.removed === 1 && vbc.availability.blackouts.filter(x => x.date === D).length === 1 && vbc.availability.blackouts.find(x => x.date === D).group_id === cAdd.body.venues[0].group_id, JSON.stringify(vbc.availability.blackouts));
    await admin('availability-blackouts', { op: 'remove', group_id: cAdd.body.venues[0].group_id });
    ok('B-05: cleanup — no entry left on the date anywhere', (await q(`SELECT count(*)::int AS n FROM venues v, jsonb_array_elements(v.availability->'blackouts') e WHERE v.retailer_id = $1 AND e->>'date' = $2`, [R, D]))[0].n === 0);
    ok('B-05: no Stripe call in any blackout operation', spy.calls.stripe.length === 0);
  }

  // ===========================================================================================
  console.log('\n— B-06: apply-all — deterministic locking, no deadlock, atomic with the source edit —');
  {
    // The DST-test reservations (VD, 3h slots) would be orphaned by Alpha's 4h 11:00 slot — remove them
    // and the B-04 booking first so the concurrency scenarios exercise locking, not the guard.
    await q(`DELETE FROM demos WHERE retailer_id = $1`, [R]);
    await q(`DELETE FROM bookings WHERE retailer_id = $1`, [R]);
    const va = await venue(VA), vb = await venue(VB);
    const c1 = await connect('applyA'), c2 = await connect('applyB');
    const RPC = `SELECT ok, reason, venue_id FROM venue_availability_apply_all($1, $2, $3, NULL, NULL, false, NULL)`;
    const [r1, r2] = await Promise.all([capture(c1.query(RPC, [R, VA, va.availability_version])), capture(c2.query(RPC, [R, VB, vb.availability_version]))]);
    ok('B-06: opposing-source apply-all calls run concurrently without a deadlock (both complete)', r1.ok && r2.ok, `${r1.ok ? 'ok' : r1.e.message} / ${r2.ok ? 'ok' : r2.e.message}`);
    // exactly one can win at its version; the other sees stale_version (both are legitimate outcomes, never a lock abort)
    const outcomes = [r1, r2].filter(x => x.ok).map(x => x.r.rows[0].ok ? 'applied' : x.r.rows[0].reason);
    ok('B-06: outcomes are applied/stale_version, not errors', outcomes.every(o => o === 'applied' || o === 'stale_version'), JSON.stringify(outcomes));
    const va2 = await venue(VA);
    const c3 = await connect('applyC'), c4 = await connect('blk');
    const [r3, r4] = await Promise.all([
      capture(c3.query(RPC, [R, VA, va2.availability_version])),
      capture(c4.query(`SELECT venue_id FROM venue_blackouts_set($1, 'add', ARRAY[$2::date], NULL, 'Race', NULL, NULL)`, [R, futureDow(6, 3)])),
    ]);
    ok('B-06: apply-all and an all-locations blackout run concurrently without a deadlock', r3.ok && r4.ok, `${r3.ok ? 'ok' : r3.e.message} / ${r4.ok ? 'ok' : r4.e.message}`);
    await release(c1, c2, c3, c4);
    const gid = (await venue(VA)).availability.blackouts.find(x => x.date === futureDow(6, 3)).group_id;
    await admin('availability-blackouts', { op: 'remove', group_id: gid });
    // Destination refusal leaves the SOURCE untouched.
    const D = futureDow(2, 4);
    const held = await insertBooking(VC, D, '9:00 AM', 'pending');        // Charlie has a 09:00 reservation
    const vbNow = await venue(VB);
    const refused = await admin('availability-apply-all', { source_venue_id: VB, expected_version: vbNow.availability_version, slots: [{ start: '11:00', hours: 4 }, { start: '15:00', hours: 3 }] });
    const vbAfter = await venue(VB);
    ok('B-06: a destination refusal (Charlie has a 09:00 reservation) is 409 slot_in_use naming Charlie', refused.statusCode === 409 && refused.body.error === 'slot_in_use' && refused.body.venue_id === VC, `${refused.statusCode} ${JSON.stringify(refused.body).slice(0, 140)}`);
    ok('B-06: the SOURCE edit was rolled back with it (Bravo version and slots unchanged)', vbAfter.availability_version === vbNow.availability_version && canon(vbAfter.availability.slots) === canon(vbNow.availability.slots), `${vbNow.availability_version} -> ${vbAfter.availability_version}`);
    await q(`DELETE FROM bookings WHERE id = $1`, [held.id]);
    const stale = await admin('availability-apply-all', { source_venue_id: VB, expected_version: vbNow.availability_version + 5, schedule: HOURS });
    ok('B-06: a stale source version is refused (409 stale_version)', stale.statusCode === 409 && stale.body.error === 'stale_version', `${stale.statusCode}`);
    const okAll = await admin('availability-apply-all', { source_venue_id: VB, expected_version: vbNow.availability_version, max_demos_per_slot: 2 });
    ok('B-06: a valid one-call apply-all returns every venue\'s new snapshot (capacity 2 everywhere)', okAll.statusCode === 200 && okAll.body.venues.length === 7 && okAll.body.venues.every(x => x.max_demos_per_slot === 2), `${okAll.statusCode} ${JSON.stringify(okAll.body).slice(0, 120)}`);
    const patch = parsed(await callRoute('admin.js', req({ method: 'PATCH', query: { table: 'venues', id: VB }, body: { max_demos_per_slot: 9 }, cookies: { dh_retailer_session: staffCookie } })));
    ok('B-06: a capacity edit through the generic venues PATCH is refused (versioned actions only)', patch.statusCode === 400 && patch.body.error === 'use_availability_actions', `${patch.statusCode}`);
  }

  // ===========================================================================================
  console.log('\n— R2: booking state and demo projection are one transaction; fulfilment retries are honest —');
  {
    process.env = { ...ENV }; _resetBindingCache();
    const wh = await import('../api/stripe-webhook.js?t=' + Date.now());
    const ful = await import('../api/_fulfillment.js?t=' + Date.now());
    const D = futureDow(1, 5), D2 = futureDow(2, 5), D3 = futureDow(3, 5), D4 = futureDow(4, 5);
    const confirmRoute = (id) => callRoute('booking-action.js', req({ body: { booking_id: id, action: 'confirm' }, cookies: { dh_retailer_session: staffCookie } }));
    const cancelRoute = (id) => callRoute('booking-action.js', req({ body: { booking_id: id, action: 'cancel' }, cookies: { dh_retailer_session: staffCookie } }));
    // (a) cancel commits BEFORE the transition: the confirm is refused, no demo.
    {
      const b = await insertBooking(VA, D, '9:00 AM', 'pending');
      await q(`UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [b.id]);
      const c = await confirmRoute(b.id);
      ok('R2 (a): confirm after a committed cancel -> 409 state_changed, no demo', c.statusCode === 409 && (await q(`SELECT id FROM demos WHERE booking_id = $1`, [b.id])).length === 0, `${c.statusCode}`);
    }
    // (b) the transition and the demo are one statement: a cancel that lands after the confirm
    //     committed retires the demo the confirm created (the old separate-write gap is gone).
    {
      const b = await insertBooking(VA, D2, '9:00 AM', 'pending');
      const c = await confirmRoute(b.id);
      const demoRow = (await q(`SELECT id, status FROM demos WHERE booking_id = $1`, [b.id]))[0];
      ok('R2 (b): confirm creates the demo atomically with the status change', c.statusCode === 200 && demoRow && demoRow.status === 'confirmed' && c.body.demo_id === demoRow.id, `${c.statusCode} ${JSON.stringify(demoRow)}`);
      const x = await cancelRoute(b.id);
      const after = (await q(`SELECT status FROM demos WHERE booking_id = $1`, [b.id]))[0];
      ok('R2 (b): a later cancel retires that demo in the same transaction (demos_cancelled)', x.statusCode === 200 && x.body.demo_cancelled === true && after.status === 'cancelled', `${x.statusCode} ${JSON.stringify(x.body).slice(0, 120)}`);
    }
    // (c) cancellation judged on CURRENT state: a cancel that read "pending" while another request
    //     confirmed (and materialised) still retires the demo, because the retirement is decided
    //     inside the transaction, not from the handler's stale object.
    {
      const b = await insertBooking(VA, D3, '9:00 AM', 'pending');
      let gate = null, gateResolve = null, hit = 0;
      const realFetch = globalThis.fetch;
      globalThis.fetch = async (url, opts = {}) => {
        const u = String(url);
        // park the CANCEL's transition (first rpc call after its refund-free preparation)
        if (gate && u.includes('/rpc/booking_transition') && String(opts.body || '').includes('"p_action":"cancel"')) { hit++; await gate; }
        return realFetch(url, opts);
      };
      gate = new Promise(r => { gateResolve = r; });
      const cancelling = cancelRoute(b.id);
      for (let i = 0; i < 100 && hit === 0; i++) await sleep(50);
      ok('R2 (c): the cancel is parked at its transition with a stale "pending" read', hit === 1);
      const c = await confirmRoute(b.id);
      ok('R2 (c): meanwhile the confirm applies and materialises the demo', c.statusCode === 200 && c.body.demo_id, `${c.statusCode}`);
      gateResolve(); gate = null;
      const x = await cancelling;
      globalThis.fetch = realFetch;
      const st = await booking(b.id); const dm = (await q(`SELECT status FROM demos WHERE booking_id = $1`, [b.id]))[0];
      ok('R2 (c): the resumed cancel still wins on current state and retires the demo the confirm created', x.statusCode === 200 && x.body.demo_cancelled === true && st.status === 'cancelled' && dm.status === 'cancelled', `${x.statusCode} ${JSON.stringify({ st: st.status, dm })}`);
    }
    // (d) fulfilment: a temporary lookup failure is RETRYABLE, never "done"; a cancelled booking is
    //     deliberately superseded (no demo, no mail); an unequal-duration booking gets its own length.
    {
      const b = await insertBooking(VB, D4, '11:00 AM', 'pending_payment');   // 4h slot at Bravo
      const row = { booking_id: b.id, target_status: 'confirmed', demo_created: false, emails_sent: false };
      spy.faults.push({ url: '/rpc/booking_transition', method: 'POST', status: 500, message: 'injected_transition_failure', once: true });
      const f = await ful.runFulfillment(row, 'test-owner');
      ok('R2 (d): a transient transition failure leaves the fulfilment NOT done and retryable', f.done === false && f.demo_created === false && /injected_transition_failure/.test(f.error || ''), JSON.stringify(f));
      ok('R2 (d): no demo and no email came out of the failed attempt', (await q(`SELECT id FROM demos WHERE booking_id = $1`, [b.id])).length === 0 && !spy.calls.resend.some(m => /confirmed/i.test(m.subject || '') && (m.html || '').includes(D4)));
      spy.calls.resend.length = 0;
      const f2 = await ful.runFulfillment(row, 'test-owner');
      const dm = (await q(`SELECT status, duration_hours FROM demos WHERE booking_id = $1`, [b.id]))[0];
      const bk = await booking(b.id);
      ok('R2 (d): the retry promotes AND materialises atomically with the booking\'s own 4h duration', f2.done === true && f2.demo_created === true && bk.status === 'confirmed' && dm && dm.status === 'confirmed' && dm.duration_hours === 4 && bk.duration_hours === 4, JSON.stringify({ f2, dm, bk: bk.status }));
      const f3 = await ful.runFulfillment({ ...row, demo_created: false, emails_sent: true }, 'test-owner');
      ok('R2 (d): a replayed fulfilment is idempotent (already_present, still one demo)', f3.done === true && (await q(`SELECT id FROM demos WHERE booking_id = $1`, [b.id])).length === 1, JSON.stringify(f3));
      // superseded: cancelled before the worker ran
      const c2 = await insertBooking(VB, futureDow(5, 5), '11:00 AM', 'pending_payment');
      await q(`UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [c2.id]);
      spy.calls.resend.length = 0;
      const f4 = await ful.runFulfillment({ booking_id: c2.id, target_status: 'confirmed', demo_created: false, emails_sent: false }, 'test-owner');
      ok('R2 (d): a cancelled booking\'s fulfilment is recorded as superseded — no demo, no mail, not retried forever', f4.done === true && /superseded/.test(f4.error || '') && (await q(`SELECT id FROM demos WHERE booking_id = $1`, [c2.id])).length === 0 && spy.calls.resend.length === 0, JSON.stringify(f4));
      const m = await wh.createDemoForConfirmedBooking({ booking_id: c2.id, retailer_id: R, venue_id: VB });
      ok('R2 (d): direct materialisation of a cancelled booking reports superseded (explicit result, nothing created)', m && m.result === 'superseded', JSON.stringify(m));
    }
    // (e) audit
    const pa = await q(`SELECT reason FROM projection_anomalies($1)`, [R]);
    ok('R2 (e): projection_anomalies() is empty after the scenarios', pa.length === 0, JSON.stringify(pa).slice(0, 200));
    const orphan = await insertBooking(VA, futureDow(6, 5), '9:00 AM', 'pending');
    await q(`UPDATE bookings SET status = 'confirmed' WHERE id = $1`, [orphan.id]);   // confirmed without a demo (bypassing the route)
    const pa2 = await q(`SELECT reason FROM projection_anomalies($1)`, [R]);
    ok('R2 (e): a confirmed booking without its demo is reported (confirmed_booking_without_demo)', pa2.length === 1 && pa2[0].reason === 'confirmed_booking_without_demo', JSON.stringify(pa2));
    const mat = await wh.createDemoForConfirmedBooking({ booking_id: orphan.id, retailer_id: R, venue_id: VA });
    ok('R2 (e): materialise repairs it (created) and the audit is clean again', mat.result === 'created' && (await q(`SELECT * FROM projection_anomalies($1)`, [R])).length === 0, JSON.stringify(mat));
    await q(`UPDATE bookings SET status = 'cancelled' WHERE id = $1`, [orphan.id]);   // bypassing the route: demo stays active
    const pa3 = await q(`SELECT reason FROM projection_anomalies($1)`, [R]);
    ok('R2 (e): an active demo on an inactive booking is reported (active_demo_for_inactive_booking)', pa3.length === 1 && pa3[0].reason === 'active_demo_for_inactive_booking', JSON.stringify(pa3));
    await q(`UPDATE demos SET status = 'cancelled' WHERE booking_id = $1`, [orphan.id]);
  }

  // ===========================================================================================
  console.log('\n— R3: a failed snapshot lookup can never become a reconstructed calendar —');
  {
    const D = futureDow(2, 7);
    const B = await mkConfirmed(VA, D, '9:00 AM');
    const feedKey = 'fk_' + uniq('k').replace(/-/g, '');
    await q(`UPDATE retailers SET cal_feed_key = $1 WHERE id = $2`, [feedKey, R]);
    const tz0 = (await one(`SELECT timezone FROM retailers WHERE id = $1`, [R])).timezone;
    const retailerFeed = () => callRoute('cal.js', req({ method: 'GET', query: { slug, key: feedKey } }));
    const brandTok = await callRoute('brand-account.js', req({ body: { action: 'cal_token' }, cookies: { dh_brand_session: brandCookie } }));
    const brandFeed = () => callRoute('brand-account.js', req({ method: 'GET', query: { action: 'cal', token: brandTok.body.token } }));
    const parseEv = (body, demoId) => { const ev = String(body || '').split('BEGIN:VEVENT').find(s => s.includes(demoId + '@')) || ''; const st = (ev.match(/DTSTART:(\d{8}T\d{6}Z)/) || [])[1]; return st ? new Date(st.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z')) : null; };
    const b0 = await booking(B.booking);
    const okR = await retailerFeed(), okB = await brandFeed();
    ok('R3: healthy reads serve the accepted instant on BOTH feeds', okR.statusCode === 200 && okB.statusCode === 200 && parseEv(okR.body, B.demo) && parseEv(okR.body, B.demo).getTime() === b0.start_at.getTime() && parseEv(okB.body, B.demo) && parseEv(okB.body, B.demo).getTime() === b0.start_at.getTime(), `${okR.statusCode}/${okB.statusCode} ${brandTok.statusCode}`);
    await q(`UPDATE retailers SET timezone = 'America/New_York' WHERE id = $1`, [R]);   // reconstruction would now shift by 3h
    for (const [label, fault] of [['non-OK response', { status: 500, message: 'injected_snapshot_failure' }], ['malformed result', { status: 200, message: 'not json' }]]) {
      spy.faults.push({ url: '/rest/v1/bookings?id=in.(', method: 'GET', ...fault });
      const r = await retailerFeed();
      spy.faults.push({ url: '/rest/v1/bookings?id=in.(', method: 'GET', ...fault });
      const bf = await brandFeed();
      spy.faults.length = 0;
      ok(`R3: retailer feed under a ${label} snapshot lookup answers 503 no-store, never a shifted calendar`, r.statusCode === 503 && /no-store/.test(String(r.headers['Cache-Control'] || '')) && !String(r.body || '').includes('BEGIN:VEVENT'), `${r.statusCode} ${JSON.stringify(r.headers)}`);
      ok(`R3: brand feed under a ${label} snapshot lookup answers 503 no-store`, bf.statusCode === 503 && /no-store/.test(String(bf.headers['Cache-Control'] || '')) && !String(bf.body || '').includes('BEGIN:VEVENT'), `${bf.statusCode}`);
    }
    const okR2 = await retailerFeed();
    ok('R3: with the lookup healthy again the feed serves the SAME instant despite the changed retailer setting', okR2.statusCode === 200 && parseEv(okR2.body, B.demo) && parseEv(okR2.body, B.demo).getTime() === b0.start_at.getTime(), `${okR2.statusCode}`);
    await q(`UPDATE retailers SET timezone = $2 WHERE id = $1`, [R, tz0]);
    // a genuine legacy demo (no booking) still renders from its own fields after a SUCCESSFUL read
    const legacyDemo = await one(`INSERT INTO demos (retailer_id, venue_id, brand_id, company_name, contact_name, contact_email, demo_date, demo_time, duration_hours, status, confirmed_at) VALUES ($1, $2, $3, 'Legacy', 'Rep', $4, $5, '9:00 AM', 2, 'confirmed', now()) RETURNING id`, [R, VA, brand.id, brandEmail, futureDow(3, 7)]);
    const okR3 = await retailerFeed();
    ok('R3: an unlinked legacy demo is still reconstructed and served', okR3.statusCode === 200 && String(okR3.body).includes('UID:' + legacyDemo.id));
  }

  // ===========================================================================================
  console.log('\n— R4: the OFF switch (SLOT_EDITING_ENABLED) is a real disable, tested through the API —');
  {
    const pick = async (venueId) => await venue(venueId);
    // A dedicated, reservation-free location is the one edited (so a slot reset is legal when ON); its
    // slot list equals the others' so an ON apply-all is a no-op on slots and the invariants below hold.
    const VOFF = await mkVenue('Off matrix', { schedule: HOURS, slots: (await pick(VA)).availability.slots, blackouts: [] });
    const before = { a: await pick(VA), b: await pick(VB), c: await pick(VC) };
    const flagValues = [['unset', undefined], ['false', 'false'], ['malformed', ' True '], ['literal true', 'true']];
    for (const [label, value] of flagValues) {
      if (value === undefined) delete ENV.SLOT_EDITING_ENABLED; else ENV.SLOT_EDITING_ENABLED = value;
      const on = value === 'true';
      const va = await pick(VOFF);
      const ver = async () => (await pick(VOFF)).availability_version;
      const slotSave = await admin('availability-set', { venue_id: VOFF, expected_version: await ver(), slots: va.availability.slots });
      const reset = await admin('availability-set', { venue_id: VOFF, expected_version: await ver(), reset_slots: true });
      const restore = on ? await admin('availability-set', { venue_id: VOFF, expected_version: await ver(), slots: va.availability.slots }) : { statusCode: 200 };
      const hours = await admin('availability-set', { venue_id: VOFF, expected_version: await ver(), schedule: va.availability.schedule, max_demos_per_slot: va.max_demos_per_slot });
      const applyAll = await admin('availability-apply-all', { source_venue_id: VOFF, expected_version: await ver(), schedule: va.availability.schedule, max_demos_per_slot: va.max_demos_per_slot });
      const blk = await admin('availability-blackouts', { op: 'add', dates: [futureDow(1, 8)], venue_ids: [VOFF] });
      const create = parsed(await callRoute('admin.js', req({ method: 'POST', query: { table: 'venues' }, body: { name: 'Off ' + label + ' ' + uniq('v'), address: '1 Off St', demo_fee: 30, availability: { schedule: HOURS, slots: [{ start: '10:00', hours: 1 }], blackouts: [{ date: futureDow(1, 9), reason: 'x' }] } }, cookies: { dh_retailer_session: staffCookie } })));
      const createHours = parsed(await callRoute('admin.js', req({ method: 'POST', query: { table: 'venues' }, body: { name: 'Off hours ' + label + ' ' + uniq('v'), address: '2 Off St', demo_fee: 30, availability: { schedule: HOURS, blackouts: [{ date: futureDow(1, 9) }] } }, cookies: { dh_retailer_session: staffCookie } })));
      if (on) {
        ok(`R4 [${label}]: slot save, reset, restore, hours, apply-all, blackout and slotted creation all succeed`, slotSave.statusCode === 200 && reset.statusCode === 200 && restore.statusCode === 200 && hours.statusCode === 200 && applyAll.statusCode === 200 && blk.statusCode === 200 && create.statusCode === 201, `${slotSave.statusCode}/${reset.statusCode}/${restore.statusCode}/${hours.statusCode}/${applyAll.statusCode}/${blk.statusCode}/${create.statusCode}`);
        const resetShape = (await q(`SELECT availability->'slots' AS s FROM venues WHERE id = $1`, [VOFF]))[0];
        ok(`R4 [${label}]: (sanity) the restored slot list is back to the shared one`, canon(resetShape.s) === canon(va.availability.slots), JSON.stringify(resetShape.s));
        const created = Array.isArray(create.body) ? create.body[0] : null;
        ok(`R4 [${label}]: a new venue's client-supplied blackouts are dropped (identity is server-side only) while its slot list is kept`, created && Array.isArray(created.availability.blackouts) && created.availability.blackouts.length === 0 && created.availability.slots.length === 1, JSON.stringify(created && created.availability).slice(0, 160));
        const gid = ((blk.body.venues[0].availability || {}).blackouts || blk.body.venues[0].blackouts || []).find(x => x.date === futureDow(1, 8)).id;
        await admin('availability-blackouts', { op: 'remove', entry_ids: [gid] });
      } else {
        ok(`R4 [${label}]: slot save and reset are refused (503 slot_editing_disabled)`, slotSave.statusCode === 503 && slotSave.body.error === 'slot_editing_disabled' && reset.statusCode === 503, `${slotSave.statusCode}/${reset.statusCode}`);
        ok(`R4 [${label}]: hours + capacity still save`, hours.statusCode === 200, `${hours.statusCode} ${JSON.stringify(hours.body).slice(0, 100)}`);
        ok(`R4 [${label}]: apply-all still copies hours + capacity but every destination KEEPS its own slot list`, applyAll.statusCode === 200 && (await pick(VB)).availability.slots && canon((await pick(VB)).availability.slots) === canon(before.b.availability.slots) && canon((await pick(VC)).availability.slots) === canon(before.c.availability.slots), `${applyAll.statusCode} ${JSON.stringify(applyAll.body).slice(0, 120)}`);
        ok(`R4 [${label}]: blackout add is refused`, blk.statusCode === 503 && blk.body.error === 'slot_editing_disabled', `${blk.statusCode}`);
        ok(`R4 [${label}]: creating a venue WITH a slot list is refused; hours-only creation works and its client blackouts are dropped`, create.statusCode === 503 && create.body.error === 'slot_editing_disabled' && createHours.statusCode === 201 && Array.isArray(createHours.body) && createHours.body[0].availability.blackouts.length === 0 && !Object.prototype.hasOwnProperty.call(createHours.body[0].availability, 'slots'), `${create.statusCode}/${createHours.statusCode} ${JSON.stringify(createHours.body).slice(0, 120)}`);
      }
      // slot lists unchanged on every venue in all OFF cases (and restored in the ON case)
      const now = { a: await pick(VA), b: await pick(VB), c: await pick(VC), o: await pick(VOFF) };
      ok(`R4 [${label}]: persisted slot lists on Alpha/Bravo/Charlie/Off-matrix are what they were`, canon(now.a.availability.slots) === canon(before.a.availability.slots) && canon(now.b.availability.slots) === canon(before.b.availability.slots) && canon(now.c.availability.slots) === canon(before.c.availability.slots) && canon(now.o.availability.slots) === canon(va.availability.slots), JSON.stringify([now.a.availability.slots, now.o.availability.slots]).slice(0, 200));
    }
    ENV.SLOT_EDITING_ENABLED = 'true';
    await q(`DELETE FROM venues WHERE retailer_id = $1 AND name LIKE 'Off %'`, [R]);
  }

  // ===========================================================================================
  console.log('\n— R7: guard bypass fixtures are transactional; the guard is on before and after —');
  {
    ok('R7: trg_booking_slot_resolve is enabled before the failing bypass', await triggerEnabled('bookings', 'trg_booking_slot_resolve'));
    const failed = await capture(withTriggerBypass('bookings', 'trg_booking_slot_resolve', async (tx) => { await tx.query('SELECT 1'); throw new Error('injected_fixture_failure'); }));
    ok('R7: a failing fixture write inside the bypass is rolled back and reported', !failed.ok && /injected_fixture_failure/.test(String(failed.e && failed.e.message)));
    ok('R7: the shared guard is enabled again after the failure (observed from another connection)', await triggerEnabled('bookings', 'trg_booking_slot_resolve'));
    // interrupt: the bypass connection is terminated mid-transaction; the guard must still be on
    const tx = await connect('bypass-kill');
    tx.on('error', () => {});   // the termination below surfaces as a client error event
    await tx.query('BEGIN'); await tx.query('ALTER TABLE bookings DISABLE TRIGGER trg_booking_slot_resolve');
    await q(`SELECT pg_terminate_backend($1)`, [tx.pid]).catch(() => null);
    const i = clients.indexOf(tx); if (i >= 0) clients.splice(i, 1); try { await tx.end(); } catch (_) {}
    ok('R7: a terminated bypass connection leaves the guard enabled (DDL rolled back with the transaction)', await triggerEnabled('bookings', 'trg_booking_slot_resolve'));
  }

  // ===========================================================================================
  console.log('\n— B-08: slots may not end at or past midnight —');
  {
    const va = await venue(VA);
    const late = await admin('availability-set', { venue_id: VA, expected_version: va.availability_version, slots: [{ start: '21:00', hours: 3 }] });
    ok('B-08: 21:00 + 3h (ends 24:00) is refused by the action', late.statusCode === 400 && late.body.error === 'invalid_slots' && /midnight/.test(late.body.message || ''), `${late.statusCode} ${JSON.stringify(late.body).slice(0, 100)}`);
    const db = await pgErr(`UPDATE venues SET availability = jsonb_set(availability, '{slots}', '[{"start":"22:00","hours":2}]'::jsonb) WHERE id = $1`, [VC]);
    ok('B-08: the database guard refuses it as well (slot_config_invalid … midnight)', db && /must end before midnight/.test(db.message), db ? db.message.slice(0, 100) : 'accepted');
    const fine = await admin('availability-set', { venue_id: VA, expected_version: va.availability_version, slots: [{ start: '09:00', hours: 2 }, { start: '11:00', hours: 4 }, { start: '20:00', hours: 3 }] });
    ok('B-08: 20:00 + 3h (ends 23:00) is accepted', fine.statusCode === 200, `${fine.statusCode} ${JSON.stringify(fine.body).slice(0, 100)}`);
  }
} catch (e) {
  ok('suite ran to completion without an unexpected exception', false, String((e && e.stack) || e).slice(0, 700));
} finally {
  console.log('\n— teardown —');
  try {
    await q(`ALTER TABLE bookings ENABLE TRIGGER trg_booking_slot_resolve`);
    const R = fx.retailer;
    if (R) {
      await ctl.query('DELETE FROM notification_deliveries WHERE retailer_id = $1', [R]);
      await ctl.query('DELETE FROM notification_events WHERE retailer_id = $1', [R]);
      await ctl.query('DELETE FROM demos WHERE retailer_id = $1', [R]);
      await ctl.query('DELETE FROM bookings WHERE retailer_id = $1', [R]);
    }
    if (fx.brands.length) {
      await ctl.query('DELETE FROM notification_events WHERE brand_id = ANY($1::uuid[])', [fx.brands]);
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
      const left = await one(`SELECT (SELECT count(*) FROM venues WHERE retailer_id = $1)::int AS v, (SELECT count(*) FROM retailers WHERE id = $1)::int AS r`, [R]);
      ok('teardown: fixture gone', left.v === 0 && left.r === 0, JSON.stringify(left));
    }
  } catch (e) { ok('teardown completed', false, String((e && e.message) || e)); }
  for (const c of clients) { try { await c.end(); } catch (_) {} }
  spy.restore();
  clearTimeout(watchdog);
}
process.exit(summary('Release B corrections (0076, Codex B-02…B-08)') ? 0 : 1);
