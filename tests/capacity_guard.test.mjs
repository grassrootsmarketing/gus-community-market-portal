// tests/capacity_guard.test.mjs — Phase D: a venue's capacity can never be lowered beneath the
// reservations already sitting on a future slot (migration 0069_capacity_decrease_guard.sql).
//
// Runs against the STAGING project with the service-role key, through PostgREST, exactly like
// live_flows.test.mjs GROUP 3. Every fixture (retailer, venue, booking) is created by this run with
// a unique slug and removed in teardown; nothing pre-seeded is touched.
//
// Env: SB_URL, SB_KEY, SB_REF (see tests/_live.mjs — refuses prod and retired refs).
//
// PREREQUISITE: 0069 must be applied to the target project. There is no DDL path from this suite,
// so if the trigger/function is missing the FIRST assertion fails with an explicit "apply 0069"
// message rather than a pile of confusing scenario failures. Scenario 5 (insert race) does not
// depend on 0069 and runs regardless.
import { rest, rpc, ok, summary, uniq } from './_live.mjs';

const bin = [];   // [table, id] teardown, reverse order
const track = (t, id) => { if (id) bin.push([t, id]); return id; };

async function mkRetailer(extra = {}) {
  const r = await rest('retailers', { method: 'POST', body: JSON.stringify({
    slug: uniq('capguard'), name: 'Capacity Guard Fixture', billing_email: uniq('capguard') + '@fixture.test',
    billing_tier: 'pro', billing_status: 'active', ...extra }) });
  return track('retailers', r.ok && r.body[0] && r.body[0].id);
}
async function mkVenue(rid, extra = {}) {
  const r = await rest('venues', { method: 'POST', body: JSON.stringify({
    retailer_id: rid, name: 'Main', address: '1 Guard St', demo_fee: 30, ...extra }) });
  return track('venues', r.ok && r.body[0] && r.body[0].id);
}
// Insert a booking directly. Default is a live 24h HOLD — the exact state the bug report names.
function mkBooking(rid, vid, d, t, extra = {}) {
  const held = new Date(); held.setUTCHours(held.getUTCHours() + 24);
  return rest('bookings', { method: 'POST', body: JSON.stringify({
    retailer_id: rid, venue_id: vid, brand_name: 'Guard Brand', contact_name: 'G',
    contact_email: 'g@fixture.test', demo_date: d, demo_time: t,
    status: 'held', payment_status: 'unpaid', held_expires_at: held.toISOString(), ...extra }) });
}
async function seed(rid, vid, d, t, extra = {}) {
  const b = await mkBooking(rid, vid, d, t, extra);
  const id = track('bookings', b.ok && b.body[0] && b.body[0].id);
  if (!id) throw new Error(`fixture booking failed: HTTP ${b.status} ${JSON.stringify(b.body).slice(0, 200)}`);
  return id;
}
const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 40 + n); return d.toISOString().slice(0, 10); };
const pastDay = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 40 - n); return d.toISOString().slice(0, 10); };

const setCap = (vid, cap) => rest(`venues?id=eq.${vid}`, { method: 'PATCH', body: JSON.stringify({ max_demos_per_slot: cap }) });
async function readCap(vid) {
  const r = await rest(`venues?id=eq.${vid}&select=max_demos_per_slot`);
  return r.ok && r.body[0] ? r.body[0].max_demos_per_slot : null;
}
const violations = (vid, futureOnly = true) => rpc('capacity_invariant_violations', { p_venue_id: vid, p_future_only: futureOnly });
async function assertNoViolations(label, vid) {
  const v = await violations(vid);
  ok(`${label}: capacity_invariant_violations() returns zero rows`,
     v.ok && Array.isArray(v.body) && v.body.length === 0,
     `HTTP ${v.status} ${JSON.stringify(v.body).slice(0, 200)}`);
}
const says = (r, needle) => JSON.stringify(r.body || '').includes(needle);

// =====================================================================
console.log('\n— PREFLIGHT: migration 0069 is applied —');
let applied = false;
{
  const probe = await rpc('capacity_invariant_violations', {});
  applied = probe.ok && Array.isArray(probe.body);
  ok('0069 applied: capacity_invariant_violations() is callable by service_role', applied,
     applied ? '' : `HTTP ${probe.status} ${JSON.stringify(probe.body).slice(0, 160)}` +
       '\n       >>> supabase/migrations/0069_capacity_decrease_guard.sql has NOT been applied to this project. ' +
       'Apply it, then re-run. Scenarios 1-4 and 6 are skipped until then.');
}

if (applied) {
  // ===================================================================
  console.log('\n— SCENARIO 1: cap 2, two active holds on one future slot -> lowering to 1 is REJECTED —');
  {
    const rid = await mkRetailer(); const vid = await mkVenue(rid, { max_demos_per_slot: 2 });
    const d = day(1), t = '10:00';
    await seed(rid, vid, d, t); await seed(rid, vid, d, t);
    // a second slot with only ONE booking must not mask the full one
    await seed(rid, vid, day(2), '11:00');

    const p = await setCap(vid, 1);
    ok('S1: PATCH max_demos_per_slot=1 is refused', !p.ok, `HTTP ${p.status} ${JSON.stringify(p.body).slice(0, 200)}`);
    ok('S1: refusal is the deterministic business error', says(p, 'capacity_below_active_reservations'),
       JSON.stringify(p.body).slice(0, 240));
    ok('S1: error names the offending slot', says(p, d) && says(p, t), JSON.stringify(p.body).slice(0, 240));
    ok('S1: error carries errcode check_violation (23514)', says(p, '23514'), JSON.stringify(p.body).slice(0, 120));
    ok('S1: cap remains 2 (UPDATE fully aborted)', (await readCap(vid)) === 2, `cap now ${await readCap(vid)}`);

    // a decrease that lands exactly ON the count of the fullest slot is fine (2 -> 2 is a no-op)
    const same = await setCap(vid, 2);
    ok('S1: PATCH to the same value (2 -> 2) succeeds', same.ok, `HTTP ${same.status}`);
    // and an increase always passes
    const up = await setCap(vid, 5);
    ok('S1: increasing 2 -> 5 succeeds', up.ok && (await readCap(vid)) === 5, `HTTP ${up.status}`);
    await assertNoViolations('S1', vid);
  }

  // ===================================================================
  console.log('\n— SCENARIO 2: lowering to EXACTLY the active count succeeds —');
  {
    const rid = await mkRetailer(); const vid = await mkVenue(rid, { max_demos_per_slot: 3 });
    const d = day(3), t = '09:00';
    await seed(rid, vid, d, t); await seed(rid, vid, d, t);

    const p = await setCap(vid, 2);
    ok('S2: cap 3 with 2 active -> PATCH to 2 succeeds', p.ok && (await readCap(vid)) === 2,
       `HTTP ${p.status} ${JSON.stringify(p.body).slice(0, 160)}`);
    const again = await setCap(vid, 2);
    ok('S2: 2 -> 2 with 2 active succeeds (equal passes through)', again.ok, `HTTP ${again.status}`);
    const below = await setCap(vid, 1);
    ok('S2: 2 -> 1 with 2 active is refused', !below.ok && says(below, 'capacity_below_active_reservations'),
       `HTTP ${below.status} ${JSON.stringify(below.body).slice(0, 160)}`);
    ok('S2: cap remains 2 after the refused decrease', (await readCap(vid)) === 2, `cap now ${await readCap(vid)}`);
    await assertNoViolations('S2', vid);
  }

  // ===================================================================
  console.log('\n— SCENARIO 3: empty future slots and past slots do not block a decrease —');
  {
    const rid = await mkRetailer(); const vid = await mkVenue(rid, { max_demos_per_slot: 2 });
    const p = await setCap(vid, 1);
    ok('S3: venue with no bookings: 2 -> 1 succeeds', p.ok && (await readCap(vid)) === 1,
       `HTTP ${p.status} ${JSON.stringify(p.body).slice(0, 160)}`);
    await assertNoViolations('S3 (empty)', vid);

    // PAST slots are history: two active bookings on a past date must not pin the cap.
    const rid2 = await mkRetailer(); const vid2 = await mkVenue(rid2, { max_demos_per_slot: 2 });
    const pd = pastDay(1), t = '14:00';
    await seed(rid2, vid2, pd, t, { status: 'confirmed', payment_status: 'paid' });
    await seed(rid2, vid2, pd, t, { status: 'confirmed', payment_status: 'paid' });
    const p2 = await setCap(vid2, 1);
    ok('S3: two active bookings on a PAST slot: 2 -> 1 succeeds (guard is future-only)', p2.ok && (await readCap(vid2)) === 1,
       `HTTP ${p2.status} ${JSON.stringify(p2.body).slice(0, 160)}`);
    await assertNoViolations('S3 (past, default future-only scope)', vid2);
    const full = await violations(vid2, false);
    ok('S3: the full-history audit DOES report that past slot (audit sees what the guard ignores)',
       full.ok && Array.isArray(full.body) && full.body.length === 1
         && full.body[0].active_count === 2 && full.body[0].max_demos_per_slot === 1,
       `HTTP ${full.status} ${JSON.stringify(full.body).slice(0, 200)}`);
  }

  // ===================================================================
  console.log('\n— SCENARIO 4: cancelled / expired / declined bookings do not count —');
  {
    const rid = await mkRetailer(); const vid = await mkVenue(rid, { max_demos_per_slot: 2 });
    const d = day(4), t = '13:00';
    const live = await seed(rid, vid, d, t);                                           // the one live hold
    await seed(rid, vid, d, t, { status: 'cancelled' });
    await seed(rid, vid, d, t, { status: 'expired', held_expires_at: new Date(Date.now() - 3600e3).toISOString() });
    await seed(rid, vid, d, t, { status: 'declined' });

    const p = await setCap(vid, 1);
    ok('S4: 1 active + cancelled + expired + declined on the slot: 2 -> 1 succeeds', p.ok && (await readCap(vid)) === 1,
       `HTTP ${p.status} ${JSON.stringify(p.body).slice(0, 200)}`);
    await assertNoViolations('S4', vid);

    // Releasing the last live hold (a status change, not a slot move) must leave the audit clean.
    const c = await rest(`bookings?id=eq.${live}`, { method: 'PATCH', body: JSON.stringify({ status: 'cancelled', cancelled_at: new Date().toISOString() }) });
    ok('S4: releasing the last hold still leaves the invariant clean', c.ok, `HTTP ${c.status}`);
    await assertNoViolations('S4 (after release)', vid);
  }
}

// =====================================================================
console.log('\n— SCENARIO 5: two concurrent inserts at cap 1 -> exactly one active reservation —');
{
  const rid = await mkRetailer(); const vid = await mkVenue(rid, { max_demos_per_slot: 1 });
  const d = day(5), t = '15:00';
  const results = await Promise.all([mkBooking(rid, vid, d, t), mkBooking(rid, vid, d, t)]);
  results.forEach(r => { if (r.ok && r.body[0]) track('bookings', r.body[0].id); });
  const won = results.filter(r => r.ok), lost = results.filter(r => !r.ok);
  ok('S5: exactly one of two parallel inserts succeeds', won.length === 1, `accepted ${won.length}`);
  ok('S5: the loser fails with slot_full', lost.length === 1 && says(lost[0], 'slot_full'),
     lost.map(r => `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`).join(' | '));
  const rows = await rest(`bookings?venue_id=eq.${vid}&demo_date=eq.${d}&demo_time=eq.${t}&select=id,status`);
  ok('S5: database holds exactly one reservation for that slot', Array.isArray(rows.body) && rows.body.length === 1,
     `rows ${Array.isArray(rows.body) ? rows.body.length : '?'}`);
  if (applied) {
    await assertNoViolations('S5', vid);
    // the winner's slot is at cap; lowering further must be refused even for a single hold
    const z = await setCap(vid, 0);
    ok('S5: lowering a cap-1 slot with 1 hold to 0 is refused', !z.ok && says(z, 'capacity_below_active_reservations'),
       `HTTP ${z.status} ${JSON.stringify(z.body).slice(0, 160)}`);
    ok('S5: cap remains 1', (await readCap(vid)) === 1, `cap now ${await readCap(vid)}`);
  }
}

// =====================================================================
// 0070_capacity_serialization.sql: enforce_slot_capacity_on_move() re-checks when a booking leaves an
// excluded status for an active one, even with the slot unchanged. If this PATCH SUCCEEDS, 0070 is
// not applied to the target — that is the failure this assertion is meant to surface.
console.log('\n— SCENARIO 7 (0070): a cancelled booking cannot be reactivated into a full slot —');
{
  const rid = await mkRetailer(); const vid = await mkVenue(rid, { max_demos_per_slot: 1 });
  const d = day(7), t = '16:00';
  // cancelled first: the INSERT trigger counts the slot whatever NEW.status is, so the live hold goes last
  const dead = await seed(rid, vid, d, t, { status: 'cancelled', cancelled_at: new Date().toISOString() });
  await seed(rid, vid, d, t);
  const revive = await rest(`bookings?id=eq.${dead}`, { method: 'PATCH', body: JSON.stringify({ status: 'pending', cancelled_at: null }) });
  ok('S7: PATCH cancelled -> pending on a full slot is refused with slot_full', !revive.ok && says(revive, 'slot_full'),
     revive.ok ? 'reactivation SUCCEEDED >>> supabase/migrations/0070_capacity_serialization.sql is NOT applied to this project'
               : `HTTP ${revive.status} ${JSON.stringify(revive.body).slice(0, 200)}`);
  const row = await rest(`bookings?id=eq.${dead}&select=status`);
  ok('S7: the cancelled row is unchanged after the refusal',
     Array.isArray(row.body) && row.body[0] && row.body[0].status === 'cancelled', JSON.stringify(row.body).slice(0, 120));
  if (applied) await assertNoViolations('S7', vid);
}

// =====================================================================
console.log('\n— SCENARIO 6: no fixture venue is left in violation —');
if (applied) {
  const mine = bin.filter(([t]) => t === 'venues').map(([, id]) => id);
  let dirty = 0;
  for (const vid of mine) { const v = await violations(vid); if (!v.ok || !Array.isArray(v.body) || v.body.length) dirty++; }
  ok(`S6: capacity_invariant_violations() is empty for all ${mine.length} fixture venues (future scope)`, dirty === 0, `${dirty} venue(s) in violation`);
} else {
  console.log('  skip S6 (0069 not applied)');
}

// =====================================================================
console.log('\n— teardown —');
// children before parents: bookings -> venues -> retailers (bin is in creation order)
for (const [t, id] of bin.reverse()) await rest(`${t}?id=eq.${id}`, { method: 'DELETE' });
const mineBookings = bin.filter(([t]) => t === 'bookings').map(([, id]) => id);
const mineVenues = bin.filter(([t]) => t === 'venues').map(([, id]) => id);
const left = mineBookings.length ? await rest(`bookings?select=id&id=in.(${mineBookings.join(',')})`) : { body: [] };
ok('teardown: every booking THIS suite created is gone',
   Array.isArray(left.body) && left.body.length === 0,
   `${Array.isArray(left.body) ? left.body.length : '?'} of ${mineBookings.length} left`);
const leftV = mineVenues.length ? await rest(`venues?select=id&id=in.(${mineVenues.join(',')})`) : { body: [] };
ok('teardown: every venue THIS suite created is gone',
   Array.isArray(leftV.body) && leftV.body.length === 0,
   `${Array.isArray(leftV.body) ? leftV.body.length : '?'} of ${mineVenues.length} left`);

process.exit(summary('capacity guard') ? 0 : 1);
