-- 0050_deployment_identity.sql — R2: let the DATABASE say which environment it is.
--
-- The incident this closes: an environment variable said one thing, the code said another, and
-- nothing in the running system could tell the difference. A URL string in config is a claim.
-- This table is the database asserting its own identity, so the application can check the claim
-- against the thing itself before it does any work.
--
-- Deliberately NOT seeded here. Codex §7.2: "Create the deployment-identity table in a migration,
-- but populate its environment and project-ref values through a target-specific provisioning step.
-- Do not commit a fake Production identity." A committed row would be exactly the kind of
-- plausible-but-unverified artifact that caused this incident.
--
-- Provisioning (run once per project, by a human, against that project only):
--   select public.set_deployment_identity('production', '<that project ref>');
--   select public.set_deployment_identity('staging',    '<that project ref>');
--
-- Idempotent.

begin;

create table if not exists public.deployment_identity (
  -- single-row guard: PK is a boolean that can only ever be true
  id           boolean      primary key default true check (id),
  environment  text         not null check (environment in ('production','staging','development','rebuild-check')),
  project_ref  text         not null check (project_ref ~ '^[a-z]{20}$'),
  note         text,
  created_at   timestamptz  not null default now(),
  updated_at   timestamptz  not null default now()
);

comment on table public.deployment_identity is
  'Single row. The database''s own statement of which environment it is. Read by api/_env.js before any application work is permitted. service_role only.';

-- RLS on, zero policies => service_role only. anon/authenticated cannot read or write it,
-- so the identity cannot be probed by a browser or spoofed by a client.
alter table public.deployment_identity enable row level security;

do $$
declare p record;
begin
  for p in
    select policyname from pg_policies
    where schemaname='public' and tablename='deployment_identity'
  loop
    execute format('drop policy if exists %I on public.deployment_identity', p.policyname);
  end loop;
end $$;

revoke all on public.deployment_identity from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Provisioning helper — explicit, auditable, and refuses to guess
-- ---------------------------------------------------------------------------
create or replace function public.set_deployment_identity(
  p_environment text,
  p_project_ref text,
  p_note        text default null
) returns public.deployment_identity
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.deployment_identity;
begin
  if p_environment is null or p_project_ref is null then
    raise exception 'environment and project_ref are both required';
  end if;

  insert into public.deployment_identity (id, environment, project_ref, note)
  values (true, p_environment, p_project_ref, p_note)
  on conflict (id) do update
    set environment = excluded.environment,
        project_ref = excluded.project_ref,
        note        = excluded.note,
        updated_at  = now()
  returning * into v_row;

  return v_row;
end $$;

revoke all on function public.set_deployment_identity(text, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Read helper used by the runtime binding check.
-- Returns zero rows when unprovisioned — the binding layer treats that as FAIL, not as "unknown ok".
-- ---------------------------------------------------------------------------
create or replace function public.get_deployment_identity()
returns table (environment text, project_ref text, updated_at timestamptz)
language sql
security definer
set search_path = public
as $$
  select environment, project_ref, updated_at from public.deployment_identity where id = true;
$$;

revoke all on function public.get_deployment_identity() from public, anon, authenticated;

commit;
