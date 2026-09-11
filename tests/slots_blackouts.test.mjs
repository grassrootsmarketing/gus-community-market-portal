// tests/slots_blackouts.test.mjs — Release B (Codex §7 configurable slots, §8 blackout dates;
// migration 0075) through the REAL routes and the real database.
//
// Proves, against demohub-rebuild-check:
//   * defaults when no slot configuration exists; an explicit empty list offers nothing;
//   * every live booking entry point (/api/book, staff /api/booking, reschedule proposal +
//     acceptance) refuses a time the venue does not offer, a closed weekday, a slot outside that
//     day's hours and a blacked-out date, with the same vocabulary;
//   * the browser cannot choose the storage spelling or the duration — "11:00" and "11:00 AM" are
//     ONE slot for capacity, and a tampered duration_hours is ignored;
//   * availability edits go through tenant-scoped RPCs: version check, merged keys, the reservation
//     guard (slot_in_use with the affected bookings), atomic apply-all that keeps each venue's own
//     blackouts, and blackout add/remove on one or all current venues with group-aware undo;
//   * the generic venues PATCH can no longer replace the availability blob;
//   * the public projection strips blackout reasons;
//   * calendar feeds carry the configured duration;
//   * offering_anomalies() and capacity_invariant_violations() are empty for the fixture retailer.
//
// Env: SB_URL, SB_KEY, SB_REF (route harness) + SB_DB_URL (session/direct pg, test project only).
import pg from 'pg';
import { installSpy, callRoute, req, ok, summary, uniq } from './_route.mjs';

const { Client } = pg;
const STAGING_REF = 'tileejdviuvijumjeplv';
const FORBIDDEN = new Set(['dkgjvsstbgnhcfboqqnd', 'ecapmcyumpjjgjwuokyv', 'eubbgurdwqmwqduamwhn']);
const SB_DB_URL = process.env.SB_DB_URL;
const SB_REF = process.env.SB_REF;
if (!SB_DB_URL) { console.log('  FAIL SB_DB_URL not set — this suite needs a direct pg connection for fixtures'); process.exit(1); }
if (SB_REF !== STAGING_REF || !SB_DB_URL.includes(STAGING_REF)) { console.log(`  FAIL REFUSING: SB_REF/SB_DB_URL must be the test project (${STAGING_REF})`); process.exit(1); }
for (const ref of FORBIDDEN) if (SB_DB_URL.includes(ref)) { console.log(`  FAIL REFUSING: SB_DB_URL references production/retired project ${ref}`); process.exit(1); }
if (/:6543(\/|$|\?)/.test(SB_DB_URL)) { console.log('  FAIL REFUSING: transaction-mode pooler (:6543); use the direct/session connection (:5432)'); process.exit(1); }

const watchdog = setTimeout(() => { console.log('  FAIL watchdog: suite exceeded 5 minutes'); process.exit(1); }, 5 * 60 * 1000);
const LA = 'America/Los_Angeles';
// A future YYYY-MM-DD falling on weekday `dow` (0 = Sunday), at least `min` days out, offset by `k` weeks.
function futureDow(dow, k = 0, min = 40) {
  const d = new Date(); d.setUTCHours(12, 0, 0, 0); d.setUTCDate(d.getUTCDate() + min);
  while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCDate(d.getUTCDate() + 7 * k);
  return d.toISOString().slice(0, 10);
}
const dayP = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

const clients = [];
async function connect(label) {
  const c = new Client({ connectionString: SB_DB_URL, ssl: /sslmode=disable/i.test(SB_DB_URL) ? false : { rejectUnauthorized: false }, application_name: `slots-${label}` });
  await c.connect();
  await c.query(`SET lock_timeout = '30s'`);
  await c.query(`SET statement_timeout = '60s'`);
  clients.push(c);
  return c;
}
const spy = installSpy();
const ctl = await connect('ctl');
const q = async (sql, params) => (await ctl.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0] || null;
const pgErr = async (sql, params) => { try { await ctl.query(sql, params); return null; } catch (e) { return e; } };

const STD_SCHEDULE = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [String(d), [{ open: '11:00', close: '14:00' }, { open: '15:00', close: '18:00' }]]));
const fx = { retailer: null, venues: [], brands: [], bookings: [] };
let staffCookie = null, brandCookie = null;

try {
  const pre = await one(`SELECT to_regprocedure('public.venue_availability_set(uuid,uuid,integer,jsonb,jsonb,boolean,integer)') AS s,
                                to_regprocedure('public.venue_blackouts_set(uuid,text,date[],uuid[],text,uuid)') AS b,
                                to_regprocedure('public.venue_availability_apply_all(uuid,uuid)') AS a,
                                to_regprocedure('public.offering_anomalies(uuid)') AS o,
                                (SELECT count(*) FROM pg_trigger WHERE tgname IN ('trg_booking_slot_resolve','trg_venue_availability_guard'))::int AS trg`);
  ok('preflight: 0075 applied (RPCs + triggers present)', pre.s && pre.b && pre.a && pre.o && pre.trg === 2, JSON.stringify(pre));

  // ---------------------------------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------------------------------
  const slug = uniq('sb');
  fx.retailer = (await one(`INSERT INTO retailers (slug, name, billing_email, billing_tier, billing_status, platform_keeps_all, timezone, auto_confirm_bookings, cancellation_mode)
                            VALUES ($1, 'Slots Fixture Market', $2, 'pro', 'active', true, $3, false, 'refundable') RETURNING id`, [slug, `${slug}@fixture.test`, LA])).id;
  const R = fx.retailer;
  const mkVenue = async (name, availability, cap = 1) => {
    const v = await one(`INSERT INTO venues (retailer_id, name, address, demo_fee, max_demos_per_slot, availability) VALUES ($1, $2, '1 Slot St', 30, $3, $4::jsonb) RETURNING id`,
      [R, name, cap, availability === undefined ? '{}' : JSON.stringify(availability)]);
    fx.venues.push(v.id); return v.id;
  };
  const V1 = await mkVenue('Configured Hours', { schedule: STD_SCHEDULE, blackouts: [] });   // hours set, no slots key -> DEFAULT slots
  const V2 = await mkVenue('Unconfigured');                                                   // {} -> no offering rule
  const V3 = await mkVenue('Custom Slots', { schedule: STD_SCHEDULE, blackouts: [] });

  const brandEmail = `${uniq('brand')}@fixture.test`;
  const brand = await one(`INSERT INTO brands (email, company_name, contact_name, phone, is_verified, default_coi_url, default_coi_expires, coi_verification_status)
                           VALUES ($1, 'Slot Brand', 'Rep', '555-0100', true, 'brands/slot.pdf', $2, 'approved') RETURNING id`, [brandEmail, dayP(400)]);
  fx.brands.push(brand.id);
  {
    const tok = 'tk-' + uniq('b');
    await q(`INSERT INTO brand_account_tokens (brand_id, email, token, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')`, [brand.id, brandEmail, tok]);
    brandCookie = (await callRoute('brand-account.js', req({ body: { action: 'verify', token: tok } }))).cookie('dh_brand_session');
  }
  const staffEmail = `staff-${slug}@fixture.test`;
  await q(`INSERT INTO retailer_admins (retailer_id, email, email_normalized, name, role) VALUES ($1, $2, $2, 'Slot Staff', 'admin')`, [R, staffEmail]);
  const staffTok = await one(`INSERT INTO admin_tokens (email, retailer_id) VALUES ($1, $2) RETURNING token`, [staffEmail, R]);
  staffCookie = (await callRoute('admin-auth.js', req({ body: { action: 'verify', token: staffTok.token } }))).cookie('dh_retailer_session');
  ok('fixtures: staff + brand sessions exist', !!staffCookie && !!brandCookie);

  const book = (venue, date, time, extra = {}) => callRoute('book.js', req({ body: { retailer_slug: slug, venue_id: venue, demo_date: date, demo_time: time, ...extra }, cookies: { dh_brand_session: brandCookie } }));
  // api/admin.js answers via send(JSON string); normalize to an object like the other routes.
  const parsed = (r) => ({ ...r, body: (typeof r.body === 'string') ? (() => { try { return JSON.parse(r.body); } catch (_) { return r.body; } })() : r.body });
  const admin = async (action, body) => parsed(await callRoute('admin.js', req({ method: 'POST', query: { action }, body, cookies: { dh_retailer_session: staffCookie } })));
  const venue = (id) => one(`SELECT id, name, availability, availability_version, max_demos_per_slot FROM venues WHERE id = $1`, [id]);
  const booking = (id) => one(`SELECT id, venue_id, demo_date::text AS demo_date, demo_time, duration_hours, status, start_at, end_at, schedule_revision FROM bookings WHERE id = $1`, [id]);
  const track = (r) => { if (r && r.body && r.body.booking_id) fx.bookings.push(r.body.booking_id); return r; };
  const hoursBetween = (a, b) => (new Date(b).getTime() - new Date(a).getTime()) / 3600e3;
  // jsonb normalizes object key order; compare shapes, not spelling.
  const canon = (v) => JSON.stringify(v, (k, val) => (val && typeof val === 'object' && !Array.isArray(val)) ? Object.fromEntries(Object.keys(val).sort().map(k2 => [k2, val[k2]])) : val);

  // ---------------------------------------------------------------------------------------------
  console.log('\n— 1: defaults on a venue with hours but no slot list (/api/book) —');
  const SUN = futureDow(0), SUN2 = futureDow(0, 1);
  {
    const r = track(await book(V1, SUN, '11:00'));   // 24-hour spelling
    ok('1a: "11:00" on a default-slot venue is accepted', r.statusCode === 200 && r.body.ok === true, `${r.statusCode} ${JSON.stringify(r.body).slice(0, 160)}`);
    const b = r.body.booking_id ? await booking(r.body.booking_id) : null;
    ok('1a: stored spelling is the canonical "11:00 AM" (not what the browser sent)', b && b.demo_time === '11:00 AM', b && b.demo_time);
    ok('1a: duration_hours = 3 from the default slot; end_at = start_at + 3h', b && b.duration_hours === 3 && b.start_at && b.end_at && hoursBetween(b.start_at, b.end_at) === 3, b && `${b.duration_hours} ${b.start_at} ${b.end_at}`);
    const r2 = track(await book(V1, SUN2, '3:00 PM'));
    ok('1b: the second default slot "3:00 PM" is accepted', r2.statusCode === 200, `${r2.statusCode} ${JSON.stringify(r2.body).slice(0, 120)}`);
    const r3 = await book(V1, SUN2, '10:00');
    ok('1c: "10:00" is refused — not a slot this venue offers (400 slot_not_offered)', r3.statusCode === 400 && r3.body.error === 'slot_not_offered', `${r3.statusCode} ${JSON.stringify(r3.body).slice(0, 120)}`);
    const r4 = await book(V1, SUN, '11:00 AM');
    ok('1d: "11:00 AM" on the same date as the "11:00" booking is slot_full (cap 1) — spelling cannot bypass capacity', r4.statusCode === 409 && r4.body.error === 'slot_full', `${r4.statusCode} ${JSON.stringify(r4.body).slice(0, 120)}`);
    const r5 = await book(V1, SUN, '12:00 PM');
    ok('1e: a time inside the hours but not a slot start is refused', r5.statusCode === 400 && r5.body.error === 'slot_not_offered', `${r5.statusCode}`);
    const r6 = await book(V1, SUN, '11:00 AM', { duration_hours: 12 });
    ok('1f: a tampered duration_hours in the body changes nothing (still slot_full on that slot)', r6.statusCode === 409, `${r6.statusCode}`);
  }

  // ---------------------------------------------------------------------------------------------
  console.log('\n— 2: an unconfigured venue ({}) has no offering rule, but capacity is still spelling-proof —');
  {
    const D = futureDow(2);
    const ins = (t) => pgErr(`INSERT INTO bookings (retailer_id, venue_id, brand_name, contact_name, contact_email, demo_date, demo_time, status, payment_status)
                              VALUES ($1, $2, 'B', 'C', 'c@fixture.test', $3, $4, 'pending', 'unpaid')`, [R, V2, D, t]);
    const e1 = await ins('11:00');
    ok('2a: "11:00" inserts on the unconfigured venue', !e1, e1 && e1.message);
    const e2 = await ins('11:00 am');
    ok('2b: "11:00 am" on the same date is slot_full (one slot, one count)', e2 && /slot_full/.test(e2.message), e2 ? e2.message.slice(0, 100) : 'inserted');
    const e3 = await ins('10:00');
    ok('2c: "10:00" inserts — no slot list or hours means no offering rule at the database level', !e3, e3 && e3.message);
    const dur = await one(`SELECT duration_hours FROM bookings WHERE venue_id = $1 AND demo_time = '10:00'`, [V2]);
    ok('2d: an unconfigured booking still gets duration_hours 3 for end_at', dur && dur.duration_hours === 3, JSON.stringify(dur));
    await q(`DELETE FROM bookings WHERE venue_id = $1`, [V2]);
  }

  // ---------------------------------------------------------------------------------------------
  console.log('\n— 3: availability actions — version check, custom slots, hours filter, reservation guard —');
  {
    const patch = parsed(await callRoute('admin.js', req({ method: 'PATCH', query: { table: 'venues', id: V3 }, body: { availability: { slots: [] } }, cookies: { dh_retailer_session: staffCookie } })));
    ok('3a: the generic venues PATCH refuses an availability blob (400 use_availability_actions)', patch.statusCode === 400 && patch.body.error === 'use_availability_actions', `${patch.statusCode} ${JSON.stringify(patch.body).slice(0, 100)}`);
    const v3before = await venue(V3);
    ok('3a: the refused PATCH changed nothing', JSON.stringify(v3before.availability) === JSON.stringify({ schedule: STD_SCHEDULE, blackouts: [] }) && v3before.availability_version === 0);

    const stale = await admin('availability-set', { venue_id: V3, expected_version: 99, slots: [{ start: '09:00', hours: 2 }] });
    ok('3b: a stale expected_version is refused (409 stale_version) and returns the current version', stale.statusCode === 409 && stale.body.error === 'stale_version' && stale.body.availability_version === 0, `${stale.statusCode} ${JSON.stringify(stale.body).slice(0, 140)}`);

    const bad = await admin('availability-set', { venue_id: V3, expected_version: 0, slots: [{ start: '9:00', hours: 2 }] });
    ok('3c: a malformed slot list ("9:00" is not HH:MM) is refused before it reaches the database', bad.statusCode === 400 && bad.body.error === 'invalid_slots', `${bad.statusCode} ${JSON.stringify(bad.body).slice(0, 120)}`);
    const overlap = await admin('availability-set', { venue_id: V3, expected_version: 0, slots: [{ start: '09:00', hours: 3 }, { start: '11:00', hours: 2 }] });
    ok('3c: overlapping slots are refused', overlap.statusCode === 400, `${overlap.statusCode}`);
    const overnight = await admin('availability-set', { venue_id: V3, expected_version: 0, slots: [{ start: '22:00', hours: 3 }] });
    ok('3c: an overnight slot is refused', overnight.statusCode === 400, `${overnight.statusCode}`);

    // Custom slots + hours: 09:00/2h and 13:00/4h; every day 09-18 except Monday closed.
    const sched = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [String(d), d === 1 ? [] : [{ open: '09:00', close: '18:00' }]]));
    const set1 = await admin('availability-set', { venue_id: V3, expected_version: 0, schedule: sched, slots: [{ start: '09:00', hours: 2 }, { start: '13:00', hours: 4 }] });
    ok('3d: custom slots + hours save (200, version 1)', set1.statusCode === 200 && set1.body.availability_version === 1, `${set1.statusCode} ${JSON.stringify(set1.body).slice(0, 160)}`);
    const TUE = futureDow(2), MON = futureDow(1), WED = futureDow(3), THU = futureDow(4);
    const r1 = track(await book(V3, TUE, '9:00 AM', { duration_hours: 12 }));
    const b1 = r1.body.booking_id ? await booking(r1.body.booking_id) : null;
    ok('3e: "9:00 AM" books on the custom venue; stored duration is the configured 2h, not the tampered 12', r1.statusCode === 200 && b1 && b1.duration_hours === 2 && hoursBetween(b1.start_at, b1.end_at) === 2, `${r1.statusCode} ${JSON.stringify(b1)}`);
    const r2 = await book(V3, TUE, '11:00 AM');
    ok('3f: the old default "11:00 AM" is no longer offered here (slot_not_offered)', r2.statusCode === 400 && r2.body.error === 'slot_not_offered', `${r2.statusCode} ${r2.body && r2.body.error}`);
    const r3 = track(await book(V3, TUE, '1:00 PM'));
    ok('3g: "1:00 PM" (13:00 + 4h = 17:00, inside 09-18) books', r3.statusCode === 200, `${r3.statusCode} ${JSON.stringify(r3.body).slice(0, 100)}`);
    const r4 = await book(V3, MON, '9:00 AM');
    ok('3h: Monday is closed -> venue_closed', r4.statusCode === 400 && r4.body.error === 'venue_closed', `${r4.statusCode} ${r4.body && r4.body.error}`);
    const sched2 = { ...sched, '3': [{ open: '09:00', close: '15:00' }] };
    const set2 = await admin('availability-set', { venue_id: V3, expected_version: 1, schedule: sched2 });
    ok('3i: an hours-only save (Wednesday 09-15) succeeds and leaves the slot list untouched', set2.statusCode === 200 && set2.body.availability_version === 2 && canon(set2.body.availability.slots) === canon([{ start: '09:00', hours: 2 }, { start: '13:00', hours: 4 }]), `${set2.statusCode} ${JSON.stringify(set2.body).slice(0, 200)}`);
    const r5 = await book(V3, WED, '1:00 PM');
    ok('3j: Wednesday "1:00 PM" (would run to 17:00, hours end 15:00) -> slot_outside_hours', r5.statusCode === 400 && r5.body.error === 'slot_outside_hours', `${r5.statusCode} ${r5.body && r5.body.error}`);
    const r6 = track(await book(V3, WED, '9:00 AM'));
    ok('3j: Wednesday "9:00 AM" still fits', r6.statusCode === 200, `${r6.statusCode}`);

    // Explicit empty list = nothing offered (not "defaults"). On a venue with no reservations (V2).
    const set3 = await admin('availability-set', { venue_id: V2, expected_version: 0, slots: [] });
    ok('3k: an explicit empty slot list saves', set3.statusCode === 200 && set3.body.availability_version === 1, `${set3.statusCode} ${JSON.stringify(set3.body).slice(0, 120)}`);
    const r7 = await book(V2, THU, '10:00');
    const r8 = await book(V2, THU, '11:00 AM');
    ok('3k: with [] nothing is offered — neither an arbitrary time nor the default start (slot_not_offered)', r7.statusCode === 400 && r7.body.error === 'slot_not_offered' && r8.statusCode === 400 && r8.body.error === 'slot_not_offered', `${r7.statusCode}/${r8.statusCode}`);
    const reset = await admin('availability-set', { venue_id: V2, expected_version: 1, reset_slots: true });
    ok('3k: reset_slots drops the key again (back to "never configured": no slots key, no schedule)', reset.statusCode === 200 && !Object.prototype.hasOwnProperty.call(reset.body.availability, 'slots'), `${reset.statusCode} ${JSON.stringify(reset.body).slice(0, 120)}`);
    const r9 = await book(V2, THU, '10:00');
    ok('3k: an unconfigured venue accepts any parseable time again', r9.statusCode === 200, `${r9.statusCode} ${JSON.stringify(r9.body).slice(0, 100)}`);
    if (r9.body && r9.body.booking_id) await q(`DELETE FROM bookings WHERE id = $1`, [r9.body.booking_id]);
    const emptyOnBooked = await admin('availability-set', { venue_id: V3, expected_version: 2, slots: [] });
    ok('3k: an empty list on a venue WITH reservations is refused (slot_in_use) — reservations are never orphaned', emptyOnBooked.statusCode === 409 && emptyOnBooked.body.error === 'slot_in_use', `${emptyOnBooked.statusCode} ${JSON.stringify(emptyOnBooked.body).slice(0, 120)}`);

    // Reservation guard: shortening 09:00 to 3h / dropping 13:00 with future bookings on them.
    const guard = await admin('availability-set', { venue_id: V3, expected_version: 2, slots: [{ start: '09:00', hours: 3 }] });
    const affected = (guard.body && guard.body.detail && guard.body.detail.affected) || [];
    ok('3l: a slot change that shortens/removes a booked slot is refused (409 slot_in_use) with the affected bookings', guard.statusCode === 409 && guard.body.error === 'slot_in_use' && affected.length >= 3, `${guard.statusCode} ${JSON.stringify(guard.body).slice(0, 240)}`);
    ok('3l: the affected list names the 9:00 AM and 1:00 PM reservations', affected.some(a => a.demo_time === '9:00 AM') && affected.some(a => a.demo_time === '1:00 PM'), JSON.stringify(affected).slice(0, 200));
    const v3g = await venue(V3);
    ok('3l: nothing changed (still the two custom slots at version 2)', v3g.availability_version === 2 && canon(v3g.availability.slots) === canon([{ start: '09:00', hours: 2 }, { start: '13:00', hours: 4 }]), JSON.stringify(v3g.availability.slots));
    const b1again = await booking(r1.body.booking_id);
    ok('3l: the booked reservation is untouched (still 2h, same slot)', b1again.duration_hours === 2 && b1again.demo_time === '9:00 AM');
    const keep = await admin('availability-set', { venue_id: V3, expected_version: 2, slots: [{ start: '09:00', hours: 2 }, { start: '13:00', hours: 4 }, { start: '17:00', hours: 1 }] });
    ok('3m: keeping the booked slots (same start + length) and adding one more is accepted', keep.statusCode === 200 && keep.body.availability_version === 3, `${keep.statusCode} ${JSON.stringify(keep.body).slice(0, 160)}`);

    // The database guard is the authority: a malformed blob written around the API is refused.
    const e = await pgErr(`UPDATE venues SET availability = jsonb_set(availability, '{slots}', '"x"'::jsonb) WHERE id = $1`, [V3]);
    ok('3n: a direct UPDATE with slots:"x" is refused by the venue guard (slot_config_invalid)', e && /slot_config_invalid|availability_invalid/.test(e.message), e ? e.message.slice(0, 120) : 'accepted');
    const e2 = await pgErr(`UPDATE venues SET availability = jsonb_set(availability, '{blackouts}', '[{"date":"2026-02-30"}]'::jsonb) WHERE id = $1`, [V3]);
    ok('3n: an impossible blackout date is refused by the venue guard', e2 && /availability_invalid/.test(e2.message), e2 ? e2.message.slice(0, 120) : 'accepted');
    const cap = await admin('availability-set', { venue_id: V3, expected_version: 3, max_demos_per_slot: 0 });
    ok('3o: capacity 0 is refused by the action (invalid_capacity)', cap.statusCode === 400 && cap.body.error === 'invalid_capacity', `${cap.statusCode}`);
  }

  // ---------------------------------------------------------------------------------------------
  console.log('\n— 4: blackout dates — add/remove, existing reservations preserved, all-current-locations, group undo —');
  const D1 = SUN;                       // V1 has a booking on D1 (scenario 1a)
  let groupId = null;
  {
    const add = await admin('availability-blackouts', { op: 'add', dates: [D1], venue_ids: [V1], reason: 'Inventory count' });
    const row = add.body && add.body.venues && add.body.venues[0];
    ok('4a: blocking a date with an existing reservation succeeds and REPORTS it (affected)', add.statusCode === 200 && row && row.venue_id === V1 && Array.isArray(row.affected) && row.affected.length === 1 && row.affected[0].demo_time === '11:00 AM', `${add.statusCode} ${JSON.stringify(add.body).slice(0, 240)}`);
    const b = await booking(fx.bookings[0]);
    ok('4a: that reservation remains valid (status unchanged, not moved)', b && b.status === 'pending_payment' && b.demo_date === D1 && b.demo_time === '11:00 AM', JSON.stringify(b));
    ok('4a: no Stripe call was made by the blackout', spy.calls.stripe.length === 0, `${spy.calls.stripe.length}`);
    const r = await book(V1, D1, '3:00 PM');
    ok('4b: a NEW booking on the blacked-out date is refused (400 date_blackout)', r.statusCode === 400 && r.body.error === 'date_blackout', `${r.statusCode} ${r.body && r.body.error}`);
    const v1 = await venue(V1);
    const entry = v1.availability.blackouts.find(x => x.date === D1);
    ok('4b: the venue carries the blackout with its private reason and a group id', entry && entry.reason === 'Inventory count' && typeof entry.group_id === 'string', JSON.stringify(v1.availability.blackouts));
    // Hours save must not clear blackouts (the old "Apply to all" wrote blackouts: []).
    const hrs = await admin('availability-set', { venue_id: V1, expected_version: v1.availability_version, schedule: STD_SCHEDULE, max_demos_per_slot: 1 });
    const v1b = await venue(V1);
    ok('4c: an hours save preserves the blackout', hrs.statusCode === 200 && v1b.availability.blackouts.some(x => x.date === D1), JSON.stringify(v1b.availability.blackouts));

    // Local block at V2 on D2, then an all-locations block on D2, then undo the group.
    const D2 = futureDow(5);
    const local = await admin('availability-blackouts', { op: 'add', dates: [D2], venue_ids: [V2], reason: 'Local only' });
    ok('4d: a local blackout at one venue', local.statusCode === 200 && local.body.venues.length === 1, `${local.statusCode}`);
    const all = await admin('availability-blackouts', { op: 'add', dates: [D2], venue_ids: null, reason: 'Holiday' });
    ok('4e: "all current locations" blocks every venue of the retailer in one call', all.statusCode === 200 && all.body.venues.length === 3, `${all.statusCode} ${JSON.stringify(all.body).slice(0, 200)}`);
    groupId = all.body.venues.find(x => x.venue_id === V1).group_id;
    const v2e = await venue(V2);
    const v2entry = v2e.availability.blackouts.find(x => x.date === D2);
    ok('4e: the venue that already had D2 keeps its OWN entry (reason/group untouched — merge, not overwrite)', v2entry && v2entry.reason === 'Local only' && v2entry.group_id !== groupId, JSON.stringify(v2entry));
    const r2 = await book(V3, D2, '9:00 AM');
    ok('4e: V3 refuses a booking on the all-locations date', r2.statusCode === 400 && r2.body.error === 'date_blackout', `${r2.statusCode}`);
    const undo = await admin('availability-blackouts', { op: 'remove', dates: [D2], venue_ids: null, group_id: groupId });
    ok('4f: undoing the all-locations block by group id', undo.statusCode === 200 && undo.body.venues.length === 3, `${undo.statusCode}`);
    const [v1f, v2f, v3f] = await Promise.all([venue(V1), venue(V2), venue(V3)]);
    ok('4f: V1 and V3 no longer have D2; V2 keeps its independent local block', !v1f.availability.blackouts.some(x => x.date === D2) && !v3f.availability.blackouts.some(x => x.date === D2) && v2f.availability.blackouts.some(x => x.date === D2 && x.reason === 'Local only'), JSON.stringify([v1f.availability.blackouts, v2f.availability.blackouts, v3f.availability.blackouts]));
    ok('4f: V1 still has its D1 blackout (unrelated dates preserved)', v1f.availability.blackouts.some(x => x.date === D1));
    const rmLocal = await admin('availability-blackouts', { op: 'remove', dates: [D2], venue_ids: [V2] });
    const v2g = await venue(V2);
    ok('4g: a local remove clears the local block', rmLocal.statusCode === 200 && !v2g.availability.blackouts.some(x => x.date === D2), JSON.stringify(v2g.availability.blackouts));
    const foreign = await admin('availability-blackouts', { op: 'add', dates: [D2], venue_ids: ['00000000-0000-0000-0000-000000000001'] });
    ok('4h: a venue id that is not yours is refused (404, nothing applied)', foreign.statusCode === 404, `${foreign.statusCode} ${JSON.stringify(foreign.body).slice(0, 100)}`);
    const badDate = await admin('availability-blackouts', { op: 'add', dates: ['2026-02-30'], venue_ids: [V1] });
    ok('4h: an impossible date is refused by the action', badDate.statusCode === 400 && badDate.body.error === 'invalid_dates', `${badDate.statusCode}`);
  }

  // ---------------------------------------------------------------------------------------------
  console.log('\n— 5: apply-all — atomic, reservation-guarded, keeps each venue\'s blackouts —');
  {
    // V3's slots (09:00/2, 13:00/4, 17:00/1) do not contain V1's booked 11:00 AM / 3:00 PM -> V1 refuses -> NOTHING applied.
    const v2before = await venue(V2);
    const refused = await admin('availability-apply-all', { source_venue_id: V3 });
    ok('5a: apply-all is refused when ANY venue has reservations on a slot the copy removes (409 slot_in_use, names the venue)', refused.statusCode === 409 && refused.body.error === 'slot_in_use' && refused.body.venue_id === V1, `${refused.statusCode} ${JSON.stringify(refused.body).slice(0, 200)}`);
    const v2after = await venue(V2);
    ok('5a: the other venue was NOT touched (all-or-nothing)', v2after.availability_version === v2before.availability_version && JSON.stringify(v2after.availability) === JSON.stringify(v2before.availability), `${v2before.availability_version} -> ${v2after.availability_version}`);
    // Make V3's list compatible with everyone's reservations: cancel V3's 1:00 PM demo, then copy 09/2 + 11/3 + 15/3.
    await q(`UPDATE bookings SET status = 'cancelled' WHERE venue_id = $1 AND demo_time = '1:00 PM'`, [V3]);
    const v3 = await venue(V3);
    const set = await admin('availability-set', { venue_id: V3, expected_version: v3.availability_version, slots: [{ start: '09:00', hours: 2 }, { start: '11:00', hours: 3 }, { start: '15:00', hours: 3 }] });
    ok('5b: V3 slot list widened to cover every venue\'s reservations', set.statusCode === 200, `${set.statusCode} ${JSON.stringify(set.body).slice(0, 160)}`);
    const applied = await admin('availability-apply-all', { source_venue_id: V3 });
    ok('5c: apply-all succeeds for both other venues', applied.statusCode === 200 && applied.body.venues.length === 2, `${applied.statusCode} ${JSON.stringify(applied.body).slice(0, 160)}`);
    const [v1, v2] = await Promise.all([venue(V1), venue(V2)]);
    ok('5c: V1 received V3\'s slots and hours', canon(v1.availability.slots) === canon([{ start: '09:00', hours: 2 }, { start: '11:00', hours: 3 }, { start: '15:00', hours: 3 }]) && canon(v1.availability.schedule) === canon((await venue(V3)).availability.schedule), JSON.stringify(v1.availability).slice(0, 200));
    ok('5c: V1 KEPT its own D1 blackout', v1.availability.blackouts.some(x => x.date === D1), JSON.stringify(v1.availability.blackouts));
    ok('5c: the unconfigured venue is now configured with the same slots, blackouts []', canon(v2.availability.slots) === canon(v1.availability.slots) && Array.isArray(v2.availability.blackouts) && v2.availability.blackouts.length === 0, JSON.stringify(v2.availability).slice(0, 160));
    const r = await book(V2, futureDow(6), '10:00');
    ok('5d: after apply-all the formerly unconfigured venue enforces the slot list ("10:00" refused)', r.statusCode === 400 && r.body.error === 'slot_not_offered', `${r.statusCode}`);
  }

  // ---------------------------------------------------------------------------------------------
  console.log('\n— 6: staff bookings obey the same rule (/api/booking) —');
  {
    const staffBook = (v, date, time) => callRoute('booking.js', req({ body: { retailer_slug: slug, brand_name: 'Slot Brand', contact_name: 'Rep', contact_email: brandEmail, contact_phone: '555-0100', venue: v, demo_date: date, demo_time: time, product: 'Samples' }, cookies: { dh_retailer_session: staffCookie } }));
    const bad = await staffBook('Configured Hours', futureDow(4, 1), '10:00');
    ok('6a: a staff booking at a non-offered time is refused (400 slot_not_offered)', bad.statusCode === 400 && bad.body.error === 'slot_not_offered', `${bad.statusCode} ${JSON.stringify(bad.body).slice(0, 120)}`);
    const good = await staffBook('Configured Hours', futureDow(4, 1), '15:00');
    if (good.body && good.body.booking_id) fx.bookings.push(good.body.booking_id);
    const rows = await q(`SELECT demo_time, duration_hours FROM bookings WHERE venue_id = $1 AND demo_date = $2`, [V1, futureDow(4, 1)]);
    ok('6b: a staff booking at "15:00" is stored canonically as "3:00 PM" with the configured 3h', good.statusCode === 200 && rows.length === 1 && rows[0].demo_time === '3:00 PM' && rows[0].duration_hours === 3, `${good.statusCode} ${JSON.stringify(good.body).slice(0, 120)} ${JSON.stringify(rows)}`);
    const blk = await staffBook('Configured Hours', D1, '3:00 PM');
    ok('6c: a staff booking on the blacked-out date is refused (date_blackout)', blk.statusCode === 400 && blk.body.error === 'date_blackout', `${blk.statusCode}`);
  }

  // ---------------------------------------------------------------------------------------------
  console.log('\n— 7: reschedule proposal + acceptance re-check the offering —');
  {
    const D3 = futureDow(0, 3), D4 = futureDow(0, 4);
    const b = await one(`INSERT INTO bookings (retailer_id, venue_id, brand_id, brand_name, contact_name, contact_email, product, demo_date, demo_time, status, payment_status)
                         VALUES ($1, $2, $3, 'Slot Brand', 'Rep', $4, 'Samples', $5, '11:00 AM', 'confirmed', 'paid') RETURNING id`, [R, V1, brand.id, brandEmail, D3]);
    fx.bookings.push(b.id);
    const d = await one(`INSERT INTO demos (retailer_id, venue_id, brand_id, company_name, contact_name, contact_email, demo_date, demo_time, duration_hours, status, confirmed_at, booking_id)
                         VALUES ($1, $2, $3, 'Slot Brand', 'Rep', $4, $5, '11:00 AM', 3, 'confirmed', now(), $6) RETURNING id`, [R, V1, brand.id, brandEmail, D3, b.id]);
    const propose = (date, time) => callRoute('booking-action.js', req({ body: { action: 'reschedule', demo_id: d.id, new_date: date, new_time: time }, cookies: { dh_retailer_session: staffCookie } }));
    const p1 = await propose(D4, '10:00 AM');
    ok('7a: proposing a time the venue does not offer is refused (400 slot_not_offered)', p1.statusCode === 400 && p1.body.error === 'slot_not_offered', `${p1.statusCode} ${JSON.stringify(p1.body).slice(0, 120)}`);
    const p2 = await propose(D1, '3:00 PM');
    ok('7b: proposing a blacked-out date is refused (400 date_blackout)', p2.statusCode === 400 && p2.body.error === 'date_blackout', `${p2.statusCode}`);
    const p3 = await propose(D4, '15:00');
    ok('7c: proposing "15:00" is accepted and stored as the canonical "3:00 PM"', p3.statusCode === 200 && p3.body.new_time === '3:00 PM', `${p3.statusCode} ${JSON.stringify(p3.body).slice(0, 140)}`);
    // Block D4 AFTER the proposal; the brand's acceptance must be refused inside the transaction.
    const blk = await admin('availability-blackouts', { op: 'add', dates: [D4], venue_ids: [V1] });
    ok('7d: D4 blocked after the proposal', blk.statusCode === 200);
    const acc = await one(`SELECT * FROM accept_reschedule($1, $2, $3)`, [b.id, brand.id, p3.body.proposal_version]);
    ok('7d: accept_reschedule refuses with date_blackout (no move)', acc && acc.ok === false && acc.reason === 'date_blackout', JSON.stringify(acc));
    const after = await booking(b.id);
    ok('7d: the booking is exactly where it was (date, slot, revision 1)', after.demo_date === D3 && after.demo_time === '11:00 AM' && after.schedule_revision === 1, JSON.stringify(after));
    await admin('availability-blackouts', { op: 'remove', dates: [D4], venue_ids: [V1] });
    const acc2 = await one(`SELECT * FROM accept_reschedule($1, $2, $3)`, [b.id, brand.id, p3.body.proposal_version]);
    const moved = await booking(b.id);
    ok('7e: once unblocked the same proposal is accepted and the booking moves with the slot\'s duration', acc2 && acc2.ok === true && moved.demo_date === D4 && moved.demo_time === '3:00 PM' && moved.duration_hours === 3 && moved.schedule_revision === 2, JSON.stringify({ acc2, moved }));
  }

  // ---------------------------------------------------------------------------------------------
  console.log('\n— 8: public projection and calendar feed —');
  {
    const pub = await callRoute('find-retailer.js', req({ body: { action: 'public-data', slug } }));
    const text = JSON.stringify(pub.body || {});
    const v1pub = pub.body && pub.body.venues && pub.body.venues.find(v => v.id === V1);
    ok('8a: public-data serves hours and slots', pub.statusCode === 200 && v1pub && Array.isArray(v1pub.availability.slots) && v1pub.availability.schedule, `${pub.statusCode}`);
    ok('8a: public blackouts carry the date ONLY — no reason, no group id', v1pub && v1pub.availability.blackouts.length >= 1 && v1pub.availability.blackouts.every(b => Object.keys(b).join(',') === 'date') && !text.includes('Inventory count') && !text.includes('group_id'), JSON.stringify(v1pub && v1pub.availability.blackouts));

    const feedKey = 'fk_' + uniq('k').replace(/-/g, '');
    await q(`UPDATE retailers SET cal_feed_key = $1 WHERE id = $2`, [feedKey, R]);
    const dm = await one(`INSERT INTO demos (retailer_id, venue_id, brand_id, company_name, contact_name, demo_date, demo_time, duration_hours, status, confirmed_at)
                          VALUES ($1, $2, $3, 'Two Hour Brand', 'Rep', $4, '9:00 AM', 2, 'confirmed', now()) RETURNING id`, [R, V3, brand.id, futureDow(2, 2)]);
    const feed = await callRoute('cal.js', req({ method: 'GET', query: { slug, key: feedKey } }));
    const ics = String(feed.body || '');
    const ev = ics.split('BEGIN:VEVENT').find(s => s.includes('UID:' + dm.id)) || '';
    const st = (ev.match(/DTSTART:(\d{8}T\d{6}Z)/) || [])[1], en = (ev.match(/DTEND:(\d{8}T\d{6}Z)/) || [])[1];
    const toDate = (s) => new Date(s.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z'));
    ok('8b: the retailer calendar feed carries the demo\'s configured 2-hour duration', feed.statusCode === 200 && st && en && (toDate(en) - toDate(st)) / 3600e3 === 2, `${feed.statusCode} ${st} ${en}`);
  }

  // ---------------------------------------------------------------------------------------------
  console.log('\n— 9: audits —');
  {
    const anomalies = await q(`SELECT * FROM offering_anomalies($1)`, [R]);
    ok('9a: offering_anomalies() is empty for the fixture retailer', anomalies.length === 0, JSON.stringify(anomalies).slice(0, 300));
    const viol = await q(`SELECT * FROM capacity_invariant_violations(NULL, true) WHERE retailer_id = $1`, [R]);
    ok('9b: capacity_invariant_violations() is empty for the fixture retailer', viol.length === 0, JSON.stringify(viol).slice(0, 200));
    const mism = await q(`SELECT * FROM schedule_mismatches() WHERE retailer_id = $1`, [R]);
    ok('9c: schedule_mismatches() is empty (bookings and demos agree after the move)', mism.length === 0, JSON.stringify(mism).slice(0, 200));
    ok('9d: no Stripe call happened anywhere in this suite', spy.calls.stripe.length === 0, `${spy.calls.stripe.length}`);
  }
} catch (e) {
  ok('suite ran to completion without an unexpected exception', false, String((e && e.stack) || e).slice(0, 600));
} finally {
  console.log('\n— teardown (FK-ordered) —');
  try {
    const R = fx.retailer;
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
      const left = await one(`SELECT (SELECT count(*) FROM bookings WHERE retailer_id = $1)::int AS b, (SELECT count(*) FROM venues WHERE retailer_id = $1)::int AS v, (SELECT count(*) FROM retailers WHERE id = $1)::int AS r`, [R]);
      ok('teardown: fixture retailer, venues and bookings are gone', left.b === 0 && left.v === 0 && left.r === 0, JSON.stringify(left));
    }
  } catch (e) {
    ok('teardown completed', false, String((e && e.message) || e));
  }
  for (const c of clients) { try { await c.end(); } catch (_) {} }
  spy.restore();
  clearTimeout(watchdog);
}
process.exit(summary('slots + blackouts (0075)') ? 0 : 1);
