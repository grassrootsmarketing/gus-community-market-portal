// tools/rehearse-0111-paste.mjs (2026-10-23): rehearses the 0111 paste on the TEST project (demohub-rebuild-check) inside
// ONE outer transaction that is rolled back at the end, so the test database is left exactly as found. The test project
// already carries 0111, so the rehearsal first simulates the production shape inside that transaction:
//   0. outer BEGIN; drop the three functions and the table, delete the ledger row 0111
//   1. wrong target: the guard with identity 'production' must refuse (this database is not production)
//   2. SAVEPOINT; the body with the ledger INSERT replaced by a forced failure -> error -> ROLLBACK TO SAVEPOINT; prove
//      nothing is left behind (no table, no functions, no ledger row)
//   3. SAVEPOINT; the paste body unmodified -> the verify row reads OK with every expectation true; issue, resolve and
//      revoke work through the functions; anon cannot execute or read
//   4. run it again -> the guard refuses (0111 in the ledger) and nothing changes
//   5. outer ROLLBACK; prove the live objects are as they were
// Usage (SB_DB_URL = the test project's pooler URL): node tools/rehearse-0111-paste.mjs <paste generated with the test identity>
import pg from 'pg';
import { readFileSync } from 'node:fs';
const url = process.env.SB_DB_URL || '';
if (!/tileejdviuvijumjeplv/.test(url)) { console.error('REFUSING: not demohub-rebuild-check'); process.exit(2); }
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
const id = (await c.query('select environment from get_deployment_identity()')).rows[0].environment;
if (id === 'production') { console.error('REFUSING: production'); process.exit(2); }
const paste = readFileSync(process.argv[2], 'utf8');
const bodyStart = paste.indexOf('DO $cutover_guard$'), bodyEnd = paste.indexOf('COMMIT;', paste.indexOf("VALUES ('0111', 'store_calendar_links');"));
if (bodyStart < 0 || bodyEnd < 0) throw new Error('paste anchors');
const body = paste.slice(bodyStart, bodyEnd);
const verifySql = paste.slice(paste.indexOf("SELECT 'OK 0111 RECORDED'"));
const guardOnly = body.slice(0, body.indexOf('$cutover_guard$;') + '$cutover_guard$;'.length);
let pass = 0, fail = 0;
const ok = (n, cond, extra = '') => { if (cond) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (extra ? ' ' + extra : '')); } };
const tableExists = async () => (await c.query(`select to_regclass('public.store_calendar_links') is not null as x`)).rows[0].x;
const fnCount = async () => (await c.query(`select count(*)::int n from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname='public' and p.proname in ('store_calendar_link_issue','store_calendar_link_revoke','store_calendar_link_resolve')`)).rows[0].n;
const ledger = async () => (await c.query(`select count(*)::int n from supabase_migrations.schema_migrations where version='0111'`)).rows[0].n;
const attempt = async (sql, params) => { try { return { ok: true, res: await c.query(sql, params) }; } catch (e) { return { ok: false, err: String(e.message || e) }; } };

const live = { table: await tableExists(), fns: await fnCount(), ledger: await ledger() };
console.log('live before:', JSON.stringify(live));
await c.query('BEGIN');
try {
  await c.query(`DROP FUNCTION IF EXISTS public.store_calendar_link_issue(uuid, uuid, text, text); DROP FUNCTION IF EXISTS public.store_calendar_link_revoke(uuid, uuid, text); DROP FUNCTION IF EXISTS public.store_calendar_link_resolve(text); DROP TABLE IF EXISTS public.store_calendar_links; DELETE FROM supabase_migrations.schema_migrations WHERE version = '0111';`);
  ok('0. production shape simulated: no table, no functions, 0111 absent', !(await tableExists()) && (await fnCount()) === 0 && (await ledger()) === 0);

  await c.query('SAVEPOINT s1');
  const e1 = await attempt(guardOnly.replace(/IS DISTINCT FROM '[a-z-]+'/, "IS DISTINCT FROM 'production'").replace(/not [a-z-]+\. STOP/, 'not production. STOP'));
  await c.query('ROLLBACK TO SAVEPOINT s1');
  ok('1. the guard with identity production refuses on this database', !e1.ok && /CUTOVER GUARD: this database identifies as/.test(e1.err), e1.err || 'no error');

  await c.query('SAVEPOINT s2');
  const e2 = await attempt(body.replace("INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('0111', 'store_calendar_links');", 'SELECT 1/0;'));
  await c.query('ROLLBACK TO SAVEPOINT s2');
  ok('2. a failure inside the paste leaves nothing behind', !e2.ok && /division by zero/.test(e2.err) && !(await tableExists()) && (await fnCount()) === 0 && (await ledger()) === 0, e2.err || 'no error');

  await c.query('SAVEPOINT s3');
  const e3 = await attempt(body);
  ok('3a. the paste body runs clean', e3.ok, e3.err || '');
  const v = (await c.query(verifySql)).rows[0];
  ok('3b. verify row: OK 0111 RECORDED, table, 3 functions, service_role may resolve, anon may not resolve or read, 0 links, ledger once', v && v.result === 'OK 0111 RECORDED' && v.rows_0111_expect_1 === '1' && v.table_present_expect_true === true && v.functions_expect_3 === '3' && v.service_role_resolve_expect_true === true && v.anon_resolve_expect_false === false && v.anon_select_expect_false === false && v.links_expect_0_until_an_admin_creates_one === '0', JSON.stringify(v));
  // functional probe inside the rehearsal: issue for a store, resolve, rotate (old dead), revoke
  const r = (await c.query(`select id from retailers order by created_at limit 1`)).rows[0];
  const h1 = 'a'.repeat(64), h2 = 'b'.repeat(64);
  const i1 = await attempt(`select * from public.store_calendar_link_issue($1, null, $2, 'rehearsal@fixture.test')`, [r.id, h1]);
  const res1 = await attempt(`select * from public.store_calendar_link_resolve($1)`, [h1]);
  const i2 = await attempt(`select * from public.store_calendar_link_issue($1, null, $2, 'rehearsal@fixture.test')`, [r.id, h2]);
  const res1b = await attempt(`select * from public.store_calendar_link_resolve($1)`, [h1]);
  const res2 = await attempt(`select * from public.store_calendar_link_resolve($1)`, [h2]);
  const rv = await attempt(`select public.store_calendar_link_revoke($1, null, 'rehearsal@fixture.test') as n`, [r.id]);
  const res2b = await attempt(`select * from public.store_calendar_link_resolve($1)`, [h2]);
  ok('3c. issue resolves; a second issue rotates (old hash dead, new live); revoke kills the new one', i1.ok && res1.ok && res1.res.rows.length === 1 && res1.res.rows[0].retailer_id === r.id && i2.ok && res1b.ok && res1b.res.rows.length === 0 && res2.ok && res2.res.rows.length === 1 && rv.ok && rv.res.rows[0].n === 1 && res2b.ok && res2b.res.rows.length === 0, JSON.stringify({ i1: i1.err, res1: res1.res && res1.res.rows.length, i2: i2.err, res1b: res1b.res && res1b.res.rows.length, res2: res2.res && res2.res.rows.length, rv: rv.res && rv.res.rows[0], res2b: res2b.res && res2b.res.rows.length }));
  await c.query('SAVEPOINT s3c');
  const badVenue = await attempt(`select * from public.store_calendar_link_issue($1, '00000000-0000-0000-0000-000000000001', $2, 'x')`, [r.id, 'c'.repeat(64)]);
  await c.query('ROLLBACK TO SAVEPOINT s3c');
  await c.query('SAVEPOINT s3d');
  const badHash = await attempt(`select * from public.store_calendar_link_issue($1, null, 'nothex', 'x')`, [r.id]);
  await c.query('ROLLBACK TO SAVEPOINT s3d');
  ok('3d. a venue outside the store and a malformed hash are refused by the function', !badVenue.ok && /venue_not_in_retailer/.test(badVenue.err) && !badHash.ok && /token_hash_shape/.test(badHash.err), (badVenue.err || '') + ' | ' + (badHash.err || ''));

  await c.query('SAVEPOINT s4');
  const e4 = await attempt(body);
  await c.query('ROLLBACK TO SAVEPOINT s4');
  ok('4. a second run refuses at the guard (0111 in the ledger)', !e4.ok && /0111 is already in the ledger/.test(e4.err) && (await ledger()) === 1, e4.err || 'no error');
} finally {
  await c.query('ROLLBACK');
}
const after = { table: await tableExists(), fns: await fnCount(), ledger: await ledger() };
ok('5. outer rollback: the live objects are exactly as before', JSON.stringify(after) === JSON.stringify(live), JSON.stringify(after));
await c.end();
console.log(`\n0111 paste rehearsal (demohub-rebuild-check, rolled back): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
