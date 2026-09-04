// tests/capacity_serialization.test.mjs — Codex F-01: capacity decreases are serialized against
// booking inserts (migration 0070_capacity_serialization.sql).
//
// This is a MULTI-CONNECTION test. PostgREST gives one transaction per request, so the interleaving
// Codex described (an insert parked on the slot lock while the cap is lowered underneath it) cannot
// be staged through tests/_live.mjs. It needs explicit BEGIN/COMMIT on several connections at once,
// so it drives STAGING directly through the `pg` driver.
//
// Env:
//   SB_DB_URL  Postgres connection string for the STAGING project (direct or pooler form).
//   SB_REF     must equal the staging ref; the connection string must also contain it.
// Missing or mismatched env is a FAIL with exit 1 — never a vacuous pass. Local ok()/summary()
// mirror tests/_live.mjs deliberately: importing _live.mjs would require SB_URL/SB_KEY and its
// import-time guard would pre-empt the SB_DB_URL message this suite has to print.
//
// PREREQUISITE: 0070 applied to the target. The preflight checks the catalog and FAILS otherwise.
//
// Every fixture (retailer, venue, booking) is created by this run and removed in a finally block.
import pg from 'pg';

const { Client } = pg;

// ---------------------------------------------------------------------------
// Assertions (same shape as tests/_live.mjs)
// ---------------------------------------------------------------------------
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
const errText = (e) => e ? `${e.code || ''} ${String(e.message || e).slice(0, 200)}${e.constraint ? ` [constraint ${e.constraint}]` : ''}` : 'no error';

// ---------------------------------------------------------------------------
// Preflight: env + target guard. Refuse rather than guess.
// ---------------------------------------------------------------------------
const STAGING_REF = 'tileejdviuvijumjeplv';
// Live production (dkgjvsstbgnhcfboqqnd) plus the retired projects _live.mjs already refuses.
const FORBIDDEN = new Set(['dkgjvsstbgnhcfboqqnd', 'ecapmcyumpjjgjwuokyv', 'eubbgurdwqmwqduamwhn']);
const SB_DB_URL = process.env.SB_DB_URL;
const SB_REF = process.env.SB_REF;

if (!SB_DB_URL) {
  console.log('  FAIL SB_DB_URL not set — cannot run deterministic serialization test');
  process.exit(1);
}
if (!SB_REF || FORBIDDEN.has(SB_REF) || SB_REF !== STAGING_REF) {
  console.log(`  FAIL REFUSING: SB_REF must be the staging ref (${STAGING_REF}); got ${SB_REF || '<unset>'}`);
  process.exit(1);
}
if (!SB_DB_URL.includes(STAGING_REF)) {
  console.log('  FAIL REFUSING: SB_DB_URL does not reference the staging project (host or pooler user must contain the ref)');
  process.exit(1);
}
for (const ref of FORBIDDEN) {
  if (SB_DB_URL.includes(ref)) { console.log(`  FAIL REFUSING: SB_DB_URL references production/retired project ${ref}`); process.exit(1); }
}
// The scenarios rely on session state (pg_backend_pid, SET lock_timeout, explicit BEGIN/COMMIT that
// spans several statements). Supabase's transaction-mode pooler (port 6543) hands each transaction
// to any backend, so use the direct connection or the SESSION-mode pooler (port 5432).
if (/:6543(\/|$|\?)/.test(SB_DB_URL)) {
  console.log('  FAIL REFUSING: SB_DB_URL points at the transaction-mode pooler (:6543); use the direct/session connection (:5432)');
  process.exit(1);
}

// Whole-run watchdog: a lock that never releases must fail the run, not hang CI.
const WATCHDOG_MS = 5 * 60 * 1000;
const watchdog = setTimeout(() => { console.log('  FAIL watchdog: suite exceeded 5 minutes — a lock did not release'); process.exit(1); }, WATCHDOG_MS);

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------
const clients = [];
async function connect(label) {
  const ssl = /sslmode=disable/i.test(SB_DB_URL) ? false : { rejectUnauthorized: false };
  const c = new Client({ connectionString: SB_DB_URL, ssl, application_name: `capser-${label}` });
  await c.connect();
  // A blocked statement that never wakes up is a FAIL (via error), never a hang.
  await c.query(`SET lock_timeout = '30s'`);
  await c.query(`SET statement_timeout = '60s'`);
  c.label = label;
  c.pid = (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  clients.push(c);
  return c;
}
const rollbackQuiet = async (c) => { try { await c.query('ROLLBACK'); } catch (_) { /* not in a txn */ } };

// Resolve to 'pending' if the promise has not settled within ms, else 'resolved' / 'rejected'.
async function settledWithin(p, ms) {
  return Promise.race([
    p.then(() => 'resolved', () => 'rejected'),
    sleep(ms).then(() => 'pending'),
  ]);
}
// Swallow a rejection so an intentionally-failing promise never becomes an unhandled rejection.
const capture = (p) => p.then(r => ({ ok: true, r }), e => ({ ok: false, e }));

async function waitEvent(ctl, pid) {
  const r = await ctl.query('SELECT wait_event_type, wait_event, state FROM pg_stat_activity WHERE pid = $1', [pid]);
  return r.rows[0] || null;
}
// Poll until the backend `pid` is waiting on a lock (optionally a specific wait_event), or give up.
async function waitUntilBlocked(ctl, pid, want = null, timeoutMs = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const w = await waitEvent(ctl, pid);
    if (w && w.wait_event_type === 'Lock' && (!want || w.wait_event === want)) return w;
    await sleep(50);
  }
  return await waitEvent(ctl, pid);
}

// ---------------------------------------------------------------------------
// Fixtures (direct SQL; shape mirrors tests/capacity_guard.test.mjs)
// ---------------------------------------------------------------------------
const fx = { retailers: [], venues: [] };
async function mkRetailer(c) {
  const r = await c.query(
    `INSERT INTO retailers (slug, name, billing_email, billing_tier, billing_status)
     VALUES ($1, 'Capacity Serialization Fixture', $2, 'pro', 'active') RETURNING id`,
    [uniq('capser'), uniq('capser') + '@fixture.test']);
  fx.retailers.push(r.rows[0].id);
  return r.rows[0].id;
}
async function mkVenue(c, rid, cap) {
  const r = await c.query(
    `INSERT INTO venues (retailer_id, name, address, demo_fee, max_demos_per_slot)
     VALUES ($1, 'Main', '1 Serial St', 30, $2) RETURNING id`, [rid, cap]);
  fx.venues.push(r.rows[0].id);
  return r.rows[0].id;
}
// A live 24h HOLD — the state the bug report names. Bookings only REQUIRES retailer_id (NOT NULL);
// venue_id/demo_date/demo_time are what the capacity triggers key on; the rest is realistic filler.
const INSERT_BOOKING = `
  INSERT INTO bookings (retailer_id, venue_id, brand_name, contact_name, contact_email,
                        demo_date, demo_time, status, payment_status, held_expires_at)
  VALUES ($1, $2, 'Serial Brand', 'S', 's@fixture.test', $3, $4, $5, 'unpaid', now() + interval '24 hours')
  RETURNING id`;
const insertBooking = (c, rid, vid, d, t, status = 'held') => c.query(INSERT_BOOKING, [rid, vid, d, t, status]);

const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 40 + n); return d.toISOString().slice(0, 10); };

const ACTIVE = `coalesce(status,'pending') NOT IN ('cancelled','declined','expired','auth_canceled')`;
async function activeCount(c, vid, d, t) {
  const r = await c.query(`SELECT count(*)::int AS n FROM bookings WHERE venue_id = $1 AND demo_date = $2 AND demo_time = $3 AND ${ACTIVE}`, [vid, d, t]);
  return r.rows[0].n;
}
async function readCap(c, vid) {
  const r = await c.query('SELECT max_demos_per_slot FROM venues WHERE id = $1', [vid]);
  return r.rows[0] ? r.rows[0].max_demos_per_slot : null;
}
async function violations(c, vid) {
  const r = await c.query('SELECT * FROM capacity_invariant_violations($1, true)', [vid]);
  return r.rows;
}
async function assertNoViolations(label, c, vid) {
  const v = await violations(c, vid);
  ok(`${label}: capacity_invariant_violations() returns zero rows`, v.length === 0, JSON.stringify(v).slice(0, 200));
}
// Identical key expression to 0047/0066/0069/0070.
const SLOT_LOCK = `SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text || '|' || coalesce($2::date::text,'') || '|' || coalesce($3::text,''), 0))`;

// =====================================================================
async function main() {
  const ctl = await connect('ctl');

  console.log('\n— PREFLIGHT: migration 0070 is applied —');
  const defIns = (await ctl.query(`SELECT pg_get_functiondef('enforce_slot_capacity'::regproc) AS d`)).rows[0].d;
  const defMove = (await ctl.query(`SELECT pg_get_functiondef('enforce_slot_capacity_on_move'::regproc) AS d`)).rows[0].d;
  const hasCheck = (await ctl.query(`SELECT convalidated FROM pg_constraint WHERE conname = 'venues_max_demos_per_slot_min' AND conrelid = 'public.venues'::regclass`)).rows[0];
  const moveCols = (await ctl.query(`
    SELECT string_agg(a.attname, ',' ORDER BY a.attname) AS cols
      FROM pg_trigger t JOIN unnest(t.tgattr::int2[]) AS u(attnum) ON true
      JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = u.attnum
     WHERE t.tgname = 'trg_enforce_slot_capacity_move' AND t.tgrelid = 'public.bookings'::regclass AND NOT t.tgisinternal`)).rows[0].cols;
  const applied = /FOR SHARE/i.test(defIns) && /FOR SHARE/i.test(defMove) && /reactivated/i.test(defMove)
    && hasCheck && hasCheck.convalidated === true && moveCols === 'demo_date,demo_time,status,venue_id';
  ok('0070 applied: FOR SHARE in both booking triggers, reactivation re-check, move trigger fires on status, CHECK validated', applied,
     applied ? '' : `\n       >>> 0070 has NOT been applied to staging (supabase/migrations/0070_capacity_serialization.sql). ` +
       `insert FOR SHARE=${/FOR SHARE/i.test(defIns)} move FOR SHARE=${/FOR SHARE/i.test(defMove)} reactivation=${/reactivated/i.test(defMove)} ` +
       `check=${JSON.stringify(hasCheck)} moveCols=${moveCols}`);
  if (!applied) return;   // the scenarios below would only produce a pile of confusing failures

  const c0 = await connect('c0'), c1 = await connect('c1'), c2 = await connect('c2'), c3 = await connect('c3');

  // ===================================================================
  console.log('\n— SCENARIO 1 (Codex interleaving): inserts parked on the slot lock; decrease must WAIT, then be REFUSED —');
  {
    const rid = await mkRetailer(ctl); const vid = await mkVenue(ctl, rid, 2);
    const d = day(1), t = '10:00';

    await c0.query('BEGIN');
    await c0.query(SLOT_LOCK, [vid, d, t]);                       // conn0 holds the per-slot advisory lock

    await c1.query('BEGIN'); await c2.query('BEGIN');
    const ins1 = capture(insertBooking(c1, rid, vid, d, t));     // both take FOR SHARE on the venue row,
    const ins2 = capture(insertBooking(c2, rid, vid, d, t));     // then block on the advisory lock
    const w1 = await waitUntilBlocked(ctl, c1.pid, 'advisory');
    const w2 = await waitUntilBlocked(ctl, c2.pid, 'advisory');
    ok('S1: both inserts are parked on the slot advisory lock (FOR SHARE already taken)',
       w1 && w1.wait_event === 'advisory' && w2 && w2.wait_event === 'advisory', JSON.stringify({ w1, w2 }));
    await sleep(300);

    await c3.query('BEGIN');
    const dec = capture(c3.query('UPDATE venues SET max_demos_per_slot = 1 WHERE id = $1', [vid]));
    const decState = await settledWithin(dec, 1500);
    ok('S1: the cap decrease does NOT complete while inserts hold FOR SHARE on the venue row (blocked >= 1500ms)',
       decState === 'pending', `decrease promise ${decState}`);
    const w3 = await waitEvent(ctl, c3.pid);
    ok('S1: pg_stat_activity shows the decrease waiting on a Lock', w3 && w3.wait_event_type === 'Lock', JSON.stringify(w3));

    await c0.query('COMMIT');                                    // release the slot lock
    // Same-slot inserts serialize on the TRANSACTION-scoped advisory lock (0047/0066 by design): insert 2
    // cannot finish its statement until connection 1 COMMITs. So commit in order — and at every step the
    // decrease must remain blocked, because whichever insert is still open holds FOR SHARE on the venue.
    // Postgres grants the released advisory lock to EITHER waiter, so commit whichever insert wins first.
    const first = await Promise.race([
      ins1.then(r => ({ who: 'insert 1', r, conn: c1, other: { ins: ins2, conn: c2, who: 'insert 2' } })),
      ins2.then(r => ({ who: 'insert 2', r, conn: c2, other: { ins: ins1, conn: c1, who: 'insert 1' } })),
    ]);
    ok(`S1: first insert to win the slot lock (${first.who}) succeeds under cap 2 (the cap it read under FOR SHARE is still 2)`,
       first.r.ok, first.r.ok ? 'ok' : errText(first.r.e));
    let stillPending = await settledWithin(dec, 500);
    ok('S1: decrease is STILL blocked while both insert transactions are open', stillPending === 'pending', `decrease promise ${stillPending}`);
    await first.conn.query('COMMIT');                            // hands the slot lock to the other insert
    const second = await first.other.ins;
    ok(`S1: ${first.other.who} then succeeds under cap 2 (count 1 < cap 2; still the pre-decrease cap)`,
       second.ok, second.ok ? 'ok' : errText(second.e));
    stillPending = await settledWithin(dec, 500);
    ok('S1: decrease is STILL blocked while the second insert is open (its FOR SHARE alone holds it)', stillPending === 'pending', `decrease promise ${stillPending}`);
    await first.other.conn.query('COMMIT');

    const decRes = await Promise.race([dec, sleep(15000).then(() => ({ ok: false, e: new Error('decrease did not settle within 15s') }))]);
    ok('S1: once the inserts commit, the decrease FAILS with capacity_below_active_reservations',
       !decRes.ok && decRes.e && decRes.e.code === '23514' && /capacity_below_active_reservations/.test(decRes.e.message),
       decRes.ok ? 'decrease SUCCEEDED (cap 1 with 2 reservations = the Codex defect)' : errText(decRes.e));
    await rollbackQuiet(c3);

    const cap = await readCap(ctl, vid), n = await activeCount(ctl, vid, d, t);
    ok('S1: final state is cap 2 / active 2 — never cap 1 / active 2', cap === 2 && n === 2, `cap ${cap} active ${n}`);
    await assertNoViolations('S1', ctl, vid);
  }

  // ===================================================================
  console.log('\n— SCENARIO 2 (inverse order): decrease in flight; insert must WAIT and then read the NEW cap —');
  {
    const rid = await mkRetailer(ctl); const vid = await mkVenue(ctl, rid, 2);
    const d = day(2), t = '11:00';

    await c3.query('BEGIN');
    await c3.query('UPDATE venues SET max_demos_per_slot = 1 WHERE id = $1', [vid]);   // empty venue: guard passes, row lock held

    await c1.query('BEGIN');
    const ins1 = capture(insertBooking(c1, rid, vid, d, t));
    const insState = await settledWithin(ins1, 1000);
    ok('S2: the insert does NOT complete while the decrease holds the venue row (blocked >= 1000ms)', insState === 'pending', `insert promise ${insState}`);
    const w1 = await waitEvent(ctl, c1.pid);
    ok('S2: pg_stat_activity shows the insert waiting on a Lock (FOR SHARE vs the UPDATE)', w1 && w1.wait_event_type === 'Lock', JSON.stringify(w1));

    await c3.query('COMMIT');
    const r1 = await ins1;
    ok('S2: after the decrease commits, the waiting insert is admitted (reads cap 1, count 0)', r1.ok, r1.ok ? '' : errText(r1.e));
    await c1.query('COMMIT');

    const r2 = await capture(insertBooking(c2, rid, vid, d, t));
    ok('S2: a second insert is refused with slot_full under the new cap', !r2.ok && r2.e.code === '23514' && /slot_full/.test(r2.e.message),
       r2.ok ? 'second insert SUCCEEDED' : errText(r2.e));

    const cap = await readCap(ctl, vid), n = await activeCount(ctl, vid, d, t);
    ok('S2: final state is cap 1 / active 1', cap === 1 && n === 1, `cap ${cap} active ${n}`);
    await assertNoViolations('S2', ctl, vid);
  }

  // ===================================================================
  console.log('\n— SCENARIO 3 (reactivation): a cancelled booking cannot be revived into a full slot —');
  {
    const rid = await mkRetailer(ctl); const vid = await mkVenue(ctl, rid, 1);
    const d = day(3), t = '12:00';
    // Order matters: the INSERT trigger counts the slot regardless of NEW.status, so the cancelled
    // row goes in first (count 0 < 1), then the live hold (cancelled is excluded, so count 0 < 1).
    const dead = (await insertBooking(ctl, rid, vid, d, t, 'cancelled')).rows[0].id;
    const live = (await insertBooking(ctl, rid, vid, d, t, 'held')).rows[0].id;

    for (const target of ['pending', 'confirmed']) {
      const r = await capture(ctl.query('UPDATE bookings SET status = $2 WHERE id = $1', [dead, target]));
      ok(`S3: cancelled -> ${target} on a full slot is refused with slot_full`,
         !r.ok && r.e.code === '23514' && /slot_full/.test(r.e.message), r.ok ? 'reactivation SUCCEEDED' : errText(r.e));
    }
    const still = (await ctl.query('SELECT status FROM bookings WHERE id = $1', [dead])).rows[0].status;
    ok('S3: the cancelled row is unchanged after the refused reactivation', still === 'cancelled', `status ${still}`);

    // An active -> active flip never consumes capacity and must pass even at a full slot.
    const flip = await capture(ctl.query(`UPDATE bookings SET status = 'confirmed' WHERE id = $1`, [live]));
    ok('S3: held -> confirmed on the live booking passes (active -> active is not a capacity event)', flip.ok, flip.ok ? '' : errText(flip.e));

    // Free the slot, then the revival succeeds.
    const cancel = await capture(ctl.query(`UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [live]));
    ok('S3: cancelling the live booking passes', cancel.ok, cancel.ok ? '' : errText(cancel.e));
    const revive = await capture(ctl.query(`UPDATE bookings SET status = 'pending' WHERE id = $1`, [dead]));
    ok('S3: reactivation succeeds once the slot has room', revive.ok, revive.ok ? '' : errText(revive.e));
    // ...and the one we just cancelled now cannot come back.
    const again = await capture(ctl.query(`UPDATE bookings SET status = 'held' WHERE id = $1`, [live]));
    ok('S3: reviving the other booking is now refused (slot full again)', !again.ok && again.e.code === '23514', again.ok ? 'SUCCEEDED' : errText(again.e));

    const n = await activeCount(ctl, vid, d, t);
    ok('S3: exactly one active reservation on the slot', n === 1, `active ${n}`);
    await assertNoViolations('S3', ctl, vid);
  }

  // ===================================================================
  console.log('\n— SCENARIO 4 (stress): 100 x { 3 concurrent inserts + 1 concurrent decrease } —');
  {
    const RUNS = 100;
    const rid = await mkRetailer(ctl);   // 'pro' allows 999 venues (0052); each run gets a fresh venue/slot
    const t = '09:00';
    let violationsFound = 0, overCap = 0, deadlocks = 0, unexpected = [];
    const jitter = () => sleep(Math.floor(Math.random() * 15));
    for (let i = 0; i < RUNS; i++) {
      const vid = await mkVenue(ctl, rid, 2);
      const d = day(10 + (i % 30));
      const ops = [
        jitter().then(() => insertBooking(c0, rid, vid, d, t)),
        jitter().then(() => insertBooking(c1, rid, vid, d, t)),
        jitter().then(() => insertBooking(c2, rid, vid, d, t)),
        jitter().then(() => c3.query('UPDATE venues SET max_demos_per_slot = 1 WHERE id = $1', [vid])),
      ];
      const res = await Promise.all(ops.map(capture));
      for (const r of res) {
        if (r.ok) continue;
        if (r.e.code === '40P01') deadlocks++;
        else if (r.e.code !== '23514') unexpected.push(errText(r.e));
      }
      const cap = await readCap(ctl, vid), n = await activeCount(ctl, vid, d, t);
      if (n > cap) { overCap++; console.log(`  x run ${i}: cap ${cap} active ${n}`); }
      const v = await violations(ctl, vid);
      if (v.length) violationsFound++;
    }
    console.log(`  stress: ${RUNS} runs, ${violationsFound} violations`);
    ok(`S4: active_count <= cap after every run (${RUNS} runs)`, overCap === 0, `${overCap} run(s) over capacity`);
    ok('S4: capacity_invariant_violations() empty after every run', violationsFound === 0, `${violationsFound} run(s) in violation`);
    ok('S4: no deadlocks (lock order venue row -> slot lock is consistent across paths)', deadlocks === 0, `${deadlocks} deadlock(s)`);
    ok('S4: every failure is a 23514 business refusal (slot_full / capacity_below_active_reservations)', unexpected.length === 0,
       unexpected.slice(0, 3).join(' | '));
  }

  // ===================================================================
  console.log('\n— SCENARIO 5: CHECK constraint max_demos_per_slot >= 1 —');
  {
    const rid = await mkRetailer(ctl); const vid = await mkVenue(ctl, rid, 2);   // EMPTY venue: the guard passes, the CHECK must catch it
    const zero = await capture(ctl.query('UPDATE venues SET max_demos_per_slot = 0 WHERE id = $1', [vid]));
    ok('S5: cap 0 is refused by the CHECK constraint (23514 venues_max_demos_per_slot_min)',
       !zero.ok && zero.e.code === '23514' && zero.e.constraint === 'venues_max_demos_per_slot_min', zero.ok ? 'SUCCEEDED' : errText(zero.e));
    const neg = await capture(ctl.query('UPDATE venues SET max_demos_per_slot = -3 WHERE id = $1', [vid]));
    ok('S5: negative cap is refused (23514)', !neg.ok && neg.e.code === '23514', neg.ok ? 'SUCCEEDED' : errText(neg.e));
    const nul = await capture(ctl.query('UPDATE venues SET max_demos_per_slot = NULL WHERE id = $1', [vid]));
    ok('S5: NULL cap is refused by NOT NULL (23502)', !nul.ok && nul.e.code === '23502', nul.ok ? 'SUCCEEDED' : errText(nul.e));
    const ins0 = await capture(ctl.query(`INSERT INTO venues (retailer_id, name, max_demos_per_slot) VALUES ($1, 'Zero', 0) RETURNING id`, [rid]));
    if (ins0.ok) fx.venues.push(ins0.r.rows[0].id);
    ok('S5: inserting a venue with cap 0 is refused (23514)', !ins0.ok && ins0.e.code === '23514', ins0.ok ? 'SUCCEEDED' : errText(ins0.e));
    const cap = await readCap(ctl, vid);
    ok('S5: cap remains 2 after the refused updates', cap === 2, `cap ${cap}`);
  }
}

// =====================================================================
try {
  await main();
} catch (e) {
  ok('suite ran to completion without an unexpected error', false, errText(e));
} finally {
  console.log('\n— teardown —');
  try {
    for (const c of clients) await rollbackQuiet(c);
    const ctl = clients[0];
    if (ctl) {
      if (fx.venues.length) await ctl.query('DELETE FROM bookings WHERE venue_id = ANY($1::uuid[])', [fx.venues]);
      if (fx.venues.length) await ctl.query('DELETE FROM venues WHERE id = ANY($1::uuid[])', [fx.venues]);
      if (fx.retailers.length) await ctl.query('DELETE FROM retailers WHERE id = ANY($1::uuid[])', [fx.retailers]);
      const b = fx.venues.length ? (await ctl.query('SELECT count(*)::int AS n FROM bookings WHERE venue_id = ANY($1::uuid[])', [fx.venues])).rows[0].n : 0;
      const v = fx.venues.length ? (await ctl.query('SELECT count(*)::int AS n FROM venues WHERE id = ANY($1::uuid[])', [fx.venues])).rows[0].n : 0;
      const r = fx.retailers.length ? (await ctl.query('SELECT count(*)::int AS n FROM retailers WHERE id = ANY($1::uuid[])', [fx.retailers])).rows[0].n : 0;
      ok(`teardown: every booking on the ${fx.venues.length} fixture venue(s) is gone`, b === 0, `${b} left`);
      ok('teardown: every fixture venue is gone', v === 0, `${v} left`);
      ok(`teardown: every fixture retailer is gone (${fx.retailers.length})`, r === 0, `${r} left`);
    } else {
      ok('teardown: control connection was established', false, 'nothing to clean up because nothing connected');
    }
  } catch (e) {
    ok('teardown completed', false, errText(e));
  }
  for (const c of clients) { try { await c.end(); } catch (_) { /* already closed */ } }
  clearTimeout(watchdog);
}

process.exit(summary('capacity serialization') ? 0 : 1);
