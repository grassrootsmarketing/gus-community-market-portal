// tests/cron_heartbeats.test.mjs — Phase E: every critical scheduled worker is observable.
//
// The public status route used to read the single most recent cron_heartbeat row of ANY job and
// call "<25h old" healthy. Only the daily brand-account cron wrote heartbeats, so a dead 15-minute
// worker (refund-worker, provisional-sweep) was masked by the daily job. This file proves, through
// the ACTUAL route handlers against real staging (tests/_route.mjs; Stripe/Resend spied):
//
//   1. the workers still refuse a missing/wrong CRON_SECRET with 401 and write NO heartbeat;
//   2. a successful run appends ONE {cron_name, outcome:'succeeded'} row; a second run appends a
//      second row (append-only, idempotent job);
//   3. a failing run appends a SEPARATE 'failed' row and leaves the earlier successes untouched;
//   3b. (Codex F-03) a per-item failure AFTER work is claimed — a Stripe refund submit that fails, one
//      bad item among good ones, a fulfilment-drain error — never yields 'succeeded': the worker
//      writes 'failed' (summary.partial=true, counts, first error, no secrets) and answers 500; a
//      later clean run recovers the job to ok:true. Real refund work is seeded on staging for this.
//   4. the status action judges each job by its OWN LATEST COMPLETED row: fresh success -> ok, stale
//      (2h) -> not ok, missing -> not ok, a later 'failed' row after a fresh success -> NOT ok until
//      a later 'succeeded' recovers it; 'started' rows are ignored; the public payload stays coarse
//      ({ok, required} per job — no ages/outcomes/summaries);
//   5. provisional-sweep is required:false / ok:true while holds are OFF (default), and
//      required:true (missing -> not ok, fresh -> ok) when PROVISIONAL_HOLDS_ENABLED=true; in that
//      child a per-booking expiry failure makes the sweep run 'failed' (500) and the job unhealthy.
//
// api/_flags.js reads env ONCE at module load and is imported by find-retailer.js with a plain
// specifier, so within one process the harness's cache-busting re-import of the route does NOT
// re-evaluate the flag. Case 5's holds-ON half therefore runs in a CHILD process of this same file
// (`--holds-on`), which sets the flag on the harness ENV before the first route import.
//
// Run from the repository root with staging creds:  node tests/cron_heartbeats.test.mjs
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ENV, installSpy, callRoute, req, ok, summary, uniq } from './_route.mjs';

// Capture BEFORE any callRoute: the harness replaces process.env wholesale on every call.
const ORIG_ENV = { ...process.env };
const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
const HOLDS_ON = process.argv.includes('--holds-on');

const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  return { ok: r.ok, status: r.status, body: j };
};

const MARK = uniq('hb');                       // every row THIS process inserts directly carries it
const CRON = { authorization: 'Bearer ' + ENV.CRON_SECRET };
const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
const WORKERS = 'in.(refund-worker,provisional-sweep)';

async function hbInsert(cron_name, outcome, { ranAt = null, extra = {} } = {}) {
  const row = { cron_name, outcome, duration_ms: 1, summary: { marker: MARK, ...extra } };
  if (ranAt) row.ran_at = ranAt;
  const r = await db('cron_heartbeat', { method: 'POST', body: JSON.stringify(row) });
  if (!r.ok) throw new Error(`heartbeat fixture insert failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body && r.body[0];
}
const hbRows = async (filter) => (await db(`cron_heartbeat?${filter}&select=id,cron_name,ran_at,outcome,duration_ms,summary&order=ran_at.asc`)).body || [];
const cleanupMarked = () => db(`cron_heartbeat?summary->>marker=eq.${encodeURIComponent(MARK)}`, { method: 'DELETE' });
// The "missing" scenarios need NO fresh success for a worker. Staging runs no crons (Vercel crons fire
// on production only), so any recent worker rows there are leftovers from a test run like this one.
const clearRecentWorkerRows = () => db(`cron_heartbeat?cron_name=${WORKERS}&ran_at=gte.${encodeURIComponent(minutesAgo(40))}`, { method: 'DELETE' });

const status = async () => {
  const r = await callRoute('find-retailer.js', req({ body: { action: 'status' } }));
  return { res: r, cron: (r.body && r.body.checks && r.body.checks.cron) || {}, jobs: (r.body && r.body.checks && r.body.checks.cron && r.body.checks.cron.jobs) || {} };
};
const publicShapeOk = (res) => {
  const s = JSON.stringify(res.body || {});
  return !/age_minutes|last_outcome|last_success|duration_ms|summary|hours_since|first_error|partial|errors":\s*\d/.test(s);
};
const onlyOkRequired = (jobs) => Object.values(jobs).every(j => Object.keys(j).sort().join(',') === 'ok,required');

// ---------------------------------------------------------------------------
// Real work fixtures (F-03). The ledger fixtures are the ones payment_ledger_adversarial.mjs pins
// (tests/_seed_ledger_fixtures.mjs): keeps-all retailer test-a, venue "A - Main" at $30, brand1.
// The harness's Stripe spy answers every refund POST with a $30.00 succeeded refund, which is
// exactly the allocation these fixtures produce — so a clean item really reaches apply_refund_event.
// ---------------------------------------------------------------------------
const FX = { RETAILER: '8cf80c18-ff37-4c32-8154-dcdd90486942', VENUE: '35301125-8921-4bb2-a7d5-aac777e2e76e', BRAND: '7f044529-1aba-417a-9b39-ea55f846d06d' };
const created = { bookings: [], groups: [] };
const rpc = (fn, args) => db(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });
const one = (j) => (Array.isArray(j) ? j[0] : j);
let seedN = 0; const DAY0 = Math.floor(Math.random() * 280); const MIN0 = Math.floor(Math.random() * 50);
function uniqueSlot() { const d = new Date(Date.UTC(2026, 11, 1)); d.setUTCDate(d.getUTCDate() + DAY0 + seedN); seedN++; return d.toISOString().slice(0, 10); }
function uniqueTime() { return `${8 + (seedN % 10)}:${String((MIN0 + seedN) % 60).padStart(2, '0')}`; }

// The pinned fixtures are created by tests/_seed_ledger_fixtures.mjs (idempotent upsert on primary key).
// In CI the clean build resets the database and test:routes runs BEFORE test:ledger, so on a fresh
// database they do not exist yet — seed them here rather than depend on suite ordering.
// Captured at import time: callRoute() swaps process.env for the harness ENV, so a child spawned later
// must be handed the real database credentials explicitly.
const SEED_ENV = { PATH: process.env.PATH, SB_URL: process.env.SB_URL, SB_KEY: process.env.SB_KEY, SB_REF: process.env.SB_REF };
let fixturesEnsured = false;
async function ensureLedgerFixtures() {
  if (fixturesEnsured) return;
  fixturesEnsured = true;
  const r = await db(`retailers?id=eq.${FX.RETAILER}&select=id`);
  if (r.ok && Array.isArray(r.body) && r.body.length) return;
  const seed = fileURLToPath(new URL('./_seed_ledger_fixtures.mjs', import.meta.url));
  const res = spawnSync(process.execPath, [seed], { encoding: 'utf8', env: SEED_ENV });
  if (res.status !== 0) throw new Error(`ledger fixture seed failed (exit ${res.status}): ${String(res.stderr || res.stdout || '').slice(-400)}`);
  const again = await db(`retailers?id=eq.${FX.RETAILER}&select=id`);
  if (!(again.ok && Array.isArray(again.body) && again.body.length)) throw new Error('ledger fixtures still missing after seeding');
}

async function seedBooking(fields) {
  await ensureLedgerFixtures();
  const r = await db('bookings', { method: 'POST', body: JSON.stringify({
    retailer_id: FX.RETAILER, venue_id: FX.VENUE, brand_id: FX.BRAND, brand_name: 'Heartbeat ' + MARK,
    contact_name: 'Heartbeat Tester', contact_email: `${MARK}@fixture.test`,
    demo_date: uniqueSlot(), demo_time: uniqueTime(), ...fields,
  }) });
  const b = one(r.body);
  if (!r.ok || !b || !b.id) throw new Error(`seedBooking failed: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  created.bookings.push(b.id);
  return b;
}
// A PAID booking with a reserved refund request that claim_refund_work will lease on the next run
// (status 'reserved', next_attempt_at = now). The fulfilment outbox row is completed directly so the
// worker's drain has no unrelated work.
async function seedRefundWork(tag) {
  const b = await seedBooking({ status: 'pending_payment', payment_status: 'unpaid' });
  const c = one((await rpc('checkout_claim_group', { p_brand_id: FX.BRAND, p_retailer_id: FX.RETAILER, p_booking_ids: [b.id], p_platform_keeps_all: true, p_connect_account_id: null, p_platform_fee_cents: 0 })).body);
  if (!c || !c.payment_group_id) throw new Error('checkout_claim_group failed: ' + JSON.stringify(c));
  created.groups.push(c.payment_group_id);
  const sess = `cs_${MARK}_${tag}`, pi = `pi_${MARK}_${tag}`, ch = `ch_${MARK}_${tag}`;
  await rpc('register_payment_attempt', { p_group_id: c.payment_group_id, p_session_id: sess, p_payment_intent: pi, p_hash: 'h-' + tag, p_schema: 1 });
  const paid = one((await rpc('apply_verified_payment', { p_session_id: sess, p_payment_intent: pi, p_charge: ch, p_amount: c.total_customer_amount, p_currency: 'usd', p_connect_dest: null, p_on_behalf_of: null, p_application_fee: null, p_transfer_id: null, p_fee_id: null })).body);
  if (!paid || paid.outcome !== 'applied') throw new Error('apply_verified_payment failed: ' + JSON.stringify(paid));
  await db(`booking_fulfillments?booking_id=eq.${b.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done', completed_at: new Date().toISOString() }) });
  const rr = one((await rpc('refund_reserve_cas', { p_booking_id: b.id, p_op_key: b.id + ':cancel', p_actor: 'heartbeat-test', p_reason: 'f03' })).body);
  if (!rr || rr.outcome !== 'reserved' || !rr.refund_request_id) throw new Error('refund_reserve_cas failed: ' + JSON.stringify(rr));
  return { booking: b, group: c.payment_group_id, request_id: rr.refund_request_id, amount: rr.amount };
}
const requestStatus = async (id) => ((await db(`refund_requests?id=eq.${id}&select=status,attempts,last_error`)).body || [])[0] || null;
// FK-safe order, mirroring payment_ledger_adversarial.mjs's teardown.
async function teardownLedger() {
  for (const gid of [...new Set(created.groups)]) {
    const allocs = (await db(`payment_allocations?payment_group_id=eq.${gid}&select=id`)).body || [];
    for (const a of allocs) {
      const reqs = (await db(`refund_requests?payment_allocation_id=eq.${a.id}&select=id`)).body || [];
      for (const rq of reqs) await db(`reconciliation_cases?refund_request_id=eq.${rq.id}`, { method: 'DELETE' });
      await db(`refund_requests?payment_allocation_id=eq.${a.id}`, { method: 'DELETE' });
      await db(`refund_operations?payment_allocation_id=eq.${a.id}`, { method: 'DELETE' });
    }
    await db(`booking_fulfillments?payment_group_id=eq.${gid}`, { method: 'DELETE' });
    await db(`reconciliation_cases?payment_group_id=eq.${gid}`, { method: 'DELETE' });
    await db(`payment_attempts?payment_group_id=eq.${gid}`, { method: 'DELETE' });
    await db(`payment_allocations?payment_group_id=eq.${gid}`, { method: 'DELETE' });
    await db(`payment_groups?id=eq.${gid}`, { method: 'DELETE' });
  }
  for (const id of [...new Set(created.bookings)]) {
    await db(`booking_fulfillments?booking_id=eq.${id}`, { method: 'DELETE' });
    await db(`bookings?id=eq.${id}`, { method: 'DELETE' });
  }
}

const spy = installSpy();

// ===========================================================================
// CHILD MODE: provisional holds ON. Only the sweep-required assertions live here.
// ===========================================================================
if (HOLDS_ON) {
  ENV.PROVISIONAL_HOLDS_ENABLED = 'true';     // callRoute copies ENV into process.env before import
  console.log('\n— 5b (child, PROVISIONAL_HOLDS_ENABLED=true): provisional-sweep is REQUIRED —');
  try {
    await clearRecentWorkerRows();
    await hbInsert('daily', 'succeeded');
    await hbInsert('refund-worker', 'succeeded');

    let s = await status();
    ok('holds ON: status route answers 200', s.res.statusCode === 200, `${s.res.statusCode} ${JSON.stringify(s.res.body)}`);
    ok('holds ON: provisional-sweep is required', s.jobs['provisional-sweep'] && s.jobs['provisional-sweep'].required === true, JSON.stringify(s.jobs));
    ok('holds ON: MISSING sweep heartbeat -> sweep ok:false', s.jobs['provisional-sweep'] && s.jobs['provisional-sweep'].ok === false, JSON.stringify(s.jobs));
    ok('holds ON: missing required job -> overall cron ok:false', s.cron.ok === false, JSON.stringify(s.cron));
    ok('holds ON: status is not operational', s.res.body && s.res.body.status !== 'operational', JSON.stringify(s.res.body && s.res.body.status));

    await hbInsert('provisional-sweep', 'succeeded', { ranAt: minutesAgo(120) });
    s = await status();
    ok('holds ON: STALE (2h) sweep success -> sweep ok:false', s.jobs['provisional-sweep'] && s.jobs['provisional-sweep'].ok === false, JSON.stringify(s.jobs));

    await hbInsert('provisional-sweep', 'succeeded');
    s = await status();
    ok('holds ON: FRESH sweep success -> sweep ok:true', s.jobs['provisional-sweep'] && s.jobs['provisional-sweep'].ok === true, JSON.stringify(s.jobs));
    ok('holds ON: all required jobs fresh -> overall cron ok:true', s.cron.ok === true, JSON.stringify(s.cron));
    ok('holds ON: public payload stays coarse', publicShapeOk(s.res), JSON.stringify(s.res.body));

    // F-03: a per-booking expiry failure AFTER the scan. The sweep finds an expired unpaid hold and
    // its 'held -> expired' PATCH fails: the run must be 'failed' (500), the booking stays held for
    // the next tick, and the REQUIRED sweep goes unhealthy until a clean run recovers it.
    console.log('\n— 5c (child): per-booking sweep failure -> failed heartbeat, non-2xx, unhealthy until recovered —');
    const tSweep = new Date().toISOString();
    const held = await seedBooking({ status: 'held', payment_status: 'unpaid', held_expires_at: minutesAgo(30) });
    spy.faults.push({ url: `bookings?id=eq.${held.id}&status=eq.held`, method: 'PATCH', status: 500, message: 'injected_expiry_patch_fault' });
    const sf = await callRoute('provisional-sweep.js', req({ body: {}, headers: CRON }));
    spy.faults.length = 0;
    ok('holds ON: sweep whose per-booking expiry PATCH fails -> 500 partial_failure', sf.statusCode === 500 && sf.body && sf.body.ok === false && sf.body.errors >= 1 && sf.body.scanned >= 1, `${sf.statusCode} ${JSON.stringify(sf.body)}`);
    let srows = await hbRows(`cron_name=eq.provisional-sweep&ran_at=gte.${encodeURIComponent(tSweep)}`);
    let last = srows[srows.length - 1];
    ok("holds ON: heartbeat row is 'failed' with summary.partial=true and the injected error", !!last && last.outcome === 'failed' && last.summary && last.summary.partial === true && last.summary.errors >= 1 && /injected_expiry_patch_fault/.test(String(last.summary.first_error)), JSON.stringify(last));
    const stillHeld = ((await db(`bookings?id=eq.${held.id}&select=status`)).body || [])[0];
    ok('holds ON: the booking that errored is still held for the next tick', stillHeld && stillHeld.status === 'held', JSON.stringify(stillHeld));
    s = await status();
    ok('holds ON: failed sweep run -> sweep ok:false', s.jobs['provisional-sweep'] && s.jobs['provisional-sweep'].ok === false, JSON.stringify(s.jobs));
    ok('holds ON: failed required job -> overall cron ok:false', s.cron.ok === false, JSON.stringify(s.cron));
    ok('holds ON: public payload stays coarse after a failure', publicShapeOk(s.res) && onlyOkRequired(s.jobs), JSON.stringify(s.res.body));

    const sr = await callRoute('provisional-sweep.js', req({ body: {}, headers: CRON }));
    ok('holds ON: clean sweep run -> 200 ok, no errors, the hold expired', sr.statusCode === 200 && sr.body && sr.body.ok === true && sr.body.errors === 0 && sr.body.expired_unpaid >= 1, `${sr.statusCode} ${JSON.stringify(sr.body)}`);
    srows = await hbRows(`cron_name=eq.provisional-sweep&ran_at=gte.${encodeURIComponent(tSweep)}`);
    ok("holds ON: sweep rows since the failure are [failed, succeeded]", srows.map(r => r.outcome).join(',') === 'failed,succeeded', srows.map(r => r.outcome).join(','));
    const nowExpired = ((await db(`bookings?id=eq.${held.id}&select=status`)).body || [])[0];
    ok('holds ON: booking is expired after the clean run', nowExpired && nowExpired.status === 'expired', JSON.stringify(nowExpired));
    s = await status();
    ok('holds ON: recovery -> sweep ok:true again', s.jobs['provisional-sweep'] && s.jobs['provisional-sweep'].ok === true, JSON.stringify(s.jobs));
    ok('holds ON: recovery -> overall cron ok:true', s.cron.ok === true, JSON.stringify(s.cron));
  } finally {
    await cleanupMarked();
    await teardownLedger();
    spy.restore();
  }
  process.exit(summary('cron heartbeats (holds ON child)') ? 0 : 1);
}

// ===========================================================================
// PARENT MODE: holds OFF (harness default — PROVISIONAL_HOLDS_ENABLED is absent from ENV).
// ===========================================================================
const startIso = new Date().toISOString();
const rowsSinceStart = (name) => hbRows(`cron_name=eq.${name}&ran_at=gte.${encodeURIComponent(startIso)}`);

try {
  // -------------------------------------------------------------------------
  // 1. CRON_SECRET still gates both workers, and a refused call writes NOTHING.
  // -------------------------------------------------------------------------
  console.log('\n— 1: unauthenticated callers get 401 and trigger no work / no heartbeat —');
  for (const file of ['refund-worker.js', 'provisional-sweep.js']) {
    const sbBefore = spy.calls.supabase, stripeBefore = spy.calls.stripe.length;
    const none = await callRoute(file, req({ body: {} }));
    ok(`${file}: no Authorization header -> 401`, none.statusCode === 401 && none.body && none.body.error === 'unauthorized', `${none.statusCode} ${JSON.stringify(none.body)}`);
    const wrong = await callRoute(file, req({ body: {}, headers: { authorization: 'Bearer not-the-secret' } }));
    ok(`${file}: wrong secret -> 401`, wrong.statusCode === 401 && wrong.body && wrong.body.error === 'unauthorized', `${wrong.statusCode} ${JSON.stringify(wrong.body)}`);
    ok(`${file}: refused calls touched neither Supabase nor Stripe`, spy.calls.supabase === sbBefore && spy.calls.stripe.length === stripeBefore,
       `supabase +${spy.calls.supabase - sbBefore} stripe +${spy.calls.stripe.length - stripeBefore}`);
  }
  ok('no heartbeat row was written by refused calls (refund-worker)', (await rowsSinceStart('refund-worker')).length === 0);
  ok('no heartbeat row was written by refused calls (provisional-sweep)', (await rowsSinceStart('provisional-sweep')).length === 0);

  // -------------------------------------------------------------------------
  // 2. A successful run appends ONE 'succeeded' row; a second run appends a second.
  // -------------------------------------------------------------------------
  console.log('\n— 2: authenticated runs append one succeeded heartbeat each —');
  {
    const r1 = await callRoute('refund-worker.js', req({ body: {}, headers: CRON }));
    ok('refund-worker with the secret -> 200 ok', r1.statusCode === 200 && r1.body && r1.body.ok === true, `${r1.statusCode} ${JSON.stringify(r1.body)}`);
    let rows = await rowsSinceStart('refund-worker');
    ok('exactly one refund-worker heartbeat row exists', rows.length === 1, `${rows.length}`);
    ok('row is cron_name=refund-worker outcome=succeeded', rows[0] && rows[0].cron_name === 'refund-worker' && rows[0].outcome === 'succeeded', JSON.stringify(rows[0]));
    ok('row carries duration_ms and the run summary', rows[0] && Number.isInteger(rows[0].duration_ms) && rows[0].summary && typeof rows[0].summary.claimed === 'number' && rows[0].summary.ok === true, JSON.stringify(rows[0] && rows[0].summary));

    const r2 = await callRoute('refund-worker.js', req({ body: {}, headers: CRON }));
    ok('second refund-worker run -> 200', r2.statusCode === 200, `${r2.statusCode}`);
    rows = await rowsSinceStart('refund-worker');
    ok('second run APPENDED a second succeeded row (append-only)', rows.length === 2 && rows.every(r => r.outcome === 'succeeded'), JSON.stringify(rows.map(r => r.outcome)));

    const s1 = await callRoute('provisional-sweep.js', req({ body: {}, headers: CRON }));
    ok('provisional-sweep with the secret -> 200 ok', s1.statusCode === 200 && s1.body && s1.body.ok === true, `${s1.statusCode} ${JSON.stringify(s1.body)}`);
    const srows = await rowsSinceStart('provisional-sweep');
    ok('provisional-sweep wrote one succeeded heartbeat', srows.length === 1 && srows[0].outcome === 'succeeded' && typeof srows[0].summary?.scanned === 'number', JSON.stringify(srows));
  }

  // -------------------------------------------------------------------------
  // 3. A failing run appends a SEPARATE 'failed' row; earlier successes are untouched.
  // -------------------------------------------------------------------------
  console.log('\n— 3: a failed run appends a failed row and never rewrites the last success —');
  {
    spy.faults.push({ url: 'rpc/claim_refund_work', method: 'POST', status: 500, message: 'injected_claim_fault' });
    const rf = await callRoute('refund-worker.js', req({ body: {}, headers: CRON }));
    spy.faults.length = 0;
    ok('refund-worker with a failing claim -> 500 worker_error', rf.statusCode === 500 && rf.body && rf.body.ok === false, `${rf.statusCode} ${JSON.stringify(rf.body)}`);
    const rows = await rowsSinceStart('refund-worker');
    ok('refund-worker rows are [succeeded, succeeded, failed]', rows.map(r => r.outcome).join(',') === 'succeeded,succeeded,failed', rows.map(r => r.outcome).join(','));
    const failed = rows[rows.length - 1];
    ok('failed row records the error in summary', failed && failed.outcome === 'failed' && /injected_claim_fault/.test(String(failed.summary && failed.summary.error)), JSON.stringify(failed && failed.summary));

    spy.faults.push({ url: 'bookings?status=eq.held', method: 'GET', status: 500, message: 'injected_sweep_fault' });
    const sf = await callRoute('provisional-sweep.js', req({ body: {}, headers: CRON }));
    spy.faults.length = 0;
    ok('provisional-sweep with a failing scan -> 500', sf.statusCode === 500 && sf.body && sf.body.ok === false, `${sf.statusCode} ${JSON.stringify(sf.body)}`);
    const srows = await rowsSinceStart('provisional-sweep');
    ok('provisional-sweep rows are [succeeded, failed]', srows.map(r => r.outcome).join(',') === 'succeeded,failed', srows.map(r => r.outcome).join(','));
  }

  // -------------------------------------------------------------------------
  // 3b. Codex F-03: failures AFTER work is claimed never yield 'succeeded'. Real refund work is
  //     seeded (paid booking + reserved refund request) so claim_refund_work leases it and the
  //     worker actually submits to (the spied) Stripe.
  // -------------------------------------------------------------------------
  console.log('\n— 3b: per-item failures after claim -> failed heartbeat, 500, unhealthy until a clean run —');
  {
    const t0 = new Date().toISOString();
    const rowsSince = (name, iso) => hbRows(`cron_name=eq.${name}&ran_at=gte.${encodeURIComponent(iso)}`);
    const lastRow = async (name, iso) => { const r = await rowsSince(name, iso); return r[r.length - 1]; };
    const redacted = (summary) => { const s = JSON.stringify(summary || {}); return !/sk_test_harness|sk_live|whsec_|@fixture\.test/.test(s); };
    await hbInsert('daily', 'succeeded');   // a fresh daily so it cannot mask the worker's health

    // (a) claim succeeds, then the Stripe refund submit fails for the only item
    const w1 = await seedRefundWork('a');
    ok('seeded a reserved refund request of $30.00 (matches the spy refund)', w1.amount === 3000, String(w1.amount));
    const stripeBefore = spy.calls.stripe.length;
    spy.faults.push({ url: 'api.stripe.com/v1/refunds', method: 'POST', status: 402, message: 'injected_stripe_refund_fault' });
    const ra = await callRoute('refund-worker.js', req({ body: {}, headers: CRON }));
    spy.faults.length = 0;
    ok('worker claimed the item and submitted to Stripe', ra.body && ra.body.claimed >= 1 && spy.calls.stripe.slice(stripeBefore).some(c => /\/v1\/refunds$/.test(c.url) && c.method === 'POST'), JSON.stringify(ra.body));
    ok('Stripe submit failure after claim -> 500, ok:false, partial_failure, errors>=1', ra.statusCode === 500 && ra.body && ra.body.ok === false && ra.body.error === 'partial_failure' && ra.body.errors >= 1, `${ra.statusCode} ${JSON.stringify(ra.body)}`);
    let hb = await lastRow('refund-worker', t0);
    ok("heartbeat row is 'failed' (never 'succeeded') with summary.partial=true and counts", !!hb && hb.outcome === 'failed' && hb.summary && hb.summary.partial === true && hb.summary.ok === false && hb.summary.errors >= 1 && hb.summary.claimed >= 1, JSON.stringify(hb));
    ok('failed summary names the first error (Stripe submit) and is redacted', !!hb && /submit: injected_stripe_refund_fault/.test(String(hb.summary && hb.summary.first_error)) && redacted(hb.summary), JSON.stringify(hb && hb.summary));
    const st1 = await requestStatus(w1.request_id);
    ok('the request was released as failed_retryable (lease released, retry scheduled)', st1 && st1.status === 'failed_retryable' && /injected_stripe_refund_fault/.test(String(st1.last_error)), JSON.stringify(st1));
    let s = await status();
    ok('status: refund-worker ok:false after the failed run', s.jobs['refund-worker'] && s.jobs['refund-worker'].ok === false, JSON.stringify(s.jobs['refund-worker']));
    ok('status: overall cron ok:false', s.cron.ok === false, JSON.stringify(s.cron));
    ok('status: not operational', s.res.body && s.res.body.status !== 'operational', JSON.stringify(s.res.body && s.res.body.status));
    ok('status: public payload still only {ok, required} per job', publicShapeOk(s.res) && onlyOkRequired(s.jobs), JSON.stringify(s.res.body));

    // (b) one Stripe failure among otherwise successful items -> still never 'succeeded'
    await db(`refund_requests?id=eq.${w1.request_id}`, { method: 'PATCH', body: JSON.stringify({ next_attempt_at: minutesAgo(1) }) });
    const w2 = await seedRefundWork('b');
    const t1 = new Date().toISOString();
    spy.faults.push({ url: 'api.stripe.com/v1/refunds', method: 'POST', status: 402, message: 'injected_one_bad_item', once: true });
    const rb = await callRoute('refund-worker.js', req({ body: {}, headers: CRON }));
    spy.faults.length = 0;
    ok('two items claimed: one Stripe failure, one resubmitted + applied', rb.body && rb.body.claimed === 2 && rb.body.errors === 1 && rb.body.resubmitted === 1, JSON.stringify(rb.body));
    ok('one bad item among good ones -> 500, ok:false', rb.statusCode === 500 && rb.body && rb.body.ok === false, `${rb.statusCode}`);
    hb = await lastRow('refund-worker', t1);
    ok("heartbeat row is 'failed' with errors:1 and resubmitted:1", !!hb && hb.outcome === 'failed' && hb.summary && hb.summary.errors === 1 && hb.summary.resubmitted === 1 && hb.summary.partial === true, JSON.stringify(hb));
    const [st1b, st2b] = [await requestStatus(w1.request_id), await requestStatus(w2.request_id)];
    ok('DB truth: exactly one request succeeded and one is failed_retryable', [st1b, st2b].filter(x => x && x.status === 'succeeded').length === 1 && [st1b, st2b].filter(x => x && x.status === 'failed_retryable').length === 1, JSON.stringify([st1b, st2b]));

    // (c) fulfilment-drain error (the post-drain backlog read fails) -> failed, even with no refund work due
    const t2 = new Date().toISOString();
    spy.faults.push({ url: 'booking_fulfillments?status=eq.pending', method: 'GET', status: 500, message: 'injected_fulfilment_fault' });
    const rc = await callRoute('refund-worker.js', req({ body: {}, headers: CRON }));
    spy.faults.length = 0;
    ok('fulfilment drain error -> 500, ok:false, errors>=1', rc.statusCode === 500 && rc.body && rc.body.ok === false && rc.body.errors >= 1, `${rc.statusCode} ${JSON.stringify(rc.body)}`);
    hb = await lastRow('refund-worker', t2);
    ok("heartbeat row is 'failed' naming the fulfilment error", !!hb && hb.outcome === 'failed' && /fulfilment: .*injected_fulfilment_fault/.test(String(hb.summary && hb.summary.first_error)), JSON.stringify(hb && hb.summary));

    // (d) recovery: a clean run writes 'succeeded' and the job is healthy again
    const t3 = new Date().toISOString();
    const rd = await callRoute('refund-worker.js', req({ body: {}, headers: CRON }));
    ok('clean run -> 200 ok:true, errors:0', rd.statusCode === 200 && rd.body && rd.body.ok === true && rd.body.errors === 0, `${rd.statusCode} ${JSON.stringify(rd.body)}`);
    hb = await lastRow('refund-worker', t3);
    ok("heartbeat row is 'succeeded' again", !!hb && hb.outcome === 'succeeded', JSON.stringify(hb));
    s = await status();
    ok('status: refund-worker ok:true after recovery', s.jobs['refund-worker'] && s.jobs['refund-worker'].ok === true, JSON.stringify(s.jobs['refund-worker']));
    ok('status: overall cron ok:true after recovery', s.cron.ok === true, JSON.stringify(s.cron));
    ok('status: public payload still only {ok, required} per job', publicShapeOk(s.res) && onlyOkRequired(s.jobs), JSON.stringify(s.res.body));
    await cleanupMarked();
  }

  // -------------------------------------------------------------------------
  // 4. Status logic — per-job, latest-completed-row governed, coarse in public.
  // -------------------------------------------------------------------------
  console.log('\n— 4: status judges each job by its own latest completed row —');
  {
    // Start from a clean slate for the workers; supply a fresh daily so it cannot mask the assertions.
    await clearRecentWorkerRows();
    const naturalDaily = await hbRows(`cron_name=eq.daily&outcome=eq.succeeded&ran_at=gte.${encodeURIComponent(minutesAgo(25 * 60))}&limit=1`);

    let s = await status();
    ok('status action answers 200 with a per-job cron map', s.res.statusCode === 200 && s.jobs && typeof s.jobs === 'object', `${s.res.statusCode} ${JSON.stringify(s.res.body)}`);
    ok('jobs map names refund-worker, provisional-sweep and daily', ['refund-worker', 'provisional-sweep', 'daily'].every(j => s.jobs[j]), JSON.stringify(Object.keys(s.jobs)));
    ok('refund-worker is required', s.jobs['refund-worker'] && s.jobs['refund-worker'].required === true, JSON.stringify(s.jobs['refund-worker']));
    ok('MISSING refund-worker heartbeat -> ok:false', s.jobs['refund-worker'] && s.jobs['refund-worker'].ok === false, JSON.stringify(s.jobs['refund-worker']));
    ok('missing required job -> overall cron ok:false', s.cron.ok === false, JSON.stringify(s.cron));
    ok('status is degraded (not operational) while a required job is dead', s.res.body && s.res.body.status !== 'operational', JSON.stringify(s.res.body && s.res.body.status));
    ok('holds OFF: provisional-sweep is required:false and ok:true even though missing',
       s.jobs['provisional-sweep'] && s.jobs['provisional-sweep'].required === false && s.jobs['provisional-sweep'].ok === true, JSON.stringify(s.jobs['provisional-sweep']));
    if (naturalDaily.length === 0) ok('no daily success in 25h -> daily ok:false', s.jobs.daily && s.jobs.daily.ok === false && s.jobs.daily.required === true, JSON.stringify(s.jobs.daily));
    else console.log('  skip daily-missing assertion: staging already has a daily success within 25h');

    await hbInsert('daily', 'succeeded');
    await hbInsert('refund-worker', 'succeeded', { ranAt: minutesAgo(120) });
    s = await status();
    ok('STALE (2h) refund-worker success -> ok:false', s.jobs['refund-worker'] && s.jobs['refund-worker'].ok === false, JSON.stringify(s.jobs['refund-worker']));
    ok('stale required job -> overall cron ok:false', s.cron.ok === false, JSON.stringify(s.cron));

    await hbInsert('refund-worker', 'succeeded');
    s = await status();
    ok('FRESH refund-worker success -> ok:true', s.jobs['refund-worker'] && s.jobs['refund-worker'].ok === true, JSON.stringify(s.jobs['refund-worker']));
    ok('fresh daily -> daily ok:true', s.jobs.daily && s.jobs.daily.ok === true, JSON.stringify(s.jobs.daily));
    ok('all required jobs fresh -> overall cron ok:true', s.cron.ok === true, JSON.stringify(s.cron));
    ok('public per-job entries expose ONLY {ok, required}', Object.values(s.jobs).every(j => Object.keys(j).sort().join(',') === 'ok,required'), JSON.stringify(s.jobs));
    ok('public payload carries no ages, outcomes, durations or summaries (DH-21)', publicShapeOk(s.res), JSON.stringify(s.res.body));

    // Codex F-03: the LATEST COMPLETED row governs. A 'failed' row after a fresh success flips the
    // required job unhealthy (it REVERSES the old "success recency governs -> still ok" rule) until a
    // later 'succeeded' recovers it.
    await hbInsert('refund-worker', 'failed', { extra: { error: 'simulated later failure' } });
    s = await status();
    ok('recent FAILED row after a fresh success -> refund-worker ok:false (latest completed row governs)', s.jobs['refund-worker'] && s.jobs['refund-worker'].ok === false, JSON.stringify(s.jobs['refund-worker']));
    ok('overall cron ok:false while the latest refund-worker outcome is failed', s.cron.ok === false, JSON.stringify(s.cron));
    ok('last_outcome is NOT leaked publicly (internal only)', !('last_outcome' in (s.jobs['refund-worker'] || {})), JSON.stringify(s.jobs['refund-worker']));
    ok('public payload stays coarse after a failure', publicShapeOk(s.res) && onlyOkRequired(s.jobs), JSON.stringify(s.res.body));

    await hbInsert('refund-worker', 'succeeded');
    s = await status();
    ok('a later SUCCEEDED row recovers -> refund-worker ok:true', s.jobs['refund-worker'] && s.jobs['refund-worker'].ok === true, JSON.stringify(s.jobs['refund-worker']));
    ok('overall cron ok:true again', s.cron.ok === true, JSON.stringify(s.cron));

    // The daily job writes 'started' before its final row: a 'started' row is NOT a completed
    // outcome and must not flip a fresh success either way.
    await hbInsert('daily', 'started');
    s = await status();
    ok("a 'started' row after a fresh daily success is ignored -> daily still ok:true", s.jobs.daily && s.jobs.daily.ok === true, JSON.stringify(s.jobs.daily));
    await hbInsert('daily', 'failed', { extra: { partial: true, errors: 2 } });
    s = await status();
    ok("a daily 'failed' (partial) row after its success -> daily ok:false", s.jobs.daily && s.jobs.daily.ok === false, JSON.stringify(s.jobs.daily));

    // A 'started'/'failed'-only history is NOT a success: an all-failed job is unhealthy.
    await cleanupMarked();
    await hbInsert('daily', 'succeeded');
    await hbInsert('refund-worker', 'failed', { extra: { error: 'only failures' } });
    s = await status();
    ok('only FAILED rows (no success) -> refund-worker ok:false', s.jobs['refund-worker'] && s.jobs['refund-worker'].ok === false, JSON.stringify(s.jobs['refund-worker']));
    await cleanupMarked();
  }

  // -------------------------------------------------------------------------
  // 5. Provisional-sweep requiredness follows the flag. Holds-ON half runs in a child process
  //    because _flags.js is evaluated once per process (see header).
  // -------------------------------------------------------------------------
  console.log('\n— 5a: holds OFF (this process) already proven above; 5b runs with holds ON in a child —');
  {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--holds-on'], { stdio: 'inherit', env: ORIG_ENV, timeout: 180000 });
    ok('holds-ON child process passed every assertion', child.status === 0, `exit ${child.status} ${child.error ? child.error.message : ''}`);
  }
} finally {
  console.log('\n— teardown —');
  await cleanupMarked();
  // rows the real workers wrote during this run are test residue on staging, not telemetry
  await db(`cron_heartbeat?cron_name=${WORKERS}&ran_at=gte.${encodeURIComponent(startIso)}`, { method: 'DELETE' });
  await teardownLedger();
  spy.restore();
}
process.exit(summary('cron heartbeats') ? 0 : 1);
