// tools/clean-chain-build.mjs (2026-10-30, Codex connected-checkout review, bounded condition "migration parity"):
// builds the COMMITTED migration chain from empty into a disposable database and dumps a catalog snapshot, so the
// hand-repaired test database can be compared against a clean build. Two commands:
//
//   node tools/clean-chain-build.mjs build <db-url> [upto]   drop everything in public, create the platform stubs a
//       Supabase project provides (supabase_migrations ledger, auth.uid(), storage buckets/objects, extensions schema),
//       run supabase/migrations in numeric order up to <upto> (default: all), record the ledger rows the official
//       runner would, and print the first failure if any.
//   node tools/clean-chain-build.mjs snapshot <db-url> <out.json>   dump public tables, columns, constraints, indexes,
//       triggers, function definitions (normalised) and function grants to JSON.
//   node tools/clean-chain-build.mjs diff <a.json> <b.json>         print the differences.
//
// Safety: the database URL must point at a database named chain_parity_check on demohub-rebuild-check (the disposable
// database created for this review), or at a localhost server. Any other target is refused: this tool DROPS the public
// schema of the database it builds into.
import pg from 'pg';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [cmd, a1, a2] = process.argv.slice(2);
const DIR = 'supabase/migrations';
function guard(url) {
  const u = new URL(url);
  const db = u.pathname.replace(/^\//, '');
  const local = ['localhost', '127.0.0.1'].includes(u.hostname);
  const disposable = /tileejdviuvijumjeplv/.test(url) && db === 'chain_parity_check';
  if (!local && !disposable) { console.error('REFUSING: not the disposable chain_parity_check database on demohub-rebuild-check and not localhost'); process.exit(2); }
  if (/dkgjvsstbgnhcfboqqnd/.test(url)) { console.error('REFUSING: production'); process.exit(2); }
}
async function client(url) { const c = new pg.Client({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } }); await c.connect(); return c; }

const STUBS = `
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_stat_statements with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role', true), '')::text $$;
create schema if not exists storage;
create table if not exists storage.buckets (id text primary key, name text not null, owner uuid, public boolean default false, created_at timestamptz default now(), updated_at timestamptz default now(), avif_autodetection boolean default false, file_size_limit bigint, allowed_mime_types text[]);
create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text, owner uuid, created_at timestamptz default now(), updated_at timestamptz default now(), last_accessed_at timestamptz default now(), metadata jsonb, path_tokens text[]);
alter table storage.objects enable row level security;
alter table storage.buckets enable row level security;
grant usage on schema storage to anon, authenticated, service_role;
grant all on storage.buckets, storage.objects to anon, authenticated, service_role;
`;

async function build(url, upto) {
  guard(url);
  let c = await client(url);
  const files = readdirSync(DIR).filter(f => /^\d{4,}_.*\.sql$/.test(f)).sort().filter(f => !upto || f.slice(0, 4) <= upto);
  await c.query('drop schema if exists public cascade; create schema public; grant usage on schema public to anon, authenticated, service_role; grant all on schema public to postgres;');
  await c.query('drop schema if exists supabase_migrations cascade; drop schema if exists storage cascade; drop schema if exists auth cascade;');
  await c.query("alter database " + new URL(url).pathname.slice(1) + " set search_path = public, extensions");
  await c.end(); c = await client(url);
  await c.query(STUBS);
  const results = [];
  for (const f of files) {
    const sql = readFileSync(join(DIR, f), 'utf8');
    const own = /^\s*begin;/im.test(sql);
    const t0 = Date.now();
    try {
      if (own) await c.query(sql); else { await c.query('begin'); await c.query(sql); await c.query('commit'); }
      await c.query('insert into supabase_migrations.schema_migrations (version, name) values ($1, $2) on conflict (version) do nothing', [f.slice(0, 4), f.slice(5, -4)]);
      results.push({ file: f, ok: true, ms: Date.now() - t0 });
    } catch (e) {
      try { await c.query('rollback'); } catch (_) {}
      results.push({ file: f, ok: false, error: String(e.message).slice(0, 300) });
      console.log('FAILED at', f, ':', String(e.message).slice(0, 300));
      break;
    }
  }
  const okCount = results.filter(r => r.ok).length;
  console.log(`applied ${okCount} of ${files.length} migrations`);
  const ledger = (await c.query("select string_agg(version, ',' order by version) v from supabase_migrations.schema_migrations")).rows[0].v;
  console.log('ledger tail:', String(ledger || '').split(',').slice(-3).join(','));
  await c.end();
  process.exit(okCount === files.length ? 0 : 1);
}

const NORMALISE = (s) => String(s).replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n{2,}/g, '\n').trim();
async function snapshot(url, out) {
  const c = await client(url);
  const q = async (sql) => (await c.query(sql)).rows;
  const snap = {};
  snap.columns = await q(`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema='public' order by table_name, ordinal_position`);
  snap.constraints = await q(`select conrelid::regclass::text as table_name, conname, pg_get_constraintdef(oid) as def from pg_constraint where connamespace='public'::regnamespace order by 1,2`);
  snap.indexes = await q(`select tablename, indexname, indexdef from pg_indexes where schemaname='public' order by 1,2`);
  snap.triggers = await q(`select tgrelid::regclass::text as table_name, tgname, pg_get_triggerdef(oid) as def from pg_trigger where not tgisinternal and tgrelid in (select oid from pg_class where relnamespace='public'::regnamespace) order by 1,2`);
  snap.functions = (await q(`select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig, pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' order by 1`)).map(r => ({ sig: r.sig, def: NORMALISE(r.def) }));
  snap.function_grants = await q(`select routine_name, grantee, privilege_type from information_schema.routine_privileges where specific_schema='public' order by 1,2,3`);
  snap.policies = await q(`select tablename, policyname, cmd, roles::text, qual, with_check from pg_policies where schemaname='public' order by 1,2`);
  snap.rls = await q(`select relname, relrowsecurity from pg_class where relnamespace='public'::regnamespace and relkind='r' order by 1`);
  snap.ledger = (await q(`select version from supabase_migrations.schema_migrations order by version`)).map(r => r.version);
  writeFileSync(out, JSON.stringify(snap, null, 1));
  console.log('snapshot written', out, Object.fromEntries(Object.entries(snap).map(([k, v]) => [k, v.length])));
  await c.end();
}

function diff(aPath, bPath) {
  const A = JSON.parse(readFileSync(aPath, 'utf8')), B = JSON.parse(readFileSync(bPath, 'utf8'));
  let total = 0;
  const keyOf = { columns: r => `${r.table_name}.${r.column_name}`, constraints: r => `${r.table_name}.${r.conname}`, indexes: r => `${r.tablename}.${r.indexname}`, triggers: r => `${r.table_name}.${r.tgname}`, functions: r => r.sig, function_grants: r => `${r.routine_name}:${r.grantee}:${r.privilege_type}`, policies: r => `${r.tablename}.${r.policyname}`, rls: r => r.relname };
  for (const [section, kf] of Object.entries(keyOf)) {
    const ma = new Map(A[section].map(r => [kf(r), JSON.stringify(r)])), mb = new Map(B[section].map(r => [kf(r), JSON.stringify(r)]));
    const onlyA = [...ma.keys()].filter(k => !mb.has(k)), onlyB = [...mb.keys()].filter(k => !ma.has(k)), changed = [...ma.keys()].filter(k => mb.has(k) && ma.get(k) !== mb.get(k));
    total += onlyA.length + onlyB.length + changed.length;
    console.log(`${section}: ${ma.size} vs ${mb.size}; only in A ${onlyA.length}; only in B ${onlyB.length}; differing ${changed.length}`);
    for (const k of onlyA.slice(0, 40)) console.log('  only in A:', k);
    for (const k of onlyB.slice(0, 40)) console.log('  only in B:', k);
    for (const k of changed.slice(0, 40)) console.log('  differs:', k);
  }
  console.log('ledger A:', A.ledger.slice(-3).join(','), 'B:', B.ledger.slice(-3).join(','));
  console.log('TOTAL differences:', total);
  process.exit(total === 0 ? 0 : 1);
}

if (cmd === 'build') await build(a1, a2);
else if (cmd === 'snapshot') await snapshot(a1, a2);
else if (cmd === 'diff') diff(a1, a2);
else { console.error('usage: build <url> [upto] | snapshot <url> <out.json> | diff <a.json> <b.json>'); process.exit(2); }
