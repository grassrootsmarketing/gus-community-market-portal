-- supabase/manifest.sql
-- ============================================================================
-- A deterministic, read-only fingerprint of the built schema.
--
-- WHY THIS FILE EXISTS, STATED PLAINLY:
--   The previous clean-build job ran `supabase db query -f manifest.sql` when no such
--   file was tracked in the repository. The CLI failed; `tee` succeeded; the shell had
--   no `pipefail`, so the pipeline exited 0. The job then diffed two identical ERROR
--   MESSAGES and printed "A == B". The uploaded artifact was 266 bytes of
--   "failed to read SQL file: NotFound". A green check attested to nothing.
--
--   This file is half the fix. The other half is in the workflow, which must refuse to
--   treat a missing file, a non-zero exit, an empty result, or error text as success.
--
-- DETERMINISM RULES OBSERVED HERE:
--   * No timestamps anywhere. Not created_at, not updated_at, not inserted_at. One
--     timestamp would make every manifest differ from every other and destroy the
--     comparison this file exists to enable.
--   * No OIDs. They are assigned in creation order and are not stable across builds.
--   * Ordering is explicit and total; nothing relies on the planner returning rows in
--     the same order twice.
--   * Definitions are emitted VERBATIM (pg_get_functiondef, pg_get_indexdef,
--     pg_get_constraintdef, pg_get_expr). Ordering inside a definition is meaningful --
--     a policy USING clause with reordered predicates is a different policy -- so those
--     strings are never sorted or rewritten.
--
-- COVERAGE, matching the required list item for item:
--   1 schemas                      8 row-level security enablement AND force
--   2 tables                       9 policies: roles, command, using, with check
--   3 columns: type, nullability, 10 grants for anon/authenticated/service_role
--     default, identity, generated 11 execute privileges on public functions
--   4 constraints p/u/f/c         12 storage buckets
--   5 indexes                     13 applied migration history
--   6 functions (full body)       14 section counts as an empty-result tripwire
--   7 triggers
--
-- Read-only by construction: every branch below is a SELECT. This file must never be
-- placed in supabase/migrations/ -- tools/check-migrations.mjs now rejects anything
-- there that is not a numbered migration, which is what stops that mistake recurring.
-- ============================================================================

with

-- 1. SCHEMAS ----------------------------------------------------------------
s_schema as (
  select '01_schema' as section,
         n.nspname   as key,
         'schema ' || n.nspname as detail
  from pg_namespace n
  where n.nspname in ('public', 'storage', 'supabase_migrations')
),

-- 2. TABLES -----------------------------------------------------------------
s_table as (
  select '02_table' as section,
         c.relnamespace::regnamespace::text || '.' || c.relname as key,
         'table ' || c.relnamespace::regnamespace::text || '.' || c.relname
           || ' kind=' || c.relkind
           || ' persistence=' || c.relpersistence as detail
  from pg_class c
  where c.relkind in ('r', 'p', 'v', 'm')
    and c.relnamespace::regnamespace::text in ('public', 'storage')
),

-- 3. COLUMNS ----------------------------------------------------------------
-- Type, nullability, default, identity and generated status. This is the section that
-- would have caught the entire Step 4 defect class at build time: eight code paths
-- referenced columns that did not exist, and a table-name-only manifest cannot see that.
s_column as (
  select '03_column' as section,
         a.attrelid::regclass::text || '.' || a.attname as key,
         'column ' || a.attrelid::regclass::text || '.' || a.attname
           || ' type='      || format_type(a.atttypid, a.atttypmod)
           || ' notnull='   || a.attnotnull::text
           || ' identity='  || coalesce(nullif(a.attidentity,  ''), '-')
           || ' generated=' || coalesce(nullif(a.attgenerated, ''), '-')
           || ' default='   || coalesce(pg_get_expr(d.adbin, d.adrelid), '-') as detail
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where a.attnum > 0
    and not a.attisdropped
    and c.relkind in ('r', 'p', 'v', 'm')
    and c.relnamespace::regnamespace::text in ('public', 'storage')
),

-- 4. CONSTRAINTS ------------------------------------------------------------
-- p primary, u unique, f foreign key, c check. The predicate text IS the constraint,
-- so pg_get_constraintdef is emitted whole.
s_constraint as (
  select '04_constraint' as section,
         con.conrelid::regclass::text || '.' || con.conname as key,
         'constraint ' || con.conrelid::regclass::text || '.' || con.conname
           || ' type=' || con.contype
           || ' def='  || pg_get_constraintdef(con.oid) as detail
  from pg_constraint con
  join pg_class c on c.oid = con.conrelid
  where con.contype in ('p', 'u', 'f', 'c')
    and c.relnamespace::regnamespace::text in ('public', 'storage')
),

-- 5. INDEXES ----------------------------------------------------------------
s_index as (
  select '05_index' as section,
         schemaname || '.' || indexname as key,
         'index ' || schemaname || '.' || indexname || ' def=' || indexdef as detail
  from pg_indexes
  where schemaname in ('public', 'storage')
),

-- 6. FUNCTIONS --------------------------------------------------------------
-- The FULL definition. The Step 4 defects lived inside function bodies, and a manifest
-- listing only signatures reported two identically-broken builds as matching -- which
-- is exactly what happened in an earlier round and is why this emits the body.
s_function as (
  select '06_function' as section,
         p.pronamespace::regnamespace::text || '.' || p.proname
           || '(' || pg_get_function_identity_arguments(p.oid) || ')' as key,
         'function ' || p.pronamespace::regnamespace::text || '.' || p.proname
           || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           || ' security_definer=' || p.prosecdef::text
           || ' volatility='       || p.provolatile
           || ' body_md5='         || md5(pg_get_functiondef(p.oid)) as detail
  from pg_proc p
  where p.pronamespace::regnamespace::text in ('public', 'storage')
    and p.prokind = 'f'
),

-- 6b. FUNCTION BODIES -------------------------------------------------------
-- Emitted separately and verbatim so a drift in body_md5 above can be diagnosed from
-- the same artifact rather than requiring another database round trip. Newlines are
-- collapsed to a marker so each function stays on one line and the diff stays readable.
s_function_body as (
  select '06b_function_body' as section,
         p.pronamespace::regnamespace::text || '.' || p.proname
           || '(' || pg_get_function_identity_arguments(p.oid) || ')' as key,
         replace(replace(pg_get_functiondef(p.oid), E'\n', ' <NL> '), E'\r', '') as detail
  from pg_proc p
  where p.pronamespace::regnamespace::text in ('public', 'storage')
    and p.prokind = 'f'
),

-- 7. TRIGGERS ---------------------------------------------------------------
s_trigger as (
  select '07_trigger' as section,
         t.tgrelid::regclass::text || '.' || t.tgname as key,
         'trigger ' || t.tgrelid::regclass::text || '.' || t.tgname
           || ' def=' || pg_get_triggerdef(t.oid) as detail
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  where not t.tgisinternal
    and c.relnamespace::regnamespace::text in ('public', 'storage')
),

-- 8. RLS --------------------------------------------------------------------
-- BOTH flags. relrowsecurity alone is insufficient: a table owner bypasses RLS unless
-- relforcerowsecurity is also set, so the pair is the actual security posture.
s_rls as (
  select '08_rls' as section,
         c.relnamespace::regnamespace::text || '.' || c.relname as key,
         'rls ' || c.relnamespace::regnamespace::text || '.' || c.relname
           || ' enabled=' || c.relrowsecurity::text
           || ' forced='  || c.relforcerowsecurity::text as detail
  from pg_class c
  where c.relkind in ('r', 'p')
    and c.relnamespace::regnamespace::text in ('public', 'storage')
),

-- 9. POLICIES ---------------------------------------------------------------
s_policy as (
  select '09_policy' as section,
         pol.polrelid::regclass::text || '.' || pol.polname as key,
         'policy ' || pol.polrelid::regclass::text || '.' || pol.polname
           || ' cmd='        || pol.polcmd
           || ' permissive=' || pol.polpermissive::text
           || ' roles='      || coalesce(
                (select string_agg(r.rolname, ',' order by r.rolname)
                   from pg_roles r where r.oid = any(pol.polroles)), 'PUBLIC')
           || ' using='      || coalesce(pg_get_expr(pol.polqual,      pol.polrelid), '-')
           || ' withcheck='  || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '-') as detail
  from pg_policy pol
  join pg_class c on c.oid = pol.polrelid
  where c.relnamespace::regnamespace::text in ('public', 'storage')
),

-- 10. TABLE GRANTS ----------------------------------------------------------
-- 0051 revoked privileges from anon. A manifest without grants cannot distinguish a
-- build where that revoke applied from one where it silently did not.
s_grant as (
  select '10_grant' as section,
         g.table_schema || '.' || g.table_name || '.' || g.grantee || '.' || g.privilege_type as key,
         'grant ' || g.privilege_type
           || ' on ' || g.table_schema || '.' || g.table_name
           || ' to ' || g.grantee as detail
  from information_schema.role_table_grants g
  where g.table_schema in ('public', 'storage')
    and g.grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC', 'postgres')
),

-- 11. FUNCTION EXECUTE PRIVILEGES -------------------------------------------
-- set_deployment_identity must NOT be executable by service_role. That property was
-- verified once at runtime; here it becomes part of the build fingerprint.
s_grant_fn as (
  select '11_grant_function' as section,
         p.pronamespace::regnamespace::text || '.' || p.proname
           || '(' || pg_get_function_identity_arguments(p.oid) || ').' || r.rolname as key,
         'execute on ' || p.pronamespace::regnamespace::text || '.' || p.proname
           || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           || ' to ' || r.rolname
           || ' = ' || has_function_privilege(r.rolname, p.oid, 'EXECUTE')::text as detail
  from pg_proc p
  cross join (select unnest(array['anon','authenticated','service_role']) as rolname) r
  where p.pronamespace::regnamespace::text = 'public'
    and p.prokind = 'f'
),

-- 12. STORAGE BUCKETS -------------------------------------------------------
-- No timestamps. The COI bucket's private flag and MIME restriction are load-bearing
-- security properties and belong in the fingerprint.
s_bucket as (
  select '12_storage_bucket' as section,
         b.id as key,
         'bucket ' || b.id
           || ' name='       || b.name
           || ' public='     || b.public::text
           || ' size_limit=' || coalesce(b.file_size_limit::text, '-')
           || ' mime='       || coalesce(array_to_string(b.allowed_mime_types, ','), '-') as detail
  from storage.buckets b
),

-- 13. MIGRATION HISTORY -----------------------------------------------------
-- Versions and names only. inserted_at is deliberately excluded: it differs between
-- Build A and Build B by construction and would guarantee a false mismatch.
s_migration as (
  select '13_migration' as section,
         m.version as key,
         'migration ' || m.version || ' ' || coalesce(m.name, '-') as detail
  from supabase_migrations.schema_migrations m
),

-- 14. COUNTS ----------------------------------------------------------------
-- A tripwire for the failure mode this whole file exists to prevent: a section that
-- silently returns NOTHING. An empty result compares equal to another empty result.
-- These totals make that visible instead of invisible.
s_count as (
  select '14_count' as section, x.key, 'count ' || x.key || ' = ' || x.n::text as detail
  from (
    select 'migrations' as key, (select count(*) from supabase_migrations.schema_migrations) as n
    union all select 'tables',    (select count(*) from pg_class c
                                    where c.relkind in ('r','p')
                                      and c.relnamespace::regnamespace::text = 'public')
    union all select 'columns',   (select count(*) from pg_attribute a
                                    join pg_class c on c.oid = a.attrelid
                                    where a.attnum > 0 and not a.attisdropped
                                      and c.relkind in ('r','p')
                                      and c.relnamespace::regnamespace::text = 'public')
    union all select 'functions', (select count(*) from pg_proc p
                                    where p.pronamespace::regnamespace::text = 'public'
                                      and p.prokind = 'f')
    union all select 'triggers',  (select count(*) from pg_trigger t
                                    join pg_class c on c.oid = t.tgrelid
                                    where not t.tgisinternal
                                      and c.relnamespace::regnamespace::text = 'public')
    union all select 'policies',  (select count(*) from pg_policy pol
                                    join pg_class c on c.oid = pol.polrelid
                                    where c.relnamespace::regnamespace::text in ('public','storage'))
    union all select 'indexes',   (select count(*) from pg_indexes where schemaname = 'public')
    union all select 'buckets',   (select count(*) from storage.buckets)
  ) x
),

all_rows as (
  select * from s_schema        union all
  select * from s_table         union all
  select * from s_column        union all
  select * from s_constraint    union all
  select * from s_index         union all
  select * from s_function      union all
  select * from s_function_body union all
  select * from s_trigger       union all
  select * from s_rls           union all
  select * from s_policy        union all
  select * from s_grant         union all
  select * from s_grant_fn      union all
  select * from s_bucket        union all
  select * from s_migration     union all
  select * from s_count
)

select section || ' | ' || key || ' | ' || detail as manifest_line
from all_rows
order by 1;
