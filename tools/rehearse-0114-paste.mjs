// tools/rehearse-0114-paste.mjs (2026-10-25): rehearses the 0114 paste on the TEST project (demohub-rebuild-check)
// inside ONE outer transaction that is rolled back at the end, so the test database is left exactly as found. Run it
// before 0114 is applied to the test project (production's shape) or after (the rehearsal restores that shape first).
//   0. outer BEGIN; if 0114 is present: drop the scope-state table, ensure and enable, restore 0113's issue and
//      revoke, delete the ledger row
//   1. wrong target: the guard with identity 'production' must refuse
//   2. SAVEPOINT; the body with the ledger INSERT replaced by a forced failure -> error -> ROLLBACK TO SAVEPOINT;
//      nothing left behind
//   3. SAVEPOINT; the paste body unmodified -> the verify row reads OK; an existing active link is untouched; ensure
//      on that scope returns it ('existing') and creates nothing; ensure on an empty scope creates ('created') and a
//      second ensure returns the same row; revoke disables; ensure then answers 'disabled'; issue on the stopped
//      scope raises scope_disabled; enable clears it; ensure creates again
//   4. run it again -> the guard refuses (0114 in the ledger) and nothing changes
//   5. outer ROLLBACK; the live objects are as they were
// Usage (SB_DB_URL = the test project's pooler URL): node tools/rehearse-0114-paste.mjs <paste generated with the test identity>
import pg from 'pg';
import { readFileSync } from 'node:fs';
const url = process.env.SB_DB_URL || '';
if (!/tileejdviuvijumjeplv/.test(url)) { console.error('REFUSING: not demohub-rebuild-check'); process.exit(2); }
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
const id = (await c.query('select environment from get_deployment_identity()')).rows[0].environment;
if (id === 'production') { console.error('REFUSING: production'); process.exit(2); }
const paste = readFileSync(process.argv[2], 'utf8');
const bodyStart = paste.indexOf('DO $cutover_guard$'), bodyEnd = paste.indexOf('COMMIT;', paste.indexOf("VALUES ('0114', 'store_calendar_scope_state');"));
if (bodyStart < 0 || bodyEnd < 0) throw new Error('paste anchors');
const body = paste.slice(bodyStart, bodyEnd);
const verifySql = paste.slice(paste.indexOf("SELECT 'OK 0114 RECORDED'"));
const guardOnly = body.slice(0, body.indexOf('$cutover_guard$;') + '$cutover_guard$;'.length);
const m0113 = readFileSync(new URL('../supabase/migrations/0113_store_calendar_persistent_links.sql', import.meta.url), 'utf8');
const m0112 = readFileSync(new URL('../supabase/migrations/0112_store_calendar_links_corrections.sql', import.meta.url), 'utf8');
const issue0113 = m0113.slice(m0113.indexOf('CREATE OR REPLACE FUNCTION public.store_calendar_link_issue('), m0113.indexOf('REVOKE ALL ON FUNCTION public.store_calendar_link_issue('));
const revoke0112 = m0112.slice(m0112.indexOf('CREATE OR REPLACE FUNCTION public.store_calendar_link_revoke('), m0112.indexOf('-- ---- SC-4: atomic resolve'));
let pass = 0, fail = 0;
const ok = (n, cond, extra = '') => { if (cond) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (extra ? ' ' + extra : '')); } };
const hasTable = async () => (await c.query(`select to_regclass('public.store_calendar_scope_state') is not null as x`)).rows[0].x;
const fnCount = async () => (await c.query(`select count(*)::int n from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname='public' and p.proname in ('store_calendar_link_ensure','store_calendar_scope_enable')`)).rows[0].n;
const ledger = async () => (await c.query(`select count(*)::int n from supabase_migrations.schema_migrations where version = '0114'`)).rows[0].n;
const attempt = async (sql, params) => { try { return { ok: true, res: await c.query(sql, params) }; } catch (e) { return { ok: false, err: String(e.message || e) }; } };
const sp = async (name, fn) => { await c.query('SAVEPOINT ' + name); const r = await fn(); await c.query('ROLLBACK TO SAVEPOINT ' + name); return r; };

const live = { table: await hasTable(), fns: await fnCount(), ledger: await ledger() };
console.log('live before:', JSON.stringify(live));
await c.query('BEGIN');
try {
  if (live.table || live.fns || live.ledger) {
    await c.query(`DROP FUNCTION IF EXISTS public.store_calendar_link_ensure(uuid, uuid, text, text, text); DROP FUNCTION IF EXISTS public.store_calendar_scope_enable(uuid, uuid, text); DROP TABLE IF EXISTS public.store_calendar_scope_state; DELETE FROM supabase_migrations.schema_migrations WHERE version = '0114';`);
    await c.query(issue0113); await c.query(revoke0112);
  }
  ok('0. production shape: no scope-state table, no ensure or enable, 0114 absent', !(await hasTable()) && (await fnCount()) === 0 && (await ledger()) === 0);
  const r = (await c.query(`insert into public.retailers (slug, name) values ('rehearsal-0114-' || substr(md5(random()::text), 1, 8), 'Rehearsal 0114') returning id`)).rows[0];
  const v = (await c.query(`insert into public.venues (retailer_id, name, active) values ($1, 'Rehearsal Venue', true) returning id`, [r.id])).rows[0];
  const SEAL = 'v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB.CCCCCCCCCCCCCCCCCCCCCC';
  const hPre = 'a'.repeat(64);
  await c.query(`select * from public.store_calendar_link_issue($1, null, $2, $3, 'rehearsal@fixture.test')`, [r.id, hPre, SEAL]);

  const e1 = await sp('s1', () => attempt(guardOnly.replace(/IS DISTINCT FROM '[a-z-]+'/, "IS DISTINCT FROM 'production'").replace(/not [a-z-]+\. STOP/, 'not production. STOP')));
  ok('1. the guard with identity production refuses on this database', !e1.ok && /CUTOVER GUARD: this database identifies as/.test(e1.err), e1.err || 'no error');
  const e2 = await sp('s2', () => attempt(body.replace("INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('0114', 'store_calendar_scope_state');", 'SELECT 1/0;')));
  ok('2. a failure at the very end leaves nothing behind (table, functions and ledger are one unit)', !e2.ok && /division by zero/.test(e2.err) && !(await hasTable()) && (await fnCount()) === 0 && (await ledger()) === 0, e2.err || 'no error');

  await c.query('SAVEPOINT s3');
  const e3 = await attempt(body);
  ok('3a. the paste body runs clean', e3.ok, e3.err || '');
  const vr = (await c.query(verifySql)).rows[0];
  ok('3b. verify row: OK 0114 RECORDED, the table, six functions, ensure locks and never revokes, issue refuses a stopped scope, service_role may ensure, anon may not ensure or read, 0 stopped scopes', vr && vr.result === 'OK 0114 RECORDED' && vr.scope_state_table_expect_true === true && vr.functions_expect_6 === '6' && vr.ensure_locks_and_never_revokes_expect_true === true && vr.issue_refuses_stopped_expect_true === true && vr.service_role_ensure_expect_true === true && vr.anon_ensure_expect_false === false && vr.anon_state_select_expect_false === false && vr.stopped_scopes_expect_0 === '0', JSON.stringify(vr));
  const pre = (await c.query(`select token_hash, revoked_at from public.store_calendar_links where retailer_id = $1 and venue_id is null`, [r.id])).rows;
  const en1 = (await c.query(`select * from public.store_calendar_link_ensure($1, null, $2, $3, 'rehearsal@fixture.test')`, [r.id, 'b'.repeat(64), SEAL])).rows[0];
  const pre2 = (await c.query(`select token_hash, revoked_at from public.store_calendar_links where retailer_id = $1 and venue_id is null`, [r.id])).rows;
  ok('3c. the pre-existing active link is untouched by the paste; ensure on its scope answers existing with ITS hash and creates nothing', pre.length === 1 && pre[0].revoked_at == null && en1.outcome === 'existing' && en1.token_hash === hPre && pre2.length === 1 && pre2[0].revoked_at == null, JSON.stringify({ pre, en1: en1 && en1.outcome }));
  const en2 = (await c.query(`select * from public.store_calendar_link_ensure($1, $2, $3, $4, 'rehearsal@fixture.test')`, [r.id, v.id, 'c'.repeat(64), SEAL])).rows[0];
  const en3 = (await c.query(`select * from public.store_calendar_link_ensure($1, $2, $3, $4, 'rehearsal@fixture.test')`, [r.id, v.id, 'd'.repeat(64), SEAL])).rows[0];
  ok('3d. ensure on an empty scope creates once; a second ensure returns the same row (existing, the first hash); one active row for the scope', en2.outcome === 'created' && en2.token_hash === 'c'.repeat(64) && en3.outcome === 'existing' && en3.token_hash === 'c'.repeat(64) && en3.id === en2.id && (await c.query(`select count(*)::int n from public.store_calendar_links where retailer_id = $1 and venue_id = $2 and revoked_at is null`, [r.id, v.id])).rows[0].n === 1, JSON.stringify({ en2: en2.outcome, en3: en3.outcome }));
  const rv = (await c.query(`select public.store_calendar_link_revoke($1, $2, 'rehearsal@fixture.test') as n`, [r.id, v.id])).rows[0].n;
  const en4 = (await c.query(`select * from public.store_calendar_link_ensure($1, $2, $3, $4, 'rehearsal@fixture.test')`, [r.id, v.id, 'e'.repeat(64), SEAL])).rows[0];
  const iss = await sp('s3iss', () => attempt(`select * from public.store_calendar_link_issue($1, $2, $3, $4, 'rehearsal@fixture.test')`, [r.id, v.id, 'f'.repeat(64), SEAL]));
  ok('3e. revoke retires the link (1) and stops the scope: ensure answers disabled and creates nothing; issue raises scope_disabled', rv === 1 && en4.outcome === 'disabled' && en4.id == null && !iss.ok && /scope_disabled/.test(iss.err) && (await c.query(`select count(*)::int n from public.store_calendar_links where retailer_id = $1 and venue_id = $2 and revoked_at is null`, [r.id, v.id])).rows[0].n === 0, JSON.stringify({ rv, en4: en4.outcome, iss: iss.err }));
  const enb = (await c.query(`select public.store_calendar_scope_enable($1, $2, 'rehearsal@fixture.test') as n`, [r.id, v.id])).rows[0].n;
  const en5 = (await c.query(`select * from public.store_calendar_link_ensure($1, $2, $3, $4, 'rehearsal@fixture.test')`, [r.id, v.id, '9'.repeat(64), SEAL])).rows[0];
  ok('3f. enable clears the stop (1); ensure then creates one new link', enb === 1 && en5.outcome === 'created' && en5.token_hash === '9'.repeat(64), JSON.stringify({ enb, en5: en5.outcome }));
  const e4 = await sp('s4', () => attempt(body));
  ok('4. running the paste again: the guard refuses (0114 in the ledger) and nothing changes', !e4.ok && /0114 is already in the ledger/.test(e4.err) && (await ledger()) === 1 && (await hasTable()), e4.err || 'no error');
  await c.query('ROLLBACK TO SAVEPOINT s3');
} finally {
  await c.query('ROLLBACK');
}
const after = { table: await hasTable(), fns: await fnCount(), ledger: await ledger() };
ok('5. after the outer rollback the live objects are exactly as before', JSON.stringify(after) === JSON.stringify(live), JSON.stringify({ live, after }));
console.log(`\n0114 paste rehearsal: ${pass} passed, ${fail} failed (test project left as found)`);
await c.end();
process.exit(fail ? 1 : 0);
