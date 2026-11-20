// tools/rehearse-0121-0122-paste.mjs (2026-11-19, Codex multi-brand review, finding 4): the PRODUCTION-SHAPED guarded
// paste for 0121 + 0122 rehearsed on the disposable database chain_parity_check inside demohub-rebuild-check.
//   1. wrong environment: the chain is built to 0120 and identifies as staging: the production kit is refused
//   2. missing predecessor: the chain is built only to 0119 and identifies as production: refused
//   3. failure rolls everything back: on a production-shaped chain at 0120, one email is made to own two brands, so the
//      0121 precondition raises in the middle of the transaction: the ledger, the indexes and the functions are unchanged
//   4. the paste applies; the verify row is printed
//   5. a second paste is refused
//   6. the window Codex asked about, on the pasted schema, with NO new code: a direct insert of a booker row (what the
//      build live before the release does) is refused for an address that owns a brand, for an address that is a booker
//      elsewhere and for a second booker on a brand; sign-up for a new address still creates a brand; a pending
//      invitation still blocks sign-up; an existing owner still signs in to their own brand
// Refuses any database other than chain_parity_check on demohub-rebuild-check. Nothing here touches public or production.
// Usage: node tools/rehearse-0121-0122-paste.mjs <chain_parity_check url> <kit path>
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const [url, kitPath] = process.argv.slice(2);
if (!url || !/tileejdviuvijumjeplv/.test(url) || !/\/chain_parity_check(\?|$)/.test(url)) { console.error('REFUSING: not chain_parity_check on demohub-rebuild-check'); process.exit(2); }
if (!kitPath) { console.error('usage: <url> <kit>'); process.exit(2); }
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (extra ? ' ' + String(extra).slice(0, 400) : '')); } };
const raw = readFileSync(kitPath, 'utf8').replace(/\r\n/g, '\n');
const cut = raw.indexOf('-- ======================= verify (read-only)');
const kit = { paste: raw.slice(0, cut), verify: raw.slice(cut) };
const build = (upto) => { const b = spawnSync(process.execPath, ['tools/clean-chain-build.mjs', 'build', url, upto], { encoding: 'utf8' }); return { ok: b.status === 0, tail: (b.stdout || '').trim().split('\n').slice(-1)[0], err: (b.stderr || '').slice(-300) }; };
const connect = async () => { const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } }); await c.connect(); return c; };
const attempt = async (c, sql, params) => { try { const r = await c.query(sql, params); return { ok: true, r }; } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} return { ok: false, err: String(e.message || e), code: e.code }; } };
const identity = (c, env) => c.query("select public.set_deployment_identity($1, 'tileejdviuvijumjeplv', 'paste rehearsal on the disposable database; the ref is the test project, the environment word is what the kit checks')", [env]);
const state = async (c) => (await c.query(`select
  (select string_agg(version, ',' order by version) from supabase_migrations.schema_migrations where version >= '0119') as ledger,
  (select count(*)::int from pg_indexes where schemaname = 'public' and indexname in ('brand_members_one_identity_idx','brand_members_one_booker_idx')) as old_indexes,
  (select to_regclass('public.brand_access_requests') is not null) as requests_table,
  (select count(*)::int from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname like 'brand_access%') as new_fns,
  (select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname = 'redeem_brand_signup') as redeem_md5`)).rows[0];

console.log('1. wrong environment');
let b = build('0120'); ok('chain 0000..0120 built from empty', b.ok, b.err);
let c = await connect();
await identity(c, 'staging');
const eEnv = await attempt(c, kit.paste);
ok('a database that identifies as staging refuses the production kit', !eEnv.ok && /identifies as staging, not production/.test(eEnv.err), eEnv.err || 'no error');
await c.end();

console.log('2. missing predecessor');
b = build('0119'); ok('chain rebuilt only to 0119', b.ok, b.err);
c = await connect(); await identity(c, 'production');
const ePred = await attempt(c, kit.paste);
ok('without 0120 in the ledger the kit is refused', !ePred.ok && /0120 is not in the ledger/.test(ePred.err), ePred.err || 'no error');
await c.end();

console.log('3. a failure in the middle rolls everything back');
b = build('0120'); ok('chain rebuilt to 0120 (production tail)', b.ok, b.err);
c = await connect(); await identity(c, 'production');
const mk = async (email, name) => (await c.query('insert into brands (email, company_name, is_verified) values ($1, $2, true) returning id', [email, name])).rows[0].id;
const b1 = await mk('owner-one@fixture.test', 'Rehearsal One'), b2 = await mk('owner-two@fixture.test', 'Rehearsal Two');
await c.query("insert into brand_members (brand_id, email, role) values ($1, 'owner-one@fixture.test', 'owner'), ($2, 'owner-two@fixture.test', 'owner')", [b1, b2]);
// make the 0121 precondition fail: one address owning two brands (the one-identity index must step aside for the setup only)
await c.query('drop index brand_members_one_identity_idx');
await c.query("update brand_members set email = 'owner-one@fixture.test' where brand_id = $1 and role = 'owner'", [b2]);
await c.query("create unique index brand_members_one_identity_idx on brand_members (lower(email)) where status in ('pending','accepted') and false");   // placeholder with the same name so the kit's own DROP has something to drop
const before = await state(c);
const eMid = await attempt(c, kit.paste);
const after = await state(c);
ok('the paste raises on the precondition (one address owns two brands)', !eMid.ok && /own more than one brand/.test(eMid.err), eMid.err || 'no error');
ok('and NOTHING changed: ledger, indexes, table, functions and the sign-in function are exactly as before', JSON.stringify(before) === JSON.stringify(after) && after.ledger === '0119,0120' && after.requests_table === false, JSON.stringify(after));
// put the fixture right again and restore the real index definition, as on production
await c.query("update brand_members set email = 'owner-two@fixture.test' where brand_id = $1 and role = 'owner'", [b2]);
await c.query('drop index brand_members_one_identity_idx');
await c.query("create unique index brand_members_one_identity_idx on brand_members (lower(email)) where status in ('pending','accepted')");
// a pending booker made the way the live build makes one, BEFORE the paste (a durable record that crosses the release)
const pendingBefore = (await c.query("insert into brand_members (brand_id, email, role, status, invited_by_email) values ($1, 'rep-before@fixture.test', 'booker', 'pending', 'owner-one@fixture.test') returning id", [b1])).rows[0].id;

console.log('4. the paste applies');
const a = await attempt(c, kit.paste);
ok('the production kit applies on the production-shaped database', a.ok, a.err || '');
const v = a.ok ? (await c.query(kit.verify)).rows[0] : null;
console.log('   verify row:', JSON.stringify(v));
ok('verify: both recorded, old indexes gone, ten new functions, three writers take the email lock, the trigger carries the direct-write rules, no rows added', v && v.result === 'OK 0121 0122 RECORDED' && /0121,0122$/.test(v.ledger_from_0118_expect_0122_last) && String(v.old_indexes_expect_0) === '0' && String(v.one_owned_brand_index_expect_1) === '1'
  && String(v.new_functions_expect_10) === '10' && String(v.writers_taking_the_email_lock_expect_3) === '3' && v.direct_write_rules_in_trigger_expect_true === true && String(v.requests_expect_0) === '0' && String(v.full_access_rows_expect_0) === '0' && String(v.membership_rows_unchanged) === '3', JSON.stringify(v));

console.log('5. a second paste');
const again = await attempt(c, kit.paste);
ok('a second paste is refused by the guard', !again.ok && /already in the ledger/.test(again.err), again.err || 'no error');

console.log('6. the old build against the new schema (no new code involved)');
const direct = (brand, email, role = 'booker') => attempt(c, "insert into brand_members (brand_id, email, role, status, invited_by_email) values ($1, $2, $3, 'pending', 'x@fixture.test') returning id", [brand, email, role]);
const d1 = await direct(b2, 'OWNER-ONE@fixture.test');
ok('a direct booker insert for an address that owns a brand is refused (as the dropped trigger rule did)', !d1.ok && d1.code === '23505', d1.err || 'inserted');
const d2 = await direct(b2, ' Rep-Before@fixture.test ');
ok('a direct booker insert for an address that is already another brand\'s booker is refused (as the dropped index did)', !d2.ok && d2.code === '23505', d2.err || 'inserted');
const d3 = await direct(b1, 'second-rep@fixture.test');
ok('a direct second booker on a brand is refused (as the dropped index did)', !d3.ok && d3.code === '23505', d3.err || 'inserted');
const d4 = await direct(b2, 'fresh-rep@fixture.test');
ok('a direct booker insert that the old rules allow still works (the old build keeps working)', d4.ok, d4.err || '');
const d5 = await direct(b2, 'never@fixture.test', 'manager');
ok('no direct insert can create a Full access row', !d5.ok && d5.code === '23514', d5.err || 'inserted');
const redeem = async (email) => { await c.query("insert into email_verifications (email, purpose, code_hash, payload, expires_at) values ($1, 'brand_signup', 'h', '{\"company_name\":\"New Co\"}'::jsonb, now() + interval '30 minutes')", [email]); return (await c.query("select redeem_brand_signup($1, 'h', $2, 30, 6) as r", [email, 'sess-' + Math.random().toString(36).slice(2)])).rows[0].r; };
const r1 = await redeem('brand-new@fixture.test');
ok('sign-up for a new address still creates a brand and its owner row', r1.outcome === 'ok' && r1.created === true && (await c.query("select count(*)::int n from brand_members where email = 'brand-new@fixture.test' and role = 'owner'")).rows[0].n === 1, JSON.stringify(r1));
const r2 = await redeem('rep-before@fixture.test');
ok('the invitation made before the paste still blocks sign-up from creating a brand (invite_pending)', r2.outcome === 'invite_pending' && (await c.query("select count(*)::int n from brands where email = 'rep-before@fixture.test'")).rows[0].n === 0, JSON.stringify(r2));
const r3 = await redeem('owner-one@fixture.test');
ok('an existing owner still signs in to their own brand', r3.outcome === 'ok' && r3.created === false && r3.brand_id === b1, JSON.stringify(r3));
const sess = (await c.query("select count(*)::int n from brand_account_sessions where email = 'owner-one@fixture.test' and brand_id = $1", [b1])).rows[0].n;
ok('and gets a session row for it', sess === 1);
const st = (await c.query('select status from brand_members where id = $1', [pendingBefore])).rows[0].status;
ok('the invitation made before the paste is untouched (still pending, still acceptable through its own link)', st === 'pending');
await c.end();
console.log(`\nrehearsal 0121 + 0122: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
