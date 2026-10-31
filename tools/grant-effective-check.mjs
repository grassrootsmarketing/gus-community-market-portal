// tools/grant-effective-check.mjs (2026-10-31, Codex connected checkout round 5, grants wording): the catalog allowlist
// (tools/clean-chain-build.mjs grant-allowlist) tolerates EXECUTE grants to service_role that exist only on the Supabase
// project. This tool states what those differences MEAN: for every allowlisted function, and for every function the api
// calls through PostgREST rpc, it reads the EFFECTIVE privileges (has_function_privilege for service_role, anon and
// authenticated, and whether PUBLIC holds EXECUTE) on two databases and classifies each function (trigger function,
// helper called only from other SQL functions, or called by the api). It fails when a function the api calls is not
// executable by service_role on database A (the project the api runs against), or when anon or authenticated can
// execute a function on one database and not the other (an exposure difference). Read-only. Prints no secret.
// Usage: node tools/grant-effective-check.mjs <allowlist.json> <url A: the project> <url B: clean chain or paste path> <out.json>
import pg from 'pg';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
const [allowPath, urlA, urlB, outPath] = process.argv.slice(2);
if (!allowPath || !urlA || !urlB || !outPath) { console.error('usage: <allowlist.json> <url A> <url B> <out.json>'); process.exit(2); }
for (const u of [urlA, urlB]) { if (!/tileejdviuvijumjeplv/.test(u) || /dkgjvsstbgnhcfboqqnd/.test(u)) { console.error('REFUSING: both databases must be on demohub-rebuild-check (public or chain_parity_check)'); process.exit(2); } }
const allow = JSON.parse(readFileSync(allowPath, 'utf8'));
const read = (d, re) => readdirSync(d).filter(f => re.test(f)).map(f => readFileSync(d + '/' + f, 'utf8')).join('\n');
const api = read('api', /\.js$/);
const apiCalled = new Set();
for (const m of api.matchAll(/(?:sbRpc|rpc|sbRpcQuiet)\((?:[A-Za-z_]+,\s*)?['"]([a-z_]+)['"]/g)) apiCalled.add(m[1]);
for (const m of api.matchAll(/rest\/v1\/rpc\/([a-z_]+)/g)) apiCalled.add(m[1]);
const migDir = 'supabase/migrations';
const migs = readdirSync(migDir).filter(f => /\.sql$/.test(f)).map(f => readFileSync(migDir + '/' + f, 'utf8')).join('\n');
const isTrigger = (n) => new RegExp('EXECUTE (FUNCTION|PROCEDURE) (public\\.)?' + n + '\\s*\\(', 'i').test(migs);
const names = [...new Set([...allow.grants.map(g => g.routine), ...apiCalled])].sort();
const sql = `
select p.proname, pg_get_function_identity_arguments(p.oid) args, p.prosecdef secdef, p.prorettype = 'trigger'::regtype returns_trigger,
       has_function_privilege('service_role', p.oid, 'EXECUTE') service_role,
       has_function_privilege('anon', p.oid, 'EXECUTE') anon,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') authenticated,
       exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') public_execute,
       p.proacl is null acl_is_postgres_default
  from pg_proc p join pg_namespace s on s.oid = p.pronamespace
 where s.nspname = 'public' and p.proname = any($1::text[]) order by 1, 2`;
async function snap(url) {
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } }); await c.connect();
  const rows = (await c.query(sql, [names])).rows;
  const dflt = (await c.query(`select r.rolname, array_to_string(d.defaclacl, ',') acl from pg_default_acl d left join pg_roles r on r.oid = d.defaclrole where d.defaclobjtype = 'f' and d.defaclnamespace in (0, 'public'::regnamespace)`)).rows;
  const ledger = (await c.query("select string_agg(version, ',' order by version) v from supabase_migrations.schema_migrations where version >= '0115'")).rows[0].v;
  await c.end();
  return { database: new URL(url).pathname.slice(1), ledger_from_0115: ledger, default_function_acl: dflt, rows };
}
const A = await snap(urlA), B = await snap(urlB);
const key = (r) => `${r.proname}(${r.args})`;
const mb = new Map(B.rows.map(r => [key(r), r]));
const functions = []; const failures = [];
for (const a of A.rows) {
  const b = mb.get(key(a)) || null;
  const n = a.proname;
  const cls = a.returns_trigger || isTrigger(n) ? 'trigger function (fired by a table trigger; PostgREST does not expose functions returning trigger)'
    : apiCalled.has(n) ? 'called by the api through rpc as service_role'
    : 'helper called only from other SQL functions or triggers (the api never names it)';
  const row = { function: key(a), class: cls, allowlisted: allow.grants.some(g => g.routine === n), api_called: apiCalled.has(n), security_definer: a.secdef,
    A: { service_role: a.service_role, anon: a.anon, authenticated: a.authenticated, public_execute: a.public_execute, acl_is_postgres_default: a.acl_is_postgres_default },
    B: b ? { service_role: b.service_role, anon: b.anon, authenticated: b.authenticated, public_execute: b.public_execute, acl_is_postgres_default: b.acl_is_postgres_default } : null };
  row.difference = !b ? 'absent on B' : (a.service_role !== b.service_role ? `service_role EXECUTE: A ${a.service_role}, B ${b.service_role}` : (a.anon !== b.anon || a.authenticated !== b.authenticated ? 'anon/authenticated differ' : 'none (effective privileges equal)'));
  if (apiCalled.has(n) && !a.service_role) failures.push(`api-called ${key(a)} is NOT executable by service_role on A`);
  if (b && (a.anon !== b.anon || a.authenticated !== b.authenticated)) failures.push(`exposure differs for ${key(a)}: anon A ${a.anon} B ${b.anon}, authenticated A ${a.authenticated} B ${b.authenticated}`);
  functions.push(row);
}
const summary = {
  total: functions.length,
  allowlisted: functions.filter(f => f.allowlisted).length,
  api_called_all_executable_by_service_role_on_A: functions.filter(f => f.api_called).every(f => f.A.service_role),
  by_class: Object.fromEntries(['trigger', 'called by the api', 'helper'].map(k => [k, functions.filter(f => f.class.startsWith(k)).length])),
  anon_or_authenticated_executable_on_A: functions.filter(f => f.A.anon || f.A.authenticated).map(f => f.function),
  anon_or_authenticated_executable_on_B: functions.filter(f => f.B && (f.B.anon || f.B.authenticated)).map(f => f.function),
  service_role_difference: functions.filter(f => f.B && f.A.service_role !== f.B.service_role).map(f => f.function),
};
writeFileSync(outPath, JSON.stringify({ generated_at: new Date().toISOString(), allowlist: allowPath, A: { database: A.database, ledger_from_0115: A.ledger_from_0115, default_function_acl: A.default_function_acl }, B: { database: B.database, ledger_from_0115: B.ledger_from_0115, default_function_acl: B.default_function_acl }, summary, failures, functions }, null, 2) + '\n');
console.log(`A ${A.database} (ledger ${A.ledger_from_0115}) vs B ${B.database} (ledger ${B.ledger_from_0115}): ${functions.length} functions (${summary.allowlisted} allowlisted, ${functions.filter(f => f.api_called).length} api-called)`);
console.log('by class:', JSON.stringify(summary.by_class));
console.log('service_role EXECUTE differs on:', summary.service_role_difference.length, 'function(s)');
console.log('anon/authenticated can execute on A:', summary.anon_or_authenticated_executable_on_A.length, '| on B:', summary.anon_or_authenticated_executable_on_B.length);
for (const f of functions) console.log(`  ${f.A.service_role ? 'svcA' : '    '} ${f.B && f.B.service_role ? 'svcB' : '    '} ${f.A.anon ? 'anon' : '    '} ${f.A.public_execute ? 'PUBLIC' : '      '} ${f.api_called ? 'API' : '   '} ${f.class.split(' ')[0].padEnd(7)} ${f.function}`.slice(0, 170));
if (failures.length) { console.log('FAILURES:'); for (const f of failures) console.log('  ' + f); }
process.exit(failures.length ? 1 : 0);
