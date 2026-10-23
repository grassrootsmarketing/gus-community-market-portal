// tools/rehearse-0113-paste.mjs (2026-10-23): rehearses the 0113 paste on the TEST project (demohub-rebuild-check)
// inside ONE outer transaction that is rolled back at the end, so the test database is left exactly as found. Run it
// BEFORE 0113 is applied to the test project (the test project then has production's shape: 0112 the tail, no
// token_enc, the four-argument issue), or after (the rehearsal first restores that shape inside the transaction).
//   0. outer BEGIN; if 0113 is present: drop token_enc, restore the four-argument issue, delete the ledger row
//   1. wrong target: the guard with identity 'production' must refuse (this database is not production)
//   2. SAVEPOINT; the body with the ledger INSERT replaced by a forced failure -> error -> ROLLBACK TO SAVEPOINT;
//      prove nothing is left behind (no column, the four-argument function, no ledger row)
//   3. SAVEPOINT; the paste body unmodified -> the verify row reads OK with every expectation true; a pre-0113 active
//      link still resolves (unchanged resolve) and shows token_enc NULL; the five-argument issue records hash and
//      seal; a malformed seal and the four-argument form are refused; a retailer with no feed key got one
//   4. run it again -> the guard refuses (0113 in the ledger) and nothing changes
//   5. outer ROLLBACK; prove the live objects are as they were
// Usage (SB_DB_URL = the test project's pooler URL): node tools/rehearse-0113-paste.mjs <paste generated with the test identity>
import pg from 'pg';
import { readFileSync } from 'node:fs';
const url = process.env.SB_DB_URL || '';
if (!/tileejdviuvijumjeplv/.test(url)) { console.error('REFUSING: not demohub-rebuild-check'); process.exit(2); }
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
const id = (await c.query('select environment from get_deployment_identity()')).rows[0].environment;
if (id === 'production') { console.error('REFUSING: production'); process.exit(2); }
const paste = readFileSync(process.argv[2], 'utf8');
const bodyStart = paste.indexOf('DO $cutover_guard$'), bodyEnd = paste.indexOf('COMMIT;', paste.indexOf("VALUES ('0113', 'store_calendar_persistent_links');"));
if (bodyStart < 0 || bodyEnd < 0) throw new Error('paste anchors');
const body = paste.slice(bodyStart, bodyEnd);
const verifySql = paste.slice(paste.indexOf("SELECT 'OK 0113 RECORDED'"));
const guardOnly = body.slice(0, body.indexOf('$cutover_guard$;') + '$cutover_guard$;'.length);
let pass = 0, fail = 0;
const ok = (n, cond, extra = '') => { if (cond) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (extra ? ' ' + extra : '')); } };
const hasCol = async () => (await c.query(`select exists (select 1 from information_schema.columns where table_schema='public' and table_name='store_calendar_links' and column_name='token_enc') as x`)).rows[0].x;
const issueArgs = async () => (await c.query(`select pg_get_function_identity_arguments(p.oid) a from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname='public' and p.proname='store_calendar_link_issue'`)).rows.map(r => r.a);
const ledger = async () => (await c.query(`select count(*)::int n from supabase_migrations.schema_migrations where version = '0113'`)).rows[0].n;
const attempt = async (sql, params) => { try { return { ok: true, res: await c.query(sql, params) }; } catch (e) { return { ok: false, err: String(e.message || e) }; } };
const sp = async (name, fn) => { await c.query('SAVEPOINT ' + name); const r = await fn(); await c.query('ROLLBACK TO SAVEPOINT ' + name); return r; };
const FOUR_ARG = readFileSync(new URL('../supabase/migrations/0112_store_calendar_links_corrections.sql', import.meta.url), 'utf8');
const fourArgDef = FOUR_ARG.slice(FOUR_ARG.indexOf('CREATE OR REPLACE FUNCTION public.store_calendar_link_issue('), FOUR_ARG.indexOf('-- Revoke', FOUR_ARG.indexOf('CREATE OR REPLACE FUNCTION public.store_calendar_link_issue(')) > 0 ? FOUR_ARG.indexOf('-- Revoke', FOUR_ARG.indexOf('CREATE OR REPLACE FUNCTION public.store_calendar_link_issue(')) : FOUR_ARG.indexOf('CREATE OR REPLACE FUNCTION public.store_calendar_link_revoke('));

const live = { col: await hasCol(), args: await issueArgs(), ledger: await ledger() };
console.log('live before:', JSON.stringify(live));
await c.query('BEGIN');
try {
  if (live.col || live.ledger || !live.args.every(a => a.split(',').length === 4)) {
    await c.query(`ALTER TABLE public.store_calendar_links DROP COLUMN IF EXISTS token_enc; DROP FUNCTION IF EXISTS public.store_calendar_link_issue(uuid, uuid, text, text, text); DELETE FROM supabase_migrations.schema_migrations WHERE version = '0113';`);
    await c.query(fourArgDef);
  }
  ok('0. production shape: no token_enc, the four-argument issue only, 0113 absent', !(await hasCol()) && (await issueArgs()).length === 1 && (await issueArgs())[0].split(',').length === 4 && (await ledger()) === 0, JSON.stringify(await issueArgs()));
  // a link recorded before 0113, and a retailer without a feed key
  // a throwaway store for the rehearsal (the test project holds no retailers at rest); it goes with the outer rollback
  const r = (await c.query(`insert into public.retailers (slug, name) values ('rehearsal-0113-' || substr(md5(random()::text), 1, 8), 'Rehearsal 0113') returning id`)).rows[0];
  const hOld = 'c'.repeat(64);
  await c.query(`select * from public.store_calendar_link_issue($1, null, $2, 'rehearsal@fixture.test')`, [r.id, hOld]);
  await c.query(`update public.retailers set cal_feed_key = null where id = $1`, [r.id]);

  const e1 = await sp('s1', () => attempt(guardOnly.replace(/IS DISTINCT FROM '[a-z-]+'/, "IS DISTINCT FROM 'production'").replace(/not [a-z-]+\. STOP/, 'not production. STOP')));
  ok('1. the guard with identity production refuses on this database', !e1.ok && /CUTOVER GUARD: this database identifies as/.test(e1.err), e1.err || 'no error');

  const e2 = await sp('s2', () => attempt(body.replace("INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('0113', 'store_calendar_persistent_links');", 'SELECT 1/0;')));
  ok('2. a failure at the very end leaves nothing behind (column, function and ledger are one unit)', !e2.ok && /division by zero/.test(e2.err) && !(await hasCol()) && (await issueArgs())[0].split(',').length === 4 && (await ledger()) === 0, e2.err || 'no error');

  await c.query('SAVEPOINT s3');
  const e3 = await attempt(body);
  ok('3a. the paste body runs clean', e3.ok, e3.err || '');
  const v = (await c.query(verifySql)).rows[0];
  ok('3b. verify row: OK 0113 RECORDED, token_enc present, one five-argument issue, service_role may issue, anon may not issue or read, no retailer without a feed key, the pre-0113 link active with token_enc NULL', v && v.result === 'OK 0113 RECORDED' && v.token_enc_present_expect_true === true && v.issue_functions_expect_1 === '1' && String(v.issue_args_expect_five).split(',').length === 5 && v.service_role_issue_expect_true === true && v.anon_issue_expect_false === false && v.anon_select_expect_false === false && v.retailers_without_feed_key_expect_0 === '0' && Number(v.active_links_recorded_before_0113_show_as_rotate) >= 1, JSON.stringify(v));
  const resOld = await attempt(`select * from public.store_calendar_link_resolve($1)`, [hOld]);
  ok('3c. the link recorded before 0113 still resolves (resolve unchanged) and carries token_enc NULL', resOld.ok && resOld.res.rows.length === 1 && (await c.query(`select token_enc from public.store_calendar_links where token_hash = $1`, [hOld])).rows[0].token_enc === null);
  const hNew = 'd'.repeat(64), sealed = 'v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB.CCCCCCCCCCCCCCCCCCCCCC';
  const iNew = await attempt(`select * from public.store_calendar_link_issue($1, null, $2, $3, 'rehearsal@fixture.test')`, [r.id, hNew, sealed]);
  const resOldAfter = await attempt(`select * from public.store_calendar_link_resolve($1)`, [hOld]);
  ok('3d. the five-argument issue records hash and seal and retires the pre-0113 link of the same scope', iNew.ok && iNew.res.rows[0].token_hash === hNew && iNew.res.rows[0].token_enc === sealed && resOldAfter.ok && resOldAfter.res.rows.length === 0, iNew.err || '');
  const bad = await sp('s3bad', () => attempt(`select * from public.store_calendar_link_issue($1, null, $2, 'not-a-seal', 'rehearsal@fixture.test')`, [r.id, 'e'.repeat(64)]));
  const four = await sp('s3four', () => attempt(`select * from public.store_calendar_link_issue($1, null, $2, 'rehearsal@fixture.test')`, [r.id, 'f'.repeat(64)]));
  ok('3e. a malformed seal is refused (token_enc_shape); the four-argument form no longer exists', !bad.ok && /token_enc_shape/.test(bad.err) && !four.ok && /does not exist/.test(four.err), (bad.err || '') + ' | ' + (four.err || ''));
  const key = (await c.query(`select cal_feed_key from public.retailers where id = $1`, [r.id])).rows[0].cal_feed_key;
  ok('3f. the retailer without a feed key got a 32-hex one', /^[0-9a-f]{32}$/.test(key || ''), String(key));

  const e4 = await sp('s4', () => attempt(body));
  ok('4. running the paste again: the guard refuses (0113 in the ledger) and nothing changes', !e4.ok && /0113 is already in the ledger/.test(e4.err) && (await ledger()) === 1 && (await hasCol()), e4.err || 'no error');
  await c.query('ROLLBACK TO SAVEPOINT s3');
} finally {
  await c.query('ROLLBACK');
}
const after = { col: await hasCol(), args: await issueArgs(), ledger: await ledger() };
ok('5. after the outer rollback the live objects are exactly as before', JSON.stringify(after) === JSON.stringify(live), JSON.stringify({ live, after }));
console.log(`\n0113 paste rehearsal: ${pass} passed, ${fail} failed (test project left as found)`);
await c.end();
process.exit(fail ? 1 : 0);
