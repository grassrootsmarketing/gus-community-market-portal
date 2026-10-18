// tools/rehearse-booker-paste.mjs (2026-10-17): rehearsal of the combined 0097 + 0098 + 0100 + 0101 booker paste on demohub-rebuild-check ONLY.
// Three guard refusals, each proven to leave the database exactly as it was (a fingerprint of the ledger, the
// membership columns and indexes, the invites table and the attribution columns is taken before and after):
//   1. the production-identity guard (this database is not production)
//   2. the "0097, 0098, 0100 or 0101 already in the ledger" guard (identity relaxed to this database's, all present here)
//   3. a forced failure inside the body: with the ledger rows for 0097 to 0101 temporarily absent inside a transaction that is
//      rolled back, the paste reaches the migration's own precondition and stops when a non-owner membership row is
//      planted, leaving nothing behind
// The forward run itself happened on this database when 0097 and 0098 were applied here (see the ledger rows).
import pg from 'pg';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const { Client } = pg;
const url = process.env.SB_DB_URL || '';
if (!url.includes('tileejdviuvijumjeplv')) { console.error('refusing: SB_DB_URL is not demohub-rebuild-check'); process.exit(2); }
const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } }); await c.connect();
let pass = 0, fail = 0; const ok = (n, cond, d) => { if (cond) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? ' ' + d : '')); } };
const fp = async () => {
  const q = async (s) => JSON.stringify((await c.query(s)).rows);
  return [await q(`select version from supabase_migrations.schema_migrations where version >= '0090' order by version`),
    await q(`select column_name from information_schema.columns where table_name = 'brand_booker_invites' order by column_name`),
    await q(`select proname from pg_proc where proname in ('booker_accept','booker_invite_issue','booker_invite_code_set','booking_create_as_member','agreement_policy_hash') order by proname`),
    await q(`select column_name from information_schema.columns where table_name = 'brand_members' order by column_name`),
    await q(`select indexname from pg_indexes where tablename = 'brand_members' order by indexname`),
    await q(`select to_regclass('public.brand_booker_invites')::text`),
    await q(`select column_name from information_schema.columns where table_name in ('bookings','demos') and column_name like 'booked_by%' order by table_name, column_name`),
    await q(`select count(*)::int from brand_members`)].join('|');
};
const kitFor = (identity) => { const out = 'C:/Users/David/Documents/Codex/cutover-kit/_rehearsal-booker-' + identity + '.sql'; execFileSync('node', ['tools/make-booker-paste.mjs', identity, out]); return readFileSync(out, 'utf8'); };
const env = (await c.query(`select environment from get_deployment_identity()`)).rows[0].environment;
console.log('this database identifies as:', env);
const before = await fp();

// 1. production identity guard
try { await c.query('begin'); await c.query(kitFor('production')); await c.query('rollback'); ok('1 production-identity guard', false, 'paste ran'); }
catch (e) { await c.query('rollback'); ok('1 the production-identity guard refuses on this database: ' + e.message.split('\n')[0].slice(0, 80), /CUTOVER GUARD: this database identifies as/.test(e.message)); }
ok('1b nothing changed', (await fp()) === before);

// 2. already-applied guard (identity relaxed)
try { await c.query('begin'); await c.query(kitFor(env)); await c.query('rollback'); ok('2 already-applied guard', false, 'paste ran'); }
catch (e) { await c.query('rollback'); ok('2 with the identity relaxed, the "0097, 0098, 0100 or 0101 already in the ledger" guard refuses: ' + e.message.split('\n')[0].slice(0, 80), /0097, 0098, 0100 or 0101 is already in the ledger/.test(e.message)); }
ok('2b nothing changed', (await fp()) === before);

// 3. forced failure inside the body, everything rolled back
try {
  await c.query('begin');
  await c.query(`delete from supabase_migrations.schema_migrations where version in ('0097','0098','0100','0101')`);
  // the objects exist here, so the object guards would refuse; strip them to reach the body's own precondition
  const body = kitFor(env).replace(/IF n <> 0 THEN RAISE EXCEPTION 'CUTOVER GUARD: brand_members already has[^\n]*\n/, '').replace(/IF to_regclass\('public\.brand_booker_invites'\) IS NOT NULL[^\n]*\n/, '').replace(/IF n <> 0 THEN RAISE EXCEPTION 'CUTOVER GUARD: % attribution column\(s\)[^\n]*\n/, '');
  // plant a non-owner membership row so the migration's first precondition fires
  const brand = (await c.query(`select id from brands where email is not null limit 1`)).rows[0];
  await c.query(`insert into brand_members (brand_id, email, name, role, status, accepted_at) values ($1, 'planted-rehearsal@fixture.test', 'Planted', 'booker', 'accepted', now())`, [brand.id]);
  const inner = body.replace(/^BEGIN;\s*/m, '').replace(/\nCOMMIT;[\s\S]*$/, '');   // run inside OUR transaction
  await c.query('savepoint sp');
  let failed = null;
  try { await c.query(inner); } catch (e) { failed = e.message; await c.query('rollback to savepoint sp'); }
  ok('3 a planted non-owner membership row stops the body at the migration precondition: ' + String(failed || '').split('\n')[0].slice(0, 90), /0097 precondition/.test(String(failed || '')));
  await c.query('rollback');
} catch (e) { await c.query('rollback'); ok('3 forced failure rehearsal ran', false, e.message); }
ok('3b nothing changed after the rolled-back rehearsal', (await fp()) === before);
await c.end();
console.log(`\nbooker paste (0097 + 0098 + 0100 + 0101) rehearsal: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
