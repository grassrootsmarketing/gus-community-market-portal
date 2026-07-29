-- 0051_revoke_anon_privileges.sql
-- ============================================================================
-- Least privilege for the browser-facing roles, and for PUBLIC.
--
-- FINDING THAT PROMPTED THIS: `anon` held INSERT/UPDATE/DELETE/TRUNCATE on 16
-- tables and table-wide SELECT on 17 — session tokens, COI records, error logs.
-- Nothing was exposed, because RLS is enabled everywhere with only one policy and
-- RLS is evaluated before privileges. But that is single-layer safety: one
-- permissive policy, or one DISABLE ROW LEVEL SECURITY, and it becomes anonymous
-- read AND write. TRUNCATE is additionally not subject to RLS at all.
--
-- CAUSE: Supabase's "Automatically expose new tables" project setting.
--
-- CODEX P0-3 — THE PART THAT MATTERS MOST: revoking from `anon` and
-- `authenticated` alone does NOT remove effective access. PostgreSQL grants
-- EXECUTE on new functions to the pseudo-role PUBLIC by default, and every role
-- inherits PUBLIC. A revoke that skips PUBLIC leaves the door open while the
-- catalog rows look clean — which is exactly the kind of false-clean signal this
-- whole exercise exists to eliminate. Post-conditions therefore use
-- has_function_privilege() (effective) rather than information_schema (direct).
--
-- ALSO REQUIRED, cannot be expressed here: on the real Production and Staging
-- projects, disable "Automatically expose new tables" at creation. This migration
-- cleans up after that setting; it cannot stop it re-granting on later tables.
--
-- Idempotent.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Tables and sequences: revoke from anon + authenticated
-- ---------------------------------------------------------------------------
do $$
declare t record;
begin
  for t in
    select c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format('revoke all privileges on public.%I from anon', t.relname);
    execute format('revoke all privileges on public.%I from authenticated', t.relname);
  end loop;
end $$;

revoke all on all sequences in schema public from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Functions: revoke from PUBLIC as well (P0-3)
-- ---------------------------------------------------------------------------
-- PUBLIC first — otherwise anon/authenticated retain EXECUTE by inheritance.
revoke all on all functions in schema public from public;
revoke all on all functions in schema public from anon, authenticated;

-- Same for future objects, including the PUBLIC default on functions.
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from public;
alter default privileges in schema public revoke all on functions from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Re-grant exactly what is needed, and nothing else
-- ---------------------------------------------------------------------------

-- 3a. Public booking page — three columns (P1-3).
--     find-retailer.js's anonymous path needs id (health ping), slug (lookup) and
--     name (existence response). Everything else comes from fixed server routes.
grant select (id, slug, name) on public.retailers to anon;

-- NOTE: nothing granted on `venues`. Production carries an "anon select venues"
-- policy that no migration creates — a hand-edit. Venue data reaches the booking
-- page through /api/find-retailer's fixed public-data action (Codex Q4).

-- 3b. Runtime RPCs the server calls with the service key.
--     service_role bypasses RLS but still needs EXECUTE, which §2 just removed.
do $$
declare
  fn text;
  runtime_fns text[] := array[
    'checkout_claim_group','apply_payment_success','apply_refund_event',
    'claim_fulfillments','complete_fulfillment','open_fulfillment_case',
    'resolve_refund_adopt','resolve_refund_replace','get_deployment_identity'
  ];
begin
  foreach fn in array runtime_fns loop
    -- identity args so overloads are covered; skip cleanly if a function is absent
    execute (
      select coalesce(string_agg(
        format('grant execute on function public.%I(%s) to service_role', p.proname,
               pg_get_function_identity_arguments(p.oid)), '; '), 'select 1')
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = fn
    );
  end loop;
end $$;

-- 3c. set_deployment_identity is PROVISIONING ONLY (Codex §4.7).
--     Deliberately NOT granted to service_role: a running request must never be
--     able to rewrite the database's own statement of which environment it is.
--     That would let a compromised route defeat the binding check by telling the
--     database to agree with it. Only the migration/owner role may call it, i.e.
--     a human in the SQL editor during R3 provisioning.
revoke all on function public.set_deployment_identity(text, text, text)
  from public, anon, authenticated, service_role;

commit;

-- ---------------------------------------------------------------------------
-- 4. Post-conditions — EFFECTIVE privileges, not catalog rows (P0-3)
-- ---------------------------------------------------------------------------
do $$
declare
  v_writes integer;
  v_tablewide integer;
  v_cols integer;
  v_fn record;
  v_leaky text := '';
begin
  -- no writes for the browser roles
  select count(*) into v_writes
  from information_schema.table_privileges
  where table_schema='public' and grantee in ('anon','authenticated')
    and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE');
  if v_writes > 0 then
    raise exception 'POST-CONDITION FAILED: anon/authenticated hold % write privilege(s)', v_writes;
  end if;

  -- no table-wide reads
  select count(*) into v_tablewide
  from information_schema.table_privileges
  where table_schema='public' and grantee in ('anon','authenticated') and privilege_type='SELECT';
  if v_tablewide > 0 then
    raise exception 'POST-CONDITION FAILED: % table-wide SELECT grant(s) remain', v_tablewide;
  end if;

  -- exactly three anon-readable retailer columns
  select count(*) into v_cols
  from information_schema.column_privileges
  where table_schema='public' and table_name='retailers'
    and grantee='anon' and privilege_type='SELECT';
  if v_cols <> 3 then
    raise exception 'POST-CONDITION FAILED: expected 3 anon-readable retailer columns, found %', v_cols;
  end if;

  -- EFFECTIVE function execution: catches PUBLIC inheritance, which
  -- information_schema would not show as an anon/authenticated row.
  for v_fn in
    select p.oid::regprocedure::text as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
  loop
    if has_function_privilege('anon', v_fn.sig, 'EXECUTE')
       or has_function_privilege('authenticated', v_fn.sig, 'EXECUTE') then
      v_leaky := v_leaky || v_fn.sig || ' ';
    end if;
  end loop;
  if v_leaky <> '' then
    raise exception 'POST-CONDITION FAILED: anon/authenticated can still EXECUTE: %', v_leaky;
  end if;

  -- identity getter reachable by the runtime role, setter NOT
  if not has_function_privilege('service_role', 'public.get_deployment_identity()', 'EXECUTE') then
    raise exception 'POST-CONDITION FAILED: service_role cannot execute get_deployment_identity(); the binding check would fail closed permanently';
  end if;
  if has_function_privilege('service_role',
       'public.set_deployment_identity(text,text,text)', 'EXECUTE') then
    raise exception 'POST-CONDITION FAILED: service_role can execute set_deployment_identity(); a running request could rewrite the environment identity';
  end if;

  raise notice 'Privileges verified: no anon/authenticated writes, no table-wide reads, 3 retailer columns, no effective function execution, identity setter is provisioning-only.';
end $$;
