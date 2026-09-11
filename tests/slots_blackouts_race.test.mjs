// tests/slots_blackouts_race.test.mjs — Release B (0075): the offering check runs INSIDE the
// booking transaction under the venue lock, so a blackout or slot edit and a concurrent
// reservation serialize instead of racing (Codex §7 "recheck inside the authoritative
// transaction under the venue lock", §8 "if blackout creation commits first reject the
// reservation; if the reservation commits first retain it and report it").
//
// Deterministic two-connection scenarios over direct Postgres (test project only):
//   1. reservation in flight, blackout waits, reservation commits -> blackout result REPORTS it, the
//      reservation stays; a later reservation on that date is refused;
//   2. blackout in flight, reservation waits -> reservation is refused once the blackout commits;
//   3. reservation in flight, slot edit that removes its slot waits -> edit refused (slot_in_use);
//   4. malformed configuration reached by disabling the guard is FAIL CLOSED at booking time;
//   5. eight concurrent reservations across two spellings of one slot at cap 1 -> exactly one wins.
import pg from 'pg';
const { Client } = pg;

const state = { pass: 0, fail: 0, fails: [] };
function ok(name, cond, extra = '') {
  if (cond) { state.pass++; console.log(`  ok   ${name}`); }
  else { state.fail++; state.fails.push(`${name} ${extra}`); console.log(`  FAIL ${name} ${extra}`); }
}
function summary(label) {
  console.log(`\n${label}: ${state.pass} passed, ${state.fail} failed`);
  if (state.fail) { console.log('FAILURES:'); state.fails.forEach(f => console.log('  x ' + f)); }
  return state.fail === 0;
}
const uniq = (p) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const capture = (p) => p.then(r => ({ ok: true, r }), e => ({ ok: false, e }));

const STAGING_REF = 'tileejdviuvijumjeplv';
const FORBIDDEN = new Set(['dkgjvsstbgnhcfboqqnd', 'ecapmcyumpjjgjwuokyv', 'eubbgurdwqmwqduamwhn']);
const SB_DB_URL = process.env.SB_DB_URL;
if (!SB_DB_URL) { console.log('  FAIL SB_DB_URL not set — cannot run deterministic race test'); process.exit(1); }
if (!SB_DB_URL.includes(STAGING_REF)) { console.log('  FAIL REFUSING: SB_DB_URL is not the test project'); process.exit(1); }
for (const ref of FORBIDDEN) if (SB_DB_URL.includes(ref)) { console.log(`  FAIL REFUSING: SB_DB_URL references production/retired project ${ref}`); process.exit(1); }
if (/:6543(\/|$|\?)/.test(SB_DB_URL)) { console.log('  FAIL REFUSING: transaction-mode pooler (:6543); use the direct/session connection (:5432)'); process.exit(1); }
const watchdog = setTimeout(() => { console.log('  FAIL watchdog: suite exceeded 5 minutes — a lock did not release'); process.exit(1); }, 5 * 60 * 1000);

const clients = [];
async function connect(label) {
  const c = new Client({ connectionString: SB_DB_URL, ssl: /sslmode=disable/i.test(SB_DB_URL) ? false : { rejectUnauthorized: false }, application_name: `slotrace-${label}` });
  await c.connect();
  await c.query(`SET lock_timeout = '30s'`);
  await c.query(`SET statement_timeout = '60s'`);
  c.pid = (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  clients.push(c);
  return c;
}
const rollbackQuiet = async (c) => { try { await c.query('ROLLBACK'); } catch (_) {} };
// Release a scenario's connections (the session pooler caps clients at 15).
async function release(...cs) { for (const c of cs) { await rollbackQuiet(c); try { await c.end(); } catch (_) {} const i = clients.indexOf(c); if (i >= 0) clients.splice(i, 1); } }
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
async function settledWithin(p, ms) { return Promise.race([p.then(() => 'resolved', () => 'rejected'), sleep(ms).then(() => 'pending')]); }

const ctl = await connect('ctl');
const q = async (sql, params) => (await ctl.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0] || null;
const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 40 + n); return d.toISOString().slice(0, 10); };
const STD = JSON.stringify({ schedule: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [String(d), [{ open: '09:00', close: '18:00' }]])), blackouts: [] });
const INSERT = `INSERT INTO bookings (retailer_id, venue_id, brand_name, contact_name, contact_email, demo_date, demo_time, status, payment_status)
                VALUES ($1, $2, 'Race Brand', 'R', 'r@fixture.test', $3, $4, 'pending', 'unpaid') RETURNING id`;
const fx = { retailer: null };

try {
  const slug = uniq('slotrace');
  fx.retailer = (await one(`INSERT INTO retailers (slug, name, billing_email, billing_tier, billing_status, timezone) VALUES ($1, 'Slot Race Fixture', $2, 'pro', 'active', 'America/Los_Angeles') RETURNING id`, [slug, `${slug}@fixture.test`])).id;
  const R = fx.retailer;
  const V1 = (await one(`INSERT INTO venues (retailer_id, name, address, demo_fee, max_demos_per_slot, availability) VALUES ($1, 'Race Hall', '1 Race St', 30, 1, $2::jsonb) RETURNING id`, [R, STD])).id;
  const V2 = (await one(`INSERT INTO venues (retailer_id, name, address, demo_fee, max_demos_per_slot, availability) VALUES ($1, 'Race Annex', '2 Race St', 30, 1, $2::jsonb) RETURNING id`, [R, STD])).id;

  // ===========================================================================================
  console.log('\n— 1: reservation in flight; blackout waits; reservation commits first -> reported, kept —');
  {
    const D = day(1);
    const c1 = await connect('res'); const c2 = await connect('blk');
    await c1.query('BEGIN');
    const ins = await c1.query(INSERT, [R, V1, D, '11:00 AM']);          // holds venue FOR SHARE until commit
    const blk = capture(c2.query(`SELECT venue_id, affected, blackouts FROM venue_blackouts_set($1, 'add', ARRAY[$2::date], ARRAY[$3::uuid], 'Race', NULL, NULL)`, [R, D, V1]));
    const w = await waitUntilBlocked(ctl, c2.pid);
    ok('1a: the blackout RPC blocks on the venue row while the reservation is uncommitted', !!w && (await settledWithin(blk, 300)) === 'pending', JSON.stringify(w));
    await c1.query('COMMIT');
    const r = await blk;
    ok('1b: after the reservation commits the blackout proceeds and REPORTS that reservation in `affected`', r.ok && r.r.rows[0].affected.some(a => a.booking_id === ins.rows[0].id), r.ok ? JSON.stringify(r.r.rows[0].affected) : String(r.e));
    const kept = await one(`SELECT status FROM bookings WHERE id = $1`, [ins.rows[0].id]);
    ok('1c: the reservation is retained, status unchanged', kept && kept.status === 'pending', JSON.stringify(kept));
    const late = await capture(ctl.query(INSERT, [R, V1, D, '3:00 PM']));
    ok('1d: a NEW reservation on that date is now refused with date_blackout', !late.ok && /date_blackout/.test(late.e.message), late.ok ? 'inserted' : late.e.message.slice(0, 100));
    await q(`SELECT venue_blackouts_set($1, 'remove', NULL, NULL, NULL, NULL, ARRAY[$2::uuid])`, [R, r.r.rows[0].blackouts.find(e => e.date === D).id]);
    await release(c1, c2);
  }

  // ===========================================================================================
  console.log('\n— 2: blackout in flight; reservation waits; blackout commits first -> reservation refused —');
  {
    const D = day(2);
    const c1 = await connect('blk2'); const c2 = await connect('res2');
    await c1.query('BEGIN');
    await c1.query(`SELECT venue_blackouts_set($1, 'add', ARRAY[$2::date], ARRAY[$3::uuid], 'Race', NULL, NULL)`, [R, D, V1]);   // venue FOR UPDATE until commit
    const ins = capture(c2.query(INSERT, [R, V1, D, '11:00 AM']));
    const w = await waitUntilBlocked(ctl, c2.pid);
    ok('2a: the reservation blocks (FOR SHARE) behind the uncommitted blackout', !!w && (await settledWithin(ins, 300)) === 'pending', JSON.stringify(w));
    await c1.query('COMMIT');
    const r = await ins;
    ok('2b: once the blackout commits the reservation is refused with date_blackout (the read happened under the lock)', !r.ok && /date_blackout/.test(r.e.message), r.ok ? 'inserted' : r.e.message.slice(0, 100));
    { const e = (await one(`SELECT availability FROM venues WHERE id = $1`, [V1])).availability.blackouts.find(x => x.date === D); await q(`SELECT venue_blackouts_set($1, 'remove', NULL, NULL, NULL, NULL, ARRAY[$2::uuid])`, [R, e.id]); }
    const n = await one(`SELECT count(*)::int AS n FROM bookings WHERE venue_id = $1 AND demo_date = $2`, [V1, D]);
    ok('2c: no row was written for the refused reservation', n.n === 0, JSON.stringify(n));
    await release(c1, c2);
  }

  // ===========================================================================================
  console.log('\n— 3: reservation in flight; slot edit that removes its slot waits -> refused (slot_in_use) —');
  {
    const D = day(3);
    const c1 = await connect('res3'); const c2 = await connect('edit3');
    await c1.query('BEGIN');
    const ins = await c1.query(INSERT, [R, V2, D, '11:00 AM']);
    const edit = capture(c2.query(`SELECT ok, reason, detail FROM venue_availability_set($1, $2, 0, NULL, '[{"start":"15:00","hours":3}]'::jsonb, false, NULL)`, [R, V2]));
    const w = await waitUntilBlocked(ctl, c2.pid);
    ok('3a: the slot edit blocks behind the uncommitted reservation', !!w && (await settledWithin(edit, 300)) === 'pending', JSON.stringify(w));
    await c1.query('COMMIT');
    const r = await edit;
    ok('3b: the edit is refused with slot_in_use and names the just-committed reservation', r.ok && r.r.rows[0].ok === false && r.r.rows[0].reason === 'slot_in_use' && JSON.stringify(r.r.rows[0].detail).includes(ins.rows[0].id), r.ok ? JSON.stringify(r.r.rows[0]).slice(0, 240) : String(r.e));
    const v = await one(`SELECT availability_version, availability->'slots' AS slots FROM venues WHERE id = $1`, [V2]);
    ok('3c: the venue is unchanged (version 0, no slot list written)', v.availability_version === 0 && v.slots === null, JSON.stringify(v));
    const keep = await one(`SELECT ok, availability_version FROM venue_availability_set($1, $2, 0, NULL, '[{"start":"11:00","hours":3},{"start":"15:00","hours":3}]'::jsonb, false, NULL)`, [R, V2]);
    ok('3d: an edit that keeps the booked slot (same start, same length) is accepted', keep.ok === true && keep.availability_version === 1, JSON.stringify(keep));
    await release(c1, c2);
  }

  // ===========================================================================================
  console.log('\n— 4: malformed configuration fails CLOSED at booking time (guard bypassed on purpose) —');
  {
    const D = day(4);
    await ctl.query('BEGIN');
    await ctl.query('ALTER TABLE venues DISABLE TRIGGER trg_venue_availability_guard');
    await ctl.query(`UPDATE venues SET availability = jsonb_set(availability, '{slots}', '"broken"'::jsonb) WHERE id = $1`, [V1]);
    await ctl.query('ALTER TABLE venues ENABLE TRIGGER trg_venue_availability_guard');
    const e = await capture(ctl.query(INSERT, [R, V1, D, '11:00 AM']));
    ok('4a: with a malformed slot list the reservation is refused (slot_config_invalid), never silently defaulted', !e.ok && /slot_config_invalid/.test(e.e.message), e.ok ? 'inserted' : e.e.message.slice(0, 120));
    await ctl.query('ROLLBACK');
    const v = await one(`SELECT availability->'slots' AS slots FROM venues WHERE id = $1`, [V1]);
    ok('4b: rolled back — the venue configuration is intact', v.slots === null, JSON.stringify(v));
  }

  // ===========================================================================================
  console.log('\n— 5: a dozen concurrent reservations, two spellings of one slot, cap 1 -> exactly one wins —');
  {
    const D = day(5);
    const N = 8;    // session-pooler friendly (15-client cap incl. ctl); enough to exercise both spellings under contention
    const conns = [];
    for (let i = 0; i < N; i++) conns.push(await connect(`c${i}`));
    const results = await Promise.all(conns.map((c, i) => capture(c.query(INSERT, [R, V1, D, i % 2 ? '11:00' : '11:00 AM']))));
    const wins = results.filter(r => r.ok).length;
    const fulls = results.filter(r => !r.ok && /slot_full/.test(r.e.message)).length;
    ok(`5a: exactly one of ${N} concurrent inserts succeeded (got ${wins})`, wins === 1, `${wins} wins, ${fulls} slot_full`);
    ok(`5a: every other attempt was refused as slot_full (${fulls}/${N - 1})`, fulls === N - 1, JSON.stringify(results.filter(r => !r.ok && !/slot_full/.test(r.e.message)).map(r => r.e.message.slice(0, 60))));
    const n = await one(`SELECT count(*)::int AS n FROM bookings WHERE venue_id = $1 AND demo_date = $2`, [V1, D]);
    ok('5b: one row on the slot', n.n === 1, JSON.stringify(n));
    const viol = await q(`SELECT * FROM capacity_invariant_violations($1, true)`, [V1]);
    ok('5c: capacity_invariant_violations() is empty', viol.length === 0, JSON.stringify(viol));
    const anomalies = await q(`SELECT * FROM offering_anomalies($1)`, [R]);
    ok('5d: offering_anomalies() is empty', anomalies.length === 0, JSON.stringify(anomalies).slice(0, 200));
    await release(...conns);
  }
} catch (e) {
  ok('suite ran to completion without an unexpected exception', false, String((e && e.stack) || e).slice(0, 600));
} finally {
  try {
    for (const c of clients) await rollbackQuiet(c);
    const R = fx.retailer;
    if (R) {
      await ctl.query('DELETE FROM notification_deliveries WHERE retailer_id = $1', [R]);
      await ctl.query('DELETE FROM notification_events WHERE retailer_id = $1', [R]);
      await ctl.query('DELETE FROM bookings WHERE retailer_id = $1', [R]);
      await ctl.query('DELETE FROM venues WHERE retailer_id = $1', [R]);
      await ctl.query('DELETE FROM retailers WHERE id = $1', [R]);
      const left = await one(`SELECT (SELECT count(*) FROM venues WHERE retailer_id = $1)::int AS v, (SELECT count(*) FROM retailers WHERE id = $1)::int AS r`, [R]);
      ok('teardown: fixture gone', left.v === 0 && left.r === 0, JSON.stringify(left));
    }
  } catch (e) { ok('teardown completed', false, String((e && e.message) || e)); }
  for (const c of clients) { try { await c.end(); } catch (_) {} }
  clearTimeout(watchdog);
}
process.exit(summary('slots + blackouts race (0075)') ? 0 : 1);
