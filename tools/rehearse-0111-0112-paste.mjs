// tools/rehearse-0111-0112-paste.mjs (2026-10-23): rehearses the combined 0111 + 0112 paste on the TEST project
// (demohub-rebuild-check) inside ONE outer transaction that is rolled back at the end, so the test database is left
// exactly as found. The test project already carries both, so the rehearsal first simulates the production shape:
//   0. outer BEGIN; drop the four functions and both tables, delete the ledger rows 0111 and 0112
//   1. wrong target: the guard with identity 'production' must refuse (this database is not production)
//   2. SAVEPOINT; the body with the LAST ledger INSERT replaced by a forced failure -> error -> ROLLBACK TO SAVEPOINT;
//      prove nothing is left behind (no tables, no functions, no ledger rows: the whole paste is one unit)
//   3. SAVEPOINT; the paste body unmodified -> the verify row reads OK with every expectation true; issue, resolve,
//      rotate and revoke work; the rate counter counts; a venue outside the store and a malformed hash are refused
//   4. run it again -> the guard refuses (0111 in the ledger) and nothing changes
//   5. outer ROLLBACK; prove the live objects are as they were
// Usage (SB_DB_URL = the test project's pooler URL): node tools/rehearse-0111-0112-paste.mjs <paste generated with the test identity>
import pg from 'pg';
import { readFileSync } from 'node:fs';
const url = process.env.SB_DB_URL || '';
if (!/tileejdviuvijumjeplv/.test(url)) { console.error('REFUSING: not demohub-rebuild-check'); process.exit(2); }
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
const id = (await c.query('select environment from get_deployment_identity()')).rows[0].environment;
if (id === 'production') { console.error('REFUSING: production'); process.exit(2); }
const paste = readFileSync(process.argv[2], 'utf8');
const bodyStart = paste.indexOf('DO $cutover_guard$'), bodyEnd = paste.indexOf('COMMIT;', paste.indexOf("VALUES ('0112', 'store_calendar_links_corrections');"));
if (bodyStart < 0 || bodyEnd < 0) throw new Error('paste anchors');
const body = paste.slice(bodyStart, bodyEnd);
const verifySql = paste.slice(paste.indexOf("SELECT 'OK 0111+0112 RECORDED'"));
const guardOnly = body.slice(0, body.indexOf('$cutover_guard$;') + '$cutover_guard$;'.length);
let pass = 0, fail = 0;
const ok = (n, cond, extra = '') => { if (cond) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (extra ? ' ' + extra : '')); } };
const tables = async () => (await c.query(`select (to_regclass('public.store_calendar_links') is not null)::int + (to_regclass('public.store_calendar_rate') is not null)::int as n`)).rows[0].n;
const fnCount = async () => (await c.query(`select count(*)::int n from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname='public' and p.proname in ('store_calendar_link_issue','store_calendar_link_revoke','store_calendar_link_resolve','store_calendar_rate_hit')`)).rows[0].n;
const ledger = async () => (await c.query(`select count(*)::int n from supabase_migrations.schema_migrations where version in ('0111','0112')`)).rows[0].n;
const attempt = async (sql, params) => { try { return { ok: true, res: await c.query(sql, params) }; } catch (e) { return { ok: false, err: String(e.message || e) }; } };
const sp = async (name, fn) => { await c.query('SAVEPOINT ' + name); const r = await fn(); await c.query('ROLLBACK TO SAVEPOINT ' + name); return r; };

const live = { tables: await tables(), fns: await fnCount(), ledger: await ledger() };
console.log('live before:', JSON.stringify(live));
await c.query('BEGIN');
try {
  await c.query(`DROP FUNCTION IF EXISTS public.store_calendar_link_issue(uuid, uuid, text, text); DROP FUNCTION IF EXISTS public.store_calendar_link_revoke(uuid, uuid, text); DROP FUNCTION IF EXISTS public.store_calendar_link_resolve(text); DROP FUNCTION IF EXISTS public.store_calendar_rate_hit(text, integer, timestamptz); DROP TABLE IF EXISTS public.store_calendar_rate; DROP TABLE IF EXISTS public.store_calendar_links; DELETE FROM supabase_migrations.schema_migrations WHERE version IN ('0111', '0112');`);
  ok('0. production shape simulated: no tables, no functions, 0111 and 0112 absent', (await tables()) === 0 && (await fnCount()) === 0 && (await ledger()) === 0);

  const e1 = await sp('s1', () => attempt(guardOnly.replace(/IS DISTINCT FROM '[a-z-]+'/, "IS DISTINCT FROM 'production'").replace(/not [a-z-]+\. STOP/, 'not production. STOP')));
  ok('1. the guard with identity production refuses on this database', !e1.ok && /CUTOVER GUARD: this database identifies as/.test(e1.err), e1.err || 'no error');

  const e2 = await sp('s2', () => attempt(body.replace("INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('0112', 'store_calendar_links_corrections');", 'SELECT 1/0;')));
  ok('2. a failure at the very end leaves nothing behind (the two migrations are one unit)', !e2.ok && /division by zero/.test(e2.err) && (await tables()) === 0 && (await fnCount()) === 0 && (await ledger()) === 0, e2.err || 'no error');

  await c.query('SAVEPOINT s3');
  const e3 = await attempt(body);
  ok('3a. the paste body runs clean', e3.ok, e3.err || '');
  const v = (await c.query(verifySql)).rows[0];
  ok('3b. verify row: OK 0111+0112 RECORDED, both tables, 4 functions, issue takes the scope lock, resolve is atomic, service_role may resolve, anon may not resolve, rate or read, 0 links, ledger twice', v && v.result === 'OK 0111+0112 RECORDED' && v.rows_expect_2 === '2' && v.tables_present_expect_true === true && v.functions_expect_4 === '4' && v.issue_takes_scope_lock_expect_true === true && v.resolve_is_atomic_expect_true === true && v.service_role_resolve_expect_true === true && v.anon_resolve_expect_false === false && v.anon_rate_expect_false === false && v.anon_select_expect_false === false && v.links_expect_0_until_an_admin_creates_one === '0', JSON.stringify(v));
  const r = (await c.query(`select id from retailers order by created_at limit 1`)).rows[0];
  const h1 = 'a'.repeat(64), h2 = 'b'.repeat(64);
  const i1 = await attempt(`select * from public.store_calendar_link_issue($1, null, $2, 'rehearsal@fixture.test')`, [r.id, h1]);
  const res1 = await attempt(`select * from public.store_calendar_link_resolve($1)`, [h1]);
  const i2 = await attempt(`select * from public.store_calendar_link_issue($1, null, $2, 'rehearsal@fixture.test')`, [r.id, h2]);
  const res1b = await attempt(`select * from public.store_calendar_link_resolve($1)`, [h1]);
  const res2 = await attempt(`select * from public.store_calendar_link_resolve($1)`, [h2]);
  const rv = await attempt(`select public.store_calendar_link_revoke($1, null, 'rehearsal@fixture.test') as n`, [r.id]);
  const res2b = await attempt(`select * from public.store_calendar_link_resolve($1)`, [h2]);
  ok('3c. issue resolves (and stamps last_used); a second issue rotates (old hash dead, new live); revoke kills the new one', i1.ok && res1.ok && res1.res.rows.length === 1 && res1.res.rows[0].retailer_id === r.id && i2.ok && res1b.ok && res1b.res.rows.length === 0 && res2.ok && res2.res.rows.length === 1 && rv.ok && rv.res.rows[0].n === 1 && res2b.ok && res2b.res.rows.length === 0, JSON.stringify({ i1: i1.err, res1: res1.res && res1.res.rows.length, i2: i2.err, res1b: res1b.res && res1b.res.rows.length, res2: res2.res && res2.res.rows.length, rv: rv.res && rv.res.rows[0], res2b: res2b.res && res2b.res.rows.length }));
  const hits = []; for (let i = 0; i < 4; i++) hits.push((await c.query(`select * from public.store_calendar_rate_hit('rehearsal:bucket', 3)`)).rows[0]);
  ok('3d. the rate counter: hits 1, 2, 3 allowed, the 4th refused, within one hour window', hits.map(h => h.allowed).join(',') === 'true,true,true,false' && hits.map(h => h.hits).join(',') === '1,2,3,4', JSON.stringify(hits));
  const badVenue = await sp('s3e', () => attempt(`select * from public.store_calendar_link_issue($1, '00000000-0000-0000-0000-000000000001', $2, 'x')`, [r.id, 'c'.repeat(64)]));
  const badHash = await sp('s3f', () => attempt(`select * from public.store_calendar_link_issue($1, null, 'nothex', 'x')`, [r.id]));
  ok('3e. a venue outside the store and a malformed hash are refused by the function', !badVenue.ok && /venue_not_in_retailer/.test(badVenue.err) && !badHash.ok && /token_hash_shape/.test(badHash.err), (badVenue.err || '') + ' | ' + (badHash.err || ''));

  const e4 = await sp('s4', () => attempt(body));
  ok('4. a second run refuses at the guard (0111 in the ledger) and the ledger still holds both once', !e4.ok && /0111 or 0112 is already in the ledger/.test(e4.err) && (await ledger()) === 2, e4.err || 'no error');
} finally {
  await c.query('ROLLBACK');
}
const after = { tables: await tables(), fns: await fnCount(), ledger: await ledger() };
ok('5. outer rollback: the live objects are exactly as before', JSON.stringify(after) === JSON.stringify(live), JSON.stringify(after));
await c.end();
console.log(`\n0111+0112 paste rehearsal (demohub-rebuild-check, rolled back): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
