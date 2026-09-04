// tests/support_access_race.test.mjs — Codex FC-02: support_session_create() vs
// support_access_set(…, false) are serialized on the retailer row (migration
// 0072_support_access_atomic.sql).
//
// This is a MULTI-CONNECTION test, in the mould of tests/capacity_serialization.test.mjs. PostgREST
// gives one transaction per request, so "OFF holds the row lock while an impersonation is waiting
// on it" cannot be staged through the route harness. It drives STAGING directly through `pg` with
// explicit BEGIN/COMMIT on several connections.
//
// The claim under test, in both orders:
//   (a) impersonation commits FIRST, then OFF        -> OFF ends the audit row and deletes the
//                                                       session before OFF is visible to anyone;
//   (b) OFF holds the lock FIRST, impersonation waits -> once OFF commits, the impersonation is
//                                                       refused with support_access_disabled — it
//                                                       never sees the stale consent it read for;
//   (c) 100+ randomly-ordered concurrent runs         -> after every run: consent is OFF and there
//                                                       is no usable session referenced by an open
//                                                       support_sessions row; zero deadlocks (40P01).
//
// Env:
//   SB_DB_URL  Postgres connection string for the STAGING project (direct or session pooler, :5432).
//   SB_REF     must equal the staging ref; the connection string must also contain it.
// Missing or mismatched env is a FAIL with exit 1 — never a vacuous pass.
//
// PREREQUISITE: 0072 applied to the target. The preflight checks the catalog and FAILS otherwise.
// Every fixture is created by this run and removed in FK order in a finally block.
import pg from 'pg';

const { Client } = pg;

// ---------------------------------------------------------------------------
// Assertions (same shape as tests/capacity_serialization.test.mjs)
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
const errText = (e) => e ? `${e.code || ''} ${String(e.message || e).slice(0, 200)}` : 'no error';

// ---------------------------------------------------------------------------
// Preflight: env + target guard. Refuse rather than guess.
// ---------------------------------------------------------------------------
const STAGING_REF = 'tileejdviuvijumjeplv';
const FORBIDDEN = new Set(['dkgjvsstbgnhcfboqqnd', 'ecapmcyumpjjgjwuokyv', 'eubbgurdwqmwqduamwhn']);
const SB_DB_URL = process.env.SB_DB_URL;
const SB_REF = process.env.SB_REF;

if (!SB_DB_URL) { console.log('  FAIL SB_DB_URL not set — cannot run the deterministic race test'); process.exit(1); }
if (!SB_REF || FORBIDDEN.has(SB_REF) || SB_REF !== STAGING_REF) {
  console.log(`  FAIL REFUSING: SB_REF must be the staging ref (${STAGING_REF}); got ${SB_REF || '<unset>'}`); process.exit(1);
}
if (!SB_DB_URL.includes(STAGING_REF)) { console.log('  FAIL REFUSING: SB_DB_URL does not reference the staging project'); process.exit(1); }
for (const ref of FORBIDDEN) {
  if (SB_DB_URL.includes(ref)) { console.log(`  FAIL REFUSING: SB_DB_URL references production/retired project ${ref}`); process.exit(1); }
}
if (/:6543(\/|$|\?)/.test(SB_DB_URL)) {
  console.log('  FAIL REFUSING: SB_DB_URL points at the transaction-mode pooler (:6543); use the direct/session connection (:5432)');
  process.exit(1);
}

const WATCHDOG_MS = 5 * 60 * 1000;
const watchdog = setTimeout(() => { console.log('  FAIL watchdog: suite exceeded 5 minutes — a lock did not release'); process.exit(1); }, WATCHDOG_MS);

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------
const clients = [];
async function connect(label) {
  const ssl = /sslmode=disable/i.test(SB_DB_URL) ? false : { rejectUnauthorized: false };
  const c = new Client({ connectionString: SB_DB_URL, ssl, application_name: `sarace-${label}` });
  await c.connect();
  await c.query(`SET lock_timeout = '30s'`);
  await c.query(`SET statement_timeout = '60s'`);
  c.label = label;
  c.pid = (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  clients.push(c);
  return c;
}
const rollbackQuiet = async (c) => { try { await c.query('ROLLBACK'); } catch (_) { /* not in a txn */ } };
async function settledWithin(p, ms) {
  return Promise.race([p.then(() => 'resolved', () => 'rejected'), sleep(ms).then(() => 'pending')]);
}
const capture = (p) => p.then(r => ({ ok: true, r }), e => ({ ok: false, e }));
async function waitEvent(ctl, pid) {
  const r = await ctl.query('SELECT wait_event_type, wait_event, state FROM pg_stat_activity WHERE pid = $1', [pid]);
  return r.rows[0] || null;
}
async function waitUntilBlocked(ctl, pid, timeoutMs = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const w = await waitEvent(ctl, pid);
    if (w && w.wait_event_type === 'Lock') return w;
    await sleep(50);
  }
  return await waitEvent(ctl, pid);
}

// ---------------------------------------------------------------------------
// Fixtures + the two functions under test
// ---------------------------------------------------------------------------
const fx = { retailers: [] };
const OWNER = 'race-owner@fixture.test';
async function mkRetailer(c) {
  const slug = uniq('sarace');
  const r = await c.query(
    `INSERT INTO retailers (slug, name, billing_email, billing_tier, billing_status, allow_support_access, support_access_expires_at)
     VALUES ($1, 'Support Access Race Fixture', $2, 'pro', 'active', true, now() + interval '24 hours') RETURNING id, billing_email`,
    [slug, slug + '@fixture.test']);
  fx.retailers.push(r.rows[0].id);
  return r.rows[0];
}
const consentOn = (c, rid) => c.query(`UPDATE retailers SET allow_support_access = true, support_access_expires_at = now() + interval '24 hours' WHERE id = $1`, [rid]);
const create = (c, rid, email, tag) => c.query(`SELECT * FROM support_session_create($1, $2, $3, NULL, $4)`, [rid, OWNER, email, tag]);
const setOff = (c, rid) => c.query(`SELECT * FROM support_access_set($1, false)`, [rid]);
const readConsent = async (c, rid) => (await c.query('SELECT allow_support_access, support_access_expires_at FROM retailers WHERE id = $1', [rid])).rows[0];
// "Usable after OFF": an existing, unexpired admin_sessions row still referenced by an OPEN audit row.
const usableOpen = async (c, rid) => (await c.query(`
  SELECT count(*)::int AS n
    FROM support_sessions s JOIN admin_sessions a ON a.session_id = s.target_session_id
   WHERE s.target_retailer_id = $1 AND s.ended_at IS NULL AND a.expires_at > now()`, [rid])).rows[0].n;
const sessionRows = async (c, rid) => (await c.query('SELECT session_id, expires_at FROM admin_sessions WHERE retailer_id = $1 AND email <> $2', [rid, 'never'])).rows;
const auditRows = async (c, rid) => (await c.query('SELECT id, target_session_id, ended_at, owner_email, started_at, writes_count FROM support_sessions WHERE target_retailer_id = $1 ORDER BY started_at', [rid])).rows;

// =====================================================================
async function main() {
  const ctl = await connect('ctl');

  console.log('\n— PREFLIGHT: migration 0072 is applied —');
  const fns = (await ctl.query(`
    SELECT p.proname, p.prosecdef,
           has_function_privilege('service_role', p.oid, 'EXECUTE') AS sr,
           has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed,
           p.prosrc
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN ('support_session_create', 'support_access_set')`)).rows;
  const byName = Object.fromEntries(fns.map(f => [f.proname, f]));
  const cr = byName.support_session_create, st = byName.support_access_set;
  const applied = !!cr && !!st && cr.prosecdef && st.prosecdef && /FOR NO KEY UPDATE/i.test(cr.prosrc) && /FOR NO KEY UPDATE/i.test(st.prosrc);
  ok('0072 applied: both functions exist, SECURITY DEFINER, and lock the retailer row', applied,
     applied ? '' : `\n       >>> 0072 has NOT been applied to staging (supabase/migrations/0072_support_access_atomic.sql). found=${JSON.stringify(fns.map(f => f.proname))}`);
  if (!applied) return;
  ok('0072 grants: service_role can execute both; anon and authenticated cannot',
     cr.sr && st.sr && !cr.anon && !st.anon && !cr.authed && !st.authed, JSON.stringify(fns.map(({ prosrc, ...f }) => f)));

  const c1 = await connect('c1'), c2 = await connect('c2');

  // ===================================================================
  console.log('\n— SCENARIO A: impersonation commits first, then OFF — OFF must revoke it —');
  {
    const r = await mkRetailer(ctl); const rid = r.id;
    await c1.query('BEGIN');
    const made = await create(c1, rid, r.billing_email, 'A');
    await c1.query('COMMIT');
    const sid = made.rows[0].session_id;
    ok('A: impersonation minted a session with expires_at <= now + 4h',
       !!sid && Date.parse(made.rows[0].expires_at) <= Date.now() + 4 * 3600e3 + 60e3, JSON.stringify(made.rows[0]));
    ok('A: one open audit row points at it', (await auditRows(ctl, rid)).filter(a => a.target_session_id === sid && a.ended_at === null).length === 1);

    const off = await setOff(c2, rid);
    ok('A: OFF returns allow=false, expiry null, ended_sessions=1',
       off.rows[0].allow_support_access === false && off.rows[0].support_access_expires_at === null && off.rows[0].ended_sessions === 1, JSON.stringify(off.rows[0]));
    const sess = await sessionRows(ctl, rid);
    ok('A: zero admin_sessions rows remain for the retailer (the support session is DELETED)', sess.length === 0, JSON.stringify(sess));
    const audits = await auditRows(ctl, rid);
    ok('A: the audit row is ended, pointer nulled by the FK, owner/started_at/writes_count preserved',
       audits.length === 1 && audits[0].ended_at !== null && audits[0].target_session_id === null && audits[0].owner_email === OWNER && audits[0].started_at && audits[0].writes_count === 0,
       JSON.stringify(audits));
    ok('A: usable-after-OFF = 0', (await usableOpen(ctl, rid)) === 0);
  }

  // ===================================================================
  console.log('\n— SCENARIO A2: impersonation holds the lock (uncommitted); OFF must WAIT, then revoke it —');
  {
    const r = await mkRetailer(ctl); const rid = r.id;
    await c1.query('BEGIN');
    const made = await create(c1, rid, r.billing_email, 'A2');          // holds the retailer row lock
    const sid = made.rows[0].session_id;

    await c2.query('BEGIN');
    const off = capture(setOff(c2, rid));
    const w = await waitUntilBlocked(ctl, c2.pid);
    ok('A2: OFF is parked on the row lock held by the in-flight impersonation', w && w.wait_event_type === 'Lock', JSON.stringify(w));
    ok('A2: OFF has not completed while the impersonation is open', (await settledWithin(off, 800)) === 'pending');

    await c1.query('COMMIT');
    const offRes = await off;
    ok('A2: OFF completes after the impersonation commits', offRes.ok, offRes.ok ? '' : errText(offRes.e));
    ok('A2: OFF saw the just-committed session and ended it (ended_sessions=1)', offRes.ok && offRes.r.rows[0].ended_sessions === 1, offRes.ok ? JSON.stringify(offRes.r.rows[0]) : '');
    await c2.query('COMMIT');
    ok('A2: the session row is gone', !(await sessionRows(ctl, rid)).some(s => s.session_id === sid));
    ok('A2: usable-after-OFF = 0', (await usableOpen(ctl, rid)) === 0);
  }

  // ===================================================================
  console.log('\n— SCENARIO B: OFF holds the lock; impersonation must BLOCK, then be REFUSED —');
  {
    const r = await mkRetailer(ctl); const rid = r.id;
    await c2.query('BEGIN');
    const off = await setOff(c2, rid);                                   // row lock held until COMMIT
    ok('B: OFF (uncommitted) reports allow=false in its own transaction', off.rows[0].allow_support_access === false);
    ok('B: to every other connection consent still reads ON (READ COMMITTED)', (await readConsent(ctl, rid)).allow_support_access === true);

    const made = capture(create(c1, rid, r.billing_email, 'B'));         // autocommit single statement
    const w = await waitUntilBlocked(ctl, c1.pid);
    ok('B: the impersonation is parked on the row lock (it did NOT mint against the stale consent)', w && w.wait_event_type === 'Lock', JSON.stringify(w));
    ok('B: impersonation has not completed while OFF is open', (await settledWithin(made, 800)) === 'pending');
    ok('B: no admin_sessions row exists while it waits', (await sessionRows(ctl, rid)).length === 0);

    await c2.query('COMMIT');
    const res = await made;
    ok('B: once OFF commits, the impersonation is REFUSED with support_access_disabled (P0001)',
       !res.ok && res.e && res.e.code === 'P0001' && res.e.message === 'support_access_disabled',
       res.ok ? `MINTED ${JSON.stringify(res.r.rows[0])} against revoked consent` : errText(res.e));
    ok('B: zero admin_sessions rows', (await sessionRows(ctl, rid)).length === 0);
    ok('B: zero support_sessions rows', (await auditRows(ctl, rid)).length === 0);
    ok('B: usable-after-OFF = 0', (await usableOpen(ctl, rid)) === 0);
  }

  // ===================================================================
  const RUNS = 100;
  console.log(`\n— SCENARIO C: ${RUNS} concurrent create-vs-OFF runs, random ordering —`);
  {
    const r = await mkRetailer(ctl); const rid = r.id;
    let deadlocks = 0, usableAfterOff = 0, minted = 0, refused = 0, otherErrors = [];
    for (let i = 0; i < RUNS; i++) {
      await consentOn(ctl, rid);
      // Random start order and jitter (0-4ms) so both interleavings occur across the run.
      const jitterCreate = Math.random() * 4, jitterOff = Math.random() * 4;
      const pCreate = sleep(jitterCreate).then(() => create(c1, rid, r.billing_email, `C${i}`));
      const pOff = sleep(jitterOff).then(() => setOff(c2, rid));
      const [rc, ro] = await Promise.all([capture(pCreate), capture(pOff)]);
      for (const x of [rc, ro]) if (!x.ok && x.e && x.e.code === '40P01') deadlocks++;
      if (!ro.ok) otherErrors.push(`OFF: ${errText(ro.e)}`);
      if (rc.ok) minted++;
      else if (rc.e && rc.e.code === 'P0001' && rc.e.message === 'support_access_disabled') refused++;
      else otherErrors.push(`create: ${errText(rc.e)}`);
      // Post-condition: OFF always ran, so consent must be OFF and nothing usable may remain.
      const consent = await readConsent(ctl, rid);
      if (consent.allow_support_access === false) {
        const n = await usableOpen(ctl, rid);
        if (n !== 0) usableAfterOff++;
      } else {
        otherErrors.push(`run ${i}: consent still ON after OFF`);
      }
      // If create won the race, OFF must have ended exactly that session.
      if (rc.ok && ro.ok && ro.r.rows[0].ended_sessions !== 1) otherErrors.push(`run ${i}: create won but OFF ended ${ro.r.rows[0].ended_sessions} sessions`);
      if (!rc.ok && ro.ok && ro.r.rows[0].ended_sessions !== 0) otherErrors.push(`run ${i}: create refused but OFF ended ${ro.r.rows[0].ended_sessions} sessions`);
    }
    console.log(`  race: ${RUNS} runs, ${usableAfterOff} usable-after-OFF, ${deadlocks} deadlocks  (create won ${minted}, refused ${refused})`);
    ok(`C: ${RUNS} runs, 0 usable-after-OFF`, usableAfterOff === 0, String(usableAfterOff));
    ok('C: 0 deadlocks (no 40P01)', deadlocks === 0, String(deadlocks));
    ok('C: every create either minted or was refused with support_access_disabled; every OFF succeeded', otherErrors.length === 0, otherErrors.slice(0, 5).join(' | '));
    ok('C: both orders actually occurred (create-first and OFF-first)', minted > 0 && refused > 0, `minted ${minted} refused ${refused}`);
    ok('C: every audit row is ended and no session row remains', (await auditRows(ctl, rid)).every(a => a.ended_at !== null) && (await sessionRows(ctl, rid)).length === 0);
    ok('C: consent ends OFF', (await readConsent(ctl, rid)).allow_support_access === false);
  }
}

// =====================================================================
let exitCode = 1;
let ctlForTeardown = null;
try {
  await main();
  exitCode = summary('support access race') ? 0 : 1;
} catch (e) {
  console.log(`  FAIL uncaught: ${errText(e)}`);
  summary('support access race');
  exitCode = 1;
} finally {
  // FK-ordered teardown on a fresh connection: any open transactions are rolled back first.
  for (const c of clients) await rollbackQuiet(c);
  try {
    ctlForTeardown = clients[0] || await connect('teardown');
    for (const rid of fx.retailers) {
      await ctlForTeardown.query('DELETE FROM support_sessions WHERE target_retailer_id = $1', [rid]);
      await ctlForTeardown.query('DELETE FROM admin_sessions WHERE retailer_id = $1', [rid]);
      await ctlForTeardown.query('DELETE FROM retailers WHERE id = $1', [rid]);
    }
  } catch (e) { console.log(`  teardown error: ${errText(e)}`); exitCode = 1; }
  for (const c of clients) { try { await c.end(); } catch (_) {} }
  clearTimeout(watchdog);
  process.exit(exitCode);
}
