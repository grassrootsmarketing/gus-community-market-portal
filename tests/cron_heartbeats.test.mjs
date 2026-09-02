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
//   4. the status action judges each job by the age of its OWN latest success: fresh -> ok, stale
//      (2h) -> not ok, missing -> not ok, a later 'failed' row after a fresh success -> still ok;
//      the public payload stays coarse ({ok, required} per job — no ages/outcomes/summaries);
//   5. provisional-sweep is required:false / ok:true while holds are OFF (default), and
//      required:true (missing -> not ok, fresh -> ok) when PROVISIONAL_HOLDS_ENABLED=true.
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
  return !/age_minutes|last_outcome|last_success|duration_ms|summary|hours_since/.test(s);
};

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
  } finally {
    await cleanupMarked();
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
  // 4. Status logic — per-job, success-recency governed, coarse in public.
  // -------------------------------------------------------------------------
  console.log('\n— 4: status judges each job by its own latest success —');
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

    // A later 'failed' row after a fresh success: success recency governs, so still healthy.
    await hbInsert('refund-worker', 'failed', { extra: { error: 'simulated later failure' } });
    s = await status();
    ok('recent FAILED row after a fresh success -> refund-worker still ok:true', s.jobs['refund-worker'] && s.jobs['refund-worker'].ok === true, JSON.stringify(s.jobs['refund-worker']));
    ok('overall cron still ok:true', s.cron.ok === true, JSON.stringify(s.cron));
    ok('last_outcome is NOT leaked publicly (internal only)', !('last_outcome' in (s.jobs['refund-worker'] || {})), JSON.stringify(s.jobs['refund-worker']));

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
  spy.restore();
}
process.exit(summary('cron heartbeats') ? 0 : 1);
